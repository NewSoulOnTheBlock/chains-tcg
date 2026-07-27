import type { Server as HttpServer } from 'node:http';
import { createLogger } from '@chains/shared';
import { config } from '../config.js';
import { ChainsTCG } from '../game/Game.js';
import { store } from './store.js';
import { Server, SocketIO, type BgioServer } from './vendor.js';

const log = createLogger({ service: 'game' }).child({ component: 'bgio' });

interface SocketLike {
  disconnect(close?: boolean): void;
}

interface NamespaceLike {
  /** v3 exposes a Map; older builds an object. Both are handled below. */
  sockets: Map<string, SocketLike> | Record<string, SocketLike>;
}

/**
 * socket.io's `Server`, as exposed by koa-socket-2 on the Koa app.
 *
 * koa-socket-2 pins socket.io ^3, so `disconnectSockets()` (added in v4) may or
 * may not exist depending on how npm dedupes the tree. Both shapes are typed
 * here and handled at runtime rather than assumed.
 */
interface SocketIoServer {
  attach(server: HttpServer, opts?: Record<string, unknown>): unknown;
  of(namespace: string): NamespaceLike;
  disconnectSockets?: (close?: boolean) => void;
}

let instance: BgioServer | null = null;
let io: SocketIoServer | null = null;

/**
 * socket.io option object that installs no CORS middleware. Typed loosely
 * because boardgame.io's `socketOpts` declaration does not model `cors: false`.
 */
const NO_CORS = { cors: false } as unknown as ConstructorParameters<
  typeof SocketIO
>[0] extends { socketOpts?: infer O }
  ? NonNullable<O>
  : never;

export function bgio(): BgioServer {
  if (!instance) throw new Error('boardgame.io server not started');
  return instance;
}

/**
 * Create the boardgame.io match server and bolt its socket.io transport onto
 * the service's existing Express HTTP server.
 *
 * ── Why we never call `Server.run()` (audit H-7) ─────────────────────────────
 * boardgame.io ships its own lobby REST API: `GET /games/:name`, `POST
 * /games/:name/create`, `.../join`, `.../leave`, `.../playAgain`. Those routes
 * return `setupData`, which for this game contains BOTH players' decklists, and
 * they let any caller create or join a match under whatever `playerName` they
 * care to type. They are precisely what H-7 is about.
 *
 * Everything the transport needs — the socket.io instance, the per-game
 * namespace and its `sync` / `update` / `chat` handlers — is wired by `Server()`
 * itself, at construction time, inside `transport.init()`. `run()` adds only
 * four things on top: `configureRouter()` (the lobby routes), `db.connect()`
 * (we call it ourselves), and two `listen()` calls.
 *
 * So we simply never call it. The lobby router is never constructed, never
 * mounted and never bound to a port — it is not "blocked" or "404'd", it does
 * not exist in this process. Our own hardened lobby (src/routes/lobby.ts) is
 * the only way in.
 *
 * ── Why we attach to the Express server ──────────────────────────────────────
 * `Server()` leaves socket.io attached to a Koa-owned `app.server` that nobody
 * ever listens on. Calling `io.attach()` on the Express server that the shared
 * `startService()` already created puts the websocket endpoint on the same port
 * (:4003) as everything else, which is exactly what `gateway/nginx.conf`
 * expects — `/games/` and `/socket.io/` both proxy to `game_upstream`.
 * socket.io's `attach` wraps the server's existing request listener and only
 * intercepts its own path, so the Express routes are untouched.
 */
export function createBgioServer(): void {
  instance = Server({
    games: [ChainsTCG],
    db: store,
    // CORS is the gateway's job and only the gateway's job — a second
    // Access-Control-Allow-Origin makes browsers reject the response outright
    // (see the header of gateway/nginx.conf). `cors: false` is spread over
    // boardgame.io's own cors config inside `transport.init`.
    // (socket.io accepts `cors: false` to install no CORS middleware at all;
    // boardgame.io's `socketOpts` type only admits the `cors` package's option
    // object, so the value is cast at the boundary.)
    transport: new SocketIO({ socketOpts: NO_CORS }),
    // Kept so boardgame.io does not warn that `origins` is unset. With
    // socket.io CORS disabled, the gateway allowlist is what actually decides
    // which browser origins can reach us.
    origins: config.ALLOWED_ORIGINS,
  });

  const app = instance.app as unknown as { _io?: SocketIoServer };
  if (!app._io) {
    throw new Error('boardgame.io did not attach a socket.io instance to its Koa app');
  }
  io = app._io;
}

/** Serve the boardgame.io websocket transport from an already-listening server. */
export function attachBgioTransport(server: HttpServer): void {
  if (!io) throw new Error('boardgame.io server not created');
  io.attach(server, { path: '/socket.io/' });
  log.info('boardgame.io socket transport attached', {
    path: '/socket.io/',
    game: ChainsTCG.name,
    // Proof, in the logs, that the vendor lobby routes were never built.
    rawLobbyApi: 'not-constructed',
  });
}

/**
 * Drop websocket clients so the HTTP server can actually finish closing.
 *
 * Players are in the game's own namespace (`/chains-tcg`), not the default one,
 * so the default namespace's socket list is always empty — iterate the game
 * namespace. Never throws: this runs from a signal handler, and a failure to
 * hang up cleanly must not turn a graceful shutdown into a crash.
 */
export function stopBgioServer(): void {
  const current = io;
  io = null;
  instance = null;
  if (!current) return;
  try {
    if (typeof current.disconnectSockets === 'function') {
      current.disconnectSockets(true);
      return;
    }
    const nsp = current.of(`/${ChainsTCG.name ?? 'chains-tcg'}`);
    const sockets = nsp.sockets;
    const open = sockets instanceof Map ? [...sockets.values()] : Object.values(sockets);
    for (const socket of open) socket.disconnect(true);
    log.info('boardgame.io sockets disconnected', { count: open.length });
  } catch (err) {
    log.warn('failed to disconnect boardgame.io sockets', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
