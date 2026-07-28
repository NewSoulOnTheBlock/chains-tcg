/**
 * Deposit verification — pure (C-2).
 *
 * `verifyDepositTx` never touches the network or the database. It takes an
 * already-parsed transaction plus the expectation the SERVER derived (escrow
 * row + seat mapping + authenticated address) and answers accept/reject.
 *
 * Every field of `DepositExpectation` comes from server-held state:
 *   escrowId, amountBase, token, depositAddress ← wager.escrows
 *   seat                                        ← game.matches mapping
 *   depositorAddresses                          ← core.profile_addresses, for
 *                                                 req.auth.profileId
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
 *   2. `from` is one of the authenticated profile's LINKED addresses, so a
 *      payment can only ever be claimed by the player who made it. This was
 *      equality with a single address until account linking; `auth.address` is
 *      now the profile's primary wallet rather than the one it signed in with,
 *      so equality would reject a player paying from their own second wallet.
 *      The set is read from `core.profile_addresses` for the authenticated
 *      profile id and can never be widened by a request (H-2).
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
  /**
   * EVERY wallet linked to the authenticated profile, lower-case.
   *
   * Plural since account linking: `auth.address` is the profile's PRIMARY
   * address, which is not necessarily the wallet the player signed in with and
   * is certainly not necessarily the wallet they pay from. A player who pays
   * from a linked secondary is the same player.
   *
   * The set always comes from `core.profile_addresses` for the authenticated
   * profile id (`services/wager/src/services/transactingAddresses.ts`), NEVER
   * from a request field — H-2. An empty set rejects everything, which is the
   * safe direction.
   */
  depositorAddresses: readonly string[];
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

  // One of the authenticated profile's wallets must be the account that sent
  // the transaction. Membership in a server-derived set, not equality with a
  // single address — but still a closed set, and still one the request cannot
  // influence.
  if (!expect.depositorAddresses.includes(tx.from)) {
    return reject(
      'not_sent_by_depositor',
      'The transaction was not sent by one of your linked wallets.',
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
    // The tokens must leave one of the depositor's own balances, not merely be
    // moved by a transaction they happened to send.
    //
    // Tested independently of `tx.from` above rather than pinned to whichever
    // address matched there. Both are wallets of the SAME profile, so a player
    // sending from wallet A a transaction that moves wallet B's tokens is moving
    // their own money either way; and `fromAddress` below returns the wallet
    // whose balance actually fell, which is where a refund has to go.
    if (!expect.depositorAddresses.includes(transfer.from)) {
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
    return reject('wrong_sender', 'The tokens did not come from one of your linked wallets.');
  }
  if (sawWrongToken) return reject('wrong_token', 'The transfer used a different token contract.');
  if (sawWrongAmount) {
    return reject('wrong_amount', 'The transferred amount does not exactly match the stake.');
  }
  return reject('no_transfer_to_escrow', 'No qualifying transfer to the escrow was found.');
}
