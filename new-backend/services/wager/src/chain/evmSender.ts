/**
 * ChainSender — signs ERC-20 payouts locally and broadcasts them.
 *
 * Why this does not go through the rpc-proxy: the proxy's allowlist refuses
 * `eth_sendRawTransaction` by design, so that a leaked browser-facing token can
 * never broadcast anything. Payout submission therefore uses a dedicated,
 * server-only endpoint (`EVM_SUBMIT_RPC_URL`). All *reads* still go through the
 * proxy.
 *
 * The critical property: `prepareTransfer` signs but does NOT send, and the
 * caller supplies the nonce. That gives two independent exactly-once anchors —
 * the hash is known before broadcast (so it can be recorded first), and two
 * transactions sharing a nonce are mutually exclusive by consensus rule.
 */
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { log } from '../platform/logger.js';
import type { ChainReader, ChainSender, PreparedTx } from './types.js';

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface EvmSenderOptions {
  submitRpcUrl: string;
  chainId: number;
  account: PrivateKeyAccount;
  /** ERC-20 contract the escrow holds. */
  token: string;
  reader: ChainReader;
  /** Upper bound on gas for a single ERC-20 transfer. */
  gasLimit: bigint;
  /** Multiplier applied to the suggested fees, in percent (150 = 1.5x). */
  feeBumpPercent: number;
}

/**
 * Classify a broadcast error message (server-35). Pure, so it is unit-testable
 * without a network:
 *   'duplicate'      — the exact same signed bytes are already known; success.
 *   'nonce_too_low'  — the nonce is used; the caller must check whether OUR hash
 *                      landed before deciding this is success or a lost nonce.
 *   'rethrow'        — a real failure.
 */
export function classifyBroadcastError(message: string): 'duplicate' | 'nonce_too_low' | 'rethrow' {
  if (/nonce too low/i.test(message)) return 'nonce_too_low';
  if (/already known|known transaction|already imported/i.test(message)) return 'duplicate';
  return 'rethrow';
}

export class EvmSender implements ChainSender {
  private readonly client: ReturnType<typeof createPublicClient>;
  private readonly account: PrivateKeyAccount;
  private readonly token: Address;
  private readonly reader: ChainReader;

  constructor(private readonly opts: EvmSenderOptions) {
    this.client = createPublicClient({ transport: http(opts.submitRpcUrl) });
    this.account = opts.account;
    this.token = opts.token as Address;
    this.reader = opts.reader;
  }

  get escrowAddress(): string {
    return this.account.address.toLowerCase();
  }

  /** Pending-inclusive nonce, read through the proxy. */
  async currentNonce(): Promise<number> {
    return this.reader.getTransactionCount(this.escrowAddress);
  }

  async prepareTransfer(args: {
    to: string;
    amountBase: bigint;
    nonce: number;
    feeEscalationAttempt?: number;
  }): Promise<PreparedTx> {
    if (args.amountBase <= 0n) throw new Error('refusing to prepare a non-positive transfer');

    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [args.to as Address, args.amountBase],
    });

    const fees = await this.client.estimateFeesPerGas().catch(() => null);
    // Base bump, then an extra +25% per replace-by-fee attempt so a replacement
    // at the same nonce clears the node's "replacement underpriced" floor and
    // outbids the stuck original (server-34).
    const escalate = Math.max(0, Math.floor(args.feeEscalationAttempt ?? 0));
    const escalationPct = BigInt(100 + 25 * escalate);
    const bump = (v: bigint): bigint =>
      (v * BigInt(this.opts.feeBumpPercent) * escalationPct) / (100n * 100n);
    const maxFeePerGas = bump(fees?.maxFeePerGas ?? 30_000_000_000n);
    const maxPriorityFeePerGas = bump(fees?.maxPriorityFeePerGas ?? 1_500_000_000n);

    const raw = await this.account.signTransaction({
      type: 'eip1559',
      chainId: this.opts.chainId,
      nonce: args.nonce,
      to: this.token,
      value: 0n,
      data,
      gas: this.opts.gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    });

    // The hash is fully determined by the signed bytes — no network involved.
    return { hash: keccak256(raw as Hex).toLowerCase(), raw, nonce: args.nonce };
  }

  async broadcast(prepared: PreparedTx): Promise<void> {
    try {
      await this.client.request({
        method: 'eth_sendRawTransaction',
        params: [prepared.raw as Hex],
      });
      log().info('payout_broadcast', { tx_hash: prepared.hash, nonce: prepared.nonce });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind = classifyBroadcastError(message);
      // A re-broadcast of the SAME bytes: the network already has exactly this
      // transaction, so this is success, not failure.
      if (kind === 'duplicate') {
        log().info('payout_broadcast_duplicate', { tx_hash: prepared.hash });
        return;
      }
      // 'nonce too low' is ambiguous (server-35): it means the nonce has been
      // used, but NOT necessarily by THIS transaction. If our own hash landed,
      // it is success; if a DIFFERENT transaction consumed the nonce (a manual
      // send from the escrow key, or a mined replacement), our hash will never
      // appear and treating this as success would wedge the leg 'pending'
      // forever. Disambiguate by looking up our own hash.
      if (kind === 'nonce_too_low') {
        const status = await this.reader.getTransactionStatus(prepared.hash);
        if (status.found) {
          log().info('payout_broadcast_duplicate', { tx_hash: prepared.hash, via: 'nonce_too_low' });
          return;
        }
        log().warn('payout_nonce_consumed_by_other', { tx_hash: prepared.hash, nonce: prepared.nonce });
        throw new NonceConsumedError(prepared.hash, prepared.nonce);
      }
      throw err;
    }
  }

  async awaitOutcome(prepared: PreparedTx): Promise<'confirmed' | 'reverted' | 'pending'> {
    const status = await this.reader.getTransactionStatus(prepared.hash);
    if (!status.found) return 'pending';
    return status.status === 'success' ? 'confirmed' : 'reverted';
  }
}

/**
 * Thrown by `broadcast` when the escrow nonce was consumed by a DIFFERENT
 * transaction (not this leg's hash). The caller must rebuild the leg at a fresh
 * nonce rather than keep polling for a hash that can never land (server-35).
 */
export class NonceConsumedError extends Error {
  constructor(
    public readonly txHash: string,
    public readonly nonce: number,
  ) {
    super(`escrow nonce ${nonce} was consumed by another transaction; ${txHash} cannot land`);
    this.name = 'NonceConsumedError';
  }
}

export function accountFromPrivateKey(privateKey: string): PrivateKeyAccount {
  return privateKeyToAccount(privateKey as Hex);
}
