/**
 * Process logger for code that runs outside a request (the settlement worker,
 * chain clients, boot). Request-scoped code uses `req.log`, which carries the
 * request id.
 *
 * Never log a secret, a keypair, or a full RPC parameter list containing
 * addresses at info level.
 */
import { createLogger, type Logger } from './shared.js';

let cached: Logger | null = null;

export function log(): Logger {
  if (!cached) {
    cached = createLogger({
      service: 'wager',
      level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
    });
  }
  return cached;
}

/** For tests: silence or capture output. */
export function setLoggerForTest(logger: Logger | null): void {
  cached = logger;
}
