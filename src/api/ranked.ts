// src/api/ranked.ts
//
// The competitive ladder: seasons, ranks, placements, the queue and the season
// leaderboard. All of it lives under `/games/ranked/*` on the game service.
//
// ─── WHAT THE SERVER SENDS, AND WHAT IT DELIBERATELY DOES NOT ───────────────
//
// Every field below is one the server actually returns. There is no hidden MMR
// in any response, no ETA, no win streak, and no rank for a player still in
// placements — `profile.rank` is NULL until `placement.inPlacements` is false.
// The UI must render that absence as an absence. The previous generation of
// this screen invented a provisional tier and that is precisely why it was
// deleted; do not bring it back.
//
// ─── PUBLIC vs AUTHENTICATED ────────────────────────────────────────────────
//
//   getSeason()      PUBLIC   season window + reward copy + the tier list
//   getLeaderboard() PUBLIC   season ladder; players in placements are EXCLUDED
//   getProfile(name) PUBLIC   anyone's ranked standing; 404 if never seen
//   getMe()          AUTH     the caller's own, plus `profileId`
//   getMyMatches()   AUTH     ranked history WITH the LP delta per match
//   joinQueue()      AUTH     enqueue
//   getQueueStatus() AUTH     THE POLL — 180 per 60s per profile
//   leaveQueue()     AUTH     dequeue
//
// ─── THE PAIRING HANDOFF ────────────────────────────────────────────────────
// `getQueueStatus()` returns `match: null` until the pairer seats you. When it
// is non-null it carries the match id and YOUR seat, but NO credentials —
// deliberately. Take the id to the existing `GET /games/:id/seat`
// (`lobby.getSeat`) for your own credentials and connect the socket exactly as
// the lobby join path does.
//
// That read is a plain database lookup, so it is idempotent: a player who
// refreshes the page mid-queue calls `getQueueStatus()` again, gets the same
// pairing back, and lands in their match. It is the reconnect path, not just
// the happy path.
//
// ─── REGIONS ARE A TRAP ─────────────────────────────────────────────────────
// The pairer only pairs WITHIN a region. Send `global` (or omit it, which means
// the same thing). Do NOT build a region picker: one player sitting in `eu`
// while the population is in `global` is a player who never matches.

import { del, get, post } from './http.js';
import { ApiError } from './errors.js';

// ── Ladder shape ────────────────────────────────────────────────────────────

/**
 * The eight tiers, lowest first. The season response carries this same list in
 * `tiers`; PREFER that at runtime and treat this as the styling fallback for a
 * client that has not loaded the season yet.
 */
export const RANKED_TIERS = [
  'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Grandmaster', 'Mythic',
] as const;

/** A known tier name — but typed open, so a new server tier cannot break the build. */
export type RankedTier = (typeof RANKED_TIERS)[number] | (string & {});

/** Queue regions the server accepts. Only `global` should ever be sent. */
export type RankedRegion = 'global' | 'na' | 'eu' | 'ap';

/**
 * A player's visible standing.
 *
 * `label` is the SERVER'S OWN rendering ("Gold II", "Mythic"). Render it rather
 * than reassembling `tier` + `division`: Mythic has no meaningful division and
 * the server already knows that. `division` is still sent for Mythic (as 1) and
 * means nothing there.
 *
 * `ordinal` is a single sortable integer across the whole ladder — useful for
 * comparing two ranks, never for display.
 */
export interface RankedRank {
  tier: RankedTier;
  division: number;
  lp: number;
  /** Pre-rendered, e.g. `"Gold II"` or `"Mythic"`. Display THIS. */
  label: string;
  ordinal: number;
}

/**
 * Placement progress.
 *
 * While `inPlacements` is true the player has NO rank — the sibling `rank`
 * field is `null` — and the UI shows progress instead of a tier.
 */
export interface RankedPlacement {
  /** Placement matches still to play. `0` once placed. */
  remaining: number;
  /** Total placement matches in this season (10 at time of writing). */
  total: number;
  inPlacements: boolean;
}

export interface RankedRecord {
  wins: number;
  losses: number;
  draws: number;
}

/** Anyone's ranked standing for a season. `GET /games/ranked/profiles/:name`. */
export interface RankedProfile {
  displayName: string;
  seasonId: string;
  /** NULL whenever `placement.inPlacements` is true. Never invent one. */
  rank: RankedRank | null;
  placement: RankedPlacement;
  record: RankedRecord;
  /** Position on the season ladder, or `null` while unplaced. */
  leaderboardRank: number | null;
}

/**
 * The caller's own standing. `GET /games/ranked/me`.
 *
 * Same shape as `RankedProfile` with `profileId` in place of `displayName` —
 * the caller already knows their own name.
 */
export interface OwnRankedProfile extends Omit<RankedProfile, 'displayName'> {
  /** bigint-safe decimal string. Never `parseInt` it. */
  profileId: string;
}

// ── Season ──────────────────────────────────────────────────────────────────

/** Reward copy for one tier. Cosmetic identifiers, not entitlements. */
export interface SeasonTierReward {
  cardback: string;
  title: string;
}

export interface SeasonChampionReward {
  title: string;
  description: string;
}

/**
 * Season reward COPY, exactly as the server words it.
 *
 * Render it; do not editorialise it into a promise. There is no payout path
 * behind any of this — these are titles and cardback identifiers.
 */
export interface SeasonRewards {
  champion: SeasonChampionReward;
  /** Keyed by tier name. Not every tier is guaranteed to be present. */
  tiers: Record<string, SeasonTierReward>;
}

export interface RankedSeason {
  id: string;
  name: string;
  /** ISO-8601. */
  startedAt: string;
  /** ISO-8601. */
  endsAt: string;
  /** How hard the next season's soft reset pulls ranks toward the middle. */
  softResetFactor: number;
  balancePatch: string | null;
  rewards: SeasonRewards;
}

/** `GET /games/ranked/season`. */
export interface SeasonInfo {
  season: RankedSeason;
  /** How many matches a new player plays before they are given a rank. */
  placementMatches: number;
  /** Tier names, lowest first — the server's own ordering. */
  tiers: RankedTier[];
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

/**
 * One ladder row.
 *
 * Carries no wallet address and no avatar — do not add either. Players still in
 * placements are EXCLUDED server-side, which is why a brand-new season's
 * leaderboard is legitimately empty rather than broken.
 */
export interface RankedLeaderboardEntry {
  /** 1-based, computed server-side. */
  rank: number;
  /** bigint-safe decimal string. */
  profileId: string;
  displayName: string;
  tier: RankedTier;
  division: number;
  lp: number;
  /** Pre-rendered rank label. Display this rather than tier + division. */
  label: string;
  record: RankedRecord;
}

export interface RankedLeaderboard {
  seasonId: string;
  limit: number;
  offset: number;
  /** Empty is a VALID answer — see the module note on placements. */
  entries: RankedLeaderboardEntry[];
}

// ── Match history ───────────────────────────────────────────────────────────

export type RankedOutcome = 'win' | 'loss' | 'draw';
/** How the match ended. Typed open — the server may add reasons. */
export type RankedEndReason = 'life' | 'deckout' | 'concede' | 'timeout' | (string & {});

/** One row of `GET /games/ranked/me/matches`. */
export interface RankedMatchEntry {
  matchID: string;
  seasonId: string;
  /** 0 or 1 — a NUMBER, unlike boardgame.io's string `playerID`. */
  seat: 0 | 1;
  outcome: RankedOutcome;
  reason: RankedEndReason;
  /** Signed LP change. Always `0` for a draw. */
  lpDelta: number;
  opponentDisplayName: string | null;
  /** ISO-8601. */
  finishedAt: string;
}

// ── Queue ───────────────────────────────────────────────────────────────────

/** `POST /games/ranked/queue` — you are now in line. */
export interface QueueTicket {
  queued: true;
  /** ISO-8601. */
  queuedAt: string;
  seasonId: string;
  region: RankedRegion;
  /** How many players are waiting in this region, including you. */
  queueDepth: number;
}

/**
 * The pairer has seated you.
 *
 * NO CREDENTIALS, by design. Take `matchID` to `lobby.getSeat()` for your own.
 */
export interface QueuePairing {
  matchID: string;
  seat: 0 | 1;
  /** boardgame.io's string form of `seat`. */
  playerID: '0' | '1';
  opponentDisplayName: string | null;
}

/**
 * `GET /games/ranked/queue` — the poll.
 *
 * Budget is 180 per 60 seconds per profile. Poll on a chained timer (not a bare
 * interval), stop while the tab is hidden, and stop on unmount.
 *
 * Fields other than `queued` and `match` are only meaningful while queued; they
 * are typed nullable so a "not queued" response cannot be mistaken for a real
 * zero wait.
 */
export interface QueueStatus {
  queued: boolean;
  queuedAt: string | null;
  /** Milliseconds waited so far. `0` when not queued. */
  waitedMs: number;
  region: RankedRegion | null;
  seasonId: string | null;
  /** How wide the rating search has opened. `null` when not queued. */
  mmrWindow: number | null;
  queueDepth: number;
  /** `null` until the pairer seats you. */
  match: QueuePairing | null;
}

/** `DELETE /games/ranked/queue`. */
export interface QueueLeft {
  queued: false;
  /** `false` when you were not in the queue to begin with — not an error. */
  wasQueued: boolean;
}

// ── Error helpers ───────────────────────────────────────────────────────────
//
// The envelope is the usual `{error:{code,message,details}}`. The domain cause
// normally travels in `details.reason` (src/api/README.md §4), but these routes
// are new and the ranked service has not been observed to place every cause
// there rather than in `code`. Each helper therefore accepts EITHER position,
// which is correct whichever one the server uses and cannot produce a false
// positive: the two vocabularies do not overlap.

function hasCause(err: unknown, cause: string): err is ApiError {
  return err instanceof ApiError && (err.reason === cause || err.code === cause);
}

/** No active deck at all. Send the player to the deck screen. */
export function isNoActiveDeckError(err: unknown): err is ApiError {
  return hasCause(err, 'no_active_deck');
}

/** There IS an active deck, but it is no longer a legal 60. Same destination. */
export function isInvalidActiveDeckError(err: unknown): err is ApiError {
  return hasCause(err, 'invalid_active_deck');
}

/**
 * The deck contains cards the player's collection does not cover.
 *
 * `details.issues` names each one as `{code:'unowned', cardId, need, owned,
 * message}`; use `collection.unownedIssues(err)` to read the numbers, because
 * `ApiError.issues` keeps only `{path, message, code}` and drops them.
 */
export function isUnownedCardsError(err: unknown): err is ApiError {
  return hasCause(err, 'unowned_cards');
}

/** Any of the three deck refusals — the single check most call sites want. */
export function isDeckBlockedError(err: unknown): err is ApiError {
  return isNoActiveDeckError(err) || isInvalidActiveDeckError(err) || isUnownedCardsError(err);
}

/**
 * `409 already_in_match` — you are already seated somewhere. Returns that match
 * id so the UI can offer to REJOIN rather than reporting a dead end.
 */
export function alreadyInMatchId(err: unknown): string | null {
  if (!hasCause(err, 'already_in_match')) return null;
  const id = err.details.matchID ?? err.details.matchId;
  return typeof id === 'string' ? id : null;
}

/** `503 ranked_disabled` — the operator has turned the ladder off. */
export function isRankedDisabledError(err: unknown): err is ApiError {
  return hasCause(err, 'ranked_disabled');
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * `GET /games/ranked/season` — PUBLIC. Works signed out.
 *
 * Also the source of the authoritative tier list and the placement-match count,
 * so prefer `info.placementMatches` over hardcoding 10.
 */
export function getSeason(signal?: AbortSignal): Promise<SeasonInfo> {
  return get<SeasonInfo>('/games/ranked/season', { auth: 'optional', signal });
}

/**
 * `GET /games/ranked/leaderboard` — PUBLIC. Works signed out.
 *
 * AN EMPTY `entries` ARRAY IS A CORRECT ANSWER, not a failure: players in
 * placements are excluded, so a season nobody has finished placements in has an
 * empty ladder. Render that as "no ranked players yet", never as an error.
 *
 * @param limit  1–100. Defaults to 100 server-side.
 * @param offset 0–100000.
 */
export function getLeaderboard(
  options: { seasonId?: string; limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<RankedLeaderboard> {
  return get<RankedLeaderboard>('/games/ranked/leaderboard', {
    auth: 'optional',
    query: { seasonId: options.seasonId, limit: options.limit, offset: options.offset },
    signal: options.signal,
  });
}

/**
 * `GET /games/ranked/profiles/:displayName` — PUBLIC. Works signed out.
 *
 * The path segment is validated as a display name (3–32 chars), so a short or
 * exotic input is a 400, not a 404. A well-formed name nobody holds is a 404.
 * A player who has never played ranked this season returns a real profile with
 * `rank: null` and a full placement counter — that is NOT a 404.
 */
export async function getProfile(displayName: string, signal?: AbortSignal): Promise<RankedProfile> {
  const { profile } = await get<{ profile: RankedProfile }>(
    `/games/ranked/profiles/${encodeURIComponent(displayName)}`,
    { auth: 'optional', signal },
  );
  return profile;
}

/**
 * `GET /games/ranked/me` — AUTH. The caller's own standing.
 *
 * This route does NOT wrap its body the way its sibling `/profiles/:name` does.
 * Verified against production: `/profiles/:name` answers `{ profile: {...} }`,
 * while `/me` spreads the same view at the top level, `{ profileId, ...view }`.
 * Reading `body.profile` here therefore yielded `undefined`, which
 * `standingOf()` maps to "no data", which the badge renders as
 * RANK UNAVAILABLE — for a player the server was describing perfectly well.
 *
 * Accept BOTH shapes rather than picking one. The mismatch is a server-side
 * inconsistency worth normalising, but a client that only understands today's
 * shape would break on the day it is fixed.
 */
export async function getMe(signal?: AbortSignal): Promise<OwnRankedProfile> {
  const body = await get<{ profile?: OwnRankedProfile } & Partial<OwnRankedProfile>>(
    '/games/ranked/me',
    { signal },
  );
  return (body.profile ?? body) as OwnRankedProfile;
}

/**
 * `GET /games/ranked/me/matches` — AUTH.
 *
 * The ONLY source of per-match LP deltas; the generic
 * `profiles.getMatches()` history has no LP in it at all.
 *
 * @param limit 1–50. Defaults to 20 server-side.
 */
export async function getMyMatches(
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<RankedMatchEntry[]> {
  const { matches } = await get<{ matches: RankedMatchEntry[] }>('/games/ranked/me/matches', {
    query: { limit: options.limit },
    signal: options.signal,
  });
  return matches;
}

/**
 * `POST /games/ranked/queue` — AUTH. Join the queue.
 *
 * THE BODY IS STRICT: `{region?}` and nothing else — any other key is a 400.
 * Omitting `region` means `global`, which is what every caller should do; see
 * the module note on why a region picker is a trap.
 *
 * Errors: 400 `no_active_deck` · 400 `invalid_active_deck` · 400
 * `unowned_cards` (+`issues`) · 409 `already_in_match` (+`matchID`) · 429
 * (30 per 60s) · 503 `ranked_disabled`.
 *
 * Not retried on a 429: the rate limiter is the point, and a queued player
 * re-queueing is a side effect worth being explicit about.
 */
export function joinQueue(
  options: { region?: RankedRegion } = {},
  signal?: AbortSignal,
): Promise<QueueTicket> {
  const body: Record<string, unknown> = {};
  if (options.region !== undefined) body.region = options.region;
  return post<QueueTicket>('/games/ranked/queue', body, { signal });
}

/**
 * `GET /games/ranked/queue` — AUTH. THE POLL. 180 per 60s per profile.
 *
 * Doubles as the reconnect path: it is a plain database read, so calling it
 * after a page refresh returns the same queue entry — and the same `match`, if
 * one has been made — rather than losing the player's place.
 *
 * A profile that is not queued has not been observed to 404, but if it ever
 * does, that is "not queued" and not an error; `getQueueStatusOrIdle()` below
 * encodes that.
 */
export function getQueueStatus(signal?: AbortSignal): Promise<QueueStatus> {
  return get<QueueStatus>('/games/ranked/queue', { signal });
}

/** The idle answer, for when there is nothing in the queue for this profile. */
export const NOT_QUEUED: QueueStatus = {
  queued: false,
  queuedAt: null,
  waitedMs: 0,
  region: null,
  seasonId: null,
  mmrWindow: null,
  queueDepth: 0,
  match: null,
};

/**
 * `getQueueStatus()` with a 404 folded into "not queued".
 *
 * Use this for the resume-on-mount read, where a 404 must not be shown to the
 * player as a failure. Every other error still throws.
 */
export async function getQueueStatusOrIdle(signal?: AbortSignal): Promise<QueueStatus> {
  try {
    return await getQueueStatus(signal);
  } catch (err) {
    if (err instanceof ApiError && err.isNotFound) return NOT_QUEUED;
    throw err;
  }
}

/**
 * `DELETE /games/ranked/queue` — AUTH. Leave the queue.
 *
 * `wasQueued: false` means there was nothing to cancel. That is a success, not
 * an error: it is exactly what a double-click, or a leave racing a pairing,
 * looks like.
 */
export function leaveQueue(signal?: AbortSignal): Promise<QueueLeft> {
  return del<QueueLeft>('/games/ranked/queue', { signal });
}
