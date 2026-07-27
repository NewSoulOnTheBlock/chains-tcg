// src/ranked/telemetry-service.ts
// Fire-and-forget telemetry. Buffers events and flushes every second so we never
// block a hot match path on a DB round-trip.
import * as RDB from './db';
import type { TelemetryEvent } from './types';

let buffer: TelemetryEvent[] = [];
let flushTimer: NodeJS.Timeout | null = null;

export function emit(
  type: TelemetryEvent['type'],
  payload: any,
  opts: { playerId?: string | null; matchId?: string | null } = {},
) {
  buffer.push({
    ts: Date.now(),
    type,
    playerId: opts.playerId ?? null,
    matchId: opts.matchId ?? null,
    payload,
  });
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 1000);
}

export async function flush() {
  flushTimer = null;
  if (buffer.length === 0) return;
  const batch = buffer; buffer = [];
  try { await RDB.emitTelemetry(batch); }
  catch (e) {
    console.warn('[ranked/telemetry] flush failed; re-buffering', e);
    buffer = batch.concat(buffer);
    setTimeout(scheduleFlush, 5000);
  }
}

export function startTelemetryFlusher() {
  // Periodic flusher in case nothing has been emitted recently but the buffer
  // has stale events. Safe no-op when buffer is empty.
  setInterval(() => { void flush(); }, 5000).unref?.();
}
