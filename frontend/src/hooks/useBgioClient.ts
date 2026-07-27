"use client";

// Vanilla boardgame.io client bridged into React via useSyncExternalStore —
// deliberately avoids 'boardgame.io/react' (peer-dep friction with React 19).

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Client } from "boardgame.io/client";
import type { Game } from "boardgame.io";
import { ChainsTCG, type GState } from "@chains/game-core";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BgioOptions {
  playerID: string;
  matchID?: string;
  credentials?: string;
  /** Transport factory result: Local({...}) or SocketIO({...}). Omit for hot-seat. */
  multiplayer?: any;
  /** Override the game (e.g. wrapped setup for solo). Defaults to ChainsTCG. */
  game?: Game<GState>;
  debug?: boolean;
}

export interface BgioMatchPlayer {
  id: number;
  name?: string;
  isConnected?: boolean;
}

export interface BgioView {
  G: GState & { deckCounts?: Record<string, number> };
  ctx: any;
  moves: Record<string, (...args: any[]) => void>;
  playerID: string;
  isActive: boolean;
  isConnected: boolean;
  matchData?: BgioMatchPlayer[];
}

interface ClientStore {
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => BgioView | null;
  /** Start the client; returns the teardown. */
  start: () => () => void;
}

const NULL_STORE: ClientStore = {
  subscribe: () => () => {},
  getSnapshot: () => null,
  start: () => () => {},
};

const getServerSnapshot = () => null;

function createStore(opts: BgioOptions): ClientStore {
  const client = Client({
    game: (opts.game ?? ChainsTCG) as any,
    numPlayers: 2,
    playerID: opts.playerID,
    matchID: opts.matchID,
    credentials: opts.credentials,
    multiplayer: opts.multiplayer,
    debug: opts.debug ?? false,
  });

  let snapshot: BgioView | null = null;
  const listeners = new Set<() => void>();

  const recompute = () => {
    const s = client.getState();
    snapshot =
      s?.G && s?.ctx
        ? {
            G: s.G as any,
            ctx: s.ctx,
            moves: client.moves as any,
            playerID: opts.playerID,
            isActive: s.isActive ?? false,
            isConnected: (s as any).isConnected ?? true,
            matchData: (client.matchData as any) ?? undefined,
          }
        : null;
  };

  return {
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    getSnapshot: () => snapshot,
    start: () => {
      client.start();
      const unsubscribe = client.subscribe(() => {
        recompute();
        listeners.forEach((l) => l());
      });
      recompute();
      listeners.forEach((l) => l());
      return () => {
        unsubscribe();
        client.stop();
      };
    },
  };
}

/**
 * Instantiate a vanilla boardgame.io client and mirror its state into React.
 * `opts` must be referentially stable (memoize in the caller) — the client is
 * torn down and rebuilt whenever it changes. Returns null until the first
 * state arrives (e.g. socket still connecting).
 */
export function useBgioClient(opts: BgioOptions | null): BgioView | null {
  const store = useMemo(() => (opts ? createStore(opts) : NULL_STORE), [opts]);
  useEffect(() => store.start(), [store]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, getServerSnapshot);
}
