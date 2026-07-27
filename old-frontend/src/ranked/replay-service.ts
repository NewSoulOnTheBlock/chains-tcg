// src/ranked/replay-service.ts
// Append-only replay log keyed by match id. Reconstruction is deterministic by
// replaying boardgame.io moves over the original RNG seed (the seed is stored
// alongside the match outcome).
import * as RDB from './db';
import type { ReplayEvent } from './types';

const buffersByMatch = new Map<string, ReplayEvent[]>();
const seqByMatch = new Map<string, number>();
let flushTimer: NodeJS.Timeout | null = null;

export function recordMove(matchId: string, actor: string | null, payload: any) {
  appendEvent(matchId, 'move', actor, payload);
}
export function recordTurnEnd(matchId: string, actor: string | null) {
  appendEvent(matchId, 'turn_end', actor, null);
}
export function recordGameover(matchId: string, payload: any) {
  appendEvent(matchId, 'gameover', null, payload);
}
export function recordDisconnect(matchId: string, playerId: string) {
  appendEvent(matchId, 'disconnect', playerId, null);
}

function appendEvent(matchId: string, type: string, actor: string | null, payload: any) {
  const seq = (seqByMatch.get(matchId) ?? 0) + 1;
  seqByMatch.set(matchId, seq);
  const buf = buffersByMatch.get(matchId) ?? [];
  buf.push({ matchId, seq, ts: Date.now(), type, actor, payload });
  buffersByMatch.set(matchId, buf);
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 1500);
}

export async function flush() {
  flushTimer = null;
  if (buffersByMatch.size === 0) return;
  const all: ReplayEvent[] = [];
  for (const arr of buffersByMatch.values()) all.push(...arr);
  buffersByMatch.clear();
  try { await RDB.appendReplayEvents(all); }
  catch (e) {
    console.warn('[ranked/replay] flush failed; events lost?', e);
  }
}

export async function getReplay(matchId: string) {
  return await RDB.getReplay(matchId);
}

export function startReplayFlusher() {
  setInterval(() => { void flush(); }, 5000).unref?.();
}
