/**
 * The upstream JSON-RPC client.
 *
 * Everything that touches the credentialed URL lives here:
 *  - the URL is never returned, logged, or included in an error,
 *  - a timeout is always set, so a hanging upstream cannot pin a connection,
 *  - the circuit breaker fails fast while the upstream is unhealthy.
 */
import { CircuitBreaker } from '../breaker.js';
import { log } from '../platform/logger.js';

export interface UpstreamOptions {
  url: string;
  /** Host only, for logs. */
  host: string;
  timeoutMs: number;
  breaker: CircuitBreaker;
}

export type UpstreamOutcome =
  | { kind: 'result'; result: unknown }
  | { kind: 'rpc_error'; code: number; message: string }
  | { kind: 'unavailable'; reason: 'breaker_open' | 'timeout' | 'network' | 'bad_gateway' };

export class UpstreamClient {
  constructor(private readonly options: UpstreamOptions) {}

  get breakerState(): string {
    return this.options.breaker.state;
  }

  async call(method: string, params: readonly unknown[], requestId: number): Promise<UpstreamOutcome> {
    if (!this.options.breaker.tryAcquire()) {
      log().warn('upstream_breaker_open', { method, host: this.options.host });
      return { kind: 'unavailable', reason: 'breaker_open' };
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const res = await fetch(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // 4xx/5xx from the provider. Treat 429 and 5xx as breaker failures;
        // a 400 is our own malformed request and should not trip it.
        if (res.status >= 500 || res.status === 429) this.options.breaker.recordFailure();
        else this.options.breaker.recordSuccess();
        log().warn('upstream_http_error', {
          method,
          host: this.options.host,
          status: res.status,
          ms: Date.now() - started,
        });
        return { kind: 'unavailable', reason: 'bad_gateway' };
      }

      const body = (await res.json()) as {
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      this.options.breaker.recordSuccess();

      if (body.error) {
        // A JSON-RPC-level error is a valid answer from a healthy node
        // (bad params, execution reverted), so it does not trip the breaker.
        return {
          kind: 'rpc_error',
          code: typeof body.error.code === 'number' ? body.error.code : -32_000,
          message: typeof body.error.message === 'string' ? body.error.message : 'upstream error',
        };
      }

      log().debug('upstream_ok', { method, host: this.options.host, ms: Date.now() - started });
      return { kind: 'result', result: body.result ?? null };
    } catch (err) {
      this.options.breaker.recordFailure();
      const aborted = err instanceof Error && err.name === 'AbortError';
      log().warn('upstream_failed', {
        method,
        host: this.options.host,
        ms: Date.now() - started,
        aborted,
      });
      return { kind: 'unavailable', reason: aborted ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
}
