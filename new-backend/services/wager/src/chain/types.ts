/**
 * The EVM chain interface the money paths are written against.
 *
 * Reads and writes are split deliberately:
 *  - reads go through the rpc-proxy, so this service holds no RPC credentials
 *    (H-5),
 *  - writes are signed locally and broadcast to a separate, server-only
 *    endpoint, because the proxy's allowlist refuses `eth_sendRawTransaction`.
 *
 * Both halves are interfaces so the settlement worker can be tested against a
 * fake chain with no network at all.
 */

/** A decoded ERC-20 `Transfer(address,address,uint256)` log. */
export interface Erc20Transfer {
  /** Token contract that emitted the log. Lower-case hex. */
  token: string;
  from: string;
  to: string;
  value: bigint;
  logIndex: number;
}

export interface ParsedTx {
  hash: string;
  blockNumber: number;
  /** Unix seconds, or null when the node did not return the block. */
  blockTimestamp: number | null;
  status: 'success' | 'reverted';
  /** Transaction sender — the account that actually signed. Lower-case hex. */
  from: string;
  to: string | null;
  /** Native value moved by the transaction itself. */
  value: bigint;
  /** Calldata, lower-case hex including the `0x`. */
  input: string;
  /** Confirmations at the time of the read. */
  confirmations: number;
  erc20Transfers: Erc20Transfer[];
}

export interface TxStatus {
  found: boolean;
  status: 'success' | 'reverted' | null;
  blockNumber: number | null;
}

export interface ChainReader {
  /** Null when the hash is unknown or still in the mempool without a receipt. */
  getTransaction(hash: string): Promise<ParsedTx | null>;
  getTransactionStatus(hash: string): Promise<TxStatus>;
  getBlockNumber(): Promise<number>;
  /** Pending-inclusive nonce for an address. */
  getTransactionCount(address: string): Promise<number>;
}

/**
 * A transaction that has been built and SIGNED but not yet broadcast.
 *
 * On EVM the hash is `keccak256(rawSignedTx)` — known before the network sees
 * it. Together with the fixed `nonce` this is what makes settlement exactly
 * once: the hash is recorded first, and two transactions sharing a nonce are
 * mutually exclusive on-chain by consensus rule, not by our bookkeeping.
 */
export interface PreparedTx {
  hash: string;
  raw: string;
  nonce: number;
}

export interface TransferRequest {
  /** Recipient address. */
  to: string;
  amountBase: bigint;
}

export interface ChainSender {
  /** The address that holds escrowed funds and signs payouts. */
  readonly escrowAddress: string;
  /**
   * Build + sign (but do NOT send) one ERC-20 transfer at an explicit nonce.
   * The caller allocates the nonce so it can be persisted with the hash.
   */
  prepareTransfer(args: { to: string; amountBase: bigint; nonce: number }): Promise<PreparedTx>;
  /** Broadcast already-signed bytes. Safe to call repeatedly. */
  broadcast(prepared: PreparedTx): Promise<void>;
  /** 'pending' until the transaction is mined. */
  awaitOutcome(prepared: PreparedTx): Promise<'confirmed' | 'reverted' | 'pending'>;
}

export interface MintedTicket {
  /** Contract or collection address the ticket lives in. */
  assetAddress: string;
  /** Token id / serial, as a string. */
  tokenId: string;
  txHash: string;
}

/**
 * Booster ticket issuance.
 *
 * The legacy implementation was Solana/Metaplex Core and has been deleted along
 * with the rest of the Solana path. Ticket *reservation* — the part that
 * carries the H-3 guarantees — is fully implemented and chain-independent; the
 * on-chain issuance step sits behind this interface awaiting an EVM contract.
 */
export interface TicketMinter {
  /** False while no chain integration is configured. */
  readonly enabled: boolean;
  mintTicket(args: {
    paymentTxHash: string;
    ownerAddress: string;
    ticketNumber: number;
  }): Promise<MintedTicket>;
}
