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
//   .env.production   VITE_API_BASE=https://api.ocva.online
//   .env.development  VITE_API_BASE=http://localhost:8080
//
// The default is the local gateway, so a developer who has never created a
// `.env` file talks to their own docker-compose stack rather than accidentally
// writing to the production database.

/**
 * Read a `VITE_*` variable in a way that survives both Vite (`import.meta.env`)
 * and plain Node (`process.env`) — the latter matters for the vitest suite and
 * for any `npx tsx` script that imports this layer.
 */
function readEnv(key: string): string | undefined {
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
 * Fallback when `VITE_API_BASE` is unset.
 *
 * `.env.production` is git-ignored, so a fresh clone — or a host like Vercel
 * that builds from git and injects env vars through its dashboard — can easily
 * build with no value at all. Defaulting to localhost in that case ships a
 * bundle that talks to nothing, and the failure only shows up in the browser.
 *
 * So: a build served from a real origin defaults to the real API, and only a
 * localhost origin defaults to the local gateway. An explicit `VITE_API_BASE`
 * always wins over both.
 */
function defaultBase(): string {
  const host = (globalThis as { location?: { hostname?: string } }).location?.hostname;
  const isLocal = host === undefined || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  return isLocal ? 'http://localhost:8080' : 'https://api.ocva.online';
}

export const API_BASE: string = normaliseBase(readEnv('VITE_API_BASE') ?? defaultBase());

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
 * boardgame.io socket.io transport lives on the same gateway origin.
 * Pass this as the `server` option to the boardgame.io SocketIO transport.
 */
export const SOCKET_URL: string = API_BASE;

/** Build an absolute API URL from a leading-slash path. */
export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}
