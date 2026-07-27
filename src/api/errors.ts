// src/api/errors.ts
//
// One parser for the one error envelope.
//
// Every error from every service AND from the gateway is (INTEGRATION.md §8.7):
//
//   { "error": { "code": "…", "message": "…", "details": { … } } }
//
// `details` is optional. Callers must NOT string-match on `message` — it is
// human-facing prose and may be reworded. Branch on `code`, or on the boolean
// helpers below.

/**
 * `error.code` is a CLOSED, TRANSPORT-LEVEL enum — these twelve values and
 * nothing else. It tells you the HTTP semantics, not the domain cause.
 *
 * The specific machine-readable cause travels in `details.reason` (see
 * `ApiError.reason`). This trips people up constantly: there is no
 * `code: "no_active_deck"`. That is
 * `code: "bad_request"` + `details.reason: "no_active_deck"`.
 */
export type ApiErrorCode =
  | 'bad_request'            // 400
  | 'unauthorized'           // 401
  | 'forbidden'              // 403
  | 'not_found'              // 404
  | 'method_not_allowed'     // 405
  | 'conflict'               // 409
  | 'payload_too_large'      // 413
  | 'unsupported_media_type' // 415
  | 'unprocessable'          // 422
  | 'rate_limited'           // 429
  | 'internal'               // 500
  | 'unavailable'            // 503
  // Client-side synthetics from this layer (never sent by the server).
  | 'network_error'
  | 'aborted'
  | 'invalid_response'
  | 'session_expired'
  // Forward-compatible: do not let a new server value break the build.
  | (string & {});

/**
 * Values seen in `details.reason`. Branch on these for domain behaviour.
 * Not exhaustive — treat unknown values as a generic failure.
 */
export type ApiReason =
  // profile / decks
  | 'invalid_deck'
  | 'deck_name_taken'
  | 'display_name_taken'
  | 'avatar_too_long' | 'avatar_invalid' | 'avatar_scheme'
  | 'avatar_credentials' | 'avatar_host'
  // game
  | 'no_active_deck'
  | 'invalid_active_deck'
  | 'self_challenge'
  | 'too_many_open_matches'
  | 'match_not_open'
  | 'already_seated'
  | 'match_incomplete'
  | 'setup_rejected'
  // wager
  | 'unknown_stake_tier'
  | 'match_not_found'
  | 'escrow_not_found'
  | 'not_a_participant'
  | 'match_not_joinable'
  | 'stake_mismatch'
  | 'escrow_closed'
  | 'seat_already_funded'
  | 'signature_already_used'
  | (string & {});

/** Shape of the JSON body. Exported so tests and mocks can build one. */
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * A single per-field or per-rule problem inside `details.issues`.
 *
 * Two producers use this array, with slightly different fields:
 *  - request-body validation (zod): `{ path, message, code }`
 *  - deck legality (`validateDeck`): `{ code, message }` — no `path`
 */
export interface ApiIssue {
  /** Dotted path to the offending field. Absent for deck-legality issues. */
  path?: string;
  message: string;
  code?: string;
}

/**
 * The single error type thrown by everything in `src/api/**`.
 *
 * Network failures and non-JSON responses are also normalised into this type
 * so a caller only ever has to `catch (e) { if (e instanceof ApiError) … }`.
 */
export class ApiError extends Error {
  /** HTTP status. `0` means the request never reached the server. */
  readonly status: number;
  /** Machine-readable code from the envelope. */
  readonly code: ApiErrorCode;
  /** Free-form structured extras. Never assume a shape without checking. */
  readonly details: Record<string, unknown>;
  /** Seconds to wait, parsed from `Retry-After` on a 429. `null` otherwise. */
  readonly retryAfter: number | null;
  /** Method + path, for logging. */
  readonly requestPath: string;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryAfter?: number | null;
    requestPath?: string;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? {};
    this.retryAfter = init.retryAfter ?? null;
    this.requestPath = init.requestPath ?? '';
    // Required for `instanceof` to work when targeting ES5-ish output.
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  // ── Branch on these, not on strings ─────────────────────────────────────

  /**
   * The request was rejected for lack of a valid identity.
   *
   * `http.ts` handles this internally by refreshing once; if an `ApiError`
   * with `isAuthError` reaches a caller, the refresh already failed and the
   * session has been cleared — the user must sign in again.
   */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** Authenticated, but not allowed. Do not retry, do not re-sign. */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /**
   * Rate limited. `retryAfter` is the server's own hint in seconds when it
   * sent a `Retry-After` header; `http.ts` already honoured it up to its
   * bounded retry budget, so seeing this means the budget was exhausted.
   */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** The resource does not exist — or the caller is not entitled to know. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** A uniqueness/state conflict, e.g. a replayed deposit signature. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  /** Request body or params failed validation. Check `issues`. */
  get isValidationError(): boolean {
    return this.status === 400;
  }

  /**
   * The domain cause from `details.reason`, or `null`.
   *
   * THIS is what you branch on for behaviour, not `code`:
   *
   *   if (err.reason === 'no_active_deck') showDeckBuilder();
   */
  get reason(): ApiReason | null {
    const r = this.details.reason;
    return typeof r === 'string' ? r : null;
  }

  /** `true` when `details.reason` matches any of the given values. */
  hasReason(...reasons: ApiReason[]): boolean {
    const r = this.reason;
    return r !== null && reasons.includes(r);
  }

  /**
   * The server's own hint that repeating this request may succeed
   * (`details.retryable`). Deposit verification sets it: a transaction that is
   * merely unconfirmed is retryable, one sent by the wrong address is not.
   */
  get isRetryable(): boolean {
    return this.details.retryable === true;
  }

  /** The request never reached the server (offline, DNS, CORS, abort). */
  get isNetworkError(): boolean {
    return this.status === 0;
  }

  /** Server-side fault; retrying later may work. */
  get isServerError(): boolean {
    return this.status >= 500;
  }

  /**
   * Per-issue problems from `details.issues`, if the server sent any.
   * Deck legality failures and body-validation failures both populate this.
   */
  get issues(): ApiIssue[] {
    const raw = this.details.issues;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const o = entry as Record<string, unknown>;
      const message = typeof o.message === 'string' ? o.message : null;
      if (message === null) return [];
      const issue: ApiIssue = { message };
      if (typeof o.path === 'string') issue.path = o.path;
      if (typeof o.code === 'string') issue.code = o.code;
      return [issue];
    });
  }

  /** One line suitable for a toast. */
  toString(): string {
    return `ApiError ${this.status} ${this.code}: ${this.message}`;
  }
}

/**
 * Thrown (well, surfaced via `onSessionChange`) when a 401 could not be
 * recovered by refreshing. Distinct from a plain 401 so the UI can tell
 * "your token was stale, we fixed it" from "you must sign the message again".
 *
 * `http.ts` clears the session before raising this.
 */
export class SessionExpiredError extends ApiError {
  constructor(requestPath = '') {
    super({
      status: 401,
      code: 'session_expired',
      message: 'Your session has expired. Please sign in with your wallet again.',
      requestPath,
    });
    this.name = 'SessionExpiredError';
    Object.setPrototypeOf(this, SessionExpiredError.prototype);
  }
}

/** Parse `Retry-After`. Supports both the delta-seconds and HTTP-date forms. */
export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.ceil((when - Date.now()) / 1000));
}

/** Narrow an unknown value to the error envelope. */
function isEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (!value || typeof value !== 'object') return false;
  const err = (value as { error?: unknown }).error;
  if (!err || typeof err !== 'object') return false;
  const o = err as Record<string, unknown>;
  return typeof o.code === 'string' && typeof o.message === 'string';
}

/**
 * Turn a non-OK `Response` into an `ApiError`.
 *
 * Consumes the body, so call it exactly once per response. Tolerates a body
 * that is empty, is not JSON, or is JSON in some other shape — a 502 from an
 * infrastructure layer in front of the gateway will not be JSON at all, and
 * that must not crash the client.
 */
export async function toApiError(res: Response, requestPath = ''): Promise<ApiError> {
  const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));

  let body: unknown = null;
  try {
    const text = await res.text();
    if (text) body = JSON.parse(text) as unknown;
  } catch {
    // Non-JSON or unreadable body — fall through to the generic mapping.
  }

  if (isEnvelope(body)) {
    const { code, message } = body.error;
    // `details` is typed `unknown` server-side; only keep it if it is an object.
    const details =
      body.error.details && typeof body.error.details === 'object' && !Array.isArray(body.error.details)
        ? (body.error.details as Record<string, unknown>)
        : undefined;
    // The rate limiter also puts the delay in the body as `retryAfterSec`;
    // prefer the header, fall back to the body.
    const fromBody = typeof details?.retryAfterSec === 'number' ? details.retryAfterSec : null;
    return new ApiError({
      status: res.status,
      code,
      message,
      details,
      retryAfter: retryAfter ?? fromBody,
      requestPath,
    });
  }

  return new ApiError({
    status: res.status,
    code: fallbackCodeForStatus(res.status),
    message: res.statusText || `Request failed with status ${res.status}`,
    retryAfter,
    requestPath,
  });
}

/** Best-guess code when the response carried no envelope. */
function fallbackCodeForStatus(status: number): string {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthorized';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 413: return 'payload_too_large';
    case 429: return 'rate_limited';
    default: return status >= 500 ? 'internal' : 'http_error';
  }
}

/** Wrap a thrown fetch/network failure as an `ApiError` with status 0. */
export function toNetworkError(cause: unknown, requestPath = ''): ApiError {
  const message =
    cause instanceof Error && cause.name === 'AbortError'
      ? 'The request was cancelled.'
      : 'Could not reach the server. Check your connection and try again.';
  return new ApiError({
    status: 0,
    code: cause instanceof Error && cause.name === 'AbortError' ? 'aborted' : 'network_error',
    message,
    details: { cause: cause instanceof Error ? cause.message : String(cause) },
    requestPath,
  });
}
