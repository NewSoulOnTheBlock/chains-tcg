import { randomUUID } from 'node:crypto';
import type { IRouter, Request } from 'express';
import {
  AppError,
  asyncHandler,
  createLogger,
  rateLimit,
  route,
  strictBody,
  validateBody,
  validateParams,
  validateQuery,
  validatedBody,
  validatedParams,
  validatedQuery,
  withTransaction,
  z,
  zDisplayName,
  zUuid,
  type AuthContext,
} from '@chains/shared';
import { config } from '../config.js';
import { store } from '../bgio/store.js';
import { createMatch } from '../bgio/vendor.js';
import { ChainsTCG } from '../game/Game.js';
import { getActiveDeck } from '../repo/decks.repo.js';
import {
  claimSeat1,
  countOpenMatchesFor,
  getDisplayName,
  getMatch,
  getProfileIdByDisplayName,
  insertOpenMatch,
  listInvites,
  listOpenMatches,
  lockMatch,
  voidOpenMatch,
  type MatchMode,
} from '../repo/matches.repo.js';
import { assertSeatableDeck, buildSetupData, mintCredentials } from '../lib/seating.js';

const log = createLogger({ service: 'game' }).child({ component: 'lobby' });

/** Narrowing helper for handlers registered behind `auth: 'required'`. */
function auth(req: Request): AuthContext {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}

const IdParams = z.object({ id: zUuid });
const LobbyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(config.LOBBY_PAGE_SIZE).default(config.LOBBY_PAGE_SIZE),
});

const CreateBody = strictBody({
  mode: z.enum(['casual', 'ranked', 'wager']).default('casual'),
  /** Unlisted matches are hidden from the public lobby. */
  unlisted: z.boolean().default(false),
  /** Addressing a match to someone turns it into a challenge (implies unlisted). */
  invitedDisplayName: zDisplayName.optional(),
  /**
   * Stake in the token's base units, as a decimal STRING (bigint-safe).
   * Advisory display metadata only — the wager service owns the escrow and the
   * real amount. Nothing on this route can move money.
   */
  wagerAmountBase: z
    .string()
    .regex(/^[0-9]{1,20}$/, 'must be a non-negative integer in base units')
    .optional(),
});
const EmptyBody = z.object({}).loose();

const lobbyWriteLimit = () =>
  rateLimit({ name: 'games:write', limit: 20, windowSec: 60, by: 'profile' });

export function registerLobbyRoutes(router: IRouter): void {
  // ── GET /games/lobby ────────────────────────────────────────────────────
  // The hardened replacement for boardgame.io's `GET /games/:name` (audit
  // H-7). Returns EXACTLY { matchID, mode, seats[{filled, displayName}],
  // createdAt, wagerAmount? }.
  //
  // Auth is required, not optional: the private-match filter is a function of
  // the caller's identity, and a lobby that can be browsed anonymously would
  // have to answer "which private matches am I allowed to see?" with "none".
  route(router, {
    method: 'get',
    path: '/games/lobby',
    auth: 'required',
    summary: 'Open matches visible to the caller (never setupData or decklists)',
    middleware: [validateQuery(LobbyQuery)],
    handler: asyncHandler(async (req, res) => {
      const { limit } = validatedQuery(req, LobbyQuery);
      res.json({ matches: await listOpenMatches(auth(req).profileId, limit) });
    }),
  });

  // ── GET /games/invites ──────────────────────────────────────────────────
  // Open matches addressed to the caller. Same projection; the filter is
  // `invited_profile = req.auth.profileId`.
  route(router, {
    method: 'get',
    path: '/games/invites',
    auth: 'required',
    summary: 'Challenges addressed to the caller',
    handler: asyncHandler(async (req, res) => {
      res.json({ matches: await listInvites(auth(req).profileId, config.LOBBY_PAGE_SIZE) });
    }),
  });

  // ── POST /games/create ──────────────────────────────────────────────────
  // Seats the CALLER at seat 0. No boardgame.io match exists yet — it is
  // materialised at join time, once both decks are known. That is precisely
  // why an open match has no `setupData` for anything to leak.
  route(router, {
    method: 'post',
    path: '/games/create',
    auth: 'required',
    summary: 'Create an open match seated by the caller',
    middleware: [lobbyWriteLimit(), validateBody(CreateBody)],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const body = validatedBody(req, CreateBody);

      const deck = await getActiveDeck(profileId);
      assertSeatableDeck(deck);

      let invitedProfile: string | null = null;
      if (body.invitedDisplayName !== undefined) {
        invitedProfile = await getProfileIdByDisplayName(body.invitedDisplayName);
        if (invitedProfile === null) throw AppError.notFound('Invited player not found');
        if (invitedProfile === profileId) {
          throw AppError.badRequest('You cannot challenge yourself', { reason: 'self_challenge' });
        }
      }

      const open = await countOpenMatchesFor(profileId);
      if (open >= config.LOBBY_MAX_OPEN_PER_PROFILE) {
        throw AppError.conflict(`You already have ${open} open matches; cancel one first`, {
          reason: 'too_many_open_matches',
        });
      }

      const match = await insertOpenMatch({
        id: randomUUID(),
        mode: body.mode as MatchMode,
        // An addressed challenge is always unlisted.
        unlisted: body.unlisted || invitedProfile !== null,
        seat0Profile: profileId,
        seat0DeckId: deck.id,
        invitedProfile,
        // The wager service owns escrow creation and sets `wager_id`.
        wagerId: null,
        wagerAmountBase: body.wagerAmountBase ?? null,
      });

      log.info('match created', { matchID: match.id, mode: match.mode, profileId });
      res.status(201).json({
        matchID: match.id,
        mode: match.mode,
        status: match.status,
        seat: 0,
        // Credentials do not exist until the match goes live — poll
        // GET /games/:id/seat once someone joins.
        createdAt: match.createdAt.toISOString(),
      });
    }),
  });

  // ── POST /games/:id/join ────────────────────────────────────────────────
  // Resolves identity from req.auth, reads the caller's ACTIVE DECK from
  // core.decks, mints boardgame.io credentials server-side, and materialises
  // the boardgame.io match. Nothing about the opponent comes back.
  route(router, {
    method: 'post',
    path: '/games/:id/join',
    auth: 'required',
    summary: 'Take seat 1; the server attaches your active deck',
    middleware: [lobbyWriteLimit(), validateParams(IdParams), validateBody(EmptyBody)],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const { id: matchId } = validatedParams(req, IdParams);

      const deck = await getActiveDeck(profileId);
      assertSeatableDeck(deck);

      const credentials = { seat0: mintCredentials(), seat1: mintCredentials() };
      // Set only once the boardgame.io row exists, so the compensating wipe
      // below can never touch a match we did not just create.
      let vendorMatchWritten = false;

      const run = withTransaction(async (c) => {
        const match = await lockMatch(matchId, c);
        if (!match) throw AppError.notFound('Match not found');
        if (match.status !== 'open') {
          throw AppError.conflict('That match is no longer open', { reason: 'match_not_open' });
        }
        if (match.seat0Profile === profileId) {
          throw AppError.conflict('You already hold a seat in that match', {
            reason: 'already_seated',
          });
        }
        // Private/challenge gate — SERVER-side, from the caller's identity.
        // 404 rather than 403: an uninvited caller should not learn the id exists.
        if (match.unlisted && match.invitedProfile !== profileId) {
          throw AppError.notFound('Match not found');
        }
        if (match.seat0Profile === null || match.seat0DeckId === null) {
          throw AppError.conflict('That match has no host', { reason: 'match_incomplete' });
        }

        const claimed = await claimSeat1(matchId, profileId, deck.id, c);
        if (!claimed) {
          throw AppError.conflict('That match is no longer open', { reason: 'match_not_open' });
        }

        const { rows: hostRows } = await c.query<{ display_name: string; cards: unknown }>(
          `SELECT p.display_name, d.cards
             FROM core.profiles p
             JOIN core.decks   d ON d.id = $2 AND d.profile_id = p.id
            WHERE p.id = $1`,
          [match.seat0Profile, match.seat0DeckId],
        );
        const host = hostRows[0];
        if (!host) {
          throw AppError.conflict("The host's deck is unavailable", { reason: 'match_incomplete' });
        }
        const hostCards = Array.isArray(host.cards) ? (host.cards as unknown[]).map(String) : [];

        const joinerName = await getDisplayName(profileId, c);
        if (joinerName === null) throw AppError.notFound('Profile not found');

        const setupData = buildSetupData(
          { names: [host.display_name, joinerName], decks: [hostCards, deck.cards] },
          match.mode,
          { amountBase: match.wagerAmountBase, wagerId: match.wagerId },
        );

        const built = createMatch({
          game: ChainsTCG,
          numPlayers: 2,
          setupData,
          // Belt and braces on top of boardgame.io's lobby API not being served
          // at all: its own listing must never surface this match either.
          unlisted: true,
        });
        if ('setupDataError' in built) {
          throw AppError.badRequest(built.setupDataError, { reason: 'setup_rejected' });
        }

        built.metadata.players[0] = {
          id: 0,
          name: host.display_name,
          credentials: credentials.seat0,
        };
        built.metadata.players[1] = { id: 1, name: joinerName, credentials: credentials.seat1 };

        // Inside the transaction: if this throws, the seat claim rolls back and
        // the match stays joinable.
        await store.createMatch(matchId, {
          initialState: built.initialState,
          metadata: built.metadata,
        });
        vendorMatchWritten = true;
      });

      try {
        await run;
      } catch (err) {
        // boardgame.io's storage is a separate connection, so it is not covered
        // by the ROLLBACK. If we had already written the vendor row, drop it so
        // the seat stays cleanly joinable.
        if (vendorMatchWritten) {
          await store.wipe(matchId).catch((e: unknown) => {
            log.error('failed to wipe orphaned boardgame.io match', {
              matchID: matchId,
              err: String(e),
            });
          });
        }
        throw err;
      }

      log.info('match joined', { matchID: matchId, profileId });
      res.json({ matchID: matchId, seat: 1, playerID: '1', credentials: credentials.seat1 });
    }),
  });

  // ── GET /games/:id/seat ─────────────────────────────────────────────────
  // Reconnect path. Returns the CALLER'S OWN seat and credentials and only
  // those — never the opponent's credentials, deck or address.
  route(router, {
    method: 'get',
    path: '/games/:id/seat',
    auth: 'required',
    summary: "The caller's own seat and boardgame.io credentials",
    middleware: [validateParams(IdParams)],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const { id } = validatedParams(req, IdParams);
      const match = await getMatch(id);
      if (!match) throw AppError.notFound('Match not found');

      const seat: 0 | 1 | null =
        match.seat0Profile === profileId ? 0 : match.seat1Profile === profileId ? 1 : null;
      // Not a seat holder → 404, not 403: do not confirm the match exists.
      if (seat === null) throw AppError.notFound('Match not found');

      if (match.status === 'open') {
        res.json({ matchID: match.id, seat, status: match.status, credentials: null });
        return;
      }

      const { metadata } = await store.fetch(id, { metadata: true });
      res.json({
        matchID: match.id,
        seat,
        playerID: String(seat),
        status: match.status,
        credentials: metadata?.players?.[seat]?.credentials ?? null,
      });
    }),
  });

  // ── POST /games/:id/cancel ──────────────────────────────────────────────
  route(router, {
    method: 'post',
    path: '/games/:id/cancel',
    auth: 'required',
    summary: 'Void your own still-open match',
    middleware: [lobbyWriteLimit(), validateParams(IdParams)],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const { id } = validatedParams(req, IdParams);
      // Ownership is the WHERE clause: only the host of an OPEN match can void it.
      const ok = await voidOpenMatch(id, profileId);
      if (!ok) throw AppError.notFound('No open match of yours with that id');
      res.json({ matchID: id, status: 'void' });
    }),
  });
}
