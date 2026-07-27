/**
 * Pure normalisation of EVM JSON-RPC responses into `ParsedTx`.
 *
 * Pure on purpose: every deposit and payment decision is made from this
 * structure, so it must be testable without a node.
 *
 * All addresses are lower-cased here, once, so that no comparison anywhere else
 * in the service can be defeated by checksum casing.
 */
import type { Erc20Transfer, ParsedTx } from './types.js';

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

type Json = Record<string, unknown>;

function asObject(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Lower-case an address-like string; null when it is not one. */
export function normalizeAddress(v: unknown): string | null {
  const s = asString(v);
  if (!s || !/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  return s.toLowerCase();
}

/** Parse a quantity that the node may return as hex or as a number. */
export function toBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string') {
    const s = v.trim();
    try {
      if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
      if (/^[0-9]+$/.test(s)) return BigInt(s);
    } catch {
      return null;
    }
  }
  return null;
}

export function toNumber(v: unknown): number | null {
  const b = toBigInt(v);
  if (b === null) return null;
  if (b > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(b);
}

/** The last 20 bytes of a 32-byte log topic, as a lower-case address. */
export function addressFromTopic(topic: unknown): string | null {
  const s = asString(topic);
  if (!s || !/^0x[0-9a-fA-F]{64}$/.test(s)) return null;
  return `0x${s.slice(-40)}`.toLowerCase();
}

function decodeTransferLog(raw: unknown): Erc20Transfer | null {
  const logEntry = asObject(raw);
  if (!logEntry) return null;
  if (logEntry.removed === true) return null;

  const topics = asArray(logEntry.topics);
  const topic0 = asString(topics[0]);
  if (!topic0 || topic0.toLowerCase() !== TRANSFER_TOPIC) return null;
  // An ERC-721 Transfer has four topics (the token id is indexed) and no data
  // amount; only the three-topic ERC-20 form is a value transfer.
  if (topics.length !== 3) return null;

  const token = normalizeAddress(logEntry.address);
  const from = addressFromTopic(topics[1]);
  const to = addressFromTopic(topics[2]);
  const value = toBigInt(logEntry.data);
  const logIndex = toNumber(logEntry.logIndex);
  if (!token || !from || !to || value === null) return null;

  return { token, from, to, value, logIndex: logIndex ?? 0 };
}

export interface RawTxParts {
  /** `eth_getTransactionByHash` result. */
  tx: unknown;
  /** `eth_getTransactionReceipt` result. */
  receipt: unknown;
  /** `eth_getBlockByNumber` result, for the timestamp. May be null. */
  block: unknown;
  /** Current head, for the confirmation count. */
  headBlockNumber: number;
}

/**
 * Combine the three reads into one verified view. Returns null when the
 * transaction is not yet mined — a receipt is required, so an unconfirmed
 * transaction can never satisfy a deposit.
 */
export function parseTransaction(hash: string, parts: RawTxParts): ParsedTx | null {
  const tx = asObject(parts.tx);
  const receipt = asObject(parts.receipt);
  if (!tx || !receipt) return null;

  const blockNumber = toNumber(receipt.blockNumber ?? tx.blockNumber);
  if (blockNumber === null) return null;

  // `status` is 0x1 / 0x0 post-Byzantium. Anything else we refuse to interpret.
  const statusRaw = toNumber(receipt.status);
  if (statusRaw === null) return null;

  const from = normalizeAddress(tx.from ?? receipt.from);
  if (!from) return null;

  const block = asObject(parts.block);
  const blockTimestamp = block ? toNumber(block.timestamp) : null;

  const erc20Transfers: Erc20Transfer[] = [];
  for (const raw of asArray(receipt.logs)) {
    const decoded = decodeTransferLog(raw);
    if (decoded) erc20Transfers.push(decoded);
  }

  const input = asString(tx.input) ?? '0x';

  return {
    hash: hash.toLowerCase(),
    blockNumber,
    blockTimestamp,
    status: statusRaw === 1 ? 'success' : 'reverted',
    from,
    to: normalizeAddress(tx.to ?? receipt.to),
    value: toBigInt(tx.value) ?? 0n,
    input: input.toLowerCase(),
    confirmations: Math.max(parts.headBlockNumber - blockNumber + 1, 0),
    erc20Transfers,
  };
}
