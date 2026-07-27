/**
 * JWT issuing/verification, the auth middleware, and the route-registration
 * safety rail.
 *
 * HS256 is implemented directly on `node:crypto` rather than through a JWT
 * library. It is forty lines, it removes a dependency from every service, and —
 * more importantly — the verifier accepts exactly one algorithm. There is no
 * code path in which a token's own `alg` header can select the verification
 * algorithm, so the classic `alg: none` / RS256→HS256 confusion attacks are not
 * merely mitigated, they are unrepresentable.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IRouter, NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from './errors.js';
import { isOperatorAddress, parseOperatorAddresses } from './env.js';

/* -------------------------------------------------------------------------- */
/* Claims                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The wire shape of an access token payload. Fixed by ARCHITECTURE.md —
 * every service decodes exactly this.
 */
export interface AccessTokenClaims {
  /** `core.profiles.id`, as a decimal string (bigint-safe). */
  sub: string;
  /** Normalised wallet address. */
  addr: string;
  /**
   * Chain slug, from `CHAINS` in `chains.ts`:
   * `solana` | `ethereum` | `base` | `arbitrum` | `polygon` | `robinhood`.
   * This app signs in on `robinhood` (4663); the rest are accepted namespaces.
   */
  chain: string;
  roles: string[];
  /** Equals `auth.sessions.id` of the session that minted this token. */
  jti: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

/** What `requireAuth()` puts on `req.auth`. */
export interface AuthContext {
  profileId: string;
  address: string;
  chain: string;
  roles: string[];
  /** The auth session id this token was minted by. */
  jti: string;
  /** Token expiry, unix seconds. */
  expiresAt: number;
}

export interface SignAccessTokenInput {
  profileId: string | number | bigint;
  address: string;
  chain: string;
  roles?: string[];
  /** Defaults to a fresh uuid. The auth service passes the session id. */
  jti?: string;
  /** Overrides the configured TTL. Seconds. */
  ttlSec?: number;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export interface AuthConfig {
  secret: string;
  issuer: string;
  audience: string;
  accessTtlSec: number;
  operators: Set<string>;
  /** Tolerance for clock drift between services, seconds. */
  clockToleranceSec: number;
}

let config: AuthConfig | null = null;

export function configureAuth(input: Partial<AuthConfig> & { secret?: string }): AuthConfig {
  const secret = input.secret ?? process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set and at least 32 characters');
  }
  config = {
    secret,
    issuer: input.issuer ?? process.env.JWT_ISSUER ?? 'chains-auth',
    audience: input.audience ?? process.env.JWT_AUDIENCE ?? 'chains-api',
    accessTtlSec: input.accessTtlSec ?? Number(process.env.ACCESS_TOKEN_TTL_SEC ?? 900),
    operators: input.operators ?? parseOperatorAddresses(process.env.OPERATOR_ADDRESSES ?? ''),
    clockToleranceSec: input.clockToleranceSec ?? 5,
  };
  return config;
}

function cfg(): AuthConfig {
  if (!config) return configureAuth({});
  return config;
}

/** Roles for a wallet. Operator status comes from env only — never the DB. */
export function deriveRoles(chain: string, address: string): string[] {
  const roles = ['player'];
  if (isOperatorAddress(cfg().operators, chain, address)) roles.push('operator');
  return roles;
}

/* -------------------------------------------------------------------------- */
/* HS256                                                                      */
/* -------------------------------------------------------------------------- */

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** Length-safe constant-time string comparison. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still burn a comparison so the failure isn't distinguishable by timing.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

const HEADER = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

/** Mint a short-lived access token. */
export function signAccessToken(input: SignAccessTokenInput): string {
  const c = cfg();
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSec ?? c.accessTtlSec;

  const claims: AccessTokenClaims = {
    sub: String(input.profileId),
    addr: input.address,
    chain: input.chain,
    roles: input.roles ?? [],
    jti: input.jti ?? randomUUID(),
    iat: now,
    exp: now + ttl,
    iss: c.issuer,
    aud: c.audience,
  };

  const body = `${HEADER}.${b64urlEncode(JSON.stringify(claims))}`;
  return `${body}.${b64urlEncode(hmac(c.secret, body))}`;
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Verify a token and return the caller's identity.
 * Throws `AppError.unauthorized` for every failure mode — the message is
 * coarse on purpose so it cannot be used as an oracle.
 */
export function verifyAccessToken(token: string): AuthContext {
  const c = cfg();

  if (typeof token !== 'string' || !JWT_RE.test(token)) {
    throw AppError.unauthorized('Invalid access token');
  }

  const parts = token.split('.');
  const headerPart = parts[0]!;
  const payloadPart = parts[1]!;
  const signaturePart = parts[2]!;

  // The algorithm is decided here, not by the token.
  if (headerPart !== HEADER) {
    let header: unknown;
    try {
      header = JSON.parse(b64urlDecode(headerPart).toString('utf8'));
    } catch {
      throw AppError.unauthorized('Invalid access token');
    }
    const alg = (header as { alg?: unknown } | null)?.alg;
    if (alg !== 'HS256') throw AppError.unauthorized('Invalid access token');
  }

  const expected = hmac(c.secret, `${headerPart}.${payloadPart}`);
  const actual = b64urlDecode(signaturePart);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw AppError.unauthorized('Invalid access token');
  }

  let claims: AccessTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(payloadPart).toString('utf8')) as AccessTokenClaims;
  } catch {
    throw AppError.unauthorized('Invalid access token');
  }

  if (claims.iss !== c.issuer || claims.aud !== c.audience) {
    throw AppError.unauthorized('Invalid access token');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || now > claims.exp + c.clockToleranceSec) {
    throw AppError.unauthorized('Access token expired');
  }
  if (typeof claims.iat !== 'number' || claims.iat > now + c.clockToleranceSec) {
    throw AppError.unauthorized('Invalid access token');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    throw AppError.unauthorized('Invalid access token');
  }
  if (typeof claims.addr !== 'string' || typeof claims.chain !== 'string') {
    throw AppError.unauthorized('Invalid access token');
  }

  return {
    profileId: claims.sub,
    address: claims.addr,
    chain: claims.chain,
    roles: Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === 'string') : [],
    jti: typeof claims.jti === 'string' ? claims.jti : '',
    expiresAt: claims.exp,
  };
}

/** Decode without verifying. Diagnostics only — never for authorisation. */
export function unsafeDecodeAccessToken(token: string): AccessTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1]!).toString('utf8')) as AccessTokenClaims;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Middleware                                                                 */
/* -------------------------------------------------------------------------- */

function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const value = rest.join(' ').trim();
  return value.length > 0 ? value : null;
}

/** Reject the request unless it carries a valid access token. */
export function requireAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    if (!token) {
      next(AppError.unauthorized('Missing Authorization: Bearer <accessToken> header'));
      return;
    }
    try {
      req.auth = verifyAccessToken(token);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Populate `req.auth` when a valid token is present, but do not reject.
 * Only legal on routes marked `public: true` — used where a response is richer
 * for a signed-in caller (e.g. "is this my profile?").
 */
export function optionalAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    if (!token) {
      next();
      return;
    }
    try {
      req.auth = verifyAccessToken(token);
    } catch {
      // A bad token on an optional route is simply "not signed in".
    }
    next();
  };
}

/** Require a role. Must be registered after `requireAuth()`. */
export function requireRole(role: string): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      next(AppError.unauthorized('Authentication required'));
      return;
    }
    if (!req.auth.roles.includes(role)) {
      req.log?.warn('role_denied', { required: role, profile_id: req.auth.profileId });
      next(AppError.forbidden(`This action requires the "${role}" role`));
      return;
    }
    next();
  };
}

/** Convenience: `requireRole('operator')`. */
export function requireOperator(): RequestHandler {
  return requireRole('operator');
}

/* -------------------------------------------------------------------------- */
/* Route registration safety rail                                             */
/* -------------------------------------------------------------------------- */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  /**
   * Explicitly unauthenticated. Mutually exclusive with `auth` / `roles`.
   * Writing this out is the point: an unauthenticated route becomes a visible,
   * greppable decision instead of an omission.
   */
  public?: boolean;
  /** Installs `requireAuth()`. Mutually exclusive with `public`. */
  auth?: 'required';
  /** Installs `requireAuth()` plus a `requireRole` per entry. Implies auth. */
  roles?: string[];
  /** Only valid together with `public: true`. */
  optionalAuth?: boolean;
  /** Runs after the auth middleware, before the handler. */
  middleware?: RequestHandler[];
  handler: RequestHandler;
  /** Shown in the startup route table. */
  summary?: string;
}

export interface RegisteredRoute {
  method: HttpMethod;
  path: string;
  auth: 'public' | 'public+optional' | 'required' | `required:${string}`;
  summary?: string;
}

const registry: RegisteredRoute[] = [];

/** Every route registered through `route()` this process. */
export function registeredRoutes(): readonly RegisteredRoute[] {
  return registry;
}

/** Test helper. */
export function resetRouteRegistry(): void {
  registry.length = 0;
}

function fail(def: Pick<RouteDefinition, 'method' | 'path'>, reason: string): never {
  throw new Error(
    `[route] ${def.method.toUpperCase()} ${def.path}: ${reason}\n` +
      `Every route must declare exactly one of:\n` +
      `  { auth: 'required' }            — installs requireAuth()\n` +
      `  { roles: ['operator'] }         — installs requireAuth() + requireRole()\n` +
      `  { public: true }                — explicitly unauthenticated\n` +
      `See new-backend/ARCHITECTURE.md § Authentication model. ` +
      `The 2026-07-27 audit finding C-3 was "no REST route was authenticated"; ` +
      `this check exists so that cannot silently recur.`,
  );
}

/**
 * Register one route.
 *
 * **Throws at startup** — i.e. before the server ever listens — if a route is
 * declared without either an auth requirement or an explicit `public: true`.
 *
 *     route(router, {
 *       method: 'get', path: '/api/profiles/me', auth: 'required',
 *       middleware: [validateQuery(Q)],
 *       handler: async (req, res) => { … req.auth!.profileId … },
 *     });
 */
export function route(router: IRouter, def: RouteDefinition): void {
  const hasRoles = Array.isArray(def.roles) && def.roles.length > 0;
  const wantsAuth = def.auth === 'required' || hasRoles;

  if (def.public && wantsAuth) {
    fail(def, 'declares both `public: true` and an auth requirement');
  }
  if (!def.public && !wantsAuth) {
    fail(def, 'was registered with no authentication and no explicit `public: true`');
  }
  if (def.optionalAuth && !def.public) {
    fail(def, '`optionalAuth` is only valid on a `public: true` route');
  }
  if (typeof def.handler !== 'function') {
    fail(def, 'has no handler');
  }

  const chain: RequestHandler[] = [];
  if (wantsAuth) {
    chain.push(requireAuth());
    for (const role of def.roles ?? []) chain.push(requireRole(role));
  } else if (def.optionalAuth) {
    chain.push(optionalAuth());
  }
  chain.push(...(def.middleware ?? []));

  const authLabel: RegisteredRoute['auth'] = def.public
    ? def.optionalAuth
      ? 'public+optional'
      : 'public'
    : hasRoles
      ? (`required:${(def.roles ?? []).join('+')}` as const)
      : 'required';

  const entry: RegisteredRoute = { method: def.method, path: def.path, auth: authLabel };
  if (def.summary) entry.summary = def.summary;
  registry.push(entry);

  router[def.method](def.path, ...chain, def.handler);
}

/** Register many routes. */
export function routes(router: IRouter, defs: RouteDefinition[]): void {
  for (const def of defs) route(router, def);
}
