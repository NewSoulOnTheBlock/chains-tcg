/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RATING, INSIDE THE AUTHORITATIVE RESULT TRANSACTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the only function in the backend that changes a ranked rating, and it
 * is not reachable from any HTTP route. It is called by
 * `results/recorder.ts::recordFinishedMatch`, with that function's transaction
 * client, at exactly one point: after
 *
 *     INSERT INTO game.match_results ... ON CONFLICT (match_id) DO NOTHING
 *
 * has reported `rowCount > 0`.
 *
 * ── Why that point and no other ────────────────────────────────────────────
 * `rowCount > 0` on that statement means precisely "this match's result is being
 * recorded for the first time, ever". It is not an approximation of that
 * statement, it is that statement, made by the primary key. Hanging the rating
 * update off it means exactly-once rating application is not a property this
 * module has to implement, argue for, or test in isolation — it is inherited,
 * whole, from the same guarantee that already keeps `core.profiles.wins` from
 * double-counting.
 *
 * The legacy service reached for the same idea and missed it. `ingestMatchResult`
 * did:
 *
 *     const status = await RDB.recordRankedMatch(m, ratings);   // its own tx
 *     if (status === 'duplicate') return 'duplicate';
 *     await RDB.upsertRankedProfile(aNext);                     // separate tx
 *     await RDB.upsertRankedProfile(bNext);                     // separate tx
 *
 * Three transactions. A crash between the first and the second leaves the match
 * marked recorded with neither rating written, and the retry sees 'duplicate'
 * and does nothing — the result is permanently lost. Worse, it was reachable
 * from `POST /api/ranked/match/result`, an unauthenticated HTTP route that took
 * `player0`, `player1` and `winner` from the request body. With a prize
 * attached, that route is the entire product.
 *
 * ── What this function must never become ──────────────────────────────────
 * It must never be exported to a route, never take a winner from an argument
 * that did not come from `ctx.gameover`, and never open a transaction of its
 * own. Everything it does happens on the caller's client `c`, so if the caller
 * rolls back — for any reason, including a foreign key violation three lines
 * later — the rating change goes with it.
 *
 * ── Draws, concedes and timeouts ──────────────────────────────────────────
 * A DRAW (`winnerSeat === null`) is a rated result. Glicko-2 scores it 0.5 for
 * both seats, so the two ratings converge slightly and both deviations shrink —
 * a draw genuinely is evidence that two players are close. It moves no LP and
 * touches neither the win nor the loss counter (`core.profiles` has no draws
 * column; `game.ranked_profiles.draws` records it on the ladder side). It does
 * consume a placement game, because it is a game that produced information.
 *
 * CONCEDE and TIMEOUT are rated exactly like any other loss, and that is a
 * decision rather than an omission. The tempting alternative — "don't punish
 * someone whose connection dropped" — makes disconnecting the cheapest way to
 * avoid losing rating. On a ladder with a prize on rank 1, any reason that
 * dodges rating loss is not an edge case, it is the strategy: stall until the
 * turn timer fires, or pull the cable when the board turns. `timeout` is
 * additionally not a proxy for "disconnected": `claimTimeout` is a move the
 * OPPONENT makes, legal only once the server-held `G.turnDeadline` plus a grace
 * period has passed, so it fires on a player who is present and stalling exactly
 * as it does on one who left.
 *
 * There is no `disconnect` reason in `ResultReason` at all, and none should be
 * added: a disconnect that never reaches a timeout leaves the match `live` with
 * no `ctx.gameover`, so the sweeper never sees it, so no rating moves. That is
 * the correct behaviour — an unfinished match is not a result.
 */
import { createLogger, type PoolClient } from '@chains/shared';
import { config } from '../config.js';
import * as repo from '../repo/ranked.repo.js';
import { assessSmurf } from './anti-smurf.js';
import { DEFAULT_RATING } from './glicko2.js';
import { rateMatch, type Standing, type StandingChange } from './rating.js';
import { seasonForResult } from './season.js';

const log = createLogger({ service: 'game' }).child({ component: 'ranked-result' });

/** Recent results consulted by the (inert) smurf heuristics. */
const SMURF_WINDOW = 10;

export interface RankedResultInput {
  matchId: string;
  /** Read from the locked `game.matches` row — never from a request. */
  mode: string;
  seat0Profile: string | null;
  seat1Profile: string | null;
  /** null == draw, exactly as in `game.match_results`. */
  winnerSeat: 0 | 1 | null;
  reason: string;
  /** The same instant that was signed into `server_sig`. */
  finishedAt: Date;
}

export interface RankedResultOutcome {
  applied: boolean;
  seasonId?: string;
  seat0LpDelta?: number;
  seat1LpDelta?: number;
}

function toStanding(row: repo.StandingRow): Standing {
  return {
    rating: row.rating,
    ratingDeviation: row.ratingDeviation,
    volatility: row.volatility,
    tier: row.tier,
    division: row.division,
    lp: row.lp,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    placementsRemaining: row.placementsRemaining,
  };
}

/**
 * Apply one finished match to the ladder. Returns `applied: false` for every
 * match that is not a rated ranked game, having changed nothing.
 */
export async function applyRankedResult(
  c: PoolClient,
  input: RankedResultInput,
): Promise<RankedResultOutcome> {
  if (!config.RANKED_ENABLED) return { applied: false };

  // ── The mode gate ───────────────────────────────────────────────────────
  // `input.mode` comes from the `game.matches` row the caller already locked
  // FOR UPDATE. It is not in the result, not in a request body, and cannot
  // change between this check and the writes below, because the lock is held
  // for the rest of the transaction. A casual or wager match reaches here and
  // leaves without touching a rating table.
  if (input.mode !== 'ranked') return { applied: false };

  const { seat0Profile, seat1Profile } = input;
  if (seat0Profile === null || seat1Profile === null) {
    // A ranked match always has both seats filled — `claimSeat1` is what flips
    // it to `live`. If one is missing the row was hand-edited or the match was
    // voided mid-flight; rating half a match is worse than rating none of it.
    log.warn('ranked match finished with an empty seat — not rating', {
      matchId: input.matchId,
      seat0: seat0Profile,
      seat1: seat1Profile,
    });
    return { applied: false };
  }
  if (seat0Profile === seat1Profile) {
    log.warn('ranked match has the same profile in both seats — not rating', {
      matchId: input.matchId,
    });
    return { applied: false };
  }

  const season = await seasonForResult(c, input.finishedAt);
  if (!season) return { applied: false };

  const placements = config.RANKED_PLACEMENT_MATCHES;

  // ── Lock order ──────────────────────────────────────────────────────────
  // Both standings are created if missing, then locked in ASCENDING PROFILE ID
  // order. Two matches that share a player can finish in the same instant —
  // nothing prevents a profile holding two live ranked matches, since
  // `POST /games/create` does not go through the queue — and without the lock
  // both transactions read the same "before" and the later COMMIT silently
  // discards the earlier one's rating change. A fixed order is what makes the
  // second transaction wait instead of deadlocking against the first.
  const [firstId, secondId] =
    BigInt(seat0Profile) <= BigInt(seat1Profile)
      ? [seat0Profile, seat1Profile]
      : [seat1Profile, seat0Profile];

  await repo.ensureStanding(c, season.id, firstId, placements);
  await repo.ensureStanding(c, season.id, secondId, placements);
  const lockedFirst = await repo.lockStanding(c, season.id, firstId);
  const lockedSecond = await repo.lockStanding(c, season.id, secondId);
  if (!lockedFirst || !lockedSecond) {
    // `ensureStanding` inserts unconditionally, so this means a profile row
    // vanished between the two statements — a deleted account mid-match. The FK
    // is ON DELETE CASCADE, so there is nothing left to rate.
    log.warn('ranked standing missing after ensure — profile deleted mid-match?', {
      matchId: input.matchId,
      seasonId: season.id,
    });
    return { applied: false };
  }

  const seat0Row = lockedFirst.profileId === seat0Profile ? lockedFirst : lockedSecond;
  const seat1Row = lockedFirst.profileId === seat1Profile ? lockedFirst : lockedSecond;

  const rated = rateMatch(toStanding(seat0Row), toStanding(seat1Row), input.winnerSeat);

  await persistSeat(c, season, seat0Profile, seat0Row, rated.seat0, input.finishedAt);
  await persistSeat(c, season, seat1Profile, seat1Row, rated.seat1, input.finishedAt);

  await repo.insertMatchRating(c, {
    matchId: input.matchId,
    seasonId: season.id,
    seat0Profile,
    seat1Profile,
    winnerSeat: input.winnerSeat,
    reason: input.reason,
    seat0RatingBefore: rated.seat0.before.rating,
    seat0RatingAfter: rated.seat0.after.rating,
    seat1RatingBefore: rated.seat1.before.rating,
    seat1RatingAfter: rated.seat1.after.rating,
    seat0LpDelta: rated.seat0.lpDelta,
    seat1LpDelta: rated.seat1.lpDelta,
    seat0OrdinalAfter: rated.seat0.ordinalAfter,
    seat1OrdinalAfter: rated.seat1.ordinalAfter,
  });

  log.info('ranked result applied', {
    matchId: input.matchId,
    seasonId: season.id,
    winnerSeat: input.winnerSeat,
    reason: input.reason,
    seat0LpDelta: rated.seat0.lpDelta,
    seat1LpDelta: rated.seat1.lpDelta,
    seat0PlacementsLeft: rated.seat0.after.placementsRemaining,
    seat1PlacementsLeft: rated.seat1.after.placementsRemaining,
  });

  return {
    applied: true,
    seasonId: season.id,
    seat0LpDelta: rated.seat0.lpDelta,
    seat1LpDelta: rated.seat1.lpDelta,
  };
}

async function persistSeat(
  c: PoolClient,
  season: repo.SeasonRow,
  profileId: string,
  before: repo.StandingRow,
  change: StandingChange,
  finishedAt: Date,
): Promise<void> {
  // Anti-smurf runs on the POST-match standing and its output is written to the
  // row for an operator to read. Nothing above this line consulted it, and
  // nothing below acts on it — `mmr_multiplier` stays 1.0. See anti-smurf.ts for
  // why re-enabling the multiplier is a change to the rating system, not a
  // config tweak.
  const accountCreatedAt = await repo.profileCreatedAt(profileId, c);
  const recent = await repo.recentOutcomes(season.id, profileId, SMURF_WINDOW, c);
  const smurf = assessSmurf({
    wins: change.after.wins,
    losses: change.after.losses,
    draws: change.after.draws,
    rating: change.after.rating,
    baselineRating: DEFAULT_RATING,
    placementsRemaining: change.after.placementsRemaining,
    accountCreatedAt: accountCreatedAt ?? finishedAt,
    recentOutcomes: [change.outcome, ...recent],
    now: finishedAt,
  });

  if (smurf.flagged && !before.smurfFlagged) {
    log.info('anti-smurf flag raised (advisory only — no rating effect)', {
      profileId,
      seasonId: season.id,
      reasons: smurf.reasons,
      wouldHaveMultipliedBy: smurf.advisoryMmrMultiplier,
    });
  }

  await repo.writeStanding(c, season.id, profileId, {
    ...change.after,
    smurfFlagged: smurf.flagged,
    smurfReasons: smurf.reasons,
  });
}
