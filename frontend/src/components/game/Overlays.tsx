"use client";

// Full-screen phase overlays + log sheet used by the Board.

import {
  CARDS,
  COLOR_META,
  COLORS,
  MULLIGAN_FLOOR,
  MULLIGAN_INITIAL_HAND,
  type Color,
} from "@chains/game-core";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ScrollText } from "lucide-react";
import { GameCard } from "./GameCard";

/** Phase 'pick' — full-screen chain color picker (5 tiles). */
export function ColorPickOverlay({
  waiting,
  onPick,
}: {
  /** True when I already picked and the opponent hasn't. */
  waiting: boolean;
  onPick: (c: Color) => void;
}) {
  return (
    <div className="fixed inset-0 z-40 bg-background/95 backdrop-blur flex flex-col items-center justify-center gap-6 p-6">
      <h2 className="text-xl font-bold tracking-wide">
        {waiting ? "Waiting for opponent…" : "Choose your chain"}
      </h2>
      {!waiting && (
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 w-full max-w-2xl">
          {COLORS.map((c) => {
            const meta = COLOR_META[c];
            return (
              <button
                key={c}
                type="button"
                onClick={() => onPick(c)}
                className="rounded-xl border p-4 flex sm:flex-col items-center gap-3 transition-transform active:scale-95 hover:-translate-y-0.5"
                style={{
                  borderColor: meta.hex,
                  background: `linear-gradient(160deg, ${meta.hex}22, #0d0d16)`,
                }}
              >
                <span
                  className="w-12 h-12 rounded-full flex items-center justify-center font-black text-xs"
                  style={{ backgroundColor: meta.hex, color: meta.ink }}
                >
                  {meta.glyph}
                </span>
                <span className="font-semibold">{meta.name}</span>
              </button>
            );
          })}
        </div>
      )}
      {waiting && (
        <p className="text-sm text-muted-foreground animate-pulse">
          Your opponent is choosing a chain.
        </p>
      )}
    </div>
  );
}

/** Phase 'mulligan' — keep / mulligan your opening hand. */
export function MulliganOverlay({
  hand,
  count,
  done,
  opponentDone,
  deadlinePassed,
  onKeep,
  onMulligan,
  onForceKeepOpponent,
}: {
  hand: string[];
  count: number;
  done: boolean;
  opponentDone: boolean;
  deadlinePassed: boolean;
  onKeep: () => void;
  onMulligan: () => void;
  onForceKeepOpponent: () => void;
}) {
  const maxMulls = MULLIGAN_INITIAL_HAND - MULLIGAN_FLOOR + 1;
  const canMull = count < maxMulls;
  return (
    <div className="fixed inset-0 z-40 bg-background/95 backdrop-blur flex flex-col items-center justify-center gap-5 p-4">
      <h2 className="text-xl font-bold tracking-wide">Opening hand</h2>
      <div className="flex flex-wrap justify-center gap-2 max-w-3xl">
        {hand.map((id, i) => {
          const def = CARDS[id];
          return def ? <GameCard key={`${id}-${i}`} def={def} size="md" /> : null;
        })}
      </div>
      {done ? (
        <p className="text-sm text-muted-foreground animate-pulse">
          Hand kept. Waiting for opponent…
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <Button variant="secondary" onClick={onMulligan} disabled={!canMull}>
            Mulligan{count > 0 ? ` (#${count + 1})` : ""}
          </Button>
          <Button onClick={onKeep}>Keep Hand</Button>
        </div>
      )}
      {!opponentDone && deadlinePassed && (
        <Button variant="destructive" size="sm" onClick={onForceKeepOpponent}>
          Force opponent to keep (timeout)
        </Button>
      )}
    </div>
  );
}

/** ctx.gameover — victory / defeat / draw. */
export function GameOverDialog({
  gameover,
  playerID,
  onExit,
}: {
  gameover: { winner?: string; draw?: boolean } | undefined;
  playerID: string;
  onExit: () => void;
}) {
  if (!gameover) return null;
  const result = gameover.draw
    ? "Draw"
    : gameover.winner === playerID
      ? "Victory"
      : "Defeat";
  const flavor = gameover.draw
    ? "Both chains fell together."
    : gameover.winner === playerID
      ? "The opposing chain has been broken."
      : "Your chain has been broken.";
  return (
    <Dialog open>
      <DialogContent showCloseButton={false} className="text-center">
        <DialogHeader>
          <DialogTitle
            className={
              "text-4xl font-black tracking-widest text-center " +
              (result === "Victory"
                ? "text-primary"
                : result === "Defeat"
                  ? "text-destructive"
                  : "")
            }
          >
            {result.toUpperCase()}
          </DialogTitle>
          <DialogDescription className="text-center">{flavor}</DialogDescription>
        </DialogHeader>
        <Button onClick={onExit} className="mt-2">
          Back to lobby
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/** Action log in a bottom sheet (last ~50 entries, newest first). */
export function LogSheet({ log }: { log: string[] }) {
  const entries = log.slice(-50).reverse();
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Action log">
          <ScrollText className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[60dvh]">
        <SheetHeader>
          <SheetTitle>Action log</SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[45dvh] px-4 pb-4">
          <ol className="space-y-1 text-xs text-muted-foreground">
            {entries.map((line, i) => (
              <li
                key={`${i}-${line}`}
                className={line.startsWith("—") ? "text-foreground font-semibold pt-1" : ""}
              >
                {line}
              </li>
            ))}
          </ol>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
