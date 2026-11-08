// src/api/config.ts
//
// The ONE place that knows where the backend lives.
//
// No other module in the app may hardcode an API URL. If you find yourself
// typing `https://api.ocva.online` or `http://localhost:8080` anywhere else,
// import `API_BASE` instead.
//
// Configured via Vite env at build time (INTEGRATION.md §8):
//
//   .env.production   VITE_API_BASE=/gw   (TRACKED in git — see below)
//   .env.development  VITE_API_BASE=http://localhost:8080
//
// Production does NOT point at `https://api.ocva.online` directly. It uses the
// same-origin path `/gw`, which Vercel rewrites to the gateway (see the
// `rewrites` block in `vercel.json`); keeping API calls same-origin avoids CORS
// preflights and keeps the gateway origin out of the bundle. `.env.production`
// is TRACKED, not git-ignored (`.gitignore` has `!.env.production`), so a fresh
// clone builds with `/gw` already set.
//
// WebSockets are the exception: Vercel rewrites do not carry them, so the
// socket needs an ABSOLUTE gateway URL — `VITE_SOCKET_URL`, falling back to
// `API_BASE` when that is already absolute. See `SOCKET_URL` below.
//
// When no base is configured at all, this module throws at import rather than
// silently defaulting to production — a staging deploy that forgets the env var
// must fail loudly, not quietly write to the production database. Localhost is
// the one origin allowed to default (to the local gateway) with no env var.

/**
 * Read a `VITE_*` variable in a way that survives both Vite (`import.meta.env`)
 * and plain Node (`process.env`) — the latter matters for the vitest suite and
 * for any `npx tsx` script that imports this layer.
 *
 * Exported because it is the ONLY sanctioned way to read build-time config in
 * this app. A second copy of this three-line dance is how one reader ends up
 * looking at `import.meta.env` while another looks at `process.env` and the two
 * disagree about whether a key is present. If you need a new `VITE_*` value,
 * import this — do not re-implement it. (`src/privy/env.ts` is the other
 * caller.)
 */
export function readEnv(key: string): string | undefined {
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromVite = viteEnv?.[key];
  if (typeof fromVite === 'string' && fromVite.length > 0) return fromVite;

  // `process` is not defined in a browser bundle unless polyfilled; guard it.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const fromNode = proc?.env?.[key];
  if (typeof fromNode === 'string' && fromNode.length > 0) return fromNode;

  return undefined;
}

/** Strip any trailing slash so `${API_BASE}/auth/nonce` never doubles up. */
function normaliseBase(raw: string): string {
  return raw.replace(/\/+$/, '');
}

/**
 * Base URL of the gateway. Every request in `src/api/**` is built as
 * `${API_BASE}${path}` where `path` always starts with `/`.
 */
/**
 * Resolve the base when `VITE_API_BASE` is unset.
 *
 * A localhost origin (and a non-browser context such as the test runner, where
 * there is no `location`) defaults to the local gateway. A build served from
 * any OTHER real origin with no configured base is a misconfiguration: rather
 * than silently default to production — which is how a staging deploy ends up
 * writing to the production database — throw so the mistake surfaces at build/
 * boot instead of in a user's browser. Set `VITE_API_BASE` (e.g. `/gw`).
 */
function resolveBase(): string {
  const explicit = readEnv('VITE_API_BASE');
  if (explicit) return explicit;
  const host = (globalThis as { location?: { hostname?: string } }).location?.hostname;
  const isLocal = host === undefined || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (isLocal) return 'http://localhost:8080';
  throw new Error(
    `VITE_API_BASE is not set and this is not a localhost origin (${host}). ` +
      'Refusing to default to production — set VITE_API_BASE (production uses "/gw").',
  );
}

export const API_BASE: string = normaliseBase(resolveBase());

/**
 * Read-only JSON-RPC endpoint (INTEGRATION.md §8.5). Point viem/ethers here
 * instead of at a provider URL — no RPC credential may appear in the bundle.
 *
 * It is READ ONLY: `eth_sendRawTransaction`, `eth_sendTransaction`, `eth_sign`,
 * `personal_sign` and `eth_accounts` are refused with 403. The browser must
 * broadcast through the user's own wallet provider.
 */
export const RPC_URL: string = `${API_BASE}/rpc/evm`;

/**
 * boardgame.io socket.io transport. Pass this as the `server` option to the
 * SocketIO transport.
 *
 * It must be an ABSOLUTE gateway URL even when `API_BASE` is a same-origin
 * proxy path (e.g. `/gw` — see vercel.json): Vercel rewrites do not carry
 * WebSockets, so the socket connects to the gateway directly. That is safe on
 * any origin because the client is forced onto the websocket transport (see
 * MatchSeat in App.tsx), and browsers apply no CORS allow-list to WebSockets.
 * `VITE_SOCKET_URL` overrides; otherwise an absolute `API_BASE` is reused.
 */
export const SOCKET_URL: string = normaliseBase(
  readEnv('VITE_SOCKET_URL') ?? (/^https?:\/\//.test(API_BASE) ? API_BASE : 'https://api.ocva.online'),
);

/** Build an absolute API URL from a leading-slash path. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}
