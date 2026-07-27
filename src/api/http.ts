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
  parseRetryAfter,
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

export interface RequestOptions {
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
/** Used when a 429 arrives with no `Retry-After` header. */
const DEFAULT_RETRY_WAIT_MS = 1_000;

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
    const session = getSession();
    if (!session) return false;
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
      if (!res.ok) {
        // 401 here means the token was expired, already used, or its family
        // was revoked. None of those are recoverable without a new signature.
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
    } catch {
      // A network blip is not proof the token is dead — but we cannot
      // distinguish it here, and retrying is the thing that burns the family.
      // Fail closed: the user re-signs, which is recoverable. A retry storm is
      // not.
      clearSession();
      return false;
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

async function parseBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({
      status: res.status,
      code: 'invalid_response',
      message: 'The server returned a response that was not valid JSON.',
      details: { snippet: text.slice(0, 200) },
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
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
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

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
        // The API is a different origin and uses bearer tokens, not cookies.
        credentials: 'omit',
        mode: 'cors',
      });
    } catch (cause) {
      throw toNetworkError(cause, label);
    }

    if (res.ok) return parseBody<T>(res);

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
        // Refresh failed; the session is already cleared. Do NOT try again —
        // reuse of a refresh token revokes the whole family server-side.
        throw new SessionExpiredError(label);
      }

      // Either we already tried, or there was no session to begin with.
      if (currentToken === null) {
        clearSession();
        throw new SessionExpiredError(label);
      }
      throw err;
    }

    // ── 429: honour Retry-After, bounded ──────────────────────────────────
    if (res.status === 429 && allowRetry && rateLimitRetries < MAX_429_RETRIES) {
      const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
      // Consume the body before sleeping.
      await res.text().catch(() => '');
      const waitMs = retryAfter !== null ? retryAfter * 1000 : DEFAULT_RETRY_WAIT_MS;
      if (waitMs <= MAX_RETRY_WAIT_MS) {
        rateLimitRetries += 1;
        await sleep(waitMs, options.signal);
        continue;
      }
      // Server wants us to wait longer than we are willing to block a UI for.
      throw new ApiError({
        status: 429,
        code: 'rate_limited',
        message: `Rate limited. Try again in ${retryAfter ?? '?'} seconds.`,
        retryAfter,
        requestPath: label,
      });
    }

    throw await toApiError(res, label);
  }
}

// ── Convenience verbs ───────────────────────────────────────────────────────

export const get = <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'GET' });

export const post = <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'POST', body });

export const put = <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'PUT', body });

export const patch = <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'PATCH', body });

export const del = <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
  request<T>(path, { ...options, method: 'DELETE' });
