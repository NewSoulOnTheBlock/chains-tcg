/**
 * Anti-smurf heuristics, ported from `src/ranked/anti-smurf.ts` — and
 * DELIBERATELY INERT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE WIRING THE MULTIPLIER BACK IN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The legacy version returned an `mmrMultiplier` (1.0 to 2.0) which
 * rating-service.ts then applied to the WINNER's Glicko delta:
 *
 *     const gain = (aRatingNext.rating - a.hiddenMmr) * aSmurf.mmrMultiplier;
 *     aRatingNext.rating = a.hiddenMmr + gain;
 *
 * That is not a tuning knob, it is a hole in the algorithm, for two separate
 * reasons:
 *
 *   1. IT DECALIBRATES THE RATING. Glicko-2's update is the maximum-likelihood
 *      step given the player's own deviation and volatility. Multiplying it by
 *      1.5 produces a number that is no longer an estimate of anything, while
 *      `rating_deviation` and `volatility` keep claiming to describe its
 *      uncertainty. Everything downstream — matchmaking brackets, placement
 *      snapping, the leaderboard order — reads a rating that the stored
 *      confidence interval no longer covers.
 *
 *   2. IT INFLATES THE POOL. Rating exchange is zero-sum by construction: the
 *      winner's gain is the loser's loss. Scaling only the winner's side mints
 *      the difference out of nothing on every flagged win. Over a season, the
 *      whole ladder drifts up, and the drift is largest exactly where the
 *      flagged accounts play — which is the top, where the prize is.
 *
 * Glicko-2 ALREADY solves the problem this was reaching for. A new account
 * starts at RD 350, so its rating moves in large steps and converges within
 * roughly ten games; a genuinely strong player on a new account is at their
 * true rating almost immediately, without anyone flagging them. That is the
 * calibrated version of "let them climb fast", and it is free.
 *
 * So the heuristics stay, the flag is recorded for an operator to look at, and
 * NOTHING in the rating path reads either the flag or the multiplier. See
 * `game.ranked_profiles.mmr_multiplier`, pinned to 1.0 with a CHECK.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE BUGS FIXED IN THE PORT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   a) CLIMB VELOCITY WAS NOT A VELOCITY. The legacy computed
 *      `lpPerDay = p.rankedPoints / seasonAgeDays`, but `rankedPoints` is LP
 *      WITHIN THE CURRENT DIVISION — it is bounded at 100 and it RESETS on
 *      every promotion. A player sitting at Bronze IV 90 LP twelve hours after
 *      signing up scored 180 "LP/day"; a Diamond player who had just promoted
 *      scored 0. It measured nothing, and it fired on new accounts almost
 *      unconditionally. Replaced with rating gained per day, which is
 *      monotone, unbounded and actually a rate.
 *
 *   b) ACCOUNT AGE WAS THE LADDER ROW'S AGE. `p.createdAt` was the ranked
 *      profile's creation timestamp, so a five-year-old account that played its
 *      first ranked game today read as a brand-new account. Now takes
 *      `core.profiles.created_at`, passed in explicitly.
 *
 *   c) THE STREAK CHECK COMPARED A DISPLAY NAME. It read
 *      `m.winner === p.playerId` against the name-keyed match rows — the exact
 *      identity bug 0012 exists to remove. Recent results now arrive as
 *      outcomes already resolved against a profile id by the caller.
 *
 * This module is pure: no database handle, no clock of its own. Everything it
 * needs is an argument, which is what makes it testable and what keeps it from
 * adding a query to the inside of the result transaction (the legacy version
 * did a `recentMatchesFor` round trip there, per player, per match).
 */

const MIN_GAMES_FOR_WINRATE = 30;
const HIGH_WINRATE = 0.8;
const NEW_ACCOUNT_AGE_MS = 5 * 86_400 * 1000;
const NEW_ACCOUNT_MIN_GAMES = 10;
const NEW_ACCOUNT_WINRATE = 0.75;
/** Hidden rating points gained per day, above which a climb looks unusual. */
const RAPID_CLIMB_RATING_PER_DAY = 120;
const STREAK_WINDOW = 10;
const STREAK_WINS = 8;

export interface SmurfInput {
  /** Season-to-date record on the ladder. */
  wins: number;
  losses: number;
  draws: number;
  /** Hidden Glicko rating right now. */
  rating: number;
  /** Rating a fresh account starts at, so "gain" has a baseline. */
  baselineRating: number;
  placementsRemaining: number;
  /** `core.profiles.created_at` — the ACCOUNT's age, not the ladder row's. */
  accountCreatedAt: Date;
  /** Most recent ranked outcomes for this profile, newest first. */
  recentOutcomes: Array<'win' | 'loss' | 'draw'>;
  now: Date;
}

export interface SmurfAssessment {
  flagged: boolean;
  reasons: string[];
  /**
   * What the legacy service WOULD have multiplied the winner's rating gain by.
   * Named `advisory` because nothing multiplies by it: `applyRankedResult`
   * never reads this field. It exists so an operator can see how aggressive the
   * old lever would have been on a given account before anyone re-enables it.
   */
  advisoryMmrMultiplier: number;
  /** Rating points the matchmaker WOULD have biased this player's bracket by. */
  advisoryBracketBoost: number;
}

export function assessSmurf(input: SmurfInput): SmurfAssessment {
  const reasons: string[] = [];
  let mult = 1.0;
  let boost = 0;

  const played = input.wins + input.losses + input.draws;
  // Draws count as played but not as won, so a drawn game dilutes winrate
  // exactly as much as it should.
  const winrate = played > 0 ? input.wins / played : 0;

  if (played >= MIN_GAMES_FOR_WINRATE && winrate >= HIGH_WINRATE) {
    reasons.push(`winrate ${(winrate * 100).toFixed(0)}% over ${played} games`);
    mult = Math.max(mult, 1.5);
    boost = Math.max(boost, 200);
  }

  const accountAgeMs = input.now.getTime() - input.accountCreatedAt.getTime();
  if (
    accountAgeMs >= 0 &&
    accountAgeMs < NEW_ACCOUNT_AGE_MS &&
    played >= NEW_ACCOUNT_MIN_GAMES &&
    winrate >= NEW_ACCOUNT_WINRATE
  ) {
    reasons.push(
      `account ${(accountAgeMs / 86_400_000).toFixed(1)}d old at ${(winrate * 100).toFixed(0)}% over ${played} games`,
    );
    mult = Math.max(mult, 1.75);
    boost = Math.max(boost, 300);
  }

  // Fix (a): rating gained per day, not LP-within-division per day.
  const ageDays = Math.max(0.5, accountAgeMs / 86_400_000);
  const ratingPerDay = (input.rating - input.baselineRating) / ageDays;
  if (ratingPerDay >= RAPID_CLIMB_RATING_PER_DAY && input.placementsRemaining === 0) {
    reasons.push(`climb ${ratingPerDay.toFixed(0)} rating/day`);
    mult = Math.max(mult, 1.3);
    boost = Math.max(boost, 100);
  }

  // Fix (c): outcomes are already resolved against a profile id by the caller.
  const window = input.recentOutcomes.slice(0, STREAK_WINDOW);
  const recentWins = window.filter((o) => o === 'win').length;
  if (window.length >= STREAK_WINS && recentWins >= STREAK_WINS) {
    reasons.push(`streak ${recentWins}/${window.length}`);
    mult = Math.max(mult, 1.4);
  }

  return {
    flagged: reasons.length > 0,
    reasons,
    advisoryMmrMultiplier: Math.min(mult, 2.0),
    advisoryBracketBoost: Math.min(boost, 400),
  };
}
