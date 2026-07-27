/**
 * The route contract, asserted against the registry the shared `route()` helper
 * builds at registration time.
 *
 * The single most important assertion in this file is the negative one: THERE IS
 * NO ROUTE THAT ACCEPTS A MATCH OUTCOME. The legacy server had
 * `POST /api/ranked/match/result`, unauthenticated, taking `player0`, `player1`
 * and `winner` out of a request body — with a prize attached to rank 1, that one
 * route is the entire product. Porting it would have been the worst possible
 * outcome of this work, so the absence is pinned here rather than left to a
 * reviewer noticing.
 *
 * The positive assertions exist because the client is coded against this exact
 * table. A path or an auth level changing silently is a client bug that shows up
 * as a 404 in somebody else's console.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const hoistedEnv = vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://chains:unused@127.0.0.1:5432/chains';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long';
  process.env.MATCH_RESULT_HMAC_SECRET ??= 'test-hmac-secret-at-least-32-characters-long';
  process.env.LOG_LEVEL ??= 'error';
  return true;
});
void hoistedEnv;

vi.mock('../bgio/store.js', () => ({
  store: { fetch: vi.fn(), listMatches: vi.fn(), createMatch: vi.fn(), wipe: vi.fn() },
  connectStore: vi.fn(),
  closeStore: vi.fn(),
}));

import { Router } from 'express';
import { registeredRoutes, resetRouteRegistry, type RegisteredRoute } from '@chains/shared';
import { registerLobbyRoutes } from '../routes/lobby.js';
import { registerRankedRoutes } from '../routes/ranked.js';
import { mmrWindowFor } from '../ranked/queue.js';

let all: readonly RegisteredRoute[] = [];

beforeAll(() => {
  resetRouteRegistry();
  const router = Router();
  registerLobbyRoutes(router);
  registerRankedRoutes(router);
  all = registeredRoutes();
});

const key = (r: RegisteredRoute): string => `${r.method.toUpperCase()} ${r.path}`;

describe('no route accepts a match outcome', () => {
  it('has no /result path anywhere in the game service', () => {
    for (const r of all) {
      expect(r.path).not.toMatch(/result/i);
      expect(r.path).not.toMatch(/gameover/i);
      expect(r.path).not.toMatch(/winner/i);
    }
  });

  it('does not resurrect the legacy /api/ranked/* surface', () => {
    const paths = all.map((r) => r.path);
    expect(paths).not.toContain('/api/ranked/match/result');
    for (const p of paths) expect(p.startsWith('/api/')).toBe(false);
  });

  it('exposes no write route beyond the queue and the lobby', () => {
    // POST/PUT/PATCH/DELETE is the complete list of ways a client can change
    // server state here. Anything new in it is a deliberate decision.
    const writes = all
      .filter((r) => ['post', 'put', 'patch', 'delete'].includes(r.method))
      .map(key)
      .sort();
    expect(writes).toEqual([
      'DELETE /games/ranked/queue',
      'POST /games/:id/cancel',
      'POST /games/:id/join',
      'POST /games/create',
      'POST /games/ranked/queue',
    ]);
  });
});

describe('the ranked route table', () => {
  const ranked = (): RegisteredRoute[] => all.filter((r) => r.path.startsWith('/games/ranked'));

  it('is exactly these eight routes at exactly these auth levels', () => {
    expect(
      ranked()
        .map((r) => `${key(r)} [${r.auth}]`)
        .sort(),
    ).toEqual([
      'DELETE /games/ranked/queue [required]',
      'GET /games/ranked/leaderboard [public]',
      'GET /games/ranked/me [required]',
      'GET /games/ranked/me/matches [required]',
      'GET /games/ranked/profiles/:displayName [public]',
      'GET /games/ranked/queue [required]',
      'GET /games/ranked/season [public]',
      'POST /games/ranked/queue [required]',
    ]);
  });

  it('mounts under /games/, which gateway/nginx.conf already proxies', () => {
    // `location /games/ { proxy_pass http://game_upstream; }` is an nginx prefix
    // match with the path preserved, so no gateway change is needed for any of
    // these. `location /api/` goes to the PROFILE service, which is why the
    // legacy prefix could not be kept.
    for (const r of ranked()) expect(r.path.startsWith('/games/ranked/')).toBe(true);
  });

  it('keeps every per-player route behind authentication', () => {
    const personal = ranked().filter(
      (r) => r.path.includes('/me') || r.path.endsWith('/queue'),
    );
    expect(personal.length).toBe(5);
    for (const r of personal) expect(r.auth).toBe('required');
  });

  it('makes public only the three routes that contain no personal data', () => {
    const publics = ranked()
      .filter((r) => r.auth.startsWith('public'))
      .map((r) => r.path)
      .sort();
    expect(publics).toEqual([
      '/games/ranked/leaderboard',
      '/games/ranked/profiles/:displayName',
      '/games/ranked/season',
    ]);
  });

  it('has no route that names a profile the caller could act as', () => {
    // `/games/ranked/profiles/:displayName` is a READ of somebody else's public
    // standing. Every route that changes anything keys on req.auth.profileId and
    // takes no identifier at all.
    const byName = ranked().filter((r) => r.path.includes(':displayName'));
    expect(byName.map((r) => r.method)).toEqual(['get']);
  });
});

describe('the matchmaking window', () => {
  const now = Date.UTC(2026, 6, 28, 12, 0, 0);
  const secondsAgo = (s: number): Date => new Date(now - s * 1000);

  it('starts narrow', () => {
    expect(mmrWindowFor(secondsAgo(0), now)).toBe(50);
    expect(mmrWindowFor(secondsAgo(9), now)).toBe(50);
  });

  it('opens by one step per interval waited', () => {
    expect(mmrWindowFor(secondsAgo(10), now)).toBe(100);
    expect(mmrWindowFor(secondsAgo(60), now)).toBe(350);
  });

  it('is capped, so a long wait produces a legible number rather than 18050', () => {
    expect(mmrWindowFor(secondsAgo(3_600), now)).toBe(2_000);
    expect(mmrWindowFor(secondsAgo(86_400), now)).toBe(2_000);
  });

  it('never goes negative for a clock that ran backwards', () => {
    expect(mmrWindowFor(new Date(now + 60_000), now)).toBe(50);
  });

  it('is monotone in time waited', () => {
    let previous = 0;
    for (const s of [0, 5, 10, 25, 60, 120, 600, 3_600]) {
      const w = mmrWindowFor(secondsAgo(s), now);
      expect(w).toBeGreaterThanOrEqual(previous);
      previous = w;
    }
  });
});
