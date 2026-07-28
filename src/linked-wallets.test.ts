// src/linked-wallets.test.ts
//
// The linked-wallets copy and pure logic. Same stakes as error-text.test.ts:
// a refusal that falls through to the raw server string reads like a bug, and
// several of these refusals ("linked elsewhere", the relink cooldown) are
// deliberately vague in ways an innocent rewrite would break.

import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  UNLINK_CONSEQUENCES,
  UNLINK_SHORT_WARNING,
  addressFailureReason,
  formatLinkedAt,
  isChainVerificationFailure,
  linkedWalletErrorText,
  needsPromoteFirst,
  relinkEligibleAt,
  sameAddress,
  sortLinkedAddresses,
  unlinkBlockedReason,
  unlinkBlockedText,
  walletKindLabel,
} from './linked-wallets';

const failure = (reason: string, status = 409, details: Record<string, unknown> = {}) =>
  new ApiError({
    status,
    code: status === 409 ? 'conflict' : status === 403 ? 'forbidden' : 'unavailable',
    message: 'raw server prose',
    details: { reason, ...details },
  });

describe('addressFailureReason — where the domain cause lives', () => {
  it('prefers details.reason (the documented envelope)', () => {
    expect(addressFailureReason(failure('address_already_linked'))).toBe('address_already_linked');
  });

  it('falls back to a NON-transport code if a service ever puts the cause there', () => {
    const err = new ApiError({ status: 409, code: 'address_linked_elsewhere', message: 'x' });
    expect(addressFailureReason(err)).toBe('address_linked_elsewhere');
  });

  it('never mistakes a bare transport code for a domain cause', () => {
    const err = new ApiError({ status: 409, code: 'conflict', message: 'x' });
    expect(addressFailureReason(err)).toBeNull();
  });

  it('is null for a non-ApiError', () => {
    expect(addressFailureReason(new Error('nope'))).toBeNull();
  });
});

describe('each named refusal has real words', () => {
  const named = [
    'address_relink_cooldown',
    'address_linked_elsewhere',
    'address_already_linked',
    'primary_address',
    'last_address',
    'chain_unreachable',
    'chain_id_mismatch',
    'chain_call_failed',
  ];

  it.each(named)('%s does not fall through to the raw server message', (reason) => {
    expect(linkedWalletErrorText(failure(reason), 'link')).not.toContain('raw server prose');
  });

  it('the cooldown shows the eligible DATE when the server sends one', () => {
    const err = failure('address_relink_cooldown', 403, { eligibleAt: '2026-08-30T12:00:00Z' });
    const text = linkedWalletErrorText(err, 'link');
    expect(text).toMatch(/2026/);
    expect(text).toMatch(/recently unlinked from another profile/i);
  });

  it('the cooldown stays vague rather than inventing a date it does not have', () => {
    const text = linkedWalletErrorText(failure('address_relink_cooldown', 403), 'link');
    expect(text).toMatch(/30-day/);
    expect(text).not.toMatch(/\bon undefined\b|Invalid Date/i);
  });

  it('relinkEligibleAt rejects garbage timestamps instead of returning Invalid Date', () => {
    expect(relinkEligibleAt(failure('address_relink_cooldown', 403, { eligibleAt: 'soon™' }))).toBeNull();
    expect(relinkEligibleAt(failure('address_relink_cooldown', 403, { eligibleAt: 12345 }))).toBeNull();
    expect(relinkEligibleAt(failure('address_relink_cooldown', 403, { eligibleAt: '2026-08-30T12:00:00Z' }))?.getUTCFullYear()).toBe(2026);
  });

  it('"linked elsewhere" deliberately does not say whose profile holds it', () => {
    const text = linkedWalletErrorText(failure('address_linked_elsewhere'), 'link');
    expect(text).toMatch(/another profile/i);
    expect(text).not.toMatch(/contact|ask|owner|who/i);
  });

  it('"already linked" is calm — it is your own wallet', () => {
    expect(linkedWalletErrorText(failure('address_already_linked'), 'link'))
      .toMatch(/already on your profile/i);
  });

  it('primary_address tells the player the fix, not just the refusal', () => {
    const text = linkedWalletErrorText(failure('primary_address'), 'unlink');
    expect(text).toMatch(/make another wallet primary first/i);
    expect(needsPromoteFirst(failure('primary_address'))).toBe(true);
    expect(needsPromoteFirst(failure('last_address'))).toBe(false);
  });

  it('last_address explains a profile always keeps one', () => {
    expect(linkedWalletErrorText(failure('last_address'), 'unlink')).toMatch(/always keep one/i);
  });

  it('chain failures blame OUR side, never the player’s wallet — and only smart accounts can see them', () => {
    for (const reason of ['chain_unreachable', 'chain_id_mismatch', 'chain_call_failed']) {
      const err = failure(reason, 503);
      expect(isChainVerificationFailure(err)).toBe(true);
      expect(linkedWalletErrorText(err, 'link')).toMatch(/our side/i);
    }
    expect(isChainVerificationFailure(failure('address_already_linked'))).toBe(false);
  });

  it('an unnamed failure falls through to the generic mapper, not to silence', () => {
    const text = linkedWalletErrorText(failure('some_future_reason'), 'link');
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });
});

describe('the pre-press unlink gate mirrors the server', () => {
  const primary = { isPrimary: true, linkedAt: '2026-01-01T00:00:00Z' };
  const extra = { isPrimary: false, linkedAt: '2026-02-01T00:00:00Z' };

  it('the only wallet can never go', () => {
    expect(unlinkBlockedReason(primary, [primary])).toBe('last_address');
  });

  it('the primary cannot go while others remain', () => {
    expect(unlinkBlockedReason(primary, [primary, extra])).toBe('primary_address');
  });

  it('a secondary wallet can go', () => {
    expect(unlinkBlockedReason(extra, [primary, extra])).toBeNull();
  });

  it('the button copy and the server-refusal copy are the SAME words', () => {
    expect(unlinkBlockedText('primary_address')).toBe(linkedWalletErrorText(failure('primary_address'), 'unlink'));
    expect(unlinkBlockedText('last_address')).toBe(linkedWalletErrorText(failure('last_address'), 'unlink'));
  });
});

describe('the unlink warning says what actually happens', () => {
  it('names the three consequences: deletion, re-scan, and cards lost with the wallet', () => {
    const all = UNLINK_CONSEQUENCES.join(' ');
    expect(all).toMatch(/deleted/i);
    expect(all).toMatch(/SCAN CHAIN/);
    expect(all).toMatch(/only by this wallet/i);
    expect(UNLINK_SHORT_WARNING).toMatch(/SCAN CHAIN/);
  });
});

describe('list helpers', () => {
  it('sorts primary first, then oldest link first, without trusting input order', () => {
    const rows = [
      { isPrimary: false, linkedAt: '2026-03-01T00:00:00Z', id: 'c' },
      { isPrimary: true, linkedAt: '2026-02-01T00:00:00Z', id: 'a' },
      { isPrimary: false, linkedAt: '2026-01-15T00:00:00Z', id: 'b' },
    ];
    expect(sortLinkedAddresses(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('sameAddress is case-insensitive and null-safe', () => {
    expect(sameAddress('0xAbC123', '0xabc123')).toBe(true);
    expect(sameAddress('0xAbC123', '0xabc124')).toBe(false);
    expect(sameAddress(null, '0xabc123')).toBe(false);
    expect(sameAddress('0xabc123', undefined)).toBe(false);
  });

  it('kind labels are player words, not enum values', () => {
    expect(walletKindLabel('eoa')).toBe('Browser wallet');
    expect(walletKindLabel('smart')).toBe('Smart account');
  });

  it('formatLinkedAt refuses to render Invalid Date', () => {
    expect(formatLinkedAt('not a date')).toBeNull();
    expect(formatLinkedAt('2026-03-01T00:00:00Z')).toMatch(/^Linked /);
  });
});
