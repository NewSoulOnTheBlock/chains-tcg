/**
 * Deposit verification (C-2, pure half) and EVM receipt parsing.
 *
 * Each test is one thing the legacy `markFunded` let through.
 */
import { describe, expect, it } from 'vitest';
import { verifyDepositTx, type DepositExpectation } from '../domain/deposit.js';
import { parseTransaction, TRANSFER_TOPIC, addressFromTopic } from '../chain/evmParse.js';
import type { Erc20Transfer, ParsedTx } from '../chain/types.js';

const ESCROW_ID = '11111111-2222-3333-4444-555555555555';
const TOKEN = '0x1111111111111111111111111111111111111111';
const ESCROW = '0x2222222222222222222222222222222222222222';
const PLAYER = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x4444444444444444444444444444444444444444';
const ESCROW_CREATED = 1_700_000_000;

const expectation: DepositExpectation = {
  escrowId: ESCROW_ID,
  seat: 0,
  amountBase: 1_000_000n,
  token: TOKEN,
  depositAddress: ESCROW,
  depositorAddress: PLAYER,
  escrowCreatedAtSeconds: ESCROW_CREATED,
  minConfirmations: 2,
};

function transfer(overrides: Partial<Erc20Transfer> = {}): Erc20Transfer {
  return { token: TOKEN, from: PLAYER, to: ESCROW, value: 1_000_000n, logIndex: 0, ...overrides };
}

function tx(overrides: Partial<ParsedTx> = {}): ParsedTx {
  return {
    hash: '0xabc',
    blockNumber: 500,
    blockTimestamp: ESCROW_CREATED + 60,
    status: 'success',
    from: PLAYER,
    to: TOKEN,
    value: 0n,
    input: '0xa9059cbb',
    confirmations: 12,
    erc20Transfers: [transfer()],
    ...overrides,
  };
}

describe('verifyDepositTx', () => {
  it('accepts a well-formed deposit', () => {
    const verdict = verifyDepositTx(tx(), expectation);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.amountBase).toBe(1_000_000n);
      expect(verdict.fromAddress).toBe(PLAYER);
    }
  });

  it('rejects an overpayment — the amount must be EXACT', () => {
    // The legacy comparison was `amt >= expectedAmount`, so one large transfer
    // could satisfy an arbitrary expectation.
    const verdict = verifyDepositTx(
      tx({ erc20Transfers: [transfer({ value: 2_000_000n })] }),
      expectation,
    );
    expect(verdict).toMatchObject({ ok: false, code: 'wrong_amount' });
  });

  it('rejects an underpayment', () => {
    const verdict = verifyDepositTx(
      tx({ erc20Transfers: [transfer({ value: 999_999n })] }),
      expectation,
    );
    expect(verdict).toMatchObject({ ok: false, code: 'wrong_amount' });
  });

  it('rejects a transfer of a different token contract', () => {
    const verdict = verifyDepositTx(
      tx({ erc20Transfers: [transfer({ token: STRANGER })] }),
      expectation,
    );
    expect(verdict).toMatchObject({ ok: false, code: 'wrong_token' });
  });

  it('rejects a transfer to some other address', () => {
    const verdict = verifyDepositTx(
      tx({ erc20Transfers: [transfer({ to: STRANGER })] }),
      expectation,
    );
    expect(verdict).toMatchObject({ ok: false, code: 'no_transfer_to_escrow' });
  });

  it("rejects tokens that came out of somebody else's balance", () => {
    const verdict = verifyDepositTx(
      tx({ erc20Transfers: [transfer({ from: STRANGER })] }),
      expectation,
    );
    expect(verdict).toMatchObject({ ok: false, code: 'wrong_sender' });
  });

  it('rejects a transaction the authenticated wallet did not send', () => {
    const verdict = verifyDepositTx(tx({ from: STRANGER }), expectation);
    expect(verdict).toMatchObject({ ok: false, code: 'not_sent_by_depositor' });
  });

  it('rejects a transfer older than the escrow', () => {
    const verdict = verifyDepositTx(tx({ blockTimestamp: ESCROW_CREATED - 1 }), expectation);
    expect(verdict).toMatchObject({ ok: false, code: 'tx_predates_escrow' });
  });

  it('refuses to guess when the node reports no block timestamp', () => {
    const verdict = verifyDepositTx(tx({ blockTimestamp: null }), expectation);
    expect(verdict).toMatchObject({ ok: false, code: 'no_block_time', retryable: true });
  });

  it('rejects a reverted transaction', () => {
    const verdict = verifyDepositTx(tx({ status: 'reverted' }), expectation);
    expect(verdict).toMatchObject({ ok: false, code: 'tx_reverted' });
  });

  it('holds an under-confirmed deposit as retryable rather than accepting it', () => {
    const verdict = verifyDepositTx(tx({ confirmations: 1 }), expectation);
    expect(verdict).toMatchObject({ ok: false, code: 'not_enough_confirmations', retryable: true });
  });

  it('reports an unmined hash as retryable rather than invalid', () => {
    expect(verifyDepositTx(null, expectation)).toMatchObject({
      ok: false,
      code: 'tx_not_found',
      retryable: true,
    });
  });

  it('accepts the qualifying transfer even when the transaction carries others', () => {
    const verdict = verifyDepositTx(
      tx({
        erc20Transfers: [
          transfer({ to: STRANGER, value: 5n, logIndex: 0 }),
          transfer({ logIndex: 1 }),
        ],
      }),
      expectation,
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.logIndex).toBe(1);
  });

  it('does not let a decoy transfer of the wrong amount mask a good one', () => {
    const verdict = verifyDepositTx(
      tx({
        erc20Transfers: [transfer({ value: 1n, logIndex: 0 }), transfer({ logIndex: 3 })],
      }),
      expectation,
    );
    expect(verdict.ok).toBe(true);
  });
});

describe('parseTransaction', () => {
  const topic = (addr: string): string => `0x${'0'.repeat(24)}${addr.slice(2)}`;

  const rawTx = {
    from: '0x3333333333333333333333333333333333333333',
    to: '0x1111111111111111111111111111111111111111',
    value: '0x0',
    input: '0xA9059CBB',
    blockNumber: '0x1f4',
  };
  const rawReceipt = {
    status: '0x1',
    blockNumber: '0x1f4',
    logs: [
      {
        address: '0x1111111111111111111111111111111111111111',
        topics: [TRANSFER_TOPIC, topic(PLAYER), topic(ESCROW)],
        data: '0x00000000000000000000000000000000000000000000000000000000000f4240',
        logIndex: '0x2',
      },
    ],
  };

  it('decodes an ERC-20 Transfer and lower-cases every address', () => {
    const parsed = parseTransaction('0xABC', {
      tx: rawTx,
      receipt: rawReceipt,
      block: { timestamp: '0x65000000' },
      headBlockNumber: 510,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.status).toBe('success');
    expect(parsed!.from).toBe(PLAYER);
    expect(parsed!.hash).toBe('0xabc');
    expect(parsed!.input).toBe('0xa9059cbb');
    expect(parsed!.confirmations).toBe(11);
    expect(parsed!.erc20Transfers).toEqual([
      { token: TOKEN, from: PLAYER, to: ESCROW, value: 1_000_000n, logIndex: 2 },
    ]);
  });

  it('returns null without a receipt, so an unmined transaction is never usable', () => {
    expect(parseTransaction('0xabc', { tx: rawTx, receipt: null, block: null, headBlockNumber: 1 })).toBeNull();
  });

  it('marks a failed transaction reverted', () => {
    const parsed = parseTransaction('0xabc', {
      tx: rawTx,
      receipt: { ...rawReceipt, status: '0x0' },
      block: null,
      headBlockNumber: 510,
    });
    expect(parsed!.status).toBe('reverted');
  });

  it('ignores removed (re-orged) logs', () => {
    const parsed = parseTransaction('0xabc', {
      tx: rawTx,
      receipt: { ...rawReceipt, logs: [{ ...rawReceipt.logs[0], removed: true }] },
      block: null,
      headBlockNumber: 510,
    });
    expect(parsed!.erc20Transfers).toEqual([]);
  });

  it('ignores an ERC-721 Transfer, which has four topics and no value', () => {
    const parsed = parseTransaction('0xabc', {
      tx: rawTx,
      receipt: {
        ...rawReceipt,
        logs: [
          {
            ...rawReceipt.logs[0],
            topics: [TRANSFER_TOPIC, topic(PLAYER), topic(ESCROW), topic(STRANGER)],
          },
        ],
      },
      block: null,
      headBlockNumber: 510,
    });
    expect(parsed!.erc20Transfers).toEqual([]);
  });

  it('ignores logs from other events', () => {
    const parsed = parseTransaction('0xabc', {
      tx: rawTx,
      receipt: { ...rawReceipt, logs: [{ ...rawReceipt.logs[0], topics: ['0xdead', topic(PLAYER)] }] },
      block: null,
      headBlockNumber: 510,
    });
    expect(parsed!.erc20Transfers).toEqual([]);
  });

  it('extracts an address from a padded topic', () => {
    expect(addressFromTopic(topic(PLAYER))).toBe(PLAYER);
    expect(addressFromTopic('0xshort')).toBeNull();
  });
});
