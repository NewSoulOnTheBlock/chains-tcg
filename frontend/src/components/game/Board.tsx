"use client";

// Chains TCG board — mobile-first, top-to-bottom:
// opponent HUD / opponent battlefield / center strip / your battlefield /
// gas + your HUD / your hand.

import { useEffect, useMemo, useState } from "react";
import { CARDS, type CardDef, type GState } from "@chains/game-core";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { X, LogOut } from "lucide-react";
import {
  attachedAuras,
  canPlayFromHand,
  memeStats,
  opponentOf,
  playerTargetId,
  targetKindFor,
  type TargetKind,
} from "@/lib/game";
import { BattlefieldRow, type BfItem } from "./BattlefieldRow";
import { CardInspectCaption, CardInspectProvider } from "./CardInspect";
import { CombatControls } from "./CombatControls";
import { GameCard } from "./GameCard";
import { HandBar } from "./HandBar";
import { GasBar, PlayerHUD } from "./PlayerHUD";
import {
  ColorPickOverlay,
  GameOverDialog,
  LogSheet,
  MulliganOverlay,
} from "./Overlays";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BoardProps {
  G: GState & { deckCounts?: Record<string, number> };
  ctx: any;
  moves: Record<string, (...args: any[]) => void>;
  playerID: string;
  matchData?: Array<{ id: number; name?: string; isConnected?: boolean }>;
  onExit: () => void;
}

interface Targeting {
  handIndex: number;
  defId: string;
}

export function Board({ G, ctx, moves, playerID, matchData, onExit }: BoardProps) {
  const oppId = opponentOf(playerID);
  const me = G.players[playerID];
  const opp = G.players[oppId];

  const [attackMode, setAttackMode] = useState(false);
  const [targeting, setTargeting] = useState<Targeting | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [selectedAttacker, setSelectedAttacker] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // 1s ticker so deadline-gated buttons (force keep / force end turn) appear.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const isMyTurn = ctx.phase === "play" && ctx.currentPlayer === playerID;
  const myStage = ctx.activePlayers?.[playerID];
  const amBlocking = myStage === "blockers";
  const waitingForBlocks = ctx.activePlayers?.[oppId] === "blockers";

  // Reset transient UI when the turn / combat stage flips
  // (render-time state adjustment — no effect needed).
  const uiKey = `${ctx.currentPlayer}|${amBlocking}`;
  const [prevUiKey, setPrevUiKey] = useState(uiKey);
  if (uiKey !== prevUiKey) {
    setPrevUiKey(uiKey);
    setAttackMode(false);
    setTargeting(null);
    setSelectedAttacker(null);
  }

  const targetKind: TargetKind = targeting
    ? targetKindFor(CARDS[targeting.defId])
    : null;

  const attackerIndex = useMemo(() => {
    const map = new Map<string, number>();
    G.combat.attackers.forEach((a, i) => map.set(a.memeUid, i + 1));
    return map;
  }, [G.combat.attackers]);

  /** attacker uid a given blocker uid is assigned to (defender side). */
  const blockAssignment = useMemo(() => {
    const map = new Map<string, string>();
    for (const [att, list] of Object.entries(G.combat.blocks)) {
      for (const b of list) map.set(b, att);
    }
    return map;
  }, [G.combat.blocks]);

  const nameOf = (pid: string) => {
    const fromMatch = matchData?.find((m) => String(m.id) === pid)?.name;
    return fromMatch || G.players[pid]?.profileName || `Player ${pid}`;
  };

  function playWithTarget(uid: string) {
    if (!targeting) return;
    moves.playCard(targeting.handIndex, uid);
    setTargeting(null);
  }

  function handlePlayFromPreview(i: number) {
    const def = CARDS[me.hand[i]];
    if (!def) return;
    setPreviewIndex(null);
    if (targetKindFor(def)) {
      setTargeting({ handIndex: i, defId: def.id });
    } else {
      moves.playCard(i);
    }
  }

  function cancelAttackMode() {
    for (const a of [...G.combat.attackers]) moves.declareAttacker(a.memeUid);
    setAttackMode(false);
  }

  // ── Battlefield item builders ─────────────────────────────────────────────
  function memeItems(pid: string): BfItem[] {
    const mine = pid === playerID;
    return G.players[pid].memes.map((inst) => {
      const def = CARDS[inst.defId];
      const stats = memeStats(G, pid, inst);
      const auraCount = attachedAuras(G, inst.uid).length || undefined;
      let onClick: (() => void) | undefined;
      let highlighted = false;
      let selected = false;
      let badge: string | undefined;

      const atkNo = attackerIndex.get(inst.uid);
      if (atkNo) badge = `⚔${atkNo}`;

      if (targeting && (targetKind === "meme" || targetKind === "any")) {
        highlighted = true;
        onClick = () => playWithTarget(inst.uid);
      } else if (mine && attackMode) {
        const ready = !inst.tapped && !inst.summoningSick;
        if (ready) {
          highlighted = !atkNo;
          selected = !!atkNo;
          onClick = () => moves.declareAttacker(inst.uid);
        }
      } else if (amBlocking) {
        if (!mine && atkNo) {
          // Enemy attacker: select it to assign a blocker.
          selected = selectedAttacker === inst.uid;
          highlighted = !selected;
          onClick = () => setSelectedAttacker(inst.uid);
        } else if (mine && !inst.tapped) {
          const assignedTo = blockAssignment.get(inst.uid);
          if (assignedTo) badge = `🛡${attackerIndex.get(assignedTo) ?? ""}`;
          highlighted = !!selectedAttacker;
          onClick = selectedAttacker
            ? () => moves.declareBlocker(inst.uid, selectedAttacker)
            : undefined;
        }
      } else if (mine && !attackMode && inst.summoningSick && !badge) {
        badge = "zZ";
      }

      return {
        inst,
        def,
        power: stats.power,
        toughness: stats.toughness,
        auraCount,
        onClick,
        highlighted,
        selected,
        badge,
      };
    });
  }

  function supportItems(pid: string): BfItem[] {
    const mine = pid === playerID;
    const p = G.players[pid];
    const nodes: BfItem[] = p.nodes.map((inst) => ({
      inst,
      def: CARDS[inst.defId],
      onClick:
        mine && isMyTurn && !attackMode && !targeting && !inst.tapped
          ? () => moves.tapNode(inst.uid)
          : undefined,
      highlighted:
        mine && isMyTurn && !attackMode && !targeting && !inst.tapped,
    }));
    const machines: BfItem[] = p.machines
      .filter((m) => !m.attachedTo)
      .map((inst) => ({
        inst,
        def: CARDS[inst.defId],
        highlighted: !!targeting && targetKind === "machine",
        onClick:
          targeting && targetKind === "machine"
            ? () => playWithTarget(inst.uid)
            : undefined,
      }));
    return [...machines, ...nodes];
  }

  // ── Phase overlays ────────────────────────────────────────────────────────
  if (ctx.phase === "pick") {
    return (
      <ColorPickOverlay
        waiting={!me.needsColorPick}
        onPick={(c, deck) => moves.chooseColor(c, deck)}
      />
    );
  }
  if (ctx.phase === "mulligan") {
    return (
      <MulliganOverlay
        hand={me.hand}
        count={G.mulligan.counts[playerID] ?? 0}
        done={!!G.mulligan.done[playerID]}
        opponentDone={!!G.mulligan.done[oppId]}
        deadlinePassed={!!G.mulligan.deadline && now > G.mulligan.deadline}
        onKeep={() => moves.keepHand()}
        onMulligan={() => moves.mulligan()}
        onForceKeepOpponent={() => moves.forceKeepOpponent()}
      />
    );
  }

  const deckCounts = G.deckCounts ?? {};
  const canForceEndTurn =
    !isMyTurn && !!G.turnDeadline && now > G.turnDeadline && !ctx.gameover;
  const previewDef: CardDef | undefined =
    previewIndex != null ? CARDS[me.hand[previewIndex]] : undefined;

  // Suppress hover/long-press card previews while clicks mean something else
  // (choosing targets, declaring attackers, assigning blockers).
  const inspectSuppressed = !!targeting || attackMode || amBlocking;

  return (
    <CardInspectProvider suppressed={inspectSuppressed}>
    <div className="fixed inset-0 flex flex-col bg-background overflow-hidden">
      {/* Opponent HUD */}
      <PlayerHUD
        name={nameOf(oppId)}
        color={opp.color}
        life={opp.life}
        deckCount={deckCounts[oppId] ?? 0}
        graveyardCount={opp.graveyard.length}
        handCount={opp.hand.length}
        isTurn={ctx.currentPlayer === oppId}
        targetable={!!targeting && targetKind === "any"}
        onClick={
          targeting && targetKind === "any"
            ? () => playWithTarget(playerTargetId(oppId))
            : undefined
        }
      />

      {/* Opponent battlefield — legacy playmat surface, darkened for card contrast */}
      <div
        className="flex-1 min-h-0 flex flex-col justify-start overflow-y-auto"
        style={{
          backgroundImage:
            "linear-gradient(rgba(8,6,14,0.68), rgba(8,6,14,0.68)), url(/playmat.png)",
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        <BattlefieldRow
          items={supportItems(oppId)}
          size="xs"
          emptyLabel="No nodes or machines"
        />
        <BattlefieldRow
          items={memeItems(oppId)}
          size="sm"
          emptyLabel="No memes"
        />

        {/* Center strip */}
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-y border-border bg-background/80 backdrop-blur-sm">
          <div className="flex items-center gap-1 min-w-0">
            <LogSheet log={G.log} />
            <span className="text-[11px] font-semibold truncate">
              Turn {ctx.turn} ·{" "}
              {amBlocking
                ? "Declare blocks"
                : waitingForBlocks
                  ? "Combat"
                  : isMyTurn
                    ? "Your turn"
                    : "Opponent's turn"}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <CombatControls
              isMyTurn={isMyTurn}
              attackMode={attackMode}
              attackerCount={G.combat.attackers.length}
              amBlocking={amBlocking}
              waitingForBlocks={waitingForBlocks}
              canForceEndTurn={canForceEndTurn}
              onToggleAttackMode={() =>
                attackMode ? cancelAttackMode() : setAttackMode(true)
              }
              onConfirmAttack={() => {
                moves.confirmAttackers();
                setAttackMode(false);
              }}
              onConfirmBlocks={() => moves.confirmBlocks()}
              onEndTurn={() => moves.passTurn()}
              onForceEndTurn={() => moves.forceEndTurn()}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={onExit}
              aria-label="Leave game"
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>

        {/* Targeting banner */}
        {targeting && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-accent text-accent-foreground text-xs">
            <span className="truncate">
              Choose a target for{" "}
              <b>{CARDS[targeting.defId]?.name ?? "card"}</b>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={() => setTargeting(null)}
            >
              <X className="size-3" /> Cancel
            </Button>
          </div>
        )}

        {/* Your battlefield */}
        <BattlefieldRow
          items={memeItems(playerID)}
          size="sm"
          emptyLabel="No memes"
        />
        <BattlefieldRow
          items={supportItems(playerID)}
          size="xs"
          emptyLabel="No nodes or machines"
        />
      </div>

      {/* Gas + your HUD + hand */}
      <div className="shrink-0">
        <GasBar gas={me.gas} />
        <PlayerHUD
          name={nameOf(playerID)}
          color={me.color}
          life={me.life}
          deckCount={deckCounts[playerID] ?? 0}
          graveyardCount={me.graveyard.length}
          isYou
          isTurn={isMyTurn}
          targetable={!!targeting && targetKind === "any"}
          onClick={
            targeting && targetKind === "any"
              ? () => playWithTarget(playerTargetId(playerID))
              : undefined
          }
        />
        <HandBar
          player={me}
          isMyTurn={isMyTurn}
          onSelect={(i) => setPreviewIndex(i)}
        />
      </div>

      {/* Hand-card preview drawer */}
      <Drawer
        open={previewIndex != null}
        onOpenChange={(open) => !open && setPreviewIndex(null)}
      >
        <DrawerContent>
          {previewDef && (
            <>
              <DrawerHeader className="items-center">
                <DrawerTitle>{previewDef.name}</DrawerTitle>
              </DrawerHeader>
              <div className="flex flex-col items-center gap-1.5 pb-2 overflow-y-auto min-h-0">
                <GameCard def={previewDef} size="lg" />
                <CardInspectCaption def={previewDef} />
              </div>
              <DrawerFooter className="pt-0">
                <Button
                  disabled={!isMyTurn || !canPlayFromHand(me, previewDef)}
                  onClick={() => handlePlayFromPreview(previewIndex!)}
                >
                  {targetKindFor(previewDef) ? "Play (choose target)" : "Play"}
                </Button>
                {!isMyTurn && (
                  <p className="text-center text-xs text-muted-foreground">
                    You can play cards on your turn.
                  </p>
                )}
              </DrawerFooter>
            </>
          )}
        </DrawerContent>
      </Drawer>

      <GameOverDialog gameover={ctx.gameover} playerID={playerID} onExit={onExit} />
    </div>
    </CardInspectProvider>
  );
}
