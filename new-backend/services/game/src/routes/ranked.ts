/**
 * `/games/ranked/*` — the ladder's read model and the queue.
 *
 * ── Why this prefix ────────────────────────────────────────────────────────
 * `gateway/nginx.conf` has `location /games/ { proxy_pass http://game_upstream; }`,
 * an nginx PREFIX match with the path preserved, so every path beginning
 * `/games/` already reaches this service. Mounting the ladder under
 * `/games/ranked/` therefore needs no gateway change, no new upstream and no
 * redeploy of nginx — verified by reading the config rather than assumed, and
 * re-verifiable with `curl -s localhost:8080/games/ranked/season`.
 *
 * The legacy prefix `/api/ranked/*` would have been the wrong answer twice over:
 * `location /api/` routes to the PROFILE service, so every ladder call would
 * have 404'd there, and the ladder is not the profile service's business — it is
 * produced by the same process that owns match results.
 *
 * ── What is NOT here ───────────────────────────────────────────────────────
 * The legacy API had `POST /api/ranked/match/result`, taking
 * `{ matchId, player0, player1, winner, draw }` from an unauthenticated request
 * body. There is no equivalent, and there must never be one. Ratings move in
 * `ranked/apply-result.ts`, inside the transaction that records the
 * authoritative result, from boardgame.io's own `ctx.gameover`. No route below
 * accepts a winner, a rating, an LP value or a match outcome of any kind.
 *
 * Every route also refuses to take an identity from its input. There is no
 * `GET /games/ranked/profile/:name` returning "your" ladder: the caller's own
 * standing is `GET /games/ranked/me`, keyed on `req.auth.profileId`. The
 * by-display-name route exists only for looking at SOMEBODY ELSE, returns
 * strictly public fields, and is not a way to act as them.
 */
import type { IRouter, Request } from 'express';
import {
  AppError,
  asyncHandler,
  rateLimit,
  route,
  strictBody,
  validateBody,
  validateParams,
  validateQuery,
  validatedBody,
  validatedParams,
  validatedQuery,
  z,
  zDisplayName,
  type AuthContext,
} from '@chains/shared';
import { config } from '../config.js';
import { getProfileIdByDisplayName } from '../repo/matches.repo.js';
import * as repo from '../repo/ranked.repo.js';
import { joinQueue, leaveQueue, queueStatus, QUEUE_REGIONS } from '../ranked/queue.js';
import { ladderLabel, tierAt, TIERS, type Division } from '../ranked/ranks.js';
import { ensureActiveSeason } from '../ranked/season.js';

function auth(req: Request): AuthContext {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}

/* -------------------------------------------------------------------------- */
/* Projections                                                                */
/* -------------------------------------------------------------------------- */

interface RankView {
  tier: string;
  division: Division;
  lp: number;
  label: string;
  /** The total-order integer the leaderboard is sorted by. */
  ordinal: number;
}

/**
 * The visible rank, or null while placements are outstanding.
 *
 * A player in placements HAS a tier/division/LP in the table — `applyLpDelta`
 * runs on every placement game so the snap at the end has something to work
 * from — but it is not a rank they have earned and it is not shown to anyone.
 * Returning it would mean the client renders "Bronze IV" for a player who is
 * about to be placed in Platinum.
 */
function rankOf(s: {
  tier: number;
  division: Division;
  lp: number;
  ladderOrdinal: number;
  placementsRemaining: number;
}): RankView | null {
  if (s.placementsRemaining > 0) return null;
  const pos = { tier: tierAt(s.tier), division: s.division, lp: s.lp };
  return {
    tier: pos.tier,
    division: pos.division,
    lp: pos.lp,
    label: ladderLabel(pos),
    ordinal: s.ladderOrdinal,
  };
}

/**
 * A standing as the client sees it.
 *
 * `rating`, `rating_deviation`, `volatility`, `smurf_flagged`, `smurf_reasons`
 * and `mmr_multiplier` are ABSENT and must stay absent. Hidden MMR is hidden for
 * a reason: published, it becomes the number players optimise against, and every
 * matchmaking decision turns into an argument. The legacy API stripped these
 * fields with a rest-destructure at the route, which meant a new column was
 * exposed by default; here the projection is a whitelist and a new column is
 * hidden by default.
 */
function standingView(
  s: repo.StandingRow,
  extra: { displayName?: string; leaderboardRank?: number | null },
): Record<string, unknown> {
  return {
    ...(extra.displayName !== undefined ? { displayName: extra.displayName } : {}),
    seasonId: s.seasonId,
    rank: rankOf(s),
    placement: {
      remaining: s.placementsRemaining,
      total: config.RANKED_PLACEMENT_MATCHES,
      inPlacements: s.placementsRemaining > 0,
    },
    record: { wins: s.wins, losses: s.losses, draws: s.draws },
    ...(extra.leaderboardRank !== undefined ? { leaderboardRank: extra.leaderboardRank } : {}),
  };
}

/** An unranked profile: exists, has never played a rated game this season. */
function unrankedView(
  seasonId: string,
  extra: { displayName?: string },
): Record<string, unknown> {
  return {
    ...(extra.displayName !== undefined ? { displayName: extra.displayName } : {}),
    seasonId,
    rank: null,
    placement: {
      remaining: config.RANKED_PLACEMENT_MATCHES,
      total: config.RANKED_PLACEMENT_MATCHES,
      inPlacements: true,
    },
    record: { wins: 0, losses: 0, draws: 0 },
    leaderboardRank: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const JoinBody = strictBody({
  /**
   * Advisory shard, from a fixed set. Not identity, not a claim about anything
   * that already exists — it is the value this request is about to persist, so
   * the value checked and the value stored are the same value.
   */
  region: z.enum(QUEUE_REGIONS).default('global'),
});

const LeaderboardQuery = z.object({
  seasonId: z.string().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(config.RANKED_LEADERBOARD_PAGE_SIZE)
    .default(config.RANKED_LEADERBOARD_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const NameParams = z.object({ displayName: zDisplayName });

/* -------------------------------------------------------------------------- */
/* Middleware                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The kill switch, as a 503 rather than a 404.
 *
 * A 404 would tell a client "you have the URL wrong", and it would keep
 * retrying against a path that is correct. `unavailable` with a reason says the
 * ladder is off, which is a thing a client can render honestly.
 */
const requireRankedEnabled = () => (_req: Request, _res: unknown, next: (e?: unknown) => void) => {
  if (!config.RANKED_ENABLED) {
    next(
      AppError.unavailable('The ranked ladder is currently disabled', {
        reason: 'ranked_disabled',
      }),
    );
    return;
  }
  next();
};

const queueWriteLimit = () =>
  rateLimit({ name: 'ranked:queue', limit: 30, windowSec: 60, by: 'profile' });
/** Queue status is polled; 180/min is a comfortable 1s poll with headroom. */
const rankedReadLimit = () =>
  rateLimit({ name: 'ranked:read', limit: 180, windowSec: 60, by: 'profile' });
const publicReadLimit = () =>
  rateLimit({ name: 'ranked:public', limit: 60, windowSec: 60, by: 'ip' });

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */

export function registerRankedRoutes(router: IRouter): void {
  // ── GET /games/ranked/season ────────────────────────────────────────────
  // Public: a season's name, window and reward copy are marketing surface, and
  // the landing page has to render them before anybody signs in. Contains no
  // per-player data at all.
  //
  // The legacy `/api/ranked/rewards` is folded in as `season.rewards` rather
  // than kept as a second route — it only ever returned this same object's
  // `rewardDefinitions` field, and a route whose entire body is one field of
  // another route's response is a cache to keep in step for no benefit.
  route(router, {
    method: 'get',
    path: '/games/ranked/season',
    public: true,
    summary: 'The active season, its window and its reward definitions',
    middleware: [requireRankedEnabled(), publicReadLimit()],
    handler: asyncHandler(async (_req, res) => {
      const s = await ensureActiveSeason();
      res.json({
        season: {
          id: s.id,
          name: s.name,
          startedAt: s.startedAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          softResetFactor: s.softResetFactor,
          balancePatch: s.balancePatch,
          rewards: s.rewardDefinitions,
        },
        placementMatches: config.RANKED_PLACEMENT_MATCHES,
        tiers: TIERS,
      });
    }),
  });

  // ── GET /games/ranked/leaderboard ───────────────────────────────────────
  // Public, matching the profile service's own `GET /api/leaderboard`, which is
  // public and also returns display names. That route is untouched by this
  // file: it orders by wins and knows nothing about rating, and both boards can
  // exist because they answer different questions.
  //
  // No wallet address is joined in, here or anywhere (H-2).
  route(router, {
    method: 'get',
    path: '/games/ranked/leaderboard',
    public: true,
    summary: 'Season standings, ordered by the visible ladder',
    middleware: [requireRankedEnabled(), publicReadLimit(), validateQuery(LeaderboardQuery)],
    handler: asyncHandler(async (req, res) => {
      const q = validatedQuery(req, LeaderboardQuery);
      const seasonId = q.seasonId ?? (await ensureActiveSeason()).id;
      const entries = await repo.topStandings(seasonId, q.limit, q.offset);
      res.json({
        seasonId,
        limit: q.limit,
        offset: q.offset,
        entries: entries.map((e) => {
          const pos = { tier: tierAt(e.tier), division: e.division, lp: e.lp };
          return {
            rank: e.rank,
            profileId: e.profileId,
            displayName: e.displayName,
            tier: pos.tier,
            division: pos.division,
            lp: pos.lp,
            label: ladderLabel(pos),
            record: { wins: e.wins, losses: e.losses, draws: e.draws },
          };
        }),
      });
    }),
  });

  // ── GET /games/ranked/profiles/:displayName ─────────────────────────────
  // Somebody else's public standing — for a profile page or an opponent badge.
  // Strictly the same projection the leaderboard uses.
  route(router, {
    method: 'get',
    path: '/games/ranked/profiles/:displayName',
    public: true,
    summary: "Another player's public ladder standing",
    middleware: [requireRankedEnabled(), publicReadLimit(), validateParams(NameParams)],
    handler: asyncHandler(async (req, res) => {
      const { displayName } = validatedParams(req, NameParams);
      const profileId = await getProfileIdByDisplayName(displayName);
      if (profileId === null) throw AppError.notFound('Profile not found');

      const season = await ensureActiveSeason();
      const standing = await repo.getStanding(season.id, profileId);
      if (!standing) {
        res.json({ profile: unrankedView(season.id, { displayName }) });
        return;
      }
      const leaderboardRank = await repo.standingRank(season.id, profileId);
      res.json({ profile: standingView(standing, { displayName, leaderboardRank }) });
    }),
  });

  // ── GET /games/ranked/me ────────────────────────────────────────────────
  // The caller's OWN standing. Identity is `req.auth.profileId` and there is no
  // parameter that could name anybody else — which is the whole difference from
  // the legacy `GET /api/ranked/profile/:name`, where the name in the path was
  // both the lookup key and, because `getOrCreateProfile` wrote on read, a way
  // to conjure ladder rows for names that were not yours.
  route(router, {
    method: 'get',
    path: '/games/ranked/me',
    auth: 'required',
    summary: "The caller's own ladder standing this season",
    middleware: [requireRankedEnabled(), rankedReadLimit()],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const season = await ensureActiveSeason();
      const standing = await repo.getStanding(season.id, profileId);
      if (!standing) {
        res.json({ profileId, ...unrankedView(season.id, {}) });
        return;
      }
      const leaderboardRank = await repo.standingRank(season.id, profileId);
      res.json({ profileId, ...standingView(standing, { leaderboardRank }) });
    }),
  });

  // ── GET /games/ranked/me/matches ────────────────────────────────────────
  // The caller's rated history with the LP each game moved — what a post-game
  // screen needs. Reads `game.ranked_match_ratings`, which is written in the
  // result transaction, so it can never show a match whose rating did not apply.
  route(router, {
    method: 'get',
    path: '/games/ranked/me/matches',
    auth: 'required',
    summary: "The caller's ranked match history with LP deltas",
    middleware: [requireRankedEnabled(), rankedReadLimit(), validateQuery(HistoryQuery)],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const { limit } = validatedQuery(req, HistoryQuery);
      res.json({ matches: await repo.recentRankedMatches(profileId, limit) });
    }),
  });

  // ── POST /games/ranked/queue ────────────────────────────────────────────
  // Join. The body carries a region and nothing else: no name, no deck, no
  // rating. The deck is the caller's ACTIVE deck read from `core.decks`, and it
  // must pass the same ownership gate that seating a ranked match does — refused
  // HERE, with the offending cards named, rather than discovered at pairing time
  // as a match that quietly never happened.
  route(router, {
    method: 'post',
    path: '/games/ranked/queue',
    auth: 'required',
    summary: 'Enter the ranked queue with your active deck',
    middleware: [requireRankedEnabled(), queueWriteLimit(), validateBody(JoinBody)],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const { region } = validatedBody(req, JoinBody);
      const result = await joinQueue(profileId, region);
      res.json({ queued: true, ...result });
    }),
  });

  // ── GET /games/ranked/queue ─────────────────────────────────────────────
  // Status, and the pairing handoff. Answers from `game.ranked_queue` and
  // `game.matches`, so it is correct across containers and across restarts, and
  // reading it does not consume anything (see ranked/queue.ts on why the legacy
  // in-process Map could not be ported).
  route(router, {
    method: 'get',
    path: '/games/ranked/queue',
    auth: 'required',
    summary: 'Queue status, and the match you have been paired into',
    middleware: [requireRankedEnabled(), rankedReadLimit()],
    handler: asyncHandler(async (req, res) => {
      res.json(await queueStatus(auth(req).profileId));
    }),
  });

  // ── DELETE /games/ranked/queue ──────────────────────────────────────────
  // Leave. Ownership is the WHERE clause: the only row this can delete is the
  // caller's own, because `profile_id` is the primary key and it comes from the
  // token.
  route(router, {
    method: 'delete',
    path: '/games/ranked/queue',
    auth: 'required',
    summary: 'Leave the ranked queue',
    middleware: [requireRankedEnabled(), queueWriteLimit()],
    handler: asyncHandler(async (req, res) => {
      const { wasQueued } = await leaveQueue(auth(req).profileId);
      res.json({ queued: false, wasQueued });
    }),
  });
}
