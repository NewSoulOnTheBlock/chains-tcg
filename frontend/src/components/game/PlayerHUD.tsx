"use client";

import { COLOR_META, COLORS, type Color } from "@chains/game-core";
import { cn } from "@/lib/utils";
import { CardBack } from "./GameCard";

export function PlayerHUD({
  name,
  color,
  life,
  deckCount,
  graveyardCount,
  handCount,
  isYou,
  isTurn,
  targetable,
  onClick,
}: {
  name: string;
  color: Color;
  life: number;
  deckCount: number;
  graveyardCount: number;
  /** Shown as card backs (opponent only). */
  handCount?: number;
  isYou?: boolean;
  isTurn?: boolean;
  targetable?: boolean;
  onClick?: () => void;
}) {
  const meta = COLOR_META[color];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2 text-left",
        "bg-card/70 border-y border-border",
        targetable && "ring-2 ring-inset ring-ring animate-pulse cursor-pointer",
        !onClick && "cursor-default"
      )}
      aria-label={`${name} — ${life} life`}
    >
      {/* Life orb */}
      <span
        className={cn(
          "relative shrink-0 w-11 h-11 rounded-full flex items-center justify-center font-black text-lg",
          "bg-gradient-to-b from-black/60 to-black/20 text-foreground",
          life <= 5 ? "text-red-400" : ""
        )}
        style={{ boxShadow: `0 0 0 2px ${meta.hex}, 0 0 14px ${meta.hex}66` }}
      >
        {life}
      </span>

      {/* Name + badges */}
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="font-semibold truncate">{name}</span>
          {isYou && (
            <span className="text-[9px] font-bold uppercase rounded bg-primary/20 text-primary px-1 py-px">
              You
            </span>
          )}
          {isTurn && (
            <span className="text-[9px] font-bold uppercase rounded bg-accent text-accent-foreground px-1 py-px">
              Turn
            </span>
          )}
        </span>
        <span className="block text-[10px] text-muted-foreground truncate">
          {meta.name} deck · {deckCount} in deck · {graveyardCount} in graveyard
        </span>
      </span>

      {/* Opponent hand as card backs */}
      {handCount !== undefined && (
        <span className="flex items-center -space-x-3 shrink-0" aria-label={`${handCount} cards in hand`}>
          {Array.from({ length: Math.min(handCount, 5) }).map((_, i) => (
            <CardBack key={i} size="xs" className="w-5 h-7 rounded-sm" />
          ))}
          <span className="pl-4 text-xs font-bold text-muted-foreground">
            {handCount}
          </span>
        </span>
      )}
    </button>
  );
}

/** Your floating gas pool: 5 chain pips with counts. */
export function GasBar({ gas }: { gas: Record<Color, number> }) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5">
      <span className="text-[9px] uppercase tracking-widest text-muted-foreground mr-1">
        Gas
      </span>
      {COLORS.map((c) => {
        const n = gas[c] ?? 0;
        const meta = COLOR_META[c];
        return (
          <span
            key={c}
            className={cn(
              "inline-flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold ring-1",
              n > 0 ? "" : "opacity-25"
            )}
            style={{
              backgroundColor: n > 0 ? meta.hex : `${meta.hex}33`,
              color: n > 0 ? meta.ink : undefined,
              boxShadow: n > 0 ? `0 0 8px ${meta.hex}88` : undefined,
            }}
            aria-label={`${meta.name} gas: ${n}`}
          >
            {n}
          </span>
        );
      })}
    </div>
  );
}
