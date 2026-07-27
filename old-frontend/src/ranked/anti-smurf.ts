// src/ranked/anti-smurf.ts
// Heuristics to identify accounts climbing too fast. Output is consumed by the
// rating service to inflate MMR gains and by the matchmaker to bias the bracket
// upward — both are corrective, not punitive.
import * as RDB from './db';
import type { RankedProfile } from './types';

const MIN_GAMES = 30;
const HIGH_WR  = 0.80;
const NEW_ACCT_AGE_MS = 5 * 86400 * 1000;
const RAPID_CLIMB_LP_PER_DAY = 80;

export type SmurfAssessment = {
  flagged: boolean;
  mmrMultiplier: number;   // applied to MMR gains; 1.0 default, ≤2.0 clamp
  bracketBoost: number;    // MMR bonus added when matchmaking against this player
  reasons: string[];
};

export async function assessSmurf(p: RankedProfile): Promise<SmurfAssessment> {
  const reasons: string[] = [];
  let mult = 1.0;
  let boost = 0;

  const totalGames = p.wins + p.losses;
  const wr = totalGames > 0 ? p.wins / totalGames : 0;

  if (totalGames >= MIN_GAMES && wr >= HIGH_WR) {
    reasons.push(`high winrate ${(wr*100).toFixed(0)}% over ${totalGames} games`);
    mult = Math.max(mult, 1.5);
    boost = Math.max(boost, 200);
  }

  if (Date.now() - p.createdAt < NEW_ACCT_AGE_MS && totalGames >= 10 && wr >= 0.75) {
    reasons.push('new account + ≥75% WR');
    mult = Math.max(mult, 1.75);
    boost = Math.max(boost, 300);
  }

  // Climb velocity: reward gain/day vs. season start.
  const seasonAgeDays = Math.max(0.5, (Date.now() - p.createdAt) / 86400_000);
  const lpPerDay = p.rankedPoints / seasonAgeDays;   // crude, but works
  if (lpPerDay >= RAPID_CLIMB_LP_PER_DAY && p.placementMatchesRemaining === 0) {
    reasons.push(`rapid climb ${lpPerDay.toFixed(0)} LP/day`);
    mult = Math.max(mult, 1.3);
    boost = Math.max(boost, 100);
  }

  // Win-streak signal — last 10 results.
  const recent = await RDB.recentMatchesFor(p.playerId, 10);
  const recentWins = recent.filter((m: any) =>
    (m.winner === p.playerId) || (m.winner ?? null) === p.playerId).length;
  if (recent.length >= 8 && recentWins >= 8) {
    reasons.push(`streak ${recentWins}/${recent.length}`);
    mult = Math.max(mult, 1.4);
  }

  // Clamp.
  mult = Math.min(mult, 2.0);
  boost = Math.min(boost, 400);
  return {
    flagged: reasons.length > 0 && (mult > 1.0 || boost > 0),
    mmrMultiplier: mult,
    bracketBoost: boost,
    reasons,
  };
}
