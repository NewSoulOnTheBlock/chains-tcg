/**
 * Payout persistence — the durable half of the exactly-once settlement story.
 *
 * Two tables:
 *
 *   wager.payouts      one DECISION per escrow (PK = escrow_id). Two workers
 *                      that both decide to settle the same match cannot both
 *                      act: the loser of the INSERT sees the existing row.
 *   wager.payout_legs  one TRANSACTION per recipient. EVM has no batching
 *                      primitive without a deployed contract, so a draw refund
 *                      is two transfers; each leg carries its own hash and
 *                      nonce and is confirmed independently.
 *
 * Leg state machine:
 *
 *   preparing ──(hash + nonce recorded, BEFORE broadcast)──▶ sending ──▶ paid
 *        ▲                                                      │
 *        └──────────(reverted: no funds moved, rebuild)──────────┘
 *
 * `tx_hash` is globally unique, so one on-chain transaction can never be
 * credited to two legs.
 */
import type { Pool, PoolClient } from 'pg';
import type { PayoutKind, PayoutPlan } from '../domain/settlement.js';

export type PayoutStatus = 'preparing' | 'sending' | 'paid' | 'failed';
export type LegStatus = 'preparing' | 'sending' | 'paid' | 'failed';

export interface PayoutRow {
  escrowId: string;
  kind: PayoutKind;
  winnerSeat: number | null;
  amountBase: bigint;
  burnBase: bigint;
  status: PayoutStatus;
  txSig: string | null;
  idempotencyKey: string;
  attempts: number;
  lastError: string | null;
  leaseUntil: Date | null;
  createdAt: Date;
  paidAt: Date | null;
}

interface RawPayout {
  escrow_id: string;
  kind: PayoutKind;
  winner_seat: number | null;
  amount_base: string;
  burn_base: string;
  status: PayoutStatus;
  tx_sig: string | null;
  idempotency_key: string;
  attempts: number;
  last_error: string | null;
  lease_until: Date | null;
  created_at: Date;
  paid_at: Date | null;
}

const COLUMNS = `escrow_id, kind, winner_seat, amount_base, burn_base, status, tx_sig,
                 idempotency_key, attempts, last_error, lease_until, created_at, paid_at`;

function map(row: RawPayout): PayoutRow {
  return {
    escrowId: row.escrow_id,
    kind: row.kind,
    winnerSeat: row.winner_seat,
    amountBase: BigInt(row.amount_base),
    burnBase: BigInt(row.burn_base),
    status: row.status,
    txSig: row.tx_sig,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    lastError: row.last_error,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

export async function getPayout(q: Pool | PoolClient, escrowId: string): Promise<PayoutRow | null> {
  const { rows } = await q.query<RawPayout>(
    `SELECT ${COLUMNS} FROM wager.payouts WHERE escrow_id = $1`,
    [escrowId],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function lockPayout(client: PoolClient, escrowId: string): Promise<PayoutRow | null> {
  const { rows } = await client.query<RawPayout>(
    `SELECT ${COLUMNS} FROM wager.payouts WHERE escrow_id = $1 FOR UPDATE`,
    [escrowId],
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * Create the payout decision if this worker is the first to reach it. Returns
 * the existing row (and `claimed: false`) when someone already did.
 */
export async function claimPayout(
  client: PoolClient,
  input: {
    escrowId: string;
    kind: PayoutKind;
    winnerSeat: number | null;
    amountBase: bigint;
    burnBase: bigint;
    idempotencyKey: string;
    leaseSeconds: number;
  },
): Promise<{ row: PayoutRow; claimed: boolean }> {
  const inserted = await client.query<RawPayout>(
    `INSERT INTO wager.payouts
       (escrow_id, kind, winner_seat, amount_base, burn_base, status, idempotency_key, lease_until)
     VALUES ($1, $2, $3, $4, $5, 'preparing', $6,
             CASE WHEN $7 > 0 THEN now() + make_interval(secs => $7) ELSE NULL END)
     ON CONFLICT (escrow_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.escrowId,
      input.kind,
      input.winnerSeat,
      input.amountBase.toString(),
      input.burnBase.toString(),
      input.idempotencyKey,
      input.leaseSeconds,
    ],
  );
  if (inserted.rows[0]) return { row: map(inserted.rows[0]), claimed: true };

  const existing = await lockPayout(client, input.escrowId);
  if (!existing) throw new Error(`payout row for ${input.escrowId} disappeared`);
  return { row: existing, claimed: false };
}

/**
 * Take over a stalled payout. Succeeds only when the previous lease expired, so
 * a healthy worker is never interrupted mid-flight.
 */
export async function takeLease(
  client: PoolClient,
  escrowId: string,
  leaseSeconds: number,
): Promise<PayoutRow | null> {
  const { rows } = await client.query<RawPayout>(
    `UPDATE wager.payouts
        SET lease_until = now() + make_interval(secs => $2), attempts = attempts + 1
      WHERE escrow_id = $1
        AND status IN ('preparing', 'sending', 'failed')
        AND (lease_until IS NULL OR lease_until < now())
      RETURNING ${COLUMNS}`,
    [escrowId, leaseSeconds],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function markPayoutPaid(
  q: Pool | PoolClient,
  escrowId: string,
  txSig: string | null,
): Promise<void> {
  await q.query(
    `UPDATE wager.payouts
        SET status = 'paid', paid_at = now(), tx_sig = $2, lease_until = NULL, last_error = NULL
      WHERE escrow_id = $1`,
    [escrowId, txSig],
  );
}

export async function markPayoutFailed(
  q: Pool | PoolClient,
  escrowId: string,
  reason: string,
): Promise<void> {
  await q.query(
    `UPDATE wager.payouts SET status = 'failed', last_error = $2, lease_until = NULL
      WHERE escrow_id = $1 AND status <> 'paid'`,
    [escrowId, reason.slice(0, 500)],
  );
}

/**
 * Operator void over an escrow whose settlement never got off the ground.
 *
 * Deliberately refuses when anything has been signed: the `NOT EXISTS` guard
 * proves no transaction for this escrow exists anywhere, so redirecting the
 * decision cannot race a payment that is still propagating.
 */
export async function repurposePayoutForVoid(
  client: PoolClient,
  input: { escrowId: string; amountBase: bigint; idempotencyKey: string },
): Promise<PayoutRow | null> {
  const { rows } = await client.query<RawPayout>(
    `UPDATE wager.payouts
        SET kind = 'void_refund', winner_seat = NULL, amount_base = $2, burn_base = 0,
            status = 'preparing', idempotency_key = $3, last_error = NULL, lease_until = NULL
      WHERE escrow_id = $1
        AND status <> 'paid'
        AND NOT EXISTS (
          SELECT 1 FROM wager.payout_legs l
           WHERE l.escrow_id = $1 AND l.tx_hash IS NOT NULL
        )
      RETURNING ${COLUMNS}`,
    [input.escrowId, input.amountBase.toString(), input.idempotencyKey],
  );
  if (!rows[0]) return null;
  // Safe: the guard above proved no leg of this escrow was ever signed.
  await client.query(`DELETE FROM wager.payout_legs WHERE escrow_id = $1`, [input.escrowId]);
  return map(rows[0]);
}

// ── legs ────────────────────────────────────────────────────────────────────

export interface LegRow {
  escrowId: string;
  legIndex: number;
  toAddress: string;
  amountBase: bigint;
  purpose: string;
  status: LegStatus;
  txHash: string | null;
  rawTx: string | null;
  nonce: number | null;
  attempts: number;
  lastError: string | null;
  paidAt: Date | null;
}

interface RawLeg {
  escrow_id: string;
  leg_index: number;
  to_address: string;
  amount_base: string;
  purpose: string;
  status: LegStatus;
  tx_hash: string | null;
  raw_tx: string | null;
  nonce: string | null;
  attempts: number;
  last_error: string | null;
  paid_at: Date | null;
}

const LEG_COLUMNS = `escrow_id, leg_index, to_address, amount_base, purpose, status,
                     tx_hash, raw_tx, nonce, attempts, last_error, paid_at`;

function mapLeg(row: RawLeg): LegRow {
  return {
    escrowId: row.escrow_id,
    legIndex: row.leg_index,
    toAddress: row.to_address,
    amountBase: BigInt(row.amount_base),
    purpose: row.purpose,
    status: row.status,
    txHash: row.tx_hash,
    rawTx: row.raw_tx,
    nonce: row.nonce === null ? null : Number(row.nonce),
    attempts: row.attempts,
    lastError: row.last_error,
    paidAt: row.paid_at,
  };
}

/**
 * Materialise the plan's legs. Idempotent: a re-run inserts nothing, so the
 * legs a decision was made with can never be rewritten underneath an in-flight
 * transaction.
 */
export async function ensureLegs(
  client: PoolClient,
  escrowId: string,
  plan: PayoutPlan,
): Promise<void> {
  for (const leg of plan.legs) {
    await client.query(
      `INSERT INTO wager.payout_legs
         (escrow_id, leg_index, to_address, amount_base, purpose, status)
       VALUES ($1, $2, $3, $4, $5, 'preparing')
       ON CONFLICT (escrow_id, leg_index) DO NOTHING`,
      [escrowId, leg.index, leg.to, leg.amountBase.toString(), leg.purpose],
    );
  }
}

export async function listLegs(q: Pool | PoolClient, escrowId: string): Promise<LegRow[]> {
  const { rows } = await q.query<RawLeg>(
    `SELECT ${LEG_COLUMNS} FROM wager.payout_legs WHERE escrow_id = $1 ORDER BY leg_index`,
    [escrowId],
  );
  return rows.map(mapLeg);
}

/**
 * Record a SIGNED-BUT-NOT-YET-BROADCAST transaction for one leg.
 * Nothing is ever broadcast before this commits.
 */
export async function recordLegAttempt(
  q: Pool | PoolClient,
  input: { escrowId: string; legIndex: number; txHash: string; rawTx: string; nonce: number },
): Promise<void> {
  await q.query(
    `UPDATE wager.payout_legs
        SET tx_hash = $3, raw_tx = $4, nonce = $5, status = 'sending',
            attempts = attempts + 1, last_error = NULL
      WHERE escrow_id = $1 AND leg_index = $2 AND status <> 'paid'`,
    [input.escrowId, input.legIndex, input.txHash, input.rawTx, input.nonce],
  );
}

export async function markLegPaid(
  q: Pool | PoolClient,
  escrowId: string,
  legIndex: number,
): Promise<void> {
  await q.query(
    `UPDATE wager.payout_legs SET status = 'paid', paid_at = now(), last_error = NULL
      WHERE escrow_id = $1 AND leg_index = $2`,
    [escrowId, legIndex],
  );
}

/**
 * The recorded transaction reverted, so no funds moved and a replacement may be
 * built. The nonce is DELIBERATELY kept on the row: reusing it means the
 * replacement and the original are mutually exclusive on-chain.
 */
export async function resetLegForRebuild(
  q: Pool | PoolClient,
  escrowId: string,
  legIndex: number,
  reason: string,
): Promise<void> {
  await q.query(
    `UPDATE wager.payout_legs
        SET status = 'preparing', tx_hash = NULL, raw_tx = NULL, last_error = $3
      WHERE escrow_id = $1 AND leg_index = $2 AND status <> 'paid'`,
    [escrowId, legIndex, reason.slice(0, 500)],
  );
}

/**
 * Allocate the next nonce for the escrow account.
 *
 * `pg_advisory_xact_lock` serialises allocation across replicas, and the result
 * is the greater of the chain's pending nonce and one past the highest nonce we
 * have already handed out — so a transaction that has not yet propagated to the
 * node we happen to ask cannot cause a nonce to be issued twice.
 */
export async function allocateNonce(
  client: PoolClient,
  chainPendingNonce: number,
): Promise<number> {
  // Fixed key: every replica must contend on the same lock.
  await client.query(`SELECT pg_advisory_xact_lock(4004, 1)`);
  const { rows } = await client.query<{ max_nonce: string | null }>(
    `SELECT MAX(nonce)::text AS max_nonce FROM wager.payout_legs WHERE nonce IS NOT NULL`,
  );
  const raw = rows[0]?.max_nonce ?? null;
  const highestUsed = raw === null ? -1 : Number(raw);
  return Math.max(chainPendingNonce, highestUsed + 1);
}
