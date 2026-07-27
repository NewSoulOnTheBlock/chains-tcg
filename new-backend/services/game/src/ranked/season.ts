/**
 * Season lifecycle, ported from `src/ranked/season-service.ts`.
 *
 * ── The rollover is an INSERT, not a rewrite ────────────────────────────────
 * The legacy `rollSeason` loaded every ranked profile in the outgoing season and
 * UPDATEd each one in place: rating soft-reset, rank back to Bronze IV,
 * placements re-armed, season_id repointed. Two problems with that, both
 * serious:
 *
 *   1. It destroyed the outgoing season's final standings. The comment above it
 *      said "archive standings"; nothing archived anything. For a season with a
 *      prize on rank 1, the final board is the single row you must still be able
 *      to produce a week later, and it was gone the instant the rollover ran.
 *
 *   2. It was O(every account who ever played) inside whatever request happened
 *      to call `ensureActiveSeason()` first — which, in the legacy code, was any
 *      queue join, any profile read, any leaderboard fetch.
 *
 * Because 0012 keys standings on (season_id, profile_id), neither is necessary.
 * A rollover is: deactivate the old row, insert the new one. The soft reset
 * happens lazily, as the seeding expression on the first standing a player earns
 * in the new season (`ensureStanding` in repo/ranked.repo.ts), so it costs
 * nothing for players who do not come back and produces the identical number for
 * players who do.
 */
import { createLogger, isUniqueViolation, withTransaction } from '@chains/shared';
import { config } from '../config.js';
import * as repo from '../repo/ranked.repo.js';
import { TIERS } from './ranks.js';

const log = createLogger({ service: 'game' }).child({ component: 'ranked-season' });

const DAY_MS = 86_400_000;

/** Deterministic id from the start date, so a rollover is idempotent by name. */
export function seasonIdFor(startedAt: Date): string {
  return `season-${startedAt.toISOString().slice(0, 10)}`;
}

/**
 * The reward blob.
 *
 * Copy only. Nothing in this backend pays out from it and no code branches on
 * its contents — the prize is settled by hand, outside the software, and
 * pretending otherwise by wiring it to the wager service would create a payout
 * path that the C-1 design deliberately does not have.
 */
function rewardDefinitions(): unknown {
  return {
    champion: {
      title: 'Season Champion',
      description: 'Awarded to the #1 player on the season leaderboard at season end.',
    },
    tiers: Object.fromEntries(
      TIERS.map((t) => [t, { cardback: `cardback_${t.toLowerCase()}`, title: `${t} Memer` }]),
    ),
  };
}

function nextSeason(startedAt: Date): repo.NewSeason {
  return {
    id: seasonIdFor(startedAt),
    name: 'Genesis Season',
    startedAt,
    endsAt: new Date(startedAt.getTime() + config.RANKED_SEASON_DURATION_DAYS * DAY_MS),
    softResetFactor: config.RANKED_SEASON_SOFT_RESET,
    rewardDefinitions: rewardDefinitions(),
  };
}

/**
 * Short-lived memo, so a polling client does not put a `WHERE active` query on
 * Postgres every second. Never outlives the season it caches, and 30s of
 * staleness costs nothing: the only thing that changes at a rollover is which
 * season new results land in, and results are resolved by `getSeasonAt` from the
 * match's own finish time anyway.
 */
const MEMO_MS = 30_000;
let memo: { season: repo.SeasonRow; until: number } | null = null;

export function clearSeasonMemo(): void {
  memo = null;
}

/**
 * The active season, bootstrapping or rolling over if needed.
 *
 * Race-safe across containers by construction:
 *   • the rollover takes `FOR UPDATE` on the outgoing season row, so the second
 *     container to arrive waits and then re-reads a row that is no longer
 *     active, and bails out;
 *   • `ranked_seasons_one_active` turns any remaining race into a 23505, which
 *     is caught here and answered by re-reading.
 */
export async function ensureActiveSeason(): Promise<repo.SeasonRow> {
  const now = Date.now();
  if (memo && memo.until > now) return memo.season;

  const current = await repo.getActiveSeason();
  if (current && current.endsAt.getTime() > now) return remember(current, now);

  try {
    const rolled = await withTransaction(async (c) => {
      const locked = await repo.lockActiveSeason(c);

      // Somebody else rolled it while we waited for the lock.
      if (locked && locked.endsAt.getTime() > Date.now()) return locked;

      if (locked) {
        await repo.deactivateSeason(c, locked.id);
        log.info('season ended', { seasonId: locked.id });
      }

      const startedAt = new Date();
      const inserted = await repo.insertActiveSeason(c, nextSeason(startedAt));
      if (inserted) {
        log.info('season started', {
          seasonId: inserted.id,
          endsAt: inserted.endsAt.toISOString(),
          softResetFactor: locked?.softResetFactor ?? config.RANKED_SEASON_SOFT_RESET,
        });
        return inserted;
      }

      // The id already existed (same calendar day) but was not active. Reactivate
      // it rather than minting a second season for the same day.
      const existing = await repo.getSeason(seasonIdFor(startedAt), c);
      if (!existing) throw new Error('ranked: season insert produced no row and none exists');
      await c.query(`UPDATE game.ranked_seasons SET active = TRUE WHERE id = $1`, [existing.id]);
      return { ...existing, active: true };
    });
    return remember(rolled, Date.now());
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost the race on `ranked_seasons_one_active`. The winner's season is the
    // answer; re-read it.
    const winner = await repo.getActiveSeason();
    if (!winner) throw err;
    return remember(winner, Date.now());
  }
}

function remember(season: repo.SeasonRow, now: number): repo.SeasonRow {
  memo = { season, until: Math.min(now + MEMO_MS, season.endsAt.getTime()) };
  return season;
}

/**
 * The season a match played at `at` belongs to, read INSIDE the caller's
 * transaction.
 *
 * Takes the result transaction's own client on purpose. Reading the season on a
 * second connection would read a different snapshot from the one the result row
 * is being written in, and this function decides which season a rating change
 * lands in — that must not be able to disagree with itself.
 *
 * It never CREATES a season. Bootstrapping is `ensureActiveSeason`, which needs
 * its own transaction and a row lock, and nesting that inside the result
 * transaction would hold the match's locks across a rollover. The service calls
 * `ensureActiveSeason()` at boot before the result sweeper starts, so the only
 * way to reach the null return is for the seasons table to have been emptied
 * underneath a running service — in which case refusing to rate is correct.
 */
export async function seasonForResult(
  c: import('@chains/shared').PoolClient,
  at: Date,
): Promise<repo.SeasonRow | null> {
  const contained = await repo.getSeasonAt(at, c);
  if (contained) return contained;

  const active = await repo.getActiveSeason(c);
  if (active) {
    // A match finished before the ladder existed, or in a gap between seasons.
    // Rating it into the current season is the least-wrong answer, and saying so
    // out loud is the point of this branch.
    log.warn('no season contains this result; rating it into the active season', {
      finishedAt: at.toISOString(),
      seasonId: active.id,
    });
    return active;
  }

  log.error('no ranked season exists — refusing to rate this match', {
    finishedAt: at.toISOString(),
  });
  return null;
}
