"use client";

// Multiplayer match — SocketIO transport against the gateway.
// Credentials come from localStorage (stored by the lobby at join time);
// the ?playerID=N query param is a spectator-style fallback.

import { useMemo } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { SocketIO } from "boardgame.io/multiplayer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { GAME_SERVER } from "@/lib/config";
import { getMatchCreds, type MatchCreds } from "@/lib/profile";
import { useBgioClient, type BgioOptions } from "@/hooks/useBgioClient";
import { useHydrated } from "@/hooks/useHydrated";
import { Board } from "@/components/game/Board";

export default function MatchPage() {
  const router = useRouter();
  const params = useParams<{ matchID: string }>();
  const matchID = params?.matchID;
  const hydrated = useHydrated();

  // undefined = resolving, null = no way to sit at this match
  const creds = useMemo<MatchCreds | null | undefined>(() => {
    if (!hydrated || !matchID) return undefined;
    const stored = getMatchCreds(matchID);
    if (stored) return stored;
    const pid = new URLSearchParams(window.location.search).get("playerID");
    return pid ? { playerID: pid, credentials: "" } : null;
  }, [hydrated, matchID]);

  const opts = useMemo<BgioOptions | null>(() => {
    if (!matchID || !creds) return null;
    return {
      playerID: creds.playerID,
      matchID,
      credentials: creds.credentials || undefined,
      multiplayer: SocketIO({ server: GAME_SERVER }),
    };
  }, [matchID, creds]);

  const view = useBgioClient(opts);

  if (creds === null) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          You have not joined this match on this device.
        </p>
        <Button asChild>
          <Link href="/play">Back to lobby</Link>
        </Button>
      </main>
    );
  }

  if (!view || !view.G || !view.ctx) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
        <Skeleton className="w-40 h-6" />
        <p className="text-sm text-muted-foreground animate-pulse">
          Connecting to match…
        </p>
        <Button asChild variant="ghost" size="sm">
          <Link href="/play">Back to lobby</Link>
        </Button>
      </main>
    );
  }

  return (
    <Board
      G={view.G}
      ctx={view.ctx}
      moves={view.moves}
      playerID={view.playerID}
      matchData={view.matchData}
      onExit={() => router.push("/play")}
    />
  );
}
