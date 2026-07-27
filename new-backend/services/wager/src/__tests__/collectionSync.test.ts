/**
 * Chain-derived ownership, end to end against a fake chain.
 *
 * The reader is faked (there is no network in a test run) but the database is
 * real, because the property under test is what ends up in
 * `core.card_ownership` after a player mints, sells and re-syncs.
 *
 * What this pins:
 *  - the address comes from the session, never from anything the caller sends,
 *  - a shifted card index stops the sync BEFORE it writes,
 *  - selling a card removes it,
 *  - an unresolvable index fails the whole sync rather than writing part of it,
 *  - a chain sync does NOT touch booster-granted cards (0011's `source`),
 *  - never-synced and synced-and-empty are two distinguishable answers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, query } from '../platform/shared.js';
import type { AuthContext } from '../platform/shared.js';
import {
  closeTestDatabase,
  makeProfile,
  setupTestDatabase,
  testDatabaseUrl,
  truncateAll,
} from '../testing/db.js';
import { getMyCollection, syncMyCollection } from '../services/collectionService.js';
import type { CollectionServiceDeps } from '../services/collectionService.js';
import type { CardPackReader, HoldingsSnapshot } from '../chain/cardPackReader.js';
import { CARD_COUNT } from '../nft/cardCatalogue.js';

const HAS_DB = testDatabaseUrl() !== null;
const suite = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn('[wager] TEST_DATABASE_URL not set — collection sync tests SKIPPED');
}

const ALICE_ADDR = '0xaAaA000000000000000000000000000000000011';

/** Minimal stand-in for the real reader; records what it was asked about. */
class FakeCardPack {
  askedFor: string[] = [];
  constructor(
    private readonly holdings: Record<string, HoldingsSnapshot>,
    private readonly chainCardCount = CARD_COUNT,
  ) {}
  get contractAddress(): string {
    return '0x57200fb533b33823f8bd2ac8f3649e3b643830b3';
  }
  get chainId(): number {
    return 4663;
  }
  async cardCount(): Promise<number> {
    return this.chainCardCount;
  }
  async holdingsOf(owner: string): Promise<HoldingsSnapshot> {
    this.askedFor.push(owner.toLowerCase());
    return (
      this.holdings[owner.toLowerCase()] ?? { blockNumber: 1, tokens: [], transferredAway: 0 }
    );
  }
}

function depsFor(fake: FakeCardPack): CollectionServiceDeps {
  return { cardPack: fake as unknown as CardPackReader };
}

function authFor(profileId: string, address: string): AuthContext {
  return { profileId, address, chain: 'ethereum', roles: [] } as unknown as AuthContext;
}

function snapshot(
  blockNumber: number,
  cardIndexes: number[],
  transferredAway = 0,
): HoldingsSnapshot {
  return {
    blockNumber,
    transferredAway,
    tokens: cardIndexes.map((cardIndex, i) => ({ tokenId: BigInt(i), cardIndex })),
  };
}

suite('chain-derived card ownership', () => {
  let alice = '';
  let bob = '';

  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll();
    alice = await makeProfile('alice', ALICE_ADDR.toLowerCase());
    bob = await makeProfile('bob', '0xbbbb000000000000000000000000000000000022');
  });

  it('projects the minted pack that actually exists on chain', async () => {
    // The real pack held by 0xC910…60Ee: indexes [43,22,74,76,40,50].
    const fake = new FakeCardPack({
      [ALICE_ADDR.toLowerCase()]: snapshot(1234, [43, 22, 74, 76, 40, 50]),
    });
    const result = await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));

    expect(result.cards).toEqual({
      robinhood_margin: 1,
      sol_fartcoin: 1,
      base_wallet: 1,
      base_tip: 1,
      robinhood_dividend: 1,
      eth_wojak: 1,
    });
    expect(result.total).toBe(6);
    expect(result.blockNumber).toBe(1234);

    const stored = await getMyCollection(authFor(alice, ALICE_ADDR));
    expect(stored.cards).toEqual(result.cards);
    expect(stored.syncedAt).not.toBeNull();
  });

  it('counts duplicate card indexes as quantity', async () => {
    const fake = new FakeCardPack({
      [ALICE_ADDR.toLowerCase()]: snapshot(10, [50, 50, 50, 22]),
    });
    const result = await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));
    expect(result.cards).toEqual({ eth_wojak: 3, sol_fartcoin: 1 });
  });

  it('THE SELL EXPLOIT: a re-sync after selling removes the cards', async () => {
    const holdings: Record<string, HoldingsSnapshot> = {
      [ALICE_ADDR.toLowerCase()]: snapshot(10, [43, 22, 74]),
    };
    const fake = new FakeCardPack(holdings);
    await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));
    expect((await getMyCollection(authFor(alice, ALICE_ADDR))).total).toBe(3);

    // Alice sells two of the three tokens.
    holdings[ALICE_ADDR.toLowerCase()] = snapshot(20, [43], 2);
    const result = await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));

    expect(result.cards).toEqual({ robinhood_margin: 1 });
    expect(result.removed).toBe(2);
    expect(result.transferredAway).toBe(2);
    expect((await getMyCollection(authFor(alice, ALICE_ADDR))).cards).toEqual({
      robinhood_margin: 1,
    });
  });

  it('asks the chain about the SESSION address, not anything the caller supplied', async () => {
    const fake = new FakeCardPack({ [ALICE_ADDR.toLowerCase()]: snapshot(1, [0]) });
    await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));
    expect(fake.askedFor).toEqual([ALICE_ADDR.toLowerCase()]);
  });

  it('one profile’s sync cannot reach another profile’s collection', async () => {
    const fake = new FakeCardPack({
      [ALICE_ADDR.toLowerCase()]: snapshot(1, [0, 1]),
    });
    await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));
    // Bob synced nothing and holds nothing; Alice's rows are untouched.
    expect((await getMyCollection(authFor(bob, '0xbbbb000000000000000000000000000000000022'))).cards)
      .toEqual({});
    expect((await getMyCollection(authFor(alice, ALICE_ADDR))).total).toBe(2);
  });

  it('THE SHIFT GUARD: a disagreeing cardCount stops the sync before it writes', async () => {
    const holdings = { [ALICE_ADDR.toLowerCase()]: snapshot(10, [43, 22]) };
    await syncMyCollection(depsFor(new FakeCardPack(holdings)), authFor(alice, ALICE_ADDR));
    const before = (await getMyCollection(authFor(alice, ALICE_ADDR))).cards;

    // Someone inserted a card into src/cards.ts and did not regenerate.
    const drifted = new FakeCardPack(holdings, CARD_COUNT + 1);
    await expect(
      syncMyCollection(depsFor(drifted), authFor(alice, ALICE_ADDR)),
    ).rejects.toMatchObject({ details: { reason: 'card_index_out_of_sync' } });

    // Nothing was written, and nothing was destroyed.
    expect((await getMyCollection(authFor(alice, ALICE_ADDR))).cards).toEqual(before);
  });

  it('an index outside the manifest fails the whole sync, not just that card', async () => {
    const holdings = { [ALICE_ADDR.toLowerCase()]: snapshot(10, [0, 1]) };
    await syncMyCollection(depsFor(new FakeCardPack(holdings)), authFor(alice, ALICE_ADDR));

    holdings[ALICE_ADDR.toLowerCase()] = snapshot(20, [0, 999]);
    await expect(
      syncMyCollection(depsFor(new FakeCardPack(holdings)), authFor(alice, ALICE_ADDR)),
    ).rejects.toThrow(/outside the manifest/);

    // A partial write here would have deleted card index 1 while keeping 0.
    expect((await getMyCollection(authFor(alice, ALICE_ADDR))).total).toBe(2);
  });

  it('answers 503 rather than emptying collections when no contract is configured', async () => {
    const err = await syncMyCollection({ cardPack: null }, authFor(alice, ALICE_ADDR)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).details).toMatchObject({ reason: 'card_pack_unconfigured' });
  });

  it('reports an empty collection for a profile that has never synced', async () => {
    const view = await getMyCollection(authFor(bob, '0xbbbb000000000000000000000000000000000022'));
    expect(view).toEqual({
      cards: {},
      distinct: 0,
      total: 0,
      synced: false,
      syncedAt: null,
      syncedBlock: null,
    });
  });

  // ── never-synced vs synced-and-empty ──────────────────────────────────────
  //
  // Both are `cards: {}`. Before 0011 they were the same response, so the
  // product had to pick one wrong message for the other case: nag a player who
  // is correctly empty, or tell a player whose wallet was never read "you own
  // no cards" — a false claim about their property, made immediately before
  // refusing them a ranked seat over it.

  it('a profile that synced and holds NOTHING is not "never synced"', async () => {
    const fake = new FakeCardPack({ [ALICE_ADDR.toLowerCase()]: snapshot(4242, []) });
    const result = await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));

    expect(result.cards).toEqual({});
    expect(result.synced).toBe(true);

    const view = await getMyCollection(authFor(alice, ALICE_ADDR));
    expect(view.cards).toEqual({});
    expect(view.synced).toBe(true);
    expect(view.syncedAt).not.toBeNull();
    expect(view.syncedBlock).toBe(4242);
  });

  it('the two empty collections differ only in the sync fields', async () => {
    await syncMyCollection(
      depsFor(new FakeCardPack({ [ALICE_ADDR.toLowerCase()]: snapshot(7, []) })),
      authFor(alice, ALICE_ADDR),
    );
    const syncedEmpty = await getMyCollection(authFor(alice, ALICE_ADDR));
    const neverSynced = await getMyCollection(
      authFor(bob, '0xbbbb000000000000000000000000000000000022'),
    );

    expect(syncedEmpty.cards).toEqual(neverSynced.cards);
    expect(syncedEmpty.total).toBe(neverSynced.total);
    // …and are still distinguishable, which is the whole point.
    expect(neverSynced.synced).toBe(false);
    expect(neverSynced.syncedAt).toBeNull();
    expect(neverSynced.syncedBlock).toBeNull();
    expect(syncedEmpty.synced).toBe(true);
  });

  it('records the CONTRACT, its chain and the block the snapshot came from', async () => {
    const fake = new FakeCardPack({ [ALICE_ADDR.toLowerCase()]: snapshot(9001, [43, 43, 22]) });
    await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));

    const { rows } = await query<{
      address: string;
      chain_id: number;
      block_number: string;
      token_count: number;
    }>(
      `SELECT address, chain_id, block_number, token_count
         FROM core.card_ownership_sync WHERE profile_id = $1`,
      [alice],
    );
    expect(rows[0]).toMatchObject({
      address: '0x57200fb533b33823f8bd2ac8f3649e3b643830b3',
      chain_id: 4663,
      block_number: '9001',
      // TOKENS enumerated, not distinct cards: three tokens, two cards.
      token_count: 3,
    });
  });

  it('a later sync REPLACES the sync row rather than adding one', async () => {
    const holdings: Record<string, HoldingsSnapshot> = {
      [ALICE_ADDR.toLowerCase()]: snapshot(100, [43]),
    };
    const fake = new FakeCardPack(holdings);
    await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));
    holdings[ALICE_ADDR.toLowerCase()] = snapshot(200, [43, 22]);
    await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));

    const { rows } = await query<{ n: string; block_number: string }>(
      `SELECT count(*)::text AS n, max(block_number)::text AS block_number
         FROM core.card_ownership_sync WHERE profile_id = $1`,
      [alice],
    );
    expect(rows[0]!.n).toBe('1');
    expect(rows[0]!.block_number).toBe('200');
  });

  it('a failed sync leaves the previous block pointer untouched', async () => {
    const holdings = { [ALICE_ADDR.toLowerCase()]: snapshot(100, [43, 22]) };
    await syncMyCollection(depsFor(new FakeCardPack(holdings)), authFor(alice, ALICE_ADDR));

    holdings[ALICE_ADDR.toLowerCase()] = snapshot(200, [43, 999]);
    await expect(
      syncMyCollection(depsFor(new FakeCardPack(holdings)), authFor(alice, ALICE_ADDR)),
    ).rejects.toThrow(/outside the manifest/);

    // A pointer at block 200 over block-100 cards would be a snapshot claiming
    // data that was rolled back.
    expect((await getMyCollection(authFor(alice, ALICE_ADDR))).syncedBlock).toBe(100);
  });

  // ── the two sources ───────────────────────────────────────────────────────

  it('THE BOOSTER BUG 0011 CLOSES: a chain sync does not delete booster cards', async () => {
    // What a redemption writes, without going through the whole booster path.
    await query(
      `INSERT INTO core.card_ownership (profile_id, card_id, qty, source)
       VALUES ($1, 'eth_pepe', 2, 'booster')`,
      [alice],
    );

    const fake = new FakeCardPack({ [ALICE_ADDR.toLowerCase()]: snapshot(10, [43]) });
    const result = await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));

    // `eth_pepe` was never on chain, so it is absent from the snapshot — which
    // under the old (profile_id, card_id) key is exactly what got it deleted.
    expect(result.cards).toEqual({ robinhood_margin: 1, eth_pepe: 2 });
    expect((await getMyCollection(authFor(alice, ALICE_ADDR))).cards).toEqual({
      robinhood_margin: 1,
      eth_pepe: 2,
    });
  });

  it('the same card from both sources is reported as the SUM', async () => {
    // robinhood_margin is card index 43 — the same card, arriving both ways.
    await query(
      `INSERT INTO core.card_ownership (profile_id, card_id, qty, source)
       VALUES ($1, 'robinhood_margin', 1, 'booster')`,
      [alice],
    );
    const fake = new FakeCardPack({ [ALICE_ADDR.toLowerCase()]: snapshot(10, [43, 43]) });
    const result = await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));

    expect(result.cards).toEqual({ robinhood_margin: 3 });
    expect(result.distinct).toBe(1);
    expect(result.total).toBe(3);
  });

  it('selling every on-chain card still leaves the booster cards', async () => {
    const holdings: Record<string, HoldingsSnapshot> = {
      [ALICE_ADDR.toLowerCase()]: snapshot(10, [43, 22]),
    };
    const fake = new FakeCardPack(holdings);
    await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));
    await query(
      `INSERT INTO core.card_ownership (profile_id, card_id, qty, source)
       VALUES ($1, 'eth_pepe', 1, 'booster')`,
      [alice],
    );

    holdings[ALICE_ADDR.toLowerCase()] = snapshot(20, [], 2);
    const result = await syncMyCollection(depsFor(fake), authFor(alice, ALICE_ADDR));

    expect(result.cards).toEqual({ eth_pepe: 1 });
    expect(result.removed).toBe(2);
  });
});
