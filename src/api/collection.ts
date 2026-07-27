// src/api/collection.ts
//
// The caller's card collection, as the SERVER sees it.
//
// ─── OWNERSHIP IS NO LONGER A CLIENT CONCERN ────────────────────────────────
// Card ownership used to live in `localStorage["ocva.collection.<name>"]`,
// which meant one devtools edit granted the whole catalogue. With a ranked
// prize attached that was the highest-payoff attack in the product, so
// ownership moved server-side, where it is derived from the CardPack ERC-721
// on Robinhood Chain and projected into `core.card_ownership`.
//
// The browser copy survives ONLY as a display cache (`src/collection.ts`). It
// is never an input to a decision, and the server never reads it.
//
// ─── NEITHER ROUTE TAKES AN IDENTIFIER ──────────────────────────────────────
// No `:profileId`, no `?wallet=`, no address in any body. The wallet address
// comes from the proven session identity. A route that accepts an identifier is
// a route that can be pointed at somebody else — that was audit finding H-2.
// There is deliberately no way to read another player's collection. Do not add
// one.
//
// ─── BASIC NODES ARE NOT IN HERE ────────────────────────────────────────────
// `node_*` ids are NEVER returned. The on-chain card index is the 80 non-Node
// cards (`services/wager/src/nft/cardIndex.ts`), and seating skips Basic Nodes
// entirely (`services/game/src/lib/seating.ts` — `if (isBasicNode(id))
// continue;`). Every player is treated as holding as many Nodes as they like.
// The client synthesises that grant locally; see `STARTING_NODES` in
// `src/collection.ts`. Do not render "0 owned" for a `node_*` id.
//
// ─── "NEVER SYNCED" IS NOT "OWNS NOTHING" ───────────────────────────────────
// `{cards: {}, total: 0}` is ambiguous on its own, and getting it backwards
// means telling a paying customer their collection is gone. BRANCH ON
// `synced`, which the service defines as the existence of the profile's
// `core.card_ownership_sync` row — written on every successful sync whether or
// not it found any cards:
//
//     synced: false  →  we have never looked. UNKNOWN. Prompt a sync.
//     synced: true   →  authoritative, including "you genuinely own nothing".
//
// `syncedAt` / `syncedBlock` are for display; the service states that null on
// either "means exactly `synced === false`".
//
// An earlier revision of this endpoint had no `synced` field and derived
// `syncedAt` from `max(updated_at)`, where null covered both cases. The
// normaliser below therefore falls back to `syncedAt !== null` when `synced` is
// absent — conservative in the right direction: a deployment running the old
// service will over-prompt for a sync rather than under-report a collection.

import { get, post } from './http.js';
import { ApiError, type ApiIssue } from './errors.js';

/** Card id → quantity owned. Cards not owned are ABSENT, never zero. */
export type OwnedCards = Record<string, number>;

/** `GET /wager/collection` and the common part of the sync response. */
export interface CollectionView {
  /** Card id → quantity. Never contains a `node_*` id. */
  cards: OwnedCards;
  /** Distinct card ids owned. */
  distinct: number;
  /** Cards owned in total, counting duplicates. */
  total: number;
  /**
   * Has a chain sync EVER completed for this profile?
   *
   * THIS is the field to branch on. `false` with an empty `cards` means "we
   * have not looked"; `true` with an empty `cards` means "you own nothing".
   * See the module header.
   */
  synced: boolean;
  /** When the last successful sync committed, ISO-8601. Null iff `!synced`. */
  syncedAt: string | null;
  /**
   * Head block the snapshot is true as of. Null iff `!synced`.
   *
   * The chain's own clock, so it composes with a re-org or a lagging RPC in a
   * way a wall-clock timestamp cannot.
   */
  syncedBlock: number | null;
}

/** `POST /wager/collection/sync` — a `CollectionView` plus reconcile detail. */
export interface SyncResult extends CollectionView {
  /** Head block the snapshot was taken at. Always equal to `syncedBlock`. */
  blockNumber: number;
  /** Tokens this address once received but no longer holds. */
  transferredAway: number;
  /** Rows removed because the profile no longer holds that card. */
  removed: number;
}

/** Tolerate a malformed body rather than letting it crash a render. */
function normaliseCards(raw: unknown): OwnedCards {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: OwnedCards = {};
  for (const [id, qty] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof qty === 'number' && Number.isFinite(qty) && qty > 0) out[id] = Math.floor(qty);
  }
  return out;
}

function normaliseView(raw: Partial<CollectionView> | undefined): CollectionView {
  const cards = normaliseCards(raw?.cards);
  const total = Object.values(cards).reduce((a, b) => a + b, 0);
  const syncedAt = typeof raw?.syncedAt === 'string' ? raw.syncedAt : null;
  return {
    cards,
    distinct: typeof raw?.distinct === 'number' ? raw.distinct : Object.keys(cards).length,
    total: typeof raw?.total === 'number' ? raw.total : total,
    // Fall back to the pre-`synced` contract: a timestamp proved a snapshot
    // existed, its absence proved nothing. Erring towards "prompt a sync" is
    // the safe direction — the unsafe one is claiming an empty collection.
    synced: typeof raw?.synced === 'boolean' ? raw.synced : syncedAt !== null,
    syncedAt,
    syncedBlock: typeof raw?.syncedBlock === 'number' ? raw.syncedBlock : null,
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * `GET /wager/collection` — the caller's own owned cards, from the stored
 * chain snapshot. Cheap: it reads the projection, it does not touch the chain.
 *
 * Rate limited to the wager service's shared budget (30/min per profile).
 */
export async function getMine(signal?: AbortSignal): Promise<CollectionView> {
  return normaliseView(await get<CollectionView>('/wager/collection', { signal }));
}

/**
 * `POST /wager/collection/sync` — re-derive the snapshot from CardPack chain
 * state and replace it. This is the only thing that makes a fresh mint visible.
 *
 * ─── RATE LIMITED HARD: 6 CALLS PER 5 MINUTES, PER PROFILE ──────────────────
 * Each call is a chain log scan plus an `ownerOf` per token against a public
 * endpoint this project does not operate, so the budget is a tenth of the read
 * route's and is not env-tunable. NEVER poll this in a tight loop — back off
 * between attempts and give up rather than burning the budget.
 *
 * `retryOn429` is left off (POST's default) deliberately: the automatic 429
 * replay in `http.ts` would spend the same scarce budget.
 *
 * Errors, all fail-closed BEFORE anything is written:
 *   503 `card_pack_unconfigured`        no CardPack contract on this deployment
 *   503 `card_index_out_of_sync`        manifest disagrees with `cardCount()`
 *   503 `card_chain_mismatch`           RPC answered for the wrong chain
 *   503 `card_chain_unavailable` / `card_chain_error` / `card_chain_unreachable`
 *   503 `card_enumeration_unavailable`  holdings scan hit its token ceiling
 */
export async function sync(signal?: AbortSignal): Promise<SyncResult> {
  // The route validates an EMPTY strict body, so send `{}` rather than nothing.
  const raw = await post<SyncResult>('/wager/collection/sync', {}, { signal });
  const view = normaliseView(raw);
  return {
    ...view,
    blockNumber: typeof raw?.blockNumber === 'number' ? raw.blockNumber : 0,
    transferredAway: typeof raw?.transferredAway === 'number' ? raw.transferredAway : 0,
    removed: typeof raw?.removed === 'number' ? raw.removed : 0,
  };
}

// ── Error type-guards ───────────────────────────────────────────────────────

/**
 * Every `details.reason` the sync path can fail with. All of them are 503 and
 * all of them mean "the chain could not be read right now", not "you own
 * nothing" — so a caller must keep showing the last known collection.
 */
const SYNC_UNAVAILABLE_REASONS = new Set([
  'card_pack_unconfigured',
  'card_index_out_of_sync',
  'card_chain_mismatch',
  'card_chain_unavailable',
  'card_chain_error',
  'card_chain_unreachable',
  'card_enumeration_unavailable',
]);

/**
 * The chain could not be read, so the snapshot was left untouched.
 *
 * Retrying may work for the transient ones, but never immediately — see the
 * rate limit on `sync()`.
 */
export function isSyncUnavailable(err: unknown): err is ApiError {
  return err instanceof ApiError && err.reason !== null && SYNC_UNAVAILABLE_REASONS.has(err.reason);
}

/** This deployment has no CardPack contract configured; syncing cannot work. */
export function isSyncUnconfigured(err: unknown): err is ApiError {
  return err instanceof ApiError && err.reason === 'card_pack_unconfigured';
}

/**
 * One card the seating check refused, from `details.issues`.
 *
 * `ApiError.issues` deliberately keeps only `{path, message, code}`, so the
 * numeric fields have to be read off `details` directly — that is what
 * `unownedIssues()` below does.
 */
export interface UnownedCardIssue extends ApiIssue {
  code?: 'unowned' | (string & {});
  /** The offending card id, e.g. `eth_pepe`. */
  cardId: string;
  /** Copies the decklist runs. */
  need: number;
  /** Copies `core.card_ownership` says the profile holds. */
  owned: number;
}

/**
 * `400 { reason: 'unowned_cards' }` — YOUR active deck contains cards you do
 * not own, by quantity. Raised by `POST /games/create` and `POST /games/:id/
 * join` for ranked and wager only; casual is deliberately ungated.
 */
export function isUnownedCardsError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.reason === 'unowned_cards';
}

/** Per-card detail for an `unowned_cards` rejection, or `[]`. */
export function unownedIssues(err: unknown): UnownedCardIssue[] {
  if (!isUnownedCardsError(err)) return [];
  const raw = err.details.issues;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const o = entry as Record<string, unknown>;
    if (typeof o.cardId !== 'string') return [];
    const issue: UnownedCardIssue = {
      cardId: o.cardId,
      need: typeof o.need === 'number' ? o.need : 0,
      owned: typeof o.owned === 'number' ? o.owned : 0,
      message: typeof o.message === 'string' ? o.message : `You do not own enough copies of ${o.cardId}.`,
    };
    if (typeof o.code === 'string') issue.code = o.code;
    return [issue];
  });
}

/**
 * `409 { reason: 'host_deck_unowned' }` — the HOST's deck failed re-validation
 * at join time.
 *
 * It carries no `issues` and never will: naming the host's cards to the joiner
 * would leak a decklist across the table (audit finding H-7). There is nothing
 * for the joining player to fix, so the only correct response is "that match
 * can't be started, pick another" plus a lobby refresh.
 */
export function isHostDeckUnownedError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.reason === 'host_deck_unowned';
}
