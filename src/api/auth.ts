// src/api/auth.ts
//
// Wallet challenge–response sign-in.
//
//   1. POST /auth/nonce  {address, chain}   → the server mints and returns the
//                                             EXACT `message` string to sign
//   2. the wallet signs that message VERBATIM
//   3. POST /auth/verify {address, chain, signature, nonce}
//                                           → {accessToken, refreshToken, profile}
//
// Step 2 is the security-critical one. The server re-derives the message from
// its own stored nonce record and refuses to verify a signature over any string
// it did not mint (INTEGRATION.md §2). Do not reformat, trim, re-wrap or
// re-encode `message`. Pass the bytes through unchanged.
//
// The signed message embeds `AUTH_DOMAIN`, which is read from server env and
// never from a request header — that is what stops another site from getting a
// wallet to sign a challenge that is replayable here.
//
// ─── CHAIN SLUGS ────────────────────────────────────────────────────────────
// Valid `chain` values are the SERVER's slugs:
//
//     ethereum | base | arbitrum | polygon | solana
//
// There is no `evm` value — sending one is a 400. `src/wallet.ts` uses a
// coarser `WalletChain = 'evm' | 'solana'` for provider selection; use
// `toAuthChain()` below to translate, and note that an EVM signature is
// chain-agnostic (plain ecrecover), so the slug only selects which `Chain ID`
// line appears in the message the user reads.
//
// ─── TOKENS ─────────────────────────────────────────────────────────────────
// Storage policy lives in `session.ts` — read that file's header. Nothing here
// writes to storage directly.

import { get, post, refreshSession } from './http.js';
import { ApiError } from './errors.js';
import {
  clearSession,
  getSession,
  setSession,
  type AuthChain,
} from './session.js';

export type { AuthChain, Session } from './session.js';
export {
  getSession,
  getAccessToken,
  getRefreshToken,
  isSignedIn,
  onSessionChange,
  getPersistence,
  setPersistence,
} from './session.js';

/** Every slug the server accepts, in a form you can iterate for a chain picker. */
export const AUTH_CHAINS = ['ethereum', 'base', 'arbitrum', 'polygon', 'solana'] as const;

/** Human labels matching the server's own `CHAINS` table. */
export const CHAIN_LABELS: Record<AuthChain, string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  arbitrum: 'Arbitrum One',
  polygon: 'Polygon',
  solana: 'Solana',
};

/** Is this slug an EVM chain (as opposed to Solana)? */
export function isEvmChain(chain: AuthChain): boolean {
  return chain !== 'solana';
}

/**
 * Translate `src/wallet.ts`'s coarse `'evm' | 'solana'` into a server slug.
 * EVM defaults to `ethereum`; pass `preferred` to pick another EVM slug.
 */
export function toAuthChain(
  walletChain: 'evm' | 'solana',
  preferred: AuthChain = 'ethereum',
): AuthChain {
  if (walletChain === 'solana') return 'solana';
  return isEvmChain(preferred) ? preferred : 'ethereum';
}

// ── Response types ──────────────────────────────────────────────────────────

/** `POST /auth/nonce` */
export interface NonceChallenge {
  /** 32 lowercase hex chars. Echo this back to `/auth/verify`. */
  nonce: string;
  /** THE STRING TO SIGN. Verbatim — do not modify. */
  message: string;
  /** ISO-8601. Default TTL is 5 minutes. */
  expiresAt: string;
  /** ISO-8601. */
  issuedAt: string;
  /** The deployment's `AUTH_DOMAIN`, as shown in the message. */
  domain: string;
  /** A STRING even for EVM (`"1"`, `"8453"`, …); `"solana"` for Solana. */
  chainId: string;
}

/** The caller's identity, as returned by `/auth/verify`. */
export interface AuthProfile {
  /** bigint-safe decimal string. Never `parseInt` it. */
  profileId: string;
  address: string;
  chain: string;
  displayName: string;
  /** `['player']`, or `['player','operator']`. Comes from the TOKEN. */
  roles: string[];
}

/** `POST /auth/verify` and `POST /auth/refresh` (the latter without `profile`). */
export interface TokenResponse {
  tokenType: 'Bearer';
  accessToken: string;
  /** Access-token lifetime in SECONDS (default 900). Not a timestamp. */
  expiresIn: number;
  refreshToken: string;
  /** ISO-8601 absolute expiry of the refresh family. */
  refreshExpiresAt: string;
}

export interface VerifyResponse extends TokenResponse {
  profile: AuthProfile;
}

/**
 * `GET /auth/me`.
 *
 * NOTE this is a DIFFERENT shape from `GET /api/profiles/me` (profiles.ts):
 * this one is flat, calls the id `profileId`, and includes `roles`; that one
 * wraps in `{profile}`, calls the id `id`, and adds `level` + `createdAt`.
 * Use this when you need roles; use `profiles.getMe()` for the profile screen.
 */
export interface MeResponse {
  profileId: string;
  address: string;
  chain: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  wins: number;
  losses: number;
  roles: string[];
}

// ── Raw endpoint wrappers ───────────────────────────────────────────────────

/**
 * Mint a sign-in challenge. Public — no token required.
 *
 * Only ONE nonce is outstanding per `(chain, address)`; calling this again
 * overwrites the previous challenge, invalidating it. Do not pre-fetch a nonce
 * you are not about to use.
 *
 * Rate limited to 10/min per address and 30/min per IP, and the gateway adds
 * its own 5 r/min burst 10 on `/auth/`. Retrying is safe (it only mints a
 * throwaway challenge), so this is one of the few POSTs we allow a 429 retry.
 */
export function requestNonce(params: { address: string; chain: AuthChain }): Promise<NonceChallenge> {
  return post<NonceChallenge>(
    '/auth/nonce',
    { address: params.address, chain: params.chain },
    { auth: 'none', retryOn429: true },
  );
}

/**
 * Exchange a signature for a token pair and STORE the session.
 *
 * `nonce` is an optional cross-check the server compares against its own
 * record — always send it; a mismatch is a 401 and that is the behaviour you
 * want if the challenge was swapped underneath you.
 */
export async function verifySignature(params: {
  address: string;
  chain: AuthChain;
  /** `0x…` hex (EVM, 65 bytes) or base58 (Solana, 64 bytes). */
  signature: string;
  nonce?: string;
  /** Optional echo of the signed message for an extra server-side check. */
  message?: string;
}): Promise<VerifyResponse> {
  const body: Record<string, unknown> = {
    address: params.address,
    chain: params.chain,
    signature: params.signature,
  };
  // The body is a zod `strictObject`: an explicitly-undefined key is fine, but
  // never add fields the schema does not declare.
  if (params.nonce !== undefined) body.nonce = params.nonce;
  if (params.message !== undefined) body.message = params.message;

  const res = await post<VerifyResponse>('/auth/verify', body, { auth: 'none' });

  setSession({
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    address: res.profile.address,
    chain: params.chain,
  });

  return res;
}

/**
 * Rotate the token pair.
 *
 * You almost never need to call this: `http.ts` does it automatically on a 401
 * and serialises concurrent attempts. Resolves `false` when the session could
 * not be recovered (and has therefore been cleared).
 *
 * NEVER call this in a loop. Presenting a spent refresh token revokes the
 * whole family server-side and logs the user out permanently.
 */
export function refresh(): Promise<boolean> {
  return refreshSession();
}

/**
 * Revoke the session server-side and clear it locally.
 *
 * Always clears locally, even if the network call fails — a user who clicks
 * "sign out" must end up signed out. Sends the refresh token so the server can
 * revoke the family rather than just the current access token's session.
 */
export async function logout(): Promise<{ ok: boolean; sessionsRevoked: number }> {
  const refreshToken = getSession()?.refreshToken;
  try {
    return await post<{ ok: boolean; sessionsRevoked: number }>(
      '/auth/logout',
      refreshToken ? { refreshToken } : {},
    );
  } catch (err) {
    // 401 here just means the token was already dead. Nothing to report.
    if (err instanceof ApiError) return { ok: true, sessionsRevoked: 0 };
    throw err;
  } finally {
    clearSession();
  }
}

/** `GET /auth/me` — the caller's own profile INCLUDING their wallet address. */
export function getMe(): Promise<MeResponse> {
  return get<MeResponse>('/auth/me');
}

// ── Message signing ─────────────────────────────────────────────────────────

/** UTF-8 → `0x…` hex, for `personal_sign`'s first parameter. */
function utf8ToHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Minimal base58 (Bitcoin alphabet) encoder for Solana signatures.
 *
 * Inlined on purpose: `bs58` is only a transitive dependency here, and adding
 * a direct one is out of scope for this layer. 20 lines beats a package.
 */
function toBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // Leading zero bytes become leading '1's.
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) out += '1';
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58_ALPHABET[digits[i]];
  return out;
}

/**
 * Sign `message` with an injected EVM provider via `personal_sign` (EIP-191).
 *
 * `personal_sign` takes `[data, address]` — note that this is the reverse of
 * `eth_sign`'s parameter order, and getting it backwards is the single most
 * common cause of "invalid signature" here.
 */
export async function signMessageEvm(message: string, address: string): Promise<string> {
  const eth = (globalThis as { ethereum?: { request(a: { method: string; params: unknown[] }): Promise<unknown> } }).ethereum;
  if (!eth) throw new Error('No EVM wallet detected. Install MetaMask, Rabby, or Coinbase Wallet.');
  const signature = await eth.request({
    method: 'personal_sign',
    params: [utf8ToHex(message), address],
  });
  if (typeof signature !== 'string') throw new Error('Wallet returned no signature.');
  return signature;
}

/**
 * Sign `message` with a Solana wallet provider (from `getSolanaWallet()` in
 * `src/wallet.ts`, or a Wallet Standard adapter).
 *
 * The backend accepts Solana ed25519 for LOGIN ONLY — it is a local signature
 * check over bytes the server minted, not a chain call. There is no
 * `/rpc/solana` and no Solana money path (INTEGRATION.md §4).
 */
export async function signMessageSolana(message: string, provider: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(message);
  const p = provider as {
    signMessage?: (m: Uint8Array, enc?: string) => Promise<unknown>;
    _wsWallet?: { features?: Record<string, unknown> };
    _account?: unknown;
  };

  // Legacy injected providers (Phantom, Solflare, Backpack): signMessage.
  if (typeof p.signMessage === 'function') {
    const out = await p.signMessage(bytes, 'utf8');
    const sig =
      out instanceof Uint8Array
        ? out
        : (out as { signature?: Uint8Array } | null)?.signature;
    if (!(sig instanceof Uint8Array)) throw new Error('Wallet returned no signature.');
    return toBase58(sig);
  }

  // Wallet Standard adapters (`src/wallet.ts` wraps these): solana:signMessage.
  const feature = p._wsWallet?.features?.['solana:signMessage'] as
    | { signMessage(input: { account: unknown; message: Uint8Array }): Promise<Array<{ signature: Uint8Array }>> }
    | undefined;
  if (feature?.signMessage) {
    const results = await feature.signMessage({ account: p._account, message: bytes });
    const sig = Array.isArray(results) ? results[0]?.signature : undefined;
    if (!(sig instanceof Uint8Array)) throw new Error('Wallet returned no signature.');
    return toBase58(sig);
  }

  throw new Error('This Solana wallet cannot sign messages. Try Phantom, Solflare, or Backpack.');
}

// ── The orchestrated flow ───────────────────────────────────────────────────

/**
 * Full sign-in for an already-connected wallet: nonce → sign → verify → store.
 *
 * The UI owns wallet CONNECTION (`connectEvm()` / `connectSolana()` from
 * `src/wallet.ts`); this owns everything after it. Pass the address those
 * functions returned.
 *
 * For Solana you must also pass the live provider (`getSolanaWallet(kind)`),
 * because the signature has to come from the same wallet instance that is
 * connected.
 *
 * Throws `ApiError` for server-side failures and a plain `Error` when the user
 * rejects the signature in their wallet.
 */
export async function signIn(params: {
  address: string;
  chain: AuthChain;
  /** Required when `chain === 'solana'`. */
  solanaProvider?: unknown;
}): Promise<VerifyResponse> {
  const { address, chain } = params;

  const challenge = await requestNonce({ address, chain });

  // Sign the server's message VERBATIM. Any transformation here breaks it.
  const signature =
    chain === 'solana'
      ? await signMessageSolana(challenge.message, requireProvider(params.solanaProvider))
      : await signMessageEvm(challenge.message, address);

  return verifySignature({
    address,
    chain,
    signature,
    nonce: challenge.nonce,
    message: challenge.message,
  });
}

function requireProvider(provider: unknown): unknown {
  if (!provider) {
    throw new Error('A connected Solana wallet is required. Call getSolanaWallet() first.');
  }
  return provider;
}
