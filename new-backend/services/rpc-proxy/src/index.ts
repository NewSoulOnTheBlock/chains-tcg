/**
 * rpc-proxy entrypoint (:4005).
 *
 * The only holder of RPC credentials (H-5). The browser calls `/rpc/evm` here
 * instead of embedding a key in the bundle, and the wager service uses the same
 * endpoint for its verification reads.
 *
 * It deliberately cannot broadcast: see `allowlist.ts`.
 */
import { startService } from './platform/shared.js';
import { log } from './platform/logger.js';
import { describeConfig, env as loadConfig, upstreamHost } from './config.js';
import { buildPolicy } from './allowlist.js';
import { CircuitBreaker } from './breaker.js';
import { UpstreamClient } from './upstream/client.js';
import { mountRpcRoutes } from './http/rpcRoutes.js';

const config = loadConfig();
const host = upstreamHost(config.EVM_RPC_URL);
const policy = buildPolicy(config.RPC_ALLOWED_METHODS);

const breaker = new CircuitBreaker({
  failureThreshold: config.RPC_BREAKER_FAILURES,
  cooldownMs: config.RPC_BREAKER_COOLDOWN_MS,
});

const upstream = new UpstreamClient({
  url: config.EVM_RPC_URL,
  host,
  timeoutMs: config.RPC_UPSTREAM_TIMEOUT_MS,
  breaker,
});

log().info('rpc_proxy_config_loaded', {
  upstream_host: host,
  allowed_methods: [...policy.allowed].sort(),
  internal_tier: config.RPC_INTERNAL_TOKEN ? 'enabled' : 'disabled',
  config: describeConfig(config),
});

await startService(
  {
    name: 'rpc-proxy',
    port: config.PORT,
    // No Postgres: this service owns no data. Redis backs the rate limiters and
    // the response cache, and a dead Redis means we fail readiness rather than
    // quietly serving unlimited traffic.
    deps: { postgres: false, redis: true },
    bodyLimit: `${config.RPC_MAX_BODY_BYTES}b`,
    logLevel: config.LOG_LEVEL,
    trustProxyHops: config.TRUST_PROXY_HOPS,
    shutdownGraceMs: config.SHUTDOWN_GRACE_MS,
    extraReadyChecks: [
      async () => {
        // Readiness follows the breaker, not a live upstream call: probing the
        // provider on every readiness check would be its own rate-limit problem.
        if (breaker.state === 'open') {
          throw new Error(`upstream ${host} circuit breaker is open`);
        }
      },
    ],
  },
  ({ app }) => {
    mountRpcRoutes(app, {
      policy,
      upstream,
      chainKey: host,
      internalToken: config.RPC_INTERNAL_TOKEN,
      ttls: {
        receipt: config.RPC_CACHE_RECEIPT_TTL_SEC,
        transaction: config.RPC_CACHE_TX_TTL_SEC,
        block: config.RPC_CACHE_BLOCK_TTL_SEC,
        chainId: config.RPC_CACHE_CHAINID_TTL_SEC,
      },
      limits: {
        ip: { limit: config.RPC_IP_LIMIT, windowSec: config.RPC_IP_WINDOW_SEC },
        profile: { limit: config.RPC_PROFILE_LIMIT, windowSec: config.RPC_PROFILE_WINDOW_SEC },
        internal: { limit: config.RPC_INTERNAL_LIMIT, windowSec: config.RPC_INTERNAL_WINDOW_SEC },
      },
    });
  },
);
