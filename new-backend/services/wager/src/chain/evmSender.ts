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
  }): Promise<PreparedTx> {
    if (args.amountBase <= 0n) throw new Error('refusing to prepare a non-positive transfer');

    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [args.to as Address, args.amountBase],
    });

    const fees = await this.client.estimateFeesPerGas().catch(() => null);
    const bump = (v: bigint): bigint => (v * BigInt(this.opts.feeBumpPercent)) / 100n;
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
      // These mean the network already has it — which is success, not failure.
      if (/already known|known transaction|nonce too low|already imported/i.test(message)) {
        log().info('payout_broadcast_duplicate', { tx_hash: prepared.hash });
        return;
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

export function accountFromPrivateKey(privateKey: string): PrivateKeyAccount {
  return privateKeyToAccount(privateKey as Hex);
}
