"use client";

// Solo vs bot — fully local boardgame.io client (Local transport + MMTCGBot).
// Human is playerID '0'; the bot picks its own chain during the pick phase.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Local } from "boardgame.io/multiplayer";
import type { Game } from "boardgame.io";
import {
  ChainsTCG,
  MMTCGBot,
  enumerateMoves,
  type Difficulty,
  type GState,
} from "@chains/game-core";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Bot } from "lucide-react";
import { useBgioClient, type BgioOptions } from "@/hooks/useBgioClient";
import { Board } from "@/components/game/Board";
import {
  ProfileNameDialog,
  useProfileName,
} from "@/components/ProfileNameDialog";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DIFFICULTIES: Array<{ id: Difficulty; label: string; blurb: string }> = [
  { id: "easy", label: "Easy", blurb: "Random legal moves. A friendly warm-up." },
  { id: "normal", label: "Normal", blurb: "Solid curve, sensible trades." },
  { id: "hard", label: "Hard", blurb: "Aggressive lines, punishes mistakes." },
];

export default function SoloPage() {
  const { name, loaded, save } = useProfileName();
  const [manualNameOpen, setManualNameOpen] = useState(false);
  const [nameDismissed, setNameDismissed] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [session, setSession] = useState(0); // bumping remounts the client
  const [started, setStarted] = useState(false);

  // Auto-prompt for a name (derived — no effect needed).
  const nameDialog = manualNameOpen || (loaded && !name && !nameDismissed);
  const setNameDialog = (o: boolean) => {
    setManualNameOpen(o);
    if (!o) setNameDismissed(true);
  };

  const opts = useMemo<BgioOptions | null>(() => {
    if (!started) return null;
    const playerName = name || "You";

    // Bake setupData into setup(): the Local transport has no lobby to forward it.
    const originalSetup = ChainsTCG.setup as any;
    const wrappedGame: Game<GState> = {
      ...ChainsTCG,
      setup: (ctxLike: any) =>
        originalSetup(ctxLike, {
          colors: [null, null], // both pick in-game (bot picks randomly)
          names: [playerName, `Bot (${difficulty})`],
        }),
      // LocalMaster only spins up bots when game.ai is defined.
      ai: { enumerate: enumerateMoves as any },
    };

    // Bind difficulty into the bot constructor.
    class BoundBot extends MMTCGBot {
      constructor(args: any) {
        super({ ...args, difficulty });
      }
    }

    return {
      playerID: "0",
      matchID: `solo-${session}`,
      multiplayer: Local({ bots: { "1": BoundBot as any } }),
      game: wrappedGame,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, session, difficulty]);

  const view = useBgioClient(opts);

  if (!started) {
    return (
      <main className="flex-1 w-full max-w-md mx-auto px-4 py-6 space-y-6">
        <header className="flex items-center gap-3">
          <Button asChild variant="ghost" size="icon" aria-label="Back">
            <Link href="/">
              <ArrowLeft className="size-5" />
            </Link>
          </Button>
          <h1 className="text-xl font-bold tracking-wide">Play vs Bot</h1>
        </header>

        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
            Difficulty
          </h2>
          {DIFFICULTIES.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDifficulty(d.id)}
              className={
                "w-full rounded-xl border p-4 text-left transition-colors " +
                (difficulty === d.id
                  ? "border-primary bg-primary/10"
                  : "border-border bg-card hover:bg-secondary/60")
              }
            >
              <span className="font-bold">{d.label}</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                {d.blurb}
              </span>
            </button>
          ))}
        </section>

        <Button
          size="lg"
          className="w-full h-12 font-bold"
          onClick={() => {
            setSession((s) => s + 1);
            setStarted(true);
          }}
        >
          <Bot className="size-5" /> Start Match
        </Button>

        <ProfileNameDialog
          open={nameDialog}
          onOpenChange={setNameDialog}
          onSaved={save}
        />
      </main>
    );
  }

  if (!view || !view.G || !view.ctx) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
        <Skeleton className="w-40 h-6" />
        <p className="text-sm text-muted-foreground animate-pulse">
          Shuffling decks…
        </p>
      </main>
    );
  }

  return (
    <Board
      G={view.G}
      ctx={view.ctx}
      moves={view.moves}
      playerID="0"
      onExit={() => setStarted(false)}
    />
  );
}
