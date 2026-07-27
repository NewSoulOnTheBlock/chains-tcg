import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export type ResultReason = 'life' | 'deckout' | 'concede' | 'timeout';

export const RESULT_REASONS: readonly ResultReason[] = ['life', 'deckout', 'concede', 'timeout'];

export function isResultReason(v: unknown): v is ResultReason {
  return typeof v === 'string' && (RESULT_REASONS as readonly string[]).includes(v);
}

export interface SignedResult {
  matchId: string;
  /** null == draw. */
  winnerSeat: 0 | 1 | null;
  reason: ResultReason;
  finishedAt: Date;
}

/**
 * Canonical pre-image for the result HMAC.
 *
 *     <match_id> "\n" <winner_seat|""> "\n" <reason> "\n" <finished_at ISO-8601 UTC, ms>
 *
 * where a draw serialises `winner_seat` as the empty string.
 *
 * The wager service MUST rebuild this string from the columns it read out of
 * `game.match_results` and compare the HMAC — that is what proves the row came
 * from the game service and was not written by anything else with a database
 * connection. The counterpart lives in
 * `services/wager/src/domain/matchResult.ts::canonicalMatchResultMessage` and
 * the two must agree BYTE FOR BYTE; a separator that differs makes every
 * legitimate result unpayable (and was the case until integration).
 *
 * `finished_at` is whatever this service INSERTs into the row — never `now()`,
 * because the database's clock is not what was hashed.
 */
export function resultPreimage(r: SignedResult): string {
  const seat = r.winnerSeat === null ? '' : String(r.winnerSeat);
  return [r.matchId, seat, r.reason, r.finishedAt.toISOString()].join('\n');
}

export function signResult(r: SignedResult): string {
  return createHmac('sha256', config.MATCH_RESULT_HMAC_SECRET)
    .update(resultPreimage(r), 'utf8')
    .digest('hex');
}

/** Constant-time verification, for anyone holding the same secret. */
export function verifyResultSignature(r: SignedResult, signature: string): boolean {
  const expected = Buffer.from(signResult(r), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
