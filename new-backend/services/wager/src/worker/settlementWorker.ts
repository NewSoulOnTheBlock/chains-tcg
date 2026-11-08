/**
 * Settlement worker — the ONLY thing in this service that can pay a winner (C-1).
 *
 * It consumes `game.match_results`, which only the game service writes. There is
 * no HTTP route, in this service or any other, that results in a payout being
 * decided: the legacy `POST /api/result` took `winner` straight from the request
 * body and forwarded it to `settleCustodialMatch`, so anyone with curl could
 * name themselves the winner of a funded match. That endpoint does not exist
 * here, and its replacement input is a database row carrying an HMAC that only
 * the game service can produce.
 *
 * Everything below is idempotent and safe to run in several replicas at once;
 * see `services/payoutRunner.ts` for the exactly-once argument.
 */
import { getPool, withTransaction } from '../platform/shared.js';
import type { PoolClient } from 'pg';
import { log } from '../platform/logger.js';
import {
  listSettlementCandidates,
  listVoidRefundCandidates,
  getMatchResult,
  type SettlementCandidate,
  type VoidRefundCandidate,
} from '../db/matchResults.js';
import { listDeposits, lockDeposits, lockEscrow } from '../db/escrows.js';
import { claimPayout, getPayout, repurposePayoutForVoid } from '../db/payouts.js';
import { verifyMatchResultSig } from '../domain/matchResult.js';
import {
  planSettlement,
  planVoidRefund,
  payoutIdempotencyKey,
  type FundedSeat,
} from '../domain/settlement.js';
import { executePayout, type PayoutRunnerDeps, type PayoutOutcome } from '../services/payoutRunner.js';

const TERMINAL_ESCROW = new Set(['settled', 'refunded', 'void']);
/** Default TTL before an abandoned 'open' match's deposit is auto-refunded. */
const DEFAULT_VOID_REFUND_TTL_SEC = 24 * 60 * 60;

export interface SettlementWorkerDeps {
  payout: PayoutRunnerDeps;
  hmacSecret: string;
  burnBps: number;
  /** Where the protocol cut is sent. Modelled as an ordinary payout leg. */
  burnAddress: string;
  batchSize: number;
  pollMs: number;
  /**
   * How long a match may sit 'open' (nobody joined) before its deposit is
   * auto-refunded (server-32). 'void' matches are refunded immediately. Defaults
   * to 24h.
   */
  voidRefundTtlSeconds?: number;
}

export interface PassSummary {
  examined: number;
  paid: number;
  pending: number;
  rejected: number;
  failed: number;
}

/** Settle one candidate. Exported so tests can drive it directly. */
export async function settleCandidate(
  deps: SettlementWorkerDeps,
  candidate: SettlementCandidate,
): Promise<PayoutOutcome | { state: 'rejected'; reason: string }> {
  // Provenance first. An unsigned or mis-signed row never moves money.
  if (!verifyMatchResultSig(candidate, deps.hmacSecret)) {
    log().error('match_result_sig_invalid', {
      match_id: candidate.matchId,
      escrow_id: candidate.escrowId,
    });
    return { state: 'rejected', reason: 'bad_server_sig' };
  }

  const deposits = await listDeposits(getPool(), candidate.escrowId);
  const funded: FundedSeat[] = deposits.map((d) => ({
    seat: d.seat,
    address: d.fromAddress,
    amountBase: d.amountBase,
  }));

  const plan = planSettlement({
    funded,
    winnerSeat: candidate.winnerSeat,
    burnBps: deps.burnBps,
    burnAddress: deps.burnAddress,
  });
  const key = payoutIdempotencyKey(candidate.escrowId, plan, candidate.winnerSeat);

  return executePayout(deps.payout, {
    escrowId: candidate.escrowId,
    plan,
    winnerSeat: candidate.winnerSeat,
    idempotencyKey: key,
  });
}

export async function runSettlementPass(deps: SettlementWorkerDeps): Promise<PassSummary> {
  const candidates = await listSettlementCandidates(getPool(), deps.batchSize);
  const summary: PassSummary = {
    examined: candidates.length,
    paid: 0,
    pending: 0,
    rejected: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      const outcome = await settleCandidate(deps, candidate);
      switch (outcome.state) {
        case 'paid':
        case 'already_paid':
          summary.paid += 1;
          break;
        case 'rejected':
          summary.rejected += 1;
          break;
        case 'failed':
          summary.failed += 1;
          break;
        default:
          summary.pending += 1;
      }
    } catch (err) {
      summary.failed += 1;
      log().error('settlement_candidate_failed', {
        escrow_id: candidate.escrowId,
        err_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (summary.examined > 0) log().info('settlement_pass_complete', { ...summary });
  return summary;
}

/**
 * Auto-refund one escrow whose match is void or abandoned (server-32).
 *
 * Mirrors the operator `voidEscrow` path, but driven by the worker with no human
 * in the loop. All the exactly-once guarantees still come from `executePayout`:
 * the payout row's escrow_id primary key, the lease, and the per-leg nonce.
 */
async function refundVoidCandidate(
  deps: SettlementWorkerDeps,
  candidate: VoidRefundCandidate,
): Promise<PayoutOutcome | { state: 'skipped' }> {
  const prepared = await withTransaction(async (client: PoolClient) => {
    const escrow = await lockEscrow(client, candidate.escrowId);
    if (!escrow) return null;
    if (TERMINAL_ESCROW.has(escrow.status)) return null;
    // A result that landed between listing and locking belongs to the normal
    // settlement path — never refund a match that actually finished.
    if (await getMatchResult(client, escrow.matchId)) return null;

    const deposits = await lockDeposits(client, escrow.id);
    if (deposits.length === 0) return null;
    const funded: FundedSeat[] = deposits.map((d) => ({
      seat: d.seat,
      address: d.fromAddress,
      amountBase: d.amountBase,
    }));
    const plan = planVoidRefund(funded);
    const key = payoutIdempotencyKey(escrow.id, plan, null);

    const existing = await getPayout(client, escrow.id);
    if (existing) {
      if (existing.status === 'paid') return null;
      const repurposed = await repurposePayoutForVoid(client, {
        escrowId: escrow.id,
        amountBase: plan.totalBase,
        idempotencyKey: key,
      });
      // A payout is already signed (has a tx_hash): leave it for reconciliation
      // rather than redirecting a transaction that may be propagating.
      if (!repurposed) return null;
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
    return { plan, key };
  });

  if (!prepared) return { state: 'skipped' };

  log().warn('escrow_auto_void_refund', {
    escrow_id: candidate.escrowId,
    match_id: candidate.matchId,
    match_status: candidate.matchStatus,
  });
  return executePayout(deps.payout, {
    escrowId: candidate.escrowId,
    plan: prepared.plan,
    winnerSeat: null,
    idempotencyKey: prepared.key,
  });
}

/** One pass of the auto-refund sweep (server-32). */
export async function runVoidRefundPass(deps: SettlementWorkerDeps): Promise<PassSummary> {
  const ttl = deps.voidRefundTtlSeconds ?? DEFAULT_VOID_REFUND_TTL_SEC;
  const candidates = await listVoidRefundCandidates(getPool(), ttl, deps.batchSize);
  const summary: PassSummary = {
    examined: candidates.length,
    paid: 0,
    pending: 0,
    rejected: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      const outcome = await refundVoidCandidate(deps, candidate);
      switch (outcome.state) {
        case 'paid':
        case 'already_paid':
          summary.paid += 1;
          break;
        case 'skipped':
          break;
        case 'failed':
          summary.failed += 1;
          break;
        default:
          summary.pending += 1;
      }
    } catch (err) {
      summary.failed += 1;
      log().error('void_refund_candidate_failed', {
        escrow_id: candidate.escrowId,
        err_message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (summary.examined > 0) log().info('void_refund_pass_complete', { ...summary });
  return summary;
}

export interface WorkerHandle {
  stop(): Promise<void>;
  /** Whether a pass has completed since boot — used by /readyz. */
  healthy(): boolean;
}

export function startSettlementWorker(deps: SettlementWorkerDeps): WorkerHandle {
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  let lastSuccess = Date.now();
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    inFlight = runSettlementPass(deps)
      // Then sweep abandoned/void matches whose deposits the settlement pass can
      // never reach (server-32). A failure here is logged but must not stop the
      // settlement pass from being marked healthy.
      .then(() => runVoidRefundPass(deps).catch((err: unknown) => {
        log().error('void_refund_pass_error', {
          err_message: err instanceof Error ? err.message : String(err),
        });
      }))
      .then(() => {
        lastSuccess = Date.now();
      })
      .catch((err: unknown) => {
        log().error('settlement_worker_error', {
          err_message: err instanceof Error ? err.message : String(err),
        });
      });
    await inFlight;
    if (!stopped) timer = setTimeout(() => void tick(), deps.pollMs);
  };

  timer = setTimeout(() => void tick(), deps.pollMs);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Let the current pass finish so we never abandon a broadcast mid-flight.
      await inFlight;
    },
    healthy(): boolean {
      return Date.now() - lastSuccess < Math.max(deps.pollMs * 10, 60_000);
    },
  };
}
