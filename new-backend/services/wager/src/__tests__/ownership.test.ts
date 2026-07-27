/**
 * `core.card_ownership` against a REAL Postgres.
 *
 * Two things here can only be proven against the real database:
 *
 *  1. THE DUPLICATE CASE. A pack rolls with replacement, so one pack routinely
 *     contains the same card twice. A naive multi-row
 *     `INSERT ... ON CONFLICT DO UPDATE` with a repeated key does not merge
 *     them — Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a
 *     second time" at runtime. A mock would happily accept it.
 *
 *  2. THE RECONCILE. Chain-derived ownership replaces the stored set rather than
 *     adding to it, so cards the player sold have to actually disappear. That is
 *     a DELETE plus an upsert in one transaction, and mocking it would only
 *     prove the mock.
 *
 *  3. THE SOURCE SPLIT (0011). The two writers are kept apart by the primary
 *     key — `(profile_id, card_id, source)` — so "a reconcile does not delete a
 *     booster card" is a property of the schema, not of any code path. Only the
 *     real table can show two rows for one card, and only the real read can show
 *     them summed.
 *
 * Run with:
 *   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=pw --name pg postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55433/postgres npx vitest run
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query, withTransaction } from '../platform/shared.js';
import {
  closeTestDatabase,
  makeProfile,
  makeTicket,
  setupTestDatabase,
  testDatabaseUrl,
  truncateAll,
} from '../testing/db.js';
import {
  grantCards,
  listOwnedCards,
  reconcileChainCards,
  tallyCardIds,
} from '../db/ownership.js';
import { redeemTicket } from '../services/boosterService.js';
import { rollTicketCards } from '../domain/packRoll.js';
import type { BoosterServiceDeps } from '../services/boosterService.js';
import type { AuthContext } from '../platform/shared.js';

const HAS_DB = testDatabaseUrl() !== null;
const suite = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn('[wager] TEST_DATABASE_URL not set — card ownership tests SKIPPED');
}

// ── the pure half: runs with or without a database ──────────────────────────

describe('tallyCardIds', () => {
  it('collapses duplicates into quantities', () => {
    expect(tallyCardIds(['a', 'b', 'a', 'a', 'c', 'b'])).toEqual([
      { cardId: 'a', qty: 3 },
      { cardId: 'b', qty: 2 },
      { cardId: 'c', qty: 1 },
    ]);
  });

  it('preserves first-seen order and totals every input', () => {
    const ids = ['z', 'y', 'z', 'x', 'y', 'z'];
    const tallied = tallyCardIds(ids);
    expect(tallied.map((t) => t.cardId)).toEqual(['z', 'y', 'x']);
    expect(tallied.reduce((n, t) => n + t.qty, 0)).toBe(ids.length);
  });

  it('is empty for an empty pack', () => {
    expect(tallyCardIds([])).toEqual([]);
  });
});

// ── the database half ───────────────────────────────────────────────────────

const SECRET = 'test-pack-secret-not-a-real-one';

function authFor(profileId: string, address: string): AuthContext {
  return { profileId, address, chain: 'ethereum', roles: [] } as unknown as AuthContext;
}

suite('core.card_ownership', () => {
  let alice = '';
  let bob = '';

  beforeAll(async () => {
    await setupTestDatabase();
    const { rows } = await query<{ present: string | null }>(
      `SELECT to_regclass('core.card_ownership')::text AS present`,
    );
    if (!rows[0]?.present) {
      throw new Error(
        'core.card_ownership is missing — db/migrations/0010_card_ownership.sql has not been applied',
      );
    }
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll();
    alice = await makeProfile('alice', '0xaaaa000000000000000000000000000000000011');
    bob = await makeProfile('bob', '0xbbbb000000000000000000000000000000000022');
  });

  async function ownedBy(profileId: string): Promise<Record<string, number>> {
    const rows = await listOwnedCards(getPool(), profileId);
    return Object.fromEntries(rows.map((r) => [r.cardId, r.qty]));
  }

  // ── grants ────────────────────────────────────────────────────────────────

  it('THE DUPLICATE CASE: one pack containing the same card three times', async () => {
    // A single statement with a repeated conflict key is what raises
    // "ON CONFLICT DO UPDATE command cannot affect row a second time".
    const pack = ['eth_pepe', 'sol_bonk', 'eth_pepe', 'base_degen', 'eth_pepe'];
    const summary = await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: pack }),
    );

    expect(summary).toEqual({ distinctCards: 3, totalCards: 5 });
    expect(await ownedBy(alice)).toEqual({ eth_pepe: 3, sol_bonk: 1, base_degen: 1 });
  });

  it('accumulates across separate grants rather than overwriting', async () => {
    await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: ['eth_pepe', 'eth_pepe'] }),
    );
    await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: ['eth_pepe', 'sol_bonk'] }),
    );
    expect(await ownedBy(alice)).toEqual({ eth_pepe: 3, sol_bonk: 1 });
  });

  it('grants land on the granted profile only', async () => {
    await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: ['eth_pepe'] }),
    );
    expect(await ownedBy(bob)).toEqual({});
  });

  it('a failed transaction grants nothing', async () => {
    await expect(
      withTransaction(async (client) => {
        await grantCards(client, { profileId: alice, cardIds: ['eth_pepe', 'eth_pepe'] });
        throw new Error('something after the grant failed');
      }),
    ).rejects.toThrow('something after the grant failed');
    expect(await ownedBy(alice)).toEqual({});
  });

  it('an empty pack is a no-op, not an empty INSERT', async () => {
    const summary = await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: [] }),
    );
    expect(summary).toEqual({ distinctCards: 0, totalCards: 0 });
    expect(await ownedBy(alice)).toEqual({});
  });

  // ── chain reconcile ───────────────────────────────────────────────────────

  it('a reconcile REPLACES the stored set — sold cards disappear', async () => {
    await withTransaction((client) =>
      reconcileChainCards(client, {
        profileId: alice,
        counts: new Map([
          ['eth_pepe', 2],
          ['sol_bonk', 1],
          ['base_degen', 4],
        ]),
      }),
    );
    expect(await ownedBy(alice)).toEqual({ eth_pepe: 2, sol_bonk: 1, base_degen: 4 });

    // Alice sells both Pepes and three Degens, and buys nothing.
    const summary = await withTransaction((client) =>
      reconcileChainCards(client, {
        profileId: alice,
        counts: new Map([
          ['sol_bonk', 1],
          ['base_degen', 1],
        ]),
      }),
    );

    expect(summary).toEqual({ distinctCards: 2, totalCards: 2, removedCards: 1 });
    // The exploit this blocks: mint, sync, sell, keep playing them.
    expect(await ownedBy(alice)).toEqual({ sol_bonk: 1, base_degen: 1 });
  });

  it('a reconcile to nothing empties the collection', async () => {
    await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map([['eth_pepe', 1]]) }),
    );
    const summary = await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map() }),
    );
    expect(summary).toEqual({ distinctCards: 0, totalCards: 0, removedCards: 1 });
    expect(await ownedBy(alice)).toEqual({});
  });

  it('a reconcile never touches another profile', async () => {
    await withTransaction((client) =>
      reconcileChainCards(client, { profileId: bob, counts: new Map([['eth_pepe', 7]]) }),
    );
    await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map([['sol_bonk', 1]]) }),
    );
    expect(await ownedBy(bob)).toEqual({ eth_pepe: 7 });
    expect(await ownedBy(alice)).toEqual({ sol_bonk: 1 });
  });

  it('a failed reconcile leaves the previous snapshot intact', async () => {
    await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map([['eth_pepe', 2]]) }),
    );
    await expect(
      withTransaction(async (client) => {
        await reconcileChainCards(client, { profileId: alice, counts: new Map() });
        throw new Error('rpc died mid-sync');
      }),
    ).rejects.toThrow('rpc died mid-sync');
    // Not an empty collection — a half-applied destructive reconcile is exactly
    // what the transaction is there to prevent.
    expect(await ownedBy(alice)).toEqual({ eth_pepe: 2 });
  });

  // ── the two sources (0011) ────────────────────────────────────────────────

  async function rowsBySource(profileId: string): Promise<Array<[string, string, number]>> {
    const { rows } = await query<{ card_id: string; source: string; qty: number }>(
      `SELECT card_id, source, qty FROM core.card_ownership
        WHERE profile_id = $1 ORDER BY card_id, source`,
      [profileId],
    );
    return rows.map((r) => [r.card_id, r.source, r.qty]);
  }

  it('grantCards writes source = booster, reconcileChainCards writes source = chain', async () => {
    await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: ['eth_pepe'] }),
    );
    await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map([['sol_bonk', 1]]) }),
    );
    expect(await rowsBySource(alice)).toEqual([
      ['eth_pepe', 'booster', 1],
      ['sol_bonk', 'chain', 1],
    ]);
  });

  it('THE SILENT LOSS 0011 PREVENTS: a reconcile does not delete booster cards', async () => {
    await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: ['eth_pepe', 'eth_pepe', 'sol_bonk'] }),
    );
    // The chain reports one card, and it is not either of those. Under the old
    // two-column key this DELETE took the paid-for cards with it.
    const summary = await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map([['base_degen', 1]]) }),
    );

    expect(summary.removedCards).toBe(0);
    expect(await ownedBy(alice)).toEqual({ eth_pepe: 2, sol_bonk: 1, base_degen: 1 });
  });

  it('a reconcile to NOTHING still leaves the booster cards standing', async () => {
    await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map([['eth_pepe', 3]]) }),
    );
    await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: ['sol_bonk'] }),
    );

    const summary = await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map() }),
    );
    // Exactly one row removed — the chain one. The booster row is not the
    // reconcile's to delete.
    expect(summary.removedCards).toBe(1);
    expect(await ownedBy(alice)).toEqual({ sol_bonk: 1 });
  });

  it('one card from both sources is TWO ROWS read back as one SUM', async () => {
    await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map([['eth_pepe', 2]]) }),
    );
    await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: ['eth_pepe'] }),
    );

    expect(await rowsBySource(alice)).toEqual([
      ['eth_pepe', 'booster', 1],
      ['eth_pepe', 'chain', 2],
    ]);
    // 2 on chain + 1 from a pack is 3. Reading a bare `qty` would say 2 or 1.
    expect(await ownedBy(alice)).toEqual({ eth_pepe: 3 });
  });

  it('a chain re-sync overwrites only its own partition of a shared card', async () => {
    await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map([['eth_pepe', 4]]) }),
    );
    await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: ['eth_pepe'] }),
    );
    // Alice sells three of the four tokens.
    await withTransaction((client) =>
      reconcileChainCards(client, { profileId: alice, counts: new Map([['eth_pepe', 1]]) }),
    );

    expect(await rowsBySource(alice)).toEqual([
      ['eth_pepe', 'booster', 1],
      ['eth_pepe', 'chain', 1],
    ]);
    expect(await ownedBy(alice)).toEqual({ eth_pepe: 2 });
  });

  it('zero in one partition does not resurrect a card that is zero in the other', async () => {
    // Ownership is SUM(qty) > 0, aggregated first — not "any row with qty > 0",
    // and never EXISTS.
    await query(
      `INSERT INTO core.card_ownership (profile_id, card_id, qty, source)
       VALUES ($1, 'eth_pepe', 0, 'chain'), ($1, 'eth_pepe', 0, 'booster')`,
      [alice],
    );
    expect(await ownedBy(alice)).toEqual({});
  });

  // ── through the booster redemption path ───────────────────────────────────

  function boosterDeps(pool: readonly string[]): BoosterServiceDeps {
    return {
      cardPool: pool,
      packSecret: SECRET,
      // Redemption never reaches these; only the digital roll matters here.
      reader: null as never,
      minter: { enabled: false } as never,
      treasuryAddress: '0xeeee000000000000000000000000000000000005',
      priceWei: 3_500_000_000_000_000n,
      minConfirmations: 2,
      supplyCap: 2_000,
      intentTtlSeconds: 900,
    };
  }

  it('THE SHIPPING BUG THIS GUARDS: a redeemed pack with duplicates lands as quantities', async () => {
    // A two-card pool over 30 picks makes duplicates certain, which is what a
    // real 80-card pool produces anyway — 30 picks with replacement.
    const pool = ['eth_pepe', 'sol_bonk'] as const;
    await makeTicket({ ticketNumber: 1, profileId: alice });

    const rolled = rollTicketCards({ pool, ticketNumber: 1, secret: SECRET });
    expect(rolled).toHaveLength(30);
    const expected = tallyCardIds(rolled);
    // Guard the guard: if this were not duplicated the test would prove nothing.
    expect(expected.some((e) => e.qty > 1)).toBe(true);

    const result = await redeemTicket(boosterDeps(pool), authFor(alice, '0xaaaa'), {
      ticketNumber: 1,
      kind: 'digital',
    });

    expect(result.cardIds).toEqual(rolled);
    expect(await ownedBy(alice)).toEqual(
      Object.fromEntries(expected.map((e) => [e.cardId, e.qty])),
    );
    // Every rolled card is accounted for, none collapsed or dropped.
    const total = Object.values(await ownedBy(alice)).reduce((a, b) => a + b, 0);
    expect(total).toBe(30);
  });

  it('a PHYSICAL redemption grants no in-game cards', async () => {
    await makeTicket({ ticketNumber: 2, profileId: alice });
    const result = await redeemTicket(boosterDeps(['eth_pepe']), authFor(alice, '0xaaaa'), {
      ticketNumber: 2,
      kind: 'physical',
      address: {
        fullName: 'Alice',
        line1: '1 Test Street',
        city: 'Testville',
        region: 'TS',
        postalCode: '00001',
        country: 'GB',
      },
    });
    expect(result.cardIds).toBeNull();
    // Real cardboard ships; the collection must not move.
    expect(await ownedBy(alice)).toEqual({});
  });

  it('a redemption that violates the once-per-kind constraint grants nothing', async () => {
    const pool = ['eth_pepe', 'sol_bonk'] as const;
    await makeTicket({ ticketNumber: 3, profileId: alice });
    await redeemTicket(boosterDeps(pool), authFor(alice, '0xaaaa'), {
      ticketNumber: 3,
      kind: 'digital',
    });
    const before = await ownedBy(alice);

    await expect(
      redeemTicket(boosterDeps(pool), authFor(alice, '0xaaaa'), {
        ticketNumber: 3,
        kind: 'digital',
      }),
    ).rejects.toMatchObject({ details: { reason: 'already_redeemed' } });

    // The rejected transaction rolled back, so the second roll granted nothing.
    expect(await ownedBy(alice)).toEqual(before);
  });

  it('redeeming someone else’s ticket grants nothing to anyone', async () => {
    await makeTicket({ ticketNumber: 4, profileId: alice });
    await expect(
      redeemTicket(boosterDeps(['eth_pepe']), authFor(bob, '0xbbbb'), {
        ticketNumber: 4,
        kind: 'digital',
      }),
    ).rejects.toMatchObject({ details: { reason: 'not_your_ticket' } });
    expect(await ownedBy(alice)).toEqual({});
    expect(await ownedBy(bob)).toEqual({});
  });

  // ── the read path ─────────────────────────────────────────────────────────

  it('a zero-quantity row is not ownership', async () => {
    // 0010 allows qty = 0 as "held once, no longer". Every reader must spell
    // ownership `qty > 0` rather than `EXISTS`.
    await query(
      `INSERT INTO core.card_ownership (profile_id, card_id, qty) VALUES ($1, 'eth_pepe', 0)`,
      [alice],
    );
    expect(await ownedBy(alice)).toEqual({});
  });

  it('reads are ordered and scoped to one profile', async () => {
    await withTransaction((client) =>
      grantCards(client, { profileId: alice, cardIds: ['sol_bonk', 'base_degen', 'eth_pepe'] }),
    );
    await withTransaction((client) =>
      grantCards(client, { profileId: bob, cardIds: ['eth_pepe'] }),
    );
    const rows = await listOwnedCards(getPool(), alice);
    expect(rows.map((r) => r.cardId)).toEqual(['base_degen', 'eth_pepe', 'sol_bonk']);
  });
});
