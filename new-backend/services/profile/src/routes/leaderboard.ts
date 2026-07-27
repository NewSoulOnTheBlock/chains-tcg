import type { IRouter } from 'express';
import { asyncHandler, route } from '@chains/shared';
import { config } from '../config.js';
import { getLeaderboard, type LeaderboardEntry } from '../repo/profiles.repo.js';
import { LEADERBOARD_CACHE_KEY, readCache, writeCache } from '../lib/cache.js';

interface CachedLeaderboard {
  generatedAt: string;
  entries: LeaderboardEntry[];
}

export function registerLeaderboardRoutes(router: IRouter): void {
  // ── GET /api/leaderboard ────────────────────────────────────────────────
  // Public listing → never contains wallet addresses (audit H-2). Cached in
  // redis for LEADERBOARD_TTL_SECONDS, and EXPLICITLY invalidated by the game
  // service the moment a match result lands (and by PATCH /api/profiles/me
  // when a display name or avatar changes).
  route(router, {
    method: 'get',
    path: '/api/leaderboard',
    public: true,
    summary: 'Top 50 by wins, redis-cached, no wallet addresses',
    handler: asyncHandler(async (_req, res) => {
      const cached = await readCache<CachedLeaderboard>(LEADERBOARD_CACHE_KEY);
      if (cached) {
        res.setHeader('x-cache', 'hit');
        res.json({ leaderboard: cached.entries, generatedAt: cached.generatedAt, cached: true });
        return;
      }
      const entries = await getLeaderboard(50);
      const payload: CachedLeaderboard = { generatedAt: new Date().toISOString(), entries };
      await writeCache(LEADERBOARD_CACHE_KEY, payload, config.LEADERBOARD_TTL_SECONDS);
      res.setHeader('x-cache', 'miss');
      res.json({ leaderboard: entries, generatedAt: payload.generatedAt, cached: false });
    }),
  });
}
