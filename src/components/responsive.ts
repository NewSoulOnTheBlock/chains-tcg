// src/components/responsive.ts
// One shared media-query hook, backed by a module-level cache of MediaQueryList
// objects + subscriber sets, so N components watching the same breakpoint share
// a single MediaQueryList and a single listener instead of allocating two per
// card (see frontend-11). Named breakpoints live here so "mobile" means the
// same thing on every screen.
import { useEffect, useState } from 'react';

type Entry = { mql: MediaQueryList; subs: Set<() => void> };
const cache = new Map<string, Entry>();

function getEntry(query: string): Entry | null {
  if (typeof window === 'undefined' || !window.matchMedia) return null;
  let e = cache.get(query);
  if (!e) {
    const mql = window.matchMedia(query);
    const subs = new Set<() => void>();
    const onChange = () => { for (const fn of subs) fn(); };
    // Safari < 14 only has the deprecated add/removeListener API.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    e = { mql, subs };
    cache.set(query, e);
  }
  return e;
}

/** Reactively track a CSS media query. All callers of the same query string
 *  share one MediaQueryList + one native listener. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    const e = getEntry(query);
    if (!e) return;
    const sync = () => setMatches(e.mql.matches);
    sync(); // pick up any change between first render and effect
    e.subs.add(sync);
    return () => { e.subs.delete(sync); };
  }, [query]);
  return matches;
}

/** Named breakpoints. Use these rather than hand-typed pixel widths. */
export const BP = {
  /** Portrait phone / narrow tablet — the board's "mobile" layout. */
  mobile: 720,
  /** Boosters/vault layout switches to a single column below this. */
  vault: 900,
} as const;

/** Viewport narrower than `breakpoint` px (default: the board's mobile width). */
export function useIsMobile(breakpoint: number = BP.mobile): boolean {
  return useMediaQuery(`(max-width: ${breakpoint}px)`);
}

/** Landscape-phone check — viewport too short for the full desktop chrome. */
export function useIsShort(maxHeight = 450): boolean {
  return useMediaQuery(`(max-height: ${maxHeight}px)`);
}
