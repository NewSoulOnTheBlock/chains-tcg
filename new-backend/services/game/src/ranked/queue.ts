/**
 * The ranked queue, ported from `src/ranked/queue-service.ts`.
 *
 * ── Every input the legacy version took from the client is gone ────────────
 * Legacy signature:
 *
 *     joinQueue(playerId: string, region: string, selectedDeckId: string | undefined)
 *
 * called from a route that read `{ name, region, deckId }` out of the request
 * body, where `deckId` was a JSON-stringified array of card ids. So the client
 * chose who it was, and what it was playing. Here `profileId` comes from the
 * JWT via `AuthContext`, and the deck is the caller's ACTIVE deck resolved
 * server-side from `core.decks` — the same source `POST /games/create` uses, so
 * a player cannot bring one deck to the lobby and a different one to the ladder.
 *
 * ── Legality is checked at ENQUEUE, not at pairing ─────────────────────────
 * `assertDeckOwnership` already refuses a ranked seat whose deck contains cards
 * the profile does not own, by quantity (lib/seating.ts). Deferring that to
 * pairing time would mean a player waits three minutes in a queue to be told
 * their deck was never eligible, and — worse — the failure would surface as a
 * pairing that silently did not happen, with no error attached to anyone. So the
 * gate runs here, synchronously, with the reason in the response.
 *
 * The pairer STILL re-checks (matchmaker.ts). That is not redundancy: `core.decks
 * .cards` stays editable while its owner sits in the queue, exactly as it stays
 * editable while a match sits open in the lobby, so a check at enqueue is a check
 * of a deck that may no longer exist by the time anyone is seated.
 */
import { AppError, createLogger, withTransaction } from '@chains/shared';
import { config } from '../config.js';
import { getActiveDeck } from '../repo/decks.repo.js';
import * as repo from '../repo/ranked.repo.js';
import { assertDeckOwnership, assertSeatableDeck } from '../lib/seating.js';
import { ensureActiveSeason } from './season.js';

const log = createLogger({ service: 'game' }).child({ component: 'ranked-queue' });

/**
 * Accepted regions.
 *
 * A fixed set, not free text. The pairer only ever pairs WITHIN a region, so a
 * client that invents `region: 'eu-west-2b'` strands itself in a shard of one
 * and waits forever — which is precisely what the legacy `String(body.region)`
 * allowed. `global` is the default and, at this population, the only one that
 * should be used; the others exist so sharding can be switched on from the
 * client without a migration.
 */
export const QUEUE_REGIONS = ['global', 'na', 'eu', 'ap'] as const;
export type QueueRegion = (typeof QUEUE_REGIONS)[number];

export interface QueueStatus {
  queued: boolean;
  queuedAt: string | null;
  waitedMs: number;
  region: QueueRegion | null;
  seasonId: string;
  /** Rating window the pairer is currently willing to match this entry across. */
  mmrWindow: number;
  /** Players waiting in the same region, this caller included. */
  queueDepth: number;
  match: {
    matchID: string;
    seat: 0 | 1;
    playerID: string;
    opponentDisplayName: string | null;
  } | null;
}

/**
 * How wide a rating bracket an entry has earned.
 *
 * Ported unchanged in shape from the legacy matchmaker — base plus a step per
 * interval waited — with a ceiling added. The legacy formula was unbounded, so
 * after an hour in an empty queue it produced a window of 18050 and logged it;
 * capping it keeps the number legible without changing behaviour, because by
 * `RANKED_MMR_WINDOW_MAX` (2000 points) it already means "anyone".
 */
export function mmrWindowFor(queuedAt: Date, now = Date.now()): number {
  const waitedSec = Math.max(0, (now - queuedAt.getTime()) / 1000);
  const steps = Math.floor(waitedSec / config.RANKED_MMR_WINDOW_STEP_SEC);
  const raw = config.RANKED_MMR_WINDOW_BASE + steps * config.RANKED_MMR_WINDOW_STEP;
  return Math.min(raw, config.RANKED_MMR_WINDOW_MAX);
}

export interface JoinResult {
  queuedAt: string;
  seasonId: string;
  region: QueueRegion;
  queueDepth: number;
}

export async function joinQueue(profileId: string, region: QueueRegion): Promise<JoinResult> {
  const season = await ensureActiveSeason();

  // Already playing? Queueing while seated would pair a player into a second
  // match they cannot be at, and both would then rate.
  const live = await repo.liveRankedMatchFor(profileId);
  if (live) {
    throw AppError.conflict('You are already in a ranked match', {
      reason: 'already_in_match',
      matchID: live.matchID,
    });
  }

  // Resolved server-side. `assertSeatableDeck` throws `no_active_deck` /
  // `invalid_active_deck`; `assertDeckOwnership` throws `unowned_cards` with the
  // offending cards named. All three are 400s the client can render directly.
  const deck = await getActiveDeck(profileId);
  assertSeatableDeck(deck);
  await assertDeckOwnership(profileId, deck, 'ranked');

  const entry = await withTransaction(async (c) => {
    await repo.ensureStanding(c, season.id, profileId, config.RANKED_PLACEMENT_MATCHES);
    const standing = await repo.getStanding(season.id, profileId, c);
    if (!standing) throw AppError.internal('Could not open a ranked standing');
    return { rating: standing.rating };
  });

  const row = await repo.enqueue({
    profileId,
    seasonId: season.id,
    deckId: deck.id,
    rating: entry.rating,
    region,
  });

  log.info('ranked queue join', { profileId, region, seasonId: season.id });

  return {
    queuedAt: row.queuedAt.toISOString(),
    seasonId: season.id,
    region,
    queueDepth: await repo.queueDepth(region),
  };
}

export async function leaveQueue(profileId: string): Promise<{ wasQueued: boolean }> {
  const wasQueued = await repo.dequeue(profileId);
  if (wasQueued) log.info('ranked queue leave', { profileId });
  return { wasQueued };
}

/**
 * Queue status, and the match handoff.
 *
 * ── Why the handoff is a database read and not an in-process Map ───────────
 * The legacy matchmaker kept pairings in `pendingByPlayer`, a module-level Map,
 * and `takePendingMatchFor(name)` DELETED the entry as it returned it. Three
 * consequences, all fatal in this backend:
 *
 *   • The Map lives in one process. The game service runs behind a gateway that
 *     load-balances across containers, so a player polling a different container
 *     from the one that paired them never sees their match.
 *   • A restart loses every pending pairing, and the players are no longer in
 *     the queue either, so they are simply stuck.
 *   • Reading it consumed it. A poll that raced a page reload lost the match id
 *     permanently — the legacy source has a comment about a variant of exactly
 *     this bug.
 *
 * Here there is no handoff state at all. The pairer writes a real `game.matches`
 * row, and this query finds it. That makes the poll idempotent, correct across
 * any number of containers, and the same answer a reconnecting client gets — a
 * player who closes the tab mid-match and comes back is told about their live
 * match by this route just as a freshly-paired one is.
 */
export async function queueStatus(profileId: string): Promise<QueueStatus> {
  const season = await ensureActiveSeason();
  const [entry, live] = await Promise.all([
    repo.getQueueEntry(profileId),
    repo.liveRankedMatchFor(profileId),
  ]);

  const region = (entry?.region ?? null) as QueueRegion | null;
  return {
    queued: entry !== null,
    queuedAt: entry ? entry.queuedAt.toISOString() : null,
    waitedMs: entry ? Math.max(0, Date.now() - entry.queuedAt.getTime()) : 0,
    region,
    seasonId: season.id,
    mmrWindow: entry ? mmrWindowFor(entry.queuedAt) : 0,
    queueDepth: region ? await repo.queueDepth(region) : 0,
    match: live
      ? {
          matchID: live.matchID,
          seat: live.seat,
          playerID: String(live.seat),
          opponentDisplayName: live.opponentDisplayName,
        }
      : null,
  };
}
