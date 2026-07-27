// src/ranked/leaderboard-service.ts
import * as RDB from './db';
import { ensureActiveSeason } from './season-service';

export type LeaderboardEntry = {
  rank: number;
  playerId: string;
  visibleRank: string;
  division: number;
  rankedPoints: number;
  hiddenMmr: number;       // included for top-N (Master+) ordering
  wins: number;
  losses: number;
};

export async function getLeaderboard(
  scope: 'global' | 'season',
  limit = 100,
): Promise<LeaderboardEntry[]> {
  const season = await ensureActiveSeason();
  // Both scopes are season-scoped in this MVP; "global" is reserved for a
  // future cross-season composite. Same query, identical output for now.
  void scope;
  const profiles = await RDB.topByMmr(season.id, limit);
  return profiles.map((p, i) => ({
    rank: i + 1,
    playerId: p.playerId,
    visibleRank: p.visibleRank,
    division: p.division,
    rankedPoints: p.rankedPoints,
    hiddenMmr: p.hiddenMmr,
    wins: p.wins,
    losses: p.losses,
  }));
}

export async function getRegionalLeaderboard(_region: string, limit = 100) {
  // No region column on profiles yet — for now return global. The matchmaker's
  // queue table tracks regions, so this can be backfilled once region is
  // promoted onto the profile.
  return getLeaderboard('global', limit);
}
