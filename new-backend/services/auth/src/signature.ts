/**
 * Wallet signature verification.
 *
 * EVM    — two tiers, cheapest first:
 *
 *          1. `viem.verifyMessage` (the STANDALONE function). Pure EIP-191
 *             ecrecover, local, no network. Answers every ordinary EOA.
 *          2. `publicClient.verifyMessage` (the CLIENT ACTION). ERC-1271
 *             `isValidSignature` for a deployed smart account, and ERC-6492 for
 *             one that has not been deployed yet. Costs an `eth_call`.
 *
 *          The recovered/validated address is compared against the *normalised*
 *          claimed address, so a checksummed and a lowercase spelling of the
 *          same wallet cannot become two identities.
 *
 * Solana — ed25519 over the raw UTF-8 message bytes via tweetnacl, with the
 *          public key and signature decoded from base58. UNCHANGED: it is a
 *          local check over bytes this server minted and makes no network call.
 *
 * `message` here is always the server-minted string rebuilt from Redis. This
 * function never sees, and cannot be given, a client-supplied message.
 *
 * ── Why the length gate was relaxed ────────────────────────────────────────
 *
 * The old gate was `/^0x[0-9a-fA-F]{130}$/` — exactly r+s+v, 65 bytes — applied
 * BEFORE verification. That is one valid shape, not the only one. A 6492-wrapped
 * signature carries the account factory's address and calldata and runs to
 * hundreds of bytes; a passkey/WebAuthn assertion carries `authenticatorData`
 * and `clientDataJSON` and is longer still; a k-of-n Safe bundle is 65 bytes per
 * owner. Every one of those was rejected before verification even ran, which is
 * why account abstraction could not sign in at all. The bound that remains is
 * `zSignature` in `packages/shared/src/validate.ts` (hex or base58, ≤512
 * chars), which is a payload cap — not a claim about the signature scheme.
 */
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { verifyMessage as verifyEvmMessageLocally } from 'viem';
import { AppError, getChain, normalizeAddress, type Logger } from '@chains/shared';
import { env } from './env.js';
import {
  ChainUnavailableError,
  chainUnavailableError,
  getSmartAccountVerifier,
} from './chain/evmVerifier.js';
import type { OnChainBudget } from './chain/onChainBudget.js';

/** r(32) + s(32) + v(1). Now a fast path, not a gate. */
const HEX_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const HEX_RE = /^0x[0-9a-fA-F]*$/;

/** How the signature was proved. Stored as `core.profile_addresses.kind`. */
export type SignerKind = 'eoa' | 'smart';

/** Local ECDSA only. No network. */
async function verifyEoa(address: string, message: string, signature: string): Promise<boolean> {
  if (!HEX_SIGNATURE_RE.test(signature)) return false;
  try {
    return await verifyEvmMessageLocally({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

function verifySolana(address: string, message: string, signature: string): boolean {
  let publicKey: Uint8Array;
  let sig: Uint8Array;
  try {
    publicKey = bs58.decode(address);
    sig = bs58.decode(signature);
  } catch {
    return false;
  }
  if (publicKey.length !== 32 || sig.length !== 64) return false;

  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, publicKey);
  } catch {
    return false;
  }
}

export interface VerifyWalletSignatureInput {
  chain: string;
  address: string;
  message: string;
  signature: string;
  /**
   * Charged once, immediately before any RPC call, and never otherwise.
   * REQUIRED so that an on-chain verification which forgot to pay for itself is
   * a compile error rather than a missing line — the same reasoning as the
   * shared `route()` helper refusing to register a route with no auth
   * declaration. See `chain/onChainBudget.ts`.
   */
  budget: OnChainBudget;
  log?: Logger;
}

export interface VerifiedSignature {
  /** Normalised address — the only form that may reach a query. */
  address: string;
  kind: SignerKind;
}

/**
 * Verify `signature` over `message` for `address` on `chain`.
 * Returns the normalised address and how it was proved; throws otherwise.
 *
 * THREE failure classes, and the first two must not be collapsed:
 *
 *   401 unauthorized  — the signature did not verify. DELIBERATELY IDENTICAL
 *                       for "wrong key", "malformed signature", "wrong message"
 *                       and "the contract said no", so the endpoint is not an
 *                       oracle. That property is unchanged by this rewrite.
 *
 *   503 unavailable   — WE could not perform the check: RPC timeout, dead
 *                       endpoint, wrong network. A statement about this
 *                       service, not about the caller's signature, and only
 *                       ever reachable AFTER local ECDSA has already failed —
 *                       so it reveals nothing a caller did not already know
 *                       about their own signature. Answering 401 here would
 *                       tell an account-abstraction user their wallet is broken
 *                       when ours is. Within either state, every signature
 *                       failure mode stays indistinguishable from every other.
 *
 *   429 rate_limited  — the on-chain budget is spent. Also only reachable on
 *                       the slow path.
 */
export async function verifyWalletSignature(
  input: VerifyWalletSignatureInput,
): Promise<VerifiedSignature> {
  const spec = getChain(input.chain);
  const address = normalizeAddress(spec.slug, input.address);

  if (spec.kind !== 'evm') {
    if (!verifySolana(address, input.message, input.signature)) {
      throw AppError.unauthorized('Signature verification failed');
    }
    return { address, kind: 'eoa' };
  }

  // ── Tier 1: local ECDSA. The overwhelmingly common case, and the only one
  // that runs when the chain is unreachable. ────────────────────────────────
  if (await verifyEoa(address, input.message, input.signature)) {
    return { address, kind: 'eoa' };
  }

  // ── Tier 2: ask the chain ────────────────────────────────────────────────
  const verifier = getSmartAccountVerifier();
  if (!verifier) {
    // AUTH_SMART_ACCOUNT_LOGIN=false. Nothing was attempted on chain, so this
    // is an ordinary verification failure and gets the ordinary message.
    throw AppError.unauthorized('Signature verification failed');
  }

  /*
   * The slug must name the chain the verifier is pinned to. `isValidSignature`
   * is a call to an address ON A NETWORK: verifying a signature claimed for
   * `base` against Robinhood Chain state would ask whichever contract happens
   * to sit at that address on 4663 — possibly one the attacker deployed there
   * precisely to answer "valid". The app only ever signs in on `robinhood`
   * (0009), so this costs nothing real and closes a cross-chain confusion hole.
   */
  if (spec.chainId !== verifier.chainId) {
    throw AppError.unauthorized('Signature verification failed');
  }

  // Non-hex cannot be a contract signature either. Refuse before spending the
  // budget, so junk cannot burn a legitimate caller's allowance.
  if (!HEX_RE.test(input.signature)) {
    throw AppError.unauthorized('Signature verification failed');
  }

  // Charged here and only here: an EOA login never reaches this line.
  await input.budget.consume();

  let ok: boolean;
  try {
    ok = await verifier.verifyMessage({
      address,
      message: input.message,
      signature: input.signature,
    });
  } catch (err) {
    if (err instanceof ChainUnavailableError) {
      input.log?.warn('onchain_verification_unavailable', {
        reason: err.reason,
        chain: spec.slug,
        err_message: err.message,
      });
      throw chainUnavailableError(err);
    }
    throw err;
  }

  if (!ok) {
    throw AppError.unauthorized('Signature verification failed');
  }

  input.log?.info('onchain_verification_succeeded', {
    chain: spec.slug,
    chain_id: verifier.chainId,
  });
  return { address, kind: 'smart' };
}

/** For the startup log, so the RPC actually in use is visible without a shell. */
export function smartAccountLoginSummary(): Record<string, unknown> {
  return {
    enabled: env.AUTH_SMART_ACCOUNT_LOGIN,
    chain_id: env.AUTH_EVM_CHAIN_ID,
    rpc_url: env.AUTH_EVM_RPC_URL,
    timeout_ms: env.AUTH_EVM_TIMEOUT_MS,
  };
}
