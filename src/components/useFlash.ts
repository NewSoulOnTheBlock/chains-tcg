// src/components/useFlash.ts
// One "flash a transient value, then clear it" hook. Replaces ~nine bare
// `setTimeout(() => setX(''), ms)` copies that never cleared the timer, so a
// fast re-trigger raced two timers and a copy-then-navigate ran setState after
// unmount (frontend-16). The timer lives in a ref: a re-trigger clears the
// previous one, and unmount clears it too.
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @param ms how long the flashed value stays set before auto-clearing.
 * @param empty the "cleared" value (default `''`).
 * Returns `[value, flash]`. `flash(v)` sets `value` to `v` and schedules a
 * single reset to `empty`, cancelling any pending reset first.
 */
export function useFlash<T = string>(ms = 1600, empty: T = '' as unknown as T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(empty);
  const timer = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null; }
  }, []);

  const flash = useCallback((v: T) => {
    clear();
    setValue(v);
    timer.current = window.setTimeout(() => { setValue(empty); timer.current = null; }, ms);
  }, [clear, ms, empty]);

  useEffect(() => clear, [clear]);

  return [value, flash];
}

/** Boolean convenience: `flash()` turns it on for `ms`, then back to false. */
export function useFlashFlag(ms = 1600): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef<number | null>(null);
  const clear = useCallback(() => {
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null; }
  }, []);
  const flash = useCallback(() => {
    clear();
    setOn(true);
    timer.current = window.setTimeout(() => { setOn(false); timer.current = null; }, ms);
  }, [clear, ms]);
  useEffect(() => clear, [clear]);
  return [on, flash];
}
