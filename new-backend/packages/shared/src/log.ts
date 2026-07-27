/**
 * Structured JSON logging. One line per event on stdout, so the container log
 * driver is the only transport we need.
 *
 * Every request gets an id (echoed to the client as `x-request-id`) and a child
 * logger bound to it, so a single failure can be traced across services.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
  readonly level: LogLevel;
}

/**
 * Field names whose values are replaced with `[redacted]` no matter where they
 * appear. Secrets have a habit of ending up inside logged objects.
 */
const REDACTED_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'secret',
  'jwt_secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'refresh_hash',
  'signature',
  'privatekey',
  'private_key',
  'seed',
  'mnemonic',
  'apikey',
  'api_key',
  'database_url',
  'redis_url',
]);

const MAX_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => redact(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: LogLevel, base: Record<string, unknown>, msg: string, fields?: Record<string, unknown>): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...base,
  };
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      record[k] = REDACTED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v);
    }
  }
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    line = JSON.stringify({ ts: record.ts, level, msg, log_error: 'unserialisable_fields' });
  }
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export interface CreateLoggerOptions {
  service: string;
  level?: LogLevel;
  base?: Record<string, unknown>;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const level = opts.level ?? ((process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info');
  const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;

  const build = (base: Record<string, unknown>): Logger => ({
    level,
    debug: (msg, fields) => threshold <= LEVEL_ORDER.debug && write('debug', base, msg, fields),
    info: (msg, fields) => threshold <= LEVEL_ORDER.info && write('info', base, msg, fields),
    warn: (msg, fields) => threshold <= LEVEL_ORDER.warn && write('warn', base, msg, fields),
    error: (msg, fields) => threshold <= LEVEL_ORDER.error && write('error', base, msg, fields),
    child: (fields) => build({ ...base, ...fields }),
  });

  return build({ service: opts.service, ...(opts.base ?? {}) });
}

/** A logger that swallows everything — for tests. */
export function nullLogger(): Logger {
  const noop = () => undefined;
  const l: Logger = {
    level: 'error',
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => l,
  };
  return l;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Assigns `req.id` and `req.log`, sets the `x-request-id` response header and
 * emits one `request_completed` line per request.
 *
 * An inbound `x-request-id` is honoured only if it is short and alphanumeric —
 * it is attacker-controlled, so it must never be able to inject into a log line
 * or a header.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.header('x-request-id');
    const id = inbound && REQUEST_ID_RE.test(inbound) ? inbound : randomUUID();

    req.id = id;
    req.log = logger.child({ request_id: id });
    res.setHeader('x-request-id', id);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      req.log.info('request_completed', {
        method: req.method,
        // req.path only — the query string can contain user data we do not want logged.
        path: req.path,
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        ip: req.ip,
        profile_id: req.auth?.profileId,
      });
    });

    next();
  };
}
