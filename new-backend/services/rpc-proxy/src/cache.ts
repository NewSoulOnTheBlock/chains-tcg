/**
 * Short-TTL caching for results that cannot change.
 *
 * The rule: only cache a response that is immutable once produced, and only
 * when the REQUEST pins a specific block or transaction. Anything phrased
 * against `latest`, `pending`, `safe` or `finalized` is never cached, because
 * the same request legitimately returns different answers over time.
 *
 * The cache key includes the method and the exact params, so two callers only
 * share an entry when they asked precisely the same question.
 */
import { createHash } from 'node:crypto';

/** Block tags whose meaning moves. */
const MOVING_TAGS = new Set(['latest', 'pending', 'safe', 'finalized', 'earliest']);

export interface CachePolicy {
  ttlSeconds: number;
}

function containsMovingTag(params: readonly unknown[]): boolean {
  return params.some((p) => typeof p === 'string' && MOVING_TAGS.has(p.toLowerCase()));
}

/**
 * Returns the TTL for a request, or null when it must not be cached.
 *
 * `eth_getTransactionReceipt` and a mined `eth_getTransactionByHash` are the
 * valuable ones: the wager service reads the same receipt on every reconciliation
 * pass, and a receipt never changes once it exists. They still get a short TTL
 * rather than a long one, so a chain re-org cannot be served from cache for long.
 */
export function ttlFor(method: string, params: readonly unknown[], ttls: {
  receipt: number;
  transaction: number;
  block: number;
  chainId: number;
}): number | null {
  switch (method) {
    case 'eth_getTransactionReceipt':
      return ttls.receipt;
    case 'eth_getTransactionByHash':
      return ttls.transaction;
    case 'eth_getBlockByHash':
      return ttls.block;
    case 'eth_getBlockByNumber':
      // Only a numeric block is immutable; `latest` is not.
      return containsMovingTag(params) ? null : ttls.block;
    case 'eth_chainId':
    case 'net_version':
    case 'web3_clientVersion':
      return ttls.chainId;
    default:
      return null;
  }
}

/**
 * Only cache results that are actually final. A receipt-shaped `null` means
 * "not mined yet", which must never be remembered.
 */
export function isCacheableResult(method: string, result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (method === 'eth_getTransactionByHash' || method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') {
    const blockNumber = (result as { blockNumber?: unknown }).blockNumber;
    // Pending transactions and pending blocks have a null blockNumber.
    if (blockNumber === null || blockNumber === undefined) return false;
  }
  return true;
}

export function cacheKey(chainKey: string, method: string, params: readonly unknown[]): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(params ?? []))
    .digest('base64url')
    .slice(0, 32);
  return `rpc:${chainKey}:${method}:${digest}`;
}
