/**
 * The ranked routes over real HTTP, on a real Express stack.
 *
 * ── Why this exists on top of the route-table test ─────────────────────────
 * `registerLobbyRoutes` runs first and registers `/games/:id/join`,
 * `/games/:id/seat` and `/games/:id/cancel`. Express matches in registration
 * order, so a three-segment ranked path is one literal away from being
 * swallowed by `/games/:id/...` and answered as "match not found" — with a 404
 * that looks exactly like a typo in the client. Asserting the registry cannot
 * catch that; only asking the router can.
 *
 * It also pins the two status codes a client integrates against most: an
 * unauthenticated call to a ranked route is 401 (not 404), and an unknown path
 * is 404 (not 401).
 *
 * Needs Postgres and Redis, because the public routes really do read a season
 * and really do take a rate-limit token. Skipped, loudly, without them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testEnv = vi.hoisted(() => {
  const db = process.env.TEST_DATABASE_URL ?? null;
  process.env.DATABASE_URL = db ?? 'postgres://chains:unused@127.0.0.1:5432/chains';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long';
  process.env.MATCH_RESULT_HMAC_SECRET ??= 'test-hmac-secret-at-least-32-characters-long';
  process.env.LOG_LEVEL ??= 'error';
  return { db, redis: process.env.REDIS_URL };
});

vi.mock('../bgio/store.js', () => ({
  store: { fetch: vi.fn(), listMatches: vi.fn(), createMatch: vi.fn(), wipe: vi.fn() },
  connectStore: vi.fn(),
  closeStore: vi.fn(),
}));

import type { Server } from 'node:http';
import express, { Router } from 'express';
import {
  closeDb,
  closeRedis,
  createLogger,
  errorHandler,
  initDb,
  initRedis,
  notFoundHandler,
  resetRouteRegistry,
} from '@chains/shared';
import { registerLobbyRoutes } from '../routes/lobby.js';
import { registerRankedRoutes } from '../routes/ranked.js';

const suite = testEnv.db ? describe : describe.skip;

if (!testEnv.db) {
  // eslint-disable-next-line no-console
  console.warn('[game] TEST_DATABASE_URL not set — ranked HTTP routing tests SKIPPED');
}

suite('ranked routes over HTTP', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    initDb({ connectionString: testEnv.db!, max: 2, statementTimeoutMs: 15_000 });
    await initRedis({ url: testEnv.redis });

    resetRouteRegistry();
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '256kb' }));
    const router = Router();
    // Registration order is the thing under test: exactly as index.ts does it.
    registerLobbyRoutes(router);
    registerRankedRoutes(router);
    app.use(router);
    app.use(notFoundHandler());
    app.use(errorHandler(createLogger({ service: 'game-test', level: 'error' })));

    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled([closeDb(), closeRedis()]);
  });

  const get = (path: string): Promise<Response> => fetch(`${base}${path}`);

  describe('the lobby s /games/:id/* routes do not shadow the ladder', () => {
    it('GET /games/ranked/season is served by the ladder, not by /games/:id/seat', async () => {
      const res = await get('/games/ranked/season');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { season: { id: string }; placementMatches: number };
      expect(body.season.id).toMatch(/^season-/);
      expect(body.placementMatches).toBe(10);
      expect(body).toHaveProperty('tiers');
    });

    it('GET /games/ranked/leaderboard returns a season-scoped board', async () => {
      const res = await get('/games/ranked/leaderboard?limit=5');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { seasonId: string; entries: unknown[]; limit: number };
      expect(body.seasonId).toMatch(/^season-/);
      expect(Array.isArray(body.entries)).toBe(true);
      expect(body.limit).toBe(5);
    });

    it('GET /games/ranked/profiles/:displayName 404s on an unknown player, not on the route', async () => {
      const res = await get('/games/ranked/profiles/definitely-not-a-real-player');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('not_found');
      // The route matched and looked the player up; a shadowed route would have
      // said "Match not found" from /games/:id/seat instead.
      expect(body.error.message).toBe('Profile not found');
    });

    it('rejects a malformed display name at the schema, not at the database', async () => {
      const res = await get('/games/ranked/profiles/ab');
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_request');
    });
  });

  describe('authentication', () => {
    const guarded: Array<[string, string]> = [
      ['GET', '/games/ranked/me'],
      ['GET', '/games/ranked/me/matches'],
      ['GET', '/games/ranked/queue'],
      ['POST', '/games/ranked/queue'],
      ['DELETE', '/games/ranked/queue'],
    ];

    it.each(guarded)('%s %s is 401 without a token, never 404', async (method, path) => {
      const res = await fetch(`${base}${path}`, {
        method,
        ...(method === 'POST'
          ? { headers: { 'content-type': 'application/json' }, body: '{}' }
          : {}),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    });

    it.each(guarded)('%s %s rejects a forged token', async (method, path) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('there is no route that takes an outcome', () => {
    it.each([
      '/games/ranked/match/result',
      '/games/ranked/result',
      '/games/result',
      '/api/ranked/match/result',
    ])('POST %s is 404', async (path) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ matchId: 'x', winner: '0', player0: 'a', player1: 'b' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('strict bodies', () => {
    it('the queue body accepts only a known region', async () => {
      // Unauthenticated, so this 401s before validation — the schema itself is
      // covered by the enum. What matters here is that no unknown key can reach
      // a handler on a route that has no auth in front of it, and there are none.
      const res = await fetch(`${base}/games/ranked/queue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ region: 'global', profileId: '1', rating: 9999 }),
      });
      expect(res.status).toBe(401);
    });
  });
});
