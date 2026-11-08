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

import crypto from 'node:crypto';
import pg from 'pg';

const GATEWAY = process.env.CHAT_GATEWAY ?? 'https://api.ocva.online';
/** Clients beat every 30s; allow one missed beat before dropping someone. */
const ONLINE_WINDOW_S = 75;
/** Hard ceiling on how long an identity may be cached. */
const ID_CACHE_MAX_MS = 5 * 60_000;

let pool: pg.Pool | null = null;
function db(): pg.Pool {
  if (!pool) {
    const url = process.env.CHAT_DATABASE_URL;
    if (!url) throw new Error('CHAT_DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: url, max: 2, ssl: pgSsl() });
  }
  return pool;
}

// Verify the server's TLS certificate (client-api-10 / server-24). Neon serves a
// publicly-trusted chain, so `rejectUnauthorized: true` works with no extra
// config. Set PG_CA to a PEM bundle to pin an explicit CA, or put
// `?sslmode=verify-full` in CHAT_DATABASE_URL. We NEVER disable verification.
function pgSsl(): pg.PoolConfig['ssl'] {
  const ca = process.env.PG_CA;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

// Schema lives in a migration run once against the Neon CHAT database (see
// migrations/presence.sql); the request path does NO DDL (server-25). For a throwaway
// / preview database set PRESENCE_AUTOMIGRATE=1 to let the first request create
// the table; in production leave it unset.
let ready: Promise<unknown> | null = null;
function ensureTable(): Promise<unknown> {
  if (process.env.PRESENCE_AUTOMIGRATE !== '1') return Promise.resolve();
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
// player per few minutes, not one per beat. Keyed on a SHA-256 of the bearer
// token (never the raw token, client-api-10) and expired at min(5min, JWT exp).
const idCache = new Map<string, { id: string; exp: number }>();

function tokenKey(auth: string): string {
  return crypto.createHash('sha256').update(auth).digest('hex');
}

function jwtExpMs(auth: string): number | null {
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function profileId(auth: string | null): Promise<string | null> {
  if (!auth?.startsWith('Bearer ')) return null;
  const k = tokenKey(auth);
  const hit = idCache.get(k);
  if (hit && hit.exp > Date.now()) return hit.id;
  const res = await fetch(`${GATEWAY}/api/profiles/me`, { headers: { Authorization: auth } });
  if (!res.ok) return null;
  const { profile } = (await res.json()) as { profile?: { id: string } };
  if (!profile?.id) return null;
  const now = Date.now();
  const exp = jwtExpMs(auth);
  const until = exp === null ? now + ID_CACHE_MAX_MS : Math.min(now + ID_CACHE_MAX_MS, exp);
  if (until > now) {
    if (idCache.size > 5000) idCache.clear();
    idCache.set(k, { id: String(profile.id), exp: until });
  }
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
