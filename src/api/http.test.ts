// src/api/http.test.ts
//
// The security-sensitive behaviour of the fetch wrapper: ONE refresh in flight
// for a storm of concurrent 401s, a failed refresh that clears the session
// exactly once, a 401 replay that skips the refresh when the token already
// rotated, and a 429 budget that never retries a POST. These are the paths that
// log every user out if they regress, and nothing exercised them before
// (client-api-07). `isRefreshing()` is the exported test seam.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, isRefreshing } from './http';
import { setSession, getSession, clearSession, type Session } from './session';
import { ApiError, SessionExpiredError } from './errors';

// ── A tiny Response stand-in ────────────────────────────────────────────────

function res(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

const SESSION: Session = {
  accessToken: 'a1',
  refreshToken: 'r1',
  address: '0xabc',
  chain: 'robinhood',
};

/** Which `Authorization` token a mocked call carried, or null. */
function bearerOf(init?: RequestInit): string | null {
  const h = (init?.headers ?? {}) as Record<string, string>;
  const v = h.Authorization ?? h.authorization;
  return v ? v.replace(/^Bearer\s+/, '') : null;
}

beforeEach(() => {
  clearSession();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearSession();
});

describe('concurrent 401s share one refresh', () => {
  it('fires exactly one /auth/refresh for ten parallel 401s, then replays', async () => {
    setSession({ ...SESSION });
    let refreshCalls = 0;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return res(200, { accessToken: 'a2', refreshToken: 'r2' });
      }
      // Protected route: stale token 401s, rotated token succeeds.
      return bearerOf(init) === 'a2' ? res(200, { ok: true }) : res(401, { error: { code: 'unauthorized', message: 'no' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => request<{ ok: boolean }>('/protected')),
    );

    expect(refreshCalls).toBe(1);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(getSession()?.accessToken).toBe('a2');
    expect(isRefreshing()).toBe(false);
  });
});

describe('a failed refresh clears the session once and expires', () => {
  it('throws SessionExpiredError and clears the session when /auth/refresh 401s', async () => {
    setSession({ ...SESSION });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) return res(401, { error: { code: 'unauthorized', message: 'dead' } });
      return res(401, { error: { code: 'unauthorized', message: 'no' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('/protected')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(getSession()).toBeNull();
    expect(isRefreshing()).toBe(false);
  });

  it('does NOT clear the session when the refresh fails on a pure network error', async () => {
    setSession({ ...SESSION });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) throw new TypeError('Failed to fetch');
      return res(401, { error: { code: 'unauthorized', message: 'no' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // A transient refresh failure surfaces the 401 but must leave the session
    // intact so a retry works without a fresh wallet signature (client-api-04).
    await expect(request('/protected')).rejects.toBeInstanceOf(ApiError);
    expect(getSession()?.refreshToken).toBe('r1');
  });
});

describe('401 replay without a refresh when the token already rotated', () => {
  it('replays with the new token and never calls /auth/refresh', async () => {
    setSession({ ...SESSION });
    let refreshCalls = 0;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/refresh')) { refreshCalls += 1; return res(200, { accessToken: 'a9', refreshToken: 'r9' }); }
      const token = bearerOf(init);
      if (token === 'a1') {
        // Simulate another in-flight request having already rotated the pair by
        // the time this 401 is handled.
        setSession({ ...SESSION, accessToken: 'a2', refreshToken: 'r2' });
        return res(401, { error: { code: 'unauthorized', message: 'stale' } });
      }
      return res(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await request<{ ok: boolean }>('/protected');
    expect(out.ok).toBe(true);
    expect(refreshCalls).toBe(0);
  });
});

describe('429 budget', () => {
  it('retries an idempotent GET after a 429 and then succeeds', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      return n === 1 ? res(429, { error: { code: 'rate_limited', message: 'slow' } }, { 'Retry-After': '0' }) : res(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await request<{ ok: boolean }>('/list', { auth: 'none' });
    expect(out.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a POST on 429, and surfaces the body retryAfterSec', async () => {
    const fetchMock = vi.fn(async () =>
      res(429, { error: { code: 'rate_limited', message: 'slow', details: { retryAfterSec: 30 } } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = await request('/do', { method: 'POST', auth: 'none' }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    // The delay lives only in the body here; toApiError must still expose it so
    // the UI can tell the player how long to wait (client-api-05).
    expect((err as ApiError).retryAfter).toBe(30);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('invalid_response from the parse validator', () => {
  it('turns a shape mismatch into an ApiError instead of a late TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { wrong: true })));
    const err = await request('/x', {
      auth: 'none',
      parse: (raw: unknown) => {
        if (!(raw && typeof raw === 'object' && 'right' in raw)) throw new Error('missing right');
        return raw;
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('invalid_response');
  });
});
