"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  BUILDABLE_CARDS,
  COLOR_META,
  COLORS,
  costTotal,
  type CardDef,
  type CardType,
  type Color,
} from "@chains/game-core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft } from "lucide-react";
import { GameCard } from "@/components/game/GameCard";
import { SceneBackground } from "@/components/SceneBackground";

const TYPES: Array<CardType | "all"> = [
  "all",
  "node",
  "meme",
  "machine",
  "aura",
  "move",
];

export default function CardsPage() {
  const [color, setColor] = useState<Color | "all">("all");
  const [type, setType] = useState<CardType | "all">("all");
  const [selected, setSelected] = useState<CardDef | null>(null);

  const cards = useMemo(() => {
    return BUILDABLE_CARDS.filter(
      (c) =>
        (color === "all" || c.color === color) &&
        (type === "all" || c.type === type)
    ).sort(
      (a, b) =>
        COLORS.indexOf(a.color) - COLORS.indexOf(b.color) ||
        costTotal(a.cost) - costTotal(b.cost) ||
        a.name.localeCompare(b.name)
    );
  }, [color, type]);

  return (
    <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-6 space-y-4">
      <SceneBackground src="/hub-bg.png" blur overlay="strong" />
      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" aria-label="Back">
          <Link href="/">
            <ArrowLeft className="size-5" />
          </Link>
        </Button>
        <h1 className="font-heading text-xl font-bold tracking-wide">Card Gallery</h1>
        <span className="ml-auto font-display text-xs text-muted-foreground">
          {cards.length} cards
        </span>
      </header>

      {/* Chain filter */}
      <Tabs value={color} onValueChange={(v) => setColor(v as Color | "all")}>
        <TabsList className="w-full overflow-x-auto justify-start font-display">
          <TabsTrigger value="all">All</TabsTrigger>
          {COLORS.map((c) => (
            <TabsTrigger key={c} value={c}>
              <span
                className="w-2 h-2 rounded-full mr-1"
                style={{ backgroundColor: COLOR_META[c].hex }}
              />
              {COLOR_META[c].name}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Type filter */}
      <Tabs value={type} onValueChange={(v) => setType(v as CardType | "all")}>
        <TabsList className="w-full overflow-x-auto justify-start font-display">
          {TYPES.map((t) => (
            <TabsTrigger key={t} value={t} className="capitalize">
              {t === "all" ? "All types" : `${t}s`}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Grid */}
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3 justify-items-center">
        {cards.map((def) => (
          <GameCard
            key={def.id}
            def={def}
            size="md"
            onClick={() => setSelected(def)}
            className="w-full max-w-28 h-auto aspect-[5/7]"
          />
        ))}
      </div>

      {/* Large view */}
      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="w-fit max-w-[90vw] p-4">
          {selected && (
            <>
              <DialogTitle className="sr-only">{selected.name}</DialogTitle>
              <GameCard def={selected} size="lg" className="max-w-full" />
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
