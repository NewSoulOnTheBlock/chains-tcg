// src/ranked/index.ts — barrel + boot helper.
import { getPool } from '../db';
import { setRankedPool, initRankedSchema } from './db';
import { ensureActiveSeason } from './season-service';
import { startMatchmaker } from './matchmaker';
import { startTelemetryFlusher } from './telemetry-service';
import { startReplayFlusher } from './replay-service';

export { routeRanked } from './api';
export * as RankedDB from './db';
export * as RatingService from './rating-service';
export * as QueueService from './queue-service';
export * as Leaderboard from './leaderboard-service';
export * as Replay from './replay-service';
export * as Telemetry from './telemetry-service';
export * as Season from './season-service';

/**
 * Boot the ranked subsystem. Safe to call once after `initDb()` has finished.
 * Kicks off async workers and ensures an active season exists.
 */
export async function bootRanked(opts: { lobbyServerUrl?: string } = {}) {
  setRankedPool(getPool());
  await initRankedSchema();
  await ensureActiveSeason();
  startTelemetryFlusher();
  startReplayFlusher();
  startMatchmaker({ serverUrl: opts.lobbyServerUrl });
  console.log('[ranked] booted');
}
