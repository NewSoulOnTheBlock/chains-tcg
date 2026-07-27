/**
 * Escrow routes.
 *
 * | Method | Path                        | Auth                        |
 * |--------|-----------------------------|-----------------------------|
 * | GET    | /wager/stakes               | required                    |
 * | POST   | /wager/escrows              | required (participant)      |
 * | GET    | /wager/escrows/:id          | required (participant/op)   |
 * | POST   | /wager/escrows/:id/deposits | required (participant)      |
 * | POST   | /wager/escrows/:id/void     | required + operator role    |
 *
 * There is NO settlement route. Paying out is not something a request can ask
 * for — that is the structural half of the C-1 fix (the other half is the HMAC
 * on `game.match_results`). `route()` refuses to register anything that is
 * neither authenticated nor explicitly `public: true`.
 */
import type { IRouter } from 'express';
import {
  asyncHandler,
  callerOf,
  rateLimit,
  route,
  validateBody,
  validateParams,
  validatedBody,
  validatedParams,
} from '../platform/shared.js';
import { createEscrowBody, depositBody, escrowParams, voidBody } from './schemas.js';
import {
  createEscrow,
  submitDeposit,
  viewEscrow,
  voidEscrow,
  type EscrowServiceDeps,
} from '../services/escrowService.js';

export interface RouteLimits {
  limit: number;
  windowSec: number;
}

export function mountEscrowRoutes(
  router: IRouter,
  deps: EscrowServiceDeps,
  limits: RouteLimits,
): void {
  route(router, {
    method: 'get',
    path: '/wager/stakes',
    auth: 'required',
    summary: 'the server-decided stake allowlist',
    middleware: [rateLimit({ name: 'wager:stakes', by: 'profile', ...limits })],
    handler: asyncHandler(async (_req, res) => {
      res.json({ tiers: deps.stakes.list(), token: deps.token, decimals: deps.decimals });
    }),
  });

  route(router, {
    method: 'post',
    path: '/wager/escrows',
    auth: 'required',
    summary: 'open an escrow for a match at an allowlisted stake tier',
    middleware: [
      rateLimit({ name: 'wager:escrow-create', by: 'profile', limit: 10, windowSec: 60 }),
      validateBody(createEscrowBody),
    ],
    handler: asyncHandler(async (req, res) => {
      const body = validatedBody(req, createEscrowBody);
      const escrow = await createEscrow(deps, callerOf(req), body);
      res.status(201).json({ escrow });
    }),
  });

  route(router, {
    method: 'get',
    path: '/wager/escrows/:id',
    auth: 'required',
    summary: 'funding status for a participant (never the opponent’s address)',
    middleware: [
      rateLimit({ name: 'wager:escrow-read', by: 'profile', ...limits }),
      validateParams(escrowParams),
    ],
    handler: asyncHandler(async (req, res) => {
      const { id } = validatedParams(req, escrowParams);
      res.json({ escrow: await viewEscrow(deps, callerOf(req), id) });
    }),
  });

  route(router, {
    method: 'post',
    path: '/wager/escrows/:id/deposits',
    auth: 'required',
    summary: 'record a deposit; seat and payer come from the session, not the body',
    middleware: [
      // Tighter budget: each call costs an RPC lookup.
      rateLimit({ name: 'wager:deposit', by: 'profile', limit: 10, windowSec: 60 }),
      validateParams(escrowParams),
      validateBody(depositBody),
    ],
    handler: asyncHandler(async (req, res) => {
      const { id } = validatedParams(req, escrowParams);
      const { txHash } = validatedBody(req, depositBody);
      const result = await submitDeposit(deps, callerOf(req), { escrowId: id, txHash });
      res.status(201).json(result);
    }),
  });

  route(router, {
    method: 'post',
    path: '/wager/escrows/:id/void',
    roles: ['operator'],
    summary: 'operator escape hatch for a stuck escrow; audited',
    middleware: [
      rateLimit({ name: 'wager:void', by: 'profile', limit: 10, windowSec: 60 }),
      validateParams(escrowParams),
      validateBody(voidBody),
    ],
    handler: asyncHandler(async (req, res) => {
      const { id } = validatedParams(req, escrowParams);
      const { reason } = validatedBody(req, voidBody);
      const result = await voidEscrow(deps, callerOf(req), {
        escrowId: id,
        reason,
        requestId: req.id,
      });
      res.json(result);
    }),
  });
}
