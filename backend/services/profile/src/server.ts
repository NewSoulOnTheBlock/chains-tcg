// Chains TCG profile service — REST API for profiles, decks, matches and the
// leaderboard. Express + postgres, with a redis-cached leaderboard.
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { validateDeck } from '@chains/game-core';
import { pool } from './db';
import { cacheGet, cacheSet, cacheDel, redisHealthy } from './redis';

const PORT = Number(process.env.PORT) || 8001;
const LEADERBOARD_KEY = 'leaderboard';
const LEADERBOARD_TTL = 30; // seconds

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

type Profile = {
  id: number;
  name: string;
  wins: number;
  losses: number;
  avatarUrl: string | null;
  bio: string | null;
};
type Deck = { id: number; profile_id: number; name: string; cards: string[] };

// avatar_url/bio are aliased so every profile response carries camelCase keys.
const PROFILE_COLS = 'id, name, wins, losses, avatar_url AS "avatarUrl", bio';
const DECK_COLS = 'id, profile_id, name, cards, created_at, updated_at';

async function findProfile(name: string): Promise<Profile | null> {
  const r = await pool.query(
    `SELECT ${PROFILE_COLS} FROM profiles WHERE lower(name) = lower($1)`,
    [name],
  );
  return r.rows[0] ?? null;
}

// Wrap async handlers so rejections hit the express error middleware.
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

// ── Health ──────────────────────────────────────────────────────────────────
// Served at both /healthz (direct) and /api/healthz (through the gateway,
// which only proxies /api/* to this service).
const healthz = wrap(async (_req, res) => {
  let postgres = false;
  try {
    await pool.query('SELECT 1');
    postgres = true;
  } catch {
    /* reported as false */
  }
  res.json({ ok: true, postgres, redis: await redisHealthy() });
});
app.get('/healthz', healthz);
app.get('/api/healthz', healthz);

// ── Profiles ────────────────────────────────────────────────────────────────
app.post('/api/profiles', wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const existing = await findProfile(name);
  if (existing) return res.json(existing);
  // Case-insensitive unique index guards the race between find and insert.
  try {
    const r = await pool.query(
      `INSERT INTO profiles (name) VALUES ($1) RETURNING ${PROFILE_COLS}`,
      [name],
    );
    res.status(201).json(r.rows[0]);
  } catch (e: any) {
    if (e?.code === '23505') return res.json(await findProfile(name));
    throw e;
  }
}));

app.get('/api/profiles/:name', wrap(async (req, res) => {
  const profile = await findProfile(req.params.name);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  res.json(profile);
}));

app.patch('/api/profiles/:name', wrap(async (req, res) => {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (req.body?.avatarUrl !== undefined) {
    const avatarUrl =
      req.body.avatarUrl === null ? '' : String(req.body.avatarUrl).trim();
    if (avatarUrl.length > 1024) {
      return res.status(400).json({ error: 'avatarUrl too long (max 1024)' });
    }
    values.push(avatarUrl || null);
    sets.push(`avatar_url = $${values.length}`);
  }
  if (req.body?.bio !== undefined) {
    const bio = req.body.bio === null ? '' : String(req.body.bio).trim();
    if (bio.length > 500) {
      return res.status(400).json({ error: 'bio too long (max 500)' });
    }
    values.push(bio || null);
    sets.push(`bio = $${values.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
  values.push(req.params.name);
  const r = await pool.query(
    `UPDATE profiles SET ${sets.join(', ')}
     WHERE lower(name) = lower($${values.length}) RETURNING ${PROFILE_COLS}`,
    values,
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'profile not found' });
  res.json(r.rows[0] as Profile);
}));

// Recent matches for a profile, newest first, opponent resolved to a name.
app.get('/api/profiles/:name/matches', wrap(async (req, res) => {
  const profile = await findProfile(req.params.name);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const r = await pool.query(
    `SELECT m.id,
            COALESCE(op.name, 'Unknown') AS opponent,
            CASE WHEN m.winner_id = $1 THEN 'win' ELSE 'loss' END AS result,
            m.mode,
            m.created_at AS "createdAt"
     FROM matches m
     LEFT JOIN profiles op
       ON op.id = CASE WHEN m.winner_id = $1 THEN m.loser_id ELSE m.winner_id END
     WHERE m.winner_id = $1 OR m.loser_id = $1
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $2`,
    [profile.id, limit],
  );
  res.json(r.rows);
}));

// ── Decks ───────────────────────────────────────────────────────────────────
app.get('/api/profiles/:name/decks', wrap(async (req, res) => {
  const profile = await findProfile(req.params.name);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  const r = await pool.query(
    `SELECT ${DECK_COLS} FROM decks WHERE profile_id = $1 ORDER BY id`,
    [profile.id],
  );
  res.json(r.rows as Deck[]);
}));

app.post('/api/profiles/:name/decks', wrap(async (req, res) => {
  const profile = await findProfile(req.params.name);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  const deckName = String(req.body?.name ?? '').trim();
  if (!deckName) return res.status(400).json({ error: 'deck name required' });
  if (!Array.isArray(req.body?.cards)) {
    return res.status(400).json({ error: 'cards[] required' });
  }
  const cards = (req.body.cards as unknown[]).map(String);
  const v = validateDeck(cards);
  if (!v.ok) return res.status(400).json({ error: 'invalid deck', issues: v.issues });
  const r = await pool.query(
    `INSERT INTO decks (profile_id, name, cards) VALUES ($1, $2, $3) RETURNING ${DECK_COLS}`,
    [profile.id, deckName, JSON.stringify(cards)],
  );
  res.status(201).json(r.rows[0]);
}));

app.put('/api/decks/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid deck id' });
  const sets: string[] = [];
  const values: unknown[] = [];
  if (req.body?.name !== undefined) {
    const deckName = String(req.body.name).trim();
    if (!deckName) return res.status(400).json({ error: 'deck name cannot be empty' });
    values.push(deckName);
    sets.push(`name = $${values.length}`);
  }
  if (req.body?.cards !== undefined) {
    if (!Array.isArray(req.body.cards)) {
      return res.status(400).json({ error: 'cards must be an array' });
    }
    const cards = (req.body.cards as unknown[]).map(String);
    const v = validateDeck(cards);
    if (!v.ok) return res.status(400).json({ error: 'invalid deck', issues: v.issues });
    values.push(JSON.stringify(cards));
    sets.push(`cards = $${values.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });
  values.push(id);
  const r = await pool.query(
    `UPDATE decks SET ${sets.join(', ')}, updated_at = now()
     WHERE id = $${values.length} RETURNING ${DECK_COLS}`,
    values,
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'deck not found' });
  res.json(r.rows[0]);
}));

app.delete('/api/decks/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid deck id' });
  const r = await pool.query('DELETE FROM decks WHERE id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'deck not found' });
  res.json({ ok: true });
}));

// ── Matches ─────────────────────────────────────────────────────────────────
app.post('/api/matches', wrap(async (req, res) => {
  const winner = String(req.body?.winner ?? '').trim();
  const loser = String(req.body?.loser ?? '').trim();
  const mode = String(req.body?.mode ?? 'casual').trim() || 'casual';
  if (!winner || !loser) {
    return res.status(400).json({ error: 'winner and loser required' });
  }
  if (winner.toLowerCase() === loser.toLowerCase()) {
    return res.status(400).json({ error: 'winner and loser must differ' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const w = await client.query(
      `UPDATE profiles SET wins = wins + 1
       WHERE lower(name) = lower($1) RETURNING id`,
      [winner],
    );
    const l = await client.query(
      `UPDATE profiles SET losses = losses + 1
       WHERE lower(name) = lower($1) RETURNING id`,
      [loser],
    );
    if (w.rowCount === 0 || l.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: `profile not found: ${w.rowCount === 0 ? winner : loser}`,
      });
    }
    const m = await client.query(
      `INSERT INTO matches (winner_id, loser_id, mode) VALUES ($1, $2, $3)
       RETURNING id, winner_id, loser_id, mode, created_at`,
      [w.rows[0].id, l.rows[0].id, mode],
    );
    await client.query('COMMIT');
    await cacheDel(LEADERBOARD_KEY);
    res.status(201).json(m.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// ── Leaderboard ─────────────────────────────────────────────────────────────
app.get('/api/leaderboard', wrap(async (_req, res) => {
  const cached = await cacheGet(LEADERBOARD_KEY);
  if (cached) {
    res.type('application/json').send(cached);
    return;
  }
  const r = await pool.query(
    `SELECT ${PROFILE_COLS} FROM profiles ORDER BY wins DESC, losses ASC, name ASC LIMIT 50`,
  );
  const body = JSON.stringify(r.rows);
  await cacheSet(LEADERBOARD_KEY, body, LEADERBOARD_TTL);
  res.type('application/json').send(body);
}));

// ── Fallthrough + errors ────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[profile] unhandled error', err);
  res.status(500).json({ error: 'internal error' });
});

// ── Startup ─────────────────────────────────────────────────────────────────
// Idempotent schema top-up: the postgres volume may predate columns that
// init.sql now declares (init.sql only runs on first boot of the volume).
async function ensureSchema() {
  await pool.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url text');
  await pool.query('ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio text');
}

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[profile] Chains TCG profile service listening on :${PORT}`);
    });
  })
  .catch(err => {
    console.error('[profile] ensure-schema failed', err);
    process.exit(1);
  });
