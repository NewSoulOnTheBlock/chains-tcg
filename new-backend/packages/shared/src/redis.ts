/**
 * The single Redis client.
 *
 * Like the database, there is no fallback: if Redis is unreachable the process
 * fails `readyCheck()` and is restarted. Nonces and rate limits that silently
 * stop working are worse than an outage.
 */
import { createClient } from 'redis';
import type { Logger } from './log.js';

export type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient | null = null;
let redisLogger: Logger | null = null;

export interface RedisOptions {
  url?: string;
  logger?: Logger;
}

/** Create and connect the process-wide client. Idempotent. */
export async function initRedis(options: RedisOptions = {}): Promise<RedisClient> {
  if (client) return client;

  const url = options.url ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not set — refusing to start without Redis');
  }

  redisLogger = options.logger ?? null;

  const c = createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      // Bounded backoff. If Redis never comes back the readiness probe fails
      // and the orchestrator replaces the container.
      reconnectStrategy: (retries) => Math.min(100 * 2 ** retries, 5_000),
    },
  });

  c.on('error', (err: Error) => {
    redisLogger?.error('redis_error', { err_message: err.message });
  });

  await c.connect();
  client = c;
  return c;
}

/** The client, or a thrown error if `initRedis` has not run. */
export function getRedis(): RedisClient {
  if (!client) {
    throw new Error('Redis client not initialised — call initRedis() during startup');
  }
  return client;
}

/** Dependency check for `/readyz`. Throws on any failure. */
export async function readyCheck(): Promise<void> {
  if (!client) throw new Error('redis client not initialised');
  if (!client.isOpen) throw new Error('redis connection is closed');
  const pong = await client.ping();
  if (pong !== 'PONG') throw new Error(`unexpected PING reply: ${String(pong)}`);
}

/** Graceful shutdown. */
export async function closeRedis(): Promise<void> {
  if (!client) return;
  const c = client;
  client = null;
  try {
    await c.quit();
  } catch {
    c.destroy();
  }
}

/**
 * Atomic single-use read. Returns the value and deletes the key in one step,
 * so two concurrent requests can never both consume the same nonce.
 * Requires Redis >= 6.2 (we run 7).
 */
export async function getDel(key: string): Promise<string | null> {
  const reply = await getRedis().sendCommand<unknown>(['GETDEL', key]);
  if (reply === null || reply === undefined) return null;
  return typeof reply === 'string' ? reply : String(reply);
}

/** Set a key only if it does not exist, with a TTL. Returns false if it existed. */
export async function setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean> {
  const reply = await getRedis().sendCommand<unknown>([
    'SET',
    key,
    value,
    'NX',
    'EX',
    String(Math.max(1, Math.floor(ttlSec))),
  ]);
  return reply === 'OK';
}

/**
 * Token bucket, evaluated atomically inside Redis.
 *
 * `limit` tokens refill evenly across `windowSec`. A caller that stays under
 * `limit / windowSec` on average is never throttled, but a burst larger than
 * `limit` is. Used for per-profile and per-address limits inside services;
 * per-IP limits are additionally enforced at the gateway.
 */
const TOKEN_BUCKET_LUA = `
local key      = KEYS[1]
local limit    = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])
local refill   = limit / window

local state  = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts     = tonumber(state[2])

if tokens == nil or ts == nil then
  tokens = limit
  ts = now
end

local elapsed = now - ts
if elapsed < 0 then elapsed = 0 end
tokens = math.min(limit, tokens + elapsed * refill)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', key, math.ceil(window * 2) + 1)

local retry = 0
if allowed == 0 then
  retry = math.ceil((cost - tokens) / refill)
end

return { allowed, math.floor(tokens), retry }
`;

export interface TokenBucketResult {
  allowed: boolean;
  /** Whole tokens left after this call. */
  remaining: number;
  /** Seconds until `cost` tokens are available again. 0 when allowed. */
  retryAfterSec: number;
  limit: number;
}

/**
 * Consume `cost` tokens from the bucket at `key`.
 *
 *     const rl = await tokenBucket(`auth:ip:${ip}`, 30, 60);
 *     if (!rl.allowed) throw AppError.rateLimited();
 */
export async function tokenBucket(
  key: string,
  limit: number,
  windowSec: number,
  cost = 1,
): Promise<TokenBucketResult> {
  if (limit <= 0 || windowSec <= 0) throw new Error('tokenBucket: limit and windowSec must be > 0');

  const nowSec = Date.now() / 1000;
  // sendCommand keeps this working across node-redis majors, whose scripting
  // helper signatures have churned.
  const reply = (await getRedis().sendCommand<unknown>([
    'EVAL',
    TOKEN_BUCKET_LUA,
    '1',
    key,
    String(limit),
    String(windowSec),
    nowSec.toFixed(6),
    String(cost),
  ])) as unknown[];

  const allowed = Number(reply?.[0] ?? 0) === 1;
  const remaining = Number(reply?.[1] ?? 0);
  const retryAfterSec = Number(reply?.[2] ?? 0);

  return { allowed, remaining, retryAfterSec, limit };
}

/** Read a bucket's state without consuming anything. */
export async function peekTokenBucket(key: string, limit: number, windowSec: number): Promise<TokenBucketResult> {
  return tokenBucket(key, limit, windowSec, 0);
}
