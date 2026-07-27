/**
 * Booster ticket issuance.
 *
 * TODO: CHAIN INTEGRATION PENDING.
 *
 * The legacy implementation minted a Metaplex Core NFT on Solana. Solana is out
 * of scope for this backend and that code has been deleted rather than left
 * dormant. No EVM ticket contract is deployed yet, so there is nothing to call.
 *
 * What matters is that this is the ONLY missing piece. Everything the audit
 * flagged under H-3 is implemented and exercised without it:
 *
 *   - the payment must be bound to a server-issued intent (nonce in calldata,
 *     exact amount, correct recipient, newer than the intent),
 *   - `wager.booster_intents.payment_tx_hash` is a primary key, so a payment can
 *     be redeemed exactly once, globally, forever,
 *   - the ticket number is taken from a counter row under `FOR UPDATE`,
 *   - the supply cap is enforced inside that same transaction,
 *   - the reservation COMMITS before anything is minted.
 *
 * With `enabled === false` a confirmed purchase settles as a durable
 * reservation and the endpoint answers 202. The ticket number is already the
 * buyer's and is never handed to anyone else, so issuing the on-chain asset
 * later is a pure catch-up job.
 *
 * To finish: implement `mintTicket` against the ticket contract, keying the
 * mint on `paymentTxHash` so a retry is idempotent on-chain as well as in the
 * database (a `mint(address to, bytes32 paymentRef)` that reverts on a
 * duplicate `paymentRef` is the shape to aim for).
 */
import { AppError } from '../platform/shared.js';
import type { MintedTicket, TicketMinter } from './types.js';

export class UnavailableTicketMinter implements TicketMinter {
  readonly enabled = false;

  async mintTicket(): Promise<MintedTicket> {
    throw AppError.unavailable('Ticket minting is not configured on this deployment', {
      reason: 'minting_unavailable',
    });
  }
}
