/**
 * In-memory chain doubles.
 *
 * `FakeSender` is what makes the settlement worker's exactly-once behaviour
 * testable: it counts broadcasts and records every nonce it was asked to sign
 * at, so "ran twice, paid once" and "a replacement reuses the nonce" are
 * assertions rather than claims.
 */
import type {
  ChainReader,
  ChainSender,
  MintedTicket,
  ParsedTx,
  PreparedTx,
  TicketMinter,
  TxStatus,
} from '../chain/types.js';

export class FakeReader implements ChainReader {
  transactions = new Map<string, ParsedTx>();
  statuses = new Map<string, TxStatus>();
  blockNumber = 1_000;
  nonces = new Map<string, number>();

  async getTransaction(hash: string): Promise<ParsedTx | null> {
    return this.transactions.get(hash.toLowerCase()) ?? null;
  }

  async getTransactionStatus(hash: string): Promise<TxStatus> {
    return this.statuses.get(hash.toLowerCase()) ?? { found: false, status: null, blockNumber: null };
  }

  async getBlockNumber(): Promise<number> {
    return this.blockNumber;
  }

  async getTransactionCount(address: string): Promise<number> {
    return this.nonces.get(address.toLowerCase()) ?? 0;
  }
}

export interface FakeSenderOptions {
  /** What `awaitOutcome` reports once a transaction has been broadcast. */
  outcome?: 'confirmed' | 'reverted' | 'pending';
  /** Throw on broadcast, simulating a network failure after signing. */
  broadcastThrows?: boolean;
  /** Nonce the "chain" reports as next. */
  startNonce?: number;
}

export class FakeSender implements ChainSender {
  prepared: PreparedTx[] = [];
  broadcasts: string[] = [];
  transfers: Array<{ to: string; amountBase: bigint; nonce: number }> = [];
  readonly escrowAddress = '0xescrow0000000000000000000000000000000000';
  private counter = 0;
  private landed = new Set<string>();

  constructor(private readonly options: FakeSenderOptions = {}) {}

  /** Number of DISTINCT transactions this sender was asked to broadcast. */
  get distinctBroadcasts(): number {
    return new Set(this.broadcasts).size;
  }

  async prepareTransfer(args: {
    to: string;
    amountBase: bigint;
    nonce: number;
  }): Promise<PreparedTx> {
    this.counter += 1;
    this.transfers.push({ to: args.to, amountBase: args.amountBase, nonce: args.nonce });
    // Real hashes differ whenever any field does, including the nonce and the
    // fee, so a replacement never collides with the transaction it replaces.
    const prepared: PreparedTx = {
      hash: `0xhash_n${args.nonce}_a${this.counter}`,
      raw: `0xraw_n${args.nonce}_a${this.counter}`,
      nonce: args.nonce,
    };
    this.prepared.push(prepared);
    return prepared;
  }

  async broadcast(prepared: PreparedTx): Promise<void> {
    this.broadcasts.push(prepared.hash);
    if (this.options.broadcastThrows) throw new Error('node rejected the transaction');
    this.landed.add(prepared.hash);
  }

  async awaitOutcome(prepared: PreparedTx): Promise<'confirmed' | 'reverted' | 'pending'> {
    if (!this.landed.has(prepared.hash)) return 'pending';
    return this.options.outcome ?? 'confirmed';
  }

  /** Simulate a transaction that reached the network without us recording it. */
  markLanded(hash: string): void {
    this.landed.add(hash);
  }
}

/** Mirrors the production `UnavailableTicketMinter` but records the attempt. */
export class FakeMinter implements TicketMinter {
  minted: Array<{ paymentTxHash: string; ticketNumber: number; owner: string }> = [];
  failNext = false;

  constructor(readonly enabled: boolean = true) {}

  async mintTicket(args: {
    paymentTxHash: string;
    ownerAddress: string;
    ticketNumber: number;
  }): Promise<MintedTicket> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('issuance failed');
    }
    this.minted.push({
      paymentTxHash: args.paymentTxHash,
      ticketNumber: args.ticketNumber,
      owner: args.ownerAddress,
    });
    return {
      assetAddress: '0xticket00000000000000000000000000000000000',
      tokenId: String(args.ticketNumber),
      txHash: `0xmint${args.ticketNumber}`,
    };
  }
}
