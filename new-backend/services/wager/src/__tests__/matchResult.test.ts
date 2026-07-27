/**
 * Match-result provenance (C-1).
 *
 * If this HMAC can be bypassed, a row written by anything other than the game
 * service pays out a pot — which is exactly the hole `POST /api/result` was.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalMatchResultMessage,
  signMatchResult,
  verifyMatchResultSig,
  type MatchResultRow,
} from '../domain/matchResult.js';

const SECRET = 'x'.repeat(48);
const FINISHED = new Date('2026-07-27T12:34:56.789Z');

function row(overrides: Partial<MatchResultRow> = {}): MatchResultRow {
  const base = {
    matchId: 'match-abc',
    winnerSeat: 0 as const,
    reason: 'life',
    finishedAt: FINISHED,
  };
  return { ...base, serverSig: signMatchResult(base, SECRET), ...overrides };
}

describe('canonical message', () => {
  it('is stable and newline-separated, with an empty seat for a draw', () => {
    expect(
      canonicalMatchResultMessage({
        matchId: 'm1',
        winnerSeat: null,
        reason: 'timeout',
        finishedAt: FINISHED,
      }),
    ).toBe('m1\n\ntimeout\n2026-07-27T12:34:56.789Z');
  });

  it('distinguishes seat 0 from a draw', () => {
    const draw = canonicalMatchResultMessage({
      matchId: 'm1',
      winnerSeat: null,
      reason: 'life',
      finishedAt: FINISHED,
    });
    const seat0 = canonicalMatchResultMessage({
      matchId: 'm1',
      winnerSeat: 0,
      reason: 'life',
      finishedAt: FINISHED,
    });
    expect(draw).not.toBe(seat0);
  });
});

describe('verifyMatchResultSig', () => {
  it('accepts a row signed with the shared secret', () => {
    expect(verifyMatchResultSig(row(), SECRET)).toBe(true);
  });

  it('rejects a row signed with a different secret', () => {
    expect(verifyMatchResultSig(row(), 'y'.repeat(48))).toBe(false);
  });

  it('rejects a flipped winner — the whole point', () => {
    const tampered = { ...row(), winnerSeat: 1 as const };
    expect(verifyMatchResultSig(tampered, SECRET)).toBe(false);
  });

  it('rejects a changed match id', () => {
    expect(verifyMatchResultSig({ ...row(), matchId: 'other' }, SECRET)).toBe(false);
  });

  it('rejects a changed reason', () => {
    expect(verifyMatchResultSig({ ...row(), reason: 'concede' }, SECRET)).toBe(false);
  });

  it('rejects a changed finish time', () => {
    expect(
      verifyMatchResultSig({ ...row(), finishedAt: new Date(FINISHED.getTime() + 1) }, SECRET),
    ).toBe(false);
  });

  it('rejects an empty, malformed or truncated signature', () => {
    expect(verifyMatchResultSig({ ...row(), serverSig: '' }, SECRET)).toBe(false);
    expect(verifyMatchResultSig({ ...row(), serverSig: 'not-hex!!' }, SECRET)).toBe(false);
    expect(verifyMatchResultSig({ ...row(), serverSig: signMatchResult(row(), SECRET).slice(0, 32) }, SECRET)).toBe(
      false,
    );
  });

  it('accepts an upper-case hex signature', () => {
    const r = row();
    expect(verifyMatchResultSig({ ...r, serverSig: r.serverSig.toUpperCase() }, SECRET)).toBe(true);
  });

  it('rejects an invalid date rather than throwing', () => {
    expect(verifyMatchResultSig({ ...row(), finishedAt: new Date(NaN) }, SECRET)).toBe(false);
  });

  it('rejects an out-of-range winner seat rather than throwing', () => {
    expect(verifyMatchResultSig({ ...row(), winnerSeat: 7 as never }, SECRET)).toBe(false);
  });
});
