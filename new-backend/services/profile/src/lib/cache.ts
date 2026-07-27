import { getRedis, createLogger } from '@chains/shared';

const log = createLogger({ service: 'profile' }).child({ component: 'cache' });

/**
 * Leaderboard cache key. SHARED CONTRACT: the game service deletes this exact
 * key inside its authoritative-result write, so a finished match shows up in
 * the standings immediately instead of up to TTL seconds later.
 *
 * If you rename it here, rename it in services/game/src/lib/cache.ts too.
 */
export const LEADERBOARD_CACHE_KEY = 'cache:leaderboard:top50:v1';

export async function readCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    // A cache miss is never fatal — the caller falls through to Postgres.
    log.warn('cache read failed', { key, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function writeCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify(value), { expiration: { type: 'EX', value: ttlSeconds } });
  } catch (err) {
    log.warn('cache write failed', { key, err: err instanceof Error ? err.message : String(err) });
  }
}

export async function invalidateLeaderboard(): Promise<void> {
  try {
    await getRedis().del(LEADERBOARD_CACHE_KEY);
  } catch (err) {
    log.warn('leaderboard invalidation failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
