/**
 * One error envelope for the entire backend.
 *
 *     { "error": { "code": "unauthorized", "message": "...", "details": { ... } } }
 *
 * Nothing else is ever sent to a client on an error path. In particular the
 * handler below NEVER serialises a stack trace, a SQL string, a driver error
 * message or a constraint body — those go to the structured log only.
 */
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import type { Logger } from './log.js';

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'unprocessable'
  | 'rate_limited'
  | 'internal'
  | 'unavailable';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  unprocessable: 422,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

/**
 * The only error type services should throw deliberately. Anything else that
 * reaches the handler is treated as an unexpected internal fault and is
 * flattened to a generic 500 before it reaches the client.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  /** Marks this error's message as safe to show a client. */
  readonly expose = true;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }

  toEnvelope(): ErrorEnvelope {
    const error: ErrorEnvelope['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }

  static badRequest(message = 'Bad request', details?: unknown) {
    return new AppError('bad_request', message, details);
  }
  static unauthorized(message = 'Authentication required', details?: unknown) {
    return new AppError('unauthorized', message, details);
  }
  static forbidden(message = 'Forbidden', details?: unknown) {
    return new AppError('forbidden', message, details);
  }
  static notFound(message = 'Not found', details?: unknown) {
    return new AppError('not_found', message, details);
  }
  static conflict(message = 'Conflict', details?: unknown) {
    return new AppError('conflict', message, details);
  }
  static unprocessable(message = 'Unprocessable entity', details?: unknown) {
    return new AppError('unprocessable', message, details);
  }
  static rateLimited(message = 'Too many requests', details?: unknown) {
    return new AppError('rate_limited', message, details);
  }
  static payloadTooLarge(message = 'Payload too large', details?: unknown) {
    return new AppError('payload_too_large', message, details);
  }
  static internal(message = 'Internal server error', details?: unknown) {
    return new AppError('internal', message, details);
  }
  static unavailable(message = 'Service unavailable', details?: unknown) {
    return new AppError('unavailable', message, details);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Build the standard envelope for any code/message pair. */
export function errorEnvelope(code: ErrorCode, message: string, details?: unknown): ErrorEnvelope {
  const error: ErrorEnvelope['error'] = { code, message };
  if (details !== undefined) error.details = details;
  return { error };
}

/** PostgreSQL SQLSTATEs we translate into client-safe errors. */
const PG_SQLSTATE: Record<string, { code: ErrorCode; message: string }> = {
  '23505': { code: 'conflict', message: 'Resource already exists' },
  '23503': { code: 'bad_request', message: 'Referenced resource does not exist' },
  '23514': { code: 'bad_request', message: 'Value violates a constraint' },
  '23502': { code: 'bad_request', message: 'A required field is missing' },
  '22P02': { code: 'bad_request', message: 'Malformed value' },
  '40001': { code: 'conflict', message: 'Concurrent update, please retry' },
  '40P01': { code: 'conflict', message: 'Concurrent update, please retry' },
  '57014': { code: 'unavailable', message: 'Statement timed out' },
};

/** Extract the SQLSTATE from a pg driver error without trusting its shape. */
export function pgErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/**
 * Translate a database error into a client-safe AppError. The original error is
 * kept out of the result entirely — callers should log it separately.
 */
export function fromDatabaseError(err: unknown): AppError | undefined {
  const sqlstate = pgErrorCode(err);
  if (!sqlstate) return undefined;
  const mapped = PG_SQLSTATE[sqlstate];
  if (!mapped) return undefined;
  return new AppError(mapped.code, mapped.message);
}

/** Body-parser / express errors that carry a usable status but an unsafe message. */
function fromExpressError(err: unknown): AppError | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { type?: string; status?: number; statusCode?: number };
  const status = e.status ?? e.statusCode;
  if (e.type === 'entity.too.large' || status === 413) {
    return AppError.payloadTooLarge('Request body exceeds the maximum allowed size');
  }
  if (e.type === 'entity.parse.failed' || (status === 400 && e.type === 'entity.parse.failed')) {
    return AppError.badRequest('Request body is not valid JSON');
  }
  if (e.type === 'encoding.unsupported' || status === 415) {
    return new AppError('unsupported_media_type', 'Unsupported content type');
  }
  return undefined;
}

function sendEnvelope(res: Response, status: number, envelope: ErrorEnvelope): void {
  if (res.headersSent) return;
  res.status(status).type('application/json').send(JSON.stringify(envelope));
}

/** 404 fallthrough. Register after every route, before `errorHandler`. */
export function notFoundHandler(): RequestHandler {
  return (req: Request, res: Response) => {
    sendEnvelope(res, 404, errorEnvelope('not_found', 'Route not found'));
  };
}

/**
 * Terminal error middleware. Register LAST.
 *
 * Client sees: the AppError code/message, or a flat `internal` for anything
 * unexpected. Server log sees: the real message, the stack, the SQLSTATE.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const log = (req as Request).log ?? logger;

    let appError: AppError | undefined;
    if (isAppError(err)) {
      appError = err;
    } else {
      appError = fromExpressError(err) ?? fromDatabaseError(err);
    }

    const unexpected = !isAppError(err);
    const status = appError?.status ?? 500;

    // Everything the client never sees goes here.
    const detail: Record<string, unknown> = {
      status,
      code: appError?.code ?? 'internal',
      err_name: err instanceof Error ? err.name : typeof err,
      err_message: err instanceof Error ? err.message : String(err),
    };
    const sqlstate = pgErrorCode(err);
    if (sqlstate) detail.sqlstate = sqlstate;
    if (err instanceof Error && err.stack) detail.stack = err.stack;

    if (status >= 500) log.error('request_failed', detail);
    else if (unexpected) log.warn('request_failed', detail);
    else log.info('request_rejected', { status, code: appError?.code });

    if (appError && !unexpected) {
      sendEnvelope(res, appError.status, appError.toEnvelope());
      return;
    }
    if (appError) {
      // Mapped from a driver/framework error: message is one of ours, safe.
      sendEnvelope(res, appError.status, appError.toEnvelope());
      return;
    }
    sendEnvelope(res, 500, errorEnvelope('internal', 'Internal server error'));
  };
}

/**
 * Wrap an async handler so a rejected promise reaches `errorHandler`.
 * Express 5 forwards rejections automatically; this stays for Express 4
 * compatibility and for explicitness.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: (err?: unknown) => void) => unknown,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
