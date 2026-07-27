import { query, queryOne } from '@chains/shared';

/**
 * `core.profiles` row shapes.
 *
 * `address` / `chain` are PERSONAL DATA and appear in exactly one projection:
 * `OwnProfile`, returned only to the authenticated owner (audit H-2). The
 * public projections below cannot leak them because the columns are not in
 * their SELECT lists at all.
 *
 * Ids are carried as STRINGS end to end — `core.profiles.id` is a bigserial and
 * `req.auth.profileId` is a decimal string, so nothing is ever narrowed through
 * a JS number.
 */
export interface OwnProfile {
  id: string;
  address: string;
  chain: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  wins: number;
  losses: number;
  level: number;
  createdAt: string;
}

export interface PublicProfile {
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  wins: number;
  losses: number;
  level: number;
}

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  avatarUrl: string | null;
  wins: number;
  losses: number;
  level: number;
}

/**
 * Level is DERIVED, not stored — `core.profiles` has no `level` column and this
 * service does not add one. Triangular curve: level 1 at 0 wins, then a level
 * per 1, 3, 6, 10, … wins, i.e. `floor((1 + sqrt(1 + 8w)) / 2)`.
 */
export function levelFromWins(wins: number): number {
  return Math.floor((1 + Math.sqrt(1 + 8 * Math.max(0, wins))) / 2);
}

export async function getOwnProfile(id: string): Promise<OwnProfile | null> {
  const r = await queryOne<{
    id: string;
    address: string;
    chain: string;
    display_name: string;
    avatar_url: string | null;
    bio: string | null;
    wins: number;
    losses: number;
    created_at: Date;
  }>(
    `SELECT id::text, address, chain, display_name, avatar_url, bio, wins, losses, created_at
       FROM core.profiles
      WHERE id = $1`,
    [id],
  );
  if (!r) return null;
  return {
    id: r.id,
    address: r.address,
    chain: r.chain,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    bio: r.bio,
    wins: r.wins,
    losses: r.losses,
    level: levelFromWins(r.wins),
    createdAt: r.created_at.toISOString(),
  };
}

/** Public view. No address, no chain, no e-mail, no shipping (audit H-2). */
export async function getPublicProfile(displayName: string): Promise<PublicProfile | null> {
  const r = await queryOne<{
    display_name: string;
    avatar_url: string | null;
    bio: string | null;
    wins: number;
    losses: number;
  }>(
    `SELECT display_name, avatar_url, bio, wins, losses
       FROM core.profiles
      WHERE display_name = $1`,
    [displayName],
  );
  if (!r) return null;
  return {
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    bio: r.bio,
    wins: r.wins,
    losses: r.losses,
    level: levelFromWins(r.wins),
  };
}

export async function getProfileIdByDisplayName(displayName: string): Promise<string | null> {
  const r = await queryOne<{ id: string }>(
    `SELECT id::text FROM core.profiles WHERE display_name = $1`,
    [displayName],
  );
  return r?.id ?? null;
}

export interface ProfilePatch {
  displayName?: string;
  avatarUrl?: string | null;
  bio?: string | null;
}

/**
 * Update the caller's own row. The id is `req.auth.profileId` — there is no
 * code path in this service that takes a target profile from a request body
 * (audit C-3).
 */
export async function updateOwnProfile(id: string, patch: ProfilePatch): Promise<OwnProfile | null> {
  const sets: string[] = [];
  const args: unknown[] = [id];

  if (patch.displayName !== undefined) {
    args.push(patch.displayName);
    sets.push(`display_name = $${args.length}`);
  }
  if (patch.avatarUrl !== undefined) {
    args.push(patch.avatarUrl);
    sets.push(`avatar_url = $${args.length}`);
  }
  if (patch.bio !== undefined) {
    args.push(patch.bio);
    sets.push(`bio = $${args.length}`);
  }
  if (sets.length === 0) return getOwnProfile(id);

  const { rowCount } = await query(
    `UPDATE core.profiles SET ${sets.join(', ')} WHERE id = $1`,
    args,
  );
  if ((rowCount ?? 0) === 0) return null;
  return getOwnProfile(id);
}

/** Top N by wins. No wallet addresses — the columns are not in the SELECT. */
export async function getLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  const { rows } = await query<{
    display_name: string;
    avatar_url: string | null;
    wins: number;
    losses: number;
  }>(
    `SELECT display_name, avatar_url, wins, losses
       FROM core.profiles
      ORDER BY wins DESC, losses ASC, id ASC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    wins: r.wins,
    losses: r.losses,
    level: levelFromWins(r.wins),
  }));
}
