/**
 * Booster sale + redemption (H-3, H-2).
 *
 * Purchase flow:
 *   POST /boosters/intents  → server issues { nonce, recipient, valueWei, data }
 *   client sends exactly that value to that address, with `data` as calldata
 *   POST /boosters/confirm { paymentTxHash }
 *        → fetch the tx (read-only), read the intent nonce out of its calldata
 *        → ONE transaction: lock the offer, verify the payment offline, consume
 *          the offer, take a ticket number from the counter row under FOR UPDATE,
 *          enforce the supply cap, INSERT the reservation keyed by the payment
 *          transaction hash
 *        → COMMIT, and only then issue the ticket
 *
 * The reservation COMMITS before issuance is attempted, so a crash can never
 * hand the same ticket number to a second buyer, and the payment hash is a
 * primary key, so a payment can be redeemed exactly once, globally, forever.
 *
 * On-chain issuance is currently unavailable (see `chain/ticketMinter.ts`): a
 * confirmed purchase settles as a durable `reserved` row and the endpoint
 * answers 202. Everything the audit flagged under H-3 is still enforced.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError, getPool, isUniqueViolation, withTransaction } from '../platform/shared.js';
import { log } from '../platform/logger.js';
import type { AuthContext } from '../platform/shared.js';
import {
  consumeOffer,
  getIntent,
  getTicketByNumber,
  insertOffer,
  insertRedemption,
  insertShipping,
  listRedemptions,
  listShippingForTicket,
  listTicketsForProfile,
  lockOffer,
  lockTicketByNumber,
  markMintFailed,
  markMinted,
  readSupply,
  reserveTicket,
  SoldOutError,
  type IntentRow,
  type RedemptionKind,
} from '../db/boosters.js';
import { grantCards, type GrantSummary } from '../db/ownership.js';
import {
  intentCalldata,
  nonceFromCalldata,
  verifyBoosterPayment,
} from '../domain/boosterPayment.js';
import { rollTicketCards } from '../domain/packRoll.js';
import type { ChainReader, TicketMinter } from '../chain/types.js';

export interface BoosterServiceDeps {
  reader: ChainReader;
  minter: TicketMinter;
  /** Lower-case treasury address that payments must credit. */
  treasuryAddress: string;
  priceWei: bigint;
  minConfirmations: number;
  supplyCap: number;
  intentTtlSeconds: number;
  cardPool: readonly string[];
  packSecret: string;
}

export interface TicketView {
  ticketNumber: number;
  /** Null until on-chain issuance happens. */
  assetAddress: string | null;
  tokenId: string | null;
  status: string;
  ownerAddress: string;
  reservedAt: string;
  mintedAt: string | null;
  redemptions: Array<{ kind: RedemptionKind; at: string; cardIds: string[] | null; tracking: string | null }>;
}

function view(intent: IntentRow, redemptions: Awaited<ReturnType<typeof listRedemptions>>): TicketView {
  return {
    ticketNumber: intent.ticketNumber,
    assetAddress: intent.assetAddress,
    tokenId: intent.tokenId,
    status: intent.status,
    ownerAddress: intent.ownerAddress,
    reservedAt: intent.reservedAt.toISOString(),
    mintedAt: intent.mintedAt ? intent.mintedAt.toISOString() : null,
    redemptions: redemptions.map((r) => ({
      kind: r.kind,
      at: r.createdAt.toISOString(),
      cardIds: r.cardIds,
      tracking: r.tracking,
    })),
  };
}

export async function supplySnapshot(deps: BoosterServiceDeps): Promise<{
  cap: number;
  reserved: number;
  remaining: number;
  priceWei: string;
  treasury: string;
  mintingEnabled: boolean;
}> {
  const s = await readSupply(getPool(), deps.supplyCap);
  return {
    cap: s.cap,
    reserved: s.reserved,
    remaining: s.remaining,
    priceWei: deps.priceWei.toString(),
    treasury: deps.treasuryAddress,
    mintingEnabled: deps.minter.enabled,
  };
}

export interface BoosterIntentView {
  nonce: string;
  recipient: string;
  /** Exact value the payment must carry, in wei. */
  valueWei: string;
  /** Calldata the payment must carry — this is what binds it to THIS intent. */
  data: string;
  expiresAt: string;
}

export async function createBoosterIntent(
  deps: BoosterServiceDeps,
  auth: AuthContext,
): Promise<BoosterIntentView> {
  const supply = await readSupply(getPool(), deps.supplyCap);
  if (supply.remaining <= 0) {
    throw new AppError('conflict', 'All booster tickets have been reserved', { reason: 'sold_out' });
  }

  const nonce = randomBytes(16).toString('hex');
  const offer = await insertOffer(getPool(), {
    nonce,
    profileId: auth.profileId,
    address: auth.address.toLowerCase(),
    // Price is server-side. The client never proposes an amount.
    amountWei: deps.priceWei,
    recipient: deps.treasuryAddress,
    ttlSeconds: deps.intentTtlSeconds,
  });

  return {
    nonce: offer.nonce,
    recipient: offer.recipient,
    valueWei: offer.amountWei.toString(),
    data: intentCalldata(offer.nonce),
    expiresAt: offer.expiresAt.toISOString(),
  };
}

export interface ConfirmResult {
  ticket: TicketView;
  /** False while on-chain issuance is pending or unavailable. */
  minted: boolean;
  mintTxHash: string | null;
}

export async function confirmBoosterPayment(
  deps: BoosterServiceDeps,
  auth: AuthContext,
  input: { paymentTxHash: string },
): Promise<ConfirmResult> {
  // Already reserved? Resume rather than reserving again.
  const existing = await getIntent(getPool(), input.paymentTxHash);
  if (existing) {
    if (existing.profileId !== auth.profileId) {
      throw AppError.forbidden('That payment belongs to another account', { reason: 'not_your_payment' });
    }
    return finishMint(deps, existing);
  }

  const tx = await deps.reader.getTransaction(input.paymentTxHash);
  if (!tx) {
    throw AppError.conflict('That payment is not visible on-chain yet', {
      reason: 'payment_not_found',
      retryable: true,
    });
  }
  const nonce = nonceFromCalldata(tx.input);
  if (!nonce) {
    throw AppError.badRequest('The payment does not carry a purchase-intent nonce', {
      reason: 'payment_calldata_missing',
    });
  }

  const reservation = await withTransaction(async (client: PoolClient) => {
    const offer = await lockOffer(client, nonce);
    if (!offer) throw AppError.notFound('No such purchase intent', { reason: 'unknown_intent' });
    if (offer.profileId !== auth.profileId) {
      throw AppError.forbidden('That purchase intent belongs to another account', {
        reason: 'not_your_intent',
      });
    }
    if (offer.status !== 'open') {
      throw AppError.conflict('That purchase intent has already been used', {
        reason: 'intent_already_used',
      });
    }
    if (offer.expiresAt.getTime() <= Date.now()) {
      throw AppError.conflict('That purchase intent has expired', { reason: 'intent_expired' });
    }

    const verdict = verifyBoosterPayment(tx, {
      nonce,
      recipient: deps.treasuryAddress,
      amountWei: offer.amountWei,
      payerAddress: auth.address.toLowerCase(),
      intentCreatedAtSeconds: Math.floor(offer.createdAt.getTime() / 1000),
      minConfirmations: deps.minConfirmations,
    });
    if (!verdict.ok) {
      throw verdict.retryable
        ? AppError.conflict(verdict.message, { reason: `payment_${verdict.code}`, retryable: true })
        : AppError.badRequest(verdict.message, {
            reason: `payment_${verdict.code}`,
            retryable: false,
          });
    }

    if (!(await consumeOffer(client, nonce))) {
      throw AppError.conflict('That purchase intent has already been used', {
        reason: 'intent_already_used',
      });
    }

    try {
      return await reserveTicket(client, {
        paymentTxHash: input.paymentTxHash,
        nonce,
        profileId: auth.profileId,
        ownerAddress: auth.address.toLowerCase(),
        amountWei: verdict.amountWei,
        envCap: deps.supplyCap,
      });
    } catch (err) {
      if (err instanceof SoldOutError) {
        throw new AppError('conflict', 'All booster tickets have been reserved', { reason: 'sold_out' });
      }
      if (isUniqueViolation(err)) {
        throw AppError.conflict('That payment signature has already been used for a ticket', {
          reason: 'payment_already_used',
        });
      }
      throw err;
    }
  });

  log().info('booster_ticket_reserved', {
    ticket_number: reservation.ticketNumber,
    profile_id: auth.profileId,
  });
  return finishMint(deps, reservation);
}

/**
 * Issue (or re-issue) the on-chain ticket for an already-committed reservation.
 *
 * Safe to call any number of times. The reservation, the ticket number and the
 * supply accounting are already durable at this point, so this function can only
 * ever move a row from `reserved` to `minted` — never allocate anything.
 *
 * While `minter.enabled` is false the reservation simply stays `reserved`. That
 * is a legitimate terminal-for-now state, not a failure: the buyer owns ticket
 * number N and nobody else can be given it.
 */
async function finishMint(deps: BoosterServiceDeps, intent: IntentRow): Promise<ConfirmResult> {
  if (intent.status === 'minted') {
    return {
      ticket: view(intent, await listRedemptions(getPool(), intent.ticketNumber)),
      minted: true,
      mintTxHash: intent.mintTxHash,
    };
  }

  if (!deps.minter.enabled) {
    return {
      ticket: view(intent, await listRedemptions(getPool(), intent.ticketNumber)),
      minted: false,
      mintTxHash: null,
    };
  }

  try {
    const res = await deps.minter.mintTicket({
      paymentTxHash: intent.paymentTxHash,
      ownerAddress: intent.ownerAddress,
      ticketNumber: intent.ticketNumber,
    });
    await markMinted(getPool(), intent.paymentTxHash, {
      assetAddress: res.assetAddress,
      tokenId: res.tokenId,
      mintTxHash: res.txHash,
    });
    const fresh = (await getIntent(getPool(), intent.paymentTxHash)) ?? intent;
    log().info('booster_ticket_minted', { ticket_number: intent.ticketNumber });
    return {
      ticket: view(fresh, await listRedemptions(getPool(), intent.ticketNumber)),
      minted: true,
      mintTxHash: res.txHash,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The ticket number stays with this row forever — a failed issuance never
    // releases it to another buyer.
    await markMintFailed(getPool(), intent.paymentTxHash, reason);
    log().error('booster_mint_failed', {
      ticket_number: intent.ticketNumber,
      err_message: reason,
    });
    const fresh = (await getIntent(getPool(), intent.paymentTxHash)) ?? intent;
    return {
      ticket: view(fresh, await listRedemptions(getPool(), intent.ticketNumber)),
      minted: false,
      mintTxHash: null,
    };
  }
}

// ── inventory + redemption (H-2) ────────────────────────────────────────────

/** Only ever the caller's own tickets. There is no "tickets by wallet" route. */
export async function listMyTickets(auth: AuthContext): Promise<TicketView[]> {
  const intents = await listTicketsForProfile(getPool(), auth.profileId);
  const out: TicketView[] = [];
  for (const intent of intents) {
    out.push(view(intent, await listRedemptions(getPool(), intent.ticketNumber)));
  }
  return out;
}

async function requireOwnedTicket(
  auth: AuthContext,
  ticketNumber: number,
  allowOperator: boolean,
): Promise<IntentRow> {
  const intent = await getTicketByNumber(getPool(), ticketNumber);
  if (!intent) throw AppError.notFound('No such ticket', { reason: 'ticket_not_found' });
  const isOwner = intent.profileId === auth.profileId;
  const isOperator = allowOperator && auth.roles.includes('operator');
  if (!isOwner && !isOperator) {
    // Same response as "not found" would leak less, but the ticket number space
    // is public (it is printed on the NFT), so an explicit 403 is honest.
    throw AppError.forbidden('That ticket belongs to another account', {
      reason: 'not_your_ticket',
    });
  }
  return intent;
}

export async function getMyTicket(
  auth: AuthContext,
  ticketNumber: number,
): Promise<TicketView> {
  const intent = await requireOwnedTicket(auth, ticketNumber, true);
  return view(intent, await listRedemptions(getPool(), ticketNumber));
}

export interface ShippingAddress {
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  email?: string;
}

export async function redeemTicket(
  deps: BoosterServiceDeps,
  auth: AuthContext,
  input: { ticketNumber: number; kind: RedemptionKind; address?: ShippingAddress },
): Promise<{ ticket: TicketView; cardIds: string[] | null }> {
  if (input.kind !== 'digital' && !input.address) {
    throw AppError.badRequest('A shipping address is required for this redemption', {
      reason: 'address_required',
    });
  }
  if (input.kind === 'digital' && deps.cardPool.length === 0) {
    throw AppError.unavailable('Digital redemption is not available on this deployment', {
      reason: 'card_pool_unconfigured',
    });
  }

  const NOTHING_GRANTED: GrantSummary = { distinctCards: 0, totalCards: 0 };

  const outcome = await withTransaction(async (client: PoolClient) => {
    // Ownership is proven against the reservation row, never a body field.
    const intent = await lockTicketByNumber(client, input.ticketNumber);
    if (!intent) throw AppError.notFound('No such ticket', { reason: 'ticket_not_found' });
    if (intent.profileId !== auth.profileId) {
      throw AppError.forbidden('That ticket belongs to another account', {
        reason: 'not_your_ticket',
      });
    }
    if (intent.status === 'failed') {
      throw AppError.conflict('This ticket could not be issued; contact support', {
        reason: 'ticket_issue_failed',
      });
    }

    const cardIds =
      input.kind === 'digital'
        ? rollTicketCards({
            pool: deps.cardPool,
            ticketNumber: intent.ticketNumber,
            secret: deps.packSecret,
          })
        : null;

    let redemptionId: number;
    try {
      const row = await insertRedemption(client, {
        ticketNumber: intent.ticketNumber,
        profileId: auth.profileId,
        kind: input.kind,
        cardIds,
      });
      redemptionId = row.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw AppError.conflict(`This ticket's ${input.kind} reward is already redeemed`, {
          reason: 'already_redeemed',
        });
      }
      throw err;
    }

    if (input.address) {
      await insertShipping(client, {
        redemptionId,
        profileId: auth.profileId,
        payload: input.address,
      });
    }

    // Ownership is recorded HERE, in the same transaction that hands out the
    // ids, or it is not recorded at all. A split would produce cards that
    // nobody owns and nothing would report it.
    //
    // `cardIds` is null for every non-digital kind, and only a digital
    // redemption grants in-game cards: a physical redemption ships real
    // cardboard and must not touch the collection.
    const granted = cardIds
      ? await grantCards(client, { profileId: auth.profileId, cardIds })
      : NOTHING_GRANTED;

    return { cardIds, granted };
  });

  const { cardIds: cards, granted } = outcome;

  log().info('ticket_redeemed', {
    ticket_number: input.ticketNumber,
    kind: input.kind,
    // Reconciliation: which collection moved, by how much. The card ids
    // themselves are already durable on the redemption row.
    profile_id: auth.profileId,
    cards_granted: granted.totalCards,
    distinct_cards_granted: granted.distinctCards,
  });
  const intent = await getTicketByNumber(getPool(), input.ticketNumber);
  return {
    ticket: view(intent!, await listRedemptions(getPool(), input.ticketNumber)),
    cardIds: cards,
  };
}

/** Owner or operator only. Never reachable by wallet address (H-2). */
export async function getShipping(
  auth: AuthContext,
  ticketNumber: number,
): Promise<Array<{ kind: RedemptionKind; payload: unknown; at: string }>> {
  await requireOwnedTicket(auth, ticketNumber, true);
  const rows = await listShippingForTicket(getPool(), ticketNumber);
  return rows.map((r) => ({ kind: r.kind, payload: r.payload, at: r.createdAt.toISOString() }));
}
