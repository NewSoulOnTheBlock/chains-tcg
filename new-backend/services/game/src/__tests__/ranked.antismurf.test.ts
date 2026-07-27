/**
 * Anti-smurf: that it still detects, and that it still does nothing.
 *
 * The second half is the one that matters. `assessSmurf` returns an
 * `advisoryMmrMultiplier` that the legacy service applied to the winner's
 * Glicko delta; nothing in this port reads it, and the tests below pin both the
 * naming and the fact that the persisted `mmr_multiplier` stays 1.0. If someone
 * wires it back in, they have to come here and delete an assertion that says why
 * not to.
 */
import { describe, expect, it } from 'vitest';
import { assessSmurf, type SmurfInput } from '../ranked/anti-smurf.js';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);

const base = (over: Partial<SmurfInput> = {}): SmurfInput => ({
  wins: 5,
  losses: 5,
  draws: 0,
  rating: 1500,
  baselineRating: 1500,
  placementsRemaining: 0,
  accountCreatedAt: daysAgo(200),
  recentOutcomes: [],
  now: NOW,
  ...over,
});

describe('it flags what it is meant to flag', () => {
  it('an 80%+ winrate over enough games', () => {
    const r = assessSmurf(base({ wins: 40, losses: 5 }));
    expect(r.flagged).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/winrate 89% over 45 games/);
  });

  it('a new account winning three quarters of its games', () => {
    const r = assessSmurf(base({ wins: 9, losses: 3, accountCreatedAt: daysAgo(2) }));
    expect(r.flagged).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/account 2\.0d old/);
  });

  it('an eight-win streak in the last ten games', () => {
    const r = assessSmurf(
      base({ recentOutcomes: ['win', 'win', 'win', 'win', 'win', 'win', 'win', 'win', 'loss', 'loss'] }),
    );
    expect(r.reasons.join(' ')).toMatch(/streak 8\/10/);
  });

  it('a rapid climb, measured in rating rather than the old broken LP/day', () => {
    // The legacy metric was `rankedPoints / seasonAgeDays`, where rankedPoints
    // is LP WITHIN THE CURRENT DIVISION — bounded at 100 and reset on every
    // promotion. A day-old account at 90 LP scored "180 LP/day"; a Diamond
    // player who had just promoted scored 0.
    const r = assessSmurf(base({ rating: 2000, accountCreatedAt: daysAgo(2) }));
    expect(r.reasons.join(' ')).toMatch(/climb 250 rating\/day/);
  });
});

describe('it does not flag what it should not', () => {
  it('an ordinary account with an ordinary record', () => {
    expect(assessSmurf(base()).flagged).toBe(false);
  });

  it('a high winrate over too few games to mean anything', () => {
    expect(assessSmurf(base({ wins: 9, losses: 1 })).flagged).toBe(false);
  });

  it('an old account climbing at a normal pace', () => {
    expect(assessSmurf(base({ rating: 2000, accountCreatedAt: daysAgo(200) })).flagged).toBe(false);
  });

  it('a player still in placements, however fast they are climbing', () => {
    const r = assessSmurf(
      base({ rating: 2400, accountCreatedAt: daysAgo(1), placementsRemaining: 3, wins: 4, losses: 0 }),
    );
    expect(r.reasons.join(' ')).not.toMatch(/climb/);
  });

  it('counts a draw as a game played but not as a game won', () => {
    // 24 wins in 30 games is 80%; the same 24 wins with 6 draws instead of 6
    // losses is still 80% and still flags, which is the correct reading.
    expect(assessSmurf(base({ wins: 24, losses: 6, draws: 0 })).flagged).toBe(true);
    expect(assessSmurf(base({ wins: 24, losses: 0, draws: 6 })).flagged).toBe(true);
    // 24 wins in 40 games is 60% and must not.
    expect(assessSmurf(base({ wins: 24, losses: 8, draws: 8 })).flagged).toBe(false);
  });
});

describe('IT IS INERT', () => {
  it('names its multiplier "advisory", because nothing applies it', () => {
    const r = assessSmurf(base({ wins: 40, losses: 5 }));
    expect(r).toHaveProperty('advisoryMmrMultiplier');
    expect(r).not.toHaveProperty('mmrMultiplier');
  });

  it('would have scaled a flagged winner by up to 2x — which is why it is off', () => {
    // Recorded so the size of the lever is visible. Multiplying only the
    // winner's side breaks Glicko-2 twice: the update stops being the calibrated
    // estimate that rating_deviation and volatility describe, and the exchange
    // stops being zero-sum, so the rating pool inflates by the excess on every
    // flagged win — fastest at the top of the ladder, where the prize is.
    const worst = assessSmurf(
      base({
        wins: 40,
        losses: 5,
        accountCreatedAt: daysAgo(1),
        rating: 2200,
        recentOutcomes: Array(10).fill('win') as Array<'win'>,
      }),
    );
    expect(worst.advisoryMmrMultiplier).toBe(1.75);
    expect(worst.advisoryMmrMultiplier).toBeLessThanOrEqual(2.0);
    expect(worst.advisoryBracketBoost).toBeLessThanOrEqual(400);
  });

  it('takes no database handle and no clock of its own', () => {
    // The legacy version issued a `recentMatchesFor` query per player, per
    // match, from inside the rating path. This one is a function of its
    // arguments, so it cannot add a round trip to the result transaction.
    expect(assessSmurf.length).toBe(1);
    const twice = [assessSmurf(base({ wins: 40, losses: 5 })), assessSmurf(base({ wins: 40, losses: 5 }))];
    expect(twice[0]).toEqual(twice[1]);
  });
});
