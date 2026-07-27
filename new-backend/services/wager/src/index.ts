/**
 * wager service entrypoint (:4004).
 *
 * Boots in this order so a misconfiguration is fatal before anything can accept
 * money: env → keypairs → dependencies (via `startService`) → routes →
 * settlement worker.
 *
 * The worker is what settles matches. There is no HTTP route in this service
 * that decides a payout (C-1).
 */
import { startService } from './platform/shared.js';
import { log } from './platform/logger.js';
import { wire } from './bootstrap.js';
import { mountEscrowRoutes, type RouteLimits } from './http/escrowRoutes.js';
import { mountBoosterRoutes } from './http/boosterRoutes.js';
import { mountCollectionRoutes } from './http/collectionRoutes.js';
import { startSettlementWorker, type WorkerHandle } from './worker/settlementWorker.js';

// Env + keypairs are validated before `startService` opens a socket.
const wiring = wire();

let worker: WorkerHandle | null = null;

const limits: RouteLimits = {
  limit: wiring.env.WAGER_RATE_LIMIT,
  windowSec: wiring.env.WAGER_RATE_WINDOW_SEC,
};

const running = await startService(
  {
    name: 'wager',
    port: wiring.env.PORT,
    deps: { postgres: true, redis: true },
    logLevel: wiring.env.LOG_LEVEL,
    trustProxyHops: wiring.env.TRUST_PROXY_HOPS,
    shutdownGraceMs: wiring.env.SHUTDOWN_GRACE_MS,
    extraReadyChecks: [
      async () => {
        // A wager service whose settlement worker has stalled is not ready to
        // take more deposits — it would be accepting money it cannot pay out.
        if (worker && !worker.healthy()) throw new Error('settlement worker is stalled');
      },
    ],
  },
  ({ app }) => {
    mountEscrowRoutes(app, wiring.escrowDeps, limits);
    mountBoosterRoutes(app, wiring.boosterDeps, limits);
    mountCollectionRoutes(app, wiring.collectionDeps, limits);
  },
);

if (wiring.env.SETTLEMENT_ENABLED) {
  worker = startSettlementWorker(wiring.workerDeps);
  log().info('settlement_worker_started', { poll_ms: wiring.env.SETTLEMENT_POLL_MS });
} else {
  log().warn('settlement_worker_disabled', { reason: 'SETTLEMENT_ENABLED=false' });
}

// `startService` installs its own SIGTERM/SIGINT handlers for the HTTP server
// and the connection pools; the worker needs to drain too, so that we never
// abandon a payout between "broadcast" and "recorded".
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void (async () => {
      if (worker) await worker.stop();
    })();
  });
}

export { running };
