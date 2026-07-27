/**
 * Settlement arithmetic — pure.
 *
 * Inputs are all server-observed: the escrow's own stake, the funded seats and
 * the payer address recorded on each `wager.deposits` row, and the winner seat
 * from an HMAC-verified `game.match_results` row. Nothing here can be influenced
 * by a request body.
 *
 * Payouts always go back to the address that actually funded the seat, so even
 * a tampered profile record cannot redirect a pot.
 *
 * On EVM a plan becomes one transaction PER recipient — there is no batching
 * primitive without a deployed contract — so a plan is a list of LEGS. The burn
 * is modelled as a leg to the burn address, which keeps the whole payout a
 * single uniform mechanism instead of a special case.
 */
import type { Seat } from './seat.js';
import type { WinnerSeat } from './matchResult.js';

export interface FundedSeat {
  seat: Seat;
  /** Wallet that paid the deposit (`wager.deposits.from_address`). */
  address: string;
  amountBase: bigint;
}

export type PayoutKind = 'winner' | 'draw_refund' | 'partial_refund' | 'void_refund' | 'noop';

export interface PayoutLeg {
  /** Stable position, so a re-run addresses the same leg. */
  index: number;
  to: string;
  amountBase: bigint;
  purpose: 'payout' | 'refund' | 'burn';
}

export interface PayoutPlan {
  kind: PayoutKind;
  legs: PayoutLeg[];
  burnBase: bigint;
  /** Total leaving the escrow, legs included. */
  totalBase: bigint;
  /** Escrow status to persist once every leg has confirmed. */
  finalStatus: 'settled' | 'refunded' | 'void';
  note: string;
}

export function computeBurn(potBase: bigint, burnBps: number): bigint {
  if (burnBps <= 0) return 0n;
  const bps = BigInt(Math.min(Math.max(Math.trunc(burnBps), 0), 10_000));
  return (potBase * bps) / 10_000n;
}

function legs(entries: Array<Omit<PayoutLeg, 'index'>>): PayoutLeg[] {
  return entries.map((entry, index) => ({ ...entry, index }));
}

/**
 * A settlement plan for a finished match.
 *
 * - both seats funded + winner → winner takes the pot minus the protocol burn
 * - both seats funded + draw    → each payer gets exactly their own stake back,
 *                                 no burn. (Under the legacy code a replayed
 *                                 signature could mark both seats funded from
 *                                 ONE deposit; this path then paid two stakes
 *                                 for one — C-2's money printer. It is
 *                                 impossible now because a transaction hash is
 *                                 globally unique in `wager.deposits`.)
 * - one seat funded             → refund that seat, whatever the result says. A
 *                                 pot that was never assembled is never paid.
 * - nothing funded              → no transaction at all.
 */
export function planSettlement(args: {
  funded: FundedSeat[];
  winnerSeat: WinnerSeat;
  burnBps: number;
  burnAddress: string;
}): PayoutPlan {
  const funded = [...args.funded].sort((a, b) => a.seat - b.seat);

  if (funded.length === 0) {
    return {
      kind: 'noop',
      legs: [],
      burnBase: 0n,
      totalBase: 0n,
      finalStatus: 'settled',
      note: 'no deposits were made',
    };
  }

  if (funded.length === 1) {
    const only = funded[0]!;
    return {
      kind: 'partial_refund',
      legs: legs([{ to: only.address, amountBase: only.amountBase, purpose: 'refund' }]),
      burnBase: 0n,
      totalBase: only.amountBase,
      finalStatus: 'refunded',
      note: `only seat ${only.seat} was funded; refunding it`,
    };
  }

  const pot = funded.reduce((acc, f) => acc + f.amountBase, 0n);
  const refundAll = (note: string): PayoutPlan => ({
    kind: 'draw_refund',
    legs: legs(funded.map((f) => ({ to: f.address, amountBase: f.amountBase, purpose: 'refund' }))),
    burnBase: 0n,
    totalBase: pot,
    finalStatus: 'refunded',
    note,
  });

  if (args.winnerSeat === null) {
    return refundAll('draw: every payer is refunded their own stake');
  }

  const winner = funded.find((f) => f.seat === args.winnerSeat);
  if (!winner) {
    // The winning seat has no deposit on file. Refund everyone rather than
    // inventing a destination.
    return refundAll(`winning seat ${args.winnerSeat} has no deposit on file; refunding all payers`);
  }

  const burnBase = computeBurn(pot, args.burnBps);
  const payout = pot - burnBase;
  const entries: Array<Omit<PayoutLeg, 'index'>> = [
    { to: winner.address, amountBase: payout, purpose: 'payout' },
  ];
  if (burnBase > 0n) {
    entries.push({ to: args.burnAddress, amountBase: burnBase, purpose: 'burn' });
  }

  return {
    kind: 'winner',
    legs: legs(entries),
    burnBase,
    totalBase: pot,
    finalStatus: 'settled',
    note: `seat ${winner.seat} wins ${payout} base units, ${burnBase} burned`,
  };
}

/** Operator void: return every funded stake to its payer. Never burns. */
export function planVoidRefund(funded: FundedSeat[]): PayoutPlan {
  const total = funded.reduce((acc, f) => acc + f.amountBase, 0n);
  return {
    kind: 'void_refund',
    legs: legs(funded.map((f) => ({ to: f.address, amountBase: f.amountBase, purpose: 'refund' }))),
    burnBase: 0n,
    totalBase: total,
    finalStatus: 'void',
    note: 'operator void: all payers refunded',
  };
}

/**
 * Idempotency key for a payout decision. Deterministic in the escrow and the
 * decided outcome, so a retry of the same decision reuses the same row while a
 * *different* decision — which must never happen for one escrow — is rejected
 * by the unique index instead of silently paying twice.
 */
export function payoutIdempotencyKey(
  escrowId: string,
  plan: PayoutPlan,
  winnerSeat: WinnerSeat,
): string {
  const seat = winnerSeat === null ? 'draw' : String(winnerSeat);
  return `${escrowId}:${plan.kind}:${seat}:${plan.totalBase.toString()}`;
}
