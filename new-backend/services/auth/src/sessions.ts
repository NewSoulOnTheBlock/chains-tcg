/**
 * Refresh-token sessions.
 *
 * Properties, all enforced here and by `auth.sessions`:
 *
 *  - The token is opaque (256 bits of CSPRNG, base64url). It carries no claims,
 *    so it cannot be read or forged, only presented.
 *  - Only its **SHA-256 hash** is stored. A dump of `auth.sessions` yields
 *    nothing usable — the column is `unique`, which is also the idempotency
 *    guard against two rows sharing a token.
 *  - Every use **rotates** it: the presented row is revoked and a new one is
 *    issued inside the same transaction, under `SELECT … FOR UPDATE`, so two
 *    concurrent refreshes serialise instead of both succeeding.
 *  - Presenting an already-revoked token is treated as theft: the entire
 *    `family_id` is revoked, logging out the attacker *and* the victim, who
 *    must re-sign. This is the standard OAuth refresh-token rotation
 *    reuse-detection rule.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, withTransaction, type Logger } from '@chains/shared';
import { env } from './env.js';

export interface SessionRow {
  id: string;
  profile_id: string;
  family_id: string;
  revoked_at: string | null;
  expires_at: string;
}

export interface IssuedSession {
  sessionId: string;
  familyId: string;
  refreshToken: string;
  expiresAt: Date;
}

/** 256 bits, base64url — 43 characters, URL- and header-safe. */
function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Create a brand-new session family. Called after a successful signature
 * verification — i.e. once per login, per device.
 */
export async function createSession(profileId: string): Promise<IssuedSession> {
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SEC * 1000);

  await withTransaction(async (tx) => {
    await tx.query(
      `insert into auth.sessions (id, profile_id, refresh_hash, family_id, expires_at)
       values ($1, $2::bigint, $3, $4, $5)`,
      [sessionId, profileId, hashRefreshToken(refreshToken), familyId, expiresAt.toISOString()],
    );
  });

  return { sessionId, familyId, refreshToken, expiresAt };
}

export interface RotatedSession extends IssuedSession {
  profileId: string;
}

/**
 * Outcome of one rotation attempt.
 *
 * Failures are *returned*, not thrown, because the transaction must COMMIT on
 * the reuse path — that is where the family revocation lives. Throwing from
 * inside `withTransaction` rolls back, which would have quietly undone the
 * revocation and left the stolen family alive.
 */
type RotateOutcome =
  | { kind: 'ok'; session: RotatedSession }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'reuse'; familyId: string; profileId: string; revoked: number };

/**
 * Consume a refresh token and issue its successor.
 * Throws `unauthorized` for unknown, expired, or reused tokens.
 */
export async function rotateSession(presentedToken: string, log?: Logger): Promise<RotatedSession> {
  const presentedHash = hashRefreshToken(presentedToken);

  const outcome = await withTransaction<RotateOutcome>(async (tx) => {
    const found = await tx.query<SessionRow>(
      `select id, profile_id::text as profile_id, family_id,
              revoked_at::text as revoked_at, expires_at::text as expires_at
         from auth.sessions
        where refresh_hash = $1
        for update`,
      [presentedHash],
    );

    const session = found.rows[0];
    if (!session) {
      // Never existed, or was pruned. Indistinguishable to the caller.
      return { kind: 'not_found' };
    }

    if (session.revoked_at !== null) {
      // REUSE DETECTED. The legitimate holder rotated this token already, so
      // whoever is presenting it now holds a stolen copy — or the legitimate
      // holder is the victim of one. Either way, burn the whole family: the
      // attacker loses access and the real user is forced to re-sign.
      const revoked = await tx.query(
        `update auth.sessions
            set revoked_at = now()
          where family_id = $1
            and revoked_at is null`,
        [session.family_id],
      );
      return {
        kind: 'reuse',
        familyId: session.family_id,
        profileId: session.profile_id,
        revoked: revoked.rowCount ?? 0,
      };
    }

    if (Date.parse(session.expires_at) <= Date.now()) {
      return { kind: 'expired' };
    }

    // Rotate: revoke the presented row, mint its successor in the same family.
    await tx.query(`update auth.sessions set revoked_at = now() where id = $1`, [session.id]);

    const nextId = randomUUID();
    const nextToken = generateRefreshToken();
    // The family keeps its original absolute expiry: rotation extends nothing,
    // so a stolen-and-rotated chain still dies 30 days after the real login.
    const expiresAt = new Date(Date.parse(session.expires_at));

    await tx.query(
      `insert into auth.sessions (id, profile_id, refresh_hash, family_id, expires_at)
       values ($1, $2::bigint, $3, $4, $5)`,
      [nextId, session.profile_id, hashRefreshToken(nextToken), session.family_id, expiresAt.toISOString()],
    );

    return {
      kind: 'ok',
      session: {
        sessionId: nextId,
        familyId: session.family_id,
        refreshToken: nextToken,
        expiresAt,
        profileId: session.profile_id,
      },
    };
  });

  // The transaction has COMMITTED by this point, so the family revocation on
  // the reuse path is durable before we reject the caller.
  switch (outcome.kind) {
    case 'ok':
      return outcome.session;
    case 'reuse':
      log?.warn('refresh_token_reuse_detected', {
        family_id: outcome.familyId,
        profile_id: outcome.profileId,
        sessions_revoked: outcome.revoked,
      });
      throw AppError.unauthorized('Invalid refresh token');
    case 'expired':
      throw AppError.unauthorized('Refresh token expired');
    case 'not_found':
    default:
      throw AppError.unauthorized('Invalid refresh token');
  }
}

/** Revoke every live session in the family that `sessionId` belongs to. */
export async function revokeFamilyBySessionId(sessionId: string, profileId: string): Promise<number> {
  return withTransaction(async (tx) => {
    const found = await tx.query<{ family_id: string }>(
      `select family_id from auth.sessions where id = $1 and profile_id = $2::bigint`,
      [sessionId, profileId],
    );
    const familyId = found.rows[0]?.family_id;
    if (!familyId) return 0;

    const res = await tx.query(
      `update auth.sessions set revoked_at = now() where family_id = $1 and revoked_at is null`,
      [familyId],
    );
    return res.rowCount ?? 0;
  });
}

/** Revoke the family a refresh token belongs to, without rotating. */
export async function revokeFamilyByToken(presentedToken: string): Promise<number> {
  const hash = hashRefreshToken(presentedToken);
  return withTransaction(async (tx) => {
    const found = await tx.query<{ family_id: string }>(
      `select family_id from auth.sessions where refresh_hash = $1`,
      [hash],
    );
    const familyId = found.rows[0]?.family_id;
    if (!familyId) return 0;
    const res = await tx.query(
      `update auth.sessions set revoked_at = now() where family_id = $1 and revoked_at is null`,
      [familyId],
    );
    return res.rowCount ?? 0;
  });
}
