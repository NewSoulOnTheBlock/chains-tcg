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
 *
 * ── Purposes ───────────────────────────────────────────────────────────────
 *
 * One challenge format, two purposes. `signin` exchanges a signature for a
 * token pair; `link` attaches the signing address to an ALREADY authenticated
 * profile. They must not be interchangeable, because a signature harvested by a
 * phishing site under "Sign in to Chains TCG." would otherwise be replayable at
 * the link endpoint to attach the victim's wallet to the attacker's profile —
 * and since collections are derived from what a linked wallet holds on chain,
 * that is a theft of the victim's entire collection, not merely a session.
 *
 * The defence is two-layered and both layers matter:
 *   * a different `statement`, so the wallet prompt tells the human the truth;
 *   * `purpose` on the record, checked on consumption, so the server does not
 *     depend on the human having read it.
 *
 * This is NOT a second challenge format. Same builder, same fields, same Redis
 * key, same single-use GETDEL, same `auth.nonces` audit row (with the `purpose`
 * column added by migration 0013).
 */
import { randomBytes } from 'node:crypto';
import { AppError, getDel, getRedis, query } from '@chains/shared';
import { buildSignInMessage, type MintedMessageFields } from './message.js';
import { env } from './env.js';

export type NoncePurpose = 'signin' | 'link';

export interface NonceRecord extends MintedMessageFields {
  /** The full message the server minted; rebuilt and compared on verify. */
  message: string;
  /**
   * Optional on the type, not on new records: a record written before 0013 and
   * still inside its 5-minute TTL during a rolling deploy has no field here,
   * and `undefined` is read as `signin` — which is what it was.
   */
  purpose?: NoncePurpose;
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

export async function issueNonce(
  chain: string,
  address: string,
  purpose: NoncePurpose = 'signin',
): Promise<IssuedNonce> {
  const nonce = generateNonce();
  const now = new Date();
  const expires = new Date(now.getTime() + env.NONCE_TTL_SEC * 1000);

  const fields: MintedMessageFields = {
    domain: env.AUTH_DOMAIN,
    uri: env.AUTH_URI,
    statement: purpose === 'link' ? env.AUTH_LINK_STATEMENT : env.AUTH_STATEMENT,
    address,
    chain,
    nonce,
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
  const message = buildSignInMessage(fields);
  const record: NonceRecord = { ...fields, message, purpose };

  // Audit row first: if this fails we have not handed out a nonce.
  await query(
    `insert into auth.nonces (nonce, address, chain, expires_at, purpose)
     values ($1, $2, $3, $4, $5)`,
    [nonce, address, chain, expires.toISOString(), purpose],
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
  expectedNonce: string | undefined,
  expectedPurpose: NoncePurpose,
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
  // A `signin` signature is not a `link` authorisation and vice versa. The
  // nonce is consumed either way — this is checked AFTER the GETDEL — so an
  // attacker replaying a captured signature at the wrong endpoint destroys the
  // challenge instead of getting a second attempt at the right one.
  if ((record.purpose ?? 'signin') !== expectedPurpose) {
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
