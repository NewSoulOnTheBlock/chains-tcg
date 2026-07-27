import type { IRouter, Request } from 'express';
import {
  AppError,
  asyncHandler,
  isUniqueViolation,
  rateLimit,
  route,
  strictBody,
  validateParams,
  validateQuery,
  validatedBody,
  validatedParams,
  validatedQuery,
  validateBody,
  z,
  zDisplayName,
  type AuthContext,
} from '@chains/shared';
import {
  getOwnProfile,
  getPublicProfile,
  getProfileIdByDisplayName,
  updateOwnProfile,
} from '../repo/profiles.repo.js';
import { listMatchHistory } from '../repo/matches.repo.js';
import { normalizeAvatarUrl } from '../lib/avatar.js';
import { invalidateLeaderboard } from '../lib/cache.js';

/** Narrowing helper for handlers registered behind `auth: 'required'`. */
function auth(req: Request): AuthContext {
  if (!req.auth) throw AppError.unauthorized();
  return req.auth;
}

const PatchBody = strictBody({
  displayName: zDisplayName.optional(),
  // `null` clears the field; an omitted key leaves it untouched.
  avatarUrl: z.string().max(4096).nullable().optional(),
  bio: z.string().max(500).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, 'at least one field must be provided');

const DisplayNameParams = z.object({ displayName: zDisplayName });
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(25) });

export function registerProfileRoutes(router: IRouter): void {
  // ── GET /api/profiles/me ────────────────────────────────────────────────
  // The ONLY route that returns a wallet address, and only to its owner (H-2).
  route(router, {
    method: 'get',
    path: '/api/profiles/me',
    auth: 'required',
    summary: "The caller's own profile, including wallet address",
    handler: asyncHandler(async (req, res) => {
      const profile = await getOwnProfile(auth(req).profileId);
      if (!profile) throw AppError.notFound('Profile not found');
      res.json({ profile });
    }),
  });

  // ── PATCH /api/profiles/me ──────────────────────────────────────────────
  // Operates on req.auth.profileId only. There is deliberately no route that
  // accepts a target profile in the body (audit C-3).
  route(router, {
    method: 'patch',
    path: '/api/profiles/me',
    auth: 'required',
    summary: "Update the caller's own display name, avatar or bio",
    middleware: [
      rateLimit({ name: 'profile:patch', limit: 10, windowSec: 60, by: 'profile' }),
      validateBody(PatchBody),
    ],
    handler: asyncHandler(async (req, res) => {
      const { profileId } = auth(req);
      const body = validatedBody(req, PatchBody);

      const patch: Parameters<typeof updateOwnProfile>[1] = {};
      if (body.displayName !== undefined) patch.displayName = body.displayName;
      if (body.avatarUrl !== undefined) patch.avatarUrl = normalizeAvatarUrl(body.avatarUrl);
      if (body.bio !== undefined) patch.bio = body.bio === null ? null : body.bio.trim() || null;

      let profile;
      try {
        profile = await updateOwnProfile(profileId, patch);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw AppError.conflict('That display name is already in use', {
            reason: 'display_name_taken',
          });
        }
        throw err;
      }
      if (!profile) throw AppError.notFound('Profile not found');

      // The leaderboard caches display names and avatars.
      if (patch.displayName !== undefined || patch.avatarUrl !== undefined) {
        await invalidateLeaderboard();
      }
      res.json({ profile });
    }),
  });

  // ── GET /api/profiles/:displayName ──────────────────────────────────────
  // PUBLIC. Display name, avatar, bio, wins, losses, level — and nothing else.
  // The repo's SELECT does not name address/chain, so no response shape here
  // can carry them (audit H-2).
  route(router, {
    method: 'get',
    path: '/api/profiles/:displayName',
    public: true,
    summary: 'Public profile view (never wallet, e-mail or shipping data)',
    middleware: [validateParams(DisplayNameParams)],
    handler: asyncHandler(async (req, res) => {
      const { displayName } = validatedParams(req, DisplayNameParams);
      const profile = await getPublicProfile(displayName);
      if (!profile) throw AppError.notFound('Profile not found');
      res.json({ profile });
    }),
  });

  // ── GET /api/profiles/:displayName/matches ──────────────────────────────
  route(router, {
    method: 'get',
    path: '/api/profiles/:displayName/matches',
    public: true,
    summary: 'Recent match history from game.match_results',
    middleware: [validateParams(DisplayNameParams), validateQuery(HistoryQuery)],
    handler: asyncHandler(async (req, res) => {
      const { displayName } = validatedParams(req, DisplayNameParams);
      const { limit } = validatedQuery(req, HistoryQuery);
      const profileId = await getProfileIdByDisplayName(displayName);
      if (profileId === null) throw AppError.notFound('Profile not found');
      res.json({ matches: await listMatchHistory(profileId, limit) });
    }),
  });
}
