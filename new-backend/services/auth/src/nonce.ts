/**
 * Nonce issuing and single-use consumption.
 *
 * Two stores, on purpose:
 *
 *   Redis — the authoritative single-use guard. Consumption is `GETDEL`, one
 *           atomic round trip, so two concurrent replays of the same nonce
 *           cannot both succeed. 5-minute TTL.
 *   Postgres — the audit trail (`auth.nonces`) plus a second guard: the update
 *           only matches rows with `consumed_at is null`. Belt and braces.
 *
 * A replayed nonce fails at the Redis step (key already deleted); a nonce
 * replayed against a Redis that was flushed still fails at the Postgres step.
 */
import { randomBytes } from 'node:crypto';
import { AppError, getDel, getRedis, query } from '@chains/shared';
import { buildSignInMessage, type MintedMessageFields } from './message.js';
import { env } from './env.js';

export interface NonceRecord extends MintedMessageFields {
  /** The full message the server minted; rebuilt and compared on verify. */
  message: string;
}

/** One outstanding nonce per (chain, address). */
function redisKey(chain: string, address: string): string {
  return `auth:nonce:${chain}:${address}`;
}

/** 128 bits of CSPRNG entropy, hex-encoded. */
function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

export interface IssuedNonce {
  nonce: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
  domain: string;
  chainId: string;
}

export async function issueNonce(chain: string, address: string): Promise<IssuedNonce> {
  const nonce = generateNonce();
  const now = new Date();
  const expires = new Date(now.getTime() + env.NONCE_TTL_SEC * 1000);

  const fields: MintedMessageFields = {
    domain: env.AUTH_DOMAIN,
    uri: env.AUTH_URI,
    statement: env.AUTH_STATEMENT,
    address,
    chain,
    nonce,
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  const message = buildSignInMessage(fields);
  const record: NonceRecord = { ...fields, message };

  // Audit row first: if this fails we have not handed out a nonce.
  await query(
    `insert into auth.nonces (nonce, address, chain, expires_at)
     values ($1, $2, $3, $4)`,
    [nonce, address, chain, expires.toISOString()],
  );

  await getRedis().set(redisKey(chain, address), JSON.stringify(record), { EX: env.NONCE_TTL_SEC });

  const chainIdMatch = /^Chain ID: (.+)$/m.exec(message);
  return {
    nonce,
    message,
    issuedAt: fields.issuedAt,
    expiresAt: fields.expiresAt,
    domain: fields.domain,
    chainId: chainIdMatch?.[1] ?? '',
  };
}

/**
 * Atomically consume the outstanding nonce for (chain, address).
 * Throws `unauthorized` if there is none, if it was already used, or if the
 * caller named a different nonce than the one the server is holding.
 */
export async function consumeNonce(
  chain: string,
  address: string,
  expectedNonce?: string,
): Promise<NonceRecord> {
  const raw = await getDel(redisKey(chain, address));
  if (!raw) {
    throw AppError.unauthorized('No active sign-in challenge — request a new nonce');
  }

  let record: NonceRecord;
  try {
    record = JSON.parse(raw) as NonceRecord;
  } catch {
    throw AppError.unauthorized('No active sign-in challenge — request a new nonce');
  }

  if (expectedNonce !== undefined && expectedNonce !== record.nonce) {
    throw AppError.unauthorized('Sign-in challenge mismatch — request a new nonce');
  }
  if (record.address !== address || record.chain !== chain) {
    throw AppError.unauthorized('Sign-in challenge mismatch — request a new nonce');
  }
  if (Date.parse(record.expiresAt) <= Date.now()) {
    throw AppError.unauthorized('Sign-in challenge expired — request a new nonce');
  }

  // Second guard, independent of Redis state.
  const consumed = await query(
    `update auth.nonces
        set consumed_at = now()
      where nonce = $1
        and consumed_at is null
        and expires_at > now()
      returning nonce`,
    [record.nonce],
  );
  if (consumed.rowCount !== 1) {
    throw AppError.unauthorized('Sign-in challenge already used — request a new nonce');
  }

  return record;
}

/** Housekeeping: drop expired audit rows. Safe to call on a timer. */
export async function pruneExpiredNonces(): Promise<number> {
  const res = await query(`delete from auth.nonces where expires_at < now() - interval '1 day'`);
  return res.rowCount ?? 0;
}
