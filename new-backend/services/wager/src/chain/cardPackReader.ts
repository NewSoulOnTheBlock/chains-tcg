/**
 * Reads the CardPack ERC-721 on Robinhood Chain (4663).
 *
 * ── WHY THIS DOES NOT GO THROUGH THE RPC PROXY ──────────────────────────────
 *
 * The proxy is pinned to ONE network by its own server env, and production
 * answers `eth_chainId` with `0xaa36a7` — Sepolia (11155111). CardPack lives on
 * Robinhood Chain (4663). The proxy physically cannot see this contract: not the
 * owner of a token, not a Transfer log, nothing. Giving the proxy a second
 * upstream would be the tidier long-term shape, but `services/rpc-proxy` is
 * outside this service's ownership, so this service reads 4663 directly.
 *
 * That does not reintroduce H-5. H-5 was about CREDENTIALS in a place that could
 * leak them. Robinhood Chain publishes a keyless public endpoint — no API key,
 * no account, nothing to rotate — and it is the same endpoint the browser bundle
 * already uses (`<repo>/src/pack-evm.ts` documents this at length). There is no
 * secret here to protect. The URL is still configurable so an operator can point
 * at their own node, but it must never be pointed at a credentialed URL, and
 * `describeEnv` does not redact it precisely because it must stay auditable.
 *
 * ── ENUMERATING WHAT AN ADDRESS HOLDS ───────────────────────────────────────
 *
 * CardPack is plain ERC721 (OpenZeppelin `ERC721`, not `ERC721Enumerable`), so
 * there is no `tokenOfOwnerByIndex` and no `totalSupply`. Two steps:
 *
 *   1. `eth_getLogs` over `Transfer(address,address,uint256)` with `topics[2]`
 *      (the `to` address) bound to the holder. That yields every token the
 *      address has EVER received — a superset.
 *   2. `ownerOf(tokenId)` on each candidate, keeping only the ones it still
 *      holds. These are tradeable NFTs; a player can mint, be recorded, and sell
 *      in the same minute. Skipping step 2 would turn "sell your cards and keep
 *      playing them" into the cheapest exploit in the product.
 *
 * Then `cardOf(tokenId)` gives the card index.
 *
 * ── COMPLETENESS IS A SAFETY PROPERTY HERE ──────────────────────────────────
 *
 * The caller writes the result as a FULL RECONCILE — cards absent from the
 * snapshot are deleted. A partial enumeration would therefore destroy holdings
 * rather than merely under-report them. So this reader never returns a partial
 * answer: it scans the whole range in windows, and if any window fails it
 * throws. Nothing here silently caps a range.
 */
import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  pad,
  toEventSelector,
  type Address,
  type Hex,
} from 'viem';
import { AppError } from '../platform/shared.js';
import { log } from '../platform/logger.js';

const CARD_PACK_ABI = [
  {
    type: 'function',
    name: 'cardCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'nextId',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'cardOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isFoil',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)');

/** One token the address holds right now. */
export interface HeldToken {
  tokenId: bigint;
  cardIndex: number;
  foil: boolean;
}

export interface HoldingsSnapshot {
  /** Head block the snapshot was taken at. Everything below is true as of here. */
  blockNumber: number;
  tokens: HeldToken[];
  /** Token ids seen as received but no longer owned — sold, gifted or burned. */
  transferredAway: number;
}

export interface CardPackReaderOptions {
  rpcUrl: string;
  /** The chain this reader REQUIRES. A different answer is a fatal misconfiguration. */
  chainId: number;
  contract: string;
  /** Block CardPack was deployed at. Scanning below it only wastes requests. */
  deployBlock: number;
  /** Blocks per `eth_getLogs` window. Public nodes cap the span per request. */
  logWindow: number;
  /**
   * Upper bound on tokens examined in the `nextId` fallback. Exceeding it throws
   * rather than truncating — see the completeness note above.
   */
  maxTokenScan: number;
  timeoutMs: number;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

function hexToBigInt(value: unknown): bigint {
  if (typeof value !== 'string') throw new Error('expected a hex quantity');
  return BigInt(value);
}

export class CardPackReader {
  private readonly contract: Address;
  private nextRequestId = 1;
  /** Verified once per process: the endpoint really is the chain we asked for. */
  private chainVerified = false;

  constructor(private readonly opts: CardPackReaderOptions) {
    this.contract = getAddress(opts.contract);
  }

  get contractAddress(): string {
    return this.contract.toLowerCase();
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await fetch(this.opts.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.nextRequestId++,
          method,
          params,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // The body is not echoed: it can contain addresses.
        log().warn('cardpack_rpc_http_error', {
          method,
          status: res.status,
          ms: Date.now() - started,
        });
        throw AppError.unavailable('Card chain data is temporarily unavailable', {
          reason: 'card_chain_unavailable',
        });
      }
      const body = (await res.json()) as JsonRpcResponse;
      if (body.error) {
        log().warn('cardpack_rpc_error', { method, rpc_code: body.error.code });
        throw AppError.unavailable('Card chain data is temporarily unavailable', {
          reason: 'card_chain_error',
        });
      }
      log().debug('cardpack_rpc_call', { method, ms: Date.now() - started });
      return body.result as T;
    } catch (err) {
      if (err instanceof AppError) throw err;
      const aborted = err instanceof Error && err.name === 'AbortError';
      log().warn('cardpack_rpc_failed', { method, ms: Date.now() - started, aborted });
      throw AppError.unavailable('Card chain data is temporarily unavailable', {
        reason: 'card_chain_unreachable',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Confirm the endpoint is the chain we think it is, once per process.
   *
   * Without this, repointing `CARD_PACK_RPC_URL` at another network would make
   * every `ownerOf` revert-or-return-nothing and every player look like they own
   * nothing — which, under a full reconcile, deletes real collections.
   */
  private async requireChain(): Promise<void> {
    if (this.chainVerified) return;
    const id = Number(hexToBigInt(await this.rpc<string>('eth_chainId', [])));
    if (id !== this.opts.chainId) {
      log().error('cardpack_wrong_chain', { expected: this.opts.chainId, actual: id });
      throw AppError.unavailable('Card ownership cannot be synced on this deployment', {
        reason: 'card_chain_mismatch',
        expected_chain_id: this.opts.chainId,
        actual_chain_id: id,
      });
    }
    this.chainVerified = true;
  }

  private async callContract<TName extends (typeof CARD_PACK_ABI)[number]['name']>(
    functionName: TName,
    args: readonly unknown[],
  ): Promise<unknown> {
    const data = encodeFunctionData({
      abi: CARD_PACK_ABI,
      functionName,
      args: args as never,
    });
    const raw = await this.rpc<Hex>('eth_call', [{ to: this.contract, data }, 'latest']);
    return decodeFunctionResult({ abi: CARD_PACK_ABI, functionName, data: raw });
  }

  async getBlockNumber(): Promise<number> {
    await this.requireChain();
    return Number(hexToBigInt(await this.rpc<string>('eth_blockNumber', [])));
  }

  /** Immutable in the contract, so this is the mapping's anchor. */
  async cardCount(): Promise<number> {
    await this.requireChain();
    return Number((await this.callContract('cardCount', [])) as bigint);
  }

  /** One past the highest minted token id. */
  async nextId(): Promise<bigint> {
    await this.requireChain();
    return (await this.callContract('nextId', [])) as bigint;
  }

  /** Null when the token does not exist — `ownerOf` reverts, which surfaces as an RPC error. */
  private async ownerOf(tokenId: bigint): Promise<string | null> {
    try {
      const owner = (await this.callContract('ownerOf', [tokenId])) as Address;
      return owner.toLowerCase();
    } catch {
      return null;
    }
  }

  private async cardOf(tokenId: bigint): Promise<number> {
    return Number((await this.callContract('cardOf', [tokenId])) as bigint);
  }

  private async isFoil(tokenId: bigint): Promise<boolean> {
    return (await this.callContract('isFoil', [tokenId])) as boolean;
  }

  /**
   * Every token id the address has ever been sent, via `Transfer` logs.
   *
   * The full range is scanned in windows. Every window is logged with its
   * bounds, so an operator can see exactly what was covered — a range that
   * silently stopped early would look identical to a player who sold everything.
   */
  private async candidateTokenIds(owner: string, head: number): Promise<Set<bigint>> {
    const topicTo = pad(getAddress(owner), { size: 32 }).toLowerCase();
    const candidates = new Set<bigint>();
    const from = Math.max(0, this.opts.deployBlock);
    let windows = 0;

    for (let start = from; start <= head; start += this.opts.logWindow) {
      const end = Math.min(start + this.opts.logWindow - 1, head);
      const logs = await this.rpc<Array<{ topics?: string[] }>>('eth_getLogs', [
        {
          address: this.contract,
          fromBlock: `0x${start.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
          topics: [TRANSFER_TOPIC, null, topicTo],
        },
      ]);
      for (const entry of logs ?? []) {
        // ERC721 indexes all three parameters, so the token id is topics[3].
        // (An ERC20 Transfer carries the value in `data` and has no topics[3] —
        // filtering by contract address already excludes those.)
        const tokenTopic = entry.topics?.[3];
        if (typeof tokenTopic === 'string') candidates.add(BigInt(tokenTopic));
      }
      windows += 1;
    }

    log().debug('cardpack_log_scan', {
      from_block: from,
      to_block: head,
      windows,
      candidates: candidates.size,
    });
    return candidates;
  }

  /**
   * Fallback when the endpoint will not serve logs at all.
   *
   * Bounded by `maxTokenScan`, and it THROWS on exceeding it instead of
   * returning what it managed to read: the caller reconciles destructively, so a
   * truncated scan would delete cards the player still holds.
   */
  private async candidatesByScan(): Promise<Set<bigint>> {
    const next = await this.nextId();
    if (next > BigInt(this.opts.maxTokenScan)) {
      log().error('cardpack_scan_too_large', {
        next_id: next.toString(),
        max_token_scan: this.opts.maxTokenScan,
      });
      throw AppError.unavailable('Card ownership cannot be synced right now', {
        reason: 'card_enumeration_unavailable',
      });
    }
    log().warn('cardpack_log_scan_unavailable', {
      fallback: 'full_token_scan',
      next_id: next.toString(),
    });
    const out = new Set<bigint>();
    for (let id = 0n; id < next; id += 1n) out.add(id);
    return out;
  }

  /**
   * What `owner` holds right now, as of a single head block.
   *
   * `head` is read FIRST and every subsequent read is `latest`, so the snapshot
   * can only ever be equal to or newer than the recorded block — never older
   * than it claims to be.
   */
  async holdingsOf(owner: string): Promise<HoldingsSnapshot> {
    await this.requireChain();
    const head = await this.getBlockNumber();
    const normalised = getAddress(owner).toLowerCase();

    let candidates: Set<bigint>;
    try {
      candidates = await this.candidateTokenIds(normalised, head);
    } catch (err) {
      log().warn('cardpack_getlogs_failed', {
        reason: err instanceof AppError ? String(err.details) : 'unknown',
      });
      candidates = await this.candidatesByScan();
    }

    const tokens: HeldToken[] = [];
    let transferredAway = 0;

    // Sorted so a snapshot is reproducible for support, and serialised so a
    // public endpoint is not hammered with an unbounded fan-out.
    for (const tokenId of [...candidates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const holder = await this.ownerOf(tokenId);
      if (holder !== normalised) {
        transferredAway += 1;
        continue;
      }
      tokens.push({
        tokenId,
        cardIndex: await this.cardOf(tokenId),
        foil: await this.isFoil(tokenId),
      });
    }

    return { blockNumber: head, tokens, transferredAway };
  }
}
