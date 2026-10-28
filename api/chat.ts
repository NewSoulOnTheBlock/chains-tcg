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
//   • a signed-in player whose wallet address is in CHAT_ADMINS, or
//   • any caller presenting `x-chat-admin-key: <CHAT_ADMIN_KEY>` (for scripts).
//
// GET  /api/chat?after=<id>   → { messages, admin } newest-last; `after` = delta
// POST /api/chat { body, kind? }

import pg from 'pg';

const GATEWAY = process.env.CHAT_GATEWAY ?? 'https://api.ocva.online';
const MAX_LEN = 280;
const PAGE = 60;
/** One message per this many ms per author, and a per-minute ceiling. */
const MIN_GAP_MS = 2_500;
const PER_MINUTE = 12;

let pool: pg.Pool | null = null;
function db(): pg.Pool {
  if (!pool) {
    const url = process.env.CHAT_DATABASE_URL;
    if (!url) throw new Error('CHAT_DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString: url, max: 2, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

const admins = (): Set<string> =>
  new Set((process.env.CHAT_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

// Admins named by their profile display name, committed here so they don't need
// an env var. Matched case-insensitively against the gateway's `displayName`,
// which is server-resolved from the caller's token (see whoIs) — a client can't
// post under someone else's name to borrow admin.
const NAME_ADMINS = new Set<string>([
  'anoversizedmoosewithsocks',
]);

interface Who { id: string; name: string; avatarUrl: string | null; address: string }

// Warm instances reuse this, so a chatty player costs one gateway call per
// few minutes rather than one per message.
const whoCache = new Map<string, { who: Who; exp: number }>();

async function whoIs(auth: string | null): Promise<Who | null> {
  if (!auth?.startsWith('Bearer ')) return null;
  const hit = whoCache.get(auth);
  if (hit && hit.exp > Date.now()) return hit.who;
  const res = await fetch(`${GATEWAY}/api/profiles/me`, { headers: { Authorization: auth } });
  if (!res.ok) return null;
  const { profile } = (await res.json()) as { profile?: { id: string; displayName: string; avatarUrl: string | null; address: string } };
  if (!profile?.id) return null;
  const who = { id: String(profile.id), name: profile.displayName, avatarUrl: profile.avatarUrl, address: profile.address };
  if (whoCache.size > 2000) whoCache.clear();
  whoCache.set(auth, { who, exp: Date.now() + 5 * 60_000 });
  return who;
}

const isAdmin = (who: Who | null) =>
  !!who && (admins().has(who.address.toLowerCase()) || NAME_ADMINS.has((who.name ?? '').trim().toLowerCase()));

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
  const byKey = !!key && req.headers.get('x-chat-admin-key') === key;
  const who = byKey ? null : await whoIs(req.headers.get('authorization'));
  if (!byKey && !who) return json({ error: 'unauthorized' }, 401);
  if (kind === 'announce' && !byKey && !isAdmin(who)) return json({ error: 'forbidden' }, 403);

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
