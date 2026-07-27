import { getRedis, createLogger } from '@chains/shared';

const log = createLogger({ service: 'game' }).child({ component: 'cache' });

/**
 * SHARED CONTRACT with services/profile/src/lib/cache.ts — the profile service
 * writes this key, we delete it. Keep the two literals identical.
 */
export const LEADERBOARD_CACHE_KEY = 'cache:leaderboard:top50:v1';

/** Called after a match result lands so the standings are not up to 30s stale. */
export async function invalidateLeaderboard(): Promise<void> {
  try {
    await getRedis().del(LEADERBOARD_CACHE_KEY);
  } catch (err) {
    // The cache has a TTL, so a failed invalidation is a staleness bug, not a
    // correctness one — the result row is already committed.
    log.warn('leaderboard invalidation failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
