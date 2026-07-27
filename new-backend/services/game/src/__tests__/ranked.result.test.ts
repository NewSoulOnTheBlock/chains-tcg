/**
 * The ladder against a REAL Postgres, through the real result recorder.
 *
 * Everything here is a property of the TRANSACTION, so none of it can be shown
 * against a mock:
 *
 *   • exactly-once — that recording the same finished match twice moves rating
 *     once. The guard is `INSERT ... ON CONFLICT (match_id) DO NOTHING`
 *     reporting `rowCount > 0`, which is a statement about a primary key. A
 *     mocked repo would return whatever it was told.
 *   • the mode gate — that a casual match reaches the same code path and leaves
 *     no ranked row behind, while still incrementing wins/losses.
 *   • rename safety — that a display-name change does not orphan a ladder
 *     standing. This is the bug 0012 exists to prevent and it is invisible
 *     without a database, because the whole failure mode is "a second row is
 *     created and the first is never found again".
 *   • the generated `ladder_ordinal` column agreeing with `ordinalOf()` in
 *     TypeScript. Two implementations of one formula, in two languages; only the
 *     database can be asked whether they match.
 *
 * boardgame.io's own store is mocked — this suite is about what happens AFTER a
 * gameover is read, and standing up a sequelize match store would test the
 * vendor, not us.
 *
 * NON-DESTRUCTIVE, like the other game suites: it creates throwaway profiles and
 * matches, works inside them, and deletes them. It does not drop or re-apply a
 * schema, so it is safe against the same compose Postgres the services run on.
 *
 *   TEST_DATABASE_URL=postgres://chains:<pw>@127.0.0.1:5432/chains npm test
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `services/game/src/config.ts` parses the environment at import time and exits
 * the process if a required variable is missing, so these have to be in place
 * before any import below is evaluated — which is what `vi.hoisted` is for.
 */
const testEnv = vi.hoisted(() => {
  const url = process.env.TEST_DATABASE_URL ?? null;
  process.env.DATABASE_URL = url ?? 'postgres://chains:unused@127.0.0.1:5432/chains';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long';
  process.env.MATCH_RESULT_HMAC_SECRET ??= 'test-hmac-secret-at-least-32-characters-long';
  process.env.LOG_LEVEL ??= 'error';
  return { url };
});

/** What the mocked boardgame.io store will report for each match id. */
const vendorMatches = vi.hoisted(
  () => new Map<string, { state: unknown; metadata: unknown }>(),
);

vi.mock('../bgio/store.js', () => ({
  store: {
    fetch: vi.fn(async (id: string) => vendorMatches.get(id) ?? {}),
    listMatches: vi.fn(async () => [] as string[]),
    createMatch: vi.fn(async () => undefined),
    wipe: vi.fn(async () => undefined),
    sequelize: { authenticate: vi.fn(async () => undefined), close: vi.fn(async () => undefined) },
  },
  connectStore: vi.fn(async () => undefined),
  closeStore: vi.fn(async () => undefined),
}));

// Redis is not part of what is under test here, and the real implementation
// would log a warning per call for a client that was never initialised.
vi.mock('../lib/cache.js', () => ({
  LEADERBOARD_CACHE_KEY: 'cache:leaderboard:top50:v1',
  invalidateLeaderboard: vi.fn(async () => undefined),
}));

import { randomUUID } from 'node:crypto';
import { getPool, initDb, query } from '@chains/shared';
import { recordFinishedMatch } from '../results/recorder.js';
import { ensureActiveSeason, clearSeasonMemo } from '../ranked/season.js';
import * as repo from '../repo/ranked.repo.js';
import { ladderOrdinalOf } from '../ranked/rating.js';
import type { Division } from '../ranked/ranks.js';

const suite = testEnv.url ? describe : describe.skip;

if (!testEnv.url) {
  // eslint-disable-next-line no-console
  console.warn('[game] TEST_DATABASE_URL not set — ranked result tests SKIPPED');
}

/** Namespaced so these can never collide with a real account. */
const ADDR_PREFIX = '0x000000000000000000000000rankedtest';

suite('ranked results', () => {
  let seasonId = '';
  const createdMatches: string[] = [];
  const createdAddresses: string[] = [];

  beforeAll(async () => {
    initDb({ connectionString: testEnv.url!, max: 4, statementTimeoutMs: 20_000 });
    clearSeasonMemo();
    seasonId = (await ensureActiveSeason()).id;
  });

  afterAll(async () => {
    await cleanup();
    await getPool().end();
  });

  beforeEach(async () => {
    await cleanup();
    vendorMatches.clear();
  });

  async function cleanup(): Promise<void> {
    if (createdMatches.length > 0) {
      // match_results references matches with no ON DELETE, so it goes first.
      // ranked_match_ratings cascades from matches (0012).
      await query(`DELETE FROM game.match_results WHERE match_id = ANY($1::text[])`, [
        createdMatches,
      ]).catch(() => undefined);
      await query(`DELETE FROM game.matches WHERE id = ANY($1::text[])`, [createdMatches]).catch(
        () => undefined,
      );
      createdMatches.length = 0;
    }
    if (createdAddresses.length > 0) {
      // ranked_profiles and ranked_queue cascade from core.profiles (0012).
      await query(`DELETE FROM core.profiles WHERE address = ANY($1::text[])`, [
        createdAddresses,
      ]).catch(() => undefined);
      createdAddresses.length = 0;
    }
  }

  let seq = 0;
  async function makeProfile(label: string): Promise<string> {
    seq += 1;
    const address = `${ADDR_PREFIX}${String(seq).padStart(6, '0')}`;
    createdAddresses.push(address);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO core.profiles (address, chain, display_name)
       VALUES ($1, 'robinhood', $2) RETURNING id::text`,
      [address, `ranked-test-${label}-${seq}`],
    );
    return rows[0]!.id;
  }

  async function makeMatch(mode: string, seat0: string, seat1: string): Promise<string> {
    const id = randomUUID();
    createdMatches.push(id);
    await query(
      `INSERT INTO game.matches
         (id, mode, status, unlisted, seat0_profile, seat1_profile, started_at, updated_at)
       VALUES ($1, $2, 'live', TRUE, $3::bigint, $4::bigint, now(), now())`,
      [id, mode, seat0, seat1],
    );
    return id;
  }

  /** Put a finished boardgame.io state in front of the recorder. */
  function finish(
    matchId: string,
    gameover: Record<string, unknown>,
    finishedAt = new Date(),
  ): void {
    vendorMatches.set(matchId, {
      state: { ctx: { gameover } },
      metadata: { updatedAt: finishedAt.getTime(), gameover },
    });
  }

  async function standing(profileId: string): Promise<repo.StandingRow | null> {
    return repo.getStanding(seasonId, profileId);
  }

  async function profileRecord(profileId: string): Promise<{ wins: number; losses: number }> {
    const { rows } = await query<{ wins: number; losses: number }>(
      `SELECT wins, losses FROM core.profiles WHERE id = $1::bigint`,
      [profileId],
    );
    return { wins: Number(rows[0]!.wins), losses: Number(rows[0]!.losses) };
  }

  /* ---------------------------------------------------------------------- */

  describe('EXACTLY ONCE: recording the same finished match twice rates it once', () => {
    it('the second record is a duplicate and moves nothing', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('ranked', a, b);
      finish(matchId, { winner: '0', reason: 'life' });

      expect((await recordFinishedMatch(matchId)).status).toBe('recorded');

      const afterFirst = {
        a: await standing(a),
        b: await standing(b),
        aProfile: await profileRecord(a),
      };
      expect(afterFirst.a!.rating).toBeGreaterThan(1500);
      expect(afterFirst.b!.rating).toBeLessThan(1500);
      expect(afterFirst.aProfile.wins).toBe(1);

      // Exactly what the sweeper does on its next pass, and after a restart.
      expect((await recordFinishedMatch(matchId)).status).toBe('duplicate');
      expect((await recordFinishedMatch(matchId)).status).toBe('duplicate');

      expect((await standing(a))!.rating).toBe(afterFirst.a!.rating);
      expect((await standing(b))!.rating).toBe(afterFirst.b!.rating);
      expect((await standing(a))!.wins).toBe(1);
      expect((await standing(b))!.losses).toBe(1);
      expect((await profileRecord(a)).wins).toBe(1);
      expect((await profileRecord(b)).losses).toBe(1);
    });

    it('writes exactly one game.ranked_match_ratings row, whatever the sweeper does', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('ranked', a, b);
      finish(matchId, { winner: '1', reason: 'concede' });

      await recordFinishedMatch(matchId);
      await recordFinishedMatch(matchId);
      await recordFinishedMatch(matchId);

      const { rows } = await query<{ n: string; winner_seat: number; reason: string }>(
        `SELECT count(*)::text AS n, max(winner_seat) AS winner_seat, max(reason) AS reason
           FROM game.ranked_match_ratings WHERE match_id = $1`,
        [matchId],
      );
      expect(rows[0]!.n).toBe('1');
      expect(Number(rows[0]!.winner_seat)).toBe(1);
      expect(rows[0]!.reason).toBe('concede');
    });

    it('rating lands in the SAME transaction as the result row, not after it', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('ranked', a, b);
      finish(matchId, { winner: '0', reason: 'deckout' });
      await recordFinishedMatch(matchId);

      // If the two writes were in separate transactions there would be an
      // interval in which one existed without the other; the strongest thing a
      // test can assert after the fact is that neither can exist alone.
      const { rows } = await query<{ results: string; ratings: string }>(
        `SELECT (SELECT count(*) FROM game.match_results        WHERE match_id = $1)::text AS results,
                (SELECT count(*) FROM game.ranked_match_ratings WHERE match_id = $1)::text AS ratings`,
        [matchId],
      );
      expect(rows[0]).toEqual({ results: '1', ratings: '1' });
    });
  });

  describe('THE MODE GATE: only ranked matches touch rating', () => {
    it('a casual match increments wins/losses and creates no ladder row at all', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('casual', a, b);
      finish(matchId, { winner: '0', reason: 'life' });

      expect((await recordFinishedMatch(matchId)).status).toBe('recorded');

      expect((await profileRecord(a)).wins).toBe(1);
      expect((await profileRecord(b)).losses).toBe(1);
      expect(await standing(a)).toBeNull();
      expect(await standing(b)).toBeNull();

      const { rows } = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM game.ranked_match_ratings WHERE match_id = $1`,
        [matchId],
      );
      expect(rows[0]!.n).toBe('0');
    });

    it('a wager match is likewise unrated', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('wager', a, b);
      finish(matchId, { winner: '1', reason: 'life' });
      await recordFinishedMatch(matchId);
      expect(await standing(a)).toBeNull();
      expect(await standing(b)).toBeNull();
    });

    it('the mode comes from the locked matches row, so it cannot be influenced', async () => {
      // There is no request in this path at all: `recordFinishedMatch` takes a
      // match id and reads everything else from the database and from
      // boardgame.io's stored state. The only way to make this match rate is to
      // change `game.matches.mode`, which no route allows for an existing match.
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('casual', a, b);
      finish(matchId, { winner: '0', reason: 'life', ranked: true, lpDelta: 9999 });
      await recordFinishedMatch(matchId);
      expect(await standing(a)).toBeNull();
    });
  });

  describe('DRAWS', () => {
    it('rate both players, move no LP, and touch neither win nor loss counter', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('ranked', a, b);
      finish(matchId, { draw: true, reason: 'life' });

      expect((await recordFinishedMatch(matchId)).status).toBe('recorded');

      expect(await profileRecord(a)).toEqual({ wins: 0, losses: 0 });
      expect(await profileRecord(b)).toEqual({ wins: 0, losses: 0 });

      const sa = (await standing(a))!;
      const sb = (await standing(b))!;
      expect(sa.draws).toBe(1);
      expect(sb.draws).toBe(1);
      expect(sa.wins).toBe(0);
      expect(sa.losses).toBe(0);
      // Equal starting ratings, so a draw is no information about who is better
      // — but it IS information that they are close, so the deviations shrink.
      expect(sa.rating).toBeCloseTo(1500, 6);
      expect(sa.ratingDeviation).toBeLessThan(350);
      expect(sa.lp).toBe(0);
      expect(sa.ladderOrdinal).toBe(0);

      const { rows } = await query<{ winner_seat: number | null; d0: number; d1: number }>(
        `SELECT winner_seat, seat0_lp_delta AS d0, seat1_lp_delta AS d1
           FROM game.ranked_match_ratings WHERE match_id = $1`,
        [matchId],
      );
      expect(rows[0]!.winner_seat).toBeNull();
      expect(Number(rows[0]!.d0)).toBe(0);
      expect(Number(rows[0]!.d1)).toBe(0);
    });

    it('still consumes a placement game', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('ranked', a, b);
      finish(matchId, { draw: true, reason: 'life' });
      await recordFinishedMatch(matchId);
      expect((await standing(a))!.placementsRemaining).toBe(9);
    });
  });

  describe('DISCONNECT AND TIMEOUT REASONS', () => {
    it('timeout and concede rate identically to a normal loss', async () => {
      // Deliberate: any reason that dodged rating loss would be an instruction
      // to use it. "Stall until the turn timer fires" must cost exactly what
      // losing on life costs, or it becomes the correct play when behind.
      const results: Record<string, number> = {};
      for (const reason of ['life', 'deckout', 'concede', 'timeout']) {
        const a = await makeProfile(`w-${reason}`);
        const b = await makeProfile(`l-${reason}`);
        const matchId = await makeMatch('ranked', a, b);
        finish(matchId, { winner: '0', reason });
        await recordFinishedMatch(matchId);
        results[reason] = (await standing(b))!.rating;
      }
      expect(results.timeout).toBe(results.life);
      expect(results.concede).toBe(results.life);
      expect(results.deckout).toBe(results.life);
    });

    it('a match with no gameover is not recorded and rates nothing', async () => {
      // An abandoned match never reaches `ctx.gameover`, so the sweeper never
      // sees it — which is correct: an unfinished match is not a result.
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('ranked', a, b);
      vendorMatches.set(matchId, { state: { ctx: {} }, metadata: { updatedAt: Date.now() } });

      expect((await recordFinishedMatch(matchId)).status).toBe('skipped');
      expect(await standing(a)).toBeNull();
    });
  });

  describe('RENAME SAFETY: rating is keyed on the profile id', () => {
    it('survives both players renaming themselves between matches', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');

      const first = await makeMatch('ranked', a, b);
      finish(first, { winner: '0', reason: 'life' });
      await recordFinishedMatch(first);

      const afterFirst = (await standing(a))!;
      expect(afterFirst.wins).toBe(1);

      // The exact operation that orphaned everything under the legacy schema:
      // ranked tables were keyed on the display name, so after this the old row
      // was unreachable and the next match created a brand-new one at 1500.
      seq += 1;
      await query(`UPDATE core.profiles SET display_name = $2 WHERE id = $1::bigint`, [
        a,
        `ranked-test-renamed-a-${seq}`,
      ]);
      await query(`UPDATE core.profiles SET display_name = $2 WHERE id = $1::bigint`, [
        b,
        `ranked-test-renamed-b-${seq}`,
      ]);

      const second = await makeMatch('ranked', a, b);
      finish(second, { winner: '0', reason: 'life' });
      await recordFinishedMatch(second);

      const afterSecond = (await standing(a))!;
      // Same row, continued: two wins, eight placements left, and a rating that
      // built on the first result rather than restarting from 1500.
      expect(afterSecond.wins).toBe(2);
      expect(afterSecond.placementsRemaining).toBe(8);
      expect(afterSecond.rating).toBeGreaterThan(afterFirst.rating);

      const { rows } = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM game.ranked_profiles
          WHERE season_id = $1 AND profile_id = $2::bigint`,
        [seasonId, a],
      );
      expect(rows[0]!.n).toBe('1');
    });

    it('the ladder history still names the renamed player, because it joins on id', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('ranked', a, b);
      finish(matchId, { winner: '0', reason: 'life' });
      await recordFinishedMatch(matchId);

      seq += 1;
      const newName = `ranked-test-postrename-${seq}`;
      await query(`UPDATE core.profiles SET display_name = $2 WHERE id = $1::bigint`, [b, newName]);

      const history = await repo.recentRankedMatches(a, 10);
      expect(history).toHaveLength(1);
      expect(history[0]!.outcome).toBe('win');
      expect(history[0]!.opponentDisplayName).toBe(newName);
      expect(history[0]!.lpDelta).toBeGreaterThan(0);
    });
  });

  describe('THE GENERATED LADDER ORDINAL', () => {
    it('agrees with ordinalOf() in TypeScript for every position on the ladder', async () => {
      // Two implementations of one formula, in SQL and in TypeScript. The SQL
      // one decides the leaderboard's ORDER BY; the TypeScript one decides what
      // a promotion is. They cannot be allowed to disagree.
      const p = await makeProfile('ord');
      const cases: Array<{ tier: number; division: Division; lp: number }> = [];
      for (let tier = 0; tier <= 6; tier += 1) {
        for (const division of [4, 3, 2, 1] as Division[]) {
          for (const lp of [0, 1, 37, 99, 100]) cases.push({ tier, division, lp });
        }
      }
      for (const lp of [0, 1, 100, 250, 4_000]) cases.push({ tier: 7, division: 1, lp });

      await query(
        `INSERT INTO game.ranked_profiles (season_id, profile_id) VALUES ($1, $2::bigint)`,
        [seasonId, p],
      );

      for (const c of cases) {
        const { rows } = await query<{ ladder_ordinal: number }>(
          `UPDATE game.ranked_profiles SET tier = $3, division = $4, lp = $5
            WHERE season_id = $1 AND profile_id = $2::bigint
            RETURNING ladder_ordinal`,
          [seasonId, p, c.tier, c.division, c.lp],
        );
        expect({ ...c, ordinal: Number(rows[0]!.ladder_ordinal) }).toEqual({
          ...c,
          ordinal: ladderOrdinalOf(c),
        });
      }
    });

    it('refuses an impossible position rather than storing it', async () => {
      const p = await makeProfile('chk');
      await query(
        `INSERT INTO game.ranked_profiles (season_id, profile_id) VALUES ($1, $2::bigint)`,
        [seasonId, p],
      );
      // Mythic has no divisions.
      await expect(
        query(
          `UPDATE game.ranked_profiles SET tier = 7, division = 3
            WHERE season_id = $1 AND profile_id = $2::bigint`,
          [seasonId, p],
        ),
      ).rejects.toThrow();
      // Only Mythic may exceed 100 LP.
      await expect(
        query(
          `UPDATE game.ranked_profiles SET tier = 3, lp = 400
            WHERE season_id = $1 AND profile_id = $2::bigint`,
          [seasonId, p],
        ),
      ).rejects.toThrow();
    });
  });

  describe('SEASONS', () => {
    it('keeps exactly one active season, whoever asks and however often', async () => {
      const seasons = await Promise.all([
        ensureActiveSeason(),
        ensureActiveSeason(),
        ensureActiveSeason(),
      ]);
      expect(new Set(seasons.map((s) => s.id)).size).toBe(1);

      const { rows } = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM game.ranked_seasons WHERE active`,
      );
      expect(rows[0]!.n).toBe('1');
    });

    it('rates a match into the season that CONTAINED it, not the current one', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('ranked', a, b);
      const season = await repo.getSeason(seasonId);
      // One second after the season opened — comfortably inside it.
      finish(matchId, { winner: '0', reason: 'life' }, new Date(season!.startedAt.getTime() + 1000));
      await recordFinishedMatch(matchId);

      const { rows } = await query<{ season_id: string }>(
        `SELECT season_id FROM game.ranked_match_ratings WHERE match_id = $1`,
        [matchId],
      );
      expect(rows[0]!.season_id).toBe(seasonId);
    });
  });

  describe('THE LEADERBOARD READ MODEL', () => {
    it('hides players who are still in placements', async () => {
      const a = await makeProfile('a');
      const b = await makeProfile('b');
      const matchId = await makeMatch('ranked', a, b);
      finish(matchId, { winner: '0', reason: 'life' });
      await recordFinishedMatch(matchId);

      const board = await repo.topStandings(seasonId, 500);
      const ids = board.map((e) => e.profileId);
      expect(ids).not.toContain(a);
      expect(ids).not.toContain(b);
      expect(await repo.standingRank(seasonId, a)).toBeNull();
    });

    it('orders by the visible ladder, so the list is sorted by what it shows', async () => {
      const low = await makeProfile('low');
      const high = await makeProfile('high');
      // Placed players, one clearly above the other.
      await query(
        `INSERT INTO game.ranked_profiles
           (season_id, profile_id, tier, division, lp, placements_remaining, rating)
         VALUES ($1, $2::bigint, 1, 3, 20, 0, 2400),
                ($1, $3::bigint, 5, 1, 80, 0, 1200)`,
        [seasonId, low, high],
      );
      const board = await repo.topStandings(seasonId, 500);
      const posLow = board.findIndex((e) => e.profileId === low);
      const posHigh = board.findIndex((e) => e.profileId === high);
      expect(posHigh).toBeGreaterThanOrEqual(0);
      // Master I beats Silver III even though the hidden rating says otherwise —
      // the legacy board ordered by hidden rating and displayed neither.
      expect(posHigh).toBeLessThan(posLow);
    });
  });
});
