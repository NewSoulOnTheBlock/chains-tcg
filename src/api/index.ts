// src/api/index.ts
//
// Barrel export for the API client layer. See `./README.md` for the auth flow,
// the token lifecycle, and a table mapping the legacy endpoints to these.
//
// Domain modules are exported as NAMESPACES because their function names
// deliberately collide (`decks.list()` vs `lobby.getLobby()`, `auth.getMe()`
// vs `profiles.getMe()` — which really are different endpoints).
//
//   import { auth, decks, lobby, profiles, wager, ApiError } from './api';
//
//   await auth.signIn({ address, chain: 'ethereum' });
//   const deck = await decks.activate(deckId);
//   await lobby.create({ mode: 'casual' });

// ── Namespaces ──────────────────────────────────────────────────────────────
export * as auth from './auth.js';
export * as collection from './collection.js';
export * as decks from './decks.js';
export * as lobby from './lobby.js';
export * as profiles from './profiles.js';
export * as wager from './wager.js';
export * as session from './session.js';

// ── Configuration ───────────────────────────────────────────────────────────
export { API_BASE, RPC_URL, SOCKET_URL, apiUrl } from './config.js';

// ── Errors: the one thing every call site needs ─────────────────────────────
export {
  ApiError,
  SessionExpiredError,
  parseRetryAfter,
  toApiError,
  toNetworkError,
} from './errors.js';
export type { ApiErrorCode, ApiErrorEnvelope, ApiIssue, ApiReason } from './errors.js';

// ── Session, re-exported flat because the UI touches it constantly ──────────
export {
  getSession,
  getAccessToken,
  isSignedIn,
  onSessionChange,
  clearSession,
  getPersistence,
  setPersistence,
} from './session.js';
export type { AuthChain, PersistenceMode, Session } from './session.js';

// ── Escape hatch for endpoints this layer does not wrap yet ─────────────────
// (e.g. the booster routes). Everything above goes through these, so they get
// the same auth injection, refresh-once-on-401 and 429 handling.
export { request, get, post, put, patch, del, refreshSession, isRefreshing } from './http.js';
export type { AuthMode, RequestOptions } from './http.js';

// ── Domain types, flat, so consumers do not need the namespace to annotate ──
export type { AuthProfile, MeResponse, NonceChallenge, TokenResponse, VerifyResponse } from './auth.js';
export type { CollectionView, OwnedCards, SyncResult, UnownedCardIssue } from './collection.js';
export type { Deck, DeckIssue } from './decks.js';
export type {
  CreatedMatch,
  CreateOptions,
  JoinedMatch,
  LobbyEntry,
  MatchMode,
  MatchStatus,
  Seat,
  SeatInfo,
} from './lobby.js';
export type {
  Leaderboard,
  LeaderboardEntry,
  MatchHistoryEntry,
  OwnProfile,
  ProfilePatch,
  PublicProfile,
} from './profiles.js';
export type { DepositResult, Escrow, EscrowStatus, StakeTier, Stakes } from './wager.js';
