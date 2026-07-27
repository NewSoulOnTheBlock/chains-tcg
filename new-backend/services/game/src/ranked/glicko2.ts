/**
 * Glicko-2, ported from `src/ranked/glicko2.ts` on the legacy server.
 *
 * Pure maths, no imports, no I/O — which is why it came across essentially
 * verbatim and why it is the one part of the ladder that can be tested to the
 * published reference values (see `__tests__/glicko2.test.ts`, which pins
 * Glickman's own worked example from glicko.net/glicko/glicko2.pdf).
 *
 * TWO CHANGES FROM THE LEGACY FILE, both about where this now runs:
 *
 *   1. Both iterative loops are bounded. This code executes INSIDE the
 *      transaction that records a match result, while that transaction holds
 *      `FOR UPDATE` locks on `game.matches` and two `game.ranked_profiles`
 *      rows. An unbounded `while` there is not a hang, it is a lock held
 *      forever and a pool that fills up behind it. The legacy version ran on a
 *      request thread with no locks held, so it could afford not to care.
 *      Neither bound is reachable for well-formed inputs — the volatility
 *      solver converges in single-digit iterations at TAU = 0.5 — so hitting
 *      one means the inputs are already wrong, and throwing rolls the
 *      transaction back rather than writing a rating derived from a
 *      non-converged root.
 *
 *   2. Inputs are checked for finiteness on the way in. `rating_deviation > 0`
 *      and `volatility > 0` are CHECK constraints in 0012, so a row from the
 *      database cannot violate them; this catches the case where a caller
 *      composes a state in memory and gets it wrong, before a NaN propagates
 *      into a stored rating where it is very hard to unpick.
 */

/** Glicko-2 internal scale factor. */
const SCALE = 173.7178;
/** System constant. Smaller = ratings change more slowly. */
const TAU = 0.5;
/** Convergence tolerance for the volatility solver. */
const EPS = 0.000001;
/** See note 1 above. Both are ~10x the worst case observed in practice. */
const MAX_BRACKET_STEPS = 100;
const MAX_ILLINOIS_STEPS = 100;

/** The starting rating for an unrated player, in display scale. */
export const DEFAULT_RATING = 1500;
/** The starting deviation. High on purpose: a new account converges fast. */
export const DEFAULT_RD = 350;
/** The starting volatility, per Glickman's recommendation. */
export const DEFAULT_VOLATILITY = 0.06;

/** A rating in Glicko-2's internal scale. */
export interface Glicko2 {
  mu: number;
  phi: number;
  sigma: number;
}

/** A rating in the display scale a human would recognise. */
export interface Rating {
  rating: number;
  rd: number;
  sigma: number;
}

/** Score from one player's point of view: loss, draw, win. */
export type Outcome = 0 | 0.5 | 1;

export function fromGlicko1(rating: number, rd: number, sigma: number): Glicko2 {
  return { mu: (rating - DEFAULT_RATING) / SCALE, phi: rd / SCALE, sigma };
}

export function toGlicko1(g: Glicko2): Rating {
  return { rating: g.mu * SCALE + DEFAULT_RATING, rd: g.phi * SCALE, sigma: g.sigma };
}

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function E(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

function assertFinite(label: string, ...values: number[]): void {
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error(`glicko2: ${label} is not finite (${String(v)})`);
  }
}

/**
 * Update a player's rating against every opponent faced in one rating period.
 * `opponents` are in internal scale and `outcomes` is aligned to it 1:1.
 *
 * We run one match per period (see rating.ts for why), so `opponents` has
 * length 1 in every production call. The general form is kept because it is the
 * algorithm as published, and because collapsing it would make this file
 * impossible to check against the paper.
 */
export function update(player: Glicko2, opponents: Glicko2[], outcomes: Outcome[]): Glicko2 {
  assertFinite('player', player.mu, player.phi, player.sigma);
  if (player.phi <= 0 || player.sigma <= 0) {
    throw new Error('glicko2: phi and sigma must be positive');
  }
  if (opponents.length !== outcomes.length) {
    throw new Error('glicko2: opponents and outcomes must be the same length');
  }

  // No games this period: only uncertainty grows.
  if (opponents.length === 0) {
    const phiPrime = Math.sqrt(player.phi * player.phi + player.sigma * player.sigma);
    return { mu: player.mu, phi: phiPrime, sigma: player.sigma };
  }

  // Estimated variance of the player's rating, from game outcomes alone.
  let vInv = 0;
  for (const o of opponents) {
    assertFinite('opponent', o.mu, o.phi, o.sigma);
    const gj = g(o.phi);
    const ej = E(player.mu, o.mu, o.phi);
    vInv += gj * gj * ej * (1 - ej);
  }
  if (vInv <= 0) throw new Error('glicko2: degenerate variance');
  const v = 1 / vInv;

  // Estimated improvement, comparing actual to expected.
  let deltaSum = 0;
  for (let i = 0; i < opponents.length; i += 1) {
    const o = opponents[i] as Glicko2;
    deltaSum += g(o.phi) * ((outcomes[i] as Outcome) - E(player.mu, o.mu, o.phi));
  }
  const delta = v * deltaSum;

  // New volatility, by Illinois-method root finding on f.
  const a = Math.log(player.sigma * player.sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - player.phi * player.phi - v - ex);
    const den = 2 * Math.pow(player.phi * player.phi + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (delta * delta > player.phi * player.phi + v) {
    B = Math.log(delta * delta - player.phi * player.phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) {
      k += 1;
      if (k > MAX_BRACKET_STEPS) {
        throw new Error('glicko2: failed to bracket the volatility root');
      }
    }
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);
  let steps = 0;
  while (Math.abs(B - A) > EPS) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
    steps += 1;
    if (steps > MAX_ILLINOIS_STEPS) {
      throw new Error('glicko2: volatility solver did not converge');
    }
  }
  const sigmaPrime = Math.exp(A / 2);

  // Pre-rating-period deviation, then the post-game deviation and rating.
  const phiStar = Math.sqrt(player.phi * player.phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = player.mu + phiPrime * phiPrime * deltaSum;

  assertFinite('result', muPrime, phiPrime, sigmaPrime);
  return { mu: muPrime, phi: phiPrime, sigma: sigmaPrime };
}

/** The 1v1 case in display scale — the only shape this ladder ever uses. */
export function update1v1(player: Rating, opponent: Rating, outcome: Outcome): Rating {
  const p = fromGlicko1(player.rating, player.rd, player.sigma);
  const o = fromGlicko1(opponent.rating, opponent.rd, opponent.sigma);
  return toGlicko1(update(p, [o], [outcome]));
}
