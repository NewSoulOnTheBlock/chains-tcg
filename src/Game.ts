// src/Game.ts
// Chains TCG — Magic-style turn-based card game built on boardgame.io.

import type { Game, Move } from 'boardgame.io';
import { INVALID_MOVE, PlayerView, Stage, ActivePlayers } from 'boardgame.io/core';
import {
  CARDS, COLORS, STARTER_DECKS, DEFAULT_MATCHUP, derivePrimaryColor, validateDeck,
  type Color, type CardDef,
} from './cards';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Instance {
  uid: string;
  defId: string;
  tapped: boolean;
  damage: number;
  summoningSick: boolean;     // memes can't attack the turn they enter
  onEtbDrawUsed?: boolean;    // for 'on_meme_etb_draw' machine (per-turn cooldown)
}

export type Zone = 'nodes' | 'memes' | 'machines';

export interface PlayerState {
  color: Color;               // deck color (cosmetic + starter selection)
  profileName: string;        // chosen profile / display name
  life: number;
  hand: string[];             // defIds
  graveyard: string[];        // defIds
  nodes:   Instance[];
  memes:   Instance[];
  machines:Instance[];
  gas: Record<Color, number>; // floating gas pool, drained each cleanup
  nodesPlayedThisTurn: number;
  hasDrawnForTurn: boolean;
  needsColorPick?: boolean;   // true until the player has chosen a deck color
}

export interface SecretState {
  decks: Record<string, string[]>;   // per-player remaining deck order
}

export interface Combat {
  attackers: Array<{ memeUid: string }>;          // attacker meme UIDs, target is defending player
  blocks:    Record<string, string[]>;            // attackerUid -> defender meme UIDs (in order)
  // each defender can only block one attacker, enforced by Game logic
}

export interface GState {
  // 'players' inside G is *not* the same as the boardgame.io PluginPlayer.
  // We use plain map by playerID for clarity.
  players: Record<string, PlayerState>;
  secret: SecretState;
  combat: Combat;
  log: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let _uid = 0;
function newUid(prefix = 'i'): string {
  _uid += 1;
  return `${prefix}${_uid}`;
}

function emptyGas(): Record<Color, number> {
  return { bnb: 0, sol: 0, hl: 0, eth: 0, xrp: 0 };
}

function mkInstance(defId: string, opts: Partial<Instance> = {}): Instance {
  return {
    uid: newUid('c'),
    defId,
    tapped: false,
    damage: 0,
    summoningSick: false,
    ...opts,
  };
}

function totalGas(p: PlayerState): number {
  return COLORS.reduce((s, c) => s + p.gas[c], 0);
}

/** Discount applied by your machines to your moves (e.g. 'gas_discount_color'). */
function discountForMove(p: PlayerState, def: CardDef): GasCost {
  const out: GasCost = { ...(def.cost ?? {}) };
  if (def.type !== 'move') return out;
  for (const m of p.machines) {
    const md = CARDS[m.defId];
    if (md.effect === 'gas_discount_color' && out[md.color]) {
      out[md.color] = Math.max(0, (out[md.color] ?? 0) - 1);
    }
  }
  return out;
}

/** Can we pay `cost` with the player's gas pool? */
function canPay(p: PlayerState, cost: GasCost): boolean {
  for (const c of COLORS) {
    if ((cost[c] ?? 0) > p.gas[c]) return false;
  }
  return true;
}
function pay(p: PlayerState, cost: GasCost) {
  for (const c of COLORS) p.gas[c] -= (cost[c] ?? 0);
}

type GasCost = Partial<Record<Color, number>>;

function drawCard(G: GState, pid: string, n = 1) {
  const p = G.players[pid];
  const deck = G.secret.decks[pid];
  for (let i = 0; i < n; i++) {
    if (deck.length === 0) {
      // milling out: lose the game on draw from empty deck
      p.life = Math.min(p.life, 0);
      G.log.push(`Player ${pid} tried to draw from empty deck and loses.`);
      return;
    }
    p.hand.push(deck.shift()!);
  }
}

function findOnBattlefield(G: GState, uid: string):
  { ownerId: string; zone: Zone; inst: Instance } | null {
  for (const pid of Object.keys(G.players)) {
    const p = G.players[pid];
    for (const z of ['nodes', 'memes', 'machines'] as Zone[]) {
      const inst = p[z].find(i => i.uid === uid);
      if (inst) return { ownerId: pid, zone: z, inst };
    }
  }
  return null;
}

function pumpBonus(p: PlayerState): number {
  return p.machines.filter(m => CARDS[m.defId].effect === 'pump_all_+1+1').length;
}
function attackerBonus(p: PlayerState): number {
  return p.machines.filter(m => CARDS[m.defId].effect === 'pump_attackers_+1+0').length;
}
function memePower(p: PlayerState, m: Instance): number {
  const d = CARDS[m.defId];
  return (d.power ?? 0) + pumpBonus(p);
}
function memeToughness(p: PlayerState, m: Instance): number {
  const d = CARDS[m.defId];
  return (d.toughness ?? 1) + pumpBonus(p);
}

function destroyMeme(G: GState, ownerId: string, uid: string) {
  const p = G.players[ownerId];
  const idx = p.memes.findIndex(m => m.uid === uid);
  if (idx === -1) return;
  const [removed] = p.memes.splice(idx, 1);
  p.graveyard.push(removed.defId);
  G.log.push(`Meme ${CARDS[removed.defId].name} dies.`);
}

function destroyMachine(G: GState, ownerId: string, uid: string) {
  const p = G.players[ownerId];
  const idx = p.machines.findIndex(m => m.uid === uid);
  if (idx === -1) return;
  const [removed] = p.machines.splice(idx, 1);
  p.graveyard.push(removed.defId);
  G.log.push(`Machine ${CARDS[removed.defId].name} is destroyed.`);
}

function returnMemeToHand(G: GState, ownerId: string, uid: string) {
  const p = G.players[ownerId];
  const idx = p.memes.findIndex(m => m.uid === uid);
  if (idx === -1) return;
  const [removed] = p.memes.splice(idx, 1);
  p.hand.push(removed.defId);
  G.log.push(`${CARDS[removed.defId].name} returned to hand.`);
}

function dealDamageToPlayer(G: GState, pid: string, amount: number) {
  G.players[pid].life -= amount;
  G.log.push(`Player ${pid} takes ${amount} damage (life=${G.players[pid].life}).`);
}

function dealDamageToMeme(G: GState, ownerId: string, uid: string, amount: number) {
  const p = G.players[ownerId];
  const m = p.memes.find(x => x.uid === uid);
  if (!m) return;
  m.damage += amount;
  if (m.damage >= memeToughness(p, m)) destroyMeme(G, ownerId, uid);
}

function pickingPending(G: GState): boolean {
  return Object.values(G.players).some(p => p.needsColorPick);
}

function otherPlayer(ctx: { currentPlayer: string; playOrder: string[] }): string {
  return ctx.playOrder.find(p => p !== ctx.currentPlayer)!;
}

// ── Moves ────────────────────────────────────────────────────────────────────

/** Play any card from hand (Node, Meme, Machine, or Move). For Moves with a target, pass targetUid. */
const playCard: Move<GState> = ({ G, ctx, playerID, random }, handIndex: number, targetUid?: string) => {
  if (playerID == null) return INVALID_MOVE;
  if (ctx.currentPlayer !== playerID) return INVALID_MOVE;
  const p = G.players[playerID];
  const defId = p.hand[handIndex];
  if (!defId) return INVALID_MOVE;
  const def = CARDS[defId];
  if (!def) return INVALID_MOVE;

  if (def.type === 'node') {
    const extra = p.machines.filter(m => CARDS[m.defId].effect === 'extra_node_per_turn').length;
    if (p.nodesPlayedThisTurn >= 1 + extra) return INVALID_MOVE;
    p.hand.splice(handIndex, 1);
    p.nodes.push(mkInstance(defId, { tapped: false }));
    p.nodesPlayedThisTurn += 1;
    G.log.push(`Player ${playerID} plays Node ${def.name}.`);
    return;
  }

  // Non-nodes: pay gas (with potential discount).
  const cost = discountForMove(p, def);
  if (!canPay(p, cost)) return INVALID_MOVE;

  if (def.type === 'meme') {
    pay(p, cost);
    p.hand.splice(handIndex, 1);
    const hasHaste = p.machines.some(m => CARDS[m.defId].effect === 'meme_haste');
    p.memes.push(mkInstance(defId, { summoningSick: !hasHaste }));
    G.log.push(`Player ${playerID} summons ${def.name}.`);
    // Trigger "on meme ETB draw" machines for this player.
    for (const m of p.machines) {
      if (CARDS[m.defId].effect === 'on_meme_etb_draw' && !m.onEtbDrawUsed) {
        m.onEtbDrawUsed = true;
        drawCard(G, playerID, 1);
        G.log.push(`${CARDS[m.defId].name} draws a card.`);
        break;
      }
    }
    return;
  }

  if (def.type === 'machine') {
    pay(p, cost);
    p.hand.splice(handIndex, 1);
    p.machines.push(mkInstance(defId));
    G.log.push(`Player ${playerID} deploys Machine ${def.name}.`);
    return;
  }

  if (def.type === 'move') {
    // Validate target up-front per effect type.
    const needsMemeTarget = def.effect === 'destroyMeme' || def.effect === 'bounceMeme';
    const needsMachineTarget = def.effect === 'destroyMachine';
    const allowsAnyTarget = def.effect === 'damage2' || def.effect === 'damage3' || def.effect === 'damage5';
    if (needsMemeTarget) {
      if (!targetUid) return INVALID_MOVE;
      const found = findOnBattlefield(G, targetUid);
      if (!found || found.zone !== 'memes') return INVALID_MOVE;
    }
    if (needsMachineTarget) {
      if (!targetUid) return INVALID_MOVE;
      const found = findOnBattlefield(G, targetUid);
      if (!found || found.zone !== 'machines') return INVALID_MOVE;
    }
    if (allowsAnyTarget && !targetUid) return INVALID_MOVE;

    pay(p, cost);
    p.hand.splice(handIndex, 1);
    G.log.push(`Player ${playerID} casts ${def.name}.`);

    switch (def.effect) {
      case 'damage2':
      case 'damage3':
      case 'damage5': {
        const amt = def.effect === 'damage2' ? 2 : def.effect === 'damage3' ? 3 : 5;
        if (targetUid && (targetUid === '__p0__' || targetUid === '__p1__')) {
          const pid = targetUid === '__p0__' ? '0' : '1';
          dealDamageToPlayer(G, pid, amt);
        } else {
          const found = findOnBattlefield(G, targetUid!);
          if (found && found.zone === 'memes') {
            dealDamageToMeme(G, found.ownerId, found.inst.uid, amt);
          }
        }
        break;
      }
      case 'destroyMeme': {
        const found = findOnBattlefield(G, targetUid!);
        if (found && found.zone === 'memes') destroyMeme(G, found.ownerId, found.inst.uid);
        break;
      }
      case 'destroyMachine': {
        const found = findOnBattlefield(G, targetUid!);
        if (found && found.zone === 'machines') destroyMachine(G, found.ownerId, found.inst.uid);
        break;
      }
      case 'bounceMeme': {
        const found = findOnBattlefield(G, targetUid!);
        if (found && found.zone === 'memes') returnMemeToHand(G, found.ownerId, found.inst.uid);
        break;
      }
      case 'drawTwo':    drawCard(G, playerID, 2); break;
      case 'gainLife4':  p.life += 4; G.log.push(`Player ${playerID} gains 4 life.`); break;
      case 'damageAll_1': {
        for (const pid of Object.keys(G.players)) {
          // copy uids first since dealDamageToMeme may mutate the array
          const uids = G.players[pid].memes.map(m => m.uid);
          for (const uid of uids) dealDamageToMeme(G, pid, uid, 1);
        }
        G.log.push(`All Memes take 1 damage.`);
        break;
      }
      case 'mill3': {
        const oppId = otherPlayer(ctx);
        for (let i = 0; i < 3; i++) {
          const next = G.secret.decks[oppId].shift();
          if (!next) break;
          G.players[oppId].graveyard.push(next);
        }
        G.log.push(`Player ${oppId} mills 3 cards.`);
        break;
      }
      case 'discardRandom': {
        const oppId = otherPlayer(ctx);
        const opp = G.players[oppId];
        if (opp.hand.length > 0) {
          const idx = random.Die(opp.hand.length) - 1;
          const [discarded] = opp.hand.splice(idx, 1);
          opp.graveyard.push(discarded);
          G.log.push(`Player ${oppId} discards a card.`);
        }
        break;
      }
      default: break;
    }
    p.graveyard.push(defId);
    return;
  }
};

/** Tap a node to add 1 gas of its color. */
const tapNode: Move<GState> = ({ G, ctx, playerID }, nodeUid: string) => {
  if (playerID == null || ctx.currentPlayer !== playerID) return INVALID_MOVE;
  const p = G.players[playerID];
  const n = p.nodes.find(x => x.uid === nodeUid);
  if (!n || n.tapped) return INVALID_MOVE;
  n.tapped = true;
  const def = CARDS[n.defId];
  p.gas[def.color] += 1;
  G.log.push(`Player ${playerID} taps ${def.name} for 1 ${def.color}.`);
};

/** Declare a Meme as attacker. (Only allowed in combat:attackers stage.) */
const declareAttacker: Move<GState> = ({ G, ctx, playerID }, memeUid: string) => {
  if (playerID == null || ctx.currentPlayer !== playerID) return INVALID_MOVE;
  const p = G.players[playerID];
  const m = p.memes.find(x => x.uid === memeUid);
  if (!m) return INVALID_MOVE;
  if (m.tapped || m.summoningSick) return INVALID_MOVE;
  if (G.combat.attackers.some(a => a.memeUid === memeUid)) {
    // toggle off
    G.combat.attackers = G.combat.attackers.filter(a => a.memeUid !== memeUid);
    return;
  }
  G.combat.attackers.push({ memeUid });
};

/** Confirm attackers and pass to blockers stage. */
const confirmAttackers: Move<GState> = ({ G, ctx, playerID, events }) => {
  if (playerID == null || ctx.currentPlayer !== playerID) return INVALID_MOVE;
  // Tap all attackers
  const p = G.players[playerID];
  for (const a of G.combat.attackers) {
    const m = p.memes.find(x => x.uid === a.memeUid);
    if (m) m.tapped = true;
  }
  G.log.push(`Player ${playerID} attacks with ${G.combat.attackers.length} meme(s).`);
  // Hand priority to defender for blocks
  const def = otherPlayer({ currentPlayer: ctx.currentPlayer, playOrder: ctx.playOrder });
  events!.setActivePlayers({ value: { [def]: 'blockers' }, revert: false });
};

/** Defender assigns one of their memes to block a specific attacker (toggles). */
const declareBlocker: Move<GState> = (
  { G, ctx, playerID }, blockerUid: string, attackerUid: string
) => {
  if (playerID == null) return INVALID_MOVE;
  if (playerID === ctx.currentPlayer) return INVALID_MOVE;   // only defender can block
  const def = G.players[playerID];
  const b = def.memes.find(m => m.uid === blockerUid);
  if (!b || b.tapped) return INVALID_MOVE;
  if (!G.combat.attackers.some(a => a.memeUid === attackerUid)) return INVALID_MOVE;

  // Remove blocker from any previous assignment.
  for (const [att, list] of Object.entries(G.combat.blocks)) {
    G.combat.blocks[att] = list.filter(u => u !== blockerUid);
  }
  G.combat.blocks[attackerUid] = [...(G.combat.blocks[attackerUid] ?? []), blockerUid];
};

/** Defender confirms blocks → resolve combat → cleanup → back to currentPlayer's main. */
const confirmBlocks: Move<GState> = ({ G, ctx, playerID, events }) => {
  if (playerID == null) return INVALID_MOVE;
  if (playerID === ctx.currentPlayer) return INVALID_MOVE;
  resolveCombat(G, ctx);
  G.combat.attackers = [];
  G.combat.blocks = {};
  // Return priority to attacker; they go back to main.
  events!.setActivePlayers({ currentPlayer: Stage.NULL, revert: false });
};

function resolveCombat(G: GState, ctx: { currentPlayer: string; playOrder: string[] }) {
  const atkPid = ctx.currentPlayer;
  const defPid = otherPlayer(ctx);
  const atk = G.players[atkPid];
  const def = G.players[defPid];

  for (const a of G.combat.attackers) {
    const attacker = atk.memes.find(m => m.uid === a.memeUid);
    if (!attacker) continue;
    const aPower = memePower(atk, attacker) + attackerBonus(atk);
    const blockerUids = G.combat.blocks[a.memeUid] ?? [];

    if (blockerUids.length === 0) {
      // Unblocked: damage defender.
      dealDamageToPlayer(G, defPid, aPower);
      applyLifelink(G, atkPid, aPower);
      continue;
    }

    // Blocked: attacker assigns damage to blockers in order; blockers deal back.
    let remaining = aPower;
    let totalDealtByBlockers = 0;
    for (const buid of blockerUids) {
      const blocker = def.memes.find(m => m.uid === buid);
      if (!blocker) continue;
      const bTough = memeToughness(def, blocker);
      const bPower = memePower(def, blocker);
      const assigned = Math.min(remaining, bTough);
      dealDamageToMeme(G, defPid, buid, assigned);
      remaining -= assigned;
      // Blocker damages attacker
      attacker.damage += bPower;
      totalDealtByBlockers += bPower;
      if (remaining <= 0 && false) break; // continue to let other blockers deal damage
    }
    applyLifelink(G, atkPid, aPower);                // attacker damage = full power
    applyLifelink(G, defPid, totalDealtByBlockers);  // defender lifelink for retaliation
    if (attacker.damage >= memeToughness(atk, attacker)) destroyMeme(G, atkPid, attacker.uid);
  }
  // Clear damage on surviving memes (per MTG, damage clears at end of turn — we do it now).
  for (const pid of Object.keys(G.players)) {
    for (const m of G.players[pid].memes) m.damage = 0;
  }
}

function applyLifelink(G: GState, pid: string, amount: number) {
  if (amount <= 0) return;
  const p = G.players[pid];
  if (p.machines.some(m => CARDS[m.defId].effect === 'lifelink_all')) {
    p.life += amount;
    G.log.push(`Player ${pid} gains ${amount} life (lifelink).`);
  }
}

/**
 * Pick your deck. Valid only while you still need to pick.
 * If `customDeck` is provided, it overrides the color choice and is used as the
 * deck list directly (color is derived from the deck contents). Otherwise the
 * standard starter deck for `color` is used.
 */
const chooseColor: Move<GState> = ({ G, playerID, random }, color: Color, customDeck?: string[]) => {
  if (playerID == null) return INVALID_MOVE;
  const p = G.players[playerID];
  if (!p?.needsColorPick) return INVALID_MOVE;
  let deck: string[];
  let finalColor: Color;
  if (customDeck && Array.isArray(customDeck) && customDeck.length > 0) {
    const v = validateDeck(customDeck);
    if (!v.ok) return INVALID_MOVE;
    deck = [...customDeck];
    finalColor = derivePrimaryColor(customDeck);
  } else {
    if (!COLORS.includes(color)) return INVALID_MOVE;
    deck = [...STARTER_DECKS[color]];
    finalColor = color;
  }
  const shuffled = random!.Shuffle(deck);
  p.color = finalColor;
  p.hand = shuffled.slice(0, 7);
  G.secret.decks[playerID] = shuffled.slice(7);
  p.needsColorPick = false;
  G.log.push(
    customDeck
      ? `Player ${playerID} brought a custom deck (${finalColor.toUpperCase()} themed).`
      : `Player ${playerID} chose the ${finalColor.toUpperCase()} deck.`
  );
};

/** Skip directly from main to end (no attacks this turn). */
const passTurn: Move<GState> = ({ G, ctx, playerID, events }) => {
  if (playerID == null || ctx.currentPlayer !== playerID) return INVALID_MOVE;
  // Discard down to 7
  const p = G.players[playerID];
  while (p.hand.length > 7) p.graveyard.push(p.hand.pop()!);
  // Drain floating gas
  p.gas = emptyGas();
  events!.endTurn();
};

/** Enter combat (defender will set blockers via setActivePlayers). */
const goToCombat: Move<GState> = ({ G, ctx, playerID, events }) => {
  if (playerID == null || ctx.currentPlayer !== playerID) return INVALID_MOVE;
  if (G.combat.attackers.length === 0) return INVALID_MOVE;   // no attackers declared yet? still fine to skip
  confirmAttackers({ G, ctx, playerID, events } as any);
};

// ── The Game ─────────────────────────────────────────────────────────────────

export const ChainsTCG: Game<GState> = {
  name: 'chains-tcg',

  minPlayers: 2,
  maxPlayers: 2,

  setup: ({ ctx, random }, setupData?: { colors?: Array<Color | null | undefined>; names?: [string, string]; decks?: Array<string[] | null | undefined> }) => {
    const colors = setupData?.colors ?? DEFAULT_MATCHUP;
    const names = setupData?.names ?? ['Player 0', 'Player 1'];
    const decksIn = setupData?.decks ?? [];
    const players: Record<string, PlayerState> = {};
    const decks:   Record<string, string[]>     = {};
    for (let i = 0; i < ctx.numPlayers; i++) {
      const pid = String(i);
      const chosen = colors[i] as Color | null | undefined;
      const customDeck = decksIn[i];
      const validCustom = customDeck && Array.isArray(customDeck) && customDeck.length > 0 && validateDeck(customDeck).ok
        ? [...customDeck] : null;
      if (chosen || validCustom) {
        const deck = validCustom ?? [...STARTER_DECKS[chosen as Color]];
        const themeColor: Color = validCustom ? derivePrimaryColor(deck) : (chosen as Color);
        const shuffled = random!.Shuffle(deck);
        decks[pid] = shuffled.slice(7);
        players[pid] = {
          color: themeColor,
          profileName: names[i] ?? `Player ${i}`,
          life: 20,
          hand: shuffled.slice(0, 7),
          graveyard: [],
          nodes: [], memes: [], machines: [],
          gas: emptyGas(),
          nodesPlayedThisTurn: 0,
          hasDrawnForTurn: true,
        };
      } else {
        // Color not yet chosen — placeholder state, player must call chooseColor before play.
        decks[pid] = [];
        players[pid] = {
          color: DEFAULT_MATCHUP[i % 2],
          profileName: names[i] ?? `Player ${i}`,
          life: 20,
          hand: [],
          graveyard: [],
          nodes: [], memes: [], machines: [],
          gas: emptyGas(),
          nodesPlayedThisTurn: 0,
          hasDrawnForTurn: true,
          needsColorPick: true,
        };
      }
    }
    return {
      players,
      secret: { decks },
      combat: { attackers: [], blocks: {} },
      log: ['Game start.'],
    };
  },

  turn: {
    onBegin: ({ G, ctx, events }) => {
      const p = G.players[ctx.currentPlayer];
      // Untap permanents
      for (const z of ['nodes', 'memes', 'machines'] as Zone[]) {
        for (const inst of p[z]) {
          inst.tapped = false;
          if (z === 'memes') inst.summoningSick = false;
          if (z === 'machines') inst.onEtbDrawUsed = false;
        }
      }
      p.nodesPlayedThisTurn = 0;
      // Draw (skip on the very first turn of the game for the starting player)
      if (ctx.turn !== 1) drawCard(G, ctx.currentPlayer, 1);
      G.log.push(`— Turn ${ctx.turn}: Player ${ctx.currentPlayer} (${p.color}) —`);
    },
    onEnd: ({ G, ctx }) => {
      // Drain floating gas at end of turn
      const p = G.players[ctx.currentPlayer];
      p.gas = emptyGas();
      G.combat.attackers = [];
      G.combat.blocks = {};
    },
  },

  moves: {
    playCard,
    tapNode,
    declareAttacker,
    confirmAttackers,
    declareBlocker,
    confirmBlocks,
    passTurn,
    goToCombat,
    chooseColor,
  },

  phases: {
    pick: {
      start: true,
      moves: { chooseColor },
      turn: {
        // Both players act simultaneously during deck selection.
        activePlayers: ActivePlayers.ALL,
      },
      endIf: ({ G }) => !pickingPending(G),
      next: 'play',
    },
    play: {
      moves: {
        playCard, tapNode,
        declareAttacker, confirmAttackers,
        declareBlocker, confirmBlocks,
        passTurn, goToCombat,
      },
    },
  },

  endIf: ({ G, ctx }) => {
    const losers = Object.entries(G.players).filter(([, p]) => p.life <= 0).map(([pid]) => pid);
    if (losers.length === 0) return;
    if (losers.length === ctx.numPlayers) return { draw: true };
    const winner = ctx.playOrder.find(p => !losers.includes(p))!;
    return { winner };
  },

  // Hide each player's deck order + the other player's hand.
  playerView: ({ G, ctx, playerID }) => {
    const viewG: GState = JSON.parse(JSON.stringify(G));
    // Hide deck contents — only expose sizes via secret stripped to counts.
    const deckCounts: Record<string, number> = {};
    for (const pid of Object.keys(viewG.secret.decks)) {
      deckCounts[pid] = viewG.secret.decks[pid].length;
      viewG.secret.decks[pid] = [];   // wipe contents
    }
    // Inject a public deck-size view
    (viewG as any).deckCounts = deckCounts;
    // Hide opponents' hands → keep length only.
    for (const pid of Object.keys(viewG.players)) {
      if (pid !== playerID) {
        const handLen = viewG.players[pid].hand.length;
        viewG.players[pid].hand = Array(handLen).fill('hidden');
      }
    }
    return viewG;
  },
};

export type { CardDef } from './cards';
export { CARDS, COLORS, COLOR_META, STARTER_DECKS } from './cards';
