// Global chat + announcements for the hub, as a Vercel function.
//
// ─── WHY THIS LIVES HERE AND NOT ON THE GAME SERVER ─────────────────────────
// api.ocva.online is a server we cannot deploy to, so chat gets its own small
// store (Neon, CHAT_DATABASE_URL) next to the static site. Identity still comes
// from the game server: a POST carries the player's normal bearer token, and we
// ask the gateway `GET /api/profiles/me` who that is. The client never tells us
// its own name, so it cannot post as someone else.
//
// ─── ANNOUNCEMENTS ──────────────────────────────────────────────────────────
// `kind: 'announce'` is accepted from either
//   • a signed-in player whose wallet address is in CHAT_ADMINS or whose
//     immutable profile id is in CHAT_ADMIN_IDS, or
//   • any caller presenting `x-chat-admin-key: <CHAT_ADMIN_KEY>` (for scripts),
//     compared in constant time and rate-limited per key.
//
// GET  /api/chat?after=<id>   → { messages, admin } newest-last; `after` = delta
// POST /api/chat { body, kind? }

import crypto from 'node:crypto';
import pg from 'pg';

const GATEWAY = process.env.CHAT_GATEWAY ?? 'https://api.ocva.online';
const MAX_LEN = 280;
const PAGE = 60;
/** One message per this many ms per author, and a per-minute ceiling. */
const MIN_GAP_MS = 2_500;
const PER_MINUTE = 12;
/** A modest ceiling for the admin-key (script) path, per key per minute. */
const KEY_PER_MINUTE = 30;
/** Hard ceiling on how long an identity may be cached (server-26). */
const WHO_CACHE_MAX_MS = 5 * 60_000;

let pool: pg.Pool | null = null;
function db(): pg.Pool {
  if (!pool) {
    const url = process.env.CHAT_DATABASE_URL;
    if (!url) throw new Error('CHAT_DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: url, max: 2, ssl: pgSsl() });
  }
  return pool;
}

// Verify the server's TLS certificate (server-24 / client-api-10). Neon serves a
// publicly-trusted chain, so `rejectUnauthorized: true` works against the system
// trust store with no extra config. If a deployment pins an explicit CA, set
// PG_CA to the PEM bundle; or put `?sslmode=verify-full` in CHAT_DATABASE_URL and
// pg will honour it. We NEVER fall back to rejectUnauthorized:false.
function pgSsl(): pg.PoolConfig['ssl'] {
  const ca = process.env.PG_CA;
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

const admins = (): Set<string> =>
  new Set((process.env.CHAT_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

// Admin is granted by IMMUTABLE profile id (server-23), not by display name.
// Display names are user-editable via the profile service, so keying admin on a
// name let anyone who claimed a freed name inherit announce rights. Set
// CHAT_ADMIN_IDS to a comma-separated list of profile ids (or use CHAT_ADMINS by
// wallet address).
const adminIds = (): Set<string> =>
  new Set((process.env.CHAT_ADMIN_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

// MIGRATION NOTE (name -> id): the previous admin was named by display name
// ('anoversizedmoosewithsocks'). To migrate, resolve that profile's id once and
// put it in CHAT_ADMIN_IDS. Until then this set exists ONLY to emit a one-time
// log pointing an operator at the id to add; it grants no privilege.
const LEGACY_NAME_ADMINS = new Set<string>(['anoversizedmoosewithsocks']);
const migrationLogged = new Set<string>();

interface Who { id: string; name: string; avatarUrl: string | null; address: string }

// Warm instances reuse this, so a chatty player costs one gateway call per
// few minutes rather than one per message. Keyed on a SHA-256 of the bearer
// token (never the raw token) and expired at min(5min, the JWT's own exp).
const whoCache = new Map<string, { who: Who; exp: number }>();

function tokenKey(auth: string): string {
  return crypto.createHash('sha256').update(auth).digest('hex');
}

/** The `exp` claim (ms) of a JWT bearer token, or null if unreadable. */
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

async function whoIs(auth: string | null): Promise<Who | null> {
  if (!auth?.startsWith('Bearer ')) return null;
  const k = tokenKey(auth);
  const hit = whoCache.get(k);
  if (hit && hit.exp > Date.now()) return hit.who;
  const res = await fetch(`${GATEWAY}/api/profiles/me`, { headers: { Authorization: auth } });
  if (!res.ok) return null;
  const { profile } = (await res.json()) as { profile?: { id: string; displayName: string; avatarUrl: string | null; address: string } };
  if (!profile?.id) return null;
  const who: Who = { id: String(profile.id), name: profile.displayName, avatarUrl: profile.avatarUrl, address: profile.address };
  noteMigration(who);
  // Cap the cache lifetime at the token's own expiry so a logged-out / expired
  // token stops resolving as this profile (server-26). Never cache a token that
  // is already expired.
  const now = Date.now();
  const exp = jwtExpMs(auth);
  const until = exp === null ? now + WHO_CACHE_MAX_MS : Math.min(now + WHO_CACHE_MAX_MS, exp);
  if (until > now) {
    if (whoCache.size > 2000) whoCache.clear();
    whoCache.set(k, { who, exp: until });
  }
  return who;
}

function noteMigration(who: Who): void {
  const name = (who.name ?? '').trim().toLowerCase();
  if (!LEGACY_NAME_ADMINS.has(name)) return;
  if (adminIds().has(who.id)) return;
  if (migrationLogged.has(who.id)) return;
  migrationLogged.add(who.id);
  console.warn(
    `[chat] admin migration: legacy name admin "${name}" resolves to profile id ${who.id}; ` +
      'add it to CHAT_ADMIN_IDS to restore announce rights (name-based admin has been removed).',
  );
}

const isAdmin = (who: Who | null): boolean =>
  !!who && (admins().has(who.address.toLowerCase()) || adminIds().has(who.id));

/** Constant-time string compare for the admin key (server-27). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Per-key sliding-window rate limit for the admin-key path (server-27). Keyed on
// a hash of the key so the raw key is not held in a map.
const keyBeats = new Map<string, number[]>();
function keyRateOk(keyStr: string): boolean {
  const h = crypto.createHash('sha256').update(keyStr).digest('hex');
  const now = Date.now();
  const arr = (keyBeats.get(h) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= KEY_PER_MINUTE) {
    keyBeats.set(h, arr);
    return false;
  }
  arr.push(now);
  keyBeats.set(h, arr);
  if (keyBeats.size > 1000) keyBeats.clear();
  return true;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const ROW = `id::text AS id, kind, author, avatar_url AS "avatarUrl", body, created_at AS "createdAt"`;

export async function GET(req: Request): Promise<Response> {
  const after = new URL(req.url).searchParams.get('after');
  const q = after && /^\d+$/.test(after)
    ? db().query(`SELECT ${ROW} FROM chat_messages WHERE id > $1 ORDER BY id ASC LIMIT ${PAGE}`, [after])
    : db().query(`SELECT * FROM (SELECT ${ROW} FROM chat_messages ORDER BY id DESC LIMIT ${PAGE}) t ORDER BY id ASC`);
  // `admin` lets the client show the announce toggle; the POST re-checks it.
  const [{ rows }, who] = await Promise.all([q, whoIs(req.headers.get('authorization')).catch(() => null)]);
  return json({ messages: rows, admin: isAdmin(who) });
}

export async function POST(req: Request): Promise<Response> {
  let payload: { body?: unknown; kind?: unknown };
  try { payload = await req.json(); } catch { return json({ error: 'bad_json' }, 400); }

  // Strip control characters and collapse whitespace runs; the client renders
  // text only, never HTML, so nothing here needs escaping.
  const body = String(payload.body ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!body) return json({ error: 'empty' }, 400);
  if (body.length > MAX_LEN) return json({ error: 'too_long', max: MAX_LEN }, 400);
  const kind = payload.kind === 'announce' ? 'announce' : 'chat';

  const key = process.env.CHAT_ADMIN_KEY;
  const provided = req.headers.get('x-chat-admin-key');
  const byKey = !!key && !!provided && safeEqual(provided, key);
  // A presented-but-wrong admin key is never treated as a signed-in user.
  if (!byKey && provided) return json({ error: 'unauthorized' }, 401);

  const who = byKey ? null : await whoIs(req.headers.get('authorization'));
  if (!byKey && !who) return json({ error: 'unauthorized' }, 401);
  if (kind === 'announce' && !byKey && !isAdmin(who)) return json({ error: 'forbidden' }, 403);

  // Rate-limit both the human path (per author) and the script path (per key).
  if (byKey) {
    if (!keyRateOk(key as string)) return json({ error: 'slow_down' }, 429);
  }

  const author = who?.name ?? 'EGREGORE';
  const authorId = who?.id ?? 'system';

  if (who && !isAdmin(who)) {
    const { rows: [r] } = await db().query(
      `SELECT count(*)::int AS n, max(created_at) AS last FROM chat_messages
        WHERE author_id = $1 AND created_at > now() - interval '1 minute'`, [authorId]);
    if (r.n >= PER_MINUTE || (r.last && Date.now() - new Date(r.last).getTime() < MIN_GAP_MS)) {
      return json({ error: 'slow_down' }, 429);
    }
  }

  const { rows: [msg] } = await db().query(
    `INSERT INTO chat_messages (kind, author, author_id, avatar_url, body) VALUES ($1,$2,$3,$4,$5) RETURNING ${ROW}`,
    [kind, author, authorId, who?.avatarUrl ?? null, body]);
  return json({ message: msg }, 201);
}
