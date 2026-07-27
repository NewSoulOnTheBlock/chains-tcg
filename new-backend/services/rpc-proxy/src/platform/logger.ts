/**
 * Process logger for code outside a request. Request-scoped code uses
 * `req.log`, which carries the request id.
 *
 * NOTHING in this service logs full JSON-RPC params at info level: an
 * `eth_getBalance` param list is a wallet address, and an access log full of
 * addresses is a deanonymisation dataset (H-2). Only the method, latency and
 * outcome are logged at info; a redacted param SHAPE is available at debug.
 */
import { createLogger, type Logger } from './shared.js';

let cached: Logger | null = null;

export function log(): Logger {
  if (!cached) {
    cached = createLogger({
      service: 'rpc-proxy',
      level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
    });
  }
  return cached;
}

export function setLoggerForTest(logger: Logger | null): void {
  cached = logger;
}
