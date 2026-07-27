"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, RefreshCw, Trophy } from "lucide-react";
import { fetchLeaderboard, type LeaderboardEntry } from "@/lib/profileApi";
import { useProfileName } from "@/components/ProfileNameDialog";

/** Rank accents for the podium (gold / silver / bronze). */
const PODIUM = [
  "text-yellow-400 bg-yellow-400/10",
  "text-slate-300 bg-slate-300/10",
  "text-amber-600 bg-amber-600/10",
];

function winPct(e: LeaderboardEntry): string {
  const total = e.wins + e.losses;
  return total ? `${Math.round((e.wins / total) * 100)}%` : "—";
}

export default function LeaderboardPage() {
  const { name } = useProfileName();
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setEntries(await fetchLeaderboard());
    } catch {
      toast.error("Could not load the leaderboard");
      setEntries((prev) => prev ?? []);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(refresh, 0);
    return () => clearTimeout(t);
  }, [refresh]);

  return (
    <main className="flex-1 w-full max-w-lg mx-auto px-4 py-6 space-y-5">
      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" aria-label="Back">
          <Link href="/">
            <ArrowLeft className="size-5" />
          </Link>
        </Button>
        <h1 className="text-xl font-bold tracking-wide">Leaderboard</h1>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          onClick={refresh}
          disabled={busy}
          aria-label="Refresh"
        >
          <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
        </Button>
      </header>

      {entries === null && (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}

      {entries !== null && entries.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center text-muted-foreground">
            <Trophy className="size-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No ranked players yet.</p>
            <p className="text-xs mt-1">Win a multiplayer match to claim the top spot.</p>
          </CardContent>
        </Card>
      )}

      {entries !== null && entries.length > 0 && (
        <ol className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          {entries.map((e, i) => {
            const isMe = !!name && e.name === name;
            return (
              <li
                key={e.id}
                className={`flex items-center gap-3 px-3 py-3 ${
                  isMe ? "bg-violet-500/10" : ""
                }`}
              >
                <span
                  className={`w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-sm font-black ${
                    PODIUM[i] ?? "text-muted-foreground bg-secondary/60"
                  }`}
                >
                  {i + 1}
                </span>
                <span
                  className={`flex-1 min-w-0 truncate text-sm font-semibold ${
                    isMe ? "text-violet-300" : ""
                  }`}
                >
                  {e.name}
                  {isMe && (
                    <span className="ml-2 text-[10px] uppercase tracking-widest text-violet-400">
                      you
                    </span>
                  )}
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  <b className="text-foreground">{e.wins}</b>–{e.losses}
                </span>
                <span className="w-12 text-right text-sm tabular-nums font-semibold">
                  {winPct(e)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}
