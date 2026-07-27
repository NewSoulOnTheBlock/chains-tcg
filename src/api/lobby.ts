// src/api/lobby.ts
//
// Matchmaking. All routes require a token.
//
// ─── THREE THINGS THAT WILL BITE YOU ────────────────────────────────────────
//
// 1. DO NOT SEND A DECK. Neither `create()` nor `join()` takes one. The server
//    attaches the caller's ACTIVE deck from `core.decks` server-side, which is
//    the whole point — a client that names its own decklist can name a better
//    one. The request bodies are strict objects; a stray `deck` key is a 400.
//
// 2. NO ACTIVE DECK ⇒ create/join FAIL. Both return 400 with
//    `details.reason === 'no_active_deck'`. Use `isNoActiveDeckError()` below
//    to route the player to the deck screen instead of showing a raw error.
//    The sibling `'invalid_active_deck'` means they HAVE an active deck but it
//    is no longer legal (the catalogue changed under them) — same destination,
//    different message, and its `details.issues` says what is wrong.
//
// 3. A NON-PARTICIPANT GETS 404 FROM `getSeat`, NOT 403. The server refuses to
//    confirm that a match exists to someone not in it. Do not render "you are
//    not allowed" on a 404 here; render "match not found".
//
// ─── boardgame.io ───────────────────────────────────────────────────────────
// boardgame.io's own lobby REST API is NOT MOUNTED — `Server.run()` is never
// called, so `GET /games/chains-tcg`, `/create`, `/join` and `/playAgain` do
// not exist in the process at all. Delete every `LobbyClient` usage. The only
// boardgame.io surface left is the socket.io transport at `/socket.io/`,
// authenticated with the `credentials` string from `getSeat()`.
//
// ─── THE CLIENT NEVER REPORTS A RESULT ──────────────────────────────────────
// There is no route anywhere that accepts a match result. The game service
// derives outcomes from its own boardgame.io state. Read history from
// `profiles.getMatches()`.

import { get, post } from './http.js';
import { ApiError } from './errors.js';

export type MatchMode = 'casual' | 'ranked' | 'wager';
/** `open` → waiting for an opponent; `live` → playable; then terminal. */
export type MatchStatus = 'open' | 'live' | 'finished' | 'void';
/** Seat index as a NUMBER. boardgame.io's `playerID` is the string form. */
export type Seat = 0 | 1;

/** A row in the lobby or invite list. Deliberately minimal — no decklists, no
 *  `setupData`, no player ids, no credentials. */
export interface LobbyEntry {
  /** Match id (uuid string). Also the boardgame.io `matchID`. */
  matchID: string;
  mode: MatchMode;
  /** Always length 2; index === seat number. */
  seats: Array<{ filled: boolean; displayName: string | null }>;
  /** ISO-8601. */
  createdAt: string;
  /** ABSENT (not null) when the match has no wager. Decimal string, base units. */
  wagerAmount?: string;
}

/** `POST /games/create` — 201. No credentials yet; see `getSeat`. */
export interface CreatedMatch {
  matchID: string;
  mode: MatchMode;
  /** Always `'open'` here. */
  status: MatchStatus;
  /** The creator always takes seat 0. */
  seat: 0;
  createdAt: string;
}

/** `POST /games/:id/join`. The joiner always takes seat 1. */
export interface JoinedMatch {
  matchID: string;
  seat: 1;
  /** boardgame.io player id — the STRING `'1'`, not the number. */
  playerID: '1';
  /** boardgame.io credentials for the socket transport. */
  credentials: string;
}

/**
 * `GET /games/:id/seat`.
 *
 * TWO SHAPES depending on `status`:
 *   status === 'open' → `credentials` is `null` and `playerID` is ABSENT
 *   otherwise         → both are present
 *
 * So poll this after creating a match; you cannot connect the socket until
 * someone joins and the match materialises.
 */
export interface SeatInfo {
  matchID: string;
  /** Your OWN seat. Never the opponent's. */
  seat: Seat;
  status: MatchStatus;
  /** `null` while the match is still `open`. */
  credentials: string | null;
  /** Absent while the match is still `open`. `String(seat)`. */
  playerID?: '0' | '1';
}

export interface CreateOptions {
  /** Defaults to `'casual'` server-side. */
  mode?: MatchMode;
  /** Hide from the public lobby. Forced true when `invitedDisplayName` is set. */
  unlisted?: boolean;
  /** Address the match to one player; they see it via `getInvites()`. */
  invitedDisplayName?: string;
  /**
   * ADVISORY ONLY — a decimal string in token base units, displayed in the
   * lobby. It does NOT create an escrow and does not move money. Open a real
   * escrow with `wager.createEscrow({matchId, tier})`, which names a TIER
   * INDEX, not an amount.
   */
  wagerAmountBase?: string;
}

// ── Error helpers ───────────────────────────────────────────────────────────

/**
 * The caller has no active deck. Send them to the deck screen.
 *
 * This is `400 bad_request` + `details.reason: 'no_active_deck'`; there is no
 * `code: 'no_active_deck'`, so do not match on `code`.
 */
export function isNoActiveDeckError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.reason === 'no_active_deck';
}

/** The caller has an active deck but it is no longer legal. Same destination. */
export function isInvalidActiveDeckError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.reason === 'invalid_active_deck';
}

/** Either deck problem — the single check most call sites want. */
export function isDeckBlockedError(err: unknown): err is ApiError {
  return isNoActiveDeckError(err) || isInvalidActiveDeckError(err);
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * `GET /games/lobby` — open, listed matches.
 *
 * Replaces boardgame.io's `GET /games/chains-tcg`, which no longer exists.
 *
 * @param limit 1–50, defaults to 50 server-side.
 */
export async function getLobby(
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<LobbyEntry[]> {
  const { matches } = await get<{ matches: LobbyEntry[] }>('/games/lobby', {
    query: { limit: options.limit },
    signal: options.signal,
  });
  return matches;
}

/** `GET /games/invites` — matches addressed to the caller by display name. */
export async function getInvites(signal?: AbortSignal): Promise<LobbyEntry[]> {
  const { matches } = await get<{ matches: LobbyEntry[] }>('/games/invites', { signal });
  return matches;
}

/**
 * `POST /games/create` — seats the caller at seat 0.
 *
 * DO NOT SEND A DECK. The server attaches your active deck.
 *
 * Errors: 400 + `reason: 'no_active_deck' | 'invalid_active_deck' |
 * 'self_challenge'`; 404 "Invited player not found"; 409 +
 * `reason: 'too_many_open_matches'` (the cap is 3 — cancel one first).
 *
 * Not retried on 429: creating a second match is a real side effect.
 */
export function create(options: CreateOptions = {}, signal?: AbortSignal): Promise<CreatedMatch> {
  const body: Record<string, unknown> = {};
  // Strict body — only send keys the caller actually set.
  if (options.mode !== undefined) body.mode = options.mode;
  if (options.unlisted !== undefined) body.unlisted = options.unlisted;
  if (options.invitedDisplayName !== undefined) body.invitedDisplayName = options.invitedDisplayName;
  if (options.wagerAmountBase !== undefined) body.wagerAmountBase = options.wagerAmountBase;
  return post<CreatedMatch>('/games/create', body, { signal });
}

/**
 * `POST /games/:id/join` — seats the caller at seat 1 and materialises the
 * boardgame.io match. Returns your credentials directly, so you do not need a
 * follow-up `getSeat()` call.
 *
 * DO NOT SEND A DECK. The body is empty.
 *
 * Errors: 400 + `reason: 'no_active_deck' | 'invalid_active_deck' |
 * 'setup_rejected'`; 404 "Match not found" (ALSO returned for an unlisted
 * match you were not invited to — deliberately indistinguishable); 409 +
 * `reason: 'match_not_open' | 'already_seated' | 'match_incomplete'`.
 */
export function join(matchId: string, signal?: AbortSignal): Promise<JoinedMatch> {
  return post<JoinedMatch>(`/games/${encodeURIComponent(matchId)}/join`, {}, { signal });
}

/**
 * `GET /games/:id/seat` — YOUR seat and YOUR boardgame.io credentials.
 *
 * Poll this after `create()` until `status !== 'open'`, then connect the
 * socket with `{ playerID, credentials }`.
 *
 * A NON-PARTICIPANT GETS 404, NOT 403 — the server will not confirm the match
 * exists to someone not seated in it. Treat 404 as "not found", not as a
 * permissions message.
 */
export function getSeat(matchId: string, signal?: AbortSignal): Promise<SeatInfo> {
  return get<SeatInfo>(`/games/${encodeURIComponent(matchId)}/seat`, { signal });
}

/**
 * `POST /games/:id/cancel` — cancel your own still-open match.
 *
 * 404 "No open match of yours with that id" covers all of: not yours, does not
 * exist, already joined, already cancelled.
 */
export function cancel(matchId: string, signal?: AbortSignal): Promise<{ matchID: string; status: 'void' }> {
  return post<{ matchID: string; status: 'void' }>(
    `/games/${encodeURIComponent(matchId)}/cancel`,
    undefined,
    { signal },
  );
}
