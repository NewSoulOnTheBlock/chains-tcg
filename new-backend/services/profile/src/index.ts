import { Router } from 'express';
import { startService } from '@chains/shared';
import { config } from './config.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerDeckRoutes } from './routes/decks.js';
import { registerLeaderboardRoutes } from './routes/leaderboard.js';

/**
 * profile service (:4002) — profiles, decks, leaderboard, match history.
 *
 * `startService` owns the standard shell: body cap, request ids, structured
 * logs, `/healthz`, `/readyz` (postgres + redis), the error envelope, and a
 * hard exit if a dependency is unreachable at boot (audit H-3). This file only
 * mounts routes.
 */
await startService(
  {
    name: 'profile',
    port: config.PORT,
    deps: { postgres: true, redis: true },
    logLevel: config.LOG_LEVEL,
    trustProxyHops: config.TRUST_PROXY_HOPS,
    shutdownGraceMs: config.SHUTDOWN_GRACE_MS,
  },
  ({ app }) => {
    const router = Router();
    // Order matters: `/api/profiles/me` must be matched before
    // `/api/profiles/:displayName`.
    registerProfileRoutes(router);
    registerDeckRoutes(router);
    registerLeaderboardRoutes(router);
    app.use(router);
  },
);
