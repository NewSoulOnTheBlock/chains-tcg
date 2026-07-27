// src/error-text.test.ts
//
// The copy layer. These assertions exist because the failure mode is silent:
// a reason with no entry falls back to the server's own prose, which is written
// for an API consumer rather than a player, and nobody notices until a support
// ticket arrives.

import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { errorHeadline, errorIssues, errorText, isDeckBlocked, isHostDeckUnowned } from './error-text';

const withReason = (reason: string, status = 409, details: Record<string, unknown> = {}) =>
  new ApiError({
    status,
    code: status === 409 ? 'conflict' : 'bad_request',
    message: 'raw server prose',
    details: { reason, ...details },
  });

describe('join / deep-link refusals all have player-facing copy', () => {
  // Every reason `POST /games/:id/join` can actually return, per
  // new-backend/services/game/src/routes/lobby.ts.
  const joinReasons = [
    'match_not_open',
    'already_seated',
    'match_incomplete',
    'host_deck_unowned',
    'setup_rejected',
    'no_active_deck',
    'invalid_active_deck',
    'unowned_cards',
  ];

  it.each(joinReasons)('%s does not fall through to the raw server message', (reason) => {
    expect(errorText(withReason(reason))).not.toContain('raw server prose');
  });

  it('tells a deep-link user why the match would not open', () => {
    const text = errorText(withReason('match_not_open'));
    expect(text).toMatch(/no longer open/i);
    // The four situations the server collapses into one reason.
    expect(text).toMatch(/started/i);
    expect(text).toMatch(/filled up/i);
    expect(text).toMatch(/cancelled/i);
  });

  it("does not name the host's cards for host_deck_unowned", () => {
    const err = withReason('host_deck_unowned');
    expect(errorIssues(err)).toEqual([]);
    expect(errorText(err)).toMatch(/pick another match/i);
  });
});

describe('routing a refusal to the right screen', () => {
  it('sends the player to the deck builder for their OWN deck', () => {
    expect(isDeckBlocked(withReason('no_active_deck'))).toBe(true);
    expect(isDeckBlocked(withReason('invalid_active_deck'))).toBe(true);
    expect(isDeckBlocked(withReason('unowned_cards', 400))).toBe(true);
  });

  it("does not send them there for somebody else's deck", () => {
    // There is nothing for the joining player to fix, and the error carries no
    // card detail by design.
    expect(isDeckBlocked(withReason('host_deck_unowned'))).toBe(false);
    expect(isHostDeckUnowned(withReason('host_deck_unowned'))).toBe(true);
    expect(isHostDeckUnowned(withReason('match_not_open'))).toBe(false);
  });
});

describe('errorHeadline', () => {
  const unowned = withReason('unowned_cards', 400, {
    issues: [
      { code: 'unowned', cardId: 'eth_pepe', need: 3, owned: 0, message: 'Your deck runs 3 × PEPE but you own 0.' },
    ],
  });

  it('leaves the per-issue detail out, so a list beside it is not a repeat', () => {
    const headline = errorHeadline(unowned);
    expect(headline).not.toContain('PEPE');
    // `errorText` deliberately DOES fold them in, for single-line call sites.
    expect(errorText(unowned)).toContain('PEPE');
    expect(errorIssues(unowned)).toEqual(['Your deck runs 3 × PEPE but you own 0.']);
  });

  it('reads unowned_cards as a rule, not a fault, and names the fix', () => {
    // A starter deck (22 Nodes + ~38 booster cards) can never pass the ranked
    // ownership check. The player must come away knowing ranked needs minted
    // cards — not that something is broken.
    const headline = errorHeadline(unowned);
    expect(headline).toMatch(/booster/i);
    expect(headline).toMatch(/node/i);
    expect(headline).toMatch(/ranked/i);
  });

  it('still describes network and rate-limit failures', () => {
    const offline = new ApiError({ status: 0, code: 'network_error', message: 'x' });
    expect(errorHeadline(offline)).toMatch(/could not reach the server/i);
    const limited = new ApiError({ status: 429, code: 'rate_limited', message: 'x', retryAfter: 12 });
    expect(errorHeadline(limited)).toContain('12');
  });
});

describe('collection sync failures', () => {
  it('reassures that the stored collection is untouched', () => {
    for (const reason of ['card_chain_unreachable', 'card_chain_error', 'card_index_out_of_sync']) {
      expect(errorText(withReason(reason, 503))).toMatch(/unchanged/i);
    }
  });

  it('is honest when the deployment simply cannot sync', () => {
    expect(errorText(withReason('card_pack_unconfigured', 503))).toMatch(/not available/i);
  });
});
