"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Plus, RefreshCw, Swords, Users } from "lucide-react";
import { GAME_NAME, GAME_SERVER } from "@/lib/config";
import { getMatchCreds, setMatchCreds } from "@/lib/profile";
import {
  ProfileNameDialog,
  useProfileName,
} from "@/components/ProfileNameDialog";

interface LobbyPlayer {
  id: number;
  name?: string;
}

interface LobbyMatch {
  matchID: string;
  players: LobbyPlayer[];
  createdAt?: number;
  gameover?: unknown;
}

const LOBBY = `${GAME_SERVER}/games/${GAME_NAME}`;

export default function LobbyPage() {
  const router = useRouter();
  const { name, loaded, save } = useProfileName();
  const [manualNameOpen, setManualNameOpen] = useState(false);
  const [nameDismissed, setNameDismissed] = useState(false);
  const [matches, setMatches] = useState<LobbyMatch[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Auto-prompt for a name (derived — no effect needed).
  const nameDialog = manualNameOpen || (loaded && !name && !nameDismissed);
  const setNameDialog = (o: boolean) => {
    setManualNameOpen(o);
    if (!o) setNameDismissed(true);
  };

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(LOBBY, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMatches(Array.isArray(data?.matches) ? data.matches : []);
    } catch {
      setMatches((prev) => prev ?? []);
    }
  }, []);

  // Poll the match list every 3s (first tick immediately, asynchronously).
  useEffect(() => {
    const t0 = setTimeout(refresh, 0);
    const t = setInterval(refresh, 3000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [refresh]);

  async function joinSeat(matchID: string, playerID: string) {
    const res = await fetch(`${LOBBY}/${matchID}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerID, playerName: name || "Anonymous" }),
    });
    if (!res.ok) throw new Error(`Join failed (HTTP ${res.status})`);
    const data = await res.json();
    const credentials = data?.playerCredentials;
    if (typeof credentials !== "string") throw new Error("No credentials returned");
    setMatchCreds(matchID, { playerID, credentials });
    router.push(`/play/${matchID}?playerID=${playerID}`);
  }

  async function createMatch() {
    if (!name) return setNameDialog(true);
    setBusy(true);
    try {
      const res = await fetch(`${LOBBY}/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // colors:[null,null] keeps needsColorPick on both seats so the in-game
        // chain picker runs; omitting setupData would apply DEFAULT_MATCHUP and
        // skip the pick phase entirely.
        body: JSON.stringify({ numPlayers: 2, setupData: { colors: [null, null] } }),
      });
      if (!res.ok) throw new Error(`Create failed (HTTP ${res.status})`);
      const data = await res.json();
      const matchID = data?.matchID;
      if (!matchID) throw new Error("No matchID returned");
      await joinSeat(matchID, "0");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create match");
    } finally {
      setBusy(false);
    }
  }

  async function joinMatch(m: LobbyMatch) {
    if (!name) return setNameDialog(true);
    const existing = getMatchCreds(m.matchID);
    if (existing) {
      router.push(`/play/${m.matchID}?playerID=${existing.playerID}`);
      return;
    }
    const free = m.players.find((p) => !p.name);
    if (!free) return toast.error("Match is full");
    setBusy(true);
    try {
      await joinSeat(m.matchID, String(free.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not join match");
    } finally {
      setBusy(false);
    }
  }

  const openMatches = (matches ?? []).filter((m) => !m.gameover);

  return (
    <main className="flex-1 w-full max-w-lg mx-auto px-4 py-6 space-y-5">
      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" aria-label="Back">
          <Link href="/">
            <ArrowLeft className="size-5" />
          </Link>
        </Button>
        <h1 className="text-xl font-bold tracking-wide">Multiplayer Lobby</h1>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          onClick={refresh}
          aria-label="Refresh"
        >
          <RefreshCw className="size-4" />
        </Button>
      </header>

      <Button
        size="lg"
        className="w-full h-12 font-bold"
        disabled={busy}
        onClick={createMatch}
      >
        <Plus className="size-5" /> Create Match
      </Button>

      <section className="space-y-2">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
          Open matches
        </h2>

        {matches === null && (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {matches !== null && openMatches.length === 0 && (
          <Card className="border-dashed">
            <CardContent className="py-8 text-center text-muted-foreground">
              <Swords className="size-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No open matches right now.</p>
              <p className="text-xs mt-1">Create one and invite a friend.</p>
            </CardContent>
          </Card>
        )}

        {openMatches.map((m) => {
          const seated = m.players.filter((p) => p.name);
          const mine = getMatchCreds(m.matchID);
          const full = seated.length >= m.players.length;
          return (
            <Card key={m.matchID}>
              <CardContent className="flex items-center gap-3 py-3">
                <Users className="size-5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {seated.map((p) => p.name).join(" vs ") || "Empty match"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {seated.length}/{m.players.length} players ·{" "}
                    {m.matchID.slice(0, 8)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={mine ? "secondary" : "default"}
                  disabled={busy || (full && !mine)}
                  onClick={() => joinMatch(m)}
                >
                  {mine ? "Rejoin" : full ? "Full" : "Join"}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <ProfileNameDialog
        open={nameDialog}
        onOpenChange={setNameDialog}
        onSaved={save}
      />
    </main>
  );
}
