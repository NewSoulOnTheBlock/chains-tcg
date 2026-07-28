/**
 * Database harness for the integration tests.
 *
 * These tests exist because the C-2 and M-2 fixes are *constraints*, not code
 * paths — asserting them against a mock would only prove the mock. They run
 * against a real Postgres when `TEST_DATABASE_URL` is set, and are skipped
 * (loudly) otherwise.
 *
 *     docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=pw --name chains-pg postgres:16-alpine
 *     TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55432/postgres npx vitest run
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, initDb, query } from '../platform/shared.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '../../../../db/migrations');

export function testDatabaseUrl(): string | null {
  return process.env.TEST_DATABASE_URL ?? null;
}

let initialised = false;

/** Apply every migration into a throwaway schema set. Idempotent per process. */
export async function setupTestDatabase(): Promise<void> {
  if (initialised) return;
  const url = testDatabaseUrl();
  if (!url) throw new Error('TEST_DATABASE_URL is not set');

  initDb({ connectionString: url, max: 4, statementTimeoutMs: 15_000 });

  // Start from a clean slate so a re-run is deterministic.
  await query(`DROP SCHEMA IF EXISTS wager CASCADE`);
  await query(`DROP SCHEMA IF EXISTS game CASCADE`);
  await query(`DROP SCHEMA IF EXISTS core CASCADE`);
  await query(`DROP SCHEMA IF EXISTS auth CASCADE`);

  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    await query(await readFile(path.join(MIGRATIONS, name), 'utf8'));
  }
  initialised = true;
}

export async function truncateAll(): Promise<void> {
  // `core.profiles` is truncated CASCADE, so anything keyed on a profile —
  // `core.card_ownership` and `core.profile_addresses` included — is emptied
  // with it. Naming those tables here would couple every test file in this
  // service to a migration it does not use.
  //
  // `core.profile_address_unlinks` is the exception and has to be named: 0013
  // deliberately gives it NO foreign key, because an audit row must outlive the
  // profile it names. Left behind, its rows arm the 30-day relink cooldown
  // against the next test that links the same fixture address to a different
  // profile id.
  await query(`
    TRUNCATE wager.shipping, wager.redemptions, wager.booster_intents,
             wager.booster_offers, wager.payouts, wager.deposits, wager.escrows,
             game.match_results, game.matches, core.audit_log,
             core.profile_address_unlinks, core.profiles
      RESTART IDENTITY CASCADE
  `);
  await query(`UPDATE wager.booster_counter SET next_ticket_number = 1, reserved_count = 0`);
}

export async function closeTestDatabase(): Promise<void> {
  if (!initialised) return;
  await getPool().end();
  initialised = false;
}

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A profile, and — since 0013 — its one primary `core.profile_addresses` row,
 * created by the `profiles_link_primary_address` trigger rather than here.
 *
 * `chain` defaults to `robinhood`, which is where every real account lives
 * since migration 0009 and therefore the only default that makes a fixture
 * resemble production. The wager service's collection sync enumerates the
 * addresses whose slug maps to the CardPack contract's chain id, so a fixture
 * on `ethereum` is a profile with no eligible wallet.
 */
export async function makeProfile(
  displayName: string,
  address: string,
  chain = 'robinhood',
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO core.profiles (address, chain, display_name)
     VALUES ($1, $2, $3) RETURNING id`,
    [address, chain, displayName],
  );
  return rows[0]!.id;
}

// ── core.profile_addresses (0013) ───────────────────────────────────────────

/**
 * Link a SECOND (or third) wallet to a profile.
 *
 * The primary row already exists — 0013's `profiles_link_primary_address`
 * trigger writes it on every profile INSERT, which is what guarantees no
 * profile can exist with zero linked addresses. So this helper defaults to
 * `is_primary = false`; asking for a second primary is a partial-unique-index
 * violation, exactly as it is in production.
 */
export async function linkAddress(input: {
  profileId: string;
  address: string;
  chain?: string;
  kind?: 'eoa' | 'smart';
  isPrimary?: boolean;
}): Promise<void> {
  await query(
    `INSERT INTO core.profile_addresses (profile_id, address, chain, kind, is_primary)
     VALUES ($1::bigint, $2, $3, $4, $5)`,
    [
      input.profileId,
      // EVM addresses are stored lowercase; a Solana address is base58 and
      // case-sensitive, so it is passed through untouched.
      input.chain === 'solana' ? input.address : input.address.toLowerCase(),
      input.chain ?? 'robinhood',
      input.kind ?? 'eoa',
      input.isPrimary ?? false,
    ],
  );
}

/**
 * Reproduce a database on which 0013 has NOT been applied.
 *
 * The wager service must survive that state — its own migrations and the auth
 * service's land in separate deploys — without either crashing or concluding
 * that every player owns nothing. The two triggers go with the table: they
 * write to it, so a profile could not be created while it is missing, and a
 * pre-0013 database had neither.
 */
export async function simulateMissingProfileAddresses(): Promise<void> {
  await query(`DROP TRIGGER IF EXISTS profiles_link_primary_address ON core.profiles`);
  await query(`DROP TRIGGER IF EXISTS profiles_sync_primary_address ON core.profiles`);
  await query(`DROP TABLE IF EXISTS core.profile_addresses CASCADE`);
}

/** Put 0013 back. It is idempotent, so re-applying the file is the whole job. */
export async function restoreProfileAddresses(): Promise<void> {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.startsWith('0013_'));
  for (const name of files) {
    await query(await readFile(path.join(MIGRATIONS, name), 'utf8'));
  }
}

export async function makeMatch(
  id: string,
  seat0: string | null,
  seat1: string | null,
): Promise<void> {
  await query(
    `INSERT INTO game.matches (id, mode, seat0_profile, seat1_profile, status)
     VALUES ($1, 'wager', $2, $3, 'live')`,
    [id, seat0, seat1],
  );
}

export async function makeMatchResult(input: {
  matchId: string;
  winnerSeat: number | null;
  reason: string;
  finishedAt: Date;
  serverSig: string;
}): Promise<void> {
  await query(
    `INSERT INTO game.match_results (match_id, winner_seat, reason, finished_at, server_sig)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.matchId, input.winnerSeat, input.reason, input.finishedAt, input.serverSig],
  );
}

export async function makeEscrow(input: {
  id: string;
  matchId: string;
  amountBase: bigint;
  status?: string;
}): Promise<void> {
  await query(
    `INSERT INTO wager.escrows (id, match_id, amount_base, token, deposit_address, status)
     VALUES ($1, $2, $3, '0x1111111111111111111111111111111111111111',
             '0x2222222222222222222222222222222222222222', $4)`,
    [input.id, input.matchId, input.amountBase.toString(), input.status ?? 'funded'],
  );
}

/**
 * A committed booster reservation, ready to be redeemed.
 *
 * Goes through the tables rather than through `confirmBoosterPayment` on
 * purpose: a redemption test should not also have to fake a chain payment. The
 * offer row exists because `booster_intents.nonce` has a foreign key onto it.
 */
export async function makeTicket(input: {
  ticketNumber: number;
  profileId: string;
  ownerAddress?: string;
  status?: 'reserved' | 'minted' | 'failed';
}): Promise<void> {
  const nonce = `nonce-${input.ticketNumber}`;
  const address = input.ownerAddress ?? '0xdddd000000000000000000000000000000000004';
  await query(
    `INSERT INTO wager.booster_offers
       (nonce, profile_id, address, amount_wei, recipient, status, expires_at)
     VALUES ($1, $2, $3, '3500000000000000',
             '0xeeee000000000000000000000000000000000005', 'consumed',
             now() + interval '1 hour')`,
    [nonce, input.profileId, address],
  );
  await query(
    `INSERT INTO wager.booster_intents
       (payment_sig, nonce, profile_id, owner_address, amount_wei, ticket_number, status)
     VALUES ($1, $2, $3, $4, '3500000000000000', $5, $6)`,
    [
      `0xpay${input.ticketNumber}`,
      nonce,
      input.profileId,
      address,
      input.ticketNumber,
      input.status ?? 'reserved',
    ],
  );
}

export async function makeDeposit(input: {
  signature: string;
  escrowId: string;
  seat: number;
  profileId: string;
  fromAddress: string;
  amountBase: bigint;
}): Promise<void> {
  await query(
    `INSERT INTO wager.deposits
       (signature, escrow_id, seat, profile_id, from_address, amount_base)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.signature,
      input.escrowId,
      input.seat,
      input.profileId,
      input.fromAddress,
      input.amountBase.toString(),
    ],
  );
}
