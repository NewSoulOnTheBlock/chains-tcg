// Plain-English explanations for card mechanics, used by the CardInspect
// hover/long-press preview and the cards-page dialog.

import {
  COLOR_META,
  COLORS,
  type CardDef,
  type Color,
  type EffectId,
} from "@chains/game-core";

/** One-line human explanation for every mechanical EffectId in game-core. */
export const EFFECT_EXPLANATIONS: Record<EffectId, string> = {
  // Moves (one-shot spells)
  damage2: "Deal 2 damage to any target — a meme or a player.",
  damage3: "Deal 3 damage to any target — a meme or a player.",
  damage5: "Deal 5 damage to any target — a meme or a player.",
  destroyMeme: "Destroy target meme outright, no matter how tough it is.",
  destroyMachine: "Destroy target machine.",
  bounceMeme:
    "Return target meme to its owner's hand — they'll have to pay for it again.",
  drawTwo: "Draw two cards.",
  gainLife4: "You gain 4 life.",
  mill3: "Your opponent puts the top 3 cards of their deck into their graveyard.",
  damageAll_1:
    "Deal 1 damage to every meme on the battlefield — yours included.",
  discardRandom: "Your opponent discards a random card from their hand.",

  // Machines (passive effects while deployed)
  "pump_all_+1+1": "All your memes get +1/+1 while this machine is deployed.",
  "pump_attackers_+1+0":
    "Your attacking memes get +1/+0 while this machine is deployed.",
  meme_haste:
    "Your memes can attack the turn they arrive — no summoning sickness.",
  extra_node_per_turn: "You may play one extra Node each turn.",
  gas_discount_color:
    "Your Moves cost 1 less gas of this chain's color (never below 0).",
  lifelink_all: "Damage your memes deal also heals you for the same amount.",
  on_meme_etb_draw:
    "When a meme enters play under your control, draw a card (once per turn).",

  // Auras (attach to a single meme)
  "aura_+2+2": "The enchanted meme gets +2/+2 while this is attached.",
  "aura_+3+0": "The enchanted meme gets +3/+0 — more punch, same toughness.",
  "aura_+0+3": "The enchanted meme gets +0/+3 — a sturdier blocker.",
  aura_haste:
    "The enchanted meme loses summoning sickness and can attack right away.",
  aura_lifelink:
    "The enchanted meme heals its controller for the damage it deals.",

  // Meme enter-the-battlefield triggers
  etb_zap_2_and_draw:
    "When this meme enters play, your opponent loses 2 life and you draw a card.",
};

const TYPE_LABEL: Record<CardDef["type"], string> = {
  node: "Node",
  meme: "Meme",
  machine: "Machine",
  aura: "Aura",
  move: "Move",
};

/** "Meme · Solana · 3/2" style line for the caption panel. */
export function typeLine(def: CardDef): string {
  const base = `${TYPE_LABEL[def.type]} · ${COLOR_META[def.color].name}`;
  return def.type === "meme" && def.power != null
    ? `${base} · ${def.power}/${def.toughness}`
    : base;
}

/** Cost breakdown in words, e.g. "Costs 1 Solana + 2 of any color gas." */
export function costWords(def: CardDef): string {
  if (def.type === "node") return "Free — you may play one Node per turn.";
  const cost = def.cost;
  if (!cost) return "Costs no gas.";
  const parts: string[] = [];
  for (const c of COLORS) {
    const n = cost[c as Color] ?? 0;
    if (n > 0) parts.push(`${n} ${COLOR_META[c].name}`);
  }
  if ((cost.any ?? 0) > 0) parts.push(`${cost.any} of any color`);
  if (parts.length === 0) return "Costs no gas.";
  return `Costs ${parts.join(" + ")} gas.`;
}

/**
 * Plain-English explanation of what the card does. Covers every EffectId,
 * node tap behavior, and a fallback for vanilla memes.
 */
export function explainCard(def: CardDef): string | null {
  if (def.type === "node") {
    return `Tap it on your turn for 1 ${COLOR_META[def.color].name} gas — gas pays for your cards. It untaps at the start of each of your turns.`;
  }
  if (def.effect) return EFFECT_EXPLANATIONS[def.effect] ?? null;
  if (def.type === "meme") {
    return "A plain meme — no special ability. It attacks and blocks with the stats shown.";
  }
  return null;
}
