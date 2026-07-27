"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

/** False during SSR/hydration, true after the client takes over. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}
