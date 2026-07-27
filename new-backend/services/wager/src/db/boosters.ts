/**
 * Booster sale persistence (H-3, H-2).
 *
 * Two tables carry the money-critical guarantees:
 *
 *  wager.booster_offers   — server-issued purchase intents (nonce, exact price,
 *                           recipient, expiry). The client cannot name a price.
 *  wager.booster_intents  — the RESERVATION, keyed by `payment_sig` (the payment
 *                           transaction hash, column name kept from 0005). Inserted
 *                           BEFORE any mint is attempted, in the same
 *                           transaction that takes the ticket number and checks
 *                           the supply cap. A replayed payment signature hits the
 *                           primary key and is rejected by Postgres, not by an
 *                           application `SELECT ... then INSERT` race.
 *
 * Ticket numbers come from a counter row taken `FOR UPDATE`, never `MAX(...)+1`.
 */
import type { Pool, PoolClient } from 'pg';

export type BoosterIntentStatus = 'reserved' | 'minted' | 'failed';
export type RedemptionKind = 'digital' | 'physical' | 'merch';

export class SoldOutError extends Error {
  constructor(public readonly cap: number) {
    super('sold out');
    this.name = 'SoldOutError';
  }
}

// ── offers ──────────────────────────────────────────────────────────────────

export interface OfferRow {
  nonce: string;
  profileId: string;
  address: string;
  amountWei: bigint;
  recipient: string;
  status: 'open' | 'consumed';
  expiresAt: Date;
  createdAt: Date;
}

interface RawOffer {
  nonce: string;
  profile_id: string;
  address: string;
  amount_wei: string;
  recipient: string;
  status: 'open' | 'consumed';
  expires_at: Date;
  created_at: Date;
}

const OFFER_COLUMNS = `nonce, profile_id, address, amount_wei, recipient, status, expires_at, created_at`;

function mapOffer(row: RawOffer): OfferRow {
  return {
    nonce: row.nonce,
    profileId: row.profile_id,
    address: row.address,
    amountWei: BigInt(row.amount_wei),
    recipient: row.recipient,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function insertOffer(
  q: Pool | PoolClient,
  input: {
    nonce: string;
    profileId: string;
    address: string;
    amountWei: bigint;
    recipient: string;
    ttlSeconds: number;
  },
): Promise<OfferRow> {
  const { rows } = await q.query<RawOffer>(
    `INSERT INTO wager.booster_offers
       (nonce, profile_id, address, amount_wei, recipient, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'open', now() + make_interval(secs => $6))
     RETURNING ${OFFER_COLUMNS}`,
    [
      input.nonce,
      input.profileId,
      input.address,
      input.amountWei.toString(),
      input.recipient,
      input.ttlSeconds,
    ],
  );
  return mapOffer(rows[0]!);
}

export async function lockOffer(client: PoolClient, nonce: string): Promise<OfferRow | null> {
  const { rows } = await client.query<RawOffer>(
    `SELECT ${OFFER_COLUMNS} FROM wager.booster_offers WHERE nonce = $1 FOR UPDATE`,
    [nonce],
  );
  return rows[0] ? mapOffer(rows[0]) : null;
}

export async function consumeOffer(client: PoolClient, nonce: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE wager.booster_offers SET status = 'consumed'
      WHERE nonce = $1 AND status = 'open' AND expires_at > now()`,
    [nonce],
  );
  return (rowCount ?? 0) > 0;
}

// ── reservations ────────────────────────────────────────────────────────────

export interface IntentRow {
  /** The payment transaction hash. */
  paymentTxHash: string;
  nonce: string;
  profileId: string;
  ownerAddress: string;
  amountWei: bigint;
  ticketNumber: number;
  /** Null until on-chain issuance happens. */
  assetAddress: string | null;
  tokenId: string | null;
  mintTxHash: string | null;
  status: BoosterIntentStatus;
  failureReason: string | null;
  reservedAt: Date;
  mintedAt: Date | null;
}

interface RawIntent {
  payment_sig: string;
  nonce: string;
  profile_id: string;
  owner_address: string;
  amount_wei: string;
  ticket_number: number;
  mint_address: string | null;
  token_id: string | null;
  mint_tx_hash: string | null;
  status: BoosterIntentStatus;
  failure_reason: string | null;
  reserved_at: Date;
  minted_at: Date | null;
}

const INTENT_COLUMNS = `payment_sig, nonce, profile_id, owner_address, amount_wei,
                        ticket_number, mint_address, token_id, mint_tx_hash, status,
                        failure_reason, reserved_at, minted_at`;

function mapIntent(row: RawIntent): IntentRow {
  return {
    paymentTxHash: row.payment_sig,
    nonce: row.nonce,
    profileId: row.profile_id,
    ownerAddress: row.owner_address,
    amountWei: BigInt(row.amount_wei),
    ticketNumber: row.ticket_number,
    assetAddress: row.mint_address,
    tokenId: row.token_id,
    mintTxHash: row.mint_tx_hash,
    status: row.status,
    failureReason: row.failure_reason,
    reservedAt: row.reserved_at,
    mintedAt: row.minted_at,
  };
}

export interface SupplySnapshot {
  cap: number;
  reserved: number;
  remaining: number;
}

export async function readSupply(q: Pool | PoolClient, envCap: number): Promise<SupplySnapshot> {
  const { rows } = await q.query<{ supply_cap: number; reserved_count: number }>(
    `SELECT supply_cap, reserved_count FROM wager.booster_counter WHERE id = true`,
  );
  const row = rows[0];
  const cap = Math.min(row?.supply_cap ?? 0, envCap);
  const reserved = row?.reserved_count ?? 0;
  return { cap, reserved, remaining: Math.max(cap - reserved, 0) };
}

/**
 * The reservation. MUST be called inside a transaction that also verifies the
 * payment; the caller rolls back if verification fails.
 *
 * Order of operations matters:
 *   1. lock the counter row (serialises every concurrent buyer),
 *   2. check the cap,
 *   3. take the next ticket number and bump the counter,
 *   4. insert the reservation keyed by the payment transaction hash.
 * Issuance happens only after this transaction has COMMITTED.
 */
export async function reserveTicket(
  client: PoolClient,
  input: {
    paymentTxHash: string;
    nonce: string;
    profileId: string;
    ownerAddress: string;
    amountWei: bigint;
    envCap: number;
  },
): Promise<IntentRow> {
  const counter = await client.query<{
    next_ticket_number: number;
    supply_cap: number;
    reserved_count: number;
  }>(
    `SELECT next_ticket_number, supply_cap, reserved_count
       FROM wager.booster_counter WHERE id = true FOR UPDATE`,
  );
  const row = counter.rows[0];
  if (!row) throw new Error('wager.booster_counter is not seeded');

  const cap = Math.min(row.supply_cap, input.envCap);
  if (row.reserved_count >= cap) throw new SoldOutError(cap);

  const ticketNumber = row.next_ticket_number;
  await client.query(
    `UPDATE wager.booster_counter
        SET next_ticket_number = next_ticket_number + 1,
            reserved_count = reserved_count + 1
      WHERE id = true`,
  );

  const { rows } = await client.query<RawIntent>(
    `INSERT INTO wager.booster_intents
       (payment_sig, nonce, profile_id, owner_address, amount_wei, ticket_number, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'reserved')
     RETURNING ${INTENT_COLUMNS}`,
    [
      input.paymentTxHash,
      input.nonce,
      input.profileId,
      input.ownerAddress,
      input.amountWei.toString(),
      ticketNumber,
    ],
  );
  return mapIntent(rows[0]!);
}

export async function getIntent(
  q: Pool | PoolClient,
  paymentTxHash: string,
): Promise<IntentRow | null> {
  const { rows } = await q.query<RawIntent>(
    `SELECT ${INTENT_COLUMNS} FROM wager.booster_intents WHERE payment_sig = $1`,
    [paymentTxHash],
  );
  return rows[0] ? mapIntent(rows[0]) : null;
}

export async function lockIntent(
  client: PoolClient,
  paymentTxHash: string,
): Promise<IntentRow | null> {
  const { rows } = await client.query<RawIntent>(
    `SELECT ${INTENT_COLUMNS} FROM wager.booster_intents WHERE payment_sig = $1 FOR UPDATE`,
    [paymentTxHash],
  );
  return rows[0] ? mapIntent(rows[0]) : null;
}

export async function markMinted(
  q: Pool | PoolClient,
  paymentTxHash: string,
  issued: { assetAddress: string; tokenId: string; mintTxHash: string },
): Promise<void> {
  await q.query(
    `UPDATE wager.booster_intents
        SET status = 'minted', mint_address = $2, token_id = $3, mint_tx_hash = $4,
            minted_at = now(), failure_reason = NULL
      WHERE payment_sig = $1 AND status <> 'minted'`,
    [paymentTxHash, issued.assetAddress, issued.tokenId, issued.mintTxHash],
  );
}

/**
 * Mint failed. The row keeps its ticket number forever — the number is never
 * handed to anyone else, and a retry re-uses this same row and the same
 * deterministic asset address.
 */
export async function markMintFailed(
  q: Pool | PoolClient,
  paymentTxHash: string,
  reason: string,
): Promise<void> {
  await q.query(
    `UPDATE wager.booster_intents
        SET status = 'failed', failure_reason = $2
      WHERE payment_sig = $1 AND status = 'reserved'`,
    [paymentTxHash, reason.slice(0, 500)],
  );
}

/** Only ever called with the AUTHENTICATED profile id (H-2). */
export async function listTicketsForProfile(
  q: Pool | PoolClient,
  profileId: string,
): Promise<IntentRow[]> {
  const { rows } = await q.query<RawIntent>(
    `SELECT ${INTENT_COLUMNS} FROM wager.booster_intents
      WHERE profile_id = $1 ORDER BY ticket_number ASC`,
    [profileId],
  );
  return rows.map(mapIntent);
}

export async function getTicketByNumber(
  q: Pool | PoolClient,
  ticketNumber: number,
): Promise<IntentRow | null> {
  const { rows } = await q.query<RawIntent>(
    `SELECT ${INTENT_COLUMNS} FROM wager.booster_intents WHERE ticket_number = $1`,
    [ticketNumber],
  );
  return rows[0] ? mapIntent(rows[0]) : null;
}

export async function lockTicketByNumber(
  client: PoolClient,
  ticketNumber: number,
): Promise<IntentRow | null> {
  const { rows } = await client.query<RawIntent>(
    `SELECT ${INTENT_COLUMNS} FROM wager.booster_intents WHERE ticket_number = $1 FOR UPDATE`,
    [ticketNumber],
  );
  return rows[0] ? mapIntent(rows[0]) : null;
}

// ── redemptions + shipping (H-2) ────────────────────────────────────────────

export interface RedemptionRow {
  id: number;
  ticketNumber: number;
  profileId: string;
  kind: RedemptionKind;
  cardIds: string[] | null;
  tracking: string | null;
  createdAt: Date;
}

interface RawRedemption {
  id: string;
  ticket_number: number;
  profile_id: string;
  kind: RedemptionKind;
  card_ids: string[] | null;
  tracking: string | null;
  created_at: Date;
}

function mapRedemption(row: RawRedemption): RedemptionRow {
  return {
    id: Number(row.id),
    ticketNumber: row.ticket_number,
    profileId: row.profile_id,
    kind: row.kind,
    cardIds: row.card_ids,
    tracking: row.tracking,
    createdAt: row.created_at,
  };
}

const REDEMPTION_COLUMNS = `id, ticket_number, profile_id, kind, card_ids, tracking, created_at`;

export async function insertRedemption(
  client: PoolClient,
  input: {
    ticketNumber: number;
    profileId: string;
    kind: RedemptionKind;
    cardIds: string[] | null;
  },
): Promise<RedemptionRow> {
  const { rows } = await client.query<RawRedemption>(
    `INSERT INTO wager.redemptions (ticket_number, profile_id, kind, card_ids)
     VALUES ($1, $2, $3, $4)
     RETURNING ${REDEMPTION_COLUMNS}`,
    [input.ticketNumber, input.profileId, input.kind, input.cardIds],
  );
  return mapRedemption(rows[0]!);
}

export async function listRedemptions(
  q: Pool | PoolClient,
  ticketNumber: number,
): Promise<RedemptionRow[]> {
  const { rows } = await q.query<RawRedemption>(
    `SELECT ${REDEMPTION_COLUMNS} FROM wager.redemptions WHERE ticket_number = $1 ORDER BY id`,
    [ticketNumber],
  );
  return rows.map(mapRedemption);
}

export async function insertShipping(
  client: PoolClient,
  input: { redemptionId: number; profileId: string; payload: unknown },
): Promise<void> {
  await client.query(
    `INSERT INTO wager.shipping (redemption_id, profile_id, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [input.redemptionId, input.profileId, JSON.stringify(input.payload)],
  );
}

export interface ShippingRow {
  redemptionId: number;
  profileId: string;
  payload: unknown;
  kind: RedemptionKind;
  createdAt: Date;
}

/**
 * Shipping payloads for a ticket. The caller is responsible for having proven
 * ownership or the operator role first; this function does not filter.
 */
export async function listShippingForTicket(
  q: Pool | PoolClient,
  ticketNumber: number,
): Promise<ShippingRow[]> {
  const { rows } = await q.query<{
    redemption_id: string;
    profile_id: string;
    payload: unknown;
    kind: RedemptionKind;
    created_at: Date;
  }>(
    `SELECT s.redemption_id, s.profile_id, s.payload, r.kind, s.created_at
       FROM wager.shipping s
       JOIN wager.redemptions r ON r.id = s.redemption_id
      WHERE r.ticket_number = $1
      ORDER BY s.redemption_id`,
    [ticketNumber],
  );
  return rows.map((row) => ({
    redemptionId: Number(row.redemption_id),
    profileId: row.profile_id,
    payload: row.payload,
    kind: row.kind,
    createdAt: row.created_at,
  }));
}
