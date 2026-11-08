/**
 * server-35: a broadcast rejection must be classified correctly. 'nonce too low'
 * is NOT the same as 'already known' — it can mean a DIFFERENT transaction took
 * the nonce, which the caller has to disambiguate rather than call success.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmSender, classifyBroadcastError, NonceConsumedError } from '../chain/evmSender.js';
import type { ChainReader } from '../chain/types.js';

describe('classifyBroadcastError (server-35)', () => {
  it('treats exact-duplicate messages as success', () => {
    expect(classifyBroadcastError('already known')).toBe('duplicate');
    expect(classifyBroadcastError('known transaction: 0xabc')).toBe('duplicate');
    expect(classifyBroadcastError('already imported')).toBe('duplicate');
  });

  it('treats "nonce too low" as its OWN case, not a duplicate success', () => {
    expect(classifyBroadcastError('nonce too low')).toBe('nonce_too_low');
    expect(classifyBroadcastError('err: Nonce too low')).toBe('nonce_too_low');
  });

  it('rethrows anything else', () => {
    expect(classifyBroadcastError('insufficient funds for gas')).toBe('rethrow');
    expect(classifyBroadcastError('execution reverted')).toBe('rethrow');
  });
});

describe('NonceConsumedError', () => {
  it('carries the hash and nonce and is name-detectable across module copies', () => {
    const e = new NonceConsumedError('0xdead', 7);
    expect(e.name).toBe('NonceConsumedError');
    expect(e.txHash).toBe('0xdead');
    expect(e.nonce).toBe(7);
  });
});

describe('EvmSender.prepareTransfer guards (offline)', () => {
  const reader: ChainReader = {
    getTransaction: async () => null,
    getTransactionStatus: async () => ({ found: false, status: null, blockNumber: null }),
    getBlockNumber: async () => 0,
    getTransactionCount: async () => 0,
  };
  const sender = new EvmSender({
    submitRpcUrl: 'http://127.0.0.1:1',
    chainId: 4663,
    account: privateKeyToAccount(`0x${'1'.repeat(64)}`),
    token: `0x${'2'.repeat(40)}`,
    reader,
    gasLimit: 100_000n,
    feeBumpPercent: 150,
  });

  it('refuses a non-positive transfer before touching the network', async () => {
    await expect(
      sender.prepareTransfer({ to: `0x${'3'.repeat(40)}`, amountBase: 0n, nonce: 0 }),
    ).rejects.toThrow(/non-positive/);
  });
});
