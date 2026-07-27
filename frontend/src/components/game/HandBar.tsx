"use client";

import { CARDS, type PlayerState } from "@chains/game-core";
import { canPlayFromHand } from "@/lib/game";
import { Inspectable } from "./CardInspect";
import { GameCard } from "./GameCard";

/** Your hand: horizontally scrollable card fan pinned to the bottom. */
export function HandBar({
  player,
  isMyTurn,
  onSelect,
}: {
  player: PlayerState;
  isMyTurn: boolean;
  onSelect: (handIndex: number) => void;
}) {
  return (
    <div className="border-t border-border bg-gradient-to-t from-black/60 to-transparent">
      <div className="flex gap-1.5 px-3 pt-2 pb-3 overflow-x-auto items-end min-h-[9rem]">
        {player.hand.length === 0 && (
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground/50 pb-6">
            Hand empty
          </span>
        )}
        {player.hand.map((defId, i) => {
          const def = CARDS[defId];
          if (!def) return null;
          const affordable = isMyTurn && canPlayFromHand(player, def);
          return (
            <Inspectable key={`${defId}-${i}`} def={def}>
              <GameCard
                def={def}
                size="md"
                dimmed={!affordable}
                onClick={() => onSelect(i)}
                className="hover:-translate-y-2"
              />
            </Inspectable>
          );
        })}
      </div>
    </div>
  );
}
