/**
 * `@chains/shared` — the library every service imports.
 *
 * Import surface (see README.md § Shared package API):
 *
 *   errors     AppError, errorEnvelope, errorHandler, notFoundHandler, asyncHandler
 *   log        createLogger, requestContext, Logger
 *   env        loadEnv, serviceEnvShape, parseOperatorAddresses
 *   db         initDb, query, queryOne, withTransaction, db.readyCheck, isUniqueViolation
 *   redis      initRedis, getRedis, tokenBucket, getDel, redis.readyCheck
 *   auth       signAccessToken, verifyAccessToken, requireAuth, requireRole, route
 *   validate   validateBody/Query/Params, strictBody, z, field schemas
 *   ratelimit  rateLimit, clientIp
 *   service    startService, createApp, finalizeApp
 *   chains     CHAINS, getChain, normalizeAddress, shortAddress
 *
 * `db` and `redis` both export `readyCheck`, so they are additionally exposed
 * as namespaces: `db.readyCheck()` / `redis.readyCheck()`.
 */

// Express `Request` augmentation (req.auth, req.log, req.id, req.valid).
import './types.js';

export * from './errors.js';
export * from './log.js';
export * from './env.js';
export * from './auth.js';
export * from './chains.js';
export * from './validate.js';
export * from './ratelimit.js';
export * from './service.js';

// Namespaced — both modules export `readyCheck`.
export * as db from './db.js';
export * as redis from './redis.js';

// Convenience named re-exports (no collisions).
export {
  initDb,
  getPool,
  query,
  queryOne,
  withTransaction,
  closeDb,
  isUniqueViolation,
  isForeignKeyViolation,
} from './db.js';
export type { DbOptions, Pool, PoolClient, QueryResult, QueryResultRow } from './db.js';

export { initRedis, getRedis, closeRedis, getDel, setIfAbsent, tokenBucket, peekTokenBucket } from './redis.js';
export type { RedisClient, RedisOptions, TokenBucketResult } from './redis.js';
