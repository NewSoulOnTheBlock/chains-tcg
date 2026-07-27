/**
 * Escrow + deposit persistence.
 *
 * Every statement is a parameterised query. There is no string interpolation of
 * user data anywhere in this service — note in particular that the legacy code
 * built `SET ${col}_pubkey = $2` from a seat value taken off the request body.
 */
import type { Pool, PoolClient } from 'pg';
import type { Seat } from '../domain/seat.js';

export type Queryable = Pool | PoolClient;

export type EscrowStatus = 'open' | 'funded' | 'settled' | 'refunded' | 'void';

export interface EscrowRow {
  id: string;
  matchId: string;
  amountBase: bigint;
  /** ERC-20 contract, lower-case. */
  token: string;
  /** Address a deposit for THIS escrow must credit, lower-case. */
  depositAddress: string;
  status: EscrowStatus;
  createdAt: Date;
}

export interface DepositRow {
  signature: string;
  escrowId: string;
  seat: Seat;
  /** `core.profiles.id` as a decimal string — bigint-safe, matches req.auth. */
  profileId: string;
  fromAddress: string;
  amountBase: bigint;
  blockNumber: number | null;
  createdAt: Date;
}

interface RawEscrow {
  id: string;
  match_id: string;
  amount_base: string;
  token: string;
  deposit_address: string;
  status: EscrowStatus;
  created_at: Date;
}

function mapEscrow(row: RawEscrow): EscrowRow {
  return {
    id: row.id,
    matchId: row.match_id,
    amountBase: BigInt(row.amount_base),
    token: row.token,
    depositAddress: row.deposit_address,
    status: row.status,
    createdAt: row.created_at,
  };
}

const ESCROW_COLUMNS = `id, match_id, amount_base, token, deposit_address, status, created_at`;

export async function insertEscrow(
  q: Queryable,
  input: {
    id: string;
    matchId: string;
    amountBase: bigint;
    token: string;
    depositAddress: string;
  },
): Promise<EscrowRow> {
  const { rows } = await q.query<RawEscrow>(
    `INSERT INTO wager.escrows (id, match_id, amount_base, token, deposit_address, status)
     VALUES ($1, $2, $3, $4, $5, 'open')
     RETURNING ${ESCROW_COLUMNS}`,
    [input.id, input.matchId, input.amountBase.toString(), input.token, input.depositAddress],
  );
  return mapEscrow(rows[0]!);
}

export async function getEscrowById(q: Queryable, id: string): Promise<EscrowRow | null> {
  const { rows } = await q.query<RawEscrow>(
    `SELECT ${ESCROW_COLUMNS} FROM wager.escrows WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapEscrow(rows[0]) : null;
}

export async function getEscrowByMatchId(q: Queryable, matchId: string): Promise<EscrowRow | null> {
  const { rows } = await q.query<RawEscrow>(
    `SELECT ${ESCROW_COLUMNS} FROM wager.escrows WHERE match_id = $1`,
    [matchId],
  );
  return rows[0] ? mapEscrow(rows[0]) : null;
}

/**
 * Row-level lock. Every money-moving path takes this first, so concurrent
 * settlement attempts serialise instead of racing (M-2).
 */
export async function lockEscrow(client: PoolClient, id: string): Promise<EscrowRow | null> {
  const { rows } = await client.query<RawEscrow>(
    `SELECT ${ESCROW_COLUMNS} FROM wager.escrows WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return rows[0] ? mapEscrow(rows[0]) : null;
}

export async function setEscrowStatus(
  q: Queryable,
  id: string,
  status: EscrowStatus,
): Promise<void> {
  await q.query(`UPDATE wager.escrows SET status = $2 WHERE id = $1`, [id, status]);
}

export interface MatchSeats {
  matchId: string;
  seat0ProfileId: string | null;
  seat1ProfileId: string | null;
  status: string;
}

/**
 * The authoritative seat mapping, owned by the game service. This — not a
 * `playerID` field in the body — decides which seat a caller is funding.
 */
export async function getMatchSeats(q: Queryable, matchId: string): Promise<MatchSeats | null> {
  const { rows } = await q.query<{
    id: string;
    seat0_profile: string | null;
    seat1_profile: string | null;
    status: string;
  }>(
    `SELECT id, seat0_profile, seat1_profile, status FROM game.matches WHERE id = $1`,
    [matchId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    matchId: row.id,
    seat0ProfileId: row.seat0_profile,
    seat1ProfileId: row.seat1_profile,
    status: row.status,
  };
}

export function seatForProfile(seats: MatchSeats, profileId: string): Seat | null {
  if (seats.seat0ProfileId === profileId) return 0;
  if (seats.seat1ProfileId === profileId) return 1;
  return null;
}

// ── deposits ────────────────────────────────────────────────────────────────

const DEPOSIT_COLUMNS = `signature, escrow_id, seat, profile_id, from_address, amount_base,
                         block_number, created_at`;

interface RawDeposit {
  signature: string;
  escrow_id: string;
  seat: number;
  profile_id: string;
  from_address: string;
  amount_base: string;
  block_number: string | null;
  created_at: Date;
}

function mapDeposit(row: RawDeposit): DepositRow {
  return {
    signature: row.signature,
    escrowId: row.escrow_id,
    seat: (row.seat === 1 ? 1 : 0) as Seat,
    profileId: row.profile_id,
    fromAddress: row.from_address,
    amountBase: BigInt(row.amount_base),
    blockNumber: row.block_number === null ? null : Number(row.block_number),
    createdAt: row.created_at,
  };
}

/**
 * C-2's structural fix.
 *
 * `wager.deposits.signature` is the PRIMARY KEY, so a signature that has ever
 * been used — for this seat, the other seat, or a different escrow entirely —
 * cannot be inserted a second time. `unique (escrow_id, seat)` independently
 * caps a seat at one deposit. This INSERT runs BEFORE the chain is consulted,
 * inside the same transaction as the verification, and the transaction is rolled
 * back if verification fails. The database is the guard; no application check
 * can be raced.
 */
export async function insertDeposit(
  client: PoolClient,
  input: {
    signature: string;
    escrowId: string;
    seat: Seat;
    profileId: string;
    fromAddress: string;
    amountBase: bigint;
    blockNumber: number | null;
  },
): Promise<DepositRow> {
  const { rows } = await client.query<RawDeposit>(
    `INSERT INTO wager.deposits
       (signature, escrow_id, seat, profile_id, from_address, amount_base, block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${DEPOSIT_COLUMNS}`,
    [
      input.signature,
      input.escrowId,
      input.seat,
      input.profileId,
      input.fromAddress,
      input.amountBase.toString(),
      input.blockNumber === null ? null : String(input.blockNumber),
    ],
  );
  return mapDeposit(rows[0]!);
}

export async function listDeposits(q: Queryable, escrowId: string): Promise<DepositRow[]> {
  const { rows } = await q.query<RawDeposit>(
    `SELECT ${DEPOSIT_COLUMNS} FROM wager.deposits WHERE escrow_id = $1 ORDER BY seat`,
    [escrowId],
  );
  return rows.map(mapDeposit);
}

export async function lockDeposits(client: PoolClient, escrowId: string): Promise<DepositRow[]> {
  const { rows } = await client.query<RawDeposit>(
    `SELECT ${DEPOSIT_COLUMNS} FROM wager.deposits WHERE escrow_id = $1 ORDER BY seat FOR UPDATE`,
    [escrowId],
  );
  return rows.map(mapDeposit);
}

export async function getDepositBySignature(
  q: Queryable,
  signature: string,
): Promise<DepositRow | null> {
  const { rows } = await q.query<RawDeposit>(
    `SELECT ${DEPOSIT_COLUMNS} FROM wager.deposits WHERE signature = $1`,
    [signature],
  );
  return rows[0] ? mapDeposit(rows[0]) : null;
}
