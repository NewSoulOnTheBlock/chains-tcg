// src/components/mute.ts
// One master-mute implementation. Before this, five screens (Landing,
// ProfilePage, RulebookPage, SettingsPage and BoostersPage) each hand-rolled
// "write ocva.muted, blanket-mute every <audio>, dispatch PREFS_EVENT" and they
// had already drifted — Boosters' copy forgot the PREFS_EVENT dispatch, so a
// per-track mute could not be re-asserted afterwards (frontend-10). Everything
// routes through `applyMasterMute` / `useMasterMute` now.
import { useCallback, useEffect, useState } from 'react';

/** localStorage key for the master mute flag ('1' / '0'). */
export const MUTE_KEY = 'ocva.muted';

/** Fired whenever a preference changes so live components re-read it. */
export const PREFS_EVENT = 'ocva:prefs-changed';

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

/**
 * Persist the master-mute flag, blanket-mute every <audio>/<video> mounted
 * right now, and notify live listeners (BgMusic re-asserts any individually
 * muted track on PREFS_EVENT, which is the dispatch Boosters used to drop).
 */
export function applyMasterMute(muted: boolean): void {
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* storage blocked */ }
  try {
    document.querySelectorAll('audio,video').forEach((a) => { (a as HTMLMediaElement).muted = muted; });
  } catch { /* noop */ }
  try { window.dispatchEvent(new CustomEvent(PREFS_EVENT)); } catch { /* old browsers */ }
}

/**
 * Master-mute state for a simple mute toggle. Returns the current flag and a
 * setter that persists + applies + dispatches via `applyMasterMute`. Stays in
 * sync with other screens and other tabs through PREFS_EVENT / storage events.
 */
export function useMasterMute(): { muted: boolean; setMuted: (m: boolean) => void; toggle: () => void } {
  const [muted, setMutedState] = useState<boolean>(readMuted);

  useEffect(() => {
    const sync = () => setMutedState(readMuted());
    window.addEventListener(PREFS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PREFS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    applyMasterMute(next);
  }, []);

  const toggle = useCallback(() => {
    setMutedState((m) => { applyMasterMute(!m); return !m; });
  }, []);

  return { muted, setMuted, toggle };
}
