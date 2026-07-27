/**
 * The JSON-RPC method allowlist (H-5).
 *
 * This proxy exists so that RPC credentials never reach a browser bundle. That
 * only helps if the proxy itself cannot be used as a signing or mutation
 * oracle, so the policy is an ALLOWLIST of read-only methods: anything not
 * named here is refused, including any method a future upstream adds.
 *
 * Explicitly NOT allowed, and why:
 *
 *   eth_sendRawTransaction   broadcasting. If the proxy could broadcast, a
 *   eth_sendTransaction      leaked browser token would be a free relay for
 *                            anyone's transactions — and the wager service's
 *                            payout path would have a second, unaudited way in.
 *   eth_sign, eth_signTransaction, personal_*   signing oracles.
 *   eth_accounts, eth_coinbase                  identity leakage from the node.
 *   admin_*, debug_*, txpool_*, miner_*, engine_*
 *                            node administration and mempool inspection.
 *
 * The wager service broadcasts its payouts through its own server-only
 * submission endpoint (`EVM_SUBMIT_RPC_URL`), never through here.
 */

/** Read-only methods any caller may use. */
export const DEFAULT_ALLOWED_METHODS: readonly string[] = [
  // chain / block state
  'eth_blockNumber',
  'eth_chainId',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'net_version',
  'web3_clientVersion',
  // account + contract reads
  'eth_call',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  // transactions
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  // fee estimation (needed to build a transaction client-side; harmless to read)
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
];

/**
 * Methods that are refused with an explicit explanation rather than a generic
 * "unknown method", because a developer hitting one of these has made a design
 * mistake we want to be loud about.
 */
export const EXPLICITLY_DENIED: readonly string[] = [
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData',
  'eth_signTypedData_v4',
  'eth_accounts',
  'eth_coinbase',
  'personal_sign',
  'personal_unlockAccount',
  'personal_sendTransaction',
];

const DENIED_PREFIXES = ['admin_', 'debug_', 'txpool_', 'miner_', 'engine_', 'personal_', 'les_'];

export interface MethodPolicy {
  allowed: Set<string>;
}

/**
 * Build the policy. An operator may narrow (or replace) the list through
 * `RPC_ALLOWED_METHODS`, but never widen it into a denied method: an explicit
 * denial always wins, so a configuration mistake cannot open a broadcast path.
 */
export function buildPolicy(override?: readonly string[]): MethodPolicy {
  const base = override && override.length > 0 ? override : DEFAULT_ALLOWED_METHODS;
  const allowed = new Set<string>();
  for (const method of base) {
    const name = method.trim();
    if (!name) continue;
    if (isHardDenied(name)) continue;
    allowed.add(name);
  }
  return { allowed };
}

export function isHardDenied(method: string): boolean {
  if (EXPLICITLY_DENIED.includes(method)) return true;
  return DENIED_PREFIXES.some((prefix) => method.startsWith(prefix));
}

export type MethodVerdict =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'not_allowed' | 'malformed' };

export function checkMethod(policy: MethodPolicy, method: unknown): MethodVerdict {
  if (typeof method !== 'string' || method.length === 0 || method.length > 128) {
    return { ok: false, reason: 'malformed' };
  }
  if (isHardDenied(method)) return { ok: false, reason: 'denied' };
  if (!policy.allowed.has(method)) return { ok: false, reason: 'not_allowed' };
  return { ok: true };
}
