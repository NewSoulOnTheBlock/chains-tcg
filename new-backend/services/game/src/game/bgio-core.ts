/**
 * ESM shim for `boardgame.io/core`.
 *
 * boardgame.io 0.50 predates package `exports` maps: its subpaths are plain
 * directories containing a proxy `package.json`. Node's CommonJS resolver
 * handles that, but the ESM loader refuses it outright
 * (`ERR_UNSUPPORTED_DIR_IMPORT`), and this service is ESM/NodeNext.
 *
 * So: resolve the CJS build through `createRequire` at runtime, and take the
 * types from the package's own declarations. Same values, same types, just a
 * resolver that works. The vendored rules in ./Game.ts import from here.
 */
import { createRequire } from 'node:module';
import type {
  INVALID_MOVE as InvalidMove,
  PlayerView as PlayerViewNs,
  Stage as StageNs,
  ActivePlayers as ActivePlayersNs,
} from 'boardgame.io/core';

const require = createRequire(import.meta.url);

const core = require('boardgame.io/core') as {
  INVALID_MOVE: typeof InvalidMove;
  PlayerView: typeof PlayerViewNs;
  Stage: typeof StageNs;
  ActivePlayers: typeof ActivePlayersNs;
};

export const INVALID_MOVE = core.INVALID_MOVE;
export const PlayerView = core.PlayerView;
export const Stage = core.Stage;
export const ActivePlayers = core.ActivePlayers;
