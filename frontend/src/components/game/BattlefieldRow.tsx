"use client";

import type { CardDef, Instance } from "@chains/game-core";
import { cn } from "@/lib/utils";
import { Inspectable } from "./CardInspect";
import { GameCard, type CardSize } from "./GameCard";

export interface BfItem {
  inst: Instance;
  def: CardDef;
  power?: number;
  toughness?: number;
  selected?: boolean;
  highlighted?: boolean;
  dimmed?: boolean;
  badge?: string;
  auraCount?: number;
  onClick?: () => void;
}

/** One horizontal battlefield row (memes, or nodes+machines). */
export function BattlefieldRow({
  items,
  size = "sm",
  emptyLabel,
  className,
}: {
  items: BfItem[];
  size?: CardSize;
  emptyLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-1.5 px-3 py-1.5 overflow-x-auto min-h-[3rem] items-center",
        className
      )}
    >
      {items.length === 0 && emptyLabel && (
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground/50">
          {emptyLabel}
        </span>
      )}
      {items.map((it) => (
        <Inspectable key={it.inst.uid} def={it.def}>
          <GameCard
            def={it.def}
            size={size}
            tapped={it.inst.tapped}
            selected={it.selected}
            highlighted={it.highlighted}
            dimmed={it.dimmed}
            badge={it.badge}
            power={it.power}
            toughness={it.toughness}
            damage={it.inst.damage || undefined}
            auraCount={it.auraCount}
            onClick={it.onClick}
          />
        </Inspectable>
      ))}
    </div>
  );
}
