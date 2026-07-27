/**
 * Read-only access to the game service's authoritative outcomes.
 *
 * This service NEVER writes to `game.match_results`, and there is no HTTP route
 * anywhere in it that can cause a row to appear. That, plus the HMAC check in
 * `domain/matchResult.ts`, is the whole of C-1's fix.
 */
import type { Pool, PoolClient } from 'pg';
import type { MatchResultRow, WinnerSeat } from '../domain/matchResult.js';

export interface SettlementCandidate extends MatchResultRow {
  escrowId: string;
  escrowStatus: string;
  payoutStatus: string | null;
}

interface RawCandidate {
  match_id: string;
  winner_seat: number | null;
  reason: string;
  finished_at: Date;
  server_sig: string;
  escrow_id: string;
  escrow_status: string;
  payout_status: string | null;
}

function map(row: RawCandidate): SettlementCandidate {
  const seat: WinnerSeat = row.winner_seat === 0 ? 0 : row.winner_seat === 1 ? 1 : null;
  return {
    matchId: row.match_id,
    winnerSeat: seat,
    reason: row.reason,
    finishedAt: row.finished_at,
    serverSig: row.server_sig,
    escrowId: row.escrow_id,
    escrowStatus: row.escrow_status,
    payoutStatus: row.payout_status,
  };
}

/**
 * Finished matches whose escrow still owes money. Includes escrows with a
 * half-finished payout row so a crashed attempt gets reconciled rather than
 * abandoned.
 */
export async function listSettlementCandidates(
  q: Pool | PoolClient,
  limit: number,
): Promise<SettlementCandidate[]> {
  const { rows } = await q.query<RawCandidate>(
    `SELECT r.match_id, r.winner_seat, r.reason, r.finished_at, r.server_sig,
            e.id AS escrow_id, e.status AS escrow_status, p.status AS payout_status
       FROM game.match_results r
       JOIN wager.escrows e ON e.match_id = r.match_id
       LEFT JOIN wager.payouts p ON p.escrow_id = e.id
      WHERE e.status IN ('open', 'funded')
        AND (p.escrow_id IS NULL OR p.status <> 'paid')
        AND (p.lease_until IS NULL OR p.lease_until < now())
      ORDER BY r.finished_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map(map);
}

export async function getMatchResult(
  q: Pool | PoolClient,
  matchId: string,
): Promise<MatchResultRow | null> {
  const { rows } = await q.query<{
    match_id: string;
    winner_seat: number | null;
    reason: string;
    finished_at: Date;
    server_sig: string;
  }>(
    `SELECT match_id, winner_seat, reason, finished_at, server_sig
       FROM game.match_results WHERE match_id = $1`,
    [matchId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    matchId: row.match_id,
    winnerSeat: row.winner_seat === 0 ? 0 : row.winner_seat === 1 ? 1 : null,
    reason: row.reason,
    finishedAt: row.finished_at,
    serverSig: row.server_sig,
  };
}
