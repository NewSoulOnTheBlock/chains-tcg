// src/ranked-client.ts
//
// ─── THE RANKED LADDER, LIVE ────────────────────────────────────────────────
//
// This file used to be a gate. It exported `RANKED_AVAILABLE = false` and a
// "coming soon" line, because the ladder existed only as legacy code written
// for the old Koa server and every `/api/ranked/*` route was a 404 on the new
// backend.
//
// The ladder has since been ported into the game service and is live at
// `/games/ranked/*`: seasons, placements, LP, a season leaderboard, per-match
// LP deltas and a real matchmaking queue. The gate is therefore GONE — there is
// no `RANKED_AVAILABLE` any more, and nothing should be checking for one.
//
// ─── WHAT LIVES WHERE ───────────────────────────────────────────────────────
//
//   src/api/ranked.ts   the transport: every route, every response type, the
//                       error helpers. Nothing in this file builds a URL.
//   THIS FILE           everything the UI needs that is NOT a request: tier
//                       colours, the LP/rank label formatters, the placement
//                       gate, the season countdown and the queue state machine.
//
// All of it is pure and side-effect free, so `src/ranked-client.test.ts` can
// exercise the parts that are easy to get wrong without a DOM or a network.
//
// ─── THE ONE RULE ───────────────────────────────────────────────────────────
// DO NOT INVENT DATA THE SERVER DOES NOT SEND. No fabricated MMR, no win
// streaks, no queue ETA, and above all no rank for a player still in
// placements — the server sends `rank: null` there and means it. Inventing a
// provisional tier is exactly what got the previous version of this UI deleted.

import { ApiError } from './api';
import { errorHeadline, errorIssues } from './error-text';
import {
  RANKED_TIERS,
  alreadyInMatchId,
  isInvalidActiveDeckError,
  isNoActiveDeckError,
  isRankedDisabledError,
  isUnownedCardsError,
  type QueuePairing,
  type QueueStatus,
  type QueueTicket,
  type RankedLeaderboard,
  type RankedMatchEntry,
  type RankedPlacement,
  type RankedRank,
  type RankedRecord,
  type RankedRegion,
  type RankedTier,
} from './api/ranked';

// Re-exported so a UI module can `import { … } from './ranked-client'` and get
// both halves — the transport and the presentation — from one place.
export * as RankedAPI from './api/ranked';
export type {
  OwnRankedProfile,
  QueueLeft,
  QueuePairing,
  QueueStatus,
  QueueTicket,
  RankedEndReason,
  RankedLeaderboard,
  RankedLeaderboardEntry,
  RankedMatchEntry,
  RankedOutcome,
  RankedPlacement,
  RankedProfile,
  RankedRank,
  RankedRecord,
  RankedRegion,
  RankedSeason,
  RankedTier,
  SeasonInfo,
  SeasonRewards,
  SeasonTierReward,
} from './api/ranked';
export { RANKED_TIERS } from './api/ranked';

/**
 * The only region this client ever sends.
 *
 * The pairer matches WITHIN a region, so a picker is a footgun: one player on
 * `eu` while the population sits on `global` is a player who waits forever.
 * There is no UI for this and there should not be one.
 */
export const QUEUE_REGION: RankedRegion = 'global';

// ─────────────────────────────────────────────────────────────────────────────
// TIER COLOURS
// ─────────────────────────────────────────────────────────────────────────────

/** How one tier is painted. Sits inside the app's dark, gold-trimmed palette. */
export interface TierStyle {
  /** Line/text colour. */
  color: string;
  /** Translucent fill for the badge body. */
  fill: string;
  /** Border colour. */
  border: string;
}

const style = (color: string, fillAlpha = '1f', borderAlpha = '66'): TierStyle => ({
  color,
  fill: `${color}${fillAlpha}`,
  border: `${color}${borderAlpha}`,
});

/**
 * Tier colours, lowest to highest.
 *
 * Bronze through Gold stay inside the app's warm gold family; the upper tiers
 * move through cool metals into violet so that a glance at a leaderboard reads
 * as a gradient rather than eight arbitrary hues.
 */
export const TIER_STYLE: Record<string, TierStyle> = {
  Bronze:      style('#C08A4E'),
  Silver:      style('#C3CBD8'),
  Gold:        style('#E6C45C'),
  Platinum:    style('#6FE0CE'),
  Diamond:     style('#6FB7FF'),
  Master:      style('#B98CFF'),
  Grandmaster: style('#FF8A6B'),
  Mythic:      style('#FF6BD6'),
};

/** The neutral used for "no tier" — unranked, in placements, or unknown. */
export const UNRANKED_STYLE: TierStyle = style('#9FA8BF');

/** Style for a tier name, falling back to the neutral for anything unknown. */
export function tierStyle(tier: RankedTier | null | undefined): TierStyle {
  if (!tier) return UNRANKED_STYLE;
  return TIER_STYLE[tier] ?? UNRANKED_STYLE;
}

/** 0-based position on the ladder, or `-1` for an unknown tier. */
export function tierIndex(tier: RankedTier | null | undefined): number {
  if (!tier) return -1;
  return (RANKED_TIERS as readonly string[]).indexOf(tier);
}

// ─────────────────────────────────────────────────────────────────────────────
// LABELS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The rank as text.
 *
 * ALWAYS prefers the server's own `label` ("Gold II", "Mythic"). Only if that
 * is missing does it reassemble, and even then it omits the division for
 * Mythic, which has none — the server sends `division: 1` there and it means
 * nothing.
 */
export function formatRankLabel(rank: RankedRank | null | undefined): string {
  if (!rank) return 'Unranked';
  if (rank.label) return rank.label;
  if (rank.tier === 'Mythic' || !rank.division) return String(rank.tier);
  return `${rank.tier} ${ROMAN[rank.division] ?? rank.division}`;
}

const ROMAN: Record<number, string> = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };

/** `"40 LP"`. */
export function formatLp(lp: number): string {
  return `${Math.round(lp)} LP`;
}

/**
 * A signed LP change, for a match-history row.
 *
 * A draw is `0` and is shown as `"0 LP"` rather than `"+0"` — the server awards
 * nothing for a draw and the copy should not imply a gain.
 */
export function formatLpDelta(delta: number): string {
  const n = Math.round(delta);
  if (n > 0) return `+${n} LP`;
  if (n < 0) return `−${Math.abs(n)} LP`;
  return '0 LP';
}

/** `"12W · 8L"`, with draws only when there are any. */
export function formatRankedRecord(record: RankedRecord): string {
  const base = `${record.wins}W · ${record.losses}L`;
  return record.draws > 0 ? `${base} · ${record.draws}D` : base;
}

/** Win rate as a whole percent, or `null` when no games have been played. */
export function rankedWinRate(record: RankedRecord): number | null {
  const games = record.wins + record.losses + record.draws;
  if (games === 0) return null;
  return Math.round((record.wins / games) * 100);
}

/** Player-facing copy for how a match ended. */
export function formatEndReason(reason: string): string {
  switch (reason) {
    case 'life': return 'Life total';
    case 'deckout': return 'Deck out';
    case 'concede': return 'Conceded';
    case 'timeout': return 'Timed out';
    default: return reason;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PLACEMENT GATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What to render for a player: placement progress, or a rank.
 *
 * `inPlacements` is the gate and it is checked FIRST — before `rank` is even
 * looked at. The server sends `rank: null` throughout placements, but the order
 * matters anyway: if a future server ever sent both, showing the rank would
 * still be wrong, because the rank is not final until placements are done.
 *
 * `unranked` is the defensive third case — not in placements, and still no rank.
 * It renders as an honest absence. It is not expected from the live server, and
 * it must never be filled in with a guess.
 */
export type RankedStanding =
  | {
      state: 'placements';
      /** Placement matches completed. */
      played: number;
      total: number;
      remaining: number;
      /** 0–100, for a progress bar. */
      progressPct: number;
    }
  | { state: 'ranked'; rank: RankedRank; leaderboardRank: number | null }
  | { state: 'unranked' };

/** The subset of a ranked profile the gate needs. Works for `me` and for anyone. */
export interface StandingSource {
  rank: RankedRank | null;
  placement: RankedPlacement;
  leaderboardRank?: number | null;
}

export function standingOf(profile: StandingSource | null | undefined): RankedStanding | null {
  if (!profile) return null;

  const { placement } = profile;
  if (placement.inPlacements) {
    const total = Math.max(0, placement.total);
    const remaining = Math.min(Math.max(0, placement.remaining), total);
    const played = total - remaining;
    return {
      state: 'placements',
      played,
      total,
      remaining,
      progressPct: total === 0 ? 0 : Math.round((played / total) * 100),
    };
  }

  if (profile.rank) {
    return { state: 'ranked', rank: profile.rank, leaderboardRank: profile.leaderboardRank ?? null };
  }
  return { state: 'unranked' };
}

/** `"3 of 10 placement matches"` — the whole of what placements may claim. */
export function placementLabel(s: Extract<RankedStanding, { state: 'placements' }>): string {
  return `${s.played} of ${s.total} placement matches`;
}

/**
 * One line explaining why there is no rank yet. Deliberately never guesses at
 * where the player will land.
 */
export function placementBlurb(s: Extract<RankedStanding, { state: 'placements' }>): string {
  if (s.remaining === s.total) {
    return `Play ${s.total} placement matches and the ladder will give you a rank.`;
  }
  return `${s.remaining} more placement match${s.remaining === 1 ? '' : 'es'} before you are given a rank.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SEASON
// ─────────────────────────────────────────────────────────────────────────────

export interface SeasonCountdown {
  ended: boolean;
  /** Milliseconds left, clamped at 0. */
  remainingMs: number;
  days: number;
  hours: number;
  minutes: number;
  /** Ready-to-render, e.g. `"59 days left"`. */
  text: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long is left in the season.
 *
 * This is a season window, not a countdown to a prize: there is no payout path
 * behind the ladder, and nothing here should be dressed up as one.
 */
export function seasonRemaining(endsAt: string, now: number = Date.now()): SeasonCountdown {
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) {
    return { ended: false, remainingMs: 0, days: 0, hours: 0, minutes: 0, text: 'Season end unknown' };
  }
  const remainingMs = Math.max(0, end - now);
  const days = Math.floor(remainingMs / DAY);
  const hours = Math.floor((remainingMs % DAY) / HOUR);
  const minutes = Math.floor((remainingMs % HOUR) / MINUTE);

  let text: string;
  if (remainingMs <= 0) text = 'Season ended';
  else if (days >= 1) text = `${days} day${days === 1 ? '' : 's'} left`;
  else if (hours >= 1) text = `${hours}h ${minutes}m left`;
  else text = `${Math.max(1, minutes)}m left`;

  return { ended: remainingMs <= 0, remainingMs, days, hours, minutes, text };
}

/** How far through the season we are, 0–100. Clamped at both ends. */
export function seasonProgressPct(startedAt: string, endsAt: string, now: number = Date.now()): number {
  const start = Date.parse(startedAt);
  const end = Date.parse(endsAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100)));
}

// ─────────────────────────────────────────────────────────────────────────────
// LEADERBOARD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An empty ladder is a CORRECT answer, not a broken table.
 *
 * Players still in placements are excluded server-side, so a freshly started
 * season has nobody on it until somebody finishes their ten. The empty state
 * says that, rather than showing headers over nothing or an error.
 */
export const LEADERBOARD_EMPTY_TITLE = 'No ranked players yet this season';
export const LEADERBOARD_EMPTY_BODY =
  'The ladder only lists players who have finished their placement matches. ' +
  'Nobody has finished theirs yet — play yours and you could be the first name on it.';

export function leaderboardIsEmpty(board: RankedLeaderboard | null | undefined): boolean {
  return !board || board.entries.length === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE QUEUE STATE MACHINE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why the queue refused, in terms the UI can act on.
 *
 * Each kind has exactly one useful next step, which is the whole reason for
 * classifying at all: `no-deck` opens the deck screen, `unowned-cards` opens
 * boosters, `already-in-match` offers to rejoin, `rate-limited` says wait.
 */
export type QueueBlockKind =
  | 'no-deck'
  | 'invalid-deck'
  | 'unowned-cards'
  | 'already-in-match'
  | 'rate-limited'
  | 'disabled'
  | 'auth'
  | 'network'
  | 'unknown';

export interface QueueBlock {
  kind: QueueBlockKind;
  /** One line, already player-facing. */
  message: string;
  /** Per-card / per-field detail, when the server sent any. */
  issues: string[];
  /** Set only for `already-in-match` — the match to rejoin. */
  matchID?: string;
  /** Set only for `rate-limited`. */
  retryAfterSec?: number;
}

/** Turn any thrown value into a queue block. Never throws itself. */
export function classifyQueueError(err: unknown): QueueBlock {
  const issues = errorIssues(err);
  const message = errorHeadline(err);

  const rejoin = alreadyInMatchId(err);
  if (rejoin !== null) {
    return {
      kind: 'already-in-match',
      matchID: rejoin,
      issues,
      message: 'You are already in a match. Rejoin it before queueing again.',
    };
  }
  if (isNoActiveDeckError(err)) return { kind: 'no-deck', message, issues };
  if (isInvalidActiveDeckError(err)) return { kind: 'invalid-deck', message, issues };
  if (isUnownedCardsError(err)) return { kind: 'unowned-cards', message, issues };
  if (isRankedDisabledError(err)) {
    return {
      kind: 'disabled',
      issues,
      message: 'Ranked is switched off right now. Casual matches are unaffected.',
    };
  }
  if (err instanceof ApiError) {
    if (err.isRateLimited) {
      return {
        kind: 'rate-limited',
        issues,
        message,
        ...(err.retryAfter !== null ? { retryAfterSec: err.retryAfter } : {}),
      };
    }
    if (err.isAuthError) return { kind: 'auth', message, issues };
    if (err.isNetworkError) return { kind: 'network', message, issues };
  }
  return { kind: 'unknown', message, issues };
}

/**
 * Where the player is with respect to the queue.
 *
 * `matched` is terminal for this machine: once the pairer has seated someone,
 * no later poll and no error may take that pairing away. The handoff to
 * `GET /games/:id/seat` is idempotent, so the caller is free to retry it, and
 * losing the match id because a poll hiccuped would strand the player in a
 * match they cannot see.
 */
export type QueueState =
  | { status: 'idle' }
  | { status: 'joining' }
  | {
      status: 'queued';
      queuedAt: string | null;
      /** As last reported by the server. The UI ticks forward from `queuedAt`. */
      waitedMs: number;
      queueDepth: number;
      region: RankedRegion | null;
      /** How wide the rating search has opened. `null` when the server omits it. */
      mmrWindow: number | null;
    }
  | { status: 'matched'; match: QueuePairing }
  | { status: 'leaving' }
  | { status: 'failed'; block: QueueBlock };

export const IDLE_QUEUE: QueueState = { status: 'idle' };

export type QueueEvent =
  /** The join request is in flight. */
  | { type: 'join' }
  /** `POST /games/ranked/queue` came back. */
  | { type: 'joined'; ticket: QueueTicket }
  /** A poll — or the resume-on-mount read — came back. */
  | { type: 'status'; status: QueueStatus }
  /** The leave request is in flight. */
  | { type: 'leave' }
  /** `DELETE /games/ranked/queue` came back. */
  | { type: 'left' }
  | { type: 'error'; error: unknown }
  /** Dismiss a failure and go back to idle. */
  | { type: 'reset' };

/**
 * The whole queue lifecycle, as one pure function.
 *
 * The rules that matter, and why:
 *
 *  • A poll NEVER resurrects a queue the player has just cancelled. The DELETE
 *    is authoritative; a poll already in flight when they pressed the button
 *    would otherwise put them straight back in line.
 *  • A poll carrying a `match` always wins, from any state. That is the
 *    reconnect path: a player who refreshes mid-queue starts at `idle`, the
 *    first read returns their pairing, and they land in the match.
 *  • A poll that says "not queued" only clears an ACTIVE queue. Arriving in
 *    `joining` it is ignored, because the join has not landed yet; arriving in
 *    `matched` it is ignored, because a pairing is not undone by a stale read.
 *  • An error while `matched` is a handoff problem, not a queue problem, and
 *    leaves the pairing alone so the caller can retry it.
 */
export function queueReducer(state: QueueState, event: QueueEvent): QueueState {
  switch (event.type) {
    case 'join':
      // Already in line, or already paired: joining again is a no-op.
      if (state.status === 'queued' || state.status === 'matched' || state.status === 'joining') return state;
      return { status: 'joining' };

    case 'joined':
      if (state.status === 'matched') return state;
      return {
        status: 'queued',
        queuedAt: event.ticket.queuedAt ?? null,
        waitedMs: 0,
        queueDepth: event.ticket.queueDepth ?? 0,
        region: event.ticket.region ?? null,
        mmrWindow: null,
      };

    case 'status': {
      if (state.status === 'leaving') return state;
      const s = event.status;
      if (s.match) {
        // Re-offering the SAME pairing keeps the same state object, so a
        // consumer keyed on identity does not re-run its seat handoff on every
        // poll. A different match id still wins.
        if (state.status === 'matched' && state.match.matchID === s.match.matchID) return state;
        return { status: 'matched', match: s.match };
      }
      if (state.status === 'matched') return state;
      if (s.queued) {
        return {
          status: 'queued',
          queuedAt: s.queuedAt ?? null,
          waitedMs: Math.max(0, s.waitedMs ?? 0),
          queueDepth: Math.max(0, s.queueDepth ?? 0),
          region: s.region ?? null,
          mmrWindow: s.mmrWindow ?? null,
        };
      }
      // Not queued, not matched.
      if (state.status === 'queued') return { status: 'idle' };
      return state;
    }

    case 'leave':
      // There is no leaving a match. Only a queue.
      if (state.status === 'matched') return state;
      if (state.status === 'idle' || state.status === 'failed') return state;
      return { status: 'leaving' };

    case 'left':
      if (state.status === 'matched') return state;
      return { status: 'idle' };

    case 'error':
      if (state.status === 'matched') return state;
      return { status: 'failed', block: classifyQueueError(event.error) };

    case 'reset':
      return { status: 'idle' };

    default:
      return state;
  }
}

// ── Polling cadence ─────────────────────────────────────────────────────────

/** The server's budget for `GET /games/ranked/queue`, per profile. */
export const QUEUE_POLL_BUDGET = { requests: 180, windowSec: 60 } as const;

/**
 * 2.5s between polls — 24 per minute, comfortably inside the 180/60s budget
 * even with a second tab open, and fast enough that a pairing is noticed
 * before the player wonders whether the button worked.
 */
export const QUEUE_POLL_MS = 2_500;

/** Floor applied after a 429, so a rate limit is never answered with a retry storm. */
export const QUEUE_BACKOFF_MS = 15_000;

/**
 * How long to wait before the next poll, or `null` when there is nothing to
 * poll for.
 *
 * Polling continues while `matched` on purpose: the response is idempotent, so
 * it keeps re-offering the same pairing while the seat handoff is retried.
 */
export function queuePollDelayMs(state: QueueState, retryAfterSec?: number | null): number | null {
  if (state.status !== 'queued' && state.status !== 'matched') return null;
  if (retryAfterSec != null && retryAfterSec > 0) {
    return Math.max(QUEUE_BACKOFF_MS, Math.ceil(retryAfterSec) * 1000);
  }
  return QUEUE_POLL_MS;
}

/**
 * Elapsed queue time, ticked locally from `queuedAt` so the number moves
 * between polls instead of jumping every 2.5 seconds.
 *
 * Falls back to the server's own `waitedMs` when `queuedAt` is missing or
 * unparseable. Never negative — a clock skewed ahead of the server must not
 * render "-3s".
 */
export function queueElapsedMs(state: QueueState, now: number = Date.now()): number {
  if (state.status !== 'queued') return 0;
  if (state.queuedAt) {
    const started = Date.parse(state.queuedAt);
    if (!Number.isNaN(started)) return Math.max(0, now - started);
  }
  return Math.max(0, state.waitedMs);
}

/** `"0:42"` / `"12:05"`. Minutes and seconds; the queue is never hours long. */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * How many players are waiting, said honestly.
 *
 * Note what is NOT here: an ETA. The server sends a queue depth and an MMR
 * window and no estimate, so neither may be turned into one.
 */
export function queueDepthLabel(depth: number): string {
  if (depth <= 0) return 'You are first in the queue';
  if (depth === 1) return '1 player in the queue';
  return `${depth} players in the queue`;
}

/** Whether the outcome should read as a win, a loss, or neither. */
export function outcomeAccent(outcome: RankedMatchEntry['outcome']): 'win' | 'loss' | 'draw' {
  return outcome === 'win' ? 'win' : outcome === 'loss' ? 'loss' : 'draw';
}
