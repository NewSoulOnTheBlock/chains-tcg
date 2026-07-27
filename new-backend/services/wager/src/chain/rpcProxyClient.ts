/**
 * ChainReader over the rpc-proxy (H-5).
 *
 * This service holds no RPC credentials. Every read goes to `POST /rpc/evm` on
 * the proxy, which injects the upstream API key server-side. The optional
 * internal token buys a higher rate-limit tier; it is never sent to a browser
 * and it grants no extra methods, so a leaked one cannot broadcast anything.
 */
import { AppError } from '../platform/shared.js';
import { log } from '../platform/logger.js';
import { parseTransaction } from './evmParse.js';
import { toNumber } from './evmParse.js';
import type { ChainReader, ParsedTx, TxStatus } from './types.js';

export interface RpcProxyOptions {
  baseUrl: string;
  internalToken?: string;
  timeoutMs: number;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class RpcProxyClient implements ChainReader {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(opts: RpcProxyOptions) {
    this.url = `${opts.baseUrl.replace(/\/+$/, '')}/rpc/evm`;
    this.token = opts.internalToken ?? '';
    this.timeoutMs = opts.timeoutMs;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.token) headers['x-internal-token'] = this.token;

      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // The body is not echoed: it can contain addresses.
        log().warn('rpc_proxy_http_error', { method, status: res.status, ms: Date.now() - started });
        throw AppError.unavailable('Chain data is temporarily unavailable', {
          reason: 'rpc_proxy_unavailable',
        });
      }
      const body = (await res.json()) as JsonRpcResponse;
      if (body.error) {
        log().warn('rpc_upstream_error', { method, rpc_code: body.error.code });
        throw AppError.unavailable('Chain data is temporarily unavailable', { reason: 'rpc_error' });
      }
      log().debug('rpc_call', { method, ms: Date.now() - started });
      return body.result as T;
    } catch (err) {
      if (err instanceof AppError) throw err;
      const aborted = err instanceof Error && err.name === 'AbortError';
      log().warn('rpc_call_failed', { method, ms: Date.now() - started, aborted });
      throw AppError.unavailable('Chain data is temporarily unavailable', {
        reason: 'rpc_unreachable',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async getBlockNumber(): Promise<number> {
    return toNumber(await this.call<unknown>('eth_blockNumber', [])) ?? 0;
  }

  async getTransaction(hash: string): Promise<ParsedTx | null> {
    const [tx, receipt] = await Promise.all([
      this.call<unknown>('eth_getTransactionByHash', [hash]),
      this.call<unknown>('eth_getTransactionReceipt', [hash]),
    ]);
    if (!tx || !receipt) return null;

    const blockNumberHex = (receipt as { blockNumber?: unknown }).blockNumber;
    const block =
      typeof blockNumberHex === 'string'
        ? await this.call<unknown>('eth_getBlockByNumber', [blockNumberHex, false])
        : null;

    const head = await this.getBlockNumber();
    return parseTransaction(hash, { tx, receipt, block, headBlockNumber: head });
  }

  async getTransactionStatus(hash: string): Promise<TxStatus> {
    const receipt = await this.call<unknown>('eth_getTransactionReceipt', [hash]);
    if (!receipt || typeof receipt !== 'object') {
      return { found: false, status: null, blockNumber: null };
    }
    const r = receipt as Record<string, unknown>;
    const status = toNumber(r.status);
    return {
      found: true,
      status: status === 1 ? 'success' : 'reverted',
      blockNumber: toNumber(r.blockNumber),
    };
  }

  async getTransactionCount(address: string): Promise<number> {
    return toNumber(await this.call<unknown>('eth_getTransactionCount', [address, 'pending'])) ?? 0;
  }
}
