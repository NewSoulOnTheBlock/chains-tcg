/**
 * On-chain signature verification for smart accounts.
 *
 * ── Why the auth service now talks to a chain at all ───────────────────────
 *
 * An ERC-4337 smart account cannot produce a signature that ecrecovers to its
 * own address. There is no private key behind that address — it is a contract,
 * and the "signature" is whatever its own validation logic accepts (an owner
 * EOA's ECDSA blob, a passkey/WebAuthn assertion, a k-of-n bundle). The only
 * way to check one is to ask the contract, which is what ERC-1271
 * `isValidSignature(bytes32,bytes)` is for, and that is an `eth_call`.
 *
 * ERC-6492 extends that to an account that is NOT DEPLOYED YET. A 4337 wallet
 * does not exist on chain until its first userOp, so `isValidSignature` on it
 * reverts — and "sign in before you have ever transacted" is the normal case
 * for an email-backed wallet. 6492 wraps the signature with the factory call
 * that would deploy the account, and a validator contract deploys it inside an
 * `eth_call` (state discarded) before asking it. viem's `verifyHash` performs
 * that with a DEPLOYLESS call: the ERC-6492 validator's creation bytecode is
 * sent as an `eth_call` with no `to`, so nothing has to be deployed on 4663
 * first and no helper address has to be trusted.
 *
 * ── Everything here is on the SLOW path, never the normal one ──────────────
 *
 * `signature.ts` runs the cheap, local, network-free ECDSA check first and only
 * reaches this module when that has already failed. So:
 *
 *   - an ordinary EOA login makes no RPC call and is unaffected by this file;
 *   - if the RPC is unreachable, EOA logins keep working, full stop;
 *   - the cost of an outbound call can only be triggered by a request that has
 *     already proved it is not an ordinary login, which is what makes the
 *     budget in `onChainBudget.ts` a meaningful defence rather than a tax.
 */
import { createPublicClient, defineChain, http, type Chain, type PublicClient, type Transport } from 'viem';
import { AppError } from '@chains/shared';
import { env } from '../env.js';

export interface EvmVerifierOptions {
  rpcUrl: string;
  chainId: number;
  timeoutMs: number;
  /** Test seam. Production always builds an `http()` transport from `rpcUrl`. */
  transport?: Transport;
}

/**
 * Thrown when the chain could not be consulted — a timeout, a dead endpoint, a
 * wrong network. Distinct from "the signature is invalid" because it is a
 * statement about US, not about the caller's signature, and the two must not
 * collapse into the same answer: telling an AA user "your signature failed"
 * when our RPC is down sends them to reconnect a wallet that was never broken.
 */
export class ChainUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'ChainUnavailableError';
    this.reason = reason;
  }
}

/**
 * Verifies contract signatures against exactly one chain.
 *
 * The chain-id assertion is the important part. `isValidSignature` is a call to
 * an address, and an address means nothing without a network: repointing
 * `AUTH_EVM_RPC_URL` at another chain would ask a completely unrelated contract
 * (or an empty account) whether a signature is valid, and an empty account
 * returning "not valid" is indistinguishable from a real rejection. Worse, on a
 * chain where that address IS a contract the attacker controls, it would return
 * "valid" for anything. So the id is verified before the first verification and
 * a mismatch is permanent, not retried.
 *
 * This mirrors `CardPackReader.requireChain()` in the wager service, which
 * exists for the same reason and states it at length.
 */
export class EvmSmartAccountVerifier {
  private readonly client: PublicClient<Transport, Chain>;
  private readonly opts: EvmVerifierOptions;
  /** `true` once verified, `'mismatch'` once refused. Never re-checked after either. */
  private chainState: false | true | 'mismatch' = false;
  private inFlightChainCheck: Promise<void> | null = null;

  constructor(opts: EvmVerifierOptions) {
    this.opts = opts;

    // Minimal chain object. `contracts` is deliberately left empty: with no
    // `erc6492Verifier` and no `multicall3` address, viem uses the deployless
    // bytecode path and never calls a helper contract we have not verified
    // exists on 4663.
    const chain = defineChain({
      id: opts.chainId,
      name: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl] } },
    });

    this.client = createPublicClient({
      chain,
      // retryCount: 0 — a login-path call must not turn one outage into three
      // requests against an endpoint we do not own. One try, one timeout.
      transport: opts.transport ?? http(opts.rpcUrl, { timeout: opts.timeoutMs, retryCount: 0 }),
    }) as PublicClient<Transport, Chain>;
  }

  get chainId(): number {
    return this.opts.chainId;
  }

  /** Verified once per process; a mismatch is cached and never retried. */
  private async requireChain(): Promise<void> {
    if (this.chainState === true) return;
    if (this.chainState === 'mismatch') {
      throw new ChainUnavailableError(
        'chain_id_mismatch',
        `RPC endpoint is not chain ${this.opts.chainId}`,
      );
    }
    if (this.inFlightChainCheck) return this.inFlightChainCheck;

    this.inFlightChainCheck = (async () => {
      let actual: number;
      try {
        actual = await this.client.getChainId();
      } catch (err) {
        // Unreachable is transient: do NOT cache it, so the next login retries.
        throw new ChainUnavailableError(
          'chain_unreachable',
          err instanceof Error ? err.message : String(err),
        );
      }
      if (actual !== this.opts.chainId) {
        // Misconfiguration is permanent until someone changes the env.
        this.chainState = 'mismatch';
        throw new ChainUnavailableError(
          'chain_id_mismatch',
          `expected chain ${this.opts.chainId}, endpoint reports ${actual}`,
        );
      }
      this.chainState = true;
    })().finally(() => {
      this.inFlightChainCheck = null;
    });

    return this.inFlightChainCheck;
  }

  /**
   * `true` if `address` validates `signature` over `message` on this chain.
   *
   * Handled by `publicClient.verifyMessage`, in this order: ERC-8010 / ERC-6492
   * wrapper if the signature carries one, otherwise the deployless ERC-6492
   * validator, which itself falls through to ERC-1271 for a deployed account
   * and to plain ecrecover for an EOA. A revert anywhere in there means "not
   * valid" and returns `false`; a transport failure throws, and is translated
   * here into `ChainUnavailableError`.
   *
   * Returns `false` — never throws — for every genuine "this signature is not
   * valid" outcome, so the caller can keep one indistinguishable error message.
   */
  async verifyMessage(input: { address: string; message: string; signature: string }): Promise<boolean> {
    await this.requireChain();
    try {
      return await this.client.verifyMessage({
        address: input.address as `0x${string}`,
        message: input.message,
        signature: input.signature as `0x${string}`,
      });
    } catch (err) {
      // viem returns false for a reverted validation. Reaching here means the
      // call itself did not complete: timeout, connection refused, HTTP 5xx,
      // a node that rejects contract-creation eth_calls.
      throw new ChainUnavailableError(
        'chain_call_failed',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Process-wide instance                                                      */
/* -------------------------------------------------------------------------- */

let instance: EvmSmartAccountVerifier | null | undefined;

/**
 * The verifier for the configured chain, or `null` when smart-account login is
 * switched off. Built lazily so importing this module never opens a socket and
 * a service that never sees an AA signature never constructs one.
 */
export function getSmartAccountVerifier(): EvmSmartAccountVerifier | null {
  if (instance !== undefined) return instance;
  instance = env.AUTH_SMART_ACCOUNT_LOGIN
    ? new EvmSmartAccountVerifier({
        rpcUrl: env.AUTH_EVM_RPC_URL,
        chainId: env.AUTH_EVM_CHAIN_ID,
        timeoutMs: env.AUTH_EVM_TIMEOUT_MS,
      })
    : null;
  return instance;
}

/** Test seam, mirroring `setLoggerForTest` in the wager service. */
export function setSmartAccountVerifierForTest(v: EvmSmartAccountVerifier | null | undefined): void {
  instance = v;
}

/** Translate a chain fault into the response the client should see. */
export function chainUnavailableError(err: ChainUnavailableError): AppError {
  return AppError.unavailable(
    'Smart-account signature verification is temporarily unavailable — retry, or sign in with a wallet that signs with a private key',
    { reason: err.reason },
  );
}
