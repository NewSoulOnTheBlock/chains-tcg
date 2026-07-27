/**
 * The five auth endpoints.
 *
 * Every route is registered through the shared `route()` helper, which refuses
 * at startup to register anything that has neither an auth requirement nor an
 * explicit `public: true`.
 */
import type { Express, Request, Response } from 'express';
import {
  AppError,
  deriveRoles,
  normalizeAddress,
  rateLimit,
  route,
  signAccessToken,
  strictBody,
  validateBody,
  validatedBody,
  z,
  zAddress,
  zChain,
  zOpaqueToken,
  zSignature,
} from '@chains/shared';
import { env } from './env.js';
import { buildSignInMessage } from './message.js';
import { consumeNonce, issueNonce } from './nonce.js';
import { findOrCreateProfile, findProfileById } from './profiles.js';
import { createSession, revokeFamilyBySessionId, revokeFamilyByToken, rotateSession } from './sessions.js';
import { verifyWalletSignature } from './signature.js';

/* ----------------------------------------------------------------- schemas */

const NonceBody = strictBody({
  address: zAddress,
  chain: zChain,
});

const VerifyBody = strictBody({
  address: zAddress,
  chain: zChain,
  signature: zSignature,
  /**
   * Optional cross-checks. The server does not need either field — it holds
   * its own copy — but if a client sends them they must match exactly, which
   * turns a client/server drift into a loud 401 instead of a silent mismatch.
   */
  nonce: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  message: z.string().max(2000).optional(),
});

const RefreshBody = strictBody({
  refreshToken: zOpaqueToken,
});

const LogoutBody = strictBody({
  refreshToken: zOpaqueToken.optional(),
});

/* ------------------------------------------------------------ rate limits */

/** Per-IP bucket, applied to every /auth route. */
const ipLimit = () =>
  rateLimit({
    name: 'auth:ip',
    by: 'ip',
    limit: env.AUTH_RL_IP_LIMIT,
    windowSec: env.AUTH_RL_IP_WINDOW_SEC,
  });

/**
 * Per-wallet-address bucket. The address comes from the (validated) body and
 * is unauthenticated at this point — that is fine: it is a rate-limit key, not
 * an identity. It stops one wallet being hammered from a botnet of IPs.
 */
const addressLimit = () =>
  rateLimit({
    name: 'auth:addr',
    limit: env.AUTH_RL_ADDRESS_LIMIT,
    windowSec: env.AUTH_RL_ADDRESS_WINDOW_SEC,
    by: (req: Request) => {
      const body = req.body as { address?: unknown; chain?: unknown } | undefined;
      if (typeof body?.address !== 'string' || typeof body?.chain !== 'string') return null;
      try {
        return `addr:${body.chain}:${normalizeAddress(body.chain, body.address)}`;
      } catch {
        return null;
      }
    },
  });

/* --------------------------------------------------------------- handlers */

function accessTokenResponse(input: {
  profileId: string;
  address: string;
  chain: string;
  roles: string[];
  sessionId: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}) {
  const accessToken = signAccessToken({
    profileId: input.profileId,
    address: input.address,
    chain: input.chain,
    roles: input.roles,
    // `jti` is the session id, so /auth/logout can revoke the family from an
    // access token alone.
    jti: input.sessionId,
  });

  return {
    tokenType: 'Bearer' as const,
    accessToken,
    expiresIn: env.ACCESS_TOKEN_TTL_SEC,
    refreshToken: input.refreshToken,
    refreshExpiresAt: input.refreshExpiresAt.toISOString(),
  };
}

export function mountAuthRoutes(app: Express): void {
  /* POST /auth/nonce ----------------------------------------------------- */
  route(app, {
    method: 'post',
    path: '/auth/nonce',
    public: true,
    summary: 'issue a single-use sign-in challenge',
    middleware: [validateBody(NonceBody), ipLimit(), addressLimit()],
    handler: async (req: Request, res: Response) => {
      const body = validatedBody(req, NonceBody);
      const address = normalizeAddress(body.chain, body.address);

      const issued = await issueNonce(body.chain, address);
      req.log.info('nonce_issued', { chain: body.chain });

      res.json({
        nonce: issued.nonce,
        // The exact bytes the wallet must sign. The server keeps its own copy
        // and re-derives this on verify; sending it is a convenience, not a
        // source of truth.
        message: issued.message,
        expiresAt: issued.expiresAt,
        issuedAt: issued.issuedAt,
        domain: issued.domain,
        chainId: issued.chainId,
      });
    },
  });

  /* POST /auth/verify ---------------------------------------------------- */
  route(app, {
    method: 'post',
    path: '/auth/verify',
    public: true,
    summary: 'exchange a signature for a token pair',
    middleware: [validateBody(VerifyBody), ipLimit(), addressLimit()],
    handler: async (req: Request, res: Response) => {
      const body = validatedBody(req, VerifyBody);
      const address = normalizeAddress(body.chain, body.address);

      // Atomically consume the challenge. A replay finds nothing here.
      const record = await consumeNonce(body.chain, address, body.nonce);

      // Re-derive the message from the server's own stored fields. Anything the
      // client sent is only ever compared, never used.
      const message = buildSignInMessage({
        domain: record.domain,
        uri: record.uri,
        statement: record.statement,
        address: record.address,
        chain: record.chain,
        nonce: record.nonce,
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
      });

      if (message !== record.message) {
        // The stored copy and a fresh derivation disagree: the message format
        // changed under a live nonce. Refuse rather than guess.
        req.log.error('minted_message_mismatch', { chain: body.chain });
        throw AppError.unauthorized('Sign-in challenge is no longer valid — request a new nonce');
      }
      if (body.message !== undefined && body.message !== message) {
        req.log.warn('client_message_mismatch', { chain: body.chain });
        throw AppError.unauthorized('Signature verification failed');
      }
      if (record.domain !== env.AUTH_DOMAIN) {
        throw AppError.unauthorized('Sign-in challenge is no longer valid — request a new nonce');
      }

      await verifyWalletSignature({
        chain: body.chain,
        address,
        message,
        signature: body.signature,
      });

      const { profile, created } = await findOrCreateProfile(address, body.chain);
      const roles = deriveRoles(body.chain, address);
      const session = await createSession(profile.id);

      req.log.info('login_succeeded', {
        profile_id: profile.id,
        chain: body.chain,
        profile_created: created,
        roles,
      });

      res.json({
        ...accessTokenResponse({
          profileId: profile.id,
          address,
          chain: body.chain,
          roles,
          sessionId: session.sessionId,
          refreshToken: session.refreshToken,
          refreshExpiresAt: session.expiresAt,
        }),
        profile: {
          profileId: profile.id,
          address: profile.address,
          chain: profile.chain,
          displayName: profile.display_name,
          roles,
        },
      });
    },
  });

  /* POST /auth/refresh --------------------------------------------------- */
  route(app, {
    method: 'post',
    path: '/auth/refresh',
    public: true,
    summary: 'rotate a refresh token for a new pair',
    middleware: [validateBody(RefreshBody), ipLimit()],
    handler: async (req: Request, res: Response) => {
      const body = validatedBody(req, RefreshBody);

      const rotated = await rotateSession(body.refreshToken, req.log);
      const profile = await findProfileById(rotated.profileId);
      if (!profile) {
        throw AppError.unauthorized('Invalid refresh token');
      }

      // Roles are recomputed from env on every rotation, so removing an
      // operator from OPERATOR_ADDRESSES takes effect within one token cycle.
      const roles = deriveRoles(profile.chain, profile.address);

      req.log.info('token_refreshed', { profile_id: profile.id });

      res.json(
        accessTokenResponse({
          profileId: profile.id,
          address: profile.address,
          chain: profile.chain,
          roles,
          sessionId: rotated.sessionId,
          refreshToken: rotated.refreshToken,
          refreshExpiresAt: rotated.expiresAt,
        }),
      );
    },
  });

  /* POST /auth/logout ---------------------------------------------------- */
  route(app, {
    method: 'post',
    path: '/auth/logout',
    auth: 'required',
    summary: 'revoke the caller session family',
    middleware: [validateBody(LogoutBody), ipLimit()],
    handler: async (req: Request, res: Response) => {
      const body = validatedBody(req, LogoutBody);
      const auth = req.auth!;

      let revoked = await revokeFamilyBySessionId(auth.jti, auth.profileId);
      if (body.refreshToken) {
        revoked += await revokeFamilyByToken(body.refreshToken);
      }

      req.log.info('logout', { profile_id: auth.profileId, sessions_revoked: revoked });
      res.json({ ok: true, sessionsRevoked: revoked });
    },
  });

  /* GET /auth/me --------------------------------------------------------- */
  route(app, {
    method: 'get',
    path: '/auth/me',
    auth: 'required',
    summary: 'the caller identity, from the token only',
    handler: async (req: Request, res: Response) => {
      // Identity comes from the verified token. There is no `?name=` here and
      // no way for a body to influence which profile is returned.
      const auth = req.auth!;
      const profile = await findProfileById(auth.profileId);
      if (!profile) throw AppError.unauthorized('Profile no longer exists');

      res.json({
        profileId: profile.id,
        address: profile.address,
        chain: profile.chain,
        displayName: profile.display_name,
        avatarUrl: profile.avatar_url,
        bio: profile.bio,
        wins: profile.wins,
        losses: profile.losses,
        roles: auth.roles,
      });
    },
  });
}
