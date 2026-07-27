"use client";

import { Button } from "@/components/ui/button";
import { Swords, ShieldCheck, X, Hourglass } from "lucide-react";

/** Center-strip action buttons: attack / blocks / end turn / force end. */
export function CombatControls({
  isMyTurn,
  attackMode,
  attackerCount,
  amBlocking,
  waitingForBlocks,
  canForceEndTurn,
  onToggleAttackMode,
  onConfirmAttack,
  onConfirmBlocks,
  onEndTurn,
  onForceEndTurn,
}: {
  isMyTurn: boolean;
  attackMode: boolean;
  attackerCount: number;
  /** I am the defender in the blockers stage. */
  amBlocking: boolean;
  /** I attacked, opponent is choosing blocks. */
  waitingForBlocks: boolean;
  canForceEndTurn: boolean;
  onToggleAttackMode: () => void;
  onConfirmAttack: () => void;
  onConfirmBlocks: () => void;
  onEndTurn: () => void;
  onForceEndTurn: () => void;
}) {
  if (amBlocking) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground hidden sm:inline">
          Tap an attacker, then your blocker
        </span>
        <Button size="sm" onClick={onConfirmBlocks}>
          <ShieldCheck className="size-4" /> Confirm Blocks
        </Button>
      </div>
    );
  }

  if (waitingForBlocks) {
    return (
      <span className="text-xs text-muted-foreground animate-pulse">
        Opponent is declaring blocks…
      </span>
    );
  }

  if (!isMyTurn) {
    if (canForceEndTurn) {
      return (
        <Button size="sm" variant="destructive" onClick={onForceEndTurn}>
          <Hourglass className="size-4" /> Force End Turn
        </Button>
      );
    }
    return (
      <span className="text-xs text-muted-foreground">Opponent&apos;s turn…</span>
    );
  }

  if (attackMode) {
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onToggleAttackMode}>
          <X className="size-4" /> Cancel
        </Button>
        <Button
          size="sm"
          disabled={attackerCount === 0}
          onClick={onConfirmAttack}
        >
          <Swords className="size-4" /> Confirm Attack ({attackerCount})
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="secondary" onClick={onToggleAttackMode}>
        <Swords className="size-4" /> Attack
      </Button>
      <Button size="sm" onClick={onEndTurn}>
        End Turn
      </Button>
    </div>
  );
}
