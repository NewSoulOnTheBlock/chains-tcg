import { query, queryOne, type PoolClient } from '@chains/shared';

export type MatchMode = 'casual' | 'ranked' | 'wager';
export type MatchStatus = 'open' | 'live' | 'finished' | 'void';

/** Profile and deck ids are bigserials — carried as strings, never narrowed. */
export interface MatchRow {
  id: string;
  mode: MatchMode;
  status: MatchStatus;
  unlisted: boolean;
  wagerId: string | null;
  wagerAmountBase: string | null;
  seat0Profile: string | null;
  seat1Profile: string | null;
  seat0DeckId: string | null;
  seat1DeckId: string | null;
  invitedProfile: string | null;
  createdAt: Date;
}

interface RawMatch {
  id: string;
  mode: string;
  status: string;
  unlisted: boolean;
  wager_id: string | null;
  wager_amount_base: string | null;
  seat0_profile: string | null;
  seat1_profile: string | null;
  seat0_deck_id: string | null;
  seat1_deck_id: string | null;
  invited_profile: string | null;
  created_at: Date;
}

const COLS = `id, mode, status, unlisted, wager_id, wager_amount_base::text,
              seat0_profile::text, seat1_profile::text,
              seat0_deck_id::text, seat1_deck_id::text,
              invited_profile::text, created_at`;

/**
 * The lobby projection, spelled out. Note what is ABSENT and stays absent:
 * `setupData` (which lives in boardgame.io's own table, not here), deck
 * CONTENTS, and any wallet address — `core.profiles.address` is never joined
 * in, so no lobby response can carry one (audit H-7, H-2).
 */
const LOBBY_COLS = `m.id, m.mode, m.status, m.unlisted, m.wager_id, m.wager_amount_base::text,
                    m.seat0_profile::text, m.seat1_profile::text,
                    m.seat0_deck_id::text, m.seat1_deck_id::text,
                    m.invited_profile::text, m.created_at,
                    p0.display_name AS seat0_name,
                    p1.display_name AS seat1_name`;

function toMatch(r: RawMatch): MatchRow {
  return {
    id: r.id,
    mode: r.mode as MatchMode,
    status: r.status as MatchStatus,
    unlisted: r.unlisted,
    wagerId: r.wager_id,
    wagerAmountBase: r.wager_amount_base,
    seat0Profile: r.seat0_profile,
    seat1Profile: r.seat1_profile,
    seat0DeckId: r.seat0_deck_id,
    seat1DeckId: r.seat1_deck_id,
    invitedProfile: r.invited_profile,
    createdAt: r.created_at,
  };
}

/** Exactly the shape the lobby is allowed to return. */
export interface LobbyEntry {
  matchID: string;
  mode: MatchMode;
  seats: Array<{ filled: boolean; displayName: string | null }>;
  createdAt: string;
  wagerAmount?: string;
}

interface RawLobby extends RawMatch {
  seat0_name: string | null;
  seat1_name: string | null;
}

function toLobbyEntry(r: RawLobby): LobbyEntry {
  const entry: LobbyEntry = {
    matchID: r.id,
    mode: r.mode as MatchMode,
    seats: [
      { filled: r.seat0_profile !== null, displayName: r.seat0_name },
      { filled: r.seat1_profile !== null, displayName: r.seat1_name },
    ],
    createdAt: r.created_at.toISOString(),
  };
  if (r.wager_amount_base !== null) entry.wagerAmount = r.wager_amount_base;
  return entry;
}

/**
 * Open matches visible to `viewerProfileId`.
 *
 * Private matches are filtered HERE, in the WHERE clause, against the
 * authenticated caller: an unlisted match is visible only to its creator and to
 * the profile it was addressed to. Nothing is filtered client-side (audit H-7).
 */
export async function listOpenMatches(
  viewerProfileId: string,
  limit: number,
): Promise<LobbyEntry[]> {
  const { rows } = await query<RawLobby>(
    `SELECT ${LOBBY_COLS}
       FROM game.matches m
       LEFT JOIN core.profiles p0 ON p0.id = m.seat0_profile
       LEFT JOIN core.profiles p1 ON p1.id = m.seat1_profile
      WHERE m.status = 'open'
        AND (
          m.unlisted = FALSE
          OR m.seat0_profile   = $1
          OR m.invited_profile = $1
        )
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [viewerProfileId, limit],
  );
  return rows.map(toLobbyEntry);
}

/** Open matches addressed specifically to the caller — the challenge inbox. */
export async function listInvites(
  viewerProfileId: string,
  limit: number,
): Promise<LobbyEntry[]> {
  const { rows } = await query<RawLobby>(
    `SELECT ${LOBBY_COLS}
       FROM game.matches m
       LEFT JOIN core.profiles p0 ON p0.id = m.seat0_profile
       LEFT JOIN core.profiles p1 ON p1.id = m.seat1_profile
      WHERE m.status = 'open' AND m.invited_profile = $1
      ORDER BY m.created_at DESC
      LIMIT $2`,
    [viewerProfileId, limit],
  );
  return rows.map(toLobbyEntry);
}

export async function countOpenMatchesFor(profileId: string): Promise<number> {
  const r = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM game.matches WHERE seat0_profile = $1 AND status = 'open'`,
    [profileId],
  );
  return Number(r?.n ?? '0');
}

export interface CreateMatchInput {
  id: string;
  mode: MatchMode;
  unlisted: boolean;
  seat0Profile: string;
  seat0DeckId: string;
  invitedProfile: string | null;
  wagerId: string | null;
  wagerAmountBase: string | null;
}

export async function insertOpenMatch(input: CreateMatchInput): Promise<MatchRow> {
  const r = await queryOne<RawMatch>(
    `INSERT INTO game.matches
       (id, mode, status, unlisted, seat0_profile, seat0_deck_id, invited_profile,
        wager_id, wager_amount_base)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8)
     RETURNING ${COLS}`,
    [
      input.id,
      input.mode,
      input.unlisted,
      input.seat0Profile,
      input.seat0DeckId,
      input.invitedProfile,
      input.wagerId,
      input.wagerAmountBase,
    ],
  );
  if (!r) throw new Error('match insert returned no row');
  return toMatch(r);
}

/** Row-locking read, for the join transaction. */
export async function lockMatch(id: string, c: PoolClient): Promise<MatchRow | null> {
  const { rows } = await c.query<RawMatch>(
    `SELECT ${COLS} FROM game.matches WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const r = rows[0];
  return r ? toMatch(r) : null;
}

export async function getMatch(id: string): Promise<MatchRow | null> {
  const r = await queryOne<RawMatch>(`SELECT ${COLS} FROM game.matches WHERE id = $1`, [id]);
  return r ? toMatch(r) : null;
}

/**
 * Claim seat 1. The predicate — not application code — is the guard: two
 * concurrent joins serialise on the row lock and the loser matches zero rows.
 */
export async function claimSeat1(
  id: string,
  profileId: string,
  deckId: string,
  c: PoolClient,
): Promise<boolean> {
  const { rowCount } = await c.query(
    `UPDATE game.matches
        SET seat1_profile = $2, seat1_deck_id = $3,
            status = 'live', started_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'open' AND seat1_profile IS NULL AND seat0_profile <> $2`,
    [id, profileId, deckId],
  );
  return (rowCount ?? 0) > 0;
}

export async function voidOpenMatch(id: string, ownerProfileId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE game.matches SET status = 'void', updated_at = now()
      WHERE id = $1 AND seat0_profile = $2 AND status = 'open'`,
    [id, ownerProfileId],
  );
  return (rowCount ?? 0) > 0;
}

export async function getDisplayName(profileId: string, c: PoolClient): Promise<string | null> {
  const { rows } = await c.query<{ display_name: string }>(
    `SELECT display_name FROM core.profiles WHERE id = $1`,
    [profileId],
  );
  return rows[0]?.display_name ?? null;
}

export async function getProfileIdByDisplayName(displayName: string): Promise<string | null> {
  const r = await queryOne<{ id: string }>(
    `SELECT id::text FROM core.profiles WHERE display_name = $1`,
    [displayName],
  );
  return r?.id ?? null;
}
