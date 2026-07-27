"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  CARDS,
  COLOR_META,
  COLORS,
  STARTER_DECKS,
  costTotal,
  type CardDef,
  type CardType,
  type Color,
} from "@chains/game-core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowLeft, Hammer } from "lucide-react";
import { GameCard } from "@/components/game/GameCard";
import { CostPips } from "@/components/game/GameCard";
import { SceneBackground } from "@/components/SceneBackground";

const TYPE_ORDER: CardType[] = ["node", "meme", "machine", "aura", "move"];
const TYPE_LABEL: Record<CardType, string> = {
  node: "Nodes",
  meme: "Memes",
  machine: "Machines",
  aura: "Auras",
  move: "Moves",
};

function deckGroups(color: Color) {
  const counts = new Map<string, number>();
  for (const id of STARTER_DECKS[color]) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const groups: Array<{ type: CardType; entries: Array<{ def: CardDef; n: number }> }> = [];
  for (const type of TYPE_ORDER) {
    const entries = [...counts.entries()]
      .map(([id, n]) => ({ def: CARDS[id], n }))
      .filter((e) => e.def?.type === type)
      .sort((a, b) => costTotal(a.def.cost) - costTotal(b.def.cost) || a.def.name.localeCompare(b.def.name));
    if (entries.length) groups.push({ type, entries });
  }
  return groups;
}

export default function DecksPage() {
  const [open, setOpen] = useState<Color | null>(null);
  const [preview, setPreview] = useState<CardDef | null>(null);
  const groups = useMemo(() => (open ? deckGroups(open) : []), [open]);

  return (
    <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-6 space-y-5">
      <SceneBackground src="/hub-bg.png" blur overlay="strong" />
      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" aria-label="Back">
          <Link href="/">
            <ArrowLeft className="size-5" />
          </Link>
        </Button>
        <h1 className="font-heading text-xl font-bold tracking-wide">Starter Decks</h1>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {COLORS.map((c) => {
          const meta = COLOR_META[c];
          return (
            <button
              key={c}
              type="button"
              onClick={() => setOpen(c)}
              className="rounded-xl border p-4 flex items-center gap-4 text-left transition-transform active:scale-[0.98] hover:-translate-y-0.5"
              style={{
                borderColor: meta.hex,
                background: `linear-gradient(150deg, ${meta.hex}22, #0d0d16 70%)`,
              }}
            >
              <span
                className="w-12 h-12 shrink-0 rounded-full flex items-center justify-center font-black text-xs"
                style={{ backgroundColor: meta.hex, color: meta.ink }}
              >
                {meta.glyph}
              </span>
              <span className="min-w-0">
                <span className="block font-bold">{meta.name} Starter</span>
                <span className="block text-xs text-muted-foreground">
                  60 cards · mono-{meta.name}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-dashed border-border p-4 flex items-center gap-3 text-muted-foreground">
        <Hammer className="size-4 shrink-0" />
        <p className="text-sm">Custom deck building is coming soon.</p>
      </div>

      {/* Deck contents dialog */}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-lg">
          {open && (
            <>
              <DialogTitle className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: COLOR_META[open].hex }}
                />
                {COLOR_META[open].name} Starter Deck
              </DialogTitle>
              <ScrollArea className="max-h-[65dvh] pr-3">
                <div className="space-y-4">
                  {groups.map(({ type, entries }) => (
                    <section key={type}>
                      <h3 className="text-xs uppercase tracking-widest text-muted-foreground mb-1.5">
                        {TYPE_LABEL[type]} (
                        {entries.reduce((s, e) => s + e.n, 0)})
                      </h3>
                      <ul className="space-y-1">
                        {entries.map(({ def, n }) => (
                          <li key={def.id}>
                            <button
                              type="button"
                              onClick={() => setPreview(def)}
                              className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 bg-secondary/50 hover:bg-secondary text-left"
                            >
                              <Badge variant="outline" className="w-8 justify-center shrink-0">
                                {n}x
                              </Badge>
                              <span className="flex-1 truncate text-sm">{def.name}</span>
                              {def.type === "meme" && (
                                <span className="text-xs text-muted-foreground shrink-0">
                                  {def.power}/{def.toughness}
                                </span>
                              )}
                              <CostPips cost={def.cost} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </ScrollArea>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Card preview */}
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="w-fit max-w-[90vw] p-4">
          {preview && (
            <>
              <DialogTitle className="sr-only">{preview.name}</DialogTitle>
              <GameCard def={preview} size="lg" className="max-w-full" />
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  );
}
