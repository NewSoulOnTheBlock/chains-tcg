// Redis cache client with graceful degradation: if redis is down the API
// keeps working, reads just skip the cache. Connection is lazy — first use
// triggers the connect attempt.
import { createClient } from 'redis';

const client = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    // Retry with backoff, but never crash the process over cache loss.
    reconnectStrategy: retries => Math.min(retries * 500, 5000),
  },
});

client.on('error', err => {
  // Logged once per burst by node-redis; keep it quiet but visible.
  console.warn('[redis] error:', (err as Error).message);
});

let connecting: Promise<void> | null = null;

async function ensureConnected(): Promise<boolean> {
  if (client.isReady) return true;
  if (!connecting) {
    connecting = client.connect().then(
      () => undefined,
      () => { connecting = null; },
    );
  }
  await connecting;
  return client.isReady;
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    if (!(await ensureConnected())) return null;
    return await client.get(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    if (!(await ensureConnected())) return;
    await client.set(key, value, { EX: ttlSeconds });
  } catch {
    /* cache-only; ignore */
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    if (!(await ensureConnected())) return;
    await client.del(key);
  } catch {
    /* cache-only; ignore */
  }
}

export function redisReady(): boolean {
  return client.isReady;
}

/** Active probe for healthz: triggers the lazy connect and pings. */
export async function redisHealthy(): Promise<boolean> {
  try {
    if (!(await ensureConnected())) return false;
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}
