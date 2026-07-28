/**
 * Signature verification: EOA, smart account (ERC-1271 / ERC-6492), and what
 * happens when the chain cannot be reached.
 *
 * No database and no Redis: every case here is a pure function of a signature,
 * a message and a stubbed JSON-RPC transport, so this file always runs.
 *
 *     npx vitest run src/__tests__/signature.test.ts   (from services/auth)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { custom, type EIP1193RequestFn } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// `env.ts` loads eagerly at import time and exits the process on a bad schema,
// so every variable it needs must be present before the first import below.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://chains:unused@127.0.0.1:5432/chains';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long';
  process.env.LOG_LEVEL ??= 'error';
});

const { AppError } = await import('@chains/shared');
const { EvmSmartAccountVerifier, setSmartAccountVerifierForTest } = await import(
  '../chain/evmVerifier.js'
);
const { verifyWalletSignature } = await import('../signature.js');
import type { OnChainBudget } from '../chain/onChainBudget.js';

const CHAIN = 'robinhood';
const CHAIN_ID_HEX = '0x1237'; // 4663
const MESSAGE = 'ocva.online wants you to sign in with your Robinhood Chain account:\n…';

/** Counts charges so a test can assert an EOA login never pays for an RPC. */
function countingBudget(): OnChainBudget & { charges: number } {
  return {
    charges: 0,
    async consume() {
      this.charges += 1;
    },
  };
}

const TRUE_WORD = `0x${'0'.repeat(63)}1` as const;
const FALSE_WORD = `0x${'0'.repeat(64)}` as const;

/**
 * A JSON-RPC endpoint that answers `eth_chainId` and returns a fixed word for
 * the deployless ERC-6492 validator `eth_call`. `calls` records what was asked,
 * so a test can prove the chain was consulted (or was not).
 */
function stubTransport(opts: { chainIdHex?: string; callResult?: string; throwOn?: string }) {
  const calls: string[] = [];
  const request = (async ({ method }: { method: string }) => {
    calls.push(method);
    if (opts.throwOn === method || opts.throwOn === '*') {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8545');
    }
    if (method === 'eth_chainId') return opts.chainIdHex ?? CHAIN_ID_HEX;
    if (method === 'eth_call') return opts.callResult ?? TRUE_WORD;
    throw new Error(`unexpected RPC method ${method}`);
  }) as unknown as EIP1193RequestFn;

  return { transport: custom({ request }), calls };
}

function verifierWith(opts: Parameters<typeof stubTransport>[0]) {
  const { transport, calls } = stubTransport(opts);
  const verifier = new EvmSmartAccountVerifier({
    rpcUrl: 'http://stub.invalid',
    chainId: 4663,
    timeoutMs: 1_000,
    transport,
  });
  return { verifier, calls };
}

beforeEach(() => {
  setSmartAccountVerifierForTest(undefined);
});

describe('EOA signatures', () => {
  it('verifies a 65-byte ECDSA signature and never touches the chain', async () => {
    const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const signature = await account.signMessage({ message: MESSAGE });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);

    const { verifier, calls } = verifierWith({});
    setSmartAccountVerifierForTest(verifier);
    const budget = countingBudget();

    const result = await verifyWalletSignature({
      chain: CHAIN,
      address: account.address,
      message: MESSAGE,
      signature,
      budget,
    });

    expect(result).toEqual({ address: account.address.toLowerCase(), kind: 'eoa' });
    // The two assertions that matter: no RPC, no budget spent.
    expect(calls).toEqual([]);
    expect(budget.charges).toBe(0);
  });

  it('still works when the chain is completely unreachable', async () => {
    const account = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const signature = await account.signMessage({ message: MESSAGE });

    // Every RPC method throws. An EOA login must be unaffected — this is the
    // property that makes the new network dependency acceptable on the login
    // path at all.
    const { verifier, calls } = verifierWith({ throwOn: '*' });
    setSmartAccountVerifierForTest(verifier);
    const budget = countingBudget();

    const result = await verifyWalletSignature({
      chain: CHAIN,
      address: account.address,
      message: MESSAGE,
      signature,
      budget,
    });

    expect(result.kind).toBe('eoa');
    expect(calls).toEqual([]);
    expect(budget.charges).toBe(0);
  });

  it('normalises a checksummed address to one identity', async () => {
    const account = privateKeyToAccount(`0x${'33'.repeat(32)}`);
    const signature = await account.signMessage({ message: MESSAGE });
    setSmartAccountVerifierForTest(null);

    const result = await verifyWalletSignature({
      chain: CHAIN,
      // The checksummed spelling from viem, not the lowercase storage form.
      address: account.address,
      message: MESSAGE,
      signature,
      budget: countingBudget(),
    });
    expect(result.address).toBe(account.address.toLowerCase());
    expect(result.address).not.toBe(account.address);
  });
});

describe('smart-account signatures (ERC-1271 / ERC-6492)', () => {
  const SMART_ACCOUNT = '0x1234567890abcdef1234567890abcdef12345678';

  /**
   * A 6492-shaped signature: far longer than 65 bytes, which the old
   * `HEX_SIGNATURE_RE` gate rejected outright BEFORE verification ran. This is
   * the case that made account abstraction unable to sign in at all.
   */
  const WRAPPED_SIGNATURE = `0x${'ab'.repeat(200)}`;

  it('verifies when the validator returns true', async () => {
    const { verifier, calls } = verifierWith({ callResult: TRUE_WORD });
    setSmartAccountVerifierForTest(verifier);
    const budget = countingBudget();

    const result = await verifyWalletSignature({
      chain: CHAIN,
      address: SMART_ACCOUNT,
      message: MESSAGE,
      signature: WRAPPED_SIGNATURE,
      budget,
    });

    expect(result).toEqual({ address: SMART_ACCOUNT, kind: 'smart' });
    // Chain pinned first, then the validator call.
    expect(calls).toEqual(['eth_chainId', 'eth_call']);
    expect(budget.charges).toBe(1);
  });

  it('accepts a 65-byte signature that only the contract can validate', async () => {
    // A Safe with one owner produces exactly 65 bytes, but it does NOT recover
    // to the account's own address — only `isValidSignature` can say yes. The
    // relaxed gate must let this through to the chain instead of pre-rejecting.
    const owner = privateKeyToAccount(`0x${'44'.repeat(32)}`);
    const ownerSig = await owner.signMessage({ message: MESSAGE });

    const { verifier, calls } = verifierWith({ callResult: TRUE_WORD });
    setSmartAccountVerifierForTest(verifier);

    const result = await verifyWalletSignature({
      chain: CHAIN,
      address: SMART_ACCOUNT,
      message: MESSAGE,
      signature: ownerSig,
      budget: countingBudget(),
    });

    expect(result.kind).toBe('smart');
    expect(calls).toContain('eth_call');
  });

  it('rejects when the validator returns false, with the generic message', async () => {
    const { verifier } = verifierWith({ callResult: FALSE_WORD });
    setSmartAccountVerifierForTest(verifier);

    await expect(
      verifyWalletSignature({
        chain: CHAIN,
        address: SMART_ACCOUNT,
        message: MESSAGE,
        signature: WRAPPED_SIGNATURE,
        budget: countingBudget(),
      }),
    ).rejects.toMatchObject({ code: 'unauthorized', message: 'Signature verification failed' });
  });

  it('refuses when the endpoint is not the pinned chain', async () => {
    // Chain 1, not 4663. Asking a different network whether a signature is
    // valid is asking a different contract — possibly one the attacker chose.
    const { verifier } = verifierWith({ chainIdHex: '0x1' });
    setSmartAccountVerifierForTest(verifier);

    await expect(
      verifyWalletSignature({
        chain: CHAIN,
        address: SMART_ACCOUNT,
        message: MESSAGE,
        signature: WRAPPED_SIGNATURE,
        budget: countingBudget(),
      }),
    ).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'chain_id_mismatch' },
    });
  });

  it('answers 503, not 401, when the RPC is unreachable', async () => {
    // The distinction is load-bearing: 401 would tell an AA user their wallet
    // is broken when ours is. Every SIGNATURE failure mode still shares one
    // message; this is a dependency failure, not a signature failure.
    const { verifier } = verifierWith({ throwOn: 'eth_chainId' });
    setSmartAccountVerifierForTest(verifier);

    await expect(
      verifyWalletSignature({
        chain: CHAIN,
        address: SMART_ACCOUNT,
        message: MESSAGE,
        signature: WRAPPED_SIGNATURE,
        budget: countingBudget(),
      }),
    ).rejects.toMatchObject({ code: 'unavailable', details: { reason: 'chain_unreachable' } });
  });

  it('is refused entirely when smart-account login is switched off', async () => {
    setSmartAccountVerifierForTest(null); // AUTH_SMART_ACCOUNT_LOGIN=false
    const budget = countingBudget();

    await expect(
      verifyWalletSignature({
        chain: CHAIN,
        address: SMART_ACCOUNT,
        message: MESSAGE,
        signature: WRAPPED_SIGNATURE,
        budget,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(budget.charges).toBe(0);
  });

  it('will not verify a signature claimed for a different chain', async () => {
    const { verifier, calls } = verifierWith({ callResult: TRUE_WORD });
    setSmartAccountVerifierForTest(verifier);

    // `base` (8453) is an accepted identity namespace but is not the chain the
    // verifier is pinned to. The contract at this address on 4663 is a
    // different contract, or nothing.
    await expect(
      verifyWalletSignature({
        chain: 'base',
        address: SMART_ACCOUNT,
        message: MESSAGE,
        signature: WRAPPED_SIGNATURE,
        budget: countingBudget(),
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(calls).toEqual([]);
  });
});

describe('malformed input', () => {
  const SMART_ACCOUNT = '0x1234567890abcdef1234567890abcdef12345678';

  it('rejects a base58 signature on an EVM chain without spending the budget', async () => {
    const { verifier, calls } = verifierWith({});
    setSmartAccountVerifierForTest(verifier);
    const budget = countingBudget();

    await expect(
      verifyWalletSignature({
        chain: CHAIN,
        address: SMART_ACCOUNT,
        message: MESSAGE,
        // Passes the shared `zSignature` schema (base58 is legal for Solana)
        // but cannot be a contract signature, so it must not reach the chain.
        signature: '5VERYb58ButNotHexAtAllzzzzzzzzzzzzzzzzzzz',
        budget,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized', message: 'Signature verification failed' });
    expect(budget.charges).toBe(0);
    expect(calls).toEqual([]);
  });

  it('rejects a truncated hex signature with the same message as a wrong key', async () => {
    const { verifier } = verifierWith({ callResult: FALSE_WORD });
    setSmartAccountVerifierForTest(verifier);

    const truncated = verifyWalletSignature({
      chain: CHAIN,
      address: SMART_ACCOUNT,
      message: MESSAGE,
      signature: '0xdeadbeef',
      budget: countingBudget(),
    });
    await expect(truncated).rejects.toBeInstanceOf(AppError);
    await expect(truncated).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'Signature verification failed',
    });
  });

  it('rejects a valid signature over a DIFFERENT message', async () => {
    const account = privateKeyToAccount(`0x${'55'.repeat(32)}`);
    const signature = await account.signMessage({ message: 'some other message' });
    const { verifier } = verifierWith({ callResult: FALSE_WORD });
    setSmartAccountVerifierForTest(verifier);

    await expect(
      verifyWalletSignature({
        chain: CHAIN,
        address: account.address,
        message: MESSAGE,
        signature,
        budget: countingBudget(),
      }),
    ).rejects.toMatchObject({ code: 'unauthorized', message: 'Signature verification failed' });
  });
});

describe('Solana is unchanged', () => {
  it('rejects a bad ed25519 signature locally, with no chain access', async () => {
    const { verifier, calls } = verifierWith({});
    setSmartAccountVerifierForTest(verifier);

    await expect(
      verifyWalletSignature({
        chain: 'solana',
        address: '7Xk2QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQq4Rt',
        message: MESSAGE,
        signature: '3'.repeat(88),
        budget: countingBudget(),
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(calls).toEqual([]);
  });
});
