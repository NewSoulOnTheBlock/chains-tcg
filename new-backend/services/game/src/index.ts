import { setTimeout as delay } from 'node:timers/promises';
import { Router } from 'express';
import { createLogger, startService } from '@chains/shared';
import { config } from './config.js';
import { registerLobbyRoutes } from './routes/lobby.js';
import { connectStore, closeStore, store } from './bgio/store.js';
import { createBgioServer, attachBgioTransport, stopBgioServer } from './bgio/server.js';
import { resultRecorder } from './results/recorder.js';

/**
 * game service (:4003) — boardgame.io match server, hardened lobby, and the
 * ONLY writer of `game.match_results`.
 *
 * One port, three surfaces, all behind the gateway's existing config:
 *   /games/*     our lobby API (this file mounts it)
 *   /socket.io/  boardgame.io's websocket transport (see bgio/server.ts)
 *   /healthz /readyz   from `startService`
 *
 * boardgame.io's own lobby REST API is never constructed — see bgio/server.ts
 * for why that is stronger than blocking it (audit H-7).
 *
 * `startService` owns the standard shell: body cap, request ids, structured
 * logs, readiness over postgres and redis, the error envelope, and a hard exit
 * if a dependency is unreachable at boot (audit H-3). CORS is deliberately
 * absent here — the gateway is the only layer that emits it.
 *
 * No route mounted below accepts a match outcome. Results come from
 * results/recorder.ts, off server-held state (audit C-1).
 */
const log = createLogger({ service: 'game' });

const running = await startService(
  {
    name: 'game',
    port: config.PORT,
    deps: { postgres: true, redis: true },
    logLevel: config.LOG_LEVEL,
    trustProxyHops: config.TRUST_PROXY_HOPS,
    shutdownGraceMs: config.SHUTDOWN_GRACE_MS,
    // A healthy lobby in front of a dead match store is worse than being taken
    // out of rotation, so boardgame.io's storage is part of readiness too.
    extraReadyChecks: [
      async () => {
        await store.sequelize.authenticate();
      },
    ],
  },
  async ({ app }) => {
    await connectStore();
    createBgioServer();

    const router = Router();
    registerLobbyRoutes(router);
    app.use(router);
  },
);

// socket.io has to be attached to a real listening server, which only exists
// once startService has resolved.
attachBgioTransport(running.server);
resultRecorder.start();

/**
 * `startService` handles SIGTERM/SIGINT for the HTTP server and the shared
 * pools. These listeners retire the two things it does not know about.
 *
 * Order matters. Websockets keep the HTTP server from finishing its close, so
 * they are hung up first. boardgame.io then flushes a `setMetadata` write per
 * disconnected seat, on its own async path that we cannot await — hence the
 * short drain before boardgame.io's storage pool is closed underneath it.
 *
 * The sweeper is idempotent and crash-safe, so a shutdown that cuts a pass
 * short costs nothing: the next boot's first pass has no cursor and rescans.
 */
const BGIO_DRAIN_MS = 500;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      stopBgioServer();
      await resultRecorder.stop().catch(() => undefined);
      await delay(BGIO_DRAIN_MS);
      await closeStore().catch((err: unknown) =>
        log.warn('boardgame.io store close failed', { err: String(err) }),
      );
    })();
  });
}
