/**
 * The rating step: two ladder standings and one outcome in, two new standings
 * out. Ported from the arithmetic half of `src/ranked/rating-service.ts`.
 *
 * This module is PURE. That is the whole design: the legacy rating service
 * interleaved Glicko maths, LP shaping, placement handling, database writes and
 * telemetry emission in one 90-line function, so none of it could be tested
 * without a database and the exactly-once question could not even be asked. Here
 * the maths is a function of its arguments, and the transaction that persists it
 * lives in `apply-result.ts` — which is the only place that knows what a
 * database is.
 */
import {
  DEFAULT_RATING,
  DEFAULT_RD,
  DEFAULT_VOLATILITY,
  update1v1,
  type Outcome,
} from './glicko2.js';
import {
  applyLpDelta,
  ladderFromOrdinal,
  ordinalOf,
  placementPlacement,
  toLadderPos,
  toLadderRow,
  type Division,
  type LadderRow,
} from './ranks.js';

export type MatchOutcome = 'win' | 'loss' | 'draw';

/** A ladder standing as stored in `game.ranked_profiles`. */
export interface Standing {
  rating: number;
  ratingDeviation: number;
  volatility: number;
  tier: number;
  division: Division;
  lp: number;
  wins: number;
  losses: number;
  draws: number;
  placementsRemaining: number;
}

export interface StandingChange {
  before: Standing;
  after: Standing;
  outcome: MatchOutcome;
  lpDelta: number;
  ordinalBefore: number;
  ordinalAfter: number;
  promoted: boolean;
  demoted: boolean;
  /** True on the match that ends placements — the rank becomes visible here. */
  placementsCompleted: boolean;
}

export interface RatedMatch {
  seat0: StandingChange;
  seat1: StandingChange;
}

/** A standing for a profile that has never played a ranked game this season. */
export function freshStanding(placementMatches: number): Standing {
  return {
    rating: DEFAULT_RATING,
    ratingDeviation: DEFAULT_RD,
    volatility: DEFAULT_VOLATILITY,
    tier: 0,
    division: 4,
    lp: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    placementsRemaining: placementMatches,
  };
}

/**
 * Seed a new season's standing from the previous one — the soft reset.
 *
 *     newRating = 1500 + (oldRating - 1500) * softResetFactor
 *
 * RD widens by 50 (capped at the 350 starting value) because a season boundary
 * means the system has less recent evidence about everybody. Rank goes back to
 * Bronze IV and placements are re-armed, which is the point of a season.
 *
 * Kept here rather than in SQL as well: the migration's seeding INSERT computes
 * the same expression, and `__tests__/ranked.rating.test.ts` pins the two
 * against each other so they cannot drift.
 */
export function softReset(prev: Standing, softResetFactor: number, placementMatches: number): Standing {
  return {
    rating: DEFAULT_RATING + (prev.rating - DEFAULT_RATING) * softResetFactor,
    ratingDeviation: Math.min(DEFAULT_RD, prev.ratingDeviation + 50),
    volatility: prev.volatility,
    tier: 0,
    division: 4,
    lp: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    placementsRemaining: placementMatches,
  };
}

/** Expected score given a hidden rating gap. Elo's logistic, used for LP shape. */
export function expectedScore(mine: number, theirs: number): number {
  return 1 / (1 + Math.pow(10, (theirs - mine) / 400));
}

/**
 * The hidden rating delta translated into visible LP.
 *
 *   • +-20 LP baseline for an even match.
 *   • Shaped by win expectancy: beating someone the system rates above you pays
 *     up to 40, and losing to them costs as little as 20. That asymmetry is what
 *     makes the visible ladder feel fair while the hidden rating stays the
 *     thing that actually decides matchmaking.
 *   • Doubled while in placements on a win, 1.5x on a loss, so ten games move a
 *     player most of the way to where they belong.
 *   • A draw moves no LP at all. It still moves the hidden rating (Glicko-2
 *     scores it 0.5), which is the honest treatment: a draw IS information about
 *     relative skill, but it is not a ladder result and paying LP for one would
 *     make stalling to a timeout a strategy.
 *
 * `smurfMultiplier` is a parameter and every caller passes 1. See anti-smurf.ts
 * for why it is not wired up, and why re-wiring it is a bigger decision than it
 * looks.
 */
export function lpDeltaFor(
  outcome: MatchOutcome,
  myRating: number,
  oppRating: number,
  inPlacements: boolean,
  smurfMultiplier = 1,
): number {
  if (outcome === 'draw') return 0;
  const expected = expectedScore(myRating, oppRating);
  if (outcome === 'win') {
    const base = 20 + (1 - expected) * 20; // 20-40
    return Math.round(base * (inPlacements ? 2 : 1) * smurfMultiplier);
  }
  const base = 20 + expected * 20; // 20-40
  return -Math.round(base * (inPlacements ? 1.5 : 1));
}

function outcomeFor(seat: 0 | 1, winnerSeat: 0 | 1 | null): MatchOutcome {
  if (winnerSeat === null) return 'draw';
  return winnerSeat === seat ? 'win' : 'loss';
}

function score(outcome: MatchOutcome): Outcome {
  return outcome === 'draw' ? 0.5 : outcome === 'win' ? 1 : 0;
}

function applyOne(self: Standing, opponent: Standing, outcome: MatchOutcome): StandingChange {
  const next = update1v1(
    { rating: self.rating, rd: self.ratingDeviation, sigma: self.volatility },
    { rating: opponent.rating, rd: opponent.ratingDeviation, sigma: opponent.volatility },
    score(outcome),
  );

  const inPlacements = self.placementsRemaining > 0;
  const lpDelta = lpDeltaFor(outcome, self.rating, opponent.rating, inPlacements);

  const posBefore = toLadderPos(self);
  const move = applyLpDelta(posBefore, lpDelta);

  const placementsRemaining = Math.max(0, self.placementsRemaining - 1);
  const placementsCompleted = inPlacements && placementsRemaining === 0;

  // On the match that finishes placements the accumulated LP is discarded and
  // the visible rank is snapped from the hidden rating. Before that point the
  // rank is not shown to anybody (see routes/ranked.ts), so nothing a player
  // saw is being taken away.
  const posAfter = placementsCompleted ? placementPlacement(next.rating) : move.next;
  const rowAfter: LadderRow = toLadderRow(posAfter);

  const after: Standing = {
    rating: next.rating,
    ratingDeviation: next.rd,
    volatility: next.sigma,
    tier: rowAfter.tier,
    division: rowAfter.division,
    lp: rowAfter.lp,
    wins: self.wins + (outcome === 'win' ? 1 : 0),
    losses: self.losses + (outcome === 'loss' ? 1 : 0),
    draws: self.draws + (outcome === 'draw' ? 1 : 0),
    placementsRemaining,
  };

  const ordinalBefore = ordinalOf(posBefore);
  const ordinalAfter = ordinalOf(posAfter);

  return {
    before: self,
    after,
    outcome,
    lpDelta,
    ordinalBefore,
    ordinalAfter,
    // A placement snap is neither a promotion nor a demotion; it is the first
    // time a rank exists at all, and reporting it as a promotion would light up
    // a "you ranked up!" animation for a rank the player never held before.
    promoted: placementsCompleted ? false : move.promoted,
    demoted: placementsCompleted ? false : move.demoted,
    placementsCompleted,
  };
}

/**
 * Rate one finished match.
 *
 * `winnerSeat === null` is a draw, matching `game.match_results.winner_seat`.
 *
 * Both players are rated against the OTHER'S PRE-MATCH standing, not against
 * the value the first update just produced. Running one match as its own rating
 * period is Glicko-2's documented degenerate case and it is what makes the
 * exchange symmetric — computing seat 1 against seat 0's already-updated rating
 * would make the result depend on which seat we happened to process first.
 */
export function rateMatch(seat0: Standing, seat1: Standing, winnerSeat: 0 | 1 | null): RatedMatch {
  return {
    seat0: applyOne(seat0, seat1, outcomeFor(0, winnerSeat)),
    seat1: applyOne(seat1, seat0, outcomeFor(1, winnerSeat)),
  };
}

/** The stored generated column, recomputed in TS. Pinned by a test. */
export function ladderOrdinalOf(row: LadderRow): number {
  return ordinalOf(toLadderPos(row));
}

export { ladderFromOrdinal };
