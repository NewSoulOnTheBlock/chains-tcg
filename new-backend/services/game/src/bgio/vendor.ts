/**
 * ESM shim for boardgame.io's server + internal entry points.
 * See src/game/bgio-core.ts for why `createRequire` is needed here.
 */
import { createRequire } from 'node:module';
import type {
  Server as ServerFn,
  Origins as OriginsNs,
  SocketIO as SocketIOClass,
} from 'boardgame.io/server';
import type { createMatch as CreateMatchFn } from 'boardgame.io/internal';

const require = createRequire(import.meta.url);

const serverPkg = require('boardgame.io/server') as {
  Server: typeof ServerFn;
  Origins: typeof OriginsNs;
  SocketIO: typeof SocketIOClass;
};
const internalPkg = require('boardgame.io/internal') as {
  createMatch: typeof CreateMatchFn;
};

export const Server = serverPkg.Server;
export const Origins = serverPkg.Origins;
/** The socket.io transport, so we can override its CORS config. */
export const SocketIO = serverPkg.SocketIO;
/** Runs the game's `setup` and produces `{ initialState, metadata }`. */
export const createMatch = internalPkg.createMatch;

export type BgioServer = ReturnType<typeof ServerFn>;
