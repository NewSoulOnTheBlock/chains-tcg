// Who is online right now, as a Vercel function.
//
// The hub used to show "N players online" where N was the number of profiles
// ever created. This counts real presence instead: every signed-in client
// sends a heartbeat while the game is open, and "online" means a heartbeat in
// the last ONLINE_WINDOW_S seconds.
//
// Identity works like api/chat.ts: the heartbeat carries the player's normal
// bearer token and we ask the gateway who that is, so a client cannot inflate
// the count by inventing ids. One row per profile, so many tabs count once.
//
// GET  /api/presence → { online }
// POST /api/presence → { online }   (heartbeat; needs Authorization)

import pg from 'pg';

const GATEWAY = process.env.CHAT_GATEWAY ?? 'https://api.ocva.online';
/** Clients beat every 30s; allow one missed beat before dropping someone. */
const ONLINE_WINDOW_S = 75;

let pool: pg.Pool | null = null;
function db(): pg.Pool {
  if (!pool) {
    const url = process.env.CHAT_DATABASE_URL;
    if (!url) throw new Error('CHAT_DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: url, max: 2, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

let ready: Promise<unknown> | null = null;
function ensureTable(): Promise<unknown> {
  ready ??= db().query(`
    CREATE TABLE IF NOT EXISTS player_presence (
      profile_id text PRIMARY KEY,
      last_seen  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS player_presence_last_seen ON player_presence (last_seen);
  `).catch((e) => { ready = null; throw e; });
  return ready;
}

// Warm instances reuse this: a heartbeat every 30s costs one gateway call per
// player per few minutes, not one per beat.
const idCache = new Map<string, { id: string; exp: number }>();

async function profileId(auth: string | null): Promise<string | null> {
  if (!auth?.startsWith('Bearer ')) return null;
  const hit = idCache.get(auth);
  if (hit && hit.exp > Date.now()) return hit.id;
  const res = await fetch(`${GATEWAY}/api/profiles/me`, { headers: { Authorization: auth } });
  if (!res.ok) return null;
  const { profile } = (await res.json()) as { profile?: { id: string } };
  if (!profile?.id) return null;
  if (idCache.size > 5000) idCache.clear();
  idCache.set(auth, { id: String(profile.id), exp: Date.now() + 5 * 60_000 });
  return String(profile.id);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function countOnline(): Promise<number> {
  const { rows } = await db().query(
    `SELECT count(*)::int AS n FROM player_presence WHERE last_seen > now() - make_interval(secs => $1)`,
    [ONLINE_WINDOW_S],
  );
  return rows[0]?.n ?? 0;
}

export async function GET(): Promise<Response> {
  await ensureTable();
  return json({ online: await countOnline() });
}

export async function POST(req: Request): Promise<Response> {
  await ensureTable();
  const id = await profileId(req.headers.get('authorization')).catch(() => null);
  if (!id) return json({ error: 'sign in to report presence' }, 401);
  await db().query(
    `INSERT INTO player_presence (profile_id, last_seen) VALUES ($1, now())
     ON CONFLICT (profile_id) DO UPDATE SET last_seen = now()`,
    [id],
  );
  // Rows older than a day are dead weight; prune opportunistically (~1 in 50 beats).
  if (Math.random() < 0.02) {
    await db().query(`DELETE FROM player_presence WHERE last_seen < now() - interval '1 day'`).catch(() => {});
  }
  return json({ online: await countOnline() });
}
