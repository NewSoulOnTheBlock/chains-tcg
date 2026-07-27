// src/ranked/glicko2.ts
// Glicko-2 rating system implementation. Pure functions; rating service composes
// these into LP / visible-rank logic.

const SCALE = 173.7178;       // Glicko-2 internal scale factor
const TAU   = 0.5;            // system constant; smaller = ratings change slowly
const EPS   = 0.000001;       // convergence tolerance

export type Glicko2 = { mu: number; phi: number; sigma: number };
export type Outcome = 0 | 0.5 | 1;   // loss / draw / win (from this player's POV)

export function fromGlicko1(rating: number, rd: number, sigma: number): Glicko2 {
  return { mu: (rating - 1500) / SCALE, phi: rd / SCALE, sigma };
}
export function toGlicko1(g: Glicko2): { rating: number; rd: number; sigma: number } {
  return { rating: g.mu * SCALE + 1500, rd: g.phi * SCALE, sigma: g.sigma };
}

function g(phi: number)  { return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI)); }
function E(mu: number, mu_j: number, phi_j: number) {
  return 1 / (1 + Math.exp(-g(phi_j) * (mu - mu_j)));
}

/**
 * Update a player's Glicko-2 rating against one or more opponents this period.
 * `opponents` are in internal scale; `outcomes` are aligned 1:1.
 */
export function update(
  player: Glicko2,
  opponents: Glicko2[],
  outcomes: Outcome[],
): Glicko2 {
  if (opponents.length === 0) {
    const phiPrime = Math.sqrt(player.phi * player.phi + player.sigma * player.sigma);
    return { mu: player.mu, phi: phiPrime, sigma: player.sigma };
  }

  // Variance v
  let vInv = 0;
  for (let i = 0; i < opponents.length; i++) {
    const o = opponents[i];
    const gj = g(o.phi);
    const ej = E(player.mu, o.mu, o.phi);
    vInv += gj * gj * ej * (1 - ej);
  }
  const v = 1 / vInv;

  // Improvement delta
  let deltaSum = 0;
  for (let i = 0; i < opponents.length; i++) {
    const o = opponents[i];
    deltaSum += g(o.phi) * (outcomes[i] - E(player.mu, o.mu, o.phi));
  }
  const delta = v * deltaSum;

  // New volatility σ' via Illinois bracketing
  const a = Math.log(player.sigma * player.sigma);
  const f = (x: number) => {
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
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPS) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA = fA / 2; }
    B = C; fB = fC;
  }
  const sigmaPrime = Math.exp(A / 2);

  // Pre-rating period RD
  const phiStar = Math.sqrt(player.phi * player.phi + sigmaPrime * sigmaPrime);

  // New RD / μ
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muPrime = player.mu + phiPrime * phiPrime * deltaSum;
  return { mu: muPrime, phi: phiPrime, sigma: sigmaPrime };
}

/** Convenience for the common 1v1 case using display-scale rating/RD. */
export function update1v1(
  player: { rating: number; rd: number; sigma: number },
  opponent: { rating: number; rd: number; sigma: number },
  outcome: Outcome,
): { rating: number; rd: number; sigma: number } {
  const p = fromGlicko1(player.rating, player.rd, player.sigma);
  const o = fromGlicko1(opponent.rating, opponent.rd, opponent.sigma);
  const next = update(p, [o], [outcome]);
  return toGlicko1(next);
}
