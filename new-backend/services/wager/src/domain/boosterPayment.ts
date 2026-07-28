/**
 * Booster payment verification — pure (H-3).
 *
 * The legacy `verifyPayment` accepted ANY confirmed transaction in which the
 * treasury balance went up by at least the price and whose fee payer was the
 * claimed buyer. That meant:
 *   - any historical transfer to the treasury could be replayed as a purchase,
 *   - "at least" let one large transfer satisfy many purchases,
 *   - the buyer identity came from the request body.
 *
 * On EVM the intent binding is exact: a native-value payment carries calldata,
 * so the server-issued nonce travels *in the transaction itself*. The payment
 * must be to the treasury, for the exact quoted amount, from one of the
 * authenticated profile's linked wallets, newer than the intent, and carrying
 * that intent's nonce as calldata.
 *
 * "One of the linked wallets" rather than "the authenticated wallet" since
 * account linking: `auth.address` became the profile's PRIMARY address, so a
 * buyer signing in with one wallet and paying with another was rejected for a
 * payment that was genuinely theirs. The set is server-derived (see
 * `services/transactingAddresses.ts`) — the buyer identity still never comes
 * from the request, which is what H-3 was about.
 */
import type { ParsedTx } from '../chain/types.js';

/** 16 random bytes, hex, no `0x` — matches `randomBytes(16).toString('hex')`. */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Calldata that binds a payment to one purchase intent. */
export function intentCalldata(nonce: string): string {
  return `0x${nonce}`.toLowerCase();
}

/** The inverse: pull an intent nonce out of a transaction's calldata. */
export function nonceFromCalldata(input: string): string | null {
  const hex = input.trim().toLowerCase().replace(/^0x/, '');
  return NONCE_PATTERN.test(hex) ? hex : null;
}

export interface BoosterPaymentExpectation {
  nonce: string;
  /** Treasury address that must receive the funds. Lower-case. */
  recipient: string;
  /** EXACT amount in wei. */
  amountWei: bigint;
  /**
   * EVERY wallet linked to the authenticated buyer's profile, lower-case.
   *
   * Plural since account linking: `auth.address` is the profile's PRIMARY
   * address, not necessarily the wallet the buyer signed in with and not
   * necessarily the one they paid from. Read from `core.profile_addresses` for
   * the authenticated profile id — never from a request field (H-2). An empty
   * set rejects every payment, which is the safe direction.
   */
  payerAddresses: readonly string[];
  /** Unix seconds; the payment must be newer than the intent. */
  intentCreatedAtSeconds: number;
  minConfirmations: number;
}

export type BoosterPaymentRejectCode =
  | 'tx_not_found'
  | 'tx_reverted'
  | 'not_enough_confirmations'
  | 'calldata_missing'
  | 'no_block_time'
  | 'tx_predates_intent'
  | 'not_sent_by_payer'
  | 'wrong_recipient'
  | 'wrong_amount';

export interface BoosterPaymentRejection {
  ok: false;
  code: BoosterPaymentRejectCode;
  message: string;
  retryable: boolean;
}

export interface BoosterPaymentAcceptance {
  ok: true;
  amountWei: bigint;
  blockNumber: number;
  blockTimestamp: number;
}

export type BoosterPaymentVerdict = BoosterPaymentAcceptance | BoosterPaymentRejection;

function reject(
  code: BoosterPaymentRejectCode,
  message: string,
  retryable = false,
): BoosterPaymentRejection {
  return { ok: false, code, message, retryable };
}

export function verifyBoosterPayment(
  tx: ParsedTx | null,
  expect: BoosterPaymentExpectation,
): BoosterPaymentVerdict {
  if (!tx) return reject('tx_not_found', 'That payment has not been mined yet.', true);
  if (tx.status !== 'success') return reject('tx_reverted', 'The payment reverted on-chain.');
  if (tx.confirmations < expect.minConfirmations) {
    return reject(
      'not_enough_confirmations',
      `The payment needs ${expect.minConfirmations} confirmations.`,
      true,
    );
  }

  if (nonceFromCalldata(tx.input) !== expect.nonce) {
    return reject('calldata_missing', 'The payment does not carry this purchase intent’s nonce.');
  }

  if (tx.blockTimestamp === null) {
    return reject('no_block_time', 'The node did not report a timestamp for this block.', true);
  }
  if (tx.blockTimestamp < expect.intentCreatedAtSeconds) {
    return reject('tx_predates_intent', 'The payment is older than the purchase intent.');
  }

  if (!expect.payerAddresses.includes(tx.from)) {
    return reject('not_sent_by_payer', 'The payment was not sent by one of your linked wallets.');
  }
  if (tx.to !== expect.recipient) {
    return reject('wrong_recipient', 'The payment does not credit the booster treasury.');
  }
  if (tx.value !== expect.amountWei) {
    return reject('wrong_amount', 'The payment does not exactly match the quoted price.');
  }

  return { ok: true, amountWei: tx.value, blockNumber: tx.blockNumber, blockTimestamp: tx.blockTimestamp };
}
