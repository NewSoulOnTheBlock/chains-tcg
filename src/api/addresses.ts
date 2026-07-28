// src/api/addresses.ts
//
// Linked wallets: one profile, several addresses.
//
// All five routes sit under the existing `/auth/` gateway prefix and all five
// are AUTHENTICATED — they act on the caller's own profile, and there is no way
// to name a different one.
//
//   GET    /auth/addresses                      → the list, primary first
//   POST   /auth/addresses/nonce                → a LINK challenge
//   POST   /auth/addresses                      → attach a signed address
//   POST   /auth/addresses/primary              → promote one
//   DELETE /auth/addresses/:chain/:address      → detach one
//
// ─── THE LINK CHALLENGE IS NOT A SIGN-IN CHALLENGE ──────────────────────────
//
// `/auth/addresses/nonce` mints its challenge with `purpose='link'`, and the
// message it returns reads "Link this wallet to your Chains TCG profile"
// instead of "Sign in". The server refuses a sign-in signature at the link
// endpoint and a link signature at `/auth/verify`.
//
// That separation is the whole security property, so do not try to be clever
// and reuse a nonce. Without it, any site that can get a wallet to perform an
// ordinary sign-in signature — which users do constantly, on request, for free
// — could replay that signature here and attach the victim's wallet to the
// attacker's profile. The attacker would then own a profile that legitimately
// controls the victim's entire on-chain collection. `linkWithSigner()` below
// always mints a fresh link nonce.
//
// ─── UNLINKING DESTROYS THE COLLECTION ──────────────────────────────────────
//
// Removing an address deletes this profile's chain-derived card collection and
// its sync state. It is a DATABASE TRIGGER, not an application choice, so there
// is no flag to opt out and no partial removal: everything goes, including
// cards proved by wallets that are still linked. The player lands back on "not
// scanned yet" and must press SCAN CHAIN to re-prove what they hold, and
// anything held only by the removed wallet is gone for good.
//
// That is correct — it is what stops someone borrowing a wallet, syncing, and
// unlinking to keep the cards — but it must never be a surprise. `Settings.tsx`
// confirms in plain language before calling `unlinkAddress()`. If you add
// another call site, confirm there too.

import { del, get, post } from './http.js';
import type { AuthChain } from './session.js';
import type { AddressKind, NonceChallenge } from './auth.js';

export type { AddressKind } from './auth.js';

/** One row of `GET /auth/addresses`. */
export interface LinkedAddress {
  /** Lowercased for EVM. */
  address: string;
  chain: AuthChain;
  kind: AddressKind;
  /**
   * Exactly one address per profile is primary. It is the one
   * `AuthProfile.address` reports and the one other players see.
   */
  isPrimary: boolean;
  /** ISO-8601. */
  linkedAt: string;
}

/**
 * Every address on the caller's profile, primary first.
 *
 * The server orders the list; we do not re-sort it. `sortLinkedAddresses()` in
 * `src/linked-wallets.ts` exists for rendering a list assembled from optimistic
 * updates, not for second-guessing this.
 */
export async function listAddresses(options?: { signal?: AbortSignal }): Promise<LinkedAddress[]> {
  const res = await get<{ addresses: LinkedAddress[] }>('/auth/addresses', { signal: options?.signal });
  return Array.isArray(res?.addresses) ? res.addresses : [];
}

/**
 * Mint a LINK challenge for `address`.
 *
 * Same envelope as `/auth/nonce` — the difference is inside `message`, and in
 * the server-side `purpose` the client cannot see. One outstanding challenge per
 * `(chain, address)`: calling this again invalidates the previous one, so do
 * not pre-fetch.
 */
export function requestLinkNonce(params: { address: string; chain: AuthChain }): Promise<NonceChallenge> {
  return post<NonceChallenge>(
    '/auth/addresses/nonce',
    { address: params.address, chain: params.chain },
    // Minting a throwaway challenge is harmless to repeat, same as `/auth/nonce`.
    { retryOn429: true },
  );
}

/**
 * Attach a signed address to the caller's profile. `201`.
 *
 * Never lands as primary — a newly linked wallet cannot demote the one the
 * player already trusts. Use `setPrimaryAddress()` for that, deliberately.
 */
export async function linkAddress(params: {
  address: string;
  chain: AuthChain;
  signature: string;
  nonce?: string;
  message?: string;
}): Promise<LinkedAddress> {
  const body: Record<string, unknown> = {
    address: params.address,
    chain: params.chain,
    signature: params.signature,
  };
  // The body is a strict schema: an absent key is fine, an unknown key is a 400.
  if (params.nonce !== undefined) body.nonce = params.nonce;
  if (params.message !== undefined) body.message = params.message;

  const res = await post<{ address: LinkedAddress }>('/auth/addresses', body);
  return res.address;
}

/** Promote an already-linked address to primary. */
export async function setPrimaryAddress(params: { address: string; chain: AuthChain }): Promise<LinkedAddress> {
  const res = await post<{ address: LinkedAddress }>('/auth/addresses/primary', {
    address: params.address,
    chain: params.chain,
  });
  return res.address;
}

/**
 * Detach an address. **Destroys the profile's card collection** — see the file
 * header. Confirm first.
 *
 * The chain slug comes before the address in the path, matching the composite
 * key. Both segments are encoded: an address is hex and a slug is a known word,
 * so neither can currently contain anything interesting, but building a path by
 * concatenation is how that stops being true.
 */
export function unlinkAddress(params: { address: string; chain: AuthChain }): Promise<{ ok: true }> {
  const path = `/auth/addresses/${encodeURIComponent(params.chain)}/${encodeURIComponent(params.address)}`;
  return del<{ ok: true }>(path);
}

// ── The orchestrated link flow ──────────────────────────────────────────────

/**
 * Full link for a wallet the caller can already sign with: nonce → sign →
 * attach.
 *
 * Mirrors `auth.signInWithSigner()` deliberately, including the seam: the
 * caller supplies `signMessage`, so a browser wallet (`personal_sign`) and a
 * smart account (`signMessageWith6492`) share this one path. `address` must be
 * the address `signMessage` signs as — for a smart account, the ACCOUNT.
 */
export async function linkWithSigner(params: {
  address: string;
  chain: AuthChain;
  signMessage: (message: string) => Promise<string>;
}): Promise<LinkedAddress> {
  const challenge = await requestLinkNonce({ address: params.address, chain: params.chain });
  const signature = await params.signMessage(challenge.message);

  return linkAddress({
    address: params.address,
    chain: params.chain,
    signature,
    nonce: challenge.nonce,
    message: challenge.message,
  });
}
