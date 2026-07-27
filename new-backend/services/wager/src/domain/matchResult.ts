/**
 * Provenance of a match outcome (C-1).
 *
 * The game service is the only writer of `game.match_results`. Each row carries
 * `server_sig`, an HMAC-SHA256 over the canonical tuple below, keyed with
 * `MATCH_RESULT_HMAC_SECRET`. The wager service recomputes it before moving any
 * money, so a row injected by anything that does not hold the secret is inert.
 *
 * CANONICAL MESSAGE (both services must agree byte for byte):
 *
 *     <match_id> "\n" <winner_seat|""> "\n" <reason> "\n" <finished_at ISO-8601 UTC, ms>
 *
 * `winner_seat` is the empty string for a draw. `finished_at` is
 * `new Date(...).toISOString()`, i.e. millisecond precision, always UTC, always
 * ending in "Z".
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type WinnerSeat = 0 | 1 | null;

export interface MatchResultRow {
  matchId: string;
  winnerSeat: WinnerSeat;
  reason: string;
  finishedAt: Date;
  serverSig: string;
}

export function canonicalMatchResultMessage(input: {
  matchId: string;
  winnerSeat: WinnerSeat;
  reason: string;
  finishedAt: Date;
}): string {
  const seat = input.winnerSeat === null ? '' : String(input.winnerSeat);
  return [input.matchId, seat, input.reason, input.finishedAt.toISOString()].join('\n');
}

export function signMatchResult(
  input: { matchId: string; winnerSeat: WinnerSeat; reason: string; finishedAt: Date },
  secret: string,
): string {
  return createHmac('sha256', secret).update(canonicalMatchResultMessage(input), 'utf8').digest('hex');
}

/**
 * Constant-time comparison. Returns false for any malformed input rather than
 * throwing, so a corrupt row can never take the worker down.
 */
export function verifyMatchResultSig(row: MatchResultRow, secret: string): boolean {
  if (typeof row.serverSig !== 'string' || row.serverSig.length === 0) return false;
  if (!(row.finishedAt instanceof Date) || Number.isNaN(row.finishedAt.getTime())) return false;
  if (row.winnerSeat !== null && row.winnerSeat !== 0 && row.winnerSeat !== 1) return false;

  const expected = signMatchResult(row, secret);
  const provided = row.serverSig.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(provided)) return false;

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
