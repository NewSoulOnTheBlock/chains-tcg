// src/ranked/queue-service.ts
// Ranked queue: validate, enqueue, leave, status. Matchmaker reads via
// `claimPair` directly from RDB.
import * as RDB from './db';
import { getOrCreateProfile } from './rating-service';
import { ensureActiveSeason } from './season-service';
import * as Telemetry from './telemetry-service';
import { validateDeck } from '../cards';
import { getDeck } from '../db';

export type QueueJoinResult =
  | { ok: true; queuedAt: number; seasonId: string }
  | { ok: false; error: string; issues?: { code: string; message: string }[] };

export async function joinQueue(
  playerId: string,
  region: string,
  selectedDeckId: string | undefined,
): Promise<QueueJoinResult> {
  if (!playerId) return { ok: false, error: 'playerId required' };
  if (!region)   return { ok: false, error: 'region required' };

  // Resolve & validate the deck.
  const deck = selectedDeckId ? null : await getDeck(playerId);
  let deckList: string[] | null = null;
  let deckIdStored = '';
  if (selectedDeckId) {
    try {
      const parsed = JSON.parse(selectedDeckId);
      if (Array.isArray(parsed)) { deckList = parsed.map(String); deckIdStored = selectedDeckId; }
    } catch { /* ignore — fall through */ }
  } else if (deck) {
    deckList = deck;
    deckIdStored = JSON.stringify(deck);
  }
  if (!deckList) return { ok: false, error: 'no deck selected' };
  const v = validateDeck(deckList);
  if (!v.ok) return { ok: false, error: 'invalid deck', issues: v.issues };

  // Already queued? Idempotent re-enqueue refreshes the timestamp.
  const profile = await getOrCreateProfile(playerId);
  const season = await ensureActiveSeason();
  const now = Date.now();
  await RDB.enqueue({
    playerId, hiddenMmr: profile.hiddenMmr, region,
    queuedAt: now, selectedDeckId: deckIdStored,
    seasonId: season.id,
  });
  Telemetry.emit('queue_time', { region, mmr: profile.hiddenMmr, action: 'join' },
    { playerId });
  return { ok: true, queuedAt: now, seasonId: season.id };
}

export async function leaveQueue(playerId: string) {
  await RDB.dequeue(playerId);
  Telemetry.emit('queue_time', { action: 'leave' }, { playerId });
}

export async function queueStatus(playerId: string) {
  return await RDB.queueStatus(playerId);
}
