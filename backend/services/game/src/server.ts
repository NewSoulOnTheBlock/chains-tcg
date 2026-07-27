// Chains TCG game service — boardgame.io Server hosting the ChainsTCG game.
//
// Match storage is in-memory for v1 (matches are lost on restart). To make
// them durable later, swap in a boardgame.io storage adapter such as
// bgio-postgres via the Server({ db }) option.
import { Server, Origins } from 'boardgame.io/server';
import { ChainsTCG } from '@chains/game-core';

const PORT = Number(process.env.PORT) || 8000;

const server = Server({
  games: [ChainsTCG],
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
