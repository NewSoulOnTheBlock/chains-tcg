// src/api/session.ts
//
// ─────────────────────────────────────────────────────────────────────────────
// TOKEN STORAGE POLICY — read this before changing anything here.
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the ONLY module that touches persistent storage for credentials.
// Nothing else in the app may read or write a token. If you need the access
// token, call `getAccessToken()`; if you need to know when it changes, use
// `onSessionChange()`.
//
// WHAT WE STORE
//
//   accessToken   — 15 minute lifetime, HS256 JWT, sent as `Authorization: Bearer`
//   refreshToken  — long-lived, ROTATING; `POST /auth/refresh` replaces BOTH
//   address/chain — the wallet identity the pair was minted for (display + sanity)
//
// THE DECISION: both tokens live in `sessionStorage` by default.
//
// The security audit flagged M-4, "long-lived credentials in localStorage".
// The obvious fix — access token in `sessionStorage`, refresh token in
// `localStorage` — does not actually address M-4, because the refresh token IS
// the long-lived credential. Putting the 15-minute token somewhere safer while
// leaving the multi-day one in `localStorage` moves the label, not the risk:
// an XSS payload steals the refresh token and mints access tokens at will,
// indefinitely, from any machine.
//
// So the default here is `sessionStorage` for BOTH. Concretely that means:
//
//   + The credential is scoped to one tab and is destroyed when that tab
//     closes. An XSS payload's stolen refresh token is still valid until it is
//     used or expires, but the *stored* copy has a bounded lifetime and does
//     not silently persist across days of browsing.
//   + A reload / in-app navigation still works, which is the only persistence
//     the app genuinely needs. `sessionStorage` survives F5.
//   + It composes with the server's defence: refresh tokens rotate, and reuse
//     of a spent one revokes the entire family (INTEGRATION.md §3). A thief and
//     the legitimate tab cannot both keep using the chain — the second use is
//     detected and everyone is logged out. Short storage lifetime plus
//     rotation-with-reuse-detection is the meaningful pairing.
//
// The cost, stated honestly:
//
//   − Closing the tab signs you out. Opening the site in a second tab requires
//     a fresh wallet signature; sessions do not follow you between tabs.
//   − This is worse UX than `localStorage`, and users will notice.
//
// Because that cost is real, `setPersistence('local')` exists as an EXPLICIT
// opt-in — wire it to a "Remember me on this device" checkbox, never enable it
// by default. When the user makes that trade knowingly it is a defensible
// product decision; making it for them silently is what M-4 is about.
//
// What none of this fixes: any storage readable by JavaScript is readable by
// injected JavaScript. The real mitigation for M-4 is the gateway's CSP
// (`default-src 'self'; script-src 'self'`), which is what actually keeps
// third-party script out of the page. Storage choice only bounds the blast
// radius after that has already failed.
//
// Why not cookies at all: the API is a different origin from the web app
// (`api.ocva.online` vs `ocva.online`), there is no shared cookie domain, and
// nothing here is `SameSite`-protected — INTEGRATION.md §2 is explicit that
// tokens travel in the `Authorization` header and never in cookies.

/** Chain slugs the auth service accepts. `evm` is NOT one of them. */
export type AuthChain = 'ethereum' | 'base' | 'arbitrum' | 'polygon' | 'solana';

/** The credential pair plus the identity it belongs to. */
export interface Session {
  accessToken: string;
  refreshToken: string;
  /** The wallet address that signed in. Lowercased for EVM, base58 for Solana. */
  address: string;
  /** The chain slug the pair was minted for. */
  chain: AuthChain;
}

/** Where the session is kept. See the file header. */
export type PersistenceMode = 'session' | 'local' | 'memory';

const STORAGE_KEY = 'chains.session.v1';
const PERSISTENCE_KEY = 'chains.session.persistence.v1';

/**
 * Authoritative in-memory copy. Storage is a cache of this, not the other way
 * round — so the app still works with storage disabled (Safari private mode,
 * embedded webviews, strict privacy extensions).
 */
let current: Session | null = null;
let mode: PersistenceMode = 'session';
let initialised = false;

type Listener = (session: Session | null) => void;
const listeners = new Set<Listener>();

// ── Storage plumbing ────────────────────────────────────────────────────────

function storageFor(m: PersistenceMode): Storage | null {
  if (m === 'memory') return null;
  try {
    const s = m === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    // Touch it — Safari private mode throws on write, not on access.
    const probe = '__chains_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function isSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.accessToken === 'string' && o.accessToken.length > 0 &&
    typeof o.refreshToken === 'string' && o.refreshToken.length > 0 &&
    typeof o.address === 'string' &&
    typeof o.chain === 'string'
  );
}

function readFrom(m: PersistenceMode): Session | null {
  const store = storageFor(m);
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeThrough(): void {
  // Only ever one storage holds the session; clear the other so a mode switch
  // cannot leave a stale credential behind.
  for (const m of ['session', 'local'] as const) {
    const store = storageFor(m);
    if (!store) continue;
    try {
      if (m === mode && current) store.setItem(STORAGE_KEY, JSON.stringify(current));
      else store.removeItem(STORAGE_KEY);
    } catch {
      /* storage full or blocked — memory copy still authoritative */
    }
  }
}

/** Lazily hydrate from storage on first access. */
function ensureInit(): void {
  if (initialised) return;
  initialised = true;

  try {
    const saved = globalThis.localStorage?.getItem(PERSISTENCE_KEY);
    if (saved === 'local' || saved === 'session' || saved === 'memory') mode = saved;
  } catch {
    /* no storage — stay on the default */
  }

  // Prefer the configured mode, but recover a session from the other store if
  // the mode was changed between page loads.
  current = readFrom(mode) ?? readFrom('session') ?? readFrom('local');
  if (current) writeThrough();

  // Cross-tab logout. `storage` events only fire for `localStorage` and only
  // in OTHER tabs; `sessionStorage` is per-tab by design, so in the default
  // mode there is nothing to synchronise (which is itself the point).
  try {
    globalThis.addEventListener?.('storage', (ev) => {
      const e = ev as StorageEvent;
      if (e.key !== STORAGE_KEY || mode !== 'local') return;
      const next = e.newValue ? (JSON.parse(e.newValue) as unknown) : null;
      current = isSession(next) ? next : null;
      emit();
    });
  } catch {
    /* non-browser environment */
  }
}

function emit(): void {
  const snapshot = current;
  for (const fn of [...listeners]) {
    try {
      fn(snapshot);
    } catch {
      /* a bad subscriber must not break the auth layer */
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** The whole session, or `null` when signed out. */
export function getSession(): Session | null {
  ensureInit();
  return current;
}

/** The bearer token, or `null`. `http.ts` is the main caller. */
export function getAccessToken(): string | null {
  return getSession()?.accessToken ?? null;
}

/** The rotating refresh token, or `null`. Only `auth.ts` should need this. */
export function getRefreshToken(): string | null {
  return getSession()?.refreshToken ?? null;
}

/** Is there a credential pair at all? Not a claim that it is still valid. */
export function isSignedIn(): boolean {
  return getSession() !== null;
}

/** Replace the whole session and notify subscribers. */
export function setSession(session: Session): void {
  ensureInit();
  current = session;
  writeThrough();
  emit();
}

/**
 * Swap in a rotated token pair, keeping the existing identity.
 *
 * `POST /auth/refresh` replaces BOTH tokens; storing only the new access token
 * would leave the old refresh token in place, and presenting it a second time
 * revokes the entire family server-side. Always write both.
 */
export function updateTokens(tokens: { accessToken: string; refreshToken: string }): void {
  ensureInit();
  if (!current) return;
  current = { ...current, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  writeThrough();
  emit();
}

/**
 * Drop everything, everywhere, and notify.
 *
 * Called on explicit logout AND whenever a refresh fails. Clears both storages
 * regardless of the current mode.
 */
export function clearSession(): void {
  ensureInit();
  current = null;
  for (const m of ['session', 'local'] as const) {
    try {
      storageFor(m)?.removeItem(STORAGE_KEY);
    } catch {
      /* nothing we can do */
    }
  }
  emit();
}

/**
 * Subscribe to sign-in / sign-out / token-rotation.
 *
 * Fires immediately with the current value so a React effect does not need a
 * separate initial read. Returns an unsubscribe function.
 *
 *   useEffect(() => onSessionChange(setSession), []);
 */
export function onSessionChange(fn: Listener): () => void {
  ensureInit();
  listeners.add(fn);
  try {
    fn(current);
  } catch {
    /* ignore */
  }
  return () => {
    listeners.delete(fn);
  };
}

/** Current persistence mode. */
export function getPersistence(): PersistenceMode {
  ensureInit();
  return mode;
}

/**
 * Change where the session is kept, migrating any live session.
 *
 * Wire `'local'` to an explicit "Remember me on this device" control only —
 * see the file header for why it must not be the default.
 */
export function setPersistence(next: PersistenceMode): void {
  ensureInit();
  if (mode === next) return;
  mode = next;
  try {
    globalThis.localStorage?.setItem(PERSISTENCE_KEY, next);
  } catch {
    /* preference is best-effort */
  }
  writeThrough();
}
