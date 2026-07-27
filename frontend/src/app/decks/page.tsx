"use client";

// Deck hub — starter decks (fixed lists) + "My Decks" (server-persisted
// custom decks) with an "active deck" toggle. The active deck is stored in
// localStorage (chains:activeDeck) and surfaces as a 6th tile on the in-game
// color-pick screen.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CARDS,
  COLOR_META,
  COLORS,
  DECK_SIZE,
  STARTER_DECKS,
  costTotal,
  derivePrimaryColor,
  validateDeck,
  type CardDef,
  type CardType,
  type Color,
} from "@chains/game-core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  Check,
  Copy,
  Pencil,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import { GameCard, CostPips } from "@/components/game/GameCard";
import { SceneBackground } from "@/components/SceneBackground";
import { ProfileNameDialog, useProfileName } from "@/components/ProfileNameDialog";
import { useHydrated } from "@/hooks/useHydrated";
import {
  DeckApiError,
  createDeck,
  deleteDeck,
  getActiveDeck,
  listMyDecks,
  setActiveDeck,
  type ActiveDeck,
  type DeckRow,
} from "@/lib/decks";

const TYPE_ORDER: CardType[] = ["node", "meme", "machine", "aura", "move"];
const TYPE_LABEL: Record<CardType, string> = {
  node: "Nodes",
  meme: "Memes",
  machine: "Machines",
  aura: "Auras",
  move: "Moves",
};

const starterName = (c: Color) => `${COLOR_META[c].name} Starter`;

function cardGroups(cards: string[]) {
  const counts = new Map<string, number>();
  for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);
  const groups: Array<{ type: CardType; entries: Array<{ def: CardDef; n: number }> }> = [];
  for (const type of TYPE_ORDER) {
    const entries = [...counts.entries()]
      .map(([id, n]) => ({ def: CARDS[id], n }))
      .filter((e) => e.def?.type === type)
      .sort(
        (a, b) =>
          costTotal(a.def.cost) - costTotal(b.def.cost) ||
          a.def.name.localeCompare(b.def.name)
      );
    if (entries.length) groups.push({ type, entries });
  }
  return groups;
}

function surfaceDeckError(e: unknown, fallback: string) {
  if (e instanceof DeckApiError) {
    if (e.issues.length) e.issues.forEach((i) => toast.error(i.message));
    else toast.error(e.message || fallback);
  } else {
    toast.error(fallback);
  }
}

export default function DecksPage() {
  const hydrated = useHydrated();
  const { name: profileName } = useProfileName();

  const [openList, setOpenList] = useState<{ title: string; cards: string[] } | null>(null);
  const [preview, setPreview] = useState<CardDef | null>(null);
  const [decks, setDecks] = useState<DeckRow[] | null>(null); // null = loading
  const [version, setVersion] = useState(0); // bump to refetch the deck list
  const [confirmDelete, setConfirmDelete] = useState<DeckRow | null>(null);
  const [nameDialog, setNameDialog] = useState(false);
  const [busy, setBusy] = useState(false);

  // Active deck: read from localStorage at render time (deterministic after
  // hydration); overridden in-session once the user toggles it.
  const [activeOverride, setActiveOverride] = useState<ActiveDeck | null | undefined>(undefined);
  const active = useMemo<ActiveDeck | null>(() => {
    if (activeOverride !== undefined) return activeOverride;
    return hydrated ? getActiveDeck() : null;
  }, [hydrated, activeOverride]);

  const groups = useMemo(
    () => (openList ? cardGroups(openList.cards) : []),
    [openList]
  );

  useEffect(() => {
    if (!hydrated || !profileName) return;
    let live = true;
    listMyDecks()
      .then((d) => {
        if (live) setDecks(d);
      })
      .catch(() => {
        if (!live) return;
        setDecks([]);
        toast.error("Could not load your decks");
      });
    return () => {
      live = false;
    };
  }, [hydrated, profileName, version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const applyActive = (deck: ActiveDeck | null) => {
    setActiveDeck(deck);
    setActiveOverride(deck);
    if (deck) toast.success(`"${deck.name}" is now your active deck`);
  };

  const isStarterActive = (c: Color) =>
    !!active && active.id == null && active.name === starterName(c);

  const toggleStarterActive = (c: Color) => {
    if (isStarterActive(c)) applyActive(null);
    else applyActive({ name: starterName(c), cards: [...STARTER_DECKS[c]] });
  };

  const toggleDeckActive = (deck: DeckRow) => {
    if (active?.id === deck.id) applyActive(null);
    else applyActive({ id: deck.id, name: deck.name, cards: deck.cards });
  };

  const duplicate = async (deck: DeckRow) => {
    setBusy(true);
    try {
      await createDeck(`${deck.name} (copy)`, deck.cards);
      toast.success("Deck duplicated");
      refresh();
    } catch (e) {
      surfaceDeckError(e, "Could not duplicate the deck");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (deck: DeckRow) => {
    setBusy(true);
    try {
      await deleteDeck(deck.id);
      if (active?.id === deck.id) applyActive(null);
      setConfirmDelete(null);
      toast.success("Deck deleted");
      refresh();
    } catch (e) {
      surfaceDeckError(e, "Could not delete the deck");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex-1 w-full max-w-3xl mx-auto px-4 py-6 space-y-6">
      <SceneBackground src="/hub-bg.png" blur overlay="strong" />
      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" aria-label="Back">
          <Link href="/">
            <ArrowLeft className="size-5" />
          </Link>
        </Button>
        <h1 className="font-heading text-xl font-bold tracking-wide">Decks</h1>
        <Button asChild size="sm" className="ml-auto">
          <Link href="/decks/builder">
            <Plus className="size-4" />
            New Deck
          </Link>
        </Button>
      </header>

      {/* ── Starter decks ── */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
          Starter Decks
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {COLORS.map((c) => {
            const meta = COLOR_META[c];
            const isActive = isStarterActive(c);
            return (
              <div
                key={c}
                className={
                  "rounded-xl border p-3 flex items-center gap-3 transition-shadow " +
                  (isActive ? "ring-2 ring-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.35)]" : "")
                }
                style={{
                  borderColor: meta.hex,
                  background: `linear-gradient(150deg, ${meta.hex}22, #0d0d16 70%)`,
                }}
              >
                <button
                  type="button"
                  onClick={() =>
                    setOpenList({ title: starterName(c), cards: STARTER_DECKS[c] })
                  }
                  className="flex-1 min-w-0 flex items-center gap-3 text-left transition-transform active:scale-[0.98]"
                >
                  <span
                    className="w-11 h-11 shrink-0 rounded-full flex items-center justify-center font-black text-[10px]"
                    style={{ backgroundColor: meta.hex, color: meta.ink }}
                  >
                    {meta.glyph}
                  </span>
                  <span className="min-w-0">
                    <span className="font-bold flex items-center gap-1.5">
                      <span className="truncate">{starterName(c)}</span>
                      {isActive && (
                        <Badge className="bg-amber-400 text-black shrink-0 px-1.5">
                          Active
                        </Badge>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {DECK_SIZE} cards · mono-{meta.name}
                    </span>
                  </span>
                </button>
                <Button
                  size="sm"
                  variant={isActive ? "secondary" : "outline"}
                  className="shrink-0"
                  onClick={() => toggleStarterActive(c)}
                >
                  {isActive ? <Check className="size-4" /> : <Star className="size-4" />}
                  {isActive ? "Active" : "Set Active"}
                </Button>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── My decks ── */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
          My Decks
        </h2>

        {hydrated && !profileName ? (
          <div className="rounded-lg border border-dashed border-border p-4 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <p className="text-sm text-muted-foreground flex-1">
              Set your profile name to save custom decks to the server.
            </p>
            <Button size="sm" variant="secondary" onClick={() => setNameDialog(true)}>
              Set name
            </Button>
          </div>
        ) : !hydrated || decks === null ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : decks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <p className="text-sm text-muted-foreground flex-1">
              No custom decks yet. Build one from scratch or start from a
              starter list.
            </p>
            <Button asChild size="sm" variant="secondary">
              <Link href="/decks/builder">
                <Plus className="size-4" />
                New Deck
              </Link>
            </Button>
          </div>
        ) : (
          <ul className="space-y-2">
            {decks.map((deck) => {
              const color = derivePrimaryColor(deck.cards);
              const meta = COLOR_META[color];
              const v = validateDeck(deck.cards);
              const isActive = active?.id === deck.id;
              return (
                <li
                  key={deck.id}
                  className={
                    "rounded-xl border p-3 space-y-2 " +
                    (isActive
                      ? "ring-2 ring-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.35)]"
                      : "")
                  }
                  style={{
                    borderColor: meta.hex,
                    background: `linear-gradient(150deg, ${meta.hex}1d, #0d0d16 70%)`,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setOpenList({ title: deck.name, cards: deck.cards })}
                    className="w-full flex items-center gap-3 text-left"
                  >
                    <span
                      className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center font-black text-[9px]"
                      style={{ backgroundColor: meta.hex, color: meta.ink }}
                    >
                      {meta.glyph}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="font-bold flex items-center gap-1.5">
                        <span className="truncate">{deck.name}</span>
                        {isActive && (
                          <Badge className="bg-amber-400 text-black shrink-0 px-1.5">
                            Active
                          </Badge>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center gap-2">
                        {deck.cards.length}/{DECK_SIZE} cards
                        {v.ok ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/60 text-emerald-400 px-1.5"
                          >
                            Valid
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-destructive/60 text-destructive px-1.5"
                          >
                            Invalid
                          </Badge>
                        )}
                      </span>
                    </span>
                  </button>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/decks/builder?deck=${deck.id}`}>
                        <Pencil className="size-3.5" />
                        Edit
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => duplicate(deck)}
                    >
                      <Copy className="size-3.5" />
                      Duplicate
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setConfirmDelete(deck)}
                      className="text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </Button>
                    <Button
                      size="sm"
                      variant={isActive ? "secondary" : "outline"}
                      className="ml-auto"
                      disabled={!v.ok && !isActive}
                      title={!v.ok ? "Fix the deck before making it active" : undefined}
                      onClick={() => toggleDeckActive(deck)}
                    >
                      {isActive ? <Check className="size-4" /> : <Star className="size-4" />}
                      {isActive ? "Active" : "Set Active"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Deck contents dialog (starters + my decks) */}
      <Dialog open={!!openList} onOpenChange={(o) => !o && setOpenList(null)}>
        <DialogContent className="max-w-lg">
          {openList && (
            <>
              <DialogTitle className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{
                    backgroundColor: COLOR_META[derivePrimaryColor(openList.cards)].hex,
                  }}
                />
                <span className="truncate">{openList.title}</span>
                <span className="ml-auto text-xs font-normal text-muted-foreground shrink-0">
                  {openList.cards.length}/{DECK_SIZE}
                </span>
              </DialogTitle>
              <ScrollArea className="max-h-[65dvh] pr-3">
                <div className="space-y-4">
                  {groups.map(({ type, entries }) => (
                    <section key={type}>
                      <h3 className="text-xs uppercase tracking-widest text-muted-foreground mb-1.5">
                        {TYPE_LABEL[type]} ({entries.reduce((s, e) => s + e.n, 0)})
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

      {/* Delete confirmation */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-sm">
          {confirmDelete && (
            <>
              <DialogHeader>
                <DialogTitle>Delete &quot;{confirmDelete.name}&quot;?</DialogTitle>
                <DialogDescription>
                  This permanently removes the deck from the server. This cannot
                  be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => remove(confirmDelete)}
                >
                  Delete deck
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ProfileNameDialog open={nameDialog} onOpenChange={setNameDialog} />
    </main>
  );
}
