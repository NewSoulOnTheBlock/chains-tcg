// src/api/wager.ts
//
// Escrowed stakes on a match. All routes require a token AND participation in
// the match.
//
// ═══════════════════════════════════════════════════════════════════════════
// STUBBED SERVER-SIDE — DO NOT LET THE UI PROMISE OTHERWISE (INTEGRATION.md §7)
// ═══════════════════════════════════════════════════════════════════════════
//
// • BOOSTER MINTING DOES NOT EXIST. `UnavailableTicketMinter` is what is wired
//   in. Reservation, ticket numbering, the supply cap and the idempotency
//   constraints are all real and enforced in the database, but NO NFT IS EVER
//   MINTED and `mint_address` / `token_id` stay NULL. Never show "your booster
//   has been minted", never render a token link, never imply an on-chain
//   asset. `GET /wager/boosters/supply` reports `mintingEnabled: false` —
//   gate the entire booster UI on it.
//
// • NO PAYOUT HAS EVER BEEN EXECUTED ON-CHAIN. The sign → persist → broadcast
//   → reconcile path is unit-tested and has never run against a real chain.
//   Deposit verification has never seen a real ERC-20 transfer either.
//
// • THERE IS NO DEPLOYED ESCROW CONTRACT. `depositAddress` is a recorded EOA
//   controlled by the wager service's own hot wallet, frozen per escrow at
//   creation. Funds sit in a hot wallet, not in a contract. This is the single
//   largest gap between this design and a trustworthy one — the UI must not
//   describe deposits as "locked in a smart contract".
//
// • DIGITAL REDEMPTION IS OFF (`BOOSTER_CARD_POOL` is empty → 503).
//
// ─── HOW STAKES WORK ────────────────────────────────────────────────────────
// A client NAMES A TIER INDEX, never an amount. `tier` is an index into the
// server's own allowlist (`GET /wager/stakes`); there is NO `amount` field and
// sending one is a 400, because a client that names its own amount can name a
// smaller one than its opponent's.
//
// ─── THERE IS NO SETTLEMENT ENDPOINT ────────────────────────────────────────
// `POST /wager/settle`, `POST /wager/escrows/:id/settle` and the legacy
// `POST /api/result` all 404. Payouts are decided by a background worker from
// HMAC-verified match results and by nothing else. Poll `getEscrow()`.
//
// ─── BROADCASTING ───────────────────────────────────────────────────────────
// `/rpc/evm` is READ-ONLY (`eth_sendRawTransaction` is refused with 403). The
// browser must broadcast the deposit through the user's own wallet provider,
// then post the resulting hash here.

import { get, post } from './http.js';
import { ApiError } from './errors.js';
import type { Seat } from './lobby.js';

export type { Seat } from './lobby.js';

/** `open` → accepting deposits; `funded` → both seats paid; then terminal. */
export type EscrowStatus = 'open' | 'funded' | 'settled' | 'refunded' | 'void';

/** One entry of the server's stake allowlist. */
export interface StakeTier {
  /** THE INDEX YOU SEND as `tier`. Not an amount, not an id. */
  tier: number;
  /** Decimal string in TOKEN BASE UNITS (bigint-safe). Never `parseInt` it. */
  amountBase: string;
}

/**
 * `GET /wager/stakes`.
 *
 * There is no `label` or human-readable amount — format `amountBase` yourself
 * with `decimals` (see `formatAmount` below).
 */
export interface Stakes {
  tiers: StakeTier[];
  /** The ONLY ERC-20 the escrow accepts. Lowercase contract address. */
  token: string;
  /** Display only. All server arithmetic is in base units. */
  decimals: number;
}

export interface Escrow {
  /** uuid string. */
  id: string;
  matchId: string;
  /** Decimal string, base units. */
  amountBase: string;
  /** ERC-20 contract address. Note the field is `token`, NOT `tokenAddress`. */
  token: string;
  decimals: number;
  status: EscrowStatus;
  /** ISO-8601. */
  createdAt: string;
  /** Which seat YOU hold. `null` only when an operator reads someone else's. */
  yourSeat: Seat | null;
  /**
   * Where this escrow's deposits must be sent. A plain EOA — see the file
   * header. Frozen at escrow creation so a key rotation cannot redefine what
   * an existing escrow accepts.
   */
  depositAddress: string;
  /** Always exactly two entries. Booleans only — never the opponent's address. */
  seats: Array<{ seat: Seat; funded: boolean; isYou: boolean }>;
  /** `null` until the settlement worker acts. */
  payout: { status: string; txSig: string | null } | null;
}

/** `POST /wager/escrows/:id/deposits` — 201, NOT wrapped in a key. */
export interface DepositResult {
  accepted: true;
  seat: Seat;
  escrowStatus: EscrowStatus;
  bothSeatsFunded: boolean;
}

// ── Error helpers ───────────────────────────────────────────────────────────

/**
 * The tx hash was already bound to an escrow seat. `409 conflict` +
 * `reason: 'signature_already_used'`. Not a failure to retry — the deposit
 * either already counted or belongs to someone else.
 */
export function isDuplicateDepositError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.reason === 'signature_already_used';
}

/**
 * Deposit verification rejected the transaction. `details.reason` is prefixed
 * `deposit_` (e.g. `deposit_not_enough_confirmations`, `deposit_wrong_amount`).
 *
 * Use `err.isRetryable` (from `details.retryable`) rather than parsing the
 * reason: merely-unconfirmed is retryable (409), wrong-sender is not (400).
 */
export function isDepositRejection(err: unknown): err is ApiError {
  return err instanceof ApiError && (err.reason?.startsWith('deposit_') ?? false);
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * `GET /wager/stakes` — the server-decided allowlist.
 *
 * Read this before rendering a stake picker; the indices are positional and
 * can change if the operator reconfigures `WAGER_STAKE_TIERS_BASE`. Never
 * hardcode a tier index.
 */
export function getStakes(signal?: AbortSignal): Promise<Stakes> {
  return get<Stakes>('/wager/stakes', { signal });
}

/**
 * `POST /wager/escrows` — 201. Opens an escrow for a match.
 *
 * `tier` is AN INDEX INTO `getStakes().tiers`. There is no `amount` field;
 * sending one is a 400 (the body is a strict object).
 *
 * Idempotent in practice: if an escrow already exists for the match at the
 * same amount, the server returns 201 with the existing one rather than
 * erroring. It is NOT retried automatically on a 429 all the same.
 *
 * Errors: 400 + `reason: 'unknown_stake_tier'` (`details.tiers` carries the
 * valid list); 404 + `reason: 'match_not_found'`; 403 +
 * `reason: 'not_a_participant'`; 409 + `reason: 'match_not_joinable' |
 * 'stake_mismatch'` (the opponent already opened one at a different tier).
 *
 * Rate limited to 10/min per profile.
 */
export async function createEscrow(
  params: { matchId: string; tier: number },
  signal?: AbortSignal,
): Promise<Escrow> {
  const { escrow } = await post<{ escrow: Escrow }>(
    '/wager/escrows',
    // `tier` MUST be a JSON number — there is no server-side coercion.
    { matchId: params.matchId, tier: params.tier },
    { signal },
  );
  return escrow;
}

/**
 * `GET /wager/escrows/:id` — funding state per seat.
 *
 * This is also how you observe settlement: there is no settlement endpoint, so
 * poll `status` and `payout` until `status` is terminal.
 *
 * 404 + `reason: 'escrow_not_found'`; 403 + `reason: 'not_a_participant'`.
 */
export async function getEscrow(id: string, signal?: AbortSignal): Promise<Escrow> {
  const { escrow } = await get<{ escrow: Escrow }>(
    `/wager/escrows/${encodeURIComponent(id)}`,
    { signal },
  );
  return escrow;
}

/**
 * `POST /wager/escrows/:id/deposits` — 201. Body is `{txHash}` ONLY.
 *
 * The seat comes from the session, the amount from the escrow, and the payer
 * from the verified on-chain transfer log. Nothing else is accepted (strict
 * body). `txHash` must be a 0x-prefixed 32-byte hex string.
 *
 * NEVER RETRIED AUTOMATICALLY. This binds a transaction to an escrow seat and
 * a blind replay is exactly what the 409 uniqueness constraints exist to
 * catch. If you get a retryable rejection (`err.isRetryable`, typically
 * "not enough confirmations"), back off and call again deliberately.
 *
 * The response is NOT wrapped in a key, unlike the escrow routes.
 */
export function submitDeposit(
  id: string,
  body: { txHash: string },
  signal?: AbortSignal,
): Promise<DepositResult> {
  return post<DepositResult>(
    `/wager/escrows/${encodeURIComponent(id)}/deposits`,
    { txHash: body.txHash },
    { signal, retryOn429: false },
  );
}

// ── Display helpers ─────────────────────────────────────────────────────────

/**
 * Format a base-unit decimal string for display, without going through
 * `Number` (which loses precision above 2^53).
 *
 *   formatAmount('1000000', 6) === '1'
 *   formatAmount('1500000', 6) === '1.5'
 */
export function formatAmount(amountBase: string, decimals: number): string {
  const negative = amountBase.startsWith('-');
  const digits = (negative ? amountBase.slice(1) : amountBase).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
