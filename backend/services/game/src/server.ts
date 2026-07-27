// Chains TCG game service — boardgame.io Server hosting the ChainsTCG game.
//
// Match storage: when DATABASE_URL is set (docker), matches are persisted to
// Postgres via bgio-postgres so they survive restarts. Without it (bare local
// dev), the default in-memory store is used and matches are lost on restart.
import { Server, Origins } from 'boardgame.io/server';
import { PostgresStore } from 'bgio-postgres';
import { ChainsTCG } from '@chains/game-core';

const PORT = Number(process.env.PORT) || 8000;

let db: PostgresStore | undefined;
if (process.env.DATABASE_URL) {
  db = new PostgresStore(process.env.DATABASE_URL, { logging: false });
  console.log('[game] using Postgres match storage (bgio-postgres)');
} else {
  console.warn(
    '[game] DATABASE_URL not set — using in-memory match storage; matches will be lost on restart',
  );
}

const server = Server({
  games: [ChainsTCG],
  db,
  origins: [
    Origins.LOCALHOST_IN_DEVELOPMENT,
    Origins.LOCALHOST,
    'http://localhost:3000',
    ...(process.env.ALLOW_ORIGIN || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  ],
});

// Liveness probe (used by docker/monitoring; not proxied by the gateway).
server.app.use(async (ctx, next) => {
  if (ctx.request.method === 'GET' && ctx.request.url === '/healthz') {
    ctx.body = { ok: true };
    return;
  }
  await next();
});

server.run(PORT, () => {
  console.log(`[game] Chains TCG game server listening on :${PORT}`);
});
