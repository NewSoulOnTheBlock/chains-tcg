// src/api/http.ts
//
// The fetch wrapper every other module in `src/api/**` goes through.
//
// Responsibilities, all in one place so no call site has to remember them:
//
//   1. Prefix `API_BASE` (config.ts) — nobody else builds a URL.
//   2. Inject `Authorization: Bearer <accessToken>` when a session exists.
//   3. On 401: refresh ONCE, then replay. Concurrent 401s share one refresh.
//      If the refresh fails, clear the session and surface `SessionExpiredError`.
//   4. On 429: honour `Retry-After` with a bounded retry, and only for methods
//      that are safe to repeat.
//   5. Normalise every failure into `ApiError` (errors.ts).
//
// ─── IDS ARE STRINGS ────────────────────────────────────────────────────────
// `profileId`, deck ids, match ids and escrow ids are bigint-safe DECIMAL
// STRINGS (INTEGRATION.md §8.8). Never `parseInt` / `Number()` them: values
// above 2^53 silently lose precision and you will read or write the wrong row.
// Every id in this layer is typed `string`. Keep it that way.
//
// ─── WHY THE REFRESH MUST NOT LOOP ──────────────────────────────────────────
// Refresh tokens rotate, and presenting a spent one revokes the WHOLE FAMILY
// server-side (INTEGRATION.md §3). A naive "retry on 401" loop therefore does
// not degrade gracefully — it burns the family and logs the user out
// permanently. Hence: at most one refresh attempt per request, and at most one
// refresh in flight globally.

import { API_BASE } from './config.js';
import {
  ApiError,
  SessionExpiredError,
  toApiError,
  toNetworkError,
} from './errors.js';
import { clearSession, getSession, updateTokens } from './session.js';

/** How the request relates to the session. */
export type AuthMode =
  /** Attach the token; a 401 triggers refresh-and-replay. */
  | 'required'
  /** Attach the token if we have one; a 401 is returned to the caller as-is. */
  | 'optional'
  /** Never attach a token. Used by the auth endpoints themselves. */
  | 'none';

export interface RequestOptions<T = unknown> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON request body. Omitted entirely when `undefined`. */
  body?: unknown;
  /** Query params. `undefined` / `null` entries are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Defaults to `'required'`. */
  auth?: AuthMode;
  /** Abort support, e.g. from a React effect cleanup. */
  signal?: AbortSignal;
  /**
   * Abort the fetch after this many ms (combined with `signal`). Defaults to
   * `DEFAULT_TIMEOUT_MS`; pass `0` to disable (e.g. a deliberately long poll
   * that manages its own lifetime). A timeout surfaces as
   * `ApiError{code:'timeout', status:0}`, distinct from a caller abort.
   */
  timeoutMs?: number;
  /**
   * Optional runtime validator for a 2xx body. When present, the parsed JSON is
   * passed through it before being returned; a thrown/`false` result becomes
   * `ApiError{code:'invalid_response'}` instead of a `TypeError` surfacing far
   * from the fetch. Use hand-written guards (see `guards.ts`) on the
   * match/money/ranked routes — a shape drift there must not crash a caller.
   */
  parse?: (raw: unknown) => T;
  /**
   * Allow a bounded retry when the server answers 429.
   *
   * Defaults to `true` for methods HTTP defines as idempotent (GET, HEAD,
   * PUT, DELETE) and `false` for POST and PATCH. Opt a POST in ONLY when
   * repeating it is genuinely harmless — `POST /auth/nonce` mints a throwaway
   * challenge, so it qualifies; `POST /wager/escrows/:id/deposits` binds a
   * transaction hash to an escrow and must never be replayed blindly.
   */
  retryOn429?: boolean;
  /** Extra headers. `Authorization` here wins over the injected one. */
  headers?: Record<string, string>;
}

/** Methods HTTP defines as idempotent — safe to repeat after a 429. */
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** Bounded retry budget for 429s. */
const MAX_429_RETRIES = 2;
/** Refuse to sit on a request longer than this; surface the error instead. */
const MAX_RETRY_WAIT_MS = 10_000;
/** Used when a 429 arrives with no `Retry-After` header or body hint. */
const DEFAULT_RETRY_WAIT_MS = 1_000;
/** A fetch with no caller timeout is aborted after this long, as `code:'timeout'`. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** The single-flight refresh fetch gets its own, tighter bound. */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * An `AbortSignal` that fires after `ms`, or `undefined` for `ms <= 0`.
 *
 * Prefers the platform `AbortSignal.timeout` (Node 18+, every live browser) and
 * falls back to a controller for any environment that lacks it, so the test
 * runner and older runtimes behave identically.
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (ms <= 0) return undefined;
  try {
    const AS = globalThis.AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal };
    if (typeof AS?.timeout === 'function') return AS.timeout(ms);
  } catch {
    /* fall through to the manual controller */
  }
  const ac = new AbortController();
  setTimeout(() => ac.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  return ac.signal;
}

/** Combine abort signals into one, preferring the platform `AbortSignal.any`. */
function anySignal(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  const AS = globalThis.AbortSignal as typeof AbortSignal & { any?: (s: AbortSignal[]) => AbortSignal };
  if (typeof AS?.any === 'function') return AS.any(signals);
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ac.abort(s.reason); break; }
    s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

// ── Serialised refresh ──────────────────────────────────────────────────────
//
// One shared promise. Ten in-flight requests that all 401 will all await this
// same promise and therefore trigger exactly ONE `POST /auth/refresh`.

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Rotate the token pair. Resolves `true` on success, `false` if the session is
 * unrecoverable (in which case it has already been cleared).
 *
 * Exported for `auth.ts` to re-export; call it directly only if you know why.
 * Deliberately implemented here rather than in `auth.ts` so the single-flight
 * mutex and the retry logic that depends on it live in the same module.
 */
export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<boolean> => {
    try {
      const session = getSession();
      if (!session) return false;

      let res: Response;
      try {
        res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
          // Bound the one request every concurrent 401 blocks on — a hung
          // /auth/refresh otherwise wedges the whole app (client-api-04).
          signal: timeoutSignal(REFRESH_TIMEOUT_MS),
        });
      } catch {
        // Network blip, offline, DNS, or our own timeout. The refresh token was
        // NOT accepted, so the family is not at risk, and nothing here proves
        // the token is dead. Do NOT clear the session — a transient drop on
        // mobile must not force a fresh wallet signature (client-api-04). The
        // caller surfaces a network error and the user can retry.
        return false;
      }

      if (!res.ok) {
        // A real HTTP rejection: expired, already used, or family revoked. None
        // of those are recoverable without a new signature.
        clearSession();
        return false;
      }
      const data = (await res.json()) as { accessToken?: unknown; refreshToken?: unknown };
      if (typeof data.accessToken !== 'string' || typeof data.refreshToken !== 'string') {
        clearSession();
        return false;
      }
      // BOTH tokens are replaced. Keeping the old refresh token would revoke
      // the family the next time it was presented.
      updateTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      return true;
    } finally {
      // Cleared in `finally` so the NEXT 401 after this settles starts a fresh
      // attempt rather than reusing a stale resolved promise.
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** Test seam: is a refresh currently in flight? */
export function isRefreshing(): boolean {
  return refreshInFlight !== null;
}

// ── URL + body helpers ──────────────────────────────────────────────────────

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError({
      status: res.status,
      code: 'invalid_response',
      message: 'The server returned a response that was not valid JSON.',
      details: { snippet: text.slice(0, 200) },
    });
  }
}

/**
 * Run an optional caller-supplied validator over a parsed 2xx body.
 *
 * A validator that throws (or a guard that returns `false`, which we treat as a
 * throw) becomes an `ApiError{code:'invalid_response'}` so a shape drift on a
 * match/money/ranked route is a handled error at the fetch, not a
 * `TypeError: Cannot destructure` deep in a component (client-api-06).
 */
function applyParse<T>(raw: unknown, parse: ((raw: unknown) => T) | undefined, label: string, status: number): T {
  if (!parse) return raw as T;
  try {
    const out = parse(raw);
    if (out === false) throw new Error('response failed validation');
    return out;
  } catch (cause) {
    throw new ApiError({
      status,
      code: 'invalid_response',
      message: 'The server returned data in an unexpected shape.',
      details: { cause: cause instanceof Error ? cause.message : String(cause) },
      requestPath: label,
    });
  }
}

// ── The request function ────────────────────────────────────────────────────

/**
 * Perform an API request and return the parsed JSON body.
 *
 * Throws `ApiError` for every failure mode, including network failures
 * (`status: 0`) and unrecoverable auth (`SessionExpiredError`).
 */
export async function request<T>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const authMode = options.auth ?? 'required';
  const url = buildUrl(path, options.query);
  const label = `${method} ${path}`;

  const allowRetry = options.retryOn429 ?? IDEMPOTENT.has(method);

  let refreshAttempted = false;
  let rateLimitRetries = 0;

  // Loop is bounded: at most one refresh replay plus MAX_429_RETRIES waits.
  for (;;) {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...options.headers,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    // Remember which token this attempt used, so that if it 401s we can tell
    // "my token was stale and someone else has already refreshed" from "the
    // current token really is rejected".
    let tokenUsed: string | null = null;
    if (authMode !== 'none' && !('Authorization' in headers)) {
      tokenUsed = getSession()?.accessToken ?? null;
      if (tokenUsed) headers.Authorization = `Bearer ${tokenUsed}`;
    }

    // Bound every fetch so a stalled gateway cannot wedge the UI with a spinner
    // that never resolves (client-api-03). The caller's own signal still wins.
    const tSignal = timeoutSignal(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const fetchSignal = anySignal(
      [options.signal, tSignal].filter((s): s is AbortSignal => s !== undefined),
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: fetchSignal,
        // The API is a different origin and uses bearer tokens, not cookies.
        credentials: 'omit',
        mode: 'cors',
      });
    } catch (cause) {
      // Our timeout fired (and the caller did not abort): surface it distinctly
      // so the UI can say "timed out" rather than a generic network error.
      if (tSignal?.aborted && !options.signal?.aborted) {
        throw new ApiError({
          status: 0,
          code: 'timeout',
          message: 'The request timed out. Check your connection and try again.',
          details: { cause: cause instanceof Error ? cause.message : String(cause) },
          requestPath: label,
        });
      }
      throw toNetworkError(cause, label);
    }

    if (res.ok) return applyParse<T>(await parseBody(res), options.parse, label, res.status);

    // ── 401: refresh once, then replay ────────────────────────────────────
    if (res.status === 401 && authMode === 'required') {
      // Drain the body so the connection can be reused.
      const err = await toApiError(res, label);

      const currentToken = getSession()?.accessToken ?? null;

      // Someone else refreshed between us sending and this response arriving.
      // Replay with the new token; no refresh of our own, no budget consumed.
      if (currentToken && currentToken !== tokenUsed && !refreshAttempted) {
        continue;
      }

      if (!refreshAttempted && currentToken !== null) {
        refreshAttempted = true;
        // All concurrent 401s await the SAME promise → exactly one refresh.
        const ok = await refreshSession();
        if (ok) continue;
        // Refresh did not succeed. If it cleared the session, the token is
        // genuinely dead — surface SessionExpiredError and do NOT try again
        // (reuse revokes the whole family). If the session SURVIVED, the
        // refresh failed for a transient reason (network/timeout, which no
        // longer clears — client-api-04): that must not read as "expired", so
        // surface the original 401 and let the user retry with the session
        // still in place.
        if (getSession() === null) throw new SessionExpiredError(label);
        throw err;
      }

      // No session to begin with. Nothing to clear, and clearing would emit a
      // spurious sign-out that yanks a signed-out player off their screen
      // (client-api-27). Just report that auth was required.
      if (currentToken === null) {
        throw new SessionExpiredError(label);
      }
      throw err;
    }

    // ── 429: honour Retry-After, bounded ──────────────────────────────────
    if (res.status === 429 && allowRetry && rateLimitRetries < MAX_429_RETRIES) {
      // Parse the body ONCE via toApiError, which reads the delay from the
      // `Retry-After` header OR the body's `details.retryAfterSec` (the rate
      // limiter only puts it in the body — client-api-05). The resulting error
      // carries that same `retryAfter`, so if we give up it reaches the UI.
      const err = await toApiError(res, label);
      const waitMs = err.retryAfter !== null ? err.retryAfter * 1000 : DEFAULT_RETRY_WAIT_MS;
      if (waitMs <= MAX_RETRY_WAIT_MS) {
        rateLimitRetries += 1;
        await sleep(waitMs, options.signal);
        continue;
      }
      // Server wants us to wait longer than we are willing to block a UI for.
      throw err;
    }

    throw await toApiError(res, label);
  }
}

// ── Convenience verbs ───────────────────────────────────────────────────────

export const get = <T>(path: string, options?: Omit<RequestOptions<T>, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'GET' });

export const post = <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'POST', body });

export const put = <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'PUT', body });

export const patch = <T>(path: string, body?: unknown, options?: Omit<RequestOptions<T>, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'PATCH', body });

export const del = <T>(path: string, options?: Omit<RequestOptions<T>, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'DELETE' });
