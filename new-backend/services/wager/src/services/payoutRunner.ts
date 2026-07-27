/**
 * Exactly-once payout execution (EVM).
 *
 * The hard problem is the gap between "the chain accepted our transfer" and
 * "our database knows about it". A crash in that gap must never cause a second
 * payment. Five things close it:
 *
 *  1. ONE DECISION PER ESCROW. `wager.payouts` has `escrow_id` as its primary
 *     key, so only one worker can ever create the payout row. Everyone else
 *     follows the existing row instead of forming a second opinion.
 *
 *  2. ONE LEG PER RECIPIENT, FIXED UP FRONT. `wager.payout_legs` is keyed
 *     `(escrow_id, leg_index)` and is written once, so the set of transfers a
 *     decision consists of cannot change under an in-flight transaction.
 *
 *  3. SIGN, PERSIST, THEN BROADCAST. An EVM transaction hash is
 *     `keccak256(rawSignedTx)` — known before the network sees it. We sign,
 *     commit `tx_hash` + `raw_tx` + `nonce`, and only then broadcast.
 *     INVARIANT: no transaction is ever broadcast whose hash is not already
 *     durably recorded, so a crash always leaves an identifiable in-flight
 *     payment rather than an anonymous one.
 *
 *  4. THE NONCE. A leg keeps its nonce for life. Any replacement transaction
 *     reuses it, and two transactions with the same sender and nonce are
 *     mutually exclusive by consensus rule — not by our bookkeeping. This is
 *     strictly stronger than "check before sending": even a bug that sent both
 *     could only ever have one of them included.
 *
 *  5. RECONCILE BEFORE SENDING. A run that finds a recorded `tx_hash` never
 *     builds a new transaction for that leg. It asks the chain:
 *        success  → mark the leg paid, no second send;
 *        pending  → REBROADCAST THE SAME BYTES (identical hash — a duplicate
 *                   cannot exist) and wait;
 *        reverted → no funds moved, so rebuild at the SAME nonce.
 *
 * `SELECT … FOR UPDATE` on the escrow row wraps every state change, which is the
 * M-2 fix: concurrent settlement attempts serialise instead of both reading
 * "not settled yet".
 */
import type { PoolClient } from 'pg';
import { AppError, getPool, withTransaction } from '../platform/shared.js';
import { log } from '../platform/logger.js';
import { lockEscrow, setEscrowStatus, type EscrowRow } from '../db/escrows.js';
import {
  allocateNonce,
  claimPayout,
  ensureLegs,
  listLegs,
  lockPayout,
  markLegPaid,
  markPayoutFailed,
  markPayoutPaid,
  recordLegAttempt,
  resetLegForRebuild,
  takeLease,
  type LegRow,
} from '../db/payouts.js';
import type { ChainReader, ChainSender, PreparedTx } from '../chain/types.js';
import type { PayoutPlan } from '../domain/settlement.js';
import type { WinnerSeat } from '../domain/matchResult.js';

export type PayoutOutcome =
  | { state: 'paid'; txSig: string | null }
  | { state: 'already_paid'; txSig: string | null }
  | { state: 'pending'; txSig: string | null }
  | { state: 'failed'; reason: string };

export interface PayoutRunnerDeps {
  reader: ChainReader;
  sender: ChainSender;
  leaseSeconds: number;
  /** How long to poll for a receipt before leaving it to the next run. */
  confirmTimeoutMs: number;
  confirmPollMs: number;
}

const TERMINAL_ESCROW_STATUSES = new Set(['settled', 'refunded', 'void']);

async function finalise(escrowId: string, plan: PayoutPlan, txSig: string | null): Promise<void> {
  await withTransaction(async (client: PoolClient) => {
    await lockEscrow(client, escrowId);
    await markPayoutPaid(client, escrowId, txSig);
    await setEscrowStatus(client, escrowId, plan.finalStatus);
  });
}

/**
 * Run (or resume) the payout for one escrow. Safe to call repeatedly and from
 * several workers at once.
 */
export async function executePayout(
  deps: PayoutRunnerDeps,
  args: { escrowId: string; plan: PayoutPlan; winnerSeat: WinnerSeat; idempotencyKey: string },
): Promise<PayoutOutcome> {
  const { escrowId, plan } = args;

  // ── Phase 1: claim the decision, materialise the legs, take a lease ───────
  const claim = await withTransaction(async (client: PoolClient) => {
    const escrow: EscrowRow | null = await lockEscrow(client, escrowId);
    if (!escrow) throw AppError.notFound('Escrow does not exist', { reason: 'escrow_not_found' });
    if (TERMINAL_ESCROW_STATUSES.has(escrow.status)) {
      const existing = await lockPayout(client, escrowId);
      return { kind: 'terminal' as const, txSig: existing?.txSig ?? null };
    }

    const { row, claimed } = await claimPayout(client, {
      escrowId,
      kind: plan.kind,
      winnerSeat: args.winnerSeat,
      amountBase: plan.totalBase,
      burnBase: plan.burnBase,
      idempotencyKey: args.idempotencyKey,
      leaseSeconds: deps.leaseSeconds,
    });

    if (row.status === 'paid') {
      // Someone finished it; make sure the escrow status agrees.
      await setEscrowStatus(client, escrowId, plan.finalStatus);
      return { kind: 'already' as const, txSig: row.txSig };
    }

    if (row.idempotencyKey !== args.idempotencyKey) {
      // A decision already exists for this escrow and it is not ours. Never
      // overwrite it — an escrow gets exactly one outcome.
      log().warn('payout_decision_conflict', {
        escrow_id: escrowId,
        existing_key: row.idempotencyKey,
        proposed_key: args.idempotencyKey,
      });
    }

    // Winning the INSERT means we own the row and the lease it was created
    // with; only a follower has to contend for the lease.
    if (!claimed) {
      const leased = await takeLease(client, escrowId, deps.leaseSeconds);
      if (!leased) return { kind: 'leased_elsewhere' as const, txSig: row.txSig };
    }

    await ensureLegs(client, escrowId, plan);
    return { kind: 'go' as const };
  });

  if (claim.kind === 'terminal' || claim.kind === 'already') {
    return { state: 'already_paid', txSig: claim.txSig };
  }
  if (claim.kind === 'leased_elsewhere') return { state: 'pending', txSig: claim.txSig };

  // ── Phase 2: nothing to send ─────────────────────────────────────────────
  if (plan.legs.length === 0) {
    await finalise(escrowId, plan, null);
    return { state: 'paid', txSig: null };
  }

  // ── Phase 3: drive each leg to a receipt ─────────────────────────────────
  let allPaid = true;
  let lastHash: string | null = null;

  for (const leg of await listLegs(getPool(), escrowId)) {
    const result = await runLeg(deps, escrowId, leg);
    if (result.state === 'paid') {
      lastHash = result.txHash ?? lastHash;
      continue;
    }
    allPaid = false;
    if (result.state === 'failed') {
      await markPayoutFailed(getPool(), escrowId, result.reason);
      return { state: 'failed', reason: result.reason };
    }
    // Still pending: stop here so legs stay in order and nonces stay dense.
    break;
  }

  if (!allPaid) return { state: 'pending', txSig: lastHash };

  await finalise(escrowId, plan, lastHash);
  log().info('payout_confirmed', { escrow_id: escrowId, kind: plan.kind, tx_hash: lastHash });
  return { state: 'paid', txSig: lastHash };
}

type LegResult =
  | { state: 'paid'; txHash: string | null }
  | { state: 'pending' }
  | { state: 'failed'; reason: string };

async function runLeg(
  deps: PayoutRunnerDeps,
  escrowId: string,
  leg: LegRow,
): Promise<LegResult> {
  if (leg.status === 'paid') return { state: 'paid', txHash: leg.txHash };

  // ── Reconcile an already-signed attempt ────────────────────────────────
  if (leg.txHash && leg.rawTx && leg.nonce !== null) {
    const prepared: PreparedTx = { hash: leg.txHash, raw: leg.rawTx, nonce: leg.nonce };
    const outcome = await deps.sender.awaitOutcome(prepared);

    if (outcome === 'confirmed') {
      await markLegPaid(getPool(), escrowId, leg.legIndex);
      log().info('payout_leg_reconciled', {
        escrow_id: escrowId,
        leg_index: leg.legIndex,
        tx_hash: leg.txHash,
      });
      return { state: 'paid', txHash: leg.txHash };
    }

    if (outcome === 'pending') {
      // Same bytes, same hash, same nonce: rebroadcasting cannot double-pay.
      try {
        await deps.sender.broadcast(prepared);
      } catch (err) {
        log().warn('payout_leg_rebroadcast_failed', {
          escrow_id: escrowId,
          leg_index: leg.legIndex,
          err_message: err instanceof Error ? err.message : String(err),
        });
      }
      if ((await pollForReceipt(deps, prepared)) === 'confirmed') {
        await markLegPaid(getPool(), escrowId, leg.legIndex);
        return { state: 'paid', txHash: leg.txHash };
      }
      return { state: 'pending' };
    }

    // Reverted: it was mined and moved nothing, so a replacement at the SAME
    // nonce is safe — and the original can never also land.
    await resetLegForRebuild(getPool(), escrowId, leg.legIndex, 'previous attempt reverted');
    log().warn('payout_leg_reverted', {
      escrow_id: escrowId,
      leg_index: leg.legIndex,
      tx_hash: leg.txHash,
    });
    return { state: 'pending' };
  }

  // ── Build, persist, broadcast ─────────────────────────────────────────
  let prepared: PreparedTx;
  try {
    // Keep a leg's nonce for life; only a brand-new leg allocates one. A
    // replacement for a reverted attempt deliberately reuses the old nonce.
    let nonce = leg.nonce;
    if (nonce === null) {
      const chainPending = await deps.reader.getTransactionCount(deps.sender.escrowAddress);
      nonce = await withTransaction((client: PoolClient) => allocateNonce(client, chainPending));
    }

    prepared = await deps.sender.prepareTransfer({
      to: leg.toAddress,
      amountBase: leg.amountBase,
      nonce,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log().error('payout_leg_prepare_failed', {
      escrow_id: escrowId,
      leg_index: leg.legIndex,
      err_message: reason,
    });
    return { state: 'failed', reason };
  }

  // Durable BEFORE the network sees anything.
  await recordLegAttempt(getPool(), {
    escrowId,
    legIndex: leg.legIndex,
    txHash: prepared.hash,
    rawTx: prepared.raw,
    nonce: prepared.nonce,
  });

  try {
    await deps.sender.broadcast(prepared);
  } catch (err) {
    // The hash is recorded, so the next run reconciles rather than resending
    // blindly — even if the broadcast did reach the network.
    log().warn('payout_leg_broadcast_threw', {
      escrow_id: escrowId,
      leg_index: leg.legIndex,
      err_message: err instanceof Error ? err.message : String(err),
    });
    return { state: 'pending' };
  }

  const outcome = await pollForReceipt(deps, prepared);
  if (outcome === 'confirmed') {
    await markLegPaid(getPool(), escrowId, leg.legIndex);
    return { state: 'paid', txHash: prepared.hash };
  }
  if (outcome === 'reverted') {
    // Mined and moved nothing. Clear the attempt but keep the nonce, so the
    // replacement and this transaction are mutually exclusive on-chain.
    await resetLegForRebuild(getPool(), escrowId, leg.legIndex, 'attempt reverted');
    log().warn('payout_leg_reverted', {
      escrow_id: escrowId,
      leg_index: leg.legIndex,
      tx_hash: prepared.hash,
    });
  }
  return { state: 'pending' };
}

async function pollForReceipt(
  deps: PayoutRunnerDeps,
  prepared: PreparedTx,
): Promise<'confirmed' | 'reverted' | 'pending'> {
  const deadline = Date.now() + deps.confirmTimeoutMs;
  for (;;) {
    const outcome = await deps.sender.awaitOutcome(prepared);
    if (outcome !== 'pending') return outcome;
    if (Date.now() >= deadline) return 'pending';
    await new Promise((resolve) => setTimeout(resolve, deps.confirmPollMs));
  }
}
