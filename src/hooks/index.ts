// src/hooks — small shared hooks extracted from App.tsx during the screen split.

import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

/**
 * `true` when the viewport is at or below `breakpoint` px. Shared responsive
 * helper (was a top-level function in App.tsx; extracted so the split-out
 * screens can use it without importing from App — frontend-01).
 */
export function useIsMobile(breakpoint = 720): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.innerWidth <= breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = () => setM(mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [breakpoint]);
  return m;
}

/**
 * Run an async effect with cancellation. The effect receives `alive()`, which
 * returns `false` once this run is torn down (deps changed, or the component
 * unmounted). Guard every `setState` with it so a slow response from an old
 * identity can never overwrite newer state or fire after unmount.
 *
 * Replaces the hand-rolled `let cancelled = false` pattern that several loaders
 * had and a few (DeckWorkspace, ProfilePage) were missing — see frontend-24.
 */
export function useAsyncEffect(
  effect: (alive: () => boolean) => void | Promise<void>,
  deps: DependencyList,
): void {
  useEffect(() => {
    let cancelled = false;
    void effect(() => !cancelled);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * A momentary flag: call `flash(value)` to set it, and it returns to `idle`
 * after `ms`. The timer lives in a ref, is cleared on every re-trigger and on
 * unmount, so a fast double-press never leaves two timers racing and no
 * `setState` fires after the component is gone — see frontend-16.
 */
export function useFlash<T>(idle: T, ms = 1600): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(idle);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  useEffect(() => clear, [clear]);
  const flash = useCallback((next: T) => {
    setValue(next);
    clear();
    timer.current = setTimeout(() => { setValue(idle); timer.current = null; }, ms);
  }, [clear, idle, ms]);
  return [value, flash];
}
