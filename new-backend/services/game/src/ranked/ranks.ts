/**
 * The visible ladder, ported from `src/ranked/ranks.ts`.
 *
 * Eight tiers x four divisions x 100 LP, with Mythic as a single divisionless
 * pool on top. Visible position deliberately lags the hidden Glicko rating —
 * see rating.ts for the LP award formula.
 *
 * ONE CHANGE FROM THE LEGACY FILE: the database stores the tier as an INDEX
 * (`game.ranked_profiles.tier smallint`, 0-7) rather than its name. Two reasons,
 * both in the migration's comments as well:
 *
 *   • `ladder_ordinal` is a generated column, so it has to be arithmetic over
 *     stored values. `'Gold' * 400` is not arithmetic.
 *   • Renaming a tier becomes a code change instead of an UPDATE over every
 *     ladder row in every season.
 *
 * `TIERS` is still the source of truth for the names and their order, and
 * `tierIndex` / `tierAt` are the only two places that convert. `ordinalOf` and
 * `ladderFromOrdinal` are unchanged and must stay byte-compatible with the
 * generated column's CASE expression in 0012_ranked.sql — a test asserts that.
 */

export const TIERS = [
  'Bronze',
  'Silver',
  'Gold',
  'Platinum',
  'Diamond',
  'Master',
  'Grandmaster',
  'Mythic',
] as const;

export type Tier = (typeof TIERS)[number];

/** Mythic has no divisions; every other tier runs IV (lowest) to I (highest). */
export const DIVISIONS = [4, 3, 2, 1] as const;
export type Division = 4 | 3 | 2 | 1;

export const LP_MIN = 0;
export const LP_MAX = 100;

/** Index of the divisionless top tier. */
export const MYTHIC_TIER = TIERS.length - 1;
/** Ordinal at which Mythic begins: the whole ladder below it, in LP. */
export const MYTHIC_FLOOR = MYTHIC_TIER * DIVISIONS.length * LP_MAX;

export interface LadderPos {
  tier: Tier;
  division: Division;
  lp: number;
}

/** Numeric form, as stored. */
export interface LadderRow {
  tier: number;
  division: Division;
  lp: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function tierIndex(tier: Tier): number {
  const i = TIERS.indexOf(tier);
  if (i < 0) throw new Error(`unknown tier: ${tier}`);
  return i;
}

/** Index to name, clamped — a row outside 0-7 cannot exist (CHECK in 0012). */
export function tierAt(index: number): Tier {
  return TIERS[clamp(Math.trunc(index), 0, MYTHIC_TIER)] as Tier;
}

export function toLadderPos(row: LadderRow): LadderPos {
  return { tier: tierAt(row.tier), division: row.division, lp: row.lp };
}

export function toLadderRow(pos: LadderPos): LadderRow {
  return { tier: tierIndex(pos.tier), division: pos.division, lp: pos.lp };
}

export function ladderEqual(a: LadderPos, b: LadderPos): boolean {
  return a.tier === b.tier && a.division === b.division && a.lp === b.lp;
}

/**
 * The absolute rank ordinal: one integer, higher is strictly better.
 *
 *   Bronze IV @  0 LP  =    0
 *   Silver IV @  0 LP  =  400
 *   Mythic    @  0 LP  = 2800
 *
 * Promotions and demotions are then plain addition, which is why `applyLpDelta`
 * is three lines and cannot get a tier boundary wrong.
 */
export function ordinalOf(p: LadderPos): number {
  if (p.tier === 'Mythic') return MYTHIC_FLOOR + Math.max(0, p.lp);
  // Lower division number is a HIGHER rank, so invert: IV -> 0, I -> 3.
  const dIdx = DIVISIONS.length - p.division;
  return tierIndex(p.tier) * DIVISIONS.length * LP_MAX + dIdx * LP_MAX + clamp(p.lp, LP_MIN, LP_MAX);
}

export function ladderFromOrdinal(ord: number): LadderPos {
  if (ord >= MYTHIC_FLOOR) {
    return { tier: 'Mythic', division: 1, lp: Math.max(0, Math.round(ord - MYTHIC_FLOOR)) };
  }
  const safe = Math.max(0, Math.round(ord));
  const tIdx = Math.min(MYTHIC_TIER, Math.floor(safe / (DIVISIONS.length * LP_MAX)));
  const within = safe - tIdx * DIVISIONS.length * LP_MAX;
  const dIdx = Math.floor(within / LP_MAX);
  return {
    tier: TIERS[tIdx] as Tier,
    division: (DIVISIONS.length - dIdx) as Division,
    lp: within - dIdx * LP_MAX,
  };
}

export interface LadderMove {
  next: LadderPos;
  promoted: boolean;
  demoted: boolean;
  tierChange: boolean;
}

/**
 * Apply an LP delta, crossing division and tier boundaries as needed.
 *
 * The hard floor is Bronze IV at 0 LP: `ladderFromOrdinal` clamps at 0, so a
 * losing streak at the bottom of the ladder stops rather than going negative.
 * There is no ceiling — Mythic LP is unbounded, which is what keeps the top of
 * the leaderboard ordered once everyone there has maxed out a division.
 */
export function applyLpDelta(pos: LadderPos, delta: number): LadderMove {
  const beforeOrd = ordinalOf(pos);
  const next = ladderFromOrdinal(beforeOrd + Math.round(delta));
  const afterOrd = ordinalOf(next);
  const crossedBoundary = next.tier !== pos.tier || next.division !== pos.division;
  return {
    next,
    promoted: afterOrd > beforeOrd && crossedBoundary,
    demoted: afterOrd < beforeOrd && crossedBoundary,
    tierChange: next.tier !== pos.tier,
  };
}

/**
 * The visible position assigned when placements finish.
 *
 * Deliberately conservative: placements should not dump a fresh account into
 * Diamond off a hot ten games. The player climbs out of it quickly if the
 * rating says they should, because the LP formula pays more for beating higher
 * hidden ratings than for beating equal ones.
 */
export function placementPlacement(hiddenRating: number): LadderPos {
  if (hiddenRating >= 2200) return { tier: 'Diamond', division: 4, lp: 0 };
  if (hiddenRating >= 2000) return { tier: 'Platinum', division: 4, lp: 0 };
  if (hiddenRating >= 1800) return { tier: 'Gold', division: 4, lp: 0 };
  if (hiddenRating >= 1600) return { tier: 'Silver', division: 2, lp: 0 };
  if (hiddenRating >= 1500) return { tier: 'Silver', division: 4, lp: 0 };
  return { tier: 'Bronze', division: 4, lp: 0 };
}

/** Display label, e.g. "Gold II" or "Mythic". */
export function ladderLabel(p: LadderPos): string {
  if (p.tier === 'Mythic') return 'Mythic';
  const roman = { 4: 'IV', 3: 'III', 2: 'II', 1: 'I' } as const;
  return `${p.tier} ${roman[p.division]}`;
}
