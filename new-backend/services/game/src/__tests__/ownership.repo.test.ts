/**
 * `getOwnedQuantities` against a REAL Postgres.
 *
 * The property under test cannot be proven against a mock, because it is a
 * property of the SCHEMA. Since 0011 the primary key of `core.card_ownership`
 * is (profile_id, card_id, source), so a single card can occupy two rows:
 *
 *   source = 'chain'    tokens the address holds on the CardPack ERC-721,
 *                       rewritten destructively by every wager-side sync,
 *   source = 'booster'  cards a redemption granted, which a sync must not touch.
 *
 * A reader that selects `qty` without aggregating returns one of those two rows
 * — whichever the plan reaches first — and a mocked repo would return whatever
 * the mock was told to. Only the database can demonstrate that two rows exist
 * and that the seating gate sees their sum.
 *
 * Why it matters in this direction: under-reporting ownership refuses a ranked
 * seat to a player who legitimately owns the cards. That is a false negative on
 * a paid entitlement, and unlike the false positive this module exists to stop,
 * the player cannot do anything about it.
 *
 * Skipped, loudly, without a database — same convention as the wager service:
 *
 *   TEST_DATABASE_URL=postgres://chains:<pw>@127.0.0.1:5432/chains npm test
 *
 * This suite is NON-DESTRUCTIVE: unlike the wager harness it does not drop or
 * re-apply schemas. It creates one throwaway profile, works inside it, and
 * deletes it (ON DELETE CASCADE takes the ownership rows with it), so it is
 * safe to point at the same compose Postgres the services are running against.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initDb, getPool, query } from '@chains/shared';
import { getOwnedQuantities } from '../repo/ownership.repo.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? null;
const suite = DB_URL ? describe : describe.skip;

if (!DB_URL) {
  // eslint-disable-next-line no-console
  console.warn('[game] TEST_DATABASE_URL not set — card ownership repo tests SKIPPED');
}

/** Unique to this suite so it can never collide with a real or fixture account. */
const TEST_ADDRESS = '0x00000000000000000000000000000gamerepo01';
const OTHER_ADDRESS = '0x00000000000000000000000000000gamerepo02';

suite('getOwnedQuantities', () => {
  let profileId = '';
  let otherProfileId = '';

  beforeAll(async () => {
    initDb({ connectionString: DB_URL!, max: 2, statementTimeoutMs: 15_000 });

    const { rows } = await query<{ pk: string | null }>(
      `SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS pk
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'core.card_ownership'::regclass AND c.contype = 'p'
        GROUP BY c.oid`,
    );
    // Guard the guard: on the old two-column key the two-source case cannot even
    // be inserted, and every assertion below would pass for the wrong reason.
    if (rows[0]?.pk !== 'profile_id,card_id,source') {
      throw new Error(
        `core.card_ownership is keyed on (${rows[0]?.pk ?? 'nothing'}) — expected ` +
          '(profile_id, card_id, source). Apply db/migrations/0011_card_ownership_source.sql.',
      );
    }
  });

  afterAll(async () => {
    await query(`DELETE FROM core.profiles WHERE address = ANY($1::text[])`, [
      [TEST_ADDRESS, OTHER_ADDRESS],
    ]).catch(() => {});
    await getPool().end();
  });

  beforeEach(async () => {
    await query(`DELETE FROM core.profiles WHERE address = ANY($1::text[])`, [
      [TEST_ADDRESS, OTHER_ADDRESS],
    ]);
    profileId = await makeProfile(TEST_ADDRESS, 'game-repo-test-a');
    otherProfileId = await makeProfile(OTHER_ADDRESS, 'game-repo-test-b');
  });

  async function makeProfile(address: string, displayName: string): Promise<string> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO core.profiles (address, chain, display_name)
       VALUES ($1, 'robinhood', $2) RETURNING id`,
      [address, displayName],
    );
    return rows[0]!.id;
  }

  async function own(cardId: string, qty: number, source: 'chain' | 'booster'): Promise<void> {
    await query(
      `INSERT INTO core.card_ownership (profile_id, card_id, qty, source)
       VALUES ($1, $2, $3, $4)`,
      [profileId, cardId, qty, source],
    );
  }

  it('THE TWO-SOURCE CASE: 2 on chain plus 1 from a booster is 3, not 2 and not 1', async () => {
    await own('eth_pepe', 2, 'chain');
    await own('eth_pepe', 1, 'booster');

    // Both rows really exist — otherwise the sum below proves nothing.
    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM core.card_ownership
        WHERE profile_id = $1 AND card_id = 'eth_pepe'`,
      [profileId],
    );
    expect(rows[0]!.n).toBe('2');

    const owned = await getOwnedQuantities(profileId, ['eth_pepe']);
    expect(owned.get('eth_pepe')).toBe(3);
  });

  it('sums per card, independently, in one query over a mixed decklist', async () => {
    await own('eth_pepe', 2, 'chain');
    await own('eth_pepe', 1, 'booster');
    await own('sol_bonk', 4, 'chain');
    await own('base_degen', 3, 'booster');

    const owned = await getOwnedQuantities(profileId, [
      'eth_pepe',
      'sol_bonk',
      'base_degen',
      'eth_wojak',
    ]);
    expect(Object.fromEntries(owned)).toEqual({ eth_pepe: 3, sol_bonk: 4, base_degen: 3 });
    // Never owned at all: absent, not zero. Callers read a missing key as 0.
    expect(owned.has('eth_wojak')).toBe(false);
  });

  it('returns a number, not the string SUM() hands back', async () => {
    await own('eth_pepe', 2, 'chain');
    await own('eth_pepe', 1, 'booster');
    const value = (await getOwnedQuantities(profileId, ['eth_pepe'])).get('eth_pepe');
    // `3 >= 3` is true; `'3' >= 3` is also true, but `'3' + 1` is '31'. The
    // seating gate compares, so pin the type rather than only the value.
    expect(typeof value).toBe('number');
    expect(value).toBe(3);
  });

  it('a booster copy does not rescue a card the chain reconcile zeroed', async () => {
    // 0010 allows qty = 0 as "held once, no longer". Summing must not turn
    // "0 on chain, 0 from boosters" into ownership just because rows exist.
    await own('eth_pepe', 0, 'chain');
    await own('eth_pepe', 0, 'booster');
    expect((await getOwnedQuantities(profileId, ['eth_pepe'])).get('eth_pepe')).toBe(0);
  });

  it('sums within one profile only — the GROUP BY does not reach across profiles', async () => {
    await own('eth_pepe', 2, 'chain');
    await own('eth_pepe', 1, 'booster');
    await query(
      `INSERT INTO core.card_ownership (profile_id, card_id, qty, source)
       VALUES ($1, 'eth_pepe', 9, 'chain')`,
      [otherProfileId],
    );

    expect((await getOwnedQuantities(profileId, ['eth_pepe'])).get('eth_pepe')).toBe(3);
    expect((await getOwnedQuantities(otherProfileId, ['eth_pepe'])).get('eth_pepe')).toBe(9);
  });

  it('asks nothing of the database for an empty card list', async () => {
    expect(await getOwnedQuantities(profileId, [])).toEqual(new Map());
  });
});
