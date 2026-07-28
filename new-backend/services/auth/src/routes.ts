/**
 * The auth endpoints.
 *
 * Every route is registered through the shared `route()` helper, which refuses
 * at startup to register anything that has neither an auth requirement nor an
 * explicit `public: true`.
 *
 * ── The linked-address routes ──────────────────────────────────────────────
 *
 * `/auth/addresses*` exist because one profile now owns many wallets
 * (migration 0013). Three properties hold across all of them:
 *
 *   * LINKING REQUIRES A FRESH SIGNATURE FROM THE ADDRESS BEING LINKED, over a
 *     server-minted, single-use, `link`-purpose challenge. Anything weaker lets
 *     a player claim someone else's wallet — and since collections are derived
 *     from what a linked wallet holds on chain, that is a theft of the victim's
 *     entire collection.
 *   * The caller's own profile is the only one addressable. There is no route
 *     that takes a target profile id and no route that answers "whose is this
 *     address?" — audit finding H-2 was exactly a by-wallet-address leak.
 *   * Refusals come from the database (0013's primary key and triggers) and are
 *     translated in `addresses.ts`. There is no check-then-insert anywhere.
 */
import type { Express, Request, Response } from 'express';
import {
  AppError,
  clientIp,
  deriveRoles,
  normalizeAddress,
  rateLimit,
  route,
  signAccessToken,
  strictBody,
  validateBody,
  validateParams,
  validatedBody,
  validatedParams,
  z,
  zAddress,
  zChain,
  zOpaqueToken,
  zSignature,
} from '@chains/shared';
import {
  linkAddress,
  listAddresses,
  noteSignerKind,
  setPrimaryAddress,
  unlinkAddress,
} from './addresses.js';
import { redisOnChainBudget } from './chain/onChainBudget.js';
import { env } from './env.js';
import { buildSignInMessage } from './message.js';
import { consumeNonce, issueNonce, type NoncePurpose } from './nonce.js';
import { deriveProfileRoles, findOrCreateProfile, findProfileById } from './profiles.js';
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

/** Same fields as `VerifyBody`; the signature just proves a different thing. */
const LinkBody = strictBody({
  address: zAddress,
  chain: zChain,
  signature: zSignature,
  nonce: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  message: z.string().max(2000).optional(),
});

const AddressParams = z.object({
  chain: zChain,
  address: zAddress,
});

const PrimaryBody = strictBody({
  address: zAddress,
  chain: zChain,
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

/**
 * The `/auth/addresses` write bucket. Linking and unlinking are authenticated
 * and rare; the per-profile key is what a rotating-IP attacker cannot escape.
 */
const addressWriteLimit = () =>
  rateLimit({
    name: 'auth:addresses',
    by: 'profile',
    limit: 10,
    windowSec: 60,
  });

/* --------------------------------------------------------------- handlers */

/**
 * Consume the challenge, rebuild the message from the SERVER's stored copy, and
 * verify the signature over it.
 *
 * Shared by `/auth/verify` and `/auth/addresses` so there is exactly one place
 * where a signature is turned into a proved address, and both endpoints get the
 * message-integrity checks, the domain pin and the purpose check identically.
 * The only difference between the two callers is `purpose`.
 */
async function proveAddress(
  req: Request,
  input: {
    chain: string;
    address: string;
    purpose: NoncePurpose;
    signature: string;
    nonce?: string;
    message?: string;
  },
) {
  // Atomically consume the challenge. A replay finds nothing here.
  const record = await consumeNonce(input.chain, input.address, input.nonce, input.purpose);

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
    req.log.error('minted_message_mismatch', { chain: input.chain });
    throw AppError.unauthorized('Sign-in challenge is no longer valid — request a new nonce');
  }
  if (input.message !== undefined && input.message !== message) {
    req.log.warn('client_message_mismatch', { chain: input.chain });
    throw AppError.unauthorized('Signature verification failed');
  }
  if (record.domain !== env.AUTH_DOMAIN) {
    throw AppError.unauthorized('Sign-in challenge is no longer valid — request a new nonce');
  }

  return verifyWalletSignature({
    chain: input.chain,
    address: input.address,
    message,
    signature: input.signature,
    // Charged only if the cheap local ECDSA check fails and the request is
    // about to reach the chain. An ordinary EOA login never spends it.
    budget: redisOnChainBudget({
      clientIp: clientIp(req),
      chain: input.chain,
      address: input.address,
    }),
    log: req.log,
  });
}

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

      const issued = await issueNonce(body.chain, address, 'signin');
      req.log.info('nonce_issued', { chain: body.chain, purpose: 'signin' });

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

      const proved = await proveAddress(req, {
        chain: body.chain,
        address,
        purpose: 'signin',
        signature: body.signature,
        ...(body.nonce !== undefined ? { nonce: body.nonce } : {}),
        ...(body.message !== undefined ? { message: body.message } : {}),
      });

      // Resolves through core.profile_addresses: any linked wallet reaches the
      // SAME profile. An address with no row still creates a new profile.
      const { profile, created } = await findOrCreateProfile(address, body.chain);

      // Keep `kind` honest — a wallet first seen as an EOA can later be a
      // deployed smart account at the same address. Advisory only; a failure
      // here must not fail a login that has already been proved.
      await noteSignerKind({ address, chain: body.chain, kind: proved.kind }).catch(
        (err: Error) => req.log.warn('signer_kind_update_failed', { err_message: err.message }),
      );

      // Roles span every linked address, so an operator keeps the role whichever
      // of their wallets signed, and /auth/refresh (which has no signing address
      // to work from) computes the same answer.
      const roles = await deriveProfileRoles(profile.id, deriveRoles);
      const session = await createSession(profile.id);

      req.log.info('login_succeeded', {
        profile_id: profile.id,
        chain: body.chain,
        profile_created: created,
        signer_kind: proved.kind,
        // Which wallet signed, as distinct from the profile's primary address.
        signed_with_primary: address === profile.address,
        roles,
      });

      res.json({
        ...accessTokenResponse({
          // The PRIMARY address, not the one that signed: the claim has to match
          // what /auth/me and GET /api/profiles/me report, and it has to survive
          // a refresh, which has no signing address to reproduce.
          profileId: profile.id,
          address: profile.address,
          chain: profile.chain,
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
        /** Which wallet was actually used, so a client can show it. */
        signedInWith: { address, chain: body.chain, kind: proved.kind },
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
      // Computed over every linked address — the same function `/auth/verify`
      // uses — because refresh has no signing address and the two must agree.
      const roles = await deriveProfileRoles(profile.id, deriveRoles);

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

  /* GET /auth/addresses -------------------------------------------------- */
  route(app, {
    method: 'get',
    path: '/auth/addresses',
    auth: 'required',
    summary: 'the caller own linked wallet addresses',
    middleware: [ipLimit()],
    handler: async (req: Request, res: Response) => {
      // `req.auth.profileId` and nothing else. There is no query parameter, no
      // path parameter and no body that can name another profile, and no route
      // anywhere that maps an address back to its owner — H-2 was exactly a
      // by-wallet-address leak.
      const auth = req.auth!;
      res.json({ addresses: await listAddresses(auth.profileId) });
    },
  });

  /* POST /auth/addresses/nonce ------------------------------------------- */
  route(app, {
    method: 'post',
    path: '/auth/addresses/nonce',
    auth: 'required',
    summary: 'issue a single-use challenge for linking a wallet',
    middleware: [validateBody(NonceBody), ipLimit(), addressLimit(), addressWriteLimit()],
    handler: async (req: Request, res: Response) => {
      const body = validatedBody(req, NonceBody);
      const address = normalizeAddress(body.chain, body.address);

      // Same machinery as /auth/nonce — same builder, same Redis key, same
      // single-use GETDEL, same auth.nonces audit row — with purpose 'link',
      // which changes the statement the wallet displays and makes the resulting
      // signature unusable at /auth/verify and vice versa.
      const issued = await issueNonce(body.chain, address, 'link');
      req.log.info('nonce_issued', {
        chain: body.chain,
        purpose: 'link',
        profile_id: req.auth!.profileId,
      });

      res.json({
        nonce: issued.nonce,
        message: issued.message,
        expiresAt: issued.expiresAt,
        issuedAt: issued.issuedAt,
        domain: issued.domain,
        chainId: issued.chainId,
      });
    },
  });

  /* POST /auth/addresses ------------------------------------------------- */
  route(app, {
    method: 'post',
    path: '/auth/addresses',
    auth: 'required',
    summary: 'link an additional wallet to the caller profile',
    middleware: [validateBody(LinkBody), ipLimit(), addressLimit(), addressWriteLimit()],
    handler: async (req: Request, res: Response) => {
      const body = validatedBody(req, LinkBody);
      const auth = req.auth!;
      const address = normalizeAddress(body.chain, body.address);

      // The signature must be over a FRESH, server-minted, link-purpose
      // challenge FOR THIS ADDRESS. Session ownership authorises "add a wallet
      // to MY profile"; only this proves "and I control that wallet". Without
      // the second half a player could claim any address — and with it the NFTs
      // that address holds.
      const proved = await proveAddress(req, {
        chain: body.chain,
        address,
        purpose: 'link',
        signature: body.signature,
        ...(body.nonce !== undefined ? { nonce: body.nonce } : {}),
        ...(body.message !== undefined ? { message: body.message } : {}),
      });

      // No check-then-insert: the (address, chain) primary key decides, and
      // linkAddress translates the SQLSTATE.
      const linked = await linkAddress({
        profileId: auth.profileId,
        address,
        chain: body.chain,
        kind: proved.kind,
      });

      req.log.info('address_linked', {
        profile_id: auth.profileId,
        chain: body.chain,
        signer_kind: proved.kind,
      });

      res.status(201).json({ address: linked });
    },
  });

  /* POST /auth/addresses/primary ----------------------------------------- */
  route(app, {
    method: 'post',
    path: '/auth/addresses/primary',
    auth: 'required',
    summary: 'promote one of the caller linked addresses to primary',
    middleware: [validateBody(PrimaryBody), ipLimit(), addressWriteLimit()],
    handler: async (req: Request, res: Response) => {
      const body = validatedBody(req, PrimaryBody);
      const auth = req.auth!;
      const address = normalizeAddress(body.chain, body.address);

      // No signature: control of this address was already proved when it was
      // linked, and promotion grants nothing that signing with it would not
      // already grant. What it changes is which wallet core.profiles.address
      // names, which is why it exists as an explicit action.
      const promoted = await setPrimaryAddress({
        profileId: auth.profileId,
        address,
        chain: body.chain,
      });

      req.log.info('primary_address_changed', { profile_id: auth.profileId, chain: body.chain });
      res.json({ address: promoted });
    },
  });

  /* DELETE /auth/addresses/:chain/:address -------------------------------- */
  route(app, {
    method: 'delete',
    path: '/auth/addresses/:chain/:address',
    auth: 'required',
    summary: 'unlink a wallet from the caller profile',
    middleware: [validateParams(AddressParams), ipLimit(), addressWriteLimit()],
    handler: async (req: Request, res: Response) => {
      const params = validatedParams(req, AddressParams);
      const auth = req.auth!;
      const address = normalizeAddress(params.chain, params.address);

      // Ownership is the WHERE clause. Someone else's address and a
      // never-linked address are the same 404 — a caller must not be able to
      // probe which wallets exist in the system.
      //
      // The last address, and the primary while others remain, are refused by
      // 0013's BEFORE DELETE trigger and surface as 409s. That guard is in the
      // database because a profile with no addresses cannot be signed into AND
      // would make the wager service's destructive collection reconcile delete
      // the player's whole collection.
      await unlinkAddress({ profileId: auth.profileId, address, chain: params.chain });

      req.log.info('address_unlinked', { profile_id: auth.profileId, chain: params.chain });
      res.json({ ok: true });
    },
  });
}
