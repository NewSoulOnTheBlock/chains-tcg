// Client-side helpers mirroring @chains/game-core rules (affordability,
// targeting requirements, displayed power/toughness). Kept deliberately simple —
// the server-side reducer remains the source of truth.

import {
  CARDS,
  COLORS,
  type CardDef,
  type Color,
  type GState,
  type GasCost,
  type Instance,
  type PlayerState,
} from "@chains/game-core";

export type TargetKind = "meme" | "machine" | "any" | null;

/** What kind of target (if any) a card needs when played from hand. */
export function targetKindFor(def: CardDef): TargetKind {
  if (def.type === "aura") return "meme";
  if (def.type !== "move") return null;
  switch (def.effect) {
    case "damage2":
    case "damage3":
    case "damage5":
      return "any"; // memes or players
    case "destroyMeme":
    case "bounceMeme":
      return "meme";
    case "destroyMachine":
      return "machine";
    default:
      return null;
  }
}

/** Mirror of Game.ts discountForMove: machines with gas_discount_color make
 *  same-color moves cost 1 less (colored first, then any). */
export function discountedCost(p: PlayerState, def: CardDef): GasCost {
  const out: GasCost = { ...(def.cost ?? {}) };
  if (def.type !== "move") return out;
  for (const m of p.machines) {
    const md = CARDS[m.defId];
    if (md?.effect !== "gas_discount_color") continue;
    if ((out[md.color] ?? 0) > 0) {
      out[md.color] = Math.max(0, (out[md.color] ?? 0) - 1);
    } else if ((out.any ?? 0) > 0) {
      out.any = Math.max(0, (out.any ?? 0) - 1);
    }
  }
  return out;
}

/** Mirror of Game.ts canPay. */
export function canPay(p: PlayerState, cost: GasCost): boolean {
  for (const c of COLORS) {
    if ((cost[c] ?? 0) > p.gas[c]) return false;
  }
  const anyNeeded = cost.any ?? 0;
  if (anyNeeded <= 0) return true;
  let leftover = 0;
  for (const c of COLORS) leftover += p.gas[c] - (cost[c] ?? 0);
  return leftover >= anyNeeded;
}

/** Can this hand card be played right now (ignoring targets)? */
export function canPlayFromHand(p: PlayerState, def: CardDef): boolean {
  if (def.type === "node") {
    const extra = p.machines.filter(
      (m) => CARDS[m.defId]?.effect === "extra_node_per_turn"
    ).length;
    return p.nodesPlayedThisTurn < 1 + extra;
  }
  return canPay(p, discountedCost(p, def));
}

function pumpBonus(p: PlayerState): number {
  return p.machines.filter(
    (m) => CARDS[m.defId]?.effect === "pump_all_+1+1" && !m.attachedTo
  ).length;
}

function aurasOn(G: GState, memeUid: string): CardDef[] {
  const out: CardDef[] = [];
  for (const pid of Object.keys(G.players)) {
    for (const m of G.players[pid].machines) {
      if (m.attachedTo === memeUid) {
        const def = CARDS[m.defId];
        if (def) out.push(def);
      }
    }
  }
  return out;
}

/** Displayed power/toughness for a meme, including machine pumps and auras. */
export function memeStats(
  G: GState,
  ownerId: string,
  inst: Instance
): { power: number; toughness: number } {
  const p = G.players[ownerId];
  const def = CARDS[inst.defId];
  let power = (def?.power ?? 0) + pumpBonus(p);
  let toughness = (def?.toughness ?? 1) + pumpBonus(p);
  for (const a of aurasOn(G, inst.uid)) {
    if (a.effect === "aura_+2+2") {
      power += 2;
      toughness += 2;
    }
    if (a.effect === "aura_+3+0") power += 3;
    if (a.effect === "aura_+0+3") toughness += 3;
  }
  return { power, toughness };
}

/** Auras attached to a meme (for badges). */
export function attachedAuras(G: GState, memeUid: string): CardDef[] {
  return aurasOn(G, memeUid);
}

export function opponentOf(playerID: string): string {
  return playerID === "0" ? "1" : "0";
}

export function playerTargetId(pid: string): string {
  return pid === "0" ? "__p0__" : "__p1__";
}

export function gasTotal(gas: Record<Color, number>): number {
  return COLORS.reduce((s, c) => s + (gas[c] ?? 0), 0);
}
