/**
 * Escrow lifecycle: create, inspect, fund, void.
 *
 * Identity rule for this whole module: the caller is `auth` (from the verified
 * session) and the seat comes from `game.matches`. No function here reads a
 * wallet, a player id or an amount from a request body.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError, getPool, isUniqueViolation, withTransaction } from '../platform/shared.js';
import type { AuthContext } from '../platform/shared.js';
import { log } from '../platform/logger.js';
import {
  getEscrowById,
  getEscrowByMatchId,
  getMatchSeats,
  insertDeposit,
  insertEscrow,
  listDeposits,
  lockDeposits,
  lockEscrow,
  seatForProfile,
  setEscrowStatus,
  type DepositRow,
  type EscrowRow,
  type MatchSeats,
} from '../db/escrows.js';
import { appendAudit } from '../db/audit.js';
import { claimPayout, getPayout, repurposePayoutForVoid } from '../db/payouts.js';
import { violatedConstraint } from '../db/errors.js';
import type { Seat } from '../domain/seat.js';
import { verifyDepositTx } from '../domain/deposit.js';
import { planVoidRefund, payoutIdempotencyKey, type FundedSeat } from '../domain/settlement.js';
import { executePayout, type PayoutRunnerDeps } from './payoutRunner.js';
import type { ChainReader } from '../chain/types.js';
import type { StakePolicy } from '../domain/stakes.js';

export interface EscrowServiceDeps {
  reader: ChainReader;
  payout: PayoutRunnerDeps;
  stakes: StakePolicy;
  /** ERC-20 contract the escrow accepts, lower-case. */
  token: string;
  decimals: number;
  /** Address deposits must credit, lower-case. Recorded on each new escrow. */
  depositAddress: string;
  minConfirmations: number;
  /** Bounds how long a deposit transaction may hold its row locks. */
  depositTxTimeoutSeconds: number;
}

export interface EscrowView {
  id: string;
  matchId: string;
  amountBase: string;
  token: string;
  decimals: number;
  status: string;
  createdAt: string;
  /** Which seat the CALLER holds, derived from the match's seat mapping. */
  yourSeat: Seat | null;
  /** Where this escrow's deposits must be sent. */
  depositAddress: string;
  /** Funding state per seat — booleans only, never the other player's address. */
  seats: Array<{ seat: Seat; funded: boolean; isYou: boolean }>;
  payout: { status: string; txSig: string | null } | null;
}

function assertParticipant(seat: Seat | null): asserts seat is Seat {
  if (seat === null) {
    throw AppError.forbidden('You are not a player in this match', { reason: 'not_a_participant' });
  }
}

function toView(
  deps: EscrowServiceDeps,
  escrow: EscrowRow,
  seats: MatchSeats,
  deposits: DepositRow[],
  auth: AuthContext,
  payoutRow: { status: string; txSig: string | null } | null,
): EscrowView {
  const yourSeat = seatForProfile(seats, auth.profileId);
  const funded = new Set(deposits.map((d) => d.seat));

  return {
    id: escrow.id,
    matchId: escrow.matchId,
    amountBase: escrow.amountBase.toString(),
    token: escrow.token,
    decimals: deps.decimals,
    status: escrow.status,
    createdAt: escrow.createdAt.toISOString(),
    yourSeat,
    depositAddress: escrow.depositAddress,
    // Booleans only. The opponent's wallet address is never disclosed here
    // (H-2 / H-7: no wallet addresses in anything a second party can read).
    seats: ([0, 1] as Seat[]).map((s) => ({
      seat: s,
      funded: funded.has(s),
      isYou: s === yourSeat,
    })),
    payout: payoutRow,
  };
}

export async function createEscrow(
  deps: EscrowServiceDeps,
  auth: AuthContext,
  input: { matchId: string; tier: number },
): Promise<EscrowView> {
  // The amount is NEVER taken from the request. The client names a tier index;
  // the server resolves it against the env allowlist.
  const amountBase = deps.stakes.amountForTier(input.tier);
  if (amountBase === null) {
    throw AppError.badRequest('That stake tier is not offered', {
      reason: 'unknown_stake_tier',
      tiers: deps.stakes.list(),
    });
  }

  const pool = getPool();
  const seats = await getMatchSeats(pool, input.matchId);
  if (!seats) throw AppError.notFound('Match does not exist', { reason: 'match_not_found' });
  const seat = seatForProfile(seats, auth.profileId);
  assertParticipant(seat);
  if (seats.status !== 'open' && seats.status !== 'live') {
    throw AppError.conflict('This match can no longer take a wager', {
      reason: 'match_not_joinable',
    });
  }

  const existing = await getEscrowByMatchId(pool, input.matchId);
  if (existing) {
    if (existing.amountBase !== amountBase) {
      throw AppError.conflict('This match already has an escrow at a different stake', {
        reason: 'stake_mismatch',
      });
    }
    return toView(deps, existing, seats, await listDeposits(pool, existing.id), auth, null);
  }

  let escrow: EscrowRow;
  try {
    escrow = await insertEscrow(pool, {
      id: randomUUID(),
      matchId: input.matchId,
      amountBase,
      token: deps.token,
      depositAddress: deps.depositAddress,
    });
  } catch (err) {
    // Lost a race with the opponent creating the same match's escrow.
    const raced = isUniqueViolation(err) ? await getEscrowByMatchId(pool, input.matchId) : null;
    if (!raced) throw err;
    escrow = raced;
  }

  log().info('escrow_created', {
    escrow_id: escrow.id,
    match_id: escrow.matchId,
    tier: input.tier,
  });
  return toView(deps, escrow, seats, [], auth, null);
}

export async function viewEscrow(
  deps: EscrowServiceDeps,
  auth: AuthContext,
  escrowId: string,
): Promise<EscrowView> {
  const pool = getPool();
  const escrow = await getEscrowById(pool, escrowId);
  if (!escrow) throw AppError.notFound('Escrow does not exist', { reason: 'escrow_not_found' });

  const seats = await getMatchSeats(pool, escrow.matchId);
  if (!seats) throw AppError.notFound('Match does not exist', { reason: 'match_not_found' });

  const seat = seatForProfile(seats, auth.profileId);
  if (seat === null && !auth.roles.includes('operator')) {
    throw AppError.forbidden('You are not a player in this match', { reason: 'not_a_participant' });
  }

  const payoutRow = await getPayout(pool, escrow.id);
  return toView(
    deps,
    escrow,
    seats,
    await listDeposits(pool, escrow.id),
    auth,
    payoutRow ? { status: payoutRow.status, txSig: payoutRow.txSig } : null,
  );
}

export interface DepositResult {
  accepted: true;
  seat: Seat;
  escrowStatus: string;
  bothSeatsFunded: boolean;
}

/**
 * Record a deposit (C-2).
 *
 * ORDER MATTERS. Inside ONE transaction we:
 *   1. lock the escrow row,
 *   2. resolve the caller's seat from the match's seat mapping,
 *   3. INSERT the deposit — the idempotency barrier, BEFORE any chain lookup,
 *   4. verify the transaction on-chain,
 *   5. roll the whole thing back if verification fails.
 *
 * WHY A REPLAYED TRANSACTION CANNOT FUND A SECOND SEAT.
 * `wager.deposits.signature` holds the transaction hash and is the PRIMARY KEY
 * of the table — not unique per escrow, not unique per seat, but globally
 * unique across every escrow that will ever exist. Step 3 therefore raises
 * 23505 the moment the same hash is presented again, whether for the other seat
 * of this escrow, a different escrow, or a different match; and
 * `unique (escrow_id, seat)` independently caps a seat at one deposit. Because
 * the insert precedes the RPC call there is no window in which two concurrent
 * requests both "check, then insert" — the second blocks on the index and then
 * fails.
 *
 * The seat itself is never nameable: it is looked up from `game.matches` for
 * `auth.profileId`, so a caller can only ever fund the seat they hold.
 *
 * The legacy `markFunded` stored the signature in a per-seat column
 * (`p0_sig` / `p1_sig`) and compared a new signature only against that same
 * seat's previous value, so one transfer could be replayed into the opposite
 * seat. A draw then refunded two stakes out of one deposit — the money printer.
 */
export async function submitDeposit(
  deps: EscrowServiceDeps,
  auth: AuthContext,
  input: { escrowId: string; txHash: string },
): Promise<DepositResult> {
  return withTransaction(async (client: PoolClient) => {
    // Bound the time this transaction may hold locks while we talk to the RPC.
    await client.query(`SELECT set_config('idle_in_transaction_session_timeout', $1, true)`, [
      `${deps.depositTxTimeoutSeconds}s`,
    ]);

    const escrow = await lockEscrow(client, input.escrowId);
    if (!escrow) throw AppError.notFound('Escrow does not exist', { reason: 'escrow_not_found' });
    if (escrow.status !== 'open' && escrow.status !== 'funded') {
      throw AppError.conflict('This escrow is no longer accepting deposits', {
        reason: 'escrow_closed',
      });
    }

    const seats = await getMatchSeats(client, escrow.matchId);
    if (!seats) throw AppError.notFound('Match does not exist', { reason: 'match_not_found' });
    const seat = seatForProfile(seats, auth.profileId);
    assertParticipant(seat);

    // (3) Insert first. The database is the guard.
    try {
      await insertDeposit(client, {
        signature: input.txHash,
        escrowId: escrow.id,
        seat,
        profileId: auth.profileId,
        fromAddress: auth.address,
        amountBase: escrow.amountBase,
        blockNumber: null,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const constraint = violatedConstraint(err) ?? '';
        if (constraint.includes('seat')) {
          throw AppError.conflict('This seat has already been funded', {
            reason: 'seat_already_funded',
          });
        }
        throw AppError.conflict('That transaction has already been recorded as a deposit', {
          reason: 'signature_already_used',
        });
      }
      throw err;
    }

    // (4) Now, and only now, ask the chain.
    const tx = await deps.reader.getTransaction(input.txHash);
    const verdict = verifyDepositTx(tx, {
      escrowId: escrow.id,
      seat,
      amountBase: escrow.amountBase,
      token: escrow.token,
      depositAddress: escrow.depositAddress,
      depositorAddress: auth.address.toLowerCase(),
      escrowCreatedAtSeconds: Math.floor(escrow.createdAt.getTime() / 1000),
      minConfirmations: deps.minConfirmations,
    });

    if (!verdict.ok) {
      // (5) Rolling back removes the reservation, so an honest retry after a
      // propagation delay still works — but nothing was ever credited.
      log().warn('deposit_rejected', { escrow_id: escrow.id, seat, deposit_reason: verdict.code });
      throw verdict.retryable
        ? AppError.conflict(verdict.message, {
            reason: `deposit_${verdict.code}`,
            retryable: true,
          })
        : AppError.badRequest(verdict.message, {
            reason: `deposit_${verdict.code}`,
            retryable: false,
          });
    }

    await client.query(
      `UPDATE wager.deposits
          SET block_number = $2, block_time = to_timestamp($3), log_index = $4
        WHERE signature = $1`,
      [input.txHash, String(verdict.blockNumber), verdict.blockTimestamp, verdict.logIndex],
    );

    const deposits = await lockDeposits(client, escrow.id);
    const both = deposits.length >= 2;
    if (both && escrow.status !== 'funded') {
      await setEscrowStatus(client, escrow.id, 'funded');
    }

    log().info('deposit_accepted', { escrow_id: escrow.id, seat, both_funded: both });
    return {
      accepted: true as const,
      seat,
      escrowStatus: both ? 'funded' : escrow.status,
      bothSeatsFunded: both,
    };
  });
}

export interface VoidResult {
  escrowId: string;
  refunded: Array<{ seat: Seat; amountBase: string }>;
  payoutState: string;
  txSig: string | null;
}

/**
 * Operator escape hatch for stuck escrows. The route declares
 * `roles: ['operator']`, so `route()` installs `requireAuth()` +
 * `requireRole('operator')` itself. A reason is mandatory and is written to
 * `core.audit_log` in the SAME transaction that redirects the payout.
 */
export async function voidEscrow(
  deps: EscrowServiceDeps,
  auth: AuthContext,
  input: { escrowId: string; reason: string; requestId?: string },
): Promise<VoidResult> {
  const prepared = await withTransaction(async (client: PoolClient) => {
    const escrow = await lockEscrow(client, input.escrowId);
    if (!escrow) throw AppError.notFound('Escrow does not exist', { reason: 'escrow_not_found' });
    if (escrow.status === 'settled' || escrow.status === 'refunded' || escrow.status === 'void') {
      throw AppError.conflict(`Escrow is already ${escrow.status}`, { reason: 'escrow_final' });
    }

    const deposits = await lockDeposits(client, escrow.id);
    const funded: FundedSeat[] = deposits.map((d) => ({
      seat: d.seat,
      address: d.fromAddress,
      amountBase: d.amountBase,
    }));
    const plan = planVoidRefund(funded);
    const key = payoutIdempotencyKey(escrow.id, plan, null);

    const existing = await getPayout(client, escrow.id);
    if (existing) {
      if (existing.status === 'paid') {
        throw AppError.conflict('This escrow has already paid out', { reason: 'already_paid' });
      }
      // No lease is set, so executePayout below can take it immediately.
      const repurposed = await repurposePayoutForVoid(client, {
        escrowId: escrow.id,
        amountBase: plan.totalBase,
        idempotencyKey: key,
      });
      if (!repurposed) {
        throw AppError.conflict(
          'A payout transaction for this escrow is already signed; reconcile it before voiding',
          { reason: 'payout_in_flight' },
        );
      }
    } else {
      await claimPayout(client, {
        escrowId: escrow.id,
        kind: plan.kind,
        winnerSeat: null,
        amountBase: plan.totalBase,
        burnBase: 0n,
        idempotencyKey: key,
        leaseSeconds: 0,
      });
    }

    await appendAudit(client, {
      actorProfileId: auth.profileId,
      actorAddress: auth.address,
      actorRoles: auth.roles,
      action: 'wager.void',
      subject: escrow.id,
      reason: input.reason,
      details: {
        match_id: escrow.matchId,
        funded_seats: funded.map((f) => f.seat),
        total_base: plan.totalBase.toString(),
      },
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });

    return { plan, key, funded };
  });

  // The payout row exists with no lease, so executePayout resumes this decision
  // rather than forming a new one.
  const outcome = await executePayout(deps.payout, {
    escrowId: input.escrowId,
    plan: prepared.plan,
    winnerSeat: null,
    idempotencyKey: prepared.key,
  });

  log().warn('escrow_voided', {
    escrow_id: input.escrowId,
    actor_profile_id: auth.profileId,
    payout_state: outcome.state,
  });

  return {
    escrowId: input.escrowId,
    refunded: prepared.funded.map((f) => ({ seat: f.seat, amountBase: f.amountBase.toString() })),
    payoutState: outcome.state,
    txSig: 'txSig' in outcome ? outcome.txSig : null,
  };
}
