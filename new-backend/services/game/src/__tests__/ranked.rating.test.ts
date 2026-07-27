/**
 * The ladder arithmetic: ordinals, LP shaping, placements, the soft reset.
 *
 * All pure. The point of splitting `ranked/rating.ts` out of the legacy
 * `rating-service.ts` was that this could exist at all — the legacy version did
 * Glicko, LP, placements, three database writes and telemetry in one function,
 * so none of the rules below could be checked without a Postgres and a clock.
 */
import { describe, expect, it } from 'vitest';
import {
  applyLpDelta,
  ladderFromOrdinal,
  ladderLabel,
  ordinalOf,
  placementPlacement,
  tierAt,
  tierIndex,
  TIERS,
  type Division,
  type LadderPos,
} from '../ranked/ranks.js';
import {
  expectedScore,
  freshStanding,
  ladderOrdinalOf,
  lpDeltaFor,
  rateMatch,
  softReset,
  type Standing,
} from '../ranked/rating.js';

const at = (tier: string, division: Division, lp: number): LadderPos =>
  ({ tier, division, lp }) as LadderPos;

describe('the ordinal is a total order over the visible ladder', () => {
  it('anchors Bronze IV, Silver IV and Mythic where the migration says', () => {
    expect(ordinalOf(at('Bronze', 4, 0))).toBe(0);
    expect(ordinalOf(at('Silver', 4, 0))).toBe(400);
    expect(ordinalOf(at('Mythic', 1, 0))).toBe(2800);
  });

  it('increases with every step up the ladder', () => {
    const ladder: LadderPos[] = [];
    for (const tier of TIERS) {
      if (tier === 'Mythic') {
        ladder.push(at('Mythic', 1, 0), at('Mythic', 1, 500));
        continue;
      }
      for (const division of [4, 3, 2, 1] as Division[]) {
        ladder.push(at(tier, division, 0), at(tier, division, 50));
      }
    }
    const ordinals = ladder.map(ordinalOf);
    for (let i = 1; i < ordinals.length; i += 1) {
      expect(ordinals[i]!).toBeGreaterThan(ordinals[i - 1]!);
    }
  });

  it('round-trips through ladderFromOrdinal', () => {
    for (const tier of TIERS) {
      if (tier === 'Mythic') continue;
      for (const division of [4, 3, 2, 1] as Division[]) {
        for (const lp of [0, 1, 55, 99]) {
          const pos = at(tier, division, lp);
          expect(ladderFromOrdinal(ordinalOf(pos))).toEqual(pos);
        }
      }
    }
  });

  it('gives Mythic an unbounded LP pool, so the top of the board stays ordered', () => {
    expect(ordinalOf(at('Mythic', 1, 1_000))).toBe(3800);
    expect(ladderFromOrdinal(3800)).toEqual(at('Mythic', 1, 1_000));
  });

  it('matches the tier index the database stores', () => {
    expect(tierIndex('Bronze')).toBe(0);
    expect(tierIndex('Mythic')).toBe(7);
    expect(tierAt(3)).toBe('Platinum');
    // ladderOrdinalOf is the TypeScript twin of the generated column in
    // 0012_ranked.sql; the database-backed suite asserts they agree.
    expect(ladderOrdinalOf({ tier: 2, division: 2, lp: 40 })).toBe(ordinalOf(at('Gold', 2, 40)));
  });
});

describe('LP deltas cross boundaries without special-casing them', () => {
  it('promotes across a division', () => {
    const move = applyLpDelta(at('Gold', 3, 90), 25);
    expect(move.next).toEqual(at('Gold', 2, 15));
    expect(move.promoted).toBe(true);
    expect(move.tierChange).toBe(false);
  });

  it('promotes across a tier', () => {
    const move = applyLpDelta(at('Gold', 1, 95), 20);
    expect(move.next).toEqual(at('Platinum', 4, 15));
    expect(move.tierChange).toBe(true);
    expect(move.promoted).toBe(true);
  });

  it('demotes across a tier', () => {
    const move = applyLpDelta(at('Platinum', 4, 5), -30);
    expect(move.next).toEqual(at('Gold', 1, 75));
    expect(move.demoted).toBe(true);
  });

  it('floors at Bronze IV 0 LP instead of going negative', () => {
    const move = applyLpDelta(at('Bronze', 4, 10), -500);
    expect(move.next).toEqual(at('Bronze', 4, 0));
    expect(ordinalOf(move.next)).toBe(0);
  });

  it('labels a position the way the client renders it', () => {
    expect(ladderLabel(at('Gold', 2, 40))).toBe('Gold II');
    expect(ladderLabel(at('Mythic', 1, 400))).toBe('Mythic');
  });
});

describe('LP award shaping', () => {
  it('pays about 30 for an even win and costs about 30 for an even loss', () => {
    expect(lpDeltaFor('win', 1500, 1500, false)).toBe(30);
    expect(lpDeltaFor('loss', 1500, 1500, false)).toBe(-30);
  });

  it('pays more for an upset and costs less for losing to a favourite', () => {
    expect(lpDeltaFor('win', 1500, 2100, false)).toBeGreaterThan(
      lpDeltaFor('win', 1500, 1500, false),
    );
    expect(lpDeltaFor('loss', 1500, 2100, false)).toBeGreaterThan(
      lpDeltaFor('loss', 1500, 1500, false),
    );
  });

  it('stays inside the documented 20-40 band', () => {
    for (const gap of [-1200, -400, 0, 400, 1200]) {
      expect(Math.abs(lpDeltaFor('win', 1500, 1500 + gap, false))).toBeGreaterThanOrEqual(20);
      expect(Math.abs(lpDeltaFor('win', 1500, 1500 + gap, false))).toBeLessThanOrEqual(40);
      expect(Math.abs(lpDeltaFor('loss', 1500, 1500 + gap, false))).toBeGreaterThanOrEqual(20);
      expect(Math.abs(lpDeltaFor('loss', 1500, 1500 + gap, false))).toBeLessThanOrEqual(40);
    }
  });

  it('doubles a placement win and pays nothing at all for a draw', () => {
    expect(lpDeltaFor('win', 1500, 1500, true)).toBe(60);
    expect(lpDeltaFor('draw', 1500, 1500, false)).toBe(0);
    expect(lpDeltaFor('draw', 1200, 2000, true)).toBe(0);
  });

  it('has an expectancy of exactly 0.5 between equals', () => {
    expect(expectedScore(1500, 1500)).toBe(0.5);
    expect(expectedScore(1900, 1500)).toBeGreaterThan(0.9);
  });

  it('ignores the smurf multiplier because every caller passes 1', () => {
    // Pinned deliberately: if someone re-enables the lever, this is where they
    // have to come and change a number on purpose. See anti-smurf.ts.
    expect(lpDeltaFor('win', 1500, 1500, false, 1)).toBe(30);
  });
});

describe('rating one match', () => {
  const settled = (rating: number): Standing => ({
    ...freshStanding(0),
    rating,
    ratingDeviation: 80,
    tier: 2,
    division: 2,
    lp: 50,
    placementsRemaining: 0,
  });

  it('moves the winner up and the loser down, by the same amount between equals', () => {
    const r = rateMatch(settled(1500), settled(1500), 0);
    expect(r.seat0.after.rating).toBeGreaterThan(1500);
    expect(r.seat1.after.rating).toBeLessThan(1500);
    expect(r.seat0.after.rating - 1500).toBeCloseTo(1500 - r.seat1.after.rating, 6);
  });

  it('rates both seats against the OPPONENT S PRE-MATCH standing', () => {
    // If seat 1 were rated against seat 0's already-updated rating, swapping
    // which seat won would not produce mirrored results.
    const a = rateMatch(settled(1600), settled(1400), 0);
    const b = rateMatch(settled(1400), settled(1600), 1);
    expect(a.seat0.after.rating).toBeCloseTo(b.seat1.after.rating, 9);
    expect(a.seat1.after.rating).toBeCloseTo(b.seat0.after.rating, 9);
  });

  it('records a win and a loss, never both, never neither', () => {
    const r = rateMatch(settled(1500), settled(1500), 1);
    expect(r.seat0.outcome).toBe('loss');
    expect(r.seat1.outcome).toBe('win');
    expect(r.seat0.after.losses).toBe(1);
    expect(r.seat0.after.wins).toBe(0);
    expect(r.seat1.after.wins).toBe(1);
  });

  describe('a draw', () => {
    const drawn = rateMatch(settled(1400), settled(1700), null);

    it('is rated: the ratings converge', () => {
      expect(drawn.seat0.after.rating).toBeGreaterThan(1400);
      expect(drawn.seat1.after.rating).toBeLessThan(1700);
    });

    it('shrinks both deviations, because it is real evidence', () => {
      expect(drawn.seat0.after.ratingDeviation).toBeLessThan(80);
      expect(drawn.seat1.after.ratingDeviation).toBeLessThan(80);
    });

    it('moves no LP and touches neither wins nor losses', () => {
      expect(drawn.seat0.lpDelta).toBe(0);
      expect(drawn.seat1.lpDelta).toBe(0);
      expect(drawn.seat0.after.wins).toBe(0);
      expect(drawn.seat0.after.losses).toBe(0);
      expect(drawn.seat0.after.draws).toBe(1);
      expect(drawn.seat1.after.draws).toBe(1);
    });

    it('leaves the visible rank exactly where it was', () => {
      expect(drawn.seat0.ordinalAfter).toBe(drawn.seat0.ordinalBefore);
    });
  });

  describe('placements', () => {
    const placing = { ...freshStanding(10) };

    it('counts a game down, including a draw', () => {
      expect(rateMatch(placing, placing, 0).seat0.after.placementsRemaining).toBe(9);
      expect(rateMatch(placing, placing, null).seat0.after.placementsRemaining).toBe(9);
    });

    it('snaps the visible rank from the hidden rating on the last one', () => {
      const last: Standing = { ...freshStanding(1), rating: 2050, ratingDeviation: 90 };
      const r = rateMatch(last, settled(2050), 0);
      expect(r.seat0.placementsCompleted).toBe(true);
      // 2050+ after a win against a 2050 opponent lands in Platinum or above.
      expect(tierAt(r.seat0.after.tier)).toBe(placementPlacement(r.seat0.after.rating).tier);
      expect(r.seat0.after.lp).toBe(0);
    });

    it('reports the snap as neither a promotion nor a demotion', () => {
      // Otherwise the client fires a "ranked up!" animation for a rank the
      // player has never held.
      const last: Standing = { ...freshStanding(1), rating: 1000 };
      const r = rateMatch(last, settled(2400), 1);
      expect(r.seat0.placementsCompleted).toBe(true);
      expect(r.seat0.promoted).toBe(false);
      expect(r.seat0.demoted).toBe(false);
    });

    it('never goes below zero remaining', () => {
      const done = { ...freshStanding(0) };
      expect(rateMatch(done, done, 0).seat0.after.placementsRemaining).toBe(0);
      expect(rateMatch(done, done, 0).seat0.placementsCompleted).toBe(false);
    });

    it('places a conservative rank, not the one the rating alone would suggest', () => {
      expect(placementPlacement(3000).tier).toBe('Diamond');
      expect(placementPlacement(1499).tier).toBe('Bronze');
    });
  });
});

describe('the season soft reset', () => {
  const veteran: Standing = {
    ...freshStanding(0),
    rating: 2100,
    ratingDeviation: 60,
    volatility: 0.055,
    tier: 5,
    division: 1,
    lp: 80,
    wins: 90,
    losses: 30,
    draws: 2,
  };

  it('halves the distance from 1500 at factor 0.5', () => {
    expect(softReset(veteran, 0.5, 10).rating).toBe(1800);
  });

  it('is the identity at factor 1 and a hard reset at factor 0', () => {
    expect(softReset(veteran, 1, 10).rating).toBe(2100);
    expect(softReset(veteran, 0, 10).rating).toBe(1500);
  });

  it('widens the deviation by 50, capped at the starting 350', () => {
    expect(softReset(veteran, 0.5, 10).ratingDeviation).toBe(110);
    expect(softReset({ ...veteran, ratingDeviation: 340 }, 0.5, 10).ratingDeviation).toBe(350);
  });

  it('re-arms placements and clears the visible rank and record', () => {
    const next = softReset(veteran, 0.5, 10);
    expect(next.placementsRemaining).toBe(10);
    expect(next).toMatchObject({ tier: 0, division: 4, lp: 0, wins: 0, losses: 0, draws: 0 });
  });

  it('lifts a demoted player back toward the middle, not down to it', () => {
    expect(softReset({ ...veteran, rating: 900 }, 0.5, 10).rating).toBe(1200);
  });
});
