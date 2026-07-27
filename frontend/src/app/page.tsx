"use client";

import { useState } from "react";
import Link from "next/link";
import { COLOR_META, COLORS } from "@chains/game-core";
import { Button } from "@/components/ui/button";
import { Bot, Swords, LayoutGrid, Layers, UserRound } from "lucide-react";
import {
  ProfileNameDialog,
  useProfileName,
} from "@/components/ProfileNameDialog";

export default function LandingPage() {
  const { name, loaded, save } = useProfileName();
  const [manualOpen, setManualOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Auto-prompt on first visit (derived — no effect needed).
  const dialogOpen = manualOpen || (loaded && !name && !dismissed);
  const setDialogOpen = (o: boolean) => {
    setManualOpen(o);
    if (!o) setDismissed(true);
  };

  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-10 px-6 py-12">
      {/* Logo / title */}
      <div className="text-center space-y-3">
        <div className="flex justify-center gap-1.5 mb-4" aria-hidden>
          {COLORS.map((c) => (
            <span
              key={c}
              className="w-3 h-3 rounded-full"
              style={{
                backgroundColor: COLOR_META[c].hex,
                boxShadow: `0 0 10px ${COLOR_META[c].hex}aa`,
              }}
            />
          ))}
        </div>
        <h1 className="text-5xl sm:text-6xl font-black tracking-[0.2em] text-foreground">
          CHAINS
          <span className="block text-2xl sm:text-3xl tracking-[0.5em] text-primary mt-1">
            TCG
          </span>
        </h1>
        <p className="text-muted-foreground text-sm max-w-xs mx-auto">
          Five chains. One battlefield. Summon your memes and break the
          opposing chain.
        </p>
      </div>

      {/* Main actions */}
      <div className="w-full max-w-xs flex flex-col gap-3">
        <Button asChild size="lg" className="h-12 text-base font-bold">
          <Link href="/play/solo">
            <Bot className="size-5" /> Play vs Bot
          </Link>
        </Button>
        <Button asChild size="lg" variant="secondary" className="h-12 text-base font-bold">
          <Link href="/play">
            <Swords className="size-5" /> Multiplayer
          </Link>
        </Button>
        <div className="grid grid-cols-2 gap-3">
          <Button asChild variant="outline" className="h-11">
            <Link href="/cards">
              <LayoutGrid className="size-4" /> Cards
            </Link>
          </Button>
          <Button asChild variant="outline" className="h-11">
            <Link href="/decks">
              <Layers className="size-4" /> Decks
            </Link>
          </Button>
        </div>
      </div>

      {/* Profile chip */}
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <UserRound className="size-4" />
        {name ? (
          <span>
            Playing as <b className="text-foreground">{name}</b>
          </span>
        ) : (
          <span>Set your name</span>
        )}
      </button>

      <ProfileNameDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={save}
      />
    </main>
  );
}
