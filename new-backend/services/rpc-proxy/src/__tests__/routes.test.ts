/**
 * Route registration.
 *
 * `route()` throws at startup for any route that declares neither an auth
 * requirement nor an explicit `public: true` (finding C-3). Mounting the real
 * router here turns that startup guarantee into a test.
 *
 * It also pins the two structural facts about this service: it exposes exactly
 * one JSON-RPC path, and that path is EVM.
 */
import express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { registeredRoutes, resetRouteRegistry } from '../platform/shared.js';
import { mountRpcRoutes } from '../http/rpcRoutes.js';
import { buildPolicy } from '../allowlist.js';
import type { UpstreamClient } from '../upstream/client.js';

function mount(): void {
  const app = express();
  // Registration never invokes a handler, so a stub upstream is enough.
  mountRpcRoutes(app, {
    policy: buildPolicy(),
    upstream: {} as UpstreamClient,
    chainKey: 'test',
    internalToken: '',
    ttls: { receipt: 30, transaction: 30, block: 30, chainId: 3_600 },
    limits: {
      ip: { limit: 10, windowSec: 60 },
      profile: { limit: 10, windowSec: 60 },
      internal: { limit: 10, windowSec: 60 },
    },
  });
}

describe('route registration', () => {
  beforeEach(() => {
    resetRouteRegistry();
  });

  it('registers every route with an explicit auth decision', () => {
    mount();
    const routes = registeredRoutes();
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(r.auth).toBeTruthy();
  });

  it('exposes exactly one JSON-RPC path, and it is EVM', () => {
    mount();
    const table = registeredRoutes()
      .map((r) => `${r.method.toUpperCase()} ${r.path} [${r.auth}]`)
      .sort();
    expect(table).toEqual([
      'GET /rpc/evm [public]',
      'POST /rpc/evm [public+optional]',
    ]);
  });

  it('has no /rpc/solana route — this backend is EVM-only', () => {
    mount();
    for (const r of registeredRoutes()) {
      expect(r.path).not.toMatch(/solana/i);
    }
  });
});
