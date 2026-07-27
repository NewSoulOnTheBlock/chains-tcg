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
import { getPool } from '../platform/shared.js';
import { log } from '../platform/logger.js';
import { listSettlementCandidates, type SettlementCandidate } from '../db/matchResults.js';
import { listDeposits } from '../db/escrows.js';
import { verifyMatchResultSig } from '../domain/matchResult.js';
import { planSettlement, payoutIdempotencyKey, type FundedSeat } from '../domain/settlement.js';
import { executePayout, type PayoutRunnerDeps, type PayoutOutcome } from '../services/payoutRunner.js';

export interface SettlementWorkerDeps {
  payout: PayoutRunnerDeps;
  hmacSecret: string;
  burnBps: number;
  /** Where the protocol cut is sent. Modelled as an ordinary payout leg. */
  burnAddress: string;
  batchSize: number;
  pollMs: number;
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
