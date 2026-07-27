/**
 * `POST /rpc/evm` — the only route this service exposes.
 *
 * | Method | Path      | Auth                                             |
 * |--------|-----------|--------------------------------------------------|
 * | POST   | /rpc/evm  | public (optional auth; per-IP + per-profile limits)|
 *
 * Public because the browser must be able to read chain state without the key.
 * That is safe only because of the allowlist: no method here can move funds,
 * sign anything, or reveal the upstream credential.
 *
 * There is no `/rpc/solana`. This backend is EVM-only; the Solana route and its
 * allowlist were removed along with the rest of the Solana path.
 */
import type { IRouter, Request } from 'express';
import {
  AppError,
  asyncHandler,
  clientIp,
  getRedis,
  rateLimit,
  route,
  strictBody,
  validateBody,
  validatedBody,
  z,
} from '../platform/shared.js';
import { log } from '../platform/logger.js';
import { checkMethod, type MethodPolicy } from '../allowlist.js';
import { cacheKey, isCacheableResult, ttlFor } from '../cache.js';
import type { UpstreamClient } from '../upstream/client.js';

/**
 * A single JSON-RPC call. Batches are refused: they multiply one inbound
 * request into many upstream ones, which defeats per-request rate limiting.
 */
export const rpcBody = strictBody({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.string().max(128), z.number(), z.null()]).optional(),
  method: z.string().min(1).max(128),
  params: z.array(z.unknown()).max(32).default([]),
});

export interface RpcRouteDeps {
  policy: MethodPolicy;
  upstream: UpstreamClient;
  chainKey: string;
  internalToken: string;
  ttls: { receipt: number; transaction: number; block: number; chainId: number };
  limits: {
    ip: { limit: number; windowSec: number };
    profile: { limit: number; windowSec: number };
    internal: { limit: number; windowSec: number };
  };
}

function isInternal(req: Request, token: string): boolean {
  if (!token) return false;
  const provided = req.header('x-internal-token');
  return typeof provided === 'string' && provided.length > 0 && provided === token;
}

function envelope(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

export function mountRpcRoutes(router: IRouter, deps: RpcRouteDeps): void {
  // Internal callers get their own, much larger budget; everyone else is
  // limited per IP and, when signed in, additionally per profile. An
  // authenticated attacker rotating IPs is caught by the profile bucket; an
  // anonymous one rotating sessions is caught by the IP bucket.
  const ipLimit = rateLimit({ name: 'rpc:ip', by: 'ip', ...deps.limits.ip });
  const profileLimit = rateLimit({ name: 'rpc:profile', by: 'profile', ...deps.limits.profile });
  const internalLimit = rateLimit({
    name: 'rpc:internal',
    by: () => 'internal',
    ...deps.limits.internal,
  });

  route(router, {
    method: 'post',
    path: '/rpc/evm',
    public: true,
    optionalAuth: true,
    summary: 'read-only EVM JSON-RPC; the upstream key never leaves this service',
    middleware: [
      (req, res, next) => {
        if (isInternal(req, deps.internalToken)) {
          internalLimit(req, res, next);
          return;
        }
        ipLimit(req, res, (err?: unknown) => {
          if (err) {
            next(err);
            return;
          }
          if (req.auth) profileLimit(req, res, next);
          else next();
        });
      },
      validateBody(rpcBody),
    ],
    handler: asyncHandler(async (req, res) => {
      const body = validatedBody(req, rpcBody);
      const started = Date.now();

      const verdict = checkMethod(deps.policy, body.method);
      if (!verdict.ok) {
        // Log the method — never the params, which carry addresses.
        req.log.warn('rpc_method_refused', {
          method: body.method,
          refusal: verdict.reason,
          ip: clientIp(req),
        });
        throw AppError.forbidden(
          verdict.reason === 'denied'
            ? 'That JSON-RPC method is never proxied. Broadcasting and signing must not go through the proxy.'
            : 'That JSON-RPC method is not on the read-only allowlist.',
          { reason: verdict.reason, method: body.method },
        );
      }

      const params = body.params as unknown[];
      const ttl = ttlFor(body.method, params, deps.ttls);
      const key = ttl === null ? null : cacheKey(deps.chainKey, body.method, params);

      if (key) {
        try {
          const hit = await getRedis().get(key);
          if (hit !== null) {
            req.log.debug('rpc_cache_hit', { method: body.method, ms: Date.now() - started });
            res.json(envelope(body.id, JSON.parse(hit)));
            return;
          }
        } catch (err) {
          // A cache miss is always safe; a cache outage must not be an outage.
          req.log.warn('rpc_cache_read_failed', {
            method: body.method,
            err_message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const outcome = await deps.upstream.call(body.method, params, 1);
      const ms = Date.now() - started;

      if (outcome.kind === 'unavailable') {
        req.log.warn('rpc_unavailable', { method: body.method, reason: outcome.reason, ms });
        throw AppError.unavailable('Upstream RPC is unavailable', { reason: outcome.reason });
      }

      if (outcome.kind === 'rpc_error') {
        req.log.info('rpc_upstream_rejected', { method: body.method, rpc_code: outcome.code, ms });
        // Pass the JSON-RPC error through verbatim: it is the node's answer,
        // and clients need `execution reverted` to be actionable.
        res.status(200).json({
          jsonrpc: '2.0',
          id: body.id ?? null,
          error: { code: outcome.code, message: outcome.message },
        });
        return;
      }

      if (key && ttl && isCacheableResult(body.method, outcome.result)) {
        try {
          await getRedis().set(key, JSON.stringify(outcome.result), { EX: ttl });
        } catch (err) {
          req.log.warn('rpc_cache_write_failed', {
            method: body.method,
            err_message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Structured access log: method and latency, never the params.
      req.log.info('rpc_call', {
        method: body.method,
        ms,
        cached: false,
        internal: isInternal(req, deps.internalToken),
      });
      res.json(envelope(body.id, outcome.result));
    }),
  });

  // A GET here is almost always a developer expecting a REST endpoint; a clear
  // 405 saves an afternoon.
  route(router, {
    method: 'get',
    path: '/rpc/evm',
    public: true,
    summary: 'method-not-allowed hint',
    handler: (_req, res) => {
      res
        .status(405)
        .set('allow', 'POST')
        .json({
          error: {
            code: 'method_not_allowed',
            message: 'JSON-RPC is POST only. Send {"method":"eth_blockNumber","params":[]}.',
          },
        });
    },
  });

  log().debug('rpc_routes_mounted', { allowed_methods: deps.policy.allowed.size });
}
