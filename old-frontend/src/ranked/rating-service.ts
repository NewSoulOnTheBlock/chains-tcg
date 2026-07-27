// src/ranked/rating-service.ts
// Atomic match ingestion: hidden Glicko-2 + visible LP + placements + anti-smurf.
import * as RDB from './db';
import { update1v1 } from './glicko2';
import { applyLpDelta, ladderEqual, placementPlacement } from './ranks';
import type { RankedMatchOutcome, RankedProfile } from './types';
import { ensureActiveSeason } from './season-service';
import { assessSmurf } from './anti-smurf';
import * as Telemetry from './telemetry-service';

/**
 * The expected score given a hidden MMR delta, used for LP shaping. Larger
 * negative delta = upset → bigger LP swing.
 */
function expectedScore(mmrA: number, mmrB: number) {
  return 1 / (1 + Math.pow(10, (mmrB - mmrA) / 400));
}

/**
 * Convert the hidden MMR delta into a visible LP delta.
 * - Base ±20 LP for an even match.
 * - Adjusted by win expectancy (overperforming gains more, underperforming loses less).
 * - During placements, doubled.
 * - Smurf multiplier inflates only the WIN side.
 */
function lpDeltaFor(
  outcome: 'win' | 'loss' | 'draw',
  myMmr: number, oppMmr: number,
  inPlacements: boolean, smurfMult: number,
): number {
  if (outcome === 'draw') return 0;
  const expected = expectedScore(myMmr, oppMmr);
  if (outcome === 'win') {
    const base = 20 + (1 - expected) * 20;       // 20–40 range
    const placement = inPlacements ? 2 : 1;
    return Math.round(base * placement * smurfMult);
  } else {
    const base = 20 + expected * 20;             // 20–40 range, capped
    const placement = inPlacements ? 1.5 : 1;
    return -Math.round(base * placement);
  }
}

export async function getOrCreateProfile(playerId: string): Promise<RankedProfile> {
  let p = await RDB.getRankedProfile(playerId);
  if (p) return p;
  const season = await ensureActiveSeason();
  p = {
    playerId,
    hiddenMmr: 1500, ratingDeviation: 350, volatility: 0.06,
    visibleRank: 'Bronze', division: 4, rankedPoints: 0,
    wins: 0, losses: 0, placementMatchesRemaining: 10,
    seasonId: season.id,
    smurfFlagged: false, mmrMultiplier: 1.0,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  return await RDB.upsertRankedProfile(p);
}

/**
 * Idempotent ingestion of one ranked match.
 * Re-submitting the same `matchId` is a no-op (returns 'duplicate').
 */
export async function ingestMatchResult(m: RankedMatchOutcome): Promise<'recorded' | 'duplicate'> {
  const season = await ensureActiveSeason();
  const a = await getOrCreateProfile(m.player0);
  const b = await getOrCreateProfile(m.player1);

  // Glicko-2 update (1v1, single rating period containing one match).
  const aOut: 0 | 0.5 | 1 = m.draw ? 0.5 : (m.winner === a.playerId ? 1 : 0);
  const bOut: 0 | 0.5 | 1 = m.draw ? 0.5 : (m.winner === b.playerId ? 1 : 0);

  const aSmurf = await assessSmurf(a);
  const bSmurf = await assessSmurf(b);

  const aRatingNext = update1v1(
    { rating: a.hiddenMmr, rd: a.ratingDeviation, sigma: a.volatility },
    { rating: b.hiddenMmr, rd: b.ratingDeviation, sigma: b.volatility },
    aOut,
  );
  const bRatingNext = update1v1(
    { rating: b.hiddenMmr, rd: b.ratingDeviation, sigma: b.volatility },
    { rating: a.hiddenMmr, rd: a.ratingDeviation, sigma: a.volatility },
    bOut,
  );

  // Apply smurf multiplier to MMR gains only on the side that won.
  if (m.winner === a.playerId) {
    const gain = (aRatingNext.rating - a.hiddenMmr) * aSmurf.mmrMultiplier;
    aRatingNext.rating = a.hiddenMmr + gain;
  } else if (m.winner === b.playerId) {
    const gain = (bRatingNext.rating - b.hiddenMmr) * bSmurf.mmrMultiplier;
    bRatingNext.rating = b.hiddenMmr + gain;
  }

  // Visible LP / rank.
  const aOutcome: 'win' | 'loss' | 'draw' = m.draw ? 'draw' : (m.winner === a.playerId ? 'win' : 'loss');
  const bOutcome: 'win' | 'loss' | 'draw' = m.draw ? 'draw' : (m.winner === b.playerId ? 'win' : 'loss');
  const aLp = lpDeltaFor(aOutcome, a.hiddenMmr, b.hiddenMmr, a.placementMatchesRemaining > 0, aSmurf.mmrMultiplier);
  const bLp = lpDeltaFor(bOutcome, b.hiddenMmr, a.hiddenMmr, b.placementMatchesRemaining > 0, bSmurf.mmrMultiplier);

  const aPosBefore = { tier: a.visibleRank, division: a.division, lp: a.rankedPoints } as const;
  const bPosBefore = { tier: b.visibleRank, division: b.division, lp: b.rankedPoints } as const;

  let aPosAfter = applyLpDelta(aPosBefore, aLp).next;
  let bPosAfter = applyLpDelta(bPosBefore, bLp).next;

  // Visible rank stays hidden during placements; on the placement-finishing
  // match, snap to placementPlacement(hiddenMmr).
  const aPlacementsLeftNext = Math.max(0, a.placementMatchesRemaining - 1);
  const bPlacementsLeftNext = Math.max(0, b.placementMatchesRemaining - 1);
  if (a.placementMatchesRemaining > 0 && aPlacementsLeftNext === 0) {
    aPosAfter = placementPlacement(aRatingNext.rating);
  }
  if (b.placementMatchesRemaining > 0 && bPlacementsLeftNext === 0) {
    bPosAfter = placementPlacement(bRatingNext.rating);
  }

  // Build updated profiles.
  const aNext: RankedProfile = {
    ...a,
    hiddenMmr: aRatingNext.rating,
    ratingDeviation: aRatingNext.rd,
    volatility: aRatingNext.sigma,
    visibleRank: aPosAfter.tier, division: aPosAfter.division, rankedPoints: aPosAfter.lp,
    wins: a.wins + (aOutcome === 'win' ? 1 : 0),
    losses: a.losses + (aOutcome === 'loss' ? 1 : 0),
    placementMatchesRemaining: aPlacementsLeftNext,
    smurfFlagged: aSmurf.flagged, mmrMultiplier: aSmurf.mmrMultiplier,
    seasonId: season.id, updatedAt: Date.now(),
  };
  const bNext: RankedProfile = {
    ...b,
    hiddenMmr: bRatingNext.rating,
    ratingDeviation: bRatingNext.rd,
    volatility: bRatingNext.sigma,
    visibleRank: bPosAfter.tier, division: bPosAfter.division, rankedPoints: bPosAfter.lp,
    wins: b.wins + (bOutcome === 'win' ? 1 : 0),
    losses: b.losses + (bOutcome === 'loss' ? 1 : 0),
    placementMatchesRemaining: bPlacementsLeftNext,
    smurfFlagged: bSmurf.flagged, mmrMultiplier: bSmurf.mmrMultiplier,
    seasonId: season.id, updatedAt: Date.now(),
  };

  // Persist atomically — record the match row first (idempotent), then
  // profiles. If the match row was a duplicate, skip rating updates.
  const status = await RDB.recordRankedMatch(m, {
    p0Before: a.hiddenMmr, p1Before: b.hiddenMmr,
    p0After: aNext.hiddenMmr, p1After: bNext.hiddenMmr,
    p0LpChange: aLp, p1LpChange: bLp,
  });
  if (status === 'duplicate') return 'duplicate';

  await RDB.upsertRankedProfile(aNext);
  await RDB.upsertRankedProfile(bNext);

  // Telemetry.
  Telemetry.emit('match_ended', {
    matchId: m.matchId, winner: m.winner, draw: m.draw,
    p0LpChange: aLp, p1LpChange: bLp,
  }, { matchId: m.matchId });
  if (!ladderEqual(aPosBefore, aPosAfter)) {
    Telemetry.emit(aPosAfter.tier !== a.visibleRank ? 'rank_up' : (aLp >= 0 ? 'promotion_series' : 'demotion'),
      { from: aPosBefore, to: aPosAfter }, { playerId: a.playerId, matchId: m.matchId });
  }
  if (!ladderEqual(bPosBefore, bPosAfter)) {
    Telemetry.emit(bPosAfter.tier !== b.visibleRank ? 'rank_up' : (bLp >= 0 ? 'promotion_series' : 'demotion'),
      { from: bPosBefore, to: bPosAfter }, { playerId: b.playerId, matchId: m.matchId });
  }
  if (aSmurf.flagged && !a.smurfFlagged) {
    Telemetry.emit('smurf_flagged', { reasons: aSmurf.reasons }, { playerId: a.playerId });
  }
  if (bSmurf.flagged && !b.smurfFlagged) {
    Telemetry.emit('smurf_flagged', { reasons: bSmurf.reasons }, { playerId: b.playerId });
  }
  return 'recorded';
}
