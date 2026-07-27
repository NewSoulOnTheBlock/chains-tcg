/**
 * The chain registry. `core.profiles` is keyed on `unique (address, chain)`, so
 * the *exact* string used for `chain` and the *exact* normalisation applied to
 * `address` are security-relevant: two spellings of the same wallet would
 * otherwise become two profiles.
 *
 * Normalisation rules:
 *   EVM     — hex, case-insensitive. Stored lowercase. Compared lowercase.
 *   Solana  — base58, case-SENSITIVE. Stored verbatim. Never lowercased.
 */
import { AppError } from './errors.js';

export type ChainKind = 'evm' | 'solana';

export interface ChainSpec {
  slug: string;
  kind: ChainKind;
  label: string;
  /** EIP-155 chain id. Present for EVM chains only. */
  chainId?: number;
}

export const CHAINS = {
  solana: { slug: 'solana', kind: 'solana', label: 'Solana' },
  ethereum: { slug: 'ethereum', kind: 'evm', label: 'Ethereum', chainId: 1 },
  base: { slug: 'base', kind: 'evm', label: 'Base', chainId: 8453 },
  arbitrum: { slug: 'arbitrum', kind: 'evm', label: 'Arbitrum One', chainId: 42161 },
  polygon: { slug: 'polygon', kind: 'evm', label: 'Polygon', chainId: 137 },
} as const satisfies Record<string, ChainSpec>;

export type ChainSlug = keyof typeof CHAINS;

export const CHAIN_SLUGS = Object.keys(CHAINS) as ChainSlug[];

export function isSupportedChain(slug: string): slug is ChainSlug {
  return Object.prototype.hasOwnProperty.call(CHAINS, slug);
}

/** Look up a chain or reject the request. */
export function getChain(slug: string): ChainSpec {
  if (!isSupportedChain(slug)) {
    throw AppError.badRequest(`Unsupported chain: ${JSON.stringify(slug).slice(0, 40)}`, {
      supported: CHAIN_SLUGS,
    });
  }
  return CHAINS[slug];
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// base58 alphabet: no 0, O, I, l.
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidAddress(chain: string, address: string): boolean {
  if (typeof address !== 'string') return false;
  const spec = isSupportedChain(chain) ? CHAINS[chain] : undefined;
  if (!spec) return false;
  return spec.kind === 'evm' ? EVM_ADDRESS_RE.test(address) : BASE58_ADDRESS_RE.test(address);
}

/**
 * Canonical storage form. Throws on an address that does not belong to the
 * chain — an unnormalisable address must never reach a query.
 */
export function normalizeAddress(chain: string, address: string): string {
  const spec = getChain(chain);
  const trimmed = typeof address === 'string' ? address.trim() : '';
  if (!isValidAddress(spec.slug, trimmed)) {
    throw AppError.badRequest(`Invalid ${spec.label} address`);
  }
  return spec.kind === 'evm' ? trimmed.toLowerCase() : trimmed;
}

/** Constant-shape comparison of two addresses on the same chain. */
export function addressesEqual(chain: string, a: string, b: string): boolean {
  try {
    return normalizeAddress(chain, a) === normalizeAddress(chain, b);
  } catch {
    return false;
  }
}

/**
 * Human-readable short form, used as the default display name on first login:
 * `0x1234…9abc` / `7Xk2…q4Rt`.
 */
export function shortAddress(address: string): string {
  if (address.length <= 11) return address;
  const head = address.startsWith('0x') ? address.slice(0, 6) : address.slice(0, 4);
  return `${head}…${address.slice(-4)}`;
}
