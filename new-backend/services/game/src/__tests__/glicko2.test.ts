/**
 * Glicko-2 against the published reference.
 *
 * A rating system with no tests is not shippable, and "it looks like the paper"
 * is not a test. The first case below is Glickman's own worked example from
 * http://www.glicko.net/glicko/glicko2.pdf § "Example calculation" — the same
 * numbers every correct implementation reproduces. If someone refactors this
 * file and the example still passes, the refactor was safe; if it fails, the
 * ladder is wrong and every rating derived from it is wrong with it.
 *
 * No database, no mocks. This module is pure arithmetic and is tested as such.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RATING,
  DEFAULT_RD,
  DEFAULT_VOLATILITY,
  fromGlicko1,
  toGlicko1,
  update,
  update1v1,
  type Glicko2,
} from '../ranked/glicko2.js';

const opp = (rating: number, rd: number): Glicko2 => fromGlicko1(rating, rd, 0.06);

describe("Glickman's worked example", () => {
  // Player: r = 1500, RD = 200, sigma = 0.06, tau = 0.5
  // vs 1400/RD 30 (win), 1550/RD 100 (loss), 1700/RD 300 (loss)
  const player = fromGlicko1(1500, 200, 0.06);
  const opponents = [opp(1400, 30), opp(1550, 100), opp(1700, 300)];
  const outcomes = [1, 0, 0] as const;

  it('reproduces mu = -0.2069, phi = 0.8722, sigma = 0.05999', () => {
    const next = update(player, opponents, [...outcomes]);
    expect(next.mu).toBeCloseTo(-0.2069, 4);
    expect(next.phi).toBeCloseTo(0.8722, 4);
    // The paper prints sigma' as 0.05999; we compute 0.0599959…, which is the
    // same number to the precision published. Asserting more digits than the
    // reference has would be asserting our own rounding, not the algorithm.
    expect(next.sigma).toBeCloseTo(0.05999, 4);
  });

  it('reproduces the display-scale rating 1464.06 and RD 151.52', () => {
    const next = toGlicko1(update(player, opponents, [...outcomes]));
    expect(next.rating).toBeCloseTo(1464.06, 1);
    expect(next.rd).toBeCloseTo(151.52, 1);
  });
});

describe('scale conversion', () => {
  it('round-trips', () => {
    const back = toGlicko1(fromGlicko1(1737.4, 123.4, 0.055));
    expect(back.rating).toBeCloseTo(1737.4, 9);
    expect(back.rd).toBeCloseTo(123.4, 9);
    expect(back.sigma).toBe(0.055);
  });

  it('puts the default rating at mu = 0', () => {
    expect(fromGlicko1(DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOLATILITY).mu).toBe(0);
  });
});

describe('1v1, the only shape the ladder uses', () => {
  const even = { rating: 1500, rd: 200, sigma: 0.06 };

  it('a win raises the rating and a loss lowers it', () => {
    const won = update1v1(even, even, 1);
    const lost = update1v1(even, even, 0);
    expect(won.rating).toBeGreaterThan(1500);
    expect(lost.rating).toBeLessThan(1500);
  });

  it('is symmetric between equal players: the winner gains what the loser loses', () => {
    // This is the property the legacy anti-smurf multiplier broke. If it ever
    // fails, somebody has re-scaled one side of the exchange and the rating pool
    // is no longer conserved.
    const won = update1v1(even, even, 1);
    const lost = update1v1(even, even, 0);
    expect(won.rating - 1500).toBeCloseTo(1500 - lost.rating, 9);
  });

  it('a draw between equals moves the rating nowhere but shrinks the deviation', () => {
    const drawn = update1v1(even, even, 0.5);
    expect(drawn.rating).toBeCloseTo(1500, 6);
    expect(drawn.rd).toBeLessThan(200);
  });

  it('a draw against a stronger opponent is a gain', () => {
    const drawn = update1v1(even, { rating: 1900, rd: 200, sigma: 0.06 }, 0.5);
    expect(drawn.rating).toBeGreaterThan(1500);
  });

  it('moves a high-deviation player further than a settled one', () => {
    // This is the mechanism that makes a smurf multiplier unnecessary: an
    // account at RD 350 converges in roughly ten games on its own.
    const fresh = update1v1({ rating: 1500, rd: 350, sigma: 0.06 }, even, 1);
    const settled = update1v1({ rating: 1500, rd: 50, sigma: 0.06 }, even, 1);
    expect(fresh.rating - 1500).toBeGreaterThan(settled.rating - 1500);
  });

  it('shrinks the deviation on every rated game', () => {
    const next = update1v1({ rating: 1500, rd: 350, sigma: 0.06 }, even, 1);
    expect(next.rd).toBeLessThan(350);
  });

  it('beating a much stronger opponent pays more than beating an equal one', () => {
    const upset = update1v1(even, { rating: 2100, rd: 200, sigma: 0.06 }, 1);
    const expected = update1v1(even, even, 1);
    expect(upset.rating).toBeGreaterThan(expected.rating);
  });
});

describe('a period with no games', () => {
  it('widens the deviation and leaves the rating alone', () => {
    const idle = update(fromGlicko1(1500, 100, 0.06), [], []);
    expect(idle.mu).toBe(0);
    expect(toGlicko1(idle).rd).toBeGreaterThan(100);
  });
});

describe('refuses malformed input rather than storing a NaN', () => {
  it('rejects a non-finite rating', () => {
    expect(() => update({ mu: Number.NaN, phi: 1, sigma: 0.06 }, [], [])).toThrow(/not finite/);
  });

  it('rejects a non-positive deviation', () => {
    expect(() => update({ mu: 0, phi: 0, sigma: 0.06 }, [], [])).toThrow(/must be positive/);
  });

  it('rejects mismatched opponents and outcomes', () => {
    expect(() => update(fromGlicko1(1500, 200, 0.06), [opp(1400, 30)], [])).toThrow(
      /same length/,
    );
  });

  it('never returns a NaN rating for any plausible pairing', () => {
    // The volatility solver is iterative; a bad bracket used to be able to spin
    // forever, which inside the result transaction would hold row locks. Both
    // loops are bounded now, so a pathological input throws instead.
    for (const rating of [1, 500, 1500, 2500, 4000]) {
      for (const rd of [1, 30, 200, 350]) {
        const next = update1v1({ rating, rd, sigma: 0.06 }, { rating: 1500, rd: 350, sigma: 0.06 }, 1);
        expect(Number.isFinite(next.rating)).toBe(true);
        expect(Number.isFinite(next.rd)).toBe(true);
        expect(Number.isFinite(next.sigma)).toBe(true);
      }
    }
  });
});
