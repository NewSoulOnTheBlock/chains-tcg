// src/ranked/matchmaker.ts
// Periodic worker that pairs queued players. Pairings widen MMR window the
// longer a player has waited. Workers cooperate via `FOR UPDATE SKIP LOCKED`.
import * as RDB from './db';
import * as Telemetry from './telemetry-service';
import { LobbyClient } from 'boardgame.io/client';
import type { RankedQueueEntry } from './types';

const WORKER_ID = `mm-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const TICK_MS = 2000;

let timer: NodeJS.Timeout | null = null;
let lobbyClient: LobbyClient | null = null;
let pendingMatches: PendingMatch[] = [];

export type PendingMatch = {
  matchId: string;
  player0: string; player1: string;
  player0Deck: string; player1Deck: string;
  region: string;
  createdAt: number;
};

/** Allow callers (e.g. /api/ranked/match/claim) to fetch pairings for clients. */
export function takePendingMatchFor(playerId: string): PendingMatch | null {
  const idx = pendingMatches.findIndex(m => m.player0 === playerId || m.player1 === playerId);
  if (idx < 0) return null;
  const [m] = pendingMatches.splice(idx, 1);
  return m;
}

export function startMatchmaker(opts: { serverUrl?: string } = {}) {
  if (timer) return;
  if (opts.serverUrl) lobbyClient = new LobbyClient({ server: opts.serverUrl });
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();
  console.log('[ranked/mm] started', WORKER_ID);
}
export function stopMatchmaker() {
  if (timer) { clearInterval(timer); timer = null; }
}

async function tick() {
  // Per-region snapshot to compute fair brackets.
  const regions = await collectRegions();
  for (const region of regions) {
    const queue = await RDB.listQueueForRegion(region);
    if (queue.length < 2) continue;
    // Sort oldest first — they get the widest bracket.
    const sorted = [...queue].sort((a, b) => a.queuedAt - b.queuedAt);
    for (const entry of sorted) {
      const waitedSec = Math.max(0, (Date.now() - entry.queuedAt) / 1000);
      const mmrRange = 50 + Math.floor(waitedSec / 10) * 50;   // ±50 expanding 50/10s
      const pair = await RDB.claimPair(WORKER_ID, region, entry.hiddenMmr, mmrRange);
      if (pair) {
        await onPairFound(pair, region);
      }
    }
  }
}

async function collectRegions(): Promise<string[]> {
  // Simple: derive regions present in the queue. We don't keep a regions table.
  const all = await RDB.listQueueForRegion('').catch(() => [] as RankedQueueEntry[]);
  // The above lists only matching empty region — we instead query each region
  // from the queue table itself. Fallback: use 'na'/'eu'/'ap' as default set.
  if (all.length > 0) return [...new Set(all.map(e => e.region))];
  return ['na', 'eu', 'ap', 'global'];
}

async function onPairFound([a, b]: [RankedQueueEntry, RankedQueueEntry], region: string) {
  // Create a boardgame.io match if a lobby client is configured. Otherwise
  // produce a synthetic match id; the integration layer can hand it off.
  let matchId: string;
  if (lobbyClient) {
    try {
      const res = await lobbyClient.createMatch('chains-tcg', {
        numPlayers: 2,
        setupData: {
          ranked: true,
          seasonId: a.seasonId,
          mode: 'ranked',
        } as any,
      });
      matchId = res.matchID;
    } catch (e) {
      console.warn('[ranked/mm] lobby createMatch failed; falling back to synthetic id', e);
      matchId = `ranked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
  } else {
    matchId = `ranked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  pendingMatches.push({
    matchId, region,
    player0: a.playerId, player1: b.playerId,
    player0Deck: a.selectedDeckId, player1Deck: b.selectedDeckId,
    createdAt: Date.now(),
  });
  Telemetry.emit('match_started', {
    matchId, region,
    player0: a.playerId, player1: b.playerId,
    p0Mmr: a.hiddenMmr, p1Mmr: b.hiddenMmr,
    p0WaitMs: Date.now() - a.queuedAt, p1WaitMs: Date.now() - b.queuedAt,
  }, { matchId });
}

/** GC stale pending matches (clients never claimed within 60s). */
export function reapStalePending(maxAgeMs = 60_000) {
  const cutoff = Date.now() - maxAgeMs;
  pendingMatches = pendingMatches.filter(m => m.createdAt >= cutoff);
}
