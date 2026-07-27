// src/ranked-client.test.ts
//
// The ladder's logic, tested without a DOM or a network.
//
// The cases that matter are the ones that would lie to a player: showing a rank
// to somebody still in placements, turning an empty season ladder into a broken
// table, resurrecting a queue the player just cancelled, or losing a pairing
// because one poll came back stale.

import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  IDLE_QUEUE,
  LEADERBOARD_EMPTY_TITLE,
  QUEUE_BACKOFF_MS,
  QUEUE_POLL_BUDGET,
  QUEUE_POLL_MS,
  QUEUE_REGION,
  RANKED_TIERS,
  TIER_STYLE,
  UNRANKED_STYLE,
  classifyQueueError,
  formatEndReason,
  formatLp,
  formatLpDelta,
  formatRankLabel,
  formatRankedRecord,
  formatWait,
  leaderboardIsEmpty,
  placementBlurb,
  placementLabel,
  queueDepthLabel,
  queueElapsedMs,
  queuePollDelayMs,
  queueReducer,
  rankedWinRate,
  seasonProgressPct,
  seasonRemaining,
  standingOf,
  tierIndex,
  tierStyle,
  type QueueState,
  type RankedRank,
} from './ranked-client';
import type { QueuePairing, QueueStatus, QueueTicket } from './api/ranked';

// ── Fixtures, shaped exactly like the live server's responses ────────────────

const goldTwo: RankedRank = { tier: 'Gold', division: 2, lp: 40, label: 'Gold II', ordinal: 1040 };
// Mythic still carries a division server-side; it means nothing and the
// server's own label omits it.
const mythic: RankedRank = { tier: 'Mythic', division: 1, lp: 140, label: 'Mythic', ordinal: 2940 };

const placed = {
  rank: goldTwo,
  placement: { remaining: 0, total: 10, inPlacements: false },
  leaderboardRank: 37,
};
/** Verified live shape for a player who has never played this season. */
const brandNew = {
  rank: null,
  placement: { remaining: 10, total: 10, inPlacements: true },
  leaderboardRank: null,
};
const midPlacements = {
  rank: null,
  placement: { remaining: 7, total: 10, inPlacements: true },
  leaderboardRank: null,
};

const pairing: QueuePairing = {
  matchID: 'e2f1c0a8-0000-4000-8000-000000000001',
  seat: 0,
  playerID: '0',
  opponentDisplayName: 'bob',
};

const ticket: QueueTicket = {
  queued: true,
  queuedAt: '2026-07-28T10:00:00.000Z',
  seasonId: 'season-2026-07-27',
  region: 'global',
  queueDepth: 3,
};

const status = (over: Partial<QueueStatus> = {}): QueueStatus => ({
  queued: true,
  queuedAt: '2026-07-28T10:00:00.000Z',
  waitedMs: 12_345,
  region: 'global',
  seasonId: 'season-2026-07-27',
  mmrWindow: 150,
  queueDepth: 4,
  match: null,
  ...over,
});

/** Build the server's error envelope as `ApiError` would parse it. */
const apiError = (status: number, code: string, details: Record<string, unknown> = {}) =>
  new ApiError({ status, code, message: 'Server said no.', details });

// ─────────────────────────────────────────────────────────────────────────────

describe('tiers', () => {
  it('knows the eight tiers, lowest first', () => {
    expect([...RANKED_TIERS]).toEqual([
      'Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Grandmaster', 'Mythic',
    ]);
  });

  it('paints every tier the server can send', () => {
    for (const tier of RANKED_TIERS) {
      expect(TIER_STYLE[tier]).toBeDefined();
      expect(tierStyle(tier)).toBe(TIER_STYLE[tier]);
    }
  });

  it('falls back to the neutral rather than crashing on an unknown tier', () => {
    // A new server tier must not break the client.
    expect(tierStyle('Celestial')).toBe(UNRANKED_STYLE);
    expect(tierStyle(null)).toBe(UNRANKED_STYLE);
    expect(tierStyle(undefined)).toBe(UNRANKED_STYLE);
    expect(tierIndex('Celestial')).toBe(-1);
    expect(tierIndex('Gold')).toBe(2);
  });
});

describe('rank labels', () => {
  it('prefers the label the server already rendered', () => {
    expect(formatRankLabel(goldTwo)).toBe('Gold II');
    expect(formatRankLabel(mythic)).toBe('Mythic');
  });

  it('never reassembles a division for Mythic when it has to fall back', () => {
    expect(formatRankLabel({ ...mythic, label: '' })).toBe('Mythic');
    expect(formatRankLabel({ ...goldTwo, label: '' })).toBe('Gold II');
  });

  it('says "Unranked" rather than inventing a tier', () => {
    expect(formatRankLabel(null)).toBe('Unranked');
    expect(formatRankLabel(undefined)).toBe('Unranked');
  });

  it('formats LP, and a draw as a gain of nothing', () => {
    expect(formatLp(40)).toBe('40 LP');
    expect(formatLpDelta(32)).toBe('+32 LP');
    expect(formatLpDelta(-18)).toBe('−18 LP');
    // `lpDelta` is 0 for draws — "+0 LP" would read as a reward.
    expect(formatLpDelta(0)).toBe('0 LP');
  });

  it('formats a record, hiding draws when there are none', () => {
    expect(formatRankedRecord({ wins: 12, losses: 8, draws: 0 })).toBe('12W · 8L');
    expect(formatRankedRecord({ wins: 88, losses: 20, draws: 1 })).toBe('88W · 20L · 1D');
  });

  it('has no win rate to report before any games are played', () => {
    expect(rankedWinRate({ wins: 0, losses: 0, draws: 0 })).toBeNull();
    expect(rankedWinRate({ wins: 3, losses: 1, draws: 0 })).toBe(75);
  });

  it('translates the four end reasons and passes anything new through', () => {
    expect(formatEndReason('life')).toBe('Life total');
    expect(formatEndReason('deckout')).toBe('Deck out');
    expect(formatEndReason('concede')).toBe('Conceded');
    expect(formatEndReason('timeout')).toBe('Timed out');
    expect(formatEndReason('meteor')).toBe('meteor');
  });
});

describe('the placement gate', () => {
  it('shows progress and NO rank while in placements', () => {
    const s = standingOf(midPlacements);
    expect(s).toEqual({ state: 'placements', played: 3, total: 10, remaining: 7, progressPct: 30 });
    expect(placementLabel(s as never)).toBe('3 of 10 placement matches');
  });

  it('gates on `inPlacements`, not on whether a rank happens to be present', () => {
    // The live server sends `rank: null` throughout placements. If it ever sent
    // both, the rank is still not final — placements must win.
    const s = standingOf({ ...midPlacements, rank: goldTwo });
    expect(s?.state).toBe('placements');
  });

  it('reads a never-played player as a full placement run', () => {
    const s = standingOf(brandNew);
    expect(s).toMatchObject({ state: 'placements', played: 0, remaining: 10, progressPct: 0 });
    expect(placementBlurb(s as never)).toBe('Play 10 placement matches and the ladder will give you a rank.');
  });

  it('counts down the remaining matches in the blurb', () => {
    expect(placementBlurb(standingOf(midPlacements) as never))
      .toBe('7 more placement matches before you are given a rank.');
    expect(placementBlurb(standingOf({ ...brandNew, placement: { remaining: 1, total: 10, inPlacements: true } }) as never))
      .toBe('1 more placement match before you are given a rank.');
  });

  it('shows the rank once placements are done', () => {
    expect(standingOf(placed)).toEqual({ state: 'ranked', rank: goldTwo, leaderboardRank: 37 });
  });

  it('reports an honest absence when the server sends neither', () => {
    // Not expected from the live server. It must still not be filled in.
    expect(standingOf({ rank: null, placement: { remaining: 0, total: 10, inPlacements: false } }))
      .toEqual({ state: 'unranked' });
  });

  it('has nothing to say about a profile that has not loaded', () => {
    expect(standingOf(null)).toBeNull();
    expect(standingOf(undefined)).toBeNull();
  });

  it('clamps a nonsensical placement counter instead of rendering it', () => {
    const s = standingOf({ rank: null, placement: { remaining: 99, total: 10, inPlacements: true } });
    expect(s).toMatchObject({ played: 0, remaining: 10 });
    const neg = standingOf({ rank: null, placement: { remaining: -3, total: 10, inPlacements: true } });
    expect(neg).toMatchObject({ played: 10, remaining: 0, progressPct: 100 });
  });
});

describe('season window', () => {
  const started = '2026-07-27T21:20:12.483Z';
  const ends = '2026-09-25T21:20:12.483Z';

  it('counts whole days down while there are days left', () => {
    const now = Date.parse('2026-07-28T21:20:12.483Z');
    expect(seasonRemaining(ends, now)).toMatchObject({ ended: false, days: 59, text: '59 days left' });
  });

  it('switches to hours and minutes on the last day', () => {
    const now = Date.parse('2026-09-25T18:05:12.483Z');
    expect(seasonRemaining(ends, now).text).toBe('3h 15m left');
  });

  it('never renders a negative countdown', () => {
    const now = Date.parse('2026-10-01T00:00:00.000Z');
    const c = seasonRemaining(ends, now);
    expect(c).toMatchObject({ ended: true, remainingMs: 0, text: 'Season ended' });
  });

  it('says so rather than guessing when the date is unreadable', () => {
    expect(seasonRemaining('not a date').text).toBe('Season end unknown');
  });

  it('reports progress through the season, clamped at both ends', () => {
    expect(seasonProgressPct(started, ends, Date.parse(started))).toBe(0);
    expect(seasonProgressPct(started, ends, Date.parse(ends))).toBe(100);
    expect(seasonProgressPct(started, ends, Date.parse('2026-10-10T00:00:00Z'))).toBe(100);
    expect(seasonProgressPct(started, ends, Date.parse('2026-07-01T00:00:00Z'))).toBe(0);
  });
});

describe('the empty leaderboard', () => {
  it('treats an empty season ladder as a real, expected answer', () => {
    // Verified live: the current season's leaderboard is `entries: []` because
    // nobody has finished placements.
    expect(leaderboardIsEmpty({ seasonId: 's', limit: 3, offset: 0, entries: [] })).toBe(true);
    expect(leaderboardIsEmpty(null)).toBe(true);
    expect(LEADERBOARD_EMPTY_TITLE).toMatch(/no ranked players/i);
  });

  it('is not empty once somebody is on it', () => {
    expect(leaderboardIsEmpty({
      seasonId: 's', limit: 3, offset: 0,
      entries: [{
        rank: 1, profileId: '42', displayName: 'alice', tier: 'Mythic', division: 1,
        lp: 140, label: 'Mythic', record: { wins: 88, losses: 20, draws: 1 },
      }],
    })).toBe(false);
  });
});

describe('queue state machine', () => {
  const queued: QueueState = {
    status: 'queued', queuedAt: ticket.queuedAt, waitedMs: 0, queueDepth: 3, region: 'global', mmrWindow: null,
  };

  it('starts idle', () => {
    expect(IDLE_QUEUE).toEqual({ status: 'idle' });
  });

  it('goes idle → joining → queued', () => {
    const joining = queueReducer(IDLE_QUEUE, { type: 'join' });
    expect(joining.status).toBe('joining');
    expect(queueReducer(joining, { type: 'joined', ticket })).toEqual({
      status: 'queued', queuedAt: ticket.queuedAt, waitedMs: 0, queueDepth: 3, region: 'global', mmrWindow: null,
    });
  });

  it('will not double-join', () => {
    expect(queueReducer(queued, { type: 'join' })).toBe(queued);
    const matched: QueueState = { status: 'matched', match: pairing };
    expect(queueReducer(matched, { type: 'join' })).toBe(matched);
  });

  it('takes the pairing from a poll, from any state — this is the reconnect path', () => {
    // A player who refreshes mid-queue starts at `idle`; the first read is the
    // one that puts them back in their match.
    for (const from of [IDLE_QUEUE, queued, { status: 'joining' } as QueueState]) {
      expect(queueReducer(from, { type: 'status', status: status({ match: pairing }) }))
        .toEqual({ status: 'matched', match: pairing });
    }
  });

  it('resumes an existing queue from idle', () => {
    expect(queueReducer(IDLE_QUEUE, { type: 'status', status: status() })).toEqual({
      status: 'queued', queuedAt: '2026-07-28T10:00:00.000Z', waitedMs: 12_345,
      queueDepth: 4, region: 'global', mmrWindow: 150,
    });
  });

  it('keeps the SAME state object while re-offering the same pairing', () => {
    // The seat handoff is keyed on state identity. A new object every 2.5s
    // would re-run it on every poll instead of only when the pairing changes.
    const matched = queueReducer(queued, { type: 'status', status: status({ match: pairing }) });
    expect(queueReducer(matched, { type: 'status', status: status({ match: pairing }) })).toBe(matched);
    // A DIFFERENT match still wins.
    const other = { ...pairing, matchID: 'other-match' };
    expect(queueReducer(matched, { type: 'status', status: status({ match: other }) }))
      .toEqual({ status: 'matched', match: other });
  });

  it('never lets a later poll take a pairing away', () => {
    const matched = queueReducer(queued, { type: 'status', status: status({ match: pairing }) });
    // A stale read that has forgotten the match must not strand the player.
    expect(queueReducer(matched, { type: 'status', status: status({ queued: false, match: null }) })).toBe(matched);
    expect(queueReducer(matched, { type: 'status', status: status({ match: null }) })).toBe(matched);
  });

  it('never resurrects a queue the player has just cancelled', () => {
    const leaving = queueReducer(queued, { type: 'leave' });
    expect(leaving.status).toBe('leaving');
    // A poll already in flight when they pressed the button.
    expect(queueReducer(leaving, { type: 'status', status: status() })).toBe(leaving);
    expect(queueReducer(leaving, { type: 'left' })).toEqual({ status: 'idle' });
  });

  it('clears an active queue when the server says we are not in it', () => {
    expect(queueReducer(queued, { type: 'status', status: status({ queued: false }) })).toEqual({ status: 'idle' });
  });

  it('ignores a "not queued" read while the join is still in flight', () => {
    const joining = queueReducer(IDLE_QUEUE, { type: 'join' });
    expect(queueReducer(joining, { type: 'status', status: status({ queued: false }) })).toBe(joining);
  });

  it('has no "leave" for a match, only for a queue', () => {
    const matched: QueueState = { status: 'matched', match: pairing };
    expect(queueReducer(matched, { type: 'leave' })).toBe(matched);
    expect(queueReducer(IDLE_QUEUE, { type: 'leave' })).toBe(IDLE_QUEUE);
  });

  it('keeps the pairing when the seat handoff fails, so it can be retried', () => {
    const matched: QueueState = { status: 'matched', match: pairing };
    expect(queueReducer(matched, { type: 'error', error: apiError(500, 'internal') })).toBe(matched);
  });

  it('fails with a block the UI can act on, and can be dismissed', () => {
    const failed = queueReducer(
      { status: 'joining' },
      { type: 'error', error: apiError(400, 'bad_request', { reason: 'no_active_deck' }) },
    );
    expect(failed).toMatchObject({ status: 'failed', block: { kind: 'no-deck' } });
    expect(queueReducer(failed, { type: 'reset' })).toEqual({ status: 'idle' });
  });
});

describe('queue error classification', () => {
  it('routes each refusal to its one useful next step', () => {
    expect(classifyQueueError(apiError(400, 'bad_request', { reason: 'no_active_deck' })).kind).toBe('no-deck');
    expect(classifyQueueError(apiError(400, 'bad_request', { reason: 'invalid_active_deck' })).kind).toBe('invalid-deck');
    expect(classifyQueueError(apiError(400, 'bad_request', { reason: 'unowned_cards' })).kind).toBe('unowned-cards');
    expect(classifyQueueError(apiError(503, 'unavailable', { reason: 'ranked_disabled' })).kind).toBe('disabled');
    expect(classifyQueueError(apiError(401, 'unauthorized')).kind).toBe('auth');
  });

  it('accepts the cause in `code` as well as in `details.reason`', () => {
    // These routes are new; the cause has been specified in both positions.
    expect(classifyQueueError(apiError(400, 'no_active_deck')).kind).toBe('no-deck');
    expect(classifyQueueError(apiError(503, 'ranked_disabled')).kind).toBe('disabled');
  });

  it('carries the match id out of a 409 so the player can rejoin', () => {
    const block = classifyQueueError(
      apiError(409, 'conflict', { reason: 'already_in_match', matchID: 'abc-123' }),
    );
    expect(block).toMatchObject({ kind: 'already-in-match', matchID: 'abc-123' });
  });

  it('carries the retry delay out of a 429', () => {
    const err = new ApiError({ status: 429, code: 'rate_limited', message: 'Slow down', retryAfter: 42 });
    expect(classifyQueueError(err)).toMatchObject({ kind: 'rate-limited', retryAfterSec: 42 });
  });

  it('lists the cards a deck is short of', () => {
    const block = classifyQueueError(apiError(400, 'bad_request', {
      reason: 'unowned_cards',
      issues: [{ code: 'unowned', cardId: 'x', need: 3, owned: 1, message: 'You own 1 of 3 Foo.' }],
    }));
    expect(block.issues).toEqual(['You own 1 of 3 Foo.']);
  });

  it('never throws on something that is not an ApiError', () => {
    expect(classifyQueueError(new Error('boom'))).toMatchObject({ kind: 'unknown', message: 'boom' });
    expect(classifyQueueError('nonsense').kind).toBe('unknown');
  });
});

describe('polling', () => {
  it('polls only while there is something to poll for', () => {
    expect(queuePollDelayMs({ status: 'idle' })).toBeNull();
    expect(queuePollDelayMs({ status: 'joining' })).toBeNull();
    expect(queuePollDelayMs({ status: 'leaving' })).toBeNull();
    expect(queuePollDelayMs({ status: 'failed', block: { kind: 'unknown', message: '', issues: [] } })).toBeNull();
  });

  it('keeps polling while matched, because the handoff may need retrying', () => {
    expect(queuePollDelayMs({ status: 'matched', match: pairing })).toBe(QUEUE_POLL_MS);
  });

  it('stays well inside the server budget', () => {
    const perMinute = 60_000 / QUEUE_POLL_MS;
    expect(perMinute).toBeLessThan(QUEUE_POLL_BUDGET.requests / QUEUE_POLL_BUDGET.windowSec * 60);
    // Two tabs open must still not exhaust it.
    expect(perMinute * 2).toBeLessThan(QUEUE_POLL_BUDGET.requests);
  });

  it('backs off hard after a 429 rather than answering a rate limit with a storm', () => {
    const queued: QueueState = {
      status: 'queued', queuedAt: null, waitedMs: 0, queueDepth: 0, region: 'global', mmrWindow: null,
    };
    expect(queuePollDelayMs(queued, 2)).toBe(QUEUE_BACKOFF_MS);
    expect(queuePollDelayMs(queued, 30)).toBe(30_000);
    expect(queuePollDelayMs(queued, null)).toBe(QUEUE_POLL_MS);
  });
});

describe('wait time', () => {
  const at = (iso: string | null, waitedMs = 0): QueueState => ({
    status: 'queued', queuedAt: iso, waitedMs, queueDepth: 0, region: 'global', mmrWindow: null,
  });

  it('ticks forward locally from queuedAt', () => {
    const now = Date.parse('2026-07-28T10:00:42.000Z');
    expect(queueElapsedMs(at('2026-07-28T10:00:00.000Z'), now)).toBe(42_000);
  });

  it('falls back to the server figure when queuedAt is unusable', () => {
    expect(queueElapsedMs(at(null, 9_000), Date.now())).toBe(9_000);
    expect(queueElapsedMs(at('garbage', 9_000), Date.now())).toBe(9_000);
  });

  it('never goes negative on a client clock running ahead of the server', () => {
    const now = Date.parse('2026-07-28T09:59:00.000Z');
    expect(queueElapsedMs(at('2026-07-28T10:00:00.000Z'), now)).toBe(0);
  });

  it('has no elapsed time when not queued', () => {
    expect(queueElapsedMs({ status: 'idle' })).toBe(0);
    expect(queueElapsedMs({ status: 'matched', match: pairing })).toBe(0);
  });

  it('formats as minutes and seconds', () => {
    expect(formatWait(0)).toBe('0:00');
    expect(formatWait(42_000)).toBe('0:42');
    expect(formatWait(725_000)).toBe('12:05');
    expect(formatWait(-5)).toBe('0:00');
  });

  it('reports queue depth without inventing an ETA', () => {
    expect(queueDepthLabel(0)).toBe('You are first in the queue');
    expect(queueDepthLabel(1)).toBe('1 player in the queue');
    expect(queueDepthLabel(4)).toBe('4 players in the queue');
  });
});

describe('regions', () => {
  it('only ever sends global — the pairer matches within a region', () => {
    expect(QUEUE_REGION).toBe('global');
  });
});
