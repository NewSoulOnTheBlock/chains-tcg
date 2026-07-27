// src/api/profiles.ts
//
// Player profiles and the leaderboard.
//
// ─── PUBLIC vs AUTHENTICATED ────────────────────────────────────────────────
//
//   getMe()            AUTH   the only route that returns a wallet address,
//                             and only to its owner
//   patchMe()          AUTH   operates on the caller's own profile only —
//                             there is no route that takes a target profile
//   getPublicProfile() PUBLIC works while signed out; NO address
//   getMatches()       PUBLIC works while signed out
//   getLeaderboard()   PUBLIC works while signed out; NO addresses
//
// The three public calls pass `auth: 'optional'`, so they attach a token when
// one happens to exist but never trigger a refresh or a "please sign in"
// state. They are safe to render on a logged-out landing page.
//
// ─── IDS ────────────────────────────────────────────────────────────────────
// `Profile.id` is a bigint-safe decimal string. Never `parseInt` it.

import { get, patch } from './http.js';

/** The caller's own profile. The ONLY shape that carries a wallet address. */
export interface OwnProfile {
  /** bigint-safe decimal string. */
  id: string;
  /** Wallet address. Lowercased for EVM, base58 for Solana. */
  address: string;
  /** Chain slug: `ethereum | base | arbitrum | polygon | solana`. */
  chain: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  wins: number;
  losses: number;
  /** Derived server-side from `wins`, not a stored column. */
  level: number;
  /** ISO-8601. */
  createdAt: string;
}

/** Anyone else's profile. Deliberately has no `id`, `address` or `chain`. */
export interface PublicProfile {
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  wins: number;
  losses: number;
  level: number;
}

/** One row of `GET /api/profiles/:displayName/matches`. */
export interface MatchHistoryEntry {
  /** Match id — a string. Same value as the boardgame.io `matchID`. */
  matchId: string;
  /** `casual | ranked | wager`. */
  mode: string;
  /** 0 or 1 — a NUMBER, unlike boardgame.io's string `playerID`. */
  seat: 0 | 1;
  outcome: 'win' | 'loss' | 'draw';
  /** Free-form, e.g. `concede`. */
  reason: string;
  opponentDisplayName: string | null;
  /** ISO-8601. */
  finishedAt: string;
}

export interface LeaderboardEntry {
  /** 1-based, computed server-side. */
  rank: number;
  displayName: string;
  avatarUrl: string | null;
  wins: number;
  losses: number;
  level: number;
}

export interface Leaderboard {
  leaderboard: LeaderboardEntry[];
  /** ISO-8601 — when the snapshot was built, not when you asked. */
  generatedAt: string;
  /** Whether this came from the server's 30s Redis cache. */
  cached: boolean;
}

/** Fields `patchMe` accepts. `null` clears; omitted leaves untouched. */
export interface ProfilePatch {
  /** 3–32 chars, letters/numbers/space/`_`/`.`/`-`. 409 if already taken. */
  displayName?: string;
  /** Must be `https:`, no credentials, ≤512 chars. `null` to clear. */
  avatarUrl?: string | null;
  /** ≤500 chars. Empty string is stored as `null`. */
  bio?: string | null;
}

/**
 * `GET /api/profiles/me` — AUTH.
 *
 * Prefer this for the profile screen. If you need `roles` (operator checks),
 * use `auth.getMe()` instead — that endpoint returns a different, flat shape.
 */
export async function getMe(signal?: AbortSignal): Promise<OwnProfile> {
  const { profile } = await get<{ profile: OwnProfile }>('/api/profiles/me', { signal });
  return profile;
}

/**
 * `PATCH /api/profiles/me` — AUTH. Edits the CALLER's profile and no other.
 *
 * Rate limited to 10/min per profile. Errors worth handling:
 *   409 + `details.reason === 'display_name_taken'`
 *   400 + `details.reason` starting `avatar_` (`avatar_host` also carries
 *         `details.allowed: string[]`)
 */
export async function patchMe(body: ProfilePatch, signal?: AbortSignal): Promise<OwnProfile> {
  const { profile } = await patch<{ profile: OwnProfile }>('/api/profiles/me', body, { signal });
  return profile;
}

/**
 * `GET /api/profiles/:displayName` — PUBLIC. Works signed out.
 *
 * The path segment is validated as a display name, so a 2-character or exotic
 * input is a 400 (`bad_request`), not a 404. Validate in the UI before calling.
 * A well-formed name that does not exist is a 404.
 */
export async function getPublicProfile(
  displayName: string,
  signal?: AbortSignal,
): Promise<PublicProfile> {
  const { profile } = await get<{ profile: PublicProfile }>(
    `/api/profiles/${encodeURIComponent(displayName)}`,
    { auth: 'optional', signal },
  );
  return profile;
}

/**
 * `GET /api/profiles/:displayName/matches` — PUBLIC. Works signed out.
 *
 * This is the ONLY source of match history. The client no longer reports
 * results (there is no endpoint that accepts one); the game service derives
 * outcomes from its own boardgame.io state and writes them itself.
 *
 * @param limit 1–50, defaults to 25 server-side.
 */
export async function getMatches(
  displayName: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<MatchHistoryEntry[]> {
  const { matches } = await get<{ matches: MatchHistoryEntry[] }>(
    `/api/profiles/${encodeURIComponent(displayName)}/matches`,
    { auth: 'optional', query: { limit: options.limit }, signal: options.signal },
  );
  return matches;
}

/**
 * `GET /api/leaderboard` — PUBLIC. Works signed out.
 *
 * Top 50, fixed server-side; there is no `limit` parameter. Contains no wallet
 * addresses by design. Cached for ~30s, so polling faster than that is wasted.
 */
export function getLeaderboard(signal?: AbortSignal): Promise<Leaderboard> {
  return get<Leaderboard>('/api/leaderboard', { auth: 'optional', signal });
}
