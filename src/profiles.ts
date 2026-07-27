// src/profiles.ts
//
// ADAPTER between the UI's long-standing `Profile` / `DeckEntry` shapes and the
// secure backend's client in `src/api/**`.
//
// This module builds no URLs, holds no tokens and parses no error envelopes —
// `src/api` does all of that. Everything here is shape translation, so the
// screens that were written against the legacy Koa server keep compiling while
// talking to the new services.
//
// ─── WHAT WENT AWAY, AND WHY ───────────────────────────────────────────────
//
//   upsertProfileApi(name)        identity is a wallet signature now, not a
//                                 name you can claim by POSTing it.
//   getProfileByWalletApi(addr)   no route maps an address to a profile; the
//                                 address is private to its owner.
//   recordResultApi(...)          THE CLIENT NEVER REPORTS A RESULT. There is
//                                 no endpoint that accepts one. The game
//                                 service derives outcomes from its own
//                                 boardgame.io state and writes them itself.
//                                 Read history with `getMatchHistoryApi()`.
//   getLibraryApi(wallet)         the Helius-backed NFT library is gone.
//   getDeckApi / saveDeckApi      the single implicit deck is gone; decks are
//                                 a list and one of them is ACTIVE.
//   challenge APIs                replaced by lobby invites — see `src/api`'s
//                                 `lobby.create({invitedDisplayName})` and
//                                 `lobby.getInvites()`.

import { decks as decksApi, profiles as profilesApi, ApiError } from './api';
import type { Deck, MatchHistoryEntry, OwnProfile, PublicProfile } from './api';

export type { MatchHistoryEntry };

/**
 * The UI's profile shape.
 *
 * Two server shapes collapse into this one: `GET /api/profiles/me` (yours,
 * carries an address) and `GET /api/profiles/:displayName` (anyone else's,
 * deliberately carries no address, no id and no chain).
 */
export type Profile = {
  name: string;
  wins: number;
  losses: number;
  /** The new backend does not record draws. Always 0 — kept so the existing
   *  record formatter and the screens that read it keep working. */
  draws: number;
  /** Epoch ms. 0 for other players — only your own profile exposes `createdAt`. */
  createdAt: number;
  avatarUrl: string | null;
  bio: string | null;
  /** Derived server-side from wins. */
  level: number;
  /** ONLY ever set on your own profile. `null` for everyone else, because the
   *  server does not disclose other players' addresses to anyone. */
  walletAddress: string | null;
  /** Chain slug (`ethereum | base | arbitrum | polygon | solana`), yours only. */
  walletChain: string | null;
};

function fromOwn(p: OwnProfile): Profile {
  return {
    name: p.displayName,
    wins: p.wins,
    losses: p.losses,
    draws: 0,
    createdAt: Date.parse(p.createdAt) || 0,
    avatarUrl: p.avatarUrl,
    bio: p.bio,
    level: p.level,
    walletAddress: p.address,
    walletChain: p.chain,
  };
}

function fromPublic(name: string, p: PublicProfile): Profile {
  return {
    name: p.displayName || name,
    wins: p.wins,
    losses: p.losses,
    draws: 0,
    createdAt: 0,
    avatarUrl: p.avatarUrl,
    bio: p.bio,
    level: p.level,
    walletAddress: null,
    walletChain: null,
  };
}

// ── Profiles ────────────────────────────────────────────────────────────────

/** Your own profile, including your wallet address. Requires a session. */
export async function getMyProfileApi(signal?: AbortSignal): Promise<Profile> {
  return fromOwn(await profilesApi.getMe(signal));
}

/**
 * Someone else's profile by display name. Public — works signed out.
 *
 * `null` when the name does not exist, and also when it is not a well-formed
 * display name (the server 400s on those rather than 404ing).
 */
export async function getProfileApi(name: string, signal?: AbortSignal): Promise<Profile | null> {
  try {
    return fromPublic(name, await profilesApi.getPublicProfile(name, signal));
  } catch (err) {
    if (err instanceof ApiError && (err.isNotFound || err.isValidationError)) return null;
    throw err;
  }
}

/**
 * Top 50 by wins. Public. Fixed size — the server takes no `limit`, and the
 * rows carry no wallet addresses by design.
 */
export async function listProfilesApi(signal?: AbortSignal): Promise<Profile[]> {
  const { leaderboard } = await profilesApi.getLeaderboard(signal);
  return leaderboard.map((e) => ({
    name: e.displayName,
    wins: e.wins,
    losses: e.losses,
    draws: 0,
    createdAt: 0,
    avatarUrl: e.avatarUrl,
    bio: null,
    level: e.level,
    walletAddress: null,
    walletChain: null,
  }));
}

/**
 * Edit YOUR OWN profile. There is no route that takes a target profile, so
 * this deliberately has no `name` parameter — whoever holds the token is who
 * gets edited.
 *
 * Display name is server-side state now: first-time players are given a
 * default derived from their address, and this is how they change it.
 */
export function updateMyProfileApi(
  patch: { displayName?: string; avatarUrl?: string | null; bio?: string | null },
  signal?: AbortSignal,
): Promise<Profile> {
  return profilesApi.patchMe(patch, signal).then(fromOwn);
}

/**
 * Match history for a display name. Public.
 *
 * THE ONLY source of results. The client does not report them and cannot.
 */
export function getMatchHistoryApi(
  name: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<MatchHistoryEntry[]> {
  return profilesApi.getMatches(name, options);
}

// ── Deck library ────────────────────────────────────────────────────────────

/** Deck ids are bigint-safe decimal STRINGS. Never `parseInt` one. */
export type DeckEntry = { id: string; name: string; cards: string[]; isActive: boolean };

function fromDeck(d: Deck): DeckEntry {
  return { id: d.id, name: d.name, cards: d.cards, isActive: d.isActive };
}

/** Your decks. The server scopes by token, so there is no name parameter. */
export async function listDecksApi(signal?: AbortSignal): Promise<DeckEntry[]> {
  return (await decksApi.list(signal)).map(fromDeck);
}

/** Your ACTIVE deck — the one the game service seats you with — or `null`. */
export async function getActiveDeckApi(signal?: AbortSignal): Promise<DeckEntry | null> {
  const d = await decksApi.getActive(signal);
  return d ? fromDeck(d) : null;
}

/**
 * Save a new deck. Card ids and copy limits are checked; SIZE IS NOT, so a
 * work-in-progress deck saves cleanly. The first deck you create is
 * automatically active.
 */
export async function createDeckApi(
  deckName: string,
  cards: string[],
  signal?: AbortSignal,
): Promise<DeckEntry> {
  return fromDeck(await decksApi.create({ name: deckName, cards }, signal));
}

/** Rename a deck, replace its cards, or both. */
export async function updateDeckApi(
  deckId: string,
  patch: { name?: string; cards?: string[] },
  signal?: AbortSignal,
): Promise<DeckEntry> {
  return fromDeck(await decksApi.update(deckId, patch, signal));
}

/**
 * Delete a deck.
 *
 * A deck that has ever been seated into a match CANNOT be deleted — the server
 * returns a bare 400 from a foreign-key violation. Callers must catch that with
 * `decksApi.isUndeletableDeckError()` and offer rename/replace instead of
 * pretending the delete worked.
 */
export function deleteDeckApi(deckId: string, signal?: AbortSignal): Promise<void> {
  return decksApi.remove(deckId, signal);
}

/**
 * Make a deck active. THE ONLY route that enforces full 60-card legality, and
 * the only way to become able to create or join a match.
 *
 * Throws `ApiError` with `reason === 'invalid_deck'` and a structured
 * `issues` array on failure — show those per issue.
 */
export async function activateDeckApi(deckId: string, signal?: AbortSignal): Promise<DeckEntry> {
  return fromDeck(await decksApi.activate(deckId, signal));
}

// ── Display helpers ─────────────────────────────────────────────────────────

export function formatRecord(p: Profile | null | undefined): string {
  if (!p) return '0-0';
  return p.draws > 0 ? `${p.wins}-${p.losses}-${p.draws}` : `${p.wins}-${p.losses}`;
}
