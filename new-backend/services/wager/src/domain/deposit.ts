/**
 * Deposit verification — pure (C-2).
 *
 * `verifyDepositTx` never touches the network or the database. It takes an
 * already-parsed transaction plus the expectation the SERVER derived (escrow
 * row + seat mapping + authenticated address) and answers accept/reject.
 *
 * Every field of `DepositExpectation` comes from server-held state:
 *   escrowId, amountBase, token, depositAddress ← wager.escrows
 *   seat, depositorAddress                      ← game.matches mapping + req.auth
 * The request body contributes exactly one value: the transaction hash.
 *
 * ── HOW A PAYMENT IS BOUND TO ONE ESCROW SEAT ON EVM ────────────────────────
 * The Solana design used a memo (`chains:<escrowId>:<seat>`). An ERC-20
 * `transfer` has no free field to carry one, so the binding is reconstructed
 * from five facts, no one of which is sufficient alone:
 *
 *   1. `to` equals THIS escrow's recorded `deposit_address` — read from the
 *      escrow row, not from configuration, so the address a deposit must credit
 *      is fixed at escrow-creation time and a later key rotation cannot
 *      retroactively redefine it. This is the hook a per-escrow deposit vault
 *      slots into later (see the report) without touching this code.
 *   2. `from` equals the authenticated profile's address, so a payment can only
 *      ever be claimed by the wallet that made it.
 *   3. The amount is EXACT, so one large transfer cannot satisfy several
 *      expectations.
 *   4. The transfer is newer than the escrow row, so historical transfers are
 *      not redeemable.
 *   5. The transaction hash is the PRIMARY KEY of `wager.deposits`, so it can be
 *      redeemed once, globally, forever — and `unique (escrow_id, seat)` caps a
 *      seat at one deposit.
 *
 * (5) is what actually closes C-2: even if 1–4 all matched two different
 * escrows, the second insert is a constraint violation.
 */
import type { ParsedTx } from '../chain/types.js';
import type { Seat } from './seat.js';

export interface DepositExpectation {
  escrowId: string;
  seat: Seat;
  /** EXACT amount, in token base units. Not a minimum. */
  amountBase: bigint;
  /** ERC-20 contract the escrow accepts. Lower-case. */
  token: string;
  /** Address this escrow's deposits must credit. Lower-case. */
  depositAddress: string;
  /** Authenticated profile's wallet address. Lower-case. */
  depositorAddress: string;
  /** Unix seconds; the transfer must be newer than the escrow itself. */
  escrowCreatedAtSeconds: number;
  /** Confirmations required before a deposit counts. */
  minConfirmations: number;
}

export type DepositRejectCode =
  | 'tx_not_found'
  | 'tx_reverted'
  | 'not_enough_confirmations'
  | 'no_block_time'
  | 'tx_predates_escrow'
  | 'not_sent_by_depositor'
  | 'no_transfer_to_escrow'
  | 'wrong_amount'
  | 'wrong_token'
  | 'wrong_sender';

export interface DepositRejection {
  ok: false;
  code: DepositRejectCode;
  message: string;
  /** True when the caller should simply try again shortly. */
  retryable: boolean;
}

export interface DepositAcceptance {
  ok: true;
  amountBase: bigint;
  blockNumber: number;
  blockTimestamp: number;
  logIndex: number;
  fromAddress: string;
}

export type DepositVerdict = DepositAcceptance | DepositRejection;

function reject(code: DepositRejectCode, message: string, retryable = false): DepositRejection {
  return { ok: false, code, message, retryable };
}

export function verifyDepositTx(tx: ParsedTx | null, expect: DepositExpectation): DepositVerdict {
  if (!tx) {
    return reject('tx_not_found', 'That transaction has not been mined yet.', true);
  }
  if (tx.status !== 'success') {
    return reject('tx_reverted', 'The deposit transaction reverted on-chain.');
  }
  if (tx.confirmations < expect.minConfirmations) {
    return reject(
      'not_enough_confirmations',
      `The deposit needs ${expect.minConfirmations} confirmations.`,
      true,
    );
  }

  // Recency. Without a block timestamp we cannot prove the transfer is newer
  // than the escrow, so we refuse rather than assume.
  if (tx.blockTimestamp === null) {
    return reject('no_block_time', 'The node did not report a timestamp for this block.', true);
  }
  if (tx.blockTimestamp < expect.escrowCreatedAtSeconds) {
    return reject(
      'tx_predates_escrow',
      'The transaction is older than the escrow and cannot be redeemed against it.',
    );
  }

  // The authenticated wallet must be the account that sent the transaction.
  if (tx.from !== expect.depositorAddress) {
    return reject(
      'not_sent_by_depositor',
      'The transaction was not sent by the authenticated wallet.',
    );
  }

  const toEscrow = tx.erc20Transfers.filter((t) => t.to === expect.depositAddress);
  if (toEscrow.length === 0) {
    return reject('no_transfer_to_escrow', 'No token transfer to the escrow address was found.');
  }

  let sawWrongToken = false;
  let sawWrongAmount = false;
  let sawWrongSender = false;

  for (const transfer of toEscrow) {
    if (transfer.token !== expect.token) {
      sawWrongToken = true;
      continue;
    }
    // EXACT amount. The legacy Solana check was `amt >= expectedAmount`, which
    // let one overpaying transfer satisfy an arbitrary expectation.
    if (transfer.value !== expect.amountBase) {
      sawWrongAmount = true;
      continue;
    }
    // The tokens must leave the depositor's own balance, not merely be moved by
    // a transaction they happened to send.
    if (transfer.from !== expect.depositorAddress) {
      sawWrongSender = true;
      continue;
    }
    return {
      ok: true,
      amountBase: transfer.value,
      blockNumber: tx.blockNumber,
      blockTimestamp: tx.blockTimestamp,
      logIndex: transfer.logIndex,
      fromAddress: transfer.from,
    };
  }

  if (sawWrongSender) {
    return reject('wrong_sender', 'The tokens did not come from the authenticated wallet.');
  }
  if (sawWrongToken) return reject('wrong_token', 'The transfer used a different token contract.');
  if (sawWrongAmount) {
    return reject('wrong_amount', 'The transferred amount does not exactly match the stake.');
  }
  return reject('no_transfer_to_escrow', 'No qualifying transfer to the escrow was found.');
}
