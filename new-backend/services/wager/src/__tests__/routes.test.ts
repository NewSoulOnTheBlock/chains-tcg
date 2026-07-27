/**
 * Route registration.
 *
 * `route()` throws at startup for any route that declares neither an auth
 * requirement nor an explicit `public: true` (finding C-3). Mounting the real
 * routers here turns that startup guarantee into a test, and pins the auth
 * level of every path so a later edit cannot quietly relax one.
 *
 * It also asserts the two things that must NOT exist: a settlement endpoint,
 * and any route that takes a wallet address.
 */
import express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { registeredRoutes, resetRouteRegistry } from '../platform/shared.js';
import { mountEscrowRoutes } from '../http/escrowRoutes.js';
import { mountBoosterRoutes } from '../http/boosterRoutes.js';
import type { EscrowServiceDeps } from '../services/escrowService.js';
import type { BoosterServiceDeps } from '../services/boosterService.js';

const limits = { limit: 30, windowSec: 60 };

function mountAll(): void {
  const app = express();
  // Registration never invokes a handler, so stub dependencies are enough.
  mountEscrowRoutes(app, {} as EscrowServiceDeps, limits);
  mountBoosterRoutes(app, {} as BoosterServiceDeps, limits);
}

describe('route registration', () => {
  beforeEach(() => {
    resetRouteRegistry();
  });

  it('registers every route with an explicit auth decision', () => {
    mountAll();
    const routes = registeredRoutes();
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.auth).toBeTruthy();
    }
  });

  it('pins the auth level of every path', () => {
    mountAll();
    const table = registeredRoutes()
      .map((r) => `${r.method.toUpperCase()} ${r.path} [${r.auth}]`)
      .sort();

    expect(table).toEqual([
      'GET /wager/boosters/supply [public]',
      'GET /wager/boosters/tickets [required]',
      'GET /wager/boosters/tickets/:ticketNumber [required]',
      'GET /wager/boosters/tickets/:ticketNumber/shipping [required]',
      'GET /wager/escrows/:id [required]',
      'GET /wager/stakes [required]',
      'POST /wager/boosters/confirm [required]',
      'POST /wager/boosters/intents [required]',
      'POST /wager/boosters/tickets/:ticketNumber/redeem/digital [required]',
      'POST /wager/boosters/tickets/:ticketNumber/redeem/merch [required]',
      'POST /wager/boosters/tickets/:ticketNumber/redeem/physical [required]',
      'POST /wager/escrows [required]',
      'POST /wager/escrows/:id/deposits [required]',
      'POST /wager/escrows/:id/void [required:operator]',
    ]);
  });

  it('exposes exactly one public route, and it carries no personal data', () => {
    mountAll();
    const publicRoutes = registeredRoutes().filter((r) => r.auth.startsWith('public'));
    expect(publicRoutes.map((r) => r.path)).toEqual(['/wager/boosters/supply']);
  });

  it('gates the void escape hatch behind the operator role', () => {
    mountAll();
    const voidRoute = registeredRoutes().find((r) => r.path.endsWith('/void'));
    expect(voidRoute?.auth).toBe('required:operator');
  });

  it('HAS NO SETTLEMENT ENDPOINT (C-1)', () => {
    mountAll();
    // The legacy `POST /api/result` paid the pot to whoever the body named.
    // Nothing here can decide a payout: settlement is a worker reading
    // HMAC-signed rows written by the game service.
    for (const r of registeredRoutes()) {
      expect(r.path).not.toMatch(/settle|result|payout|winner/i);
    }
  });

  it('has no route that takes a wallet address (H-2)', () => {
    mountAll();
    for (const r of registeredRoutes()) {
      expect(r.path).not.toMatch(/wallet|address|:addr/i);
    }
  });

  it('mounts everything under /wager/, which is what the gateway routes here', () => {
    mountAll();
    for (const r of registeredRoutes()) {
      expect(r.path.startsWith('/wager/')).toBe(true);
    }
  });
});
