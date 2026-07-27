"use client";

// Deck builder — /decks/builder (new) and /decks/builder?deck=<id> (edit).
// The deck id is read from window.location after hydration (same pattern as
// play/[matchID]) to avoid the useSearchParams Suspense requirement.
//
// Mobile-first split: the card pool fills the page; the deck list lives in a
// bottom drawer (trigger shows the live count). On lg+ screens the deck list
// is a sticky right sidebar instead.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BUILDABLE_CARDS,
  CARDS,
  COLOR_META,
  COLORS,
  DECK_SIZE,
  MAX_COPIES_NONBASIC,
  STARTER_DECKS,
  costTotal,
  isBasicNode,
  validateDeck,
  type CardDef,
  type CardType,
  type Color,
} from "@chains/game-core";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  Check,
  Layers,
  Minus,
  Plus,
  Save,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { GameCard } from "@/components/game/GameCard";
import { SceneBackground } from "@/components/SceneBackground";
import { ProfileNameDialog, useProfileName } from "@/components/ProfileNameDialog";
import { useHydrated } from "@/hooks/useHydrated";
import {
  DeckApiError,
  createDeck,
  listMyDecks,
  setActiveDeck,
  updateDeck,
} from "@/lib/decks";

const TYPE_ORDER: CardType[] = ["node", "meme", "machine", "aura", "move"];
const TYPE_LABEL: Record<CardType, string> = {
  node: "Nodes",
  meme: "Memes",
  machine: "Machines",
  aura: "Auras",
  move: "Moves",
};
const TYPES: Array<CardType | "all"> = ["all", ...TYPE_ORDER];

function surfaceDeckError(e: unknown, fallback: string) {
  if (e instanceof DeckApiError) {
    if (e.issues.length) e.issues.forEach((i) => toast.error(i.message));
    else toast.error(e.message || fallback);
  } else {
    toast.error(fallback);
  }
}

/** Deck contents grouped by type, entries sorted by cost then name. */
function deckGroups(counts: Map<string, number>) {
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

export default function DeckBuilderPage() {
  const hydrated = useHydrated();
  const router = useRouter();
  const { name: profileName } = useProfileName();

  // Deck being edited
  const [deckId, setDeckId] = useState<number | null>(null);
  const [fetched, setFetched] = useState(false); // ?deck= server lookup finished
  const [deckName, setDeckName] = useState("");
  const [cards, setCards] = useState<string[]>([]);

  // Pool filters
  const [color, setColor] = useState<Color | "all">("all");
  const [type, setType] = useState<CardType | "all">("all");
  const [query, setQuery] = useState("");

  const [preview, setPreview] = useState<CardDef | null>(null);
  const [nameDialog, setNameDialog] = useState(false);
  const [saving, setSaving] = useState(false);

  // Resolve ?deck=<id> after hydration (window.location, not useSearchParams —
  // avoids the Suspense boundary requirement; same approach as play/[matchID]).
  // null = no/invalid param (new deck), number = deck id to load.
  const deckParam = useMemo<number | null>(() => {
    if (!hydrated) return null;
    const raw = new URLSearchParams(window.location.search).get("deck");
    const id = raw ? Number(raw) : NaN;
    return Number.isInteger(id) ? id : null;
  }, [hydrated]);

  useEffect(() => {
    if (deckParam === null || fetched) return;
    let live = true;
    // No GET /api/decks/:id on the server — find it in the profile's list.
    listMyDecks()
      .then((rows) => {
        if (!live) return;
        const row = rows.find((r) => r.id === deckParam);
        if (row) {
          setDeckId(row.id);
          setDeckName(row.name);
          setCards(row.cards);
        } else {
          toast.error("Deck not found — starting a new deck");
        }
        setFetched(true);
      })
      .catch(() => {
        if (!live) return;
        toast.error("Could not load the deck from the server");
        setFetched(true);
      });
    return () => {
      live = false;
    };
  }, [deckParam, fetched]);

  const resolved = hydrated && (deckParam === null || fetched);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const id of cards) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [cards]);

  const groups = useMemo(() => deckGroups(counts), [counts]);
  const validation = useMemo(() => validateDeck(cards), [cards]);

  const pool = useMemo(() => {
    const q = query.trim().toLowerCase();
    return BUILDABLE_CARDS.filter(
      (c) =>
        (color === "all" || c.color === color) &&
        (type === "all" || c.type === type) &&
        (!q || c.name.toLowerCase().includes(q) || c.text.toLowerCase().includes(q))
    ).sort(
      (a, b) =>
        COLORS.indexOf(a.color) - COLORS.indexOf(b.color) ||
        costTotal(a.cost) - costTotal(b.cost) ||
        a.name.localeCompare(b.name)
    );
  }, [color, type, query]);

  // Mana curve buckets 0..6+ over non-node cards.
  const curve = useMemo(() => {
    const buckets = Array(7).fill(0) as number[];
    for (const id of cards) {
      const def = CARDS[id];
      if (!def || def.type === "node") continue;
      buckets[Math.min(costTotal(def.cost), 6)]++;
    }
    return buckets;
  }, [cards]);
  const curveMax = Math.max(1, ...curve);

  // Per-chain distribution (all cards, nodes included).
  const colorCounts = useMemo(() => {
    const m: Record<Color, number> = { bnb: 0, sol: 0, eth: 0, robinhood: 0, base: 0 };
    for (const id of cards) {
      const def = CARDS[id];
      if (def) m[def.color]++;
    }
    return m;
  }, [cards]);

  const addCard = (id: string) => {
    const n = counts.get(id) ?? 0;
    if (!isBasicNode(id) && n >= MAX_COPIES_NONBASIC) {
      toast.warning(`Max ${MAX_COPIES_NONBASIC} copies of ${CARDS[id]?.name ?? id}`);
      return;
    }
    if (cards.length >= DECK_SIZE) {
      toast.warning(`Deck is full (${DECK_SIZE} cards) — remove something first`);
      return;
    }
    setCards((prev) => [...prev, id]);
  };

  const removeCard = (id: string) => {
    setCards((prev) => {
      const i = prev.lastIndexOf(id);
      if (i === -1) return prev;
      return [...prev.slice(0, i), ...prev.slice(i + 1)];
    });
  };

  const loadStarter = (c: Color) => {
    setCards([...STARTER_DECKS[c]]);
    if (!deckName.trim()) setDeckName(`My ${COLOR_META[c].name} Deck`);
  };

  const save = async (activate: boolean) => {
    if (!profileName) {
      setNameDialog(true);
      return;
    }
    const nm = deckName.trim() || "Untitled Deck";
    setSaving(true);
    try {
      const row = deckId
        ? await updateDeck(deckId, { name: nm, cards })
        : await createDeck(nm, cards);
      setDeckId(row.id);
      setDeckName(row.name);
      // Keep the URL editable-on-refresh without remounting the page.
      window.history.replaceState(null, "", `/decks/builder?deck=${row.id}`);
      if (activate) {
        setActiveDeck({ id: row.id, name: row.name, cards: row.cards });
        toast.success(`Saved — "${row.name}" is your active deck`);
        router.push("/decks");
      } else {
        toast.success("Deck saved");
      }
    } catch (e) {
      surfaceDeckError(e, "Could not save the deck");
    } finally {
      setSaving(false);
    }
  };

  const deckPanel = (
    <div className="flex flex-col min-h-0 flex-1">
      <ScrollArea className="flex-1 min-h-0 px-3">
        {cards.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            Tap cards in the pool to add them.
          </p>
        ) : (
          <div className="space-y-3 py-2">
            {groups.map(({ type: t, entries }) => (
              <section key={t}>
                <h3 className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
                  {TYPE_LABEL[t]} ({entries.reduce((s, e) => s + e.n, 0)})
                </h3>
                <ul className="space-y-1">
                  {entries.map(({ def, n }) => {
                    const capped =
                      !isBasicNode(def.id) && n >= MAX_COPIES_NONBASIC;
                    return (
                      <li
                        key={def.id}
                        className="flex items-center gap-1.5 rounded-md bg-secondary/50 pl-2 pr-1 py-1"
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: COLOR_META[def.color].hex }}
                        />
                        <button
                          type="button"
                          onClick={() => setPreview(def)}
                          className="flex-1 min-w-0 text-left text-sm truncate hover:underline"
                        >
                          {def.name}
                        </button>
                        <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                          ×{n}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 shrink-0"
                          aria-label={`Remove one ${def.name}`}
                          onClick={() => removeCard(def.id)}
                        >
                          <Minus className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 shrink-0"
                          aria-label={`Add one ${def.name}`}
                          disabled={capped || cards.length >= DECK_SIZE}
                          onClick={() => addCard(def.id)}
                        >
                          <Plus className="size-3.5" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Live footer: size, issues, curve, colors */}
      <div className="border-t border-border px-3 py-2 space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <span
            className={
              "text-sm font-bold tabular-nums " +
              (cards.length === DECK_SIZE ? "text-emerald-400" : "")
            }
          >
            {cards.length}/{DECK_SIZE}
          </span>
          {validation.ok ? (
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
          {cards.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 px-2 text-xs text-muted-foreground"
              onClick={() => setCards([])}
            >
              <Trash2 className="size-3" />
              Clear
            </Button>
          )}
        </div>

        {!validation.ok && (
          <ul className="space-y-0.5">
            {validation.issues.slice(0, 4).map((i, idx) => (
              <li key={`${i.code}-${idx}`} className="text-xs text-destructive">
                {i.message}
              </li>
            ))}
          </ul>
        )}

        {/* Mana curve (non-node cards, buckets 0–6+) */}
        <div>
          <div className="flex items-end gap-1 h-10">
            {curve.map((n, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
                <span className="text-[9px] text-muted-foreground leading-none tabular-nums">
                  {n > 0 ? n : ""}
                </span>
                <div
                  className="w-full rounded-sm bg-primary/70"
                  style={{ height: `${(n / curveMax) * 24 + (n > 0 ? 3 : 1)}px` }}
                />
              </div>
            ))}
          </div>
          <div className="flex gap-1">
            {["0", "1", "2", "3", "4", "5", "6+"].map((l) => (
              <span
                key={l}
                className="flex-1 text-center text-[9px] text-muted-foreground"
              >
                {l}
              </span>
            ))}
          </div>
        </div>

        {/* Chain distribution */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {COLORS.filter((c) => colorCounts[c] > 0).map((c) => (
            <span key={c} className="inline-flex items-center gap-1 text-xs">
              <span
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: COLOR_META[c].hex }}
              />
              <span className="text-muted-foreground tabular-nums">
                {colorCounts[c]}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );

  if (!hydrated || !resolved) {
    return (
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-6 space-y-4">
        <SceneBackground src="/hub-bg.png" blur overlay="strong" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </main>
    );
  }

  return (
    <main className="flex-1 w-full max-w-6xl mx-auto px-4 pt-6 pb-24 lg:pb-6">
      <SceneBackground src="/hub-bg.png" blur overlay="strong" />
      <div className="lg:flex lg:gap-5 lg:items-start">
        {/* ── Pool column ── */}
        <div className="min-w-0 flex-1 space-y-4">
          <header className="flex items-center gap-2">
            <Button asChild variant="ghost" size="icon" aria-label="Back to decks">
              <Link href="/decks">
                <ArrowLeft className="size-5" />
              </Link>
            </Button>
            <Input
              value={deckName}
              onChange={(e) => setDeckName(e.target.value)}
              placeholder="Deck name"
              aria-label="Deck name"
              className="max-w-56 font-semibold"
            />
            <div className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant="secondary" disabled={saving} onClick={() => save(false)}>
                <Save className="size-4" />
                <span className="hidden sm:inline">Save</span>
              </Button>
              <Button size="sm" disabled={saving} onClick={() => save(true)}>
                <Star className="size-4" />
                <span className="hidden sm:inline">Save &amp; Set Active</span>
                <span className="sm:hidden">+ Active</span>
              </Button>
            </div>
          </header>

          {/* Start from — shown while the deck is empty */}
          {cards.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-3 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-widest text-muted-foreground mr-1">
                Start from
              </span>
              {COLORS.map((c) => {
                const meta = COLOR_META[c];
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => loadStarter(c)}
                    className="rounded-full px-2.5 py-1 text-xs font-bold border transition-transform active:scale-95"
                    style={{
                      borderColor: meta.hex,
                      background: `${meta.hex}22`,
                      color: meta.hex === "#f5f5f5" ? "#f5f5f5" : meta.hex,
                    }}
                  >
                    {meta.name}
                  </button>
                );
              })}
              <span className="text-xs text-muted-foreground">or an empty list</span>
            </div>
          )}

          {/* Filters */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search cards…"
                  aria-label="Search cards"
                  className="pl-7"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setColor("all")}
                className={
                  "rounded-full px-2.5 py-1 text-xs font-semibold border " +
                  (color === "all"
                    ? "bg-foreground text-background border-foreground"
                    : "border-border text-muted-foreground")
                }
              >
                All chains
              </button>
              {COLORS.map((c) => {
                const meta = COLOR_META[c];
                const on = color === c;
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(on ? "all" : c)}
                    className="rounded-full px-2.5 py-1 text-xs font-bold border transition-colors"
                    style={
                      on
                        ? { backgroundColor: meta.hex, color: meta.ink, borderColor: meta.hex }
                        : { borderColor: `${meta.hex}88`, color: meta.hex === "#f5f5f5" ? "#f5f5f5" : meta.hex }
                    }
                  >
                    {meta.glyph}
                  </button>
                );
              })}
              <span className="w-px bg-border mx-0.5" aria-hidden />
              {TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={
                    "rounded-full px-2.5 py-1 text-xs font-semibold border " +
                    (type === t
                      ? "bg-foreground text-background border-foreground"
                      : "border-border text-muted-foreground")
                  }
                >
                  {t === "all" ? "All types" : TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          {/* Pool grid — tap to add */}
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
            {pool.map((def) => {
              const n = counts.get(def.id) ?? 0;
              const capped = !isBasicNode(def.id) && n >= MAX_COPIES_NONBASIC;
              return (
                <GameCard
                  key={def.id}
                  def={def}
                  size="md"
                  className="w-full"
                  badge={n > 0 ? `${n}` : undefined}
                  dimmed={capped}
                  onClick={() => addCard(def.id)}
                />
              );
            })}
            {pool.length === 0 && (
              <p className="col-span-full text-sm text-muted-foreground py-8 text-center">
                No cards match these filters.
              </p>
            )}
          </div>
        </div>

        {/* ── Deck panel: desktop sidebar ── */}
        <aside className="hidden lg:flex lg:flex-col w-80 shrink-0 sticky top-4 max-h-[calc(100dvh-2rem)] rounded-xl border border-border bg-background/80 backdrop-blur overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
            <Layers className="size-4 text-muted-foreground" />
            <h2 className="font-heading text-sm font-bold tracking-wide truncate">
              {deckName.trim() || "New Deck"}
            </h2>
          </div>
          {deckPanel}
        </aside>
      </div>

      {/* ── Deck panel: mobile bottom drawer ── */}
      <div className="lg:hidden fixed bottom-4 inset-x-0 z-30 flex justify-center pointer-events-none">
        <Drawer>
          <DrawerTrigger asChild>
            <Button className="pointer-events-auto shadow-lg" size="lg">
              <Layers className="size-4" />
              Deck
              <Badge
                className={
                  "ml-1 px-1.5 " +
                  (validation.ok
                    ? "bg-emerald-500 text-black"
                    : "bg-background/30 text-primary-foreground")
                }
              >
                {cards.length}/{DECK_SIZE}
              </Badge>
              {validation.ok && <Check className="size-3.5" />}
            </Button>
          </DrawerTrigger>
          <DrawerContent className="h-[80dvh]">
            <DrawerHeader className="pb-1">
              <DrawerTitle className="truncate">
                {deckName.trim() || "New Deck"}
              </DrawerTitle>
            </DrawerHeader>
            {deckPanel}
          </DrawerContent>
        </Drawer>
      </div>

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

      <ProfileNameDialog
        open={nameDialog}
        onOpenChange={setNameDialog}
        onSaved={() => toast.info("Profile saved — hit Save again to store the deck")}
      />
    </main>
  );
}
