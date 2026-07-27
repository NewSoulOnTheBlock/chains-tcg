// src/ranked/ranks.ts
// Visible ladder model: 8 tiers × 4 divisions × 100 LP.
// Visible rank deliberately lags hidden MMR — see rating-service.ts for the LP
// award/loss formula.

export const TIERS = [
  'Bronze', 'Silver', 'Gold', 'Platinum',
  'Diamond', 'Master', 'Grandmaster', 'Mythic',
] as const;
export type Tier = typeof TIERS[number];

/** Mythic has no divisions; all others use divisions IV (lowest) → I (highest). */
export const DIVISIONS = [4, 3, 2, 1] as const;
export type Division = 4 | 3 | 2 | 1;

export const LP_MIN = 0;
export const LP_MAX = 100;

export type LadderPos = { tier: Tier; division: Division; lp: number };

export function ladderEqual(a: LadderPos, b: LadderPos) {
  return a.tier === b.tier && a.division === b.division && a.lp === b.lp;
}

/**
 * Compute the absolute "rank ordinal" — a single integer where higher = better.
 * Used for ordering and clamp arithmetic when applying LP deltas across
 * promotions/demotions.
 *
 * Bronze IV @ 0 LP = 0
 * Silver IV @ 0 LP = 400
 * Mythic   @ 0 LP = 2800
 *
 * Mythic is treated as "tier 7, division 1" with unbounded LP above 100.
 */
export function ordinalOf(p: LadderPos): number {
  const tIdx = TIERS.indexOf(p.tier);
  if (p.tier === 'Mythic') return 7 * 4 * LP_MAX + Math.max(0, p.lp);
  // Lower division number = higher rank, so invert: IV → 0, I → 3.
  const dIdx = 4 - p.division;
  return tIdx * 4 * LP_MAX + dIdx * LP_MAX + clamp(p.lp, 0, LP_MAX);
}

export function ladderFromOrdinal(ord: number): LadderPos {
  const mythicFloor = 7 * 4 * LP_MAX;
  if (ord >= mythicFloor) {
    return { tier: 'Mythic', division: 1, lp: Math.max(0, ord - mythicFloor) };
  }
  const safe = Math.max(0, ord);
  const tIdx = Math.min(7, Math.floor(safe / (4 * LP_MAX)));
  const within = safe - tIdx * 4 * LP_MAX;
  const dIdx = Math.floor(within / LP_MAX);
  const lp = within - dIdx * LP_MAX;
  const division = (4 - dIdx) as Division;
  return { tier: TIERS[tIdx], division, lp };
}

/**
 * Apply an LP delta. Promotes / demotes across divisions and tiers as needed.
 * Returns the new position plus a flag set indicating border crossings, useful
 * for telemetry / promotion-series UI.
 */
export function applyLpDelta(
  pos: LadderPos,
  delta: number,
): { next: LadderPos; promoted: boolean; demoted: boolean; tierChange: boolean } {
  const beforeOrd = ordinalOf(pos);
  // Hard floor: nobody drops below Bronze IV 0 LP.
  const next = ladderFromOrdinal(beforeOrd + Math.round(delta));
  const tierChange = next.tier !== pos.tier;
  const promoted = ordinalOf(next) > beforeOrd && (
    next.tier !== pos.tier || next.division !== pos.division
  );
  const demoted = ordinalOf(next) < beforeOrd && (
    next.tier !== pos.tier || next.division !== pos.division
  );
  return { next, promoted, demoted, tierChange };
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }

/** Initial visible position assigned after the 10 placement matches. */
export function placementPlacement(hiddenMmr: number): LadderPos {
  // Map hidden MMR to a starting tier deliberately conservative — placement
  // shouldn't dump a fresh player straight into Diamond on a hot streak.
  if (hiddenMmr >= 2200) return { tier: 'Diamond',     division: 4, lp: 0 };
  if (hiddenMmr >= 2000) return { tier: 'Platinum',    division: 4, lp: 0 };
  if (hiddenMmr >= 1800) return { tier: 'Gold',        division: 4, lp: 0 };
  if (hiddenMmr >= 1600) return { tier: 'Silver',      division: 2, lp: 0 };
  if (hiddenMmr >= 1500) return { tier: 'Silver',      division: 4, lp: 0 };
  return                   { tier: 'Bronze',      division: 4, lp: 0 };
}
