/**
 * Collection routes.
 *
 * | Method | Path                    | Auth           |
 * |--------|-------------------------|----------------|
 * | GET    | /wager/collection       | required (own) |
 * | POST   | /wager/collection/sync  | required (own) |
 *
 * Neither route takes an identifier. The collection is always the caller's,
 * derived from the session by `callerOf(req)` — there is deliberately no
 * `:profileId` segment, no `?wallet=` query and no address in any body, because
 * a route that accepts an identifier is a route that can be pointed at somebody
 * else. That was audit finding H-2, and `routes.test.ts` asserts no path in this
 * service matches /wallet|address/.
 *
 * The sync route is rate-limited harder than the read: each call costs a chain
 * log scan plus one `ownerOf` per token, against a public endpoint this project
 * does not operate.
 */
import type { IRouter } from 'express';
import {
  asyncHandler,
  callerOf,
  rateLimit,
  route,
  validateBody,
} from '../platform/shared.js';
import { emptyBody } from './schemas.js';
import {
  getMyCollection,
  syncMyCollection,
  type CollectionServiceDeps,
} from '../services/collectionService.js';
import type { RouteLimits } from './escrowRoutes.js';

export function mountCollectionRoutes(
  router: IRouter,
  deps: CollectionServiceDeps,
  limits: RouteLimits,
): void {
  route(router, {
    method: 'get',
    path: '/wager/collection',
    auth: 'required',
    summary: 'the caller’s own owned cards, from the stored chain snapshot',
    middleware: [rateLimit({ name: 'wager:collection', by: 'profile', ...limits })],
    handler: asyncHandler(async (req, res) => {
      res.json(await getMyCollection(callerOf(req)));
    }),
  });

  route(router, {
    method: 'post',
    path: '/wager/collection/sync',
    auth: 'required',
    summary: 're-derive the caller’s collection from CardPack chain state',
    middleware: [
      // Tighter budget: each call is a chain scan against a public endpoint.
      rateLimit({ name: 'wager:collection-sync', by: 'profile', limit: 6, windowSec: 300 }),
      validateBody(emptyBody),
    ],
    handler: asyncHandler(async (req, res) => {
      res.json(await syncMyCollection(deps, callerOf(req)));
    }),
  });
}
