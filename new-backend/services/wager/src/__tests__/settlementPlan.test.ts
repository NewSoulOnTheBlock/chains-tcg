/**
 * Settlement arithmetic and the booster payment binding — both pure.
 */
import { describe, expect, it } from 'vitest';
import {
  computeBurn,
  payoutIdempotencyKey,
  planSettlement,
  planVoidRefund,
  type FundedSeat,
} from '../domain/settlement.js';
import { StakePolicy } from '../domain/stakes.js';
import { verifyBoosterPayment, intentCalldata } from '../domain/boosterPayment.js';
import { rollTicketCards } from '../domain/packRoll.js';
import type { ParsedTx } from '../chain/types.js';

const A = '0xaaaa000000000000000000000000000000000001';
const B = '0xbbbb000000000000000000000000000000000002';
const BURN = '0x000000000000000000000000000000000000dead';

const both: FundedSeat[] = [
  { seat: 0, address: A, amountBase: 1_000_000n },
  { seat: 1, address: B, amountBase: 1_000_000n },
];

describe('planSettlement', () => {
  it('pays the winner the pot minus the burn', () => {
    const plan = planSettlement({ funded: both, winnerSeat: 1, burnBps: 1_000, burnAddress: BURN });
    expect(plan.kind).toBe('winner');
    expect(plan.burnBase).toBe(200_000n);
    // The burn is an ordinary leg, so the whole payout is one mechanism.
    expect(plan.legs).toEqual([
      { index: 0, to: B, amountBase: 1_800_000n, purpose: 'payout' },
      { index: 1, to: BURN, amountBase: 200_000n, purpose: 'burn' },
    ]);
    const out = plan.legs.reduce((acc, l) => acc + l.amountBase, 0n);
    expect(out).toBe(plan.totalBase);
    expect(plan.finalStatus).toBe('settled');
  });

  it('refunds each payer exactly their own stake on a draw, with no burn', () => {
    const plan = planSettlement({ funded: both, winnerSeat: null, burnBps: 1_000, burnAddress: BURN });
    expect(plan.kind).toBe('draw_refund');
    expect(plan.burnBase).toBe(0n);
    expect(plan.legs).toEqual([
      { index: 0, to: A, amountBase: 1_000_000n, purpose: 'refund' },
      { index: 1, to: B, amountBase: 1_000_000n, purpose: 'refund' },
    ]);
    // Conservation: a draw pays out exactly what came in, never more. Under the
    // legacy code one replayed signature could mark both seats funded, and this
    // path then paid two stakes for one deposit.
    const paid = plan.legs.reduce((acc, l) => acc + l.amountBase, 0n);
    expect(paid).toBe(2_000_000n);
    expect(paid).toBe(plan.totalBase);
  });

  it('refunds a single funded seat instead of paying a pot that never existed', () => {
    const plan = planSettlement({ funded: [both[0]!], winnerSeat: 1, burnBps: 1_000, burnAddress: BURN });
    expect(plan.kind).toBe('partial_refund');
    expect(plan.legs).toEqual([{ index: 0, to: A, amountBase: 1_000_000n, purpose: 'refund' }]);
    expect(plan.finalStatus).toBe('refunded');
  });

  it('refunds everyone when the winning seat has no deposit on file', () => {
    const plan = planSettlement({
      funded: [
        { seat: 0, address: A, amountBase: 1_000_000n },
        { seat: 0, address: A, amountBase: 1_000_000n },
      ],
      winnerSeat: 1,
      burnBps: 1_000,
      burnAddress: BURN,
    });
    expect(plan.kind).toBe('draw_refund');
  });

  it('sends nothing at all when no seat was funded', () => {
    const plan = planSettlement({ funded: [], winnerSeat: 0, burnBps: 1_000, burnAddress: BURN });
    expect(plan.kind).toBe('noop');
    expect(plan.legs).toEqual([]);
    expect(plan.burnBase).toBe(0n);
  });

  it('never burns on a void refund', () => {
    const plan = planVoidRefund(both);
    expect(plan.burnBase).toBe(0n);
    expect(plan.finalStatus).toBe('void');
  });

  it('rounds the burn down, so the escrow can never owe more than it holds', () => {
    expect(computeBurn(3n, 1_000)).toBe(0n);
    expect(computeBurn(1_000_001n, 1)).toBe(100n);
  });

  it('derives a different idempotency key per decided outcome', () => {
    const win0 = planSettlement({ funded: both, winnerSeat: 0, burnBps: 1_000, burnAddress: BURN });
    const win1 = planSettlement({ funded: both, winnerSeat: 1, burnBps: 1_000, burnAddress: BURN });
    expect(payoutIdempotencyKey('e1', win0, 0)).not.toBe(payoutIdempotencyKey('e1', win1, 1));
    expect(payoutIdempotencyKey('e1', win0, 0)).toBe(payoutIdempotencyKey('e1', win0, 0));
  });
});

describe('StakePolicy', () => {
  const policy = new StakePolicy([1_000_000n, 5_000_000n]);

  it('resolves a tier index to a server-side amount', () => {
    expect(policy.amountForTier(0)).toBe(1_000_000n);
    expect(policy.amountForTier(1)).toBe(5_000_000n);
  });

  it('refuses anything that is not an allowlisted tier', () => {
    expect(policy.amountForTier(2)).toBeNull();
    expect(policy.amountForTier(-1)).toBeNull();
    expect(policy.amountForTier(1.5)).toBeNull();
    expect(policy.amountForTier(Number.NaN)).toBeNull();
  });

  it('knows which amounts are allowed', () => {
    expect(policy.isAllowedAmount(1_000_000n)).toBe(true);
    expect(policy.isAllowedAmount(1_000_001n)).toBe(false);
  });
});

describe('verifyBoosterPayment', () => {
  const TREASURY = '0xcccc000000000000000000000000000000000003';
  const BUYER = '0xdddd000000000000000000000000000000000004';
  const NONCE = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';
  const CREATED = 1_700_000_000;

  const expectation = {
    nonce: NONCE,
    recipient: TREASURY,
    amountWei: 3_500_000_000_000_000n,
    payerAddress: BUYER,
    intentCreatedAtSeconds: CREATED,
    minConfirmations: 2,
  };

  function tx(overrides: Partial<ParsedTx> = {}): ParsedTx {
    return {
      hash: '0xpay',
      blockNumber: 10,
      blockTimestamp: CREATED + 30,
      status: 'success',
      from: BUYER,
      to: TREASURY,
      value: 3_500_000_000_000_000n,
      input: intentCalldata(NONCE),
      confirmations: 5,
      erc20Transfers: [],
      ...overrides,
    };
  }

  it('accepts a payment bound to the intent', () => {
    expect(verifyBoosterPayment(tx(), expectation).ok).toBe(true);
  });

  it('rejects an old transfer to the treasury — the legacy replay', () => {
    // Previously ANY historical transfer whose treasury delta was >= the price
    // could be presented as a purchase.
    expect(verifyBoosterPayment(tx({ blockTimestamp: CREATED - 1 }), expectation)).toMatchObject({
      ok: false,
      code: 'tx_predates_intent',
    });
  });

  it('rejects a payment carrying no intent nonce', () => {
    expect(verifyBoosterPayment(tx({ input: '0x' }), expectation)).toMatchObject({
      ok: false,
      code: 'calldata_missing',
    });
  });

  it("rejects another intent's nonce", () => {
    expect(
      verifyBoosterPayment(tx({ input: intentCalldata('f'.repeat(32)) }), expectation),
    ).toMatchObject({ ok: false, code: 'calldata_missing' });
  });

  it('rejects an overpayment — the amount must be EXACT', () => {
    expect(verifyBoosterPayment(tx({ value: 9_000_000_000_000_000n }), expectation)).toMatchObject({
      ok: false,
      code: 'wrong_amount',
    });
  });

  it('rejects a payment that never credited the treasury', () => {
    expect(verifyBoosterPayment(tx({ to: BUYER }), expectation)).toMatchObject({
      ok: false,
      code: 'wrong_recipient',
    });
  });

  it('rejects a payment sent by somebody else', () => {
    expect(verifyBoosterPayment(tx({ from: TREASURY }), expectation)).toMatchObject({
      ok: false,
      code: 'not_sent_by_payer',
    });
  });

  it('holds an under-confirmed payment as retryable', () => {
    expect(verifyBoosterPayment(tx({ confirmations: 0 }), expectation)).toMatchObject({
      ok: false,
      code: 'not_enough_confirmations',
      retryable: true,
    });
  });
});

describe('rollTicketCards', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'];

  it('is deterministic in the ticket number, so a retry re-rolls nothing', () => {
    const first = rollTicketCards({ pool, ticketNumber: 7, secret: 'seed' });
    const again = rollTicketCards({ pool, ticketNumber: 7, secret: 'seed' });
    expect(again).toEqual(first);
    expect(first).toHaveLength(30);
  });

  it('differs between tickets', () => {
    const a = rollTicketCards({ pool, ticketNumber: 7, secret: 'seed' });
    const b = rollTicketCards({ pool, ticketNumber: 8, secret: 'seed' });
    expect(a).not.toEqual(b);
  });
});
