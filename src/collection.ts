// src/collection.ts
// Player card ownership — THE SERVER IS AUTHORITATIVE.
//
// ─── WHAT CHANGED, AND WHY ──────────────────────────────────────────────────
// This module used to BE the ownership ledger: it seeded 20 of each Node into
// `localStorage["ocva.collection.<name>"]`, added cards on every booster mint,
// and answered every ownership question from that one editable object. Any
// player with devtools could grant themselves the whole catalogue. With a 1 ETH
// ranked prize that is the highest-payoff attack in the product.
//
// Ownership now lives on the server, derived from real CardPack (ERC-721)
// holdings on Robinhood Chain, and the game service refuses ranked and wager
// seating for a deck containing cards the profile does not own. See
// `src/api/collection.ts` for the wire contract.
//
// What is left here is a CACHE and a MODEL, in that order:
//
//   • the server snapshot is the truth;
//   • localStorage keeps the last snapshot so the UI paints instantly on load
//     and survives a brief API failure — it is never an input to a decision,
//     and it is keyed by WALLET ADDRESS, not by display name (which is mutable
//     and used to orphan a player's whole collection on rename);
//   • Basic Nodes are synthesised locally, because they do not exist on chain.
//
// ─── BASIC NODES ARE FREE AND EXEMPT ────────────────────────────────────────
// The on-chain card index is the 80 NON-Node cards, and the seating check skips
// `node_*` ids outright (`services/game/src/lib/seating.ts`). So the server
// never reports a Node and never complains about one. `STARTING_NODES` below is
// a client-side fiction that matches the server's behaviour: unlimited Nodes,
// displayed as a fixed grant. `deckCap` returns Infinity for them, exactly as
// the format rules do.
//
// ─── "NEVER SYNCED" IS NOT "OWNS NOTHING" ───────────────────────────────────
// An empty `cards` map means one of two completely different things, and
// getting it backwards means telling a paying customer their cards are gone.
// The server distinguishes them with `synced` — the existence of the profile's
// `core.card_ownership_sync` row, written on every successful sync whether or
// not it found anything:
//
//   synced: false  →  UNKNOWN. Prompt a scan; answer no ownership questions.
//   synced: true   →  authoritative, including "you genuinely own nothing".
//
// `ownershipKnown()` is that bit. While it is false, `ownershipIssues` returns
// nothing and `deckCap` falls back to the format limit — the builder must not
// invent an ownership failure out of an answer nobody has looked up.
//
// ─── SIGNED OUT / OFFLINE ───────────────────────────────────────────────────
// Solo play is entirely client-side (`Local()` transport, no server). Signed
// out there is no identity to check ownership against, so ownership is simply
// not enforced: every card is available and `ownershipIssues` returns nothing.
// That matches the server, which only gates ranked and wager.

import { useSyncExternalStore } from 'react';
import {
  COLORS, CARDS, validateDeck, isBasicNode, MAX_COPIES_NONBASIC,
  type DeckIssue, type DeckValidation,
} from './cards';
import {
  collection as collectionApi, ApiError, getSession, isSignedIn, onSessionChange,
  type SyncResult,
} from './api';
import { errorText } from './error-text';

/** Free Nodes every collection is treated as holding — 20 of each chain. */
export const STARTING_NODES = 20;

export type Collection = Record<string, number>;

/** Where the counts currently on screen came from. */
export type CollectionSource =
  /** No session: local grant only, ownership is not enforced. */
  | 'signed-out'
  /** The server has not answered yet; this is the last snapshot we stored. */
  | 'cache'
  /** Straight from `GET /wager/collection` or a chain sync. */
  | 'server';

export interface CollectionState {
  /**
   * Counts to DISPLAY: the server snapshot, plus the implicit Node grant, plus
   * any cards from a pack that the chain indexer has not caught up with yet.
   *
   * Do not make ownership decisions from this — use `ownedCount` / `deckCap` /
   * `ownershipIssues`, which read the confirmed snapshot only.
   */
  cards: Collection;
  source: CollectionSource;
  /** ISO-8601 of the last successful sync. `null` exactly when `needsSync`. */
  syncedAt: string | null;
  /**
   * Head block the snapshot is true as of. `null` exactly when `needsSync`.
   *
   * Worth showing next to the timestamp: it is the chain's own clock, so it
   * means something when a player is arguing with a lagging RPC endpoint.
   */
  syncedBlock: number | null;
  /**
   * `true` when we have no confirmed snapshot for this player, so an empty
   * collection means "we have not looked", NOT "you own nothing". Prompt a
   * sync; never claim the player's cards are gone.
   */
  needsSync: boolean;
  /** A read or a chain sync is in flight. */
  loading: boolean;
  /** Player-facing text for the last failure, or `null`. */
  error: string | null;
  /** Non-Node cards the server confirms, counting duplicates. */
  total: number;
  /** Distinct non-Node cards the server confirms. */
  distinct: number;
  /** Cards from a just-opened pack the server has not indexed yet. */
  pendingCount: number;
}

// ── Storage ─────────────────────────────────────────────────────────────────
//
// Display cache only. Keyed by wallet address because the display name is
// mutable (`PATCH /api/profiles/me`) and renaming used to silently orphan the
// whole collection.

const CACHE_PREFIX = 'ocva.collection.v2.';
const LOCAL_KEY = 'ocva.collection.local';

interface CachedSnapshot {
  cards: Collection;
  syncedAt: string | null;
  syncedBlock: number | null;
  /** `true` once a sync has confirmed this snapshot, even if it is empty. */
  confirmed: boolean;
  /** When we wrote it, epoch ms. */
  at: number;
}

function readLS(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLS(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
}

function safeIsSignedIn(): boolean {
  try { return isSignedIn(); } catch { return false; }
}

function currentAddress(): string | null {
  try { return getSession()?.address?.toLowerCase() ?? null; } catch { return null; }
}

function cacheKey(): string {
  const address = currentAddress();
  return address ? `${CACHE_PREFIX}${address}` : LOCAL_KEY;
}

function readCache(): CachedSnapshot | null {
  const raw = readLS(cacheKey());
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedSnapshot>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.cards !== 'object' || !parsed.cards) return null;
    return {
      cards: sanitise(parsed.cards as Collection),
      syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : null,
      syncedBlock: typeof parsed.syncedBlock === 'number' ? parsed.syncedBlock : null,
      confirmed: parsed.confirmed === true,
      at: typeof parsed.at === 'number' ? parsed.at : 0,
    };
  } catch {
    return null;
  }
}

function writeCache(snapshot: CachedSnapshot): void {
  writeLS(cacheKey(), JSON.stringify(snapshot));
}

/** Drop anything that is not a positive integer count, and drop Node ids. */
function sanitise(cards: Collection): Collection {
  const out: Collection = {};
  for (const [id, qty] of Object.entries(cards)) {
    if (isBasicNode(id)) continue; // synthesised, never stored
    if (typeof qty === 'number' && Number.isFinite(qty) && qty > 0) out[id] = Math.floor(qty);
  }
  return out;
}

// ── Node grant ──────────────────────────────────────────────────────────────

/** Merge the implicit Basic Node grant into a set of non-Node counts. */
function withNodes(base: Collection): Collection {
  const out: Collection = { ...base };
  for (const color of COLORS) {
    const id = `node_${color}`;
    if ((out[id] ?? 0) < STARTING_NODES) out[id] = STARTING_NODES;
  }
  return out;
}

function tally(ids: readonly string[]): Collection {
  const out: Collection = {};
  for (const id of ids) out[id] = (out[id] ?? 0) + 1;
  return out;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * Optimistic overlay for a pack that has confirmed on chain but which the
 * server has not indexed yet.
 *
 * `base` is the confirmed count at the moment of the mint, so the overlay
 * shrinks to nothing on its own as the server catches up:
 *
 *     pending(id) = clamp(base(id) + minted(id) - confirmed(id), 0, minted(id))
 *
 * It expires regardless after `PENDING_TTL_MS` so a permanently-stuck indexer
 * cannot leave the UI claiming cards forever. It is display-only and is never
 * consulted by `ownedCount`, `deckCap` or `ownershipIssues`.
 */
interface PendingMint {
  minted: Collection;
  base: Collection;
  at: number;
}
const PENDING_TTL_MS = 5 * 60_000;

/** Confirmed, server-side, non-Node counts. The ONLY ownership input. */
let confirmed: Collection = {};
/** The server's `synced` bit: has a chain sync ever completed for this player? */
let snapshotConfirmed = false;
/** Display metadata for the confirmed snapshot. Both null iff never synced. */
let snapshotAt: string | null = null;
let snapshotBlock: number | null = null;
let pendingMint: PendingMint | null = null;

let state: CollectionState = buildState('signed-out', false, null);
const listeners = new Set<() => void>();

function derivePending(): Collection {
  if (!pendingMint) return {};
  if (Date.now() - pendingMint.at > PENDING_TTL_MS) { pendingMint = null; return {}; }
  const out: Collection = {};
  for (const [id, minted] of Object.entries(pendingMint.minted)) {
    const base = pendingMint.base[id] ?? 0;
    const missing = base + minted - (confirmed[id] ?? 0);
    if (missing > 0) out[id] = Math.min(missing, minted);
  }
  return out;
}

function buildState(
  source: CollectionSource,
  loading: boolean,
  error: string | null,
): CollectionState {
  const pending = derivePending();
  const display: Collection = { ...confirmed };
  for (const [id, n] of Object.entries(pending)) display[id] = (display[id] ?? 0) + n;
  const total = Object.values(confirmed).reduce((a, b) => a + b, 0);
  return {
    cards: withNodes(display),
    source,
    syncedAt: snapshotAt,
    syncedBlock: snapshotBlock,
    needsSync: source !== 'signed-out' && !snapshotConfirmed,
    loading,
    error,
    total,
    distinct: Object.keys(confirmed).length,
    pendingCount: Object.values(pending).reduce((a, b) => a + b, 0),
  };
}

function commit(next: CollectionState): void {
  state = next;
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* a bad subscriber must not break ownership */ }
  }
}

/** Re-read the identity and rebuild from cache. Called on sign-in/sign-out. */
function resetForIdentity(): void {
  pendingMint = null;
  if (!safeIsSignedIn()) {
    confirmed = {};
    snapshotConfirmed = false;
    snapshotAt = null;
    snapshotBlock = null;
    commit(buildState('signed-out', false, null));
    return;
  }
  const cached = readCache();
  confirmed = cached ? cached.cards : {};
  snapshotConfirmed = cached?.confirmed ?? false;
  snapshotAt = cached?.syncedAt ?? null;
  snapshotBlock = cached?.syncedBlock ?? null;
  commit(buildState('cache', false, null));
}

/**
 * Hydrate from the display cache on first read.
 *
 * Deferred rather than done at import so that merely importing this module in a
 * test or a script touches no storage, and so the very first render already
 * sees the cached collection instead of an empty flash.
 */
let hydrated = false;
function ensureHydrated(): void {
  if (hydrated) return;
  hydrated = true;
  resetForIdentity();
}

/**
 * Adopt a server snapshot as the truth.
 *
 * Exported because `refreshCollection` / `syncCollection` are the only real
 * callers and the unit tests need a way in that does not involve the network.
 * Nothing in the UI should call it.
 */
export function applyServerSnapshot(
  view: { cards: Collection; synced?: boolean; syncedAt: string | null; syncedBlock?: number | null },
  opts: { confirmedBySync?: boolean } = {},
): void {
  confirmed = sanitise(view.cards);
  // `synced` is the server's own answer to "have we ever looked?". The other
  // two terms are fallbacks: `syncedAt` for a deployment predating the field,
  // and `confirmedBySync` for a sync we just performed ourselves — which is
  // proof even if the response somehow says otherwise.
  snapshotConfirmed = view.synced === true || view.syncedAt !== null || opts.confirmedBySync === true;
  snapshotAt = view.syncedAt;
  snapshotBlock = typeof view.syncedBlock === 'number' ? view.syncedBlock : null;
  if (safeIsSignedIn()) {
    writeCache({
      cards: confirmed, syncedAt: snapshotAt, syncedBlock: snapshotBlock,
      confirmed: snapshotConfirmed, at: Date.now(),
    });
  }
  commit(buildState('server', false, null));
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** The current snapshot. Synchronous; never throws. */
export function getCollectionState(): CollectionState {
  ensureHydrated();
  return state;
}

/**
 * Owned counts INCLUDING the implicit Node grant and any un-indexed pack.
 *
 * Display only — the server decides who owns what. Kept synchronous (and with
 * the same name) so screens that only render numbers did not have to change.
 */
export function getCollection(): Collection {
  return getCollectionState().cards;
}

/**
 * Subscribe to ownership changes. Fires immediately with the current value,
 * mirroring `session.onSessionChange`. Returns an unsubscribe function.
 */
export function subscribeCollection(fn: () => void): () => void {
  ensureWired();
  listeners.add(fn);
  fn();
  return () => { listeners.delete(fn); };
}

/** React binding over the same store. */
export function useCollection(): CollectionState {
  return useSyncExternalStore(
    (onChange) => { ensureWired(); listeners.add(onChange); return () => { listeners.delete(onChange); }; },
    getCollectionState,
    getCollectionState,
  );
}

/**
 * `true` when we hold a confirmed snapshot and may therefore answer ownership
 * questions. `false` when signed out (nothing to enforce) or never synced
 * (we do not know, and guessing means telling a paying customer their cards
 * are gone).
 */
export function ownershipKnown(): boolean {
  ensureHydrated();
  return snapshotConfirmed;
}

/**
 * How many copies of a card the player owns, per the SERVER.
 *
 * Basic Nodes are unlimited and answer `STARTING_NODES` for display. Returns 0
 * for everything else when ownership is not known — callers must gate on
 * `ownershipKnown()` before reading anything into that.
 */
export function ownedCount(id: string): number {
  if (isBasicNode(id)) return STARTING_NODES;
  return confirmed[id] ?? 0;
}

/**
 * The most copies of a card that may go in a deck.
 *
 * Basic Nodes are Infinity — that is the format rule AND the server's, which
 * skips `node_*` entirely in the ownership check. Everything else is capped by
 * the format's 4 and, once we know it, by what the player actually owns.
 */
export function deckCap(id: string): number {
  if (isBasicNode(id)) return Infinity;
  if (!ownershipKnown()) return MAX_COPIES_NONBASIC;
  return Math.min(ownedCount(id), MAX_COPIES_NONBASIC);
}

/**
 * Ownership-only problems with a decklist, mirroring the server's seating
 * check. Does NOT include size / copy-limit checks — `validateDeck` does those.
 *
 * Returns `[]` when ownership is not known, because "we have not looked" must
 * never render as "you own none of this".
 *
 * ─── THIS IS AN ADVISORY, NOT A GATE ────────────────────────────────────────
 * The server only enforces ownership for RANKED and WAGER; casual and solo are
 * deliberately ungated so a new player can build and play any deck for free.
 * Show these; do not use them to disable the deck builder.
 */
export function ownershipIssues(cards: string[]): DeckIssue[] {
  if (!ownershipKnown()) return [];
  const counts = tally(cards);
  const issues: DeckIssue[] = [];
  for (const id of Object.keys(counts).sort()) {
    if (isBasicNode(id)) continue; // exempt server-side; never flag one
    const need = counts[id];
    const owned = ownedCount(id);
    if (need <= owned) continue;
    const name = CARDS[id]?.name ?? id;
    issues.push({
      code: 'owned',
      message: owned === 0
        ? `You do not own ${name} — open a booster pack to unlock it.`
        : `Your deck runs ${need} × ${name} but you own ${owned}.`,
    });
  }
  return issues;
}

/** Full deck validation including ownership (size + copy caps + owned). */
export function validateOwnedDeck(cards: string[]): DeckValidation {
  const base = validateDeck(cards);
  const owned = ownershipIssues(cards);
  return { ok: base.ok && owned.length === 0, size: base.size, issues: [...base.issues, ...owned] };
}

// ── Writes ──────────────────────────────────────────────────────────────────

let inFlight: Promise<void> | null = null;

/**
 * `GET /wager/collection` — refresh the snapshot from the server.
 *
 * Cheap (no chain access), so it is safe on sign-in, on window focus and after
 * a mint. Concurrent calls share one request. A failure leaves the cached
 * snapshot on screen and records `error`; it never empties the collection.
 */
export function refreshCollection(): Promise<void> {
  if (inFlight) return inFlight;
  ensureHydrated();
  if (!safeIsSignedIn()) { resetForIdentity(); return Promise.resolve(); }

  commit(buildState(state.source, true, null));
  inFlight = (async () => {
    try {
      const view = await collectionApi.getMine();
      applyServerSnapshot(view);
    } catch (err) {
      // A 401 has already cleared the session and fired `onSessionChange`;
      // the identity reset will land on its own. Anything else: keep showing
      // what we had. An unreachable API is not evidence of an empty wallet.
      if (err instanceof ApiError && err.isAuthError) return;
      commit(buildState(state.source === 'server' ? 'server' : 'cache', false, describe(err)));
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * `POST /wager/collection/sync` — rescan the chain and reconcile.
 *
 * RATE LIMITED to 6 calls per 5 minutes per profile. This is the only thing
 * that makes a fresh mint (or a sold card) visible, so it is offered as an
 * explicit button and used with backoff after a pack — never polled.
 *
 * Resolves to the reconcile summary, or `null` if the sync could not run. A
 * failure never clears the collection.
 */
export async function syncCollection(): Promise<SyncResult | null> {
  if (!safeIsSignedIn()) return null;
  ensureHydrated();
  commit(buildState(state.source, true, null));
  try {
    const result = await collectionApi.sync();
    // The response already carries `synced: true`. Asserting it here as well
    // means a sync that came back with zero cards still reads as "confirmed
    // empty" rather than "never looked", even against an older service that
    // has no `synced` field at all.
    applyServerSnapshot(result, { confirmedBySync: true });
    return result;
  } catch (err) {
    if (err instanceof ApiError && err.isAuthError) return null;
    commit(buildState(state.source, false, describe(err)));
    return null;
  }
}

/**
 * Show cards from a just-minted pack immediately, before the server has seen
 * them. Display only — see `PendingMint`.
 */
export function applyOptimisticGrant(cardIds: string[]): void {
  if (cardIds.length === 0) return;
  const minted = tally(cardIds.filter((id) => !isBasicNode(id)));
  const previous = pendingMint && Date.now() - pendingMint.at <= PENDING_TTL_MS ? pendingMint : null;
  const base: Collection = { ...confirmed };
  if (previous) {
    // A second pack before the first was indexed: keep both.
    for (const [id, n] of Object.entries(previous.minted)) minted[id] = (minted[id] ?? 0) + n;
    for (const [id, n] of Object.entries(previous.base)) base[id] = Math.min(base[id] ?? n, n);
  }
  pendingMint = { minted, base, at: Date.now() };
  commit(buildState(state.source, state.loading, state.error));
}

/**
 * Backoff schedule for the post-mint sync, in ms since the receipt.
 *
 * Chain indexing lags the receipt slightly, so the first attempt can legitimately
 * come back without the new tokens. Three attempts over ~20s costs half the
 * 6-per-5-minutes budget and leaves room for the player to press Sync by hand.
 * NEVER turn this into a tight loop.
 */
const MINT_SYNC_BACKOFF_MS = [1_500, 6_000, 15_000];

/**
 * Make a freshly minted pack real, server-side.
 *
 * The mint is a genuine on-chain transaction, so the server can see it — the
 * client no longer grants itself anything. Call this AFTER the receipt is
 * confirmed (i.e. after `mintPack` resolves).
 *
 * The cards are shown optimistically straight away and stay on screen until a
 * sync accounts for them, so a lagging indexer looks like a short delay rather
 * than a pack that vanished. Gives up quietly after the last attempt; the
 * player can press Sync in the Collection tab, and the next natural refresh
 * will pick the cards up anyway.
 */
export async function syncAfterMint(cardIds: string[]): Promise<void> {
  applyOptimisticGrant(cardIds);
  if (!safeIsSignedIn()) return;

  for (const wait of MINT_SYNC_BACKOFF_MS) {
    await sleep(wait);
    const result = await syncCollection();
    // Rate limited, chain unreachable, or signed out — stop. Retrying spends a
    // budget we do not have, and the optimistic overlay is already on screen.
    if (result === null) return;
    if (state.pendingCount === 0) return; // the server accounted for the pack
  }
}

/** Player-facing text for a failure, with collection-specific reassurance. */
function describe(err: unknown): string {
  if (err instanceof ApiError) {
    // Both of these leave the stored snapshot untouched, so say so — an
    // unreachable API is not evidence of an empty wallet.
    if (err.isNetworkError) return 'Could not reach the server — showing your last known collection.';
    if (collectionApi.isSyncUnavailable(err) && !collectionApi.isSyncUnconfigured(err)) {
      return 'The card chain could not be read just now. Your collection is unchanged — try again shortly.';
    }
  }
  return errorText(err);
}

// ── Wiring ──────────────────────────────────────────────────────────────────
//
// Installed on first subscribe rather than at import, so importing this module
// in a test (or a script) does not attach listeners to a DOM that is not there.

let wired = false;
let lastAutoRefresh = 0;
/** Focus fires a lot. One automatic read per 30s is plenty. */
const AUTO_REFRESH_MIN_MS = 30_000;

function ensureWired(): void {
  if (wired) return;
  wired = true;

  try {
    onSessionChange(() => {
      resetForIdentity();
      if (safeIsSignedIn()) { lastAutoRefresh = Date.now(); void refreshCollection(); }
    });
  } catch { /* no session layer (non-browser) */ }

  try {
    window.addEventListener('focus', () => {
      if (!safeIsSignedIn()) return;
      if (Date.now() - lastAutoRefresh < AUTO_REFRESH_MIN_MS) return;
      lastAutoRefresh = Date.now();
      void refreshCollection();
    });
  } catch { /* non-browser */ }
}

/** Test seam: forget everything, as if the module had just been imported. */
export function __resetCollectionForTests(): void {
  confirmed = {};
  snapshotConfirmed = false;
  snapshotAt = null;
  snapshotBlock = null;
  pendingMint = null;
  inFlight = null;
  hydrated = true; // do not touch storage from a test
  state = buildState('signed-out', false, null);
}
