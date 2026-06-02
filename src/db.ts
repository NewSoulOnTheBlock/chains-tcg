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
  walletAddress: string | null;
  walletChain: string | null;
};

const DATABASE_URL = process.env.DATABASE_URL;
let pool: pg.Pool | null = null;

// Fallback in-memory store (for local dev without Postgres).
const memProfiles: Map<string, Profile> = new Map();
const recordedMatches: Set<string> = new Set(); // matchID dedupe for in-memory mode

/** Exposed for the ranked subsystem so it can share the same Pool. */
export function getPool(): pg.Pool | null { return pool; }

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
      bio        TEXT,
      wallet_address TEXT,
      wallet_chain   TEXT,
      custom_deck    TEXT
    );
  `);
  // Migrate older deployments that pre-date avatar_url/bio/wallet/deck columns.
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT;`);
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wallet_address TEXT;`);
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wallet_chain TEXT;`);
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS custom_deck TEXT;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS profiles_wallet_idx ON profiles (LOWER(wallet_address)) WHERE wallet_address IS NOT NULL;`);
  // Deck Library: per-profile named decks + active pointer.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decks (
      id          SERIAL PRIMARY KEY,
      profile_key TEXT NOT NULL REFERENCES profiles(name_key) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      cards       JSONB NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now(),
      UNIQUE(profile_key, name)
    );
  `);
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS active_deck_id INT REFERENCES decks(id) ON DELETE SET NULL;`);
  // One-time migration: hoist every legacy custom_deck JSON into a "Default" deck row.
  await pool.query(`
    INSERT INTO decks (profile_key, name, cards)
    SELECT p.name_key, 'Default', p.custom_deck::jsonb
      FROM profiles p
     WHERE p.custom_deck IS NOT NULL
       AND p.active_deck_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM decks d WHERE d.profile_key = p.name_key AND d.name = 'Default')
    ON CONFLICT (profile_key, name) DO NOTHING;
  `);
  await pool.query(`
    UPDATE profiles p
       SET active_deck_id = d.id
      FROM decks d
     WHERE d.profile_key = p.name_key
       AND d.name = 'Default'
       AND p.active_deck_id IS NULL;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recorded_matches (
      match_id   TEXT PRIMARY KEY,
      winner     TEXT,
      loser      TEXT,
      draw       BOOLEAN NOT NULL DEFAULT FALSE,
      recorded_at BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS challenges (
      id            TEXT PRIMARY KEY,
      from_key      TEXT NOT NULL,
      from_name     TEXT NOT NULL,
      to_key        TEXT NOT NULL,
      to_name       TEXT NOT NULL,
      match_id      TEXT NOT NULL,
      wager_kind    TEXT NOT NULL DEFAULT 'free',
      wager_amount  INTEGER,
      message       TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    BIGINT NOT NULL,
      expires_at    BIGINT NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS challenges_to_idx   ON challenges (to_key, status, expires_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS challenges_from_idx ON challenges (from_key, status, expires_at);`);
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
    walletAddress: r.wallet_address ?? null,
    walletChain: r.wallet_chain ?? null,
  };
}

export async function upsertProfile(name: string): Promise<Profile> {
  const n = name.trim();
  if (!n) throw new Error('Profile name required');
  const k = key(n);
  if (!pool) {
    let p = memProfiles.get(k);
    if (!p) { p = { name: n, wins: 0, losses: 0, draws: 0, createdAt: Date.now(), avatarUrl: null, bio: null, walletAddress: null, walletChain: null }; memProfiles.set(k, p); }
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

/** Update editable profile fields (avatar URL, bio, wallet). Creates the row if it doesn't exist. */
export async function updateProfile(
  name: string,
  patch: { avatarUrl?: string | null; bio?: string | null; walletAddress?: string | null; walletChain?: string | null },
): Promise<Profile> {
  const existing = await upsertProfile(name);
  const k = key(name);
  const nextAvatar = patch.avatarUrl === undefined ? existing.avatarUrl : (patch.avatarUrl || null);
  const nextBio    = patch.bio       === undefined ? existing.bio       : (patch.bio       || null);
  const nextWallet = patch.walletAddress === undefined ? existing.walletAddress : (patch.walletAddress || null);
  const nextChain  = patch.walletChain   === undefined ? existing.walletChain   : (patch.walletChain   || null);
  if (!pool) {
    const p = memProfiles.get(k)!;
    p.avatarUrl = nextAvatar;
    p.bio = nextBio;
    p.walletAddress = nextWallet;
    p.walletChain = nextChain;
    return p;
  }
  const { rows } = await pool.query(
    `UPDATE profiles SET avatar_url = $2, bio = $3, wallet_address = $4, wallet_chain = $5 WHERE name_key = $1 RETURNING *`,
    [k, nextAvatar, nextBio, nextWallet, nextChain],
  );
  return rowToProfile(rows[0]);
}

/** Look up profile by linked wallet address (case-insensitive). */
export async function getProfileByWallet(addr: string): Promise<Profile | null> {
  const a = (addr || '').trim().toLowerCase();
  if (!a) return null;
  if (!pool) {
    for (const p of memProfiles.values()) {
      if (p.walletAddress && p.walletAddress.toLowerCase() === a) return p;
    }
    return null;
  }
  const { rows } = await pool.query(
    `SELECT * FROM profiles WHERE LOWER(wallet_address) = $1 LIMIT 1`,
    [a],
  );
  return rows[0] ? rowToProfile(rows[0]) : null;
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

// ── Custom decks / Deck Library ─────────────────────────────────────────────

export type DeckEntry = { id: number; name: string; cards: string[]; isActive: boolean };

// In-memory fallback: per-profile map of {id,name,cards} + active pointer.
type MemDeckRow = { id: number; name: string; cards: string[] };
const memDecksByProfile: Map<string, MemDeckRow[]>  = new Map();
const memActiveDeckId:   Map<string, number>        = new Map();
let _memDeckId = 0;

function memList(k: string): MemDeckRow[] {
  if (!memDecksByProfile.has(k)) memDecksByProfile.set(k, []);
  return memDecksByProfile.get(k)!;
}

export async function listDecks(name: string): Promise<DeckEntry[]> {
  const k = key(name);
  if (!pool) {
    const list = memList(k);
    const active = memActiveDeckId.get(k);
    return list.map(d => ({ id: d.id, name: d.name, cards: [...d.cards], isActive: d.id === active }));
  }
  const { rows } = await pool.query(
    `SELECT d.id, d.name, d.cards,
            (p.active_deck_id = d.id) AS is_active
       FROM decks d
       JOIN profiles p ON p.name_key = d.profile_key
      WHERE d.profile_key = $1
      ORDER BY d.created_at ASC, d.id ASC`,
    [k],
  );
  return rows.map(r => ({
    id: Number(r.id),
    name: String(r.name),
    cards: Array.isArray(r.cards) ? (r.cards as any[]).map(String) : [],
    isActive: !!r.is_active,
  }));
}

export async function createDeck(name: string, deckName: string, cards: string[]): Promise<DeckEntry> {
  const n = name.trim();
  const dn = deckName.trim();
  if (!n)  throw new Error('Profile name required');
  if (!dn) throw new Error('Deck name required');
  await upsertProfile(n);
  const k = key(n);
  if (!pool) {
    const list = memList(k);
    if (list.some(d => d.name.toLowerCase() === dn.toLowerCase())) {
      throw new Error('A deck with that name already exists.');
    }
    _memDeckId += 1;
    const row: MemDeckRow = { id: _memDeckId, name: dn, cards: [...cards] };
    list.push(row);
    if (!memActiveDeckId.has(k)) memActiveDeckId.set(k, row.id);
    return { id: row.id, name: row.name, cards: [...row.cards], isActive: memActiveDeckId.get(k) === row.id };
  }
  const { rows } = await pool.query(
    `INSERT INTO decks (profile_key, name, cards) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [k, dn, JSON.stringify(cards)],
  );
  const id = Number(rows[0].id);
  // If profile has no active deck yet, set this one.
  await pool.query(
    `UPDATE profiles SET active_deck_id = $2 WHERE name_key = $1 AND active_deck_id IS NULL`,
    [k, id],
  );
  const all = await listDecks(n);
  return all.find(d => d.id === id) ?? { id, name: dn, cards: [...cards], isActive: false };
}

export async function updateDeck(
  name: string, deckId: number, patch: { name?: string; cards?: string[] },
): Promise<DeckEntry> {
  const k = key(name);
  if (!pool) {
    const list = memList(k);
    const row = list.find(d => d.id === deckId);
    if (!row) throw new Error('Deck not found');
    if (patch.name !== undefined) {
      const dn = patch.name.trim();
      if (!dn) throw new Error('Deck name required');
      if (list.some(d => d.id !== deckId && d.name.toLowerCase() === dn.toLowerCase())) {
        throw new Error('A deck with that name already exists.');
      }
      row.name = dn;
    }
    if (patch.cards) row.cards = [...patch.cards];
    return { id: row.id, name: row.name, cards: [...row.cards], isActive: memActiveDeckId.get(k) === row.id };
  }
  const sets: string[] = [];
  const args: any[] = [deckId, k];
  if (patch.name !== undefined) {
    const dn = patch.name.trim();
    if (!dn) throw new Error('Deck name required');
    args.push(dn); sets.push(`name = $${args.length}`);
  }
  if (patch.cards !== undefined) {
    args.push(JSON.stringify(patch.cards)); sets.push(`cards = $${args.length}::jsonb`);
  }
  if (sets.length === 0) {
    const all = await listDecks(name);
    const d = all.find(x => x.id === deckId);
    if (!d) throw new Error('Deck not found');
    return d;
  }
  sets.push(`updated_at = now()`);
  const { rowCount } = await pool.query(
    `UPDATE decks SET ${sets.join(', ')} WHERE id = $1 AND profile_key = $2`,
    args,
  );
  if (rowCount === 0) throw new Error('Deck not found');
  const all = await listDecks(name);
  const d = all.find(x => x.id === deckId);
  if (!d) throw new Error('Deck not found');
  return d;
}

export async function deleteDeck(name: string, deckId: number): Promise<void> {
  const k = key(name);
  if (!pool) {
    const list = memList(k);
    const idx = list.findIndex(d => d.id === deckId);
    if (idx < 0) throw new Error('Deck not found');
    list.splice(idx, 1);
    if (memActiveDeckId.get(k) === deckId) {
      const fallback = list[0]?.id;
      if (fallback != null) memActiveDeckId.set(k, fallback);
      else memActiveDeckId.delete(k);
    }
    return;
  }
  // If the active deck is being deleted, fall back to whatever remains (or null).
  const wasActive = await pool.query(
    `SELECT 1 FROM profiles WHERE name_key = $1 AND active_deck_id = $2`,
    [k, deckId],
  );
  await pool.query(`DELETE FROM decks WHERE id = $1 AND profile_key = $2`, [deckId, k]);
  if ((wasActive.rowCount ?? 0) > 0) {
    const { rows } = await pool.query(
      `SELECT id FROM decks WHERE profile_key = $1 ORDER BY created_at ASC, id ASC LIMIT 1`,
      [k],
    );
    const fallback = rows[0]?.id ?? null;
    await pool.query(`UPDATE profiles SET active_deck_id = $2 WHERE name_key = $1`, [k, fallback]);
  }
}

export async function activateDeck(name: string, deckId: number): Promise<DeckEntry> {
  const k = key(name);
  if (!pool) {
    const list = memList(k);
    if (!list.some(d => d.id === deckId)) throw new Error('Deck not found');
    memActiveDeckId.set(k, deckId);
    const row = list.find(d => d.id === deckId)!;
    return { id: row.id, name: row.name, cards: [...row.cards], isActive: true };
  }
  const { rowCount } = await pool.query(
    `UPDATE profiles p SET active_deck_id = $2
       FROM decks d
      WHERE p.name_key = $1 AND d.id = $2 AND d.profile_key = $1`,
    [k, deckId],
  );
  if (rowCount === 0) throw new Error('Deck not found');
  const all = await listDecks(name);
  const d = all.find(x => x.id === deckId);
  if (!d) throw new Error('Deck not found');
  return d;
}

/**
 * Back-compat: return the player's active deck cards (or null).
 * Existing callers (Game.ts, ranked queue-service, joinMatch flow, etc.)
 * keep working without modification.
 */
export async function getDeck(name: string): Promise<string[] | null> {
  const k = key(name);
  if (!pool) {
    const active = memActiveDeckId.get(k);
    if (active == null) return null;
    const row = memList(k).find(d => d.id === active);
    return row ? [...row.cards] : null;
  }
  const { rows } = await pool.query(
    `SELECT d.cards
       FROM profiles p JOIN decks d ON d.id = p.active_deck_id
      WHERE p.name_key = $1`,
    [k],
  );
  const raw = rows[0]?.cards;
  if (!raw) return null;
  return Array.isArray(raw) ? (raw as any[]).map(String) : null;
}

/**
 * Back-compat: save into the player's active deck (creating one named "Default"
 * if they have none). Old call sites assumed "the deck" and shouldn't break.
 */
export async function saveDeck(name: string, cards: string[]): Promise<void> {
  const n = name.trim();
  if (!n) throw new Error('Profile name required');
  await upsertProfile(n);
  const k = key(n);
  if (!pool) {
    const active = memActiveDeckId.get(k);
    if (active != null) {
      const row = memList(k).find(d => d.id === active);
      if (row) { row.cards = [...cards]; return; }
    }
    // Otherwise create a Default deck and activate it.
    await createDeck(n, 'Default', cards);
    return;
  }
  // Find active deck id; if none, create + activate a Default.
  const { rows } = await pool.query(
    `SELECT active_deck_id FROM profiles WHERE name_key = $1`, [k],
  );
  const activeId: number | null = rows[0]?.active_deck_id ?? null;
  if (activeId) {
    await pool.query(
      `UPDATE decks SET cards = $3::jsonb, updated_at = now() WHERE id = $1 AND profile_key = $2`,
      [activeId, k, JSON.stringify(cards)],
    );
    return;
  }
  await createDeck(n, 'Default', cards);
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


// ── Challenges (direct player-to-player invites) ────────────────────────────

export type Challenge = {
  id: string;
  fromName: string;
  toName: string;
  matchId: string;
  wagerKind: 'free' | 'master';
  wagerAmount: number | null;
  message: string | null;
  status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';
  createdAt: number;
  expiresAt: number;
};

const memChallenges: Map<string, Challenge> = new Map();
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 min

function rowToChallenge(r: any): Challenge {
  return {
    id: r.id,
    fromName: r.from_name,
    toName: r.to_name,
    matchId: r.match_id,
    wagerKind: (r.wager_kind === 'master' ? 'master' : 'free') as 'free' | 'master',
    wagerAmount: r.wager_amount == null ? null : Number(r.wager_amount),
    message: r.message ?? null,
    status: r.status,
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
  };
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Create a new challenge from romName to 	oName. Recipient must exist as a profile. */
export async function createChallenge(args: {
  fromName: string;
  toName: string;
  matchId: string;
  wagerKind: 'free' | 'master';
  wagerAmount: number | null;
  message: string | null;
}): Promise<Challenge> {
  const now = Date.now();
  const id = genId();
  const ch: Challenge = {
    id,
    fromName: args.fromName,
    toName: args.toName,
    matchId: args.matchId,
    wagerKind: args.wagerKind,
    wagerAmount: args.wagerAmount,
    message: args.message,
    status: 'pending',
    createdAt: now,
    expiresAt: now + CHALLENGE_TTL_MS,
  };
  if (!pool) { memChallenges.set(id, ch); return ch; }
  await pool.query(
    `INSERT INTO challenges
       (id, from_key, from_name, to_key, to_name, match_id, wager_kind, wager_amount, message, status, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11)`,
    [id, key(args.fromName), args.fromName, key(args.toName), args.toName,
     args.matchId, args.wagerKind, args.wagerAmount, args.message, now, now + CHALLENGE_TTL_MS],
  );
  return ch;
}

async function reapExpired(): Promise<void> {
  const now = Date.now();
  if (!pool) {
    for (const [id, c] of memChallenges) {
      if (c.status === 'pending' && c.expiresAt < now) { c.status = 'expired'; memChallenges.set(id, c); }
    }
    return;
  }
  await pool.query(`UPDATE challenges SET status = 'expired' WHERE status = 'pending' AND expires_at < $1`, [now]);
}

export async function listIncomingChallenges(toName: string): Promise<Challenge[]> {
  await reapExpired();
  if (!pool) {
    return [...memChallenges.values()].filter(c => key(c.toName) === key(toName) && c.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  const r = await pool.query(
    `SELECT * FROM challenges WHERE to_key = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 50`,
    [key(toName)],
  );
  return r.rows.map(rowToChallenge);
}

export async function listOutgoingChallenges(fromName: string): Promise<Challenge[]> {
  await reapExpired();
  if (!pool) {
    return [...memChallenges.values()].filter(c => key(c.fromName) === key(fromName) && c.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  const r = await pool.query(
    `SELECT * FROM challenges WHERE from_key = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 50`,
    [key(fromName)],
  );
  return r.rows.map(rowToChallenge);
}

export async function getChallenge(id: string): Promise<Challenge | null> {
  if (!pool) return memChallenges.get(id) ?? null;
  const r = await pool.query(`SELECT * FROM challenges WHERE id = $1`, [id]);
  if (!r.rowCount) return null;
  return rowToChallenge(r.rows[0]);
}

export async function updateChallengeStatus(
  id: string,
  newStatus: Challenge['status'],
  actor: { name: string; role: 'from' | 'to' },
): Promise<Challenge | null> {
  if (!pool) {
    const c = memChallenges.get(id);
    if (!c || c.status !== 'pending') return c ?? null;
    const expectedName = actor.role === 'from' ? c.fromName : c.toName;
    if (key(expectedName) !== key(actor.name)) return null;
    c.status = newStatus; memChallenges.set(id, c); return c;
  }
  const col = actor.role === 'from' ? 'from_key' : 'to_key';
  const r = await pool.query(
    `UPDATE challenges SET status = $1 WHERE id = $2 AND status = 'pending' AND ${col} = $3 RETURNING *`,
    [newStatus, id, key(actor.name)],
  );
  if (!r.rowCount) return null;
  return rowToChallenge(r.rows[0]);
}

