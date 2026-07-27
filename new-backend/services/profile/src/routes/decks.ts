import type { IRouter, Request } from 'express';
import {
  AppError,
  asyncHandler,
  rateLimit,
  route,
  strictBody,
  validateBody,
  validateParams,
  validatedBody,
  validatedParams,
  z,
  type AuthContext,
} from '@chains/shared';
import {
  activateDeck,
  createDeck,
  deleteDeck,
  listDecks,
  updateDeck,
} from '../repo/decks.repo.js';
// Deck legality comes from the repo's own game rules, vendored verbatim.
import { validateDeck, DECK_SIZE } from '../game/cards.js';

function auth(req: Request): AuthContext {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}

/** Hard ceiling on the array we are willing to parse at all (DoS guard). */
const MAX_DECK_CARDS = 400;

const zCards = z.array(z.string().min(1).max(64)).max(MAX_DECK_CARDS);
const zDeckName = z.string().trim().min(1).max(48);
// `core.decks.id` is a bigserial; keep it a string so nothing is narrowed.
const IdParams = z.object({ id: z.string().regex(/^[0-9]{1,19}$/, 'must be a deck id') });

const CreateBody = strictBody({ name: zDeckName, cards: zCards });
const UpdateBody = strictBody({ name: zDeckName.optional(), cards: zCards.optional() }).refine(
  (v) => v.name !== undefined || v.cards !== undefined,
  'nothing to update',
);

/**
 * Legality gate.
 *
 * Parity with the server this replaces: saving a work-in-progress deck checks
 * card ids and copy limits only (`requireSize: false`); the full 60-card rule
 * is enforced on ACTIVATE, because only an active deck can be seated into a
 * match by the game service.
 */
function assertDeckLegal(cards: string[], opts: { requireSize: boolean }): void {
  const result = validateDeck(cards, { requireSize: opts.requireSize });
  if (!result.ok) {
    throw AppError.badRequest('Deck is not legal', {
      reason: 'invalid_deck',
      size: result.size,
      requiredSize: opts.requireSize ? DECK_SIZE : undefined,
      issues: result.issues,
    });
  }
}

const deckWriteLimit = () =>
  rateLimit({ name: 'decks:write', limit: 30, windowSec: 60, by: 'profile' });

export function registerDeckRoutes(router: IRouter): void {
  // ── GET /api/decks ──────────────────────────────────────────────────────
  route(router, {
    method: 'get',
    path: '/api/decks',
    auth: 'required',
    summary: "The caller's decks",
    handler: asyncHandler(async (req, res) => {
      res.json({ decks: await listDecks(auth(req).profileId) });
    }),
  });

  // ── POST /api/decks ─────────────────────────────────────────────────────
  route(router, {
    method: 'post',
    path: '/api/decks',
    auth: 'required',
    summary: 'Create a deck',
    middleware: [deckWriteLimit(), validateBody(CreateBody)],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const body = validatedBody(req, CreateBody);
      assertDeckLegal(body.cards, { requireSize: false });
      const deck = await createDeck(profileId, body.name, body.cards);
      res.status(201).json({ deck });
    }),
  });

  // ── PUT /api/decks/:id ──────────────────────────────────────────────────
  route(router, {
    method: 'put',
    path: '/api/decks/:id',
    auth: 'required',
    summary: 'Rename a deck or replace its cards',
    middleware: [deckWriteLimit(), validateParams(IdParams), validateBody(UpdateBody)],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const { id } = validatedParams(req, IdParams);
      const body = validatedBody(req, UpdateBody);
      if (body.cards !== undefined) assertDeckLegal(body.cards, { requireSize: false });
      // Ownership is the WHERE clause: `id = :id AND profile_id = :auth`.
      const patch: { name?: string; cards?: string[] } = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.cards !== undefined) patch.cards = body.cards;
      res.json({ deck: await updateDeck(profileId, id, patch) });
    }),
  });

  // ── DELETE /api/decks/:id ───────────────────────────────────────────────
  route(router, {
    method: 'delete',
    path: '/api/decks/:id',
    auth: 'required',
    summary: 'Delete a deck',
    middleware: [deckWriteLimit(), validateParams(IdParams)],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const { id } = validatedParams(req, IdParams);
      await deleteDeck(profileId, id);
      res.json({ ok: true });
    }),
  });

  // ── POST /api/decks/:id/activate ────────────────────────────────────────
  // The active deck is what the GAME service seats you with, so full legality
  // is required here and only here.
  route(router, {
    method: 'post',
    path: '/api/decks/:id/activate',
    auth: 'required',
    summary: 'Make a deck the active one (must be fully legal)',
    middleware: [deckWriteLimit(), validateParams(IdParams)],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const { id } = validatedParams(req, IdParams);
      const target = (await listDecks(profileId)).find((d) => d.id === id);
      if (!target) throw AppError.notFound('Deck not found');
      assertDeckLegal(target.cards, { requireSize: true });
      res.json({ deck: await activateDeck(profileId, id) });
    }),
  });
}
