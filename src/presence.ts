// src/presence.ts
// Real "players online": a heartbeat to api/presence.ts while the game is open
// and the tab is visible, plus a hook that reads the live count.
//
// `/api/presence` is a Vercel function (same-origin), NOT the gateway, so it is
// hit with a plain `fetch` rather than the `src/api/http.ts` wrapper (which
// prefixes the gateway `API_BASE`). We reimplement the two things that matter
// from that wrapper by hand: a timeout, and a single refresh-and-retry on 401,
// so an idle player whose 15-minute access token expired does not silently drop
// out of the online count (client-api-09).
import { useEffect, useState } from 'react';
import { getAccessToken, refreshSession } from './api';

const BEAT_MS = 30_000;
/** A presence request is a heartbeat, not a user action — bound it tightly. */
const PRESENCE_TIMEOUT_MS = 8_000;

/** `AbortSignal.timeout`, with a fallback for runtimes that lack it. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    const AS = globalThis.AbortSignal as typeof AbortSignal & { timeout?: (ms: number) => AbortSignal };
    if (typeof AS?.timeout === 'function') return AS.timeout(ms);
  } catch { /* fall through */ }
  const ac = new AbortController();
  setTimeout(() => ac.abort(), ms);
  return ac.signal;
}

// ── Shared online-count store ───────────────────────────────────────────────
//
// `useOnlineCount()` is mounted by more than one component (App.tsx mounts it in
// two places). A per-component poller meant every open tab issued several GETs
// per 30s, each running a `count(*)` in a Postgres-backed function. Lift the
// count into one module-level store with a SINGLE poller shared by all
// subscribers, and let the heartbeat POST's own response feed it too, so a
// signed-in client needs no separate GET at all (client-api-28).

let onlineCount: number | null = null;
const countSubs = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight: AbortController | null = null;

function setOnline(n: number | null): void {
  if (n === null || n === onlineCount) return;
  onlineCount = n;
  for (const fn of [...countSubs]) { try { fn(); } catch { /* noop */ } }
}

async function readOnline(): Promise<void> {
  pollInFlight?.abort();
  const ac = new AbortController();
  pollInFlight = ac;
  const signal = timeoutSignal(PRESENCE_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    const res = await fetch('/api/presence', { cache: 'no-store', signal: ac.signal });
    if (!res.ok) return;
    const { online } = (await res.json()) as { online?: number };
    if (typeof online === 'number') setOnline(online);
  } catch {
    /* keep the last good value */
  } finally {
    if (pollInFlight === ac) pollInFlight = null;
  }
}

function startPolling(): void {
  if (pollTimer) return;
  void readOnline();
  pollTimer = setInterval(() => { void readOnline(); }, BEAT_MS);
}

function stopPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  pollInFlight?.abort();
  pollInFlight = null;
}

// ── Heartbeat ───────────────────────────────────────────────────────────────

/** POST one heartbeat, refreshing the token once on a 401. Returns the count. */
async function beat(): Promise<number | null> {
  let token = getAccessToken();
  if (!token) return null;

  const send = (t: string) =>
    fetch('/api/presence', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t}` },
      signal: timeoutSignal(PRESENCE_TIMEOUT_MS),
    });

  try {
    let res = await send(token);
    // The 15-minute access token expires out from under an idle player. Refresh
    // once (single-flight, shared with http.ts) and retry so they stay counted.
    if (res.status === 401 && (await refreshSession())) {
      token = getAccessToken();
      if (!token) return null;
      res = await send(token);
    }
    if (!res.ok) return null;
    const online = ((await res.json()) as { online?: number }).online ?? null;
    setOnline(online); // feed the shared store so a signed-in tab needs no GET
    return online;
  } catch {
    return null;
  }
}

/** Keep this player counted as online while the tab is visible. Mount once, signed in. */
export function usePresenceHeartbeat(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      void beat().catch(() => {});
      timer = setInterval(() => { void beat().catch(() => {}); }, BEAT_MS);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    // A hidden tab is not "online": stop beating and drop out after the window.
    const onVis = () => (document.visibilityState === 'visible' ? start() : stop());
    onVis();
    document.addEventListener('visibilitychange', onVis);
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [enabled]);
}

/** Live online count, or null until the first read (and on failure). */
export function useOnlineCount(): number | null {
  const [n, setN] = useState<number | null>(onlineCount);
  useEffect(() => {
    const sub = () => setN(onlineCount);
    countSubs.add(sub);
    startPolling();
    sub(); // sync with whatever the shared store already holds
    return () => {
      countSubs.delete(sub);
      if (countSubs.size === 0) stopPolling();
    };
  }, []);
  return n;
}
