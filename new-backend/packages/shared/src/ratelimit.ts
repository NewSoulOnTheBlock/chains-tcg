/**
 * Per-profile / per-IP rate limiting, backed by the Redis token bucket.
 *
 * The gateway already applies coarse per-IP limits (10 r/s global, 5 r/min on
 * `/auth/`, 1 r/s on `/wager/`). This layer exists because an authenticated
 * attacker behind a rotating IP pool defeats the gateway limit but not a limit
 * keyed on their profile id.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from './errors.js';
import { tokenBucket } from './redis.js';

export type RateLimitKeyFn = (req: Request) => string | null;

export interface RateLimitOptions {
  /** Namespace for the Redis key, e.g. `auth:nonce`. */
  name: string;
  limit: number;
  windowSec: number;
  /**
   * What to key on. `'profile'` falls back to the IP for unauthenticated
   * callers so a public route can still be limited.
   */
  by?: 'ip' | 'profile' | 'address' | RateLimitKeyFn;
  cost?: number;
  /** Skip the limit entirely for these roles (default: none). */
  exemptRoles?: string[];
}

/** `req.ip` with `trust proxy` configured; falls back to the socket address. */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

function resolveKey(req: Request, by: RateLimitOptions['by']): string | null {
  if (typeof by === 'function') return by(req);
  switch (by) {
    case 'profile':
      return req.auth ? `profile:${req.auth.profileId}` : `ip:${clientIp(req)}`;
    case 'address':
      return req.auth ? `addr:${req.auth.chain}:${req.auth.address}` : `ip:${clientIp(req)}`;
    case 'ip':
    default:
      return `ip:${clientIp(req)}`;
  }
}

/** Express middleware form of `tokenBucket`. */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { name, limit, windowSec, cost = 1, exemptRoles = [] } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    if (exemptRoles.length > 0 && req.auth?.roles.some((r) => exemptRoles.includes(r))) {
      next();
      return;
    }

    const subject = resolveKey(req, options.by);
    if (!subject) {
      next();
      return;
    }

    void tokenBucket(`rl:${name}:${subject}`, limit, windowSec, cost)
      .then((result) => {
        res.setHeader('RateLimit-Limit', String(result.limit));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, result.remaining)));
        if (!result.allowed) {
          const retry = Math.max(1, result.retryAfterSec);
          res.setHeader('Retry-After', String(retry));
          req.log?.warn('rate_limited', { bucket: name, subject, retry_after_sec: retry });
          next(AppError.rateLimited('Too many requests', { retryAfterSec: retry }));
          return;
        }
        next();
      })
      // Redis being down is a hard failure, not a reason to stop rate limiting.
      .catch(next);
  };
}

/**
 * Apply several buckets in sequence — the usual pattern for `/auth/*`, where a
 * request is limited both per IP and per wallet address.
 */
export function rateLimitAll(...limits: RateLimitOptions[]): RequestHandler[] {
  return limits.map(rateLimit);
}
