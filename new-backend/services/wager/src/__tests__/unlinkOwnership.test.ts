/**
 * Unlinking a wallet clears the profile's chain-sourced collection.
 *
 * The fix is migration `0014_unlink_clears_chain_ownership.sql` — a trigger, not
 * application code — so it is tested where it lives, against a real PostgreSQL,
 * with raw SQL doing the unlink. Driving it through the auth service's
 * `unlinkAddress` would only prove that one caller behaves; the entire argument
 * for putting it in the database is that it holds for every caller, including
 * the fixtures below and a psql session nobody wrote a test for.
 *
 * THE ATTACK, end to end: borrow a wallet holding a collection, link it, sync,
 * unlink, keep the cards. `services/game/src/lib/seating.ts` reads
 * `core.card_ownership` and nothing else, so without this trigger the borrowed
 * deck keeps getting seated in ranked forever — the player who benefits from a
 * stale snapshot has no reason to ever press sync again.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://chains:<pw>@127.0.0.1:5432/chains_test npx vitest run
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query, withTransaction } from '../platform/shared.js';
import {
  closeTestDatabase,
  linkAddress,
  makeProfile,
  setupTestDatabase,
  testDatabaseUrl,
  truncateAll,
} from '../testing/db.js';
import {
  grantCards,
  listOwnedCards,
  readSyncState,
  reconcileChainCards,
  recordSync,
} from '../db/ownership.js';

const HAS_DB = testDatabaseUrl() !== null;
const suite = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn('[wager] TEST_DATABASE_URL not set — unlink ownership tests SKIPPED');
}

const OWN = '0xaaaa000000000000000000000000000000000011';
const BORROWED = '0xbbbb000000000000000000000000000000000022';
const CARD_PACK = '0x57200fb533b33823f8bd2ac8f3649e3b643830b3';
const CARD_CHAIN_ID = 4663;

suite('unlinking a wallet clears chain ownership (0014)', () => {
  let player = '';

  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll();
    // 0013's `profiles_link_primary_address` trigger writes the primary row for
    // OWN; BORROWED is the wallet that gets lent and taken back.
    player = await makeProfile('player', OWN);
    await linkAddress({ profileId: player, address: BORROWED });
  });

  /** Everything stored for this profile, by source, so the partitions are visible. */
  async function rowsBySource(profileId: string): Promise<Array<[string, string, number]>> {
    const { rows } = await query<{ card_id: string; source: string; qty: number }>(
      `SELECT card_id, source, qty FROM core.card_ownership
        WHERE profile_id = $1 ORDER BY source, card_id`,
      [profileId],
    );
    return rows.map((r) => [r.source, r.card_id, r.qty]);
  }

  /** A sync: chain-sourced rows plus the sync-state row, as the service writes them. */
  async function sync(profileId: string, counts: Record<string, number>): Promise<void> {
    await withTransaction(async (client) => {
      await reconcileChainCards(client, {
        profileId,
        counts: new Map(Object.entries(counts)),
      });
      await recordSync(client, {
        profileId,
        address: CARD_PACK,
        chainId: CARD_CHAIN_ID,
        blockNumber: 100,
        tokenCount: Object.values(counts).reduce((a, b) => a + b, 0),
      });
    });
  }

  function unlink(address: string): Promise<unknown> {
    return query(`DELETE FROM core.profile_addresses WHERE address = $1`, [address]);
  }

  /* ------------------------------------------------------------------ */

  it('THE BORROWED WALLET CASE: unlinking drops the chain collection', async () => {
    await sync(player, { robinhood_margin: 3, sol_fartcoin: 1 });
    expect(await rowsBySource(player)).toEqual([
      ['chain', 'robinhood_margin', 3],
      ['chain', 'sol_fartcoin', 1],
    ]);

    await unlink(BORROWED);

    // The whole chain partition, not just the borrowed wallet's share: there is
    // no per-address partition in core.card_ownership to subtract, and the
    // honest answer to "which of these were the borrowed wallet's" is a chain
    // scan the trigger cannot do. It fails closed and makes the player prove it.
    expect(await rowsBySource(player)).toEqual([]);
    expect(await listOwnedCards(getPool(), player)).toEqual([]);
  });

  it('resets the profile to never-synced, not to synced-and-empty', async () => {
    await sync(player, { robinhood_margin: 1 });
    expect(await readSyncState(getPool(), player)).not.toBeNull();

    await unlink(BORROWED);

    // `synced: false` is what makes the client render "your collection has not
    // been read from the chain yet" with a SCAN CHAIN button. Leaving the row
    // behind would produce `synced: true, cards: {}` — the server telling a
    // player they own nothing, which 0011 exists to make unrepresentable.
    expect(await readSyncState(getPool(), player)).toBeNull();
  });

  it('leaves source = booster rows completely untouched', async () => {
    await withTransaction((client) =>
      grantCards(client, { profileId: player, cardIds: ['eth_wojak', 'eth_wojak', 'base_tip'] }),
    );
    await sync(player, { robinhood_margin: 2 });

    await unlink(BORROWED);

    // Booster cards were granted by us, were never on a chain, and are tied to
    // no wallet — so a wallet leaving says nothing about them (0011). Deleting
    // them would destroy a paid item over an unrelated action.
    expect(await rowsBySource(player)).toEqual([
      ['booster', 'base_tip', 1],
      ['booster', 'eth_wojak', 2],
    ]);
    // And the player still owns them, so the collection is not empty.
    const owned = await listOwnedCards(getPool(), player);
    expect(Object.fromEntries(owned.map((r) => [r.cardId, r.qty]))).toEqual({
      base_tip: 1,
      eth_wojak: 2,
    });
  });

  it('does not touch ANOTHER profile', async () => {
    const bystander = await makeProfile('bystander', '0xcccc000000000000000000000000000000000033');
    await sync(player, { robinhood_margin: 1 });
    await sync(bystander, { sol_fartcoin: 2 });

    await unlink(BORROWED);

    expect(await rowsBySource(player)).toEqual([]);
    expect(await rowsBySource(bystander)).toEqual([['chain', 'sol_fartcoin', 2]]);
    expect(await readSyncState(getPool(), bystander)).not.toBeNull();
  });

  it('the cards come back on the next sync — nothing is permanently lost', async () => {
    await sync(player, { robinhood_margin: 3, sol_fartcoin: 1 });
    await unlink(BORROWED);
    expect(await rowsBySource(player)).toEqual([]);

    // The player re-scans. Whatever their remaining wallets actually hold is
    // what they get back, which is the entire point of forcing the re-scan.
    await sync(player, { robinhood_margin: 3 });
    expect(await rowsBySource(player)).toEqual([['chain', 'robinhood_margin', 3]]);
    expect(await readSyncState(getPool(), player)).not.toBeNull();
  });

  /* ── cascade is exempt (0014 § d) ─────────────────────────────────── */

  it('deleting a profile still works and takes everything with it', async () => {
    await withTransaction((client) =>
      grantCards(client, { profileId: player, cardIds: ['eth_wojak'] }),
    );
    await sync(player, { robinhood_margin: 1 });

    // Exactly what the game suite's fixtures do on every beforeEach.
    await query(`DELETE FROM core.profiles WHERE address = ANY($1::text[])`, [[OWN]]);

    expect(await rowsBySource(player)).toEqual([]);
    expect(await readSyncState(getPool(), player)).toBeNull();
    const links = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM core.profile_addresses WHERE profile_id = $1::bigint`,
      [player],
    );
    expect(links.rows[0]!.n).toBe('0');
  });

  it('a profile delete writes no unlink history — the cascade exemption still holds', async () => {
    await sync(player, { robinhood_margin: 1 });
    await query(`DELETE FROM core.profiles WHERE address = ANY($1::text[])`, [[OWN]]);

    // 0013 § 5 exempts cascade from recording an unlink so fixture teardown does
    // not arm the 30-day relink cooldown against its own addresses. 0014 uses
    // the same test and must not have disturbed it.
    const history = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM core.profile_address_unlinks WHERE address = ANY($1::text[])`,
      [[OWN, BORROWED]],
    );
    expect(history.rows[0]!.n).toBe('0');
  });

  it('a profile deleted by address can be recreated with the same address', async () => {
    await sync(player, { robinhood_margin: 1 });
    await query(`DELETE FROM core.profiles WHERE address = ANY($1::text[])`, [[OWN]]);

    // The property every fixture teardown in the repo depends on.
    const again = await makeProfile('player-again', OWN);
    expect(again).not.toBe(player);
    expect(await rowsBySource(again)).toEqual([]);
    expect(await readSyncState(getPool(), again)).toBeNull();
  });

  /* ── the refusals from 0013 still stand ───────────────────────────── */

  it('a REFUSED unlink does not clear anything', async () => {
    await sync(player, { robinhood_margin: 2 });

    // 0013 § 5 refuses to unlink the primary while another address remains
    // (CH003). The clearing trigger is AFTER DELETE, so a refused unlink never
    // reaches it — the collection must survive the failed attempt intact.
    await expect(unlink(OWN)).rejects.toMatchObject({ code: 'CH003' });
    expect(await rowsBySource(player)).toEqual([['chain', 'robinhood_margin', 2]]);
    expect(await readSyncState(getPool(), player)).not.toBeNull();
  });

  it('a REFUSED last-address unlink does not clear anything either', async () => {
    const solo = await makeProfile('solo', '0xdddd000000000000000000000000000000000044');
    await sync(solo, { base_wallet: 1 });

    await expect(
      query(`DELETE FROM core.profile_addresses WHERE profile_id = $1::bigint`, [solo]),
    ).rejects.toMatchObject({ code: 'CH002' });

    expect(await rowsBySource(solo)).toEqual([['chain', 'base_wallet', 1]]);
    expect(await readSyncState(getPool(), solo)).not.toBeNull();
  });
});
