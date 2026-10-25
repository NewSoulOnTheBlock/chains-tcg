// src/presence.ts
// Real "players online": a heartbeat to api/presence.ts while the game is open
// and the tab is visible, plus a hook that reads the live count.
import { useEffect, useState } from 'react';
import { getAccessToken } from './api';

const BEAT_MS = 30_000;

async function beat(): Promise<number | null> {
  const token = getAccessToken();
  if (!token) return null;
  const res = await fetch('/api/presence', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return ((await res.json()) as { online?: number }).online ?? null;
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
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const res = await fetch('/api/presence', { cache: 'no-store' });
        if (!res.ok) return;
        const { online } = (await res.json()) as { online?: number };
        if (alive && typeof online === 'number') setN(online);
      } catch { /* keep the last good value */ }
    };
    void read();
    const t = setInterval(read, BEAT_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return n;
}
