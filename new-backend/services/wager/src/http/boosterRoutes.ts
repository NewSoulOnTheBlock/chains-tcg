/**
 * Booster routes.
 *
 * Everything lives under `/wager/` because that is the prefix the gateway
 * routes to this service; it does not rewrite paths.
 *
 * | Method | Path                                                  | Auth              |
 * |--------|-------------------------------------------------------|-------------------|
 * | GET    | /wager/boosters/supply                                | public            |
 * | POST   | /wager/boosters/intents                               | required          |
 * | POST   | /wager/boosters/confirm                               | required          |
 * | GET    | /wager/boosters/tickets                               | required (own)    |
 * | GET    | /wager/boosters/tickets/:ticketNumber                 | required (owner/op)|
 * | POST   | /wager/boosters/tickets/:ticketNumber/redeem/digital  | required (owner)  |
 * | POST   | /wager/boosters/tickets/:ticketNumber/redeem/physical | required (owner)  |
 * | POST   | /wager/boosters/tickets/:ticketNumber/redeem/merch    | required (owner)  |
 * | GET    | /wager/boosters/tickets/:ticketNumber/shipping        | required (owner/op)|
 *
 * `/wager/boosters/supply` is the only public route: counts plus the public treasury
 * address, no personal data and no wallet-to-identity mapping. There is
 * deliberately NO route that takes a wallet address and returns tickets or
 * shipping details (H-2) — the legacy `GET /api/boosters/tickets/:wallet` did
 * exactly that, unauthenticated, and `redeem-*` took the owner from the body.
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
import { confirmBody, emptyBody, redeemShippedBody, ticketParams } from './schemas.js';
import {
  confirmBoosterPayment,
  createBoosterIntent,
  getMyTicket,
  getShipping,
  listMyTickets,
  redeemTicket,
  supplySnapshot,
  type BoosterServiceDeps,
} from '../services/boosterService.js';
import type { RouteLimits } from './escrowRoutes.js';

export function mountBoosterRoutes(
  router: IRouter,
  deps: BoosterServiceDeps,
  limits: RouteLimits,
): void {
  route(router, {
    method: 'get',
    path: '/wager/boosters/supply',
    public: true,
    summary: 'remaining supply and price — no personal data',
    middleware: [rateLimit({ name: 'boosters:supply', by: 'ip', limit: 60, windowSec: 60 })],
    handler: asyncHandler(async (_req, res) => {
      res.json(await supplySnapshot(deps));
    }),
  });

  route(router, {
    method: 'post',
    path: '/wager/boosters/intents',
    auth: 'required',
    summary: 'server-issued purchase intent: nonce, exact price, recipient',
    middleware: [rateLimit({ name: 'boosters:intent', by: 'profile', limit: 10, windowSec: 300 })],
    handler: asyncHandler(async (req, res) => {
      res.status(201).json({ intent: await createBoosterIntent(deps, callerOf(req)) });
    }),
  });

  route(router, {
    method: 'post',
    path: '/wager/boosters/confirm',
    auth: 'required',
    summary: 'reserve-then-mint against a paid intent',
    middleware: [
      rateLimit({ name: 'boosters:confirm', by: 'profile', limit: 10, windowSec: 300 }),
      validateBody(confirmBody),
    ],
    handler: asyncHandler(async (req, res) => {
      const { paymentTxHash } = validatedBody(req, confirmBody);
      const result = await confirmBoosterPayment(deps, callerOf(req), { paymentTxHash });
      // 202 when the reservation is durable but the mint has not landed yet.
      res.status(result.minted ? 200 : 202).json(result);
    }),
  });

  route(router, {
    method: 'get',
    path: '/wager/boosters/tickets',
    auth: 'required',
    summary: 'the caller’s own tickets, and only those',
    middleware: [rateLimit({ name: 'boosters:tickets', by: 'profile', ...limits })],
    handler: asyncHandler(async (req, res) => {
      res.json({ tickets: await listMyTickets(callerOf(req)) });
    }),
  });

  route(router, {
    method: 'get',
    path: '/wager/boosters/tickets/:ticketNumber',
    auth: 'required',
    summary: 'one ticket — owner or operator only',
    middleware: [
      rateLimit({ name: 'boosters:tickets', by: 'profile', ...limits }),
      validateParams(ticketParams),
    ],
    handler: asyncHandler(async (req, res) => {
      const { ticketNumber } = validatedParams(req, ticketParams);
      res.json({ ticket: await getMyTicket(callerOf(req), ticketNumber) });
    }),
  });

  for (const kind of ['digital', 'physical', 'merch'] as const) {
    route(router, {
      method: 'post',
      path: `/wager/boosters/tickets/:ticketNumber/redeem/${kind}`,
      auth: 'required',
      summary: `redeem the ${kind} reward — ownership proven against the reservation row`,
      middleware: [
        rateLimit({ name: 'boosters:redeem', by: 'profile', limit: 10, windowSec: 60 }),
        validateParams(ticketParams),
        validateBody(kind === 'digital' ? emptyBody : redeemShippedBody),
      ],
      handler: asyncHandler(async (req, res) => {
        const { ticketNumber } = validatedParams(req, ticketParams);
        const address =
          kind === 'digital' ? undefined : validatedBody(req, redeemShippedBody).address;
        const result = await redeemTicket(deps, callerOf(req), {
          ticketNumber,
          kind,
          ...(address ? { address } : {}),
        });
        res.status(201).json(result);
      }),
    });
  }

  route(router, {
    method: 'get',
    path: '/wager/boosters/tickets/:ticketNumber/shipping',
    auth: 'required',
    summary: 'shipping payloads — owner or operator only (H-2)',
    middleware: [
      rateLimit({ name: 'boosters:shipping', by: 'profile', limit: 20, windowSec: 60 }),
      validateParams(ticketParams),
    ],
    handler: asyncHandler(async (req, res) => {
      const { ticketNumber } = validatedParams(req, ticketParams);
      res.json({ shipping: await getShipping(callerOf(req), ticketNumber) });
    }),
  });
}
