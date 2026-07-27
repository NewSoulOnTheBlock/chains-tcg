/**
 * The proxy's three safety properties, tested without a network:
 *   1. the allowlist cannot be talked into a mutation,
 *   2. nothing that can change is ever cached,
 *   3. an unhealthy upstream fails fast instead of pinning connections.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPolicy,
  checkMethod,
  isHardDenied,
  DEFAULT_ALLOWED_METHODS,
  EXPLICITLY_DENIED,
} from '../allowlist.js';
import { cacheKey, isCacheableResult, ttlFor } from '../cache.js';
import { CircuitBreaker } from '../breaker.js';
import { upstreamHost, parseEnv } from '../config.js';

const TTLS = { receipt: 30, transaction: 30, block: 30, chainId: 3_600 };

describe('method allowlist (H-5)', () => {
  const policy = buildPolicy();

  it('allows the read-only methods the app actually needs', () => {
    for (const method of [
      'eth_blockNumber',
      'eth_call',
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
      'eth_getTransactionCount',
      'eth_getLogs',
      'eth_getBlockByNumber',
      'eth_chainId',
    ]) {
      expect(checkMethod(policy, method)).toEqual({ ok: true });
    }
  });

  it('NEVER allows broadcasting — the whole point of the proxy', () => {
    expect(checkMethod(policy, 'eth_sendRawTransaction')).toEqual({ ok: false, reason: 'denied' });
    expect(checkMethod(policy, 'eth_sendTransaction')).toEqual({ ok: false, reason: 'denied' });
  });

  it('never allows a signing oracle', () => {
    for (const method of ['eth_sign', 'eth_signTransaction', 'personal_sign', 'eth_signTypedData_v4']) {
      expect(checkMethod(policy, method)).toEqual({ ok: false, reason: 'denied' });
    }
  });

  it('denies whole administrative namespaces by prefix, not by enumeration', () => {
    for (const method of [
      'admin_nodeInfo',
      'debug_traceTransaction',
      'txpool_content',
      'miner_start',
      'engine_forkchoiceUpdatedV1',
      'personal_listAccounts',
    ]) {
      expect(isHardDenied(method)).toBe(true);
      expect(checkMethod(policy, method)).toEqual({ ok: false, reason: 'denied' });
    }
  });

  it('refuses an unknown method rather than forwarding it', () => {
    expect(checkMethod(policy, 'eth_someFutureMethod')).toEqual({ ok: false, reason: 'not_allowed' });
  });

  it('refuses malformed method names', () => {
    expect(checkMethod(policy, '')).toEqual({ ok: false, reason: 'malformed' });
    expect(checkMethod(policy, 42)).toEqual({ ok: false, reason: 'malformed' });
    expect(checkMethod(policy, 'x'.repeat(200))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('lets an operator narrow the list', () => {
    const narrow = buildPolicy(['eth_blockNumber']);
    expect(checkMethod(narrow, 'eth_blockNumber')).toEqual({ ok: true });
    expect(checkMethod(narrow, 'eth_call')).toEqual({ ok: false, reason: 'not_allowed' });
  });

  it('does NOT let an operator widen it into a denied method', () => {
    // A configuration mistake must not be able to open a broadcast path.
    const misconfigured = buildPolicy(['eth_blockNumber', 'eth_sendRawTransaction']);
    expect(checkMethod(misconfigured, 'eth_sendRawTransaction')).toEqual({
      ok: false,
      reason: 'denied',
    });
  });

  it('has no overlap between the default allowlist and the denylist', () => {
    for (const method of DEFAULT_ALLOWED_METHODS) {
      expect(EXPLICITLY_DENIED).not.toContain(method);
      expect(isHardDenied(method)).toBe(false);
    }
  });
});

describe('cache policy', () => {
  it('caches receipts and mined transactions', () => {
    expect(ttlFor('eth_getTransactionReceipt', ['0xabc'], TTLS)).toBe(30);
    expect(ttlFor('eth_getTransactionByHash', ['0xabc'], TTLS)).toBe(30);
  });

  it('never caches a moving block tag', () => {
    expect(ttlFor('eth_getBlockByNumber', ['latest', false], TTLS)).toBeNull();
    expect(ttlFor('eth_getBlockByNumber', ['pending', false], TTLS)).toBeNull();
    expect(ttlFor('eth_getBlockByNumber', ['finalized', false], TTLS)).toBeNull();
    expect(ttlFor('eth_getBlockByNumber', ['0x1f4', false], TTLS)).toBe(30);
  });

  it('never caches balances, calls or block height', () => {
    for (const method of ['eth_getBalance', 'eth_call', 'eth_blockNumber', 'eth_getLogs', 'eth_gasPrice']) {
      expect(ttlFor(method, [], TTLS)).toBeNull();
    }
  });

  it('never caches "not mined yet"', () => {
    // A null receipt means the transaction has not landed. Remembering that
    // would make the wager service's reconciliation loop blind.
    expect(isCacheableResult('eth_getTransactionReceipt', null)).toBe(false);
    expect(isCacheableResult('eth_getTransactionByHash', { blockNumber: null })).toBe(false);
    expect(isCacheableResult('eth_getTransactionByHash', { blockNumber: '0x1' })).toBe(true);
  });

  it('keys on the exact params, so two questions never share an answer', () => {
    const a = cacheKey('host', 'eth_getTransactionReceipt', ['0xaaa']);
    const b = cacheKey('host', 'eth_getTransactionReceipt', ['0xbbb']);
    expect(a).not.toBe(b);
    expect(cacheKey('host', 'eth_getTransactionReceipt', ['0xaaa'])).toBe(a);
  });

  it('keys on the upstream too, so a chain switch cannot serve stale answers', () => {
    expect(cacheKey('mainnet', 'eth_chainId', [])).not.toBe(cacheKey('sepolia', 'eth_chainId', []));
  });
});

describe('circuit breaker', () => {
  function makeBreaker(): { breaker: CircuitBreaker; advance: (ms: number) => void } {
    let clock = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 1_000,
      now: () => clock,
    });
    return { breaker, advance: (ms: number) => (clock += ms) };
  }

  it('stays closed while the upstream is healthy', () => {
    const { breaker } = makeBreaker();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('opens after the failure threshold and refuses calls immediately', () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('lets exactly ONE probe through after the cooldown', () => {
    const { breaker, advance } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();
    advance(1_000);
    expect(breaker.state).toBe('half-open');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('closes again when the probe succeeds', () => {
    const { breaker, advance } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();
    advance(1_000);
    breaker.tryAcquire();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
  });

  it('re-opens for a full cooldown when the probe fails', () => {
    const { breaker, advance } = makeBreaker();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();
    advance(1_000);
    breaker.tryAcquire();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    advance(999);
    expect(breaker.state).toBe('open');
    advance(1);
    expect(breaker.state).toBe('half-open');
  });
});

describe('config', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'x'.repeat(48),
    EVM_RPC_URL: 'https://rpc.example.com/v2/SUPER-SECRET-KEY',
  };

  it('reduces the credentialed upstream URL to a bare host for logs', () => {
    // The API key lives in the path or query; only the host may be logged.
    expect(upstreamHost(base.EVM_RPC_URL)).toBe('rpc.example.com');
  });

  it('refuses to start without an upstream URL', () => {
    const { EVM_RPC_URL: _omitted, ...withoutUpstream } = base;
    expect(() => parseEnv(withoutUpstream)).toThrow(/EVM_RPC_URL/);
  });

  it('defaults to no internal tier when no token is configured', () => {
    expect(parseEnv(base).RPC_INTERNAL_TOKEN).toBe('');
  });
});
