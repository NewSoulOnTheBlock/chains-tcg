/**
 * Chains TCG auth service — :4001
 *
 * Routes are mounted under `/auth/*` because the gateway proxies `/auth/` here
 * without rewriting the path. Running the service directly gives the same URLs.
 */
import { registeredRoutes, startService } from '@chains/shared';
import { env } from './env.js';
import { pruneExpiredNonces } from './nonce.js';
import { mountAuthRoutes } from './routes.js';
import { smartAccountLoginSummary } from './signature.js';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const service = await startService(
    {
      name: 'auth',
      port: env.PORT,
      deps: { postgres: true, redis: true },
      bodyLimit: '64kb', // no auth payload is large; the gateway caps at 256 KB
      logLevel: env.LOG_LEVEL,
      trustProxyHops: env.TRUST_PROXY_HOPS,
      shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
    },
    ({ app }) => {
      mountAuthRoutes(app);
    },
  );

  // Printed once at boot: an unauthenticated route is visible in the log, not
  // buried in a router file.
  service.logger.info('routes_registered', { routes: registeredRoutes() });

  // The login path can now make an outbound RPC call. Which endpoint, which
  // chain and whether the path is enabled at all belong in the boot log, not in
  // a shell — the same reason the route table is printed above. `/readyz` is
  // deliberately NOT gated on it: EOA logins need no chain, so an unreachable
  // RPC must not take the whole service out of rotation.
  service.logger.info('smart_account_login', smartAccountLoginSummary());

  const timer = setInterval(() => {
    void pruneExpiredNonces()
      .then((n) => n > 0 && service.logger.info('nonces_pruned', { rows: n }))
      .catch((err: Error) => service.logger.warn('nonce_prune_failed', { err_message: err.message }));
  }, PRUNE_INTERVAL_MS);
  timer.unref();
}

void main();
