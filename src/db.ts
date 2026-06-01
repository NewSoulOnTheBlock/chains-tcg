// src/db.ts
// Postgres-backed profile + result store. Falls back to in-memory if no DATABASE_URL.

import pg from 'pg';

export type Profile = {
  name: string;
  wins: number;
  losses: number;
  draws: number;
  createdAt: number;
  avatarUrl: string | null;
  bio: string | null;
};

const DATABASE_URL = process.env.DATABASE_URL;
let pool: pg.Pool | null = null;

// Fallback in-memory store (for local dev without Postgres).
const memProfiles: Map<string, Profile> = new Map();
const recordedMatches: Set<string> = new Set(); // matchID dedupe for in-memory mode

export async function initDb() {
  if (!DATABASE_URL) {
    console.warn('[db] DATABASE_URL not set — using in-memory store (data will not persist).');
    return;
  }
  pool = new pg.Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('render.com') || process.env.PGSSL === '1'
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      name_key   TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      wins       INTEGER NOT NULL DEFAULT 0,
      losses     INTEGER NOT NULL DEFAULT 0,
      draws      INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT  NOT NULL,
      avatar_url TEXT,
      bio        TEXT
    );
  `);
  // Migrate older deployments that pre-date avatar_url/bio columns.
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recorded_matches (
      match_id   TEXT PRIMARY KEY,
      winner     TEXT,
      loser      TEXT,
      draw       BOOLEAN NOT NULL DEFAULT FALSE,
      recorded_at BIGINT NOT NULL
    );
  `);
  console.log('[db] Postgres ready.');
}

function key(name: string) {
  return name.trim().toLowerCase();
}

function rowToProfile(r: any): Profile {
  return {
    name: r.name,
    wins: Number(r.wins),
    losses: Number(r.losses),
    draws: Number(r.draws),
    createdAt: Number(r.created_at),
    avatarUrl: r.avatar_url ?? null,
    bio: r.bio ?? null,
  };
}

export async function upsertProfile(name: string): Promise<Profile> {
  const n = name.trim();
  if (!n) throw new Error('Profile name required');
  const k = key(n);
  if (!pool) {
    let p = memProfiles.get(k);
    if (!p) { p = { name: n, wins: 0, losses: 0, draws: 0, createdAt: Date.now(), avatarUrl: null, bio: null }; memProfiles.set(k, p); }
    return p;
  }
  const { rows } = await pool.query(
    `INSERT INTO profiles (name_key, name, wins, losses, draws, created_at)
     VALUES ($1, $2, 0, 0, 0, $3)
     ON CONFLICT (name_key) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [k, n, Date.now()],
  );
  return rowToProfile(rows[0]);
}

/** Update editable profile fields (avatar URL + bio). Creates the row if it doesn't exist. */
export async function updateProfile(
  name: string, patch: { avatarUrl?: string | null; bio?: string | null },
): Promise<Profile> {
  const existing = await upsertProfile(name);
  const k = key(name);
  const nextAvatar = patch.avatarUrl === undefined ? existing.avatarUrl : (patch.avatarUrl || null);
  const nextBio    = patch.bio       === undefined ? existing.bio       : (patch.bio       || null);
  if (!pool) {
    const p = memProfiles.get(k)!;
    p.avatarUrl = nextAvatar;
    p.bio = nextBio;
    return p;
  }
  const { rows } = await pool.query(
    `UPDATE profiles SET avatar_url = $2, bio = $3 WHERE name_key = $1 RETURNING *`,
    [k, nextAvatar, nextBio],
  );
  return rowToProfile(rows[0]);
}

export async function getProfile(name: string): Promise<Profile | null> {
  const k = key(name);
  if (!pool) return memProfiles.get(k) ?? null;
  const { rows } = await pool.query(`SELECT * FROM profiles WHERE name_key = $1`, [k]);
  return rows[0] ? rowToProfile(rows[0]) : null;
}

export async function listProfiles(): Promise<Profile[]> {
  if (!pool) {
    return [...memProfiles.values()].sort((a, b) =>
      (b.wins - b.losses) - (a.wins - a.losses) || b.wins - a.wins);
  }
  const { rows } = await pool.query(
    `SELECT * FROM profiles ORDER BY (wins - losses) DESC, wins DESC LIMIT 200`,
  );
  return rows.map(rowToProfile);
}

/**
 * Record a match result idempotently keyed by matchID.
 * If the matchID was already recorded, this is a no-op (returns 'duplicate').
 */
export async function recordMatch(
  matchID: string, winner: string | null, loser: string | null, draw: boolean,
): Promise<'recorded' | 'duplicate'> {
  if (!matchID) throw new Error('matchID required');
  if (!pool) {
    if (recordedMatches.has(matchID)) return 'duplicate';
    recordedMatches.add(matchID);
    if (winner) await upsertProfile(winner);
    if (loser)  await upsertProfile(loser);
    if (draw) {
      if (winner) memProfiles.get(key(winner))!.draws  += 1;
      if (loser)  memProfiles.get(key(loser))!.draws   += 1;
    } else {
      if (winner) memProfiles.get(key(winner))!.wins   += 1;
      if (loser)  memProfiles.get(key(loser))!.losses  += 1;
    }
    return 'recorded';
  }
  // Try insert; if matchID exists, do nothing.
  const insert = await pool.query(
    `INSERT INTO recorded_matches (match_id, winner, loser, draw, recorded_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (match_id) DO NOTHING
     RETURNING match_id`,
    [matchID, winner, loser, draw, Date.now()],
  );
  if (insert.rowCount === 0) return 'duplicate';
  // Make sure profiles exist, then bump counts.
  if (winner) await upsertProfile(winner);
  if (loser)  await upsertProfile(loser);
  if (draw) {
    if (winner) await pool.query(`UPDATE profiles SET draws = draws + 1 WHERE name_key = $1`, [key(winner)]);
    if (loser)  await pool.query(`UPDATE profiles SET draws = draws + 1 WHERE name_key = $1`, [key(loser)]);
  } else {
    if (winner) await pool.query(`UPDATE profiles SET wins   = wins   + 1 WHERE name_key = $1`, [key(winner)]);
    if (loser)  await pool.query(`UPDATE profiles SET losses = losses + 1 WHERE name_key = $1`, [key(loser)]);
  }
  return 'recorded';
}
