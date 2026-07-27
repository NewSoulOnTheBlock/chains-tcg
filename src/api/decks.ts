// src/api/decks.ts
//
// Deck CRUD plus activation. All routes require a token.
//
// ─── THE TWO-TIER LEGALITY RULE ─────────────────────────────────────────────
//
//   create / update  →  card ids and copy limits ONLY (work-in-progress decks
//                       are savable at any size)
//   activate         →  FULL 60-card legality, enforced here and ONLY here
//
// So a deck can save cleanly and still fail to activate. `activate()` re-reads
// the STORED deck, which also means it can fail on a deck you did not just
// edit. Always surface `DeckLegalityError.issues` rather than a generic
// "invalid deck" message — the server tells you exactly what is wrong.
//
// The active deck matters because the GAME service seats you with it:
// `POST /games/create` and `POST /games/:id/join` both fail with
// `details.reason === 'no_active_deck'` if you have not activated one.
//
// ─── CARD IDS ───────────────────────────────────────────────────────────────
// `cards` is a FLAT array of card id strings WITH REPETITION — not
// `[{id, count}]`. A 60-card deck is a 60-element array. The server validates
// against a vendored copy of this repo's own `src/cards.ts`, so the ids are
// exactly the ones the client already knows.
//
//   node_* cards are unlimited; every other card is capped at 4 copies.

import { del, get, post, put } from './http.js';
import { ApiError, type ApiIssue } from './errors.js';

/** Exactly 60 cards in a legal deck. Mirrors the server's `DECK_SIZE`. */
export const DECK_SIZE = 60;
/** Copy limit for anything that is not a `node_*` card. */
export const MAX_COPIES_NONBASIC = 4;

export interface Deck {
  /** bigint-safe decimal string. Never `parseInt` it. */
  id: string;
  name: string;
  /** Flat array of card ids, with repetition. */
  cards: string[];
  /** Exactly one deck per profile is active. */
  isActive: boolean;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt: string;
}

/**
 * One legality problem. `code` is one of exactly three values:
 *
 *   'size'    the deck is not exactly 60 cards (activate only)
 *   'unknown' an unrecognised card id — ONE ISSUE PER OCCURRENCE, so a bad id
 *             repeated four times yields four identical issues
 *   'copies'  more than 4 copies of a non-`node_*` card; the message uses the
 *             card's DISPLAY NAME (e.g. "PEPE"), not its id
 *
 * There is no `cardId` or `count` field — only `code` and `message`. Show
 * `message` directly; it is written for players.
 */
export interface DeckIssue extends ApiIssue {
  code?: 'size' | 'unknown' | 'copies' | (string & {});
}

/**
 * Type guard for a legality failure, as opposed to any other 400.
 *
 * Necessary because body-validation failures ALSO arrive as
 * `code: 'bad_request'` with a `details.issues` array — but a different issue
 * shape (`{path, message, code}` vs `{code, message}`). The discriminator is
 * `details.reason === 'invalid_deck'`.
 *
 *   catch (e) {
 *     if (isDeckLegalityError(e)) setDeckErrors(deckIssues(e));
 *   }
 */
export function isDeckLegalityError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.reason === 'invalid_deck';
}

/** Per-issue legality problems, or `[]` if this was not a legality failure. */
export function deckIssues(err: unknown): DeckIssue[] {
  return isDeckLegalityError(err) ? (err.issues as DeckIssue[]) : [];
}

/** Card count the server saw, for a legality failure. `null` otherwise. */
export function deckIssueSize(err: unknown): number | null {
  if (!isDeckLegalityError(err)) return null;
  const size = err.details.size;
  return typeof size === 'number' ? size : null;
}

/** `GET /api/decks` — the caller's decks, oldest first. */
export async function list(signal?: AbortSignal): Promise<Deck[]> {
  const { decks } = await get<{ decks: Deck[] }>('/api/decks', { signal });
  return decks;
}

/** The caller's active deck, or `null`. Convenience over `list()`. */
export async function getActive(signal?: AbortSignal): Promise<Deck | null> {
  const decks = await list(signal);
  return decks.find((d) => d.isActive) ?? null;
}

/**
 * `POST /api/decks` — 201.
 *
 * Validates card ids and copy limits but NOT size, so a partial deck saves
 * fine. The first deck a profile creates is automatically active.
 *
 * Errors: 409 + `reason: 'deck_name_taken'`; 400 + `reason: 'invalid_deck'`.
 * Rate limited to 30/min per profile (shared across all deck writes).
 */
export async function create(
  body: { name: string; cards: string[] },
  signal?: AbortSignal,
): Promise<Deck> {
  const { deck } = await post<{ deck: Deck }>('/api/decks', body, { signal });
  return deck;
}

/**
 * `PUT /api/decks/:id` — rename, replace cards, or both. At least one of
 * `name` / `cards` is required.
 *
 * Ownership is the `WHERE` clause, so editing someone else's deck is a 404
 * (never a 403) — the server does not confirm that the row exists.
 */
export async function update(
  id: string,
  body: { name?: string; cards?: string[] },
  signal?: AbortSignal,
): Promise<Deck> {
  const { deck } = await put<{ deck: Deck }>(`/api/decks/${encodeURIComponent(id)}`, body, { signal });
  return deck;
}

/**
 * `DELETE /api/decks/:id`.
 *
 * Deleting the active deck auto-promotes the oldest survivor, so the caller
 * may still have an active deck afterwards — re-read `list()` rather than
 * assuming. Missing or not-yours is a 404.
 *
 * ─── KNOWN SERVER BUG: A DECK THAT HAS BEEN PLAYED CANNOT BE DELETED ───────
 * Verified against production. Once a deck has been seated into a match (i.e.
 * it was active when you called `lobby.create()` or `lobby.join()`), deleting
 * it fails with:
 *
 *     400 { "error": { "code": "bad_request",
 *                      "message": "Referenced resource does not exist" } }
 *
 * That is a raw Postgres foreign-key violation (23503) from `game.matches`
 * leaking through the shared error mapper. Note it carries NO
 * `details.reason`, so it cannot be told apart from other 400s by reason —
 * use `isUndeletableDeckError()` below, which matches on the shape.
 *
 * Cancelling the match does not release the reference. Until the server grows
 * a soft-delete or an `ON DELETE SET NULL`, the deck builder should either
 * offer "rename/replace cards" instead of delete for played decks, or catch
 * this and explain that decks used in a match are retained for match history.
 */
export async function remove(id: string, signal?: AbortSignal): Promise<void> {
  await del<{ ok: true }>(`/api/decks/${encodeURIComponent(id)}`, { signal });
}

/**
 * The deck could not be deleted because a match still references it.
 * See the `remove()` doc comment — this is a server-side limitation, not
 * something the caller can fix by retrying.
 */
export function isUndeletableDeckError(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.status === 400 &&
    err.reason === null &&
    /Referenced resource does not exist/i.test(err.message)
  );
}

/**
 * `POST /api/decks/:id/activate` — THE ONLY ROUTE THAT ENFORCES FULL 60-CARD
 * LEGALITY. Sets this deck active and clears the flag on the others.
 *
 * On failure the server returns 400 with structured per-issue detail. Feed it
 * straight to the deck builder:
 *
 *   try {
 *     await decks.activate(id);
 *   } catch (e) {
 *     if (isDeckLegalityError(e)) {
 *       showIssues(deckIssues(e));        // [{code:'size', message:'Deck must be exactly 60 cards (currently 58).'}]
 *     } else throw e;
 *   }
 *
 * Takes no body; anything sent is ignored.
 */
export async function activate(id: string, signal?: AbortSignal): Promise<Deck> {
  const { deck } = await post<{ deck: Deck }>(
    `/api/decks/${encodeURIComponent(id)}/activate`,
    undefined,
    { signal },
  );
  return deck;
}

/**
 * Client-side pre-check mirroring the server's rules, so the deck builder can
 * disable the Activate button without a round trip.
 *
 * The SERVER is authoritative — always handle a 400 from `activate()` anyway.
 * This exists to save a request, not to replace the check.
 */
export function checkLegality(
  cards: string[],
  opts: { requireSize?: boolean } = {},
): { ok: boolean; size: number; issues: DeckIssue[] } {
  const requireSize = opts.requireSize ?? true;
  const issues: DeckIssue[] = [];
  const size = cards.length;
  if (requireSize && size !== DECK_SIZE) {
    issues.push({ code: 'size', message: `Deck must be exactly ${DECK_SIZE} cards (currently ${size}).` });
  }
  const counts = new Map<string, number>();
  for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (!id.startsWith('node_') && n > MAX_COPIES_NONBASIC) {
      issues.push({ code: 'copies', message: `Too many copies of ${id} (${n}/${MAX_COPIES_NONBASIC}).` });
    }
  }
  return { ok: issues.length === 0, size, issues };
}
