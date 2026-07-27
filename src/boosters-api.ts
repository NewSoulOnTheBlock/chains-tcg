// src/boosters-api.ts
//
// Client for the booster ticket routes on the secure backend
// (`/wager/boosters/*`, INTEGRATION.md §3). Goes through `src/api/http` so it
// inherits the bearer token, the refresh-once-on-401 and the 429 handling.
//
// ═══════════════════════════════════════════════════════════════════════════
// NOTHING HERE MINTS AN NFT (INTEGRATION.md §7)
// ═══════════════════════════════════════════════════════════════════════════
//
// `UnavailableTicketMinter` is what is wired in production. The reservation,
// the ticket number, the supply cap and the idempotency constraints are all
// real and enforced in Postgres — but `assetAddress` and `tokenId` stay `null`
// forever and `confirm()` answers 202 with `minted: false`.
//
// So the UI must NOT say "minted", must NOT render an explorer link, and must
// NOT imply the player owns an on-chain asset. Gate the whole purchase flow on
// `supply.mintingEnabled`, which production currently reports as `false`:
//
//   {"cap":2000,"reserved":0,"remaining":2000,
//    "priceWei":"3500000000000000",
//    "treasury":"0x2fa2…c634","mintingEnabled":false}
//
// Digital redemption is off too (`BOOSTER_CARD_POOL` is empty → 503).
//
// ─── WHAT CHANGED FROM THE LEGACY CLIENT ───────────────────────────────────
//
//   /api/boosters/*                    → /wager/boosters/*
//   buy-intent {wallet}                → POST /intents, empty body — the seat,
//                                        the price and the recipient are all
//                                        server-side; a client never proposes
//                                        an amount or names a wallet
//   confirm {wallet, signature}        → confirm {paymentTxHash}
//   tickets/:wallet (UNAUTHENTICATED!) → GET /tickets, scoped to the token.
//                                        The old route let anyone read anyone's
//                                        tickets and shipping address by
//                                        address alone — that is H-2.
//   redeem-* {mintAddress, wallet}     → tickets/:n/redeem/{kind}; ownership is
//                                        proven against the reservation row,
//                                        never a body field
//   Solana / lamports / SOL price      → EVM / wei. There is no Solana money
//                                        path in this backend at all.

import { get, post } from './api';

// ── Supply / config ────────────────────────────────────────────────────────

export type BoosterSupply = {
  cap: number;
  reserved: number;
  remaining: number;
  /** Decimal string in wei. Bigint-safe — never `Number()` it. */
  priceWei: string;
  /** The address a payment must be sent to. */
  treasury: string;
  /**
   * FALSE in production. When false, a confirmed payment still reserves a
   * ticket number but no NFT is ever issued. Gate the buy flow on this.
   */
  mintingEnabled: boolean;
};

/** `GET /wager/boosters/supply` — public, works signed out. */
export function getBoosterSupply(signal?: AbortSignal): Promise<BoosterSupply> {
  return get<BoosterSupply>('/wager/boosters/supply', { auth: 'optional', signal });
}

// ── Purchase ───────────────────────────────────────────────────────────────

export type BoosterIntent = {
  /** Server-issued, single-use. */
  nonce: string;
  /** Where the payment must go. */
  recipient: string;
  /** EXACT value the payment must carry, in wei. Decimal string. */
  valueWei: string;
  /** Calldata that binds the payment to this intent. Send it verbatim. */
  data: string;
  /** ISO-8601. */
  expiresAt: string;
};

/**
 * `POST /wager/boosters/intents` — 201. Empty body.
 *
 * The price, the recipient and the buyer all come from the server and the
 * session. Broadcast the resulting transaction through the USER'S OWN wallet:
 * `/rpc/evm` refuses `eth_sendRawTransaction` by design.
 *
 * 409 + `reason: 'sold_out'` when the cap is reached.
 */
export async function createBoosterIntent(signal?: AbortSignal): Promise<BoosterIntent> {
  const { intent } = await post<{ intent: BoosterIntent }>(
    '/wager/boosters/intents',
    {},
    { signal },
  );
  return intent;
}

export type RedemptionKind = 'digital' | 'physical' | 'merch';

export type Ticket = {
  ticketNumber: number;
  /** ALWAYS null on this deployment — no NFT is ever issued. */
  assetAddress: string | null;
  /** ALWAYS null on this deployment. */
  tokenId: string | null;
  /** `reserved` | `minted` | `mint_failed`. Production stops at `reserved`. */
  status: string;
  ownerAddress: string;
  /** ISO-8601. */
  reservedAt: string;
  /** ISO-8601, or null while unminted — which is always, here. */
  mintedAt: string | null;
  redemptions: Array<{
    kind: RedemptionKind;
    at: string;
    cardIds: string[] | null;
    tracking: string | null;
  }>;
};

export type ConfirmResult = {
  ticket: Ticket;
  /** FALSE on this deployment. Do not render "minted" when this is false. */
  minted: boolean;
  /** Null on this deployment. */
  mintTxHash: string | null;
};

/**
 * `POST /wager/boosters/confirm` — binds a paid transaction to one intent.
 *
 * 200 when the ticket minted, **202 when it only reserved**, which is the only
 * outcome production produces. Both are success: the buyer owns ticket number
 * N and nobody else can be given it.
 */
export function confirmBoosterPayment(
  paymentTxHash: string,
  signal?: AbortSignal,
): Promise<ConfirmResult> {
  return post<ConfirmResult>('/wager/boosters/confirm', { paymentTxHash }, { signal });
}

// ── Inventory + redemption ─────────────────────────────────────────────────

/**
 * `GET /wager/boosters/tickets` — YOUR tickets, scoped to the session.
 *
 * There is deliberately no route that takes a wallet address and returns
 * tickets: the legacy one did, unauthenticated, and leaked the buyer's
 * shipping address with it.
 */
export async function getMyTickets(signal?: AbortSignal): Promise<Ticket[]> {
  const { tickets } = await get<{ tickets: Ticket[] }>('/wager/boosters/tickets', { signal });
  return tickets;
}

/** `GET /wager/boosters/tickets/:n` — owner (or operator) only. */
export async function getTicket(ticketNumber: number, signal?: AbortSignal): Promise<Ticket> {
  const { ticket } = await get<{ ticket: Ticket }>(
    `/wager/boosters/tickets/${ticketNumber}`,
    { signal },
  );
  return ticket;
}

export type ShippingAddress = {
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  email?: string;
};

/**
 * `POST /wager/boosters/tickets/:n/redeem/{kind}` — 201. One redemption per
 * kind per ticket, enforced by a database constraint.
 *
 * `digital` takes no address and CURRENTLY 503s (`reason:
 * 'card_pool_unconfigured'`) because `BOOSTER_CARD_POOL` is empty — the server
 * refuses to invent card ids rather than handing out something meaningless.
 */
export function redeemTicket(
  ticketNumber: number,
  kind: RedemptionKind,
  address?: ShippingAddress,
  signal?: AbortSignal,
): Promise<{ ticket: Ticket; cardIds: string[] | null }> {
  return post<{ ticket: Ticket; cardIds: string[] | null }>(
    `/wager/boosters/tickets/${ticketNumber}/redeem/${kind}`,
    kind === 'digital' ? {} : { address },
    { signal },
  );
}

/** `GET /wager/boosters/tickets/:n/shipping` — owner or operator only (H-2). */
export async function getShipping(
  ticketNumber: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const { shipping } = await get<{ shipping: unknown }>(
    `/wager/boosters/tickets/${ticketNumber}/shipping`,
    { signal },
  );
  return shipping;
}
