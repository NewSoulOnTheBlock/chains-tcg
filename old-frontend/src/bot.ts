// src/bot.ts
// ─────────────────────────────────────────────────────────────────────────────
// Heuristic single-player bot for Memetic Masters.
//
// Built on boardgame.io's Bot abstract base. Three difficulties:
//   - 'easy'   — picks a random legal move from the enumerator (often suboptimal)
//   - 'normal' — priority heuristic: tap nodes → play biggest castable card →
//                attack profitable trades → block well → end turn
//   - 'hard'   — same heuristic but plays more aggressively (faces over trades
//                when life lead allows, casts removal on the biggest threat)
//
// The bot doesn't fork the game state for lookahead. That keeps it small and
// deterministic. We layer on `randomFloor` jitter on Easy so the same opening
// hand doesn't produce identical games every time you replay.
//
// Action shape returned to boardgame.io's Local transport:
//   { action: { type: 'MAKE_MOVE',  payload: { type, args, playerID } } }
//   { action: { type: 'GAME_EVENT', payload: { type, args, playerID } } }
// ─────────────────────────────────────────────────────────────────────────────

import { Bot } from 'boardgame.io/ai';
import type { BotAction } from 'boardgame.io/dist/types/src/ai/bot';
import { CARDS, COLORS, type CardDef } from './cards';

export type Difficulty = 'easy' | 'normal' | 'hard';

function totalGasCost(cost: CardDef['cost']): number {
  return (cost?.any ?? 0) + COLORS.reduce((sum, c) => sum + (cost?.[c] ?? 0), 0);
}

type AnyState = any;

function makeMove(type: string, args: any[], playerID: string): BotAction {
  return { type: 'MAKE_MOVE', payload: { type, args, playerID } } as any;
}

// "Skip" action: the bot is called by boardgame.io on every state change, but
// our game pins BOTH players into stages every turn (currentPlayer: NULL,
// others: 'afk'), so GetBotPlayer always returns the bot's playerID — even on
// the human's turn. Returning a real move like `passTurn` here would return
// INVALID_MOVE (state unchanged) and the reducer would still dispatch + notify,
// re-triggering the bot on the same state → infinite 100ms retry loop that
// blocks the human's input from being applied. By returning a move name that
// is NOT registered in any phase, the master short-circuits at the
// `canPlayerMakeMove=false` check WITHOUT dispatching, so subscribeCallback is
// not re-fired and the loop ends.
function noop(playerID: string): BotAction {
  return { type: 'MAKE_MOVE', payload: { type: '__bot_skip__', args: [], playerID } } as any;
}

// ── Enumerator: every legal move for `playerID` in the current state ───────
// Exposed both as the bot's internal helper and (later) for plugging into
// boardgame.io's MCTSBot via Game.ai.enumerate.
export function enumerateMoves(G: AnyState, ctx: any, playerID: string): BotAction[] {
  const out: BotAction[] = [];
  const phase = ctx.phase as string | undefined;

  // Pick phase — chooseColor (random starter from the 5 chains).
  if (phase === 'pick') {
    if (G.players?.[playerID]?.needsColorPick) {
      for (const c of COLORS) out.push(makeMove('chooseColor', [c], playerID));
    }
    return out;
  }

  // Mulligan phase.
  if (phase === 'mulligan') {
    if (!G.mulligan?.done?.[playerID]) {
      out.push(makeMove('keepHand', [], playerID));
      out.push(makeMove('mulligan', [], playerID));
    }
    return out;
  }

  // Play phase — only the current player has moves.
  if (ctx.currentPlayer !== playerID) return out;
  const p = G.players?.[playerID];
  if (!p) return out;

  // 1. Tap any untapped node.
  for (const n of p.nodes ?? []) {
    if (!n.tapped) out.push(makeMove('tapNode', [n.uid], playerID));
  }

  // 2. Play hand cards (gas-cost checked below).
  const opp = G.players[playerID === '0' ? '1' : '0'];
  for (let i = 0; i < (p.hand?.length ?? 0); i++) {
    const def = CARDS[p.hand[i]];
    if (!def) continue;
    if (def.type === 'node') {
      const extra = (p.machines ?? []).filter((m: any) => CARDS[m.defId]?.effect === 'extra_node_per_turn').length;
      if (p.nodesPlayedThisTurn < 1 + extra) {
        out.push(makeMove('playCard', [i], playerID));
      }
      continue;
    }
    if (!canAffordHeuristic(p, def)) continue;
    if (def.type === 'meme' || def.type === 'machine') {
      out.push(makeMove('playCard', [i], playerID));
      continue;
    }
    if (def.type === 'aura') {
      // Buffs land on own memes; shield-style auras also fine on our own.
      // Skip if we have no memes to attach to.
      for (const m of p.memes ?? []) out.push(makeMove('playCard', [i, m.uid], playerID));
      continue;
    }
    if (def.type === 'move') {
      const e = def.effect;
      if (e === 'drawTwo' || e === 'gainLife4' || e === 'damageAll_1' || e === 'mill3' || e === 'discardRandom') {
        out.push(makeMove('playCard', [i], playerID));
      } else if (e === 'destroyMeme' || e === 'bounceMeme') {
        for (const m of opp?.memes ?? []) out.push(makeMove('playCard', [i, m.uid], playerID));
      } else if (e === 'destroyMachine') {
        for (const m of opp?.machines ?? []) out.push(makeMove('playCard', [i, m.uid], playerID));
      } else if (e === 'damage2' || e === 'damage3' || e === 'damage5') {
        for (const m of opp?.memes ?? []) out.push(makeMove('playCard', [i, m.uid], playerID));
        out.push(makeMove('playCard', [i, opp === G.players['0'] ? '__p0__' : '__p1__'], playerID));
      }
    }
  }

  // 3. Combat declarations (when not already in blockers phase).
  const inBlock = G.combat?.attackers?.length > 0;
  if (!inBlock) {
    for (const m of p.memes ?? []) {
      if (!m.summoningSick && !m.tapped && !G.combat.attackers.some((a: any) => a.memeUid === m.uid)) {
        out.push(makeMove('declareAttacker', [m.uid], playerID));
      }
    }
    if (G.combat.attackers.length > 0) {
      out.push(makeMove('confirmAttackers', [], playerID));
    }
  }

  // 4. End turn is always legal in the play phase.
  out.push(makeMove('passTurn', [], playerID));

  return out;
}

function canAffordHeuristic(p: any, def: CardDef): boolean {
  // Approximate: bot pays generic cost from any color when possible. We trust
  // the move reducer to reject if we get it wrong; this is just a quick filter
  // to avoid spamming illegal moves in the enumerator.
  const cost = def.cost ?? { any: 0 };
  const total = totalGasCost(cost);
  const gas = p.gas ?? {};
  const have = COLORS.reduce((sum, c) => sum + (gas[c] ?? 0), 0);
  if (have < total) return false;
  // Specific-color requirements.
  for (const c of COLORS) {
    if ((cost[c] ?? 0) > (gas[c] ?? 0)) return false;
  }
  return true;
}

// ── Heuristic policy ─────────────────────────────────────────────────────────
// Card priority: bigger = better. Tweaked per difficulty.
function cardPriority(def: CardDef, diff: Difficulty): number {
  const totalCost = totalGasCost(def.cost);
  let score = totalCost; // play bigger spells first
  if (def.type === 'machine') score += 2;        // engines first
  if (def.type === 'meme') score += (def.power ?? 0) * 0.5 + (def.toughness ?? 0) * 0.3;
  if (def.type === 'move' && def.effect === 'drawTwo') score += 1.5;
  if (def.type === 'move' && def.effect?.startsWith('damage')) score += 1;
  if (diff === 'hard' && def.type === 'meme') score += (def.power ?? 0) * 0.3; // hard loves aggro
  return score;
}

function chooseTarget(
  G: AnyState, ownerSide: 'me' | 'opp', meId: string, oppId: string, def: CardDef, diff: Difficulty,
): string | undefined {
  const opp = G.players[oppId];
  const me = G.players[meId];
  const e = def.effect;
  if (e === 'destroyMeme' || e === 'bounceMeme') {
    // Kill biggest threat.
    const sorted = [...(opp.memes ?? [])].sort((a: any, b: any) => {
      const da = CARDS[a.defId]; const db = CARDS[b.defId];
      return (db?.power ?? 0) - (da?.power ?? 0);
    });
    return sorted[0]?.uid;
  }
  if (e === 'destroyMachine') {
    return opp.machines?.[0]?.uid;
  }
  if (e === 'damage2' || e === 'damage3' || e === 'damage5') {
    const dmg = e === 'damage2' ? 2 : e === 'damage3' ? 3 : 5;
    // Hard difficulty: face damage if it would win or opp has no good memes.
    if (diff === 'hard' && opp.life <= dmg) {
      return oppId === '0' ? '__p0__' : '__p1__';
    }
    // Prefer killing a meme with exactly enough damage.
    const kill = (opp.memes ?? []).find((m: any) => {
      const d = CARDS[m.defId];
      const remain = (d?.toughness ?? 1) - (m.damage ?? 0);
      return remain <= dmg && remain > 0;
    });
    if (kill) return kill.uid;
    if (diff !== 'easy') return oppId === '0' ? '__p0__' : '__p1__';
    return (opp.memes?.[0]?.uid) ?? (oppId === '0' ? '__p0__' : '__p1__');
  }
  void ownerSide; void me;
  return undefined;
}

export class MMTCGBot extends Bot {
  private difficulty: Difficulty;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(args: { difficulty?: Difficulty; enumerate?: any; seed?: string | number }) {
    super({ enumerate: args.enumerate ?? enumerateMoves, seed: args.seed });
    this.difficulty = args.difficulty ?? 'normal';
  }

  async play(state: AnyState, playerID: string): Promise<{ action: BotAction }> {
    const { G, ctx } = state;

    // Compute the action first, then add a small delay so the human can see
    // what's happening in the action log + battlefield. Total wall-clock per
    // bot action = ~700-1100ms (boardgame.io's LocalMaster already adds 100ms
    // before calling us). Skip the delay during pick/mulligan so the game
    // doesn't feel sluggish before it even starts.
    const compute = (): { action: BotAction } | null => this._compute(state, playerID);
    const result = compute();
    if (!result) return { action: noop(playerID) };
    if (ctx.phase === 'play') {
      const jitter = 600 + Math.floor(Math.random() * 400);
      await new Promise(r => setTimeout(r, jitter));
    }
    return result;
  }

  private _compute(state: AnyState, playerID: string): { action: BotAction } | null {
    const { G, ctx } = state;

    // ── Pick phase: random color (matches user request: "random choice from 5 starters")
    if (ctx.phase === 'pick' && G.players?.[playerID]?.needsColorPick) {
      const c = COLORS[Math.floor(Math.random() * COLORS.length)];
      return { action: makeMove('chooseColor', [c], playerID) };
    }

    // ── Mulligan phase: easy/normal keep 7-card hands with ≥2 nodes & ≥2 plays;
    //    hard is stricter (≥3 nodes, ≥3 plays). Always keep after one mulligan.
    if (ctx.phase === 'mulligan' && !G.mulligan?.done?.[playerID]) {
      const p = G.players[playerID];
      const nodes = (p.hand ?? []).filter((id: string) => CARDS[id]?.type === 'node').length;
      const cheaps = (p.hand ?? []).filter((id: string) => {
        const c = CARDS[id]?.cost;
        const total = totalGasCost(c);
        return CARDS[id]?.type !== 'node' && total <= 3;
      }).length;
      const minNodes = this.difficulty === 'hard' ? 3 : 2;
      const minCheap = this.difficulty === 'hard' ? 3 : 2;
      const alreadyMulled = (G.mulligan?.counts?.[playerID] ?? 0) >= 1;
      const acceptable = nodes >= minNodes && cheaps >= minCheap;
      if (alreadyMulled || acceptable || this.difficulty === 'easy') {
        return { action: makeMove('keepHand', [], playerID) };
      }
      return { action: makeMove('mulligan', [], playerID) };
    }

    // ── Play phase: only act when it's our turn.
    // Special case: defender stage during opponent's combat — assign blocks.
    const myStage = ctx.activePlayers?.[playerID];
    if (myStage === 'blockers') {
      const meId = playerID;
      const oppId = playerID === '0' ? '1' : '0';
      const me = G.players[meId];
      // Gather unassigned blockers + remaining attackers.
      const assigned = new Set<string>();
      for (const list of Object.values(G.combat?.blocks ?? {}) as string[][]) {
        for (const u of list) assigned.add(u);
      }
      const myBlockers = (me.memes ?? []).filter((m: any) => !m.tapped && !assigned.has(m.uid));
      const attackers = (G.combat?.attackers ?? []) as Array<{ memeUid: string }>;
      // Sort attackers by power descending — block the biggest threats first.
      const oppMemes = G.players[oppId].memes ?? [];
      const atkDefs = attackers.map(a => {
        const m = oppMemes.find((x: any) => x.uid === a.memeUid);
        return { uid: a.memeUid, power: CARDS[m?.defId]?.power ?? 0 };
      }).sort((a, b) => b.power - a.power);

      // Block whenever the trade is good (blocker survives or kills attacker)
      // OR we're at low life and need to chump.
      for (const blocker of myBlockers) {
        const bd = CARDS[blocker.defId];
        const bp = bd?.power ?? 0;
        const bt = (bd?.toughness ?? 1) - (blocker.damage ?? 0);
        const lowLife = me.life <= 6;
        for (const atk of atkDefs) {
          if ((G.combat.blocks?.[atk.uid] ?? []).length > 0) continue;
          const tradeUp = bp >= 1 && bt > atk.power;        // we survive
          const evenTrade = bp >= 1 && bt >= atk.power;     // both die
          const stopFatal = lowLife && atk.power >= me.life;
          const isHard = this.difficulty === 'hard';
          const shouldBlock = tradeUp || (isHard && evenTrade) || stopFatal;
          if (shouldBlock) {
            return { action: makeMove('declareBlocker', [blocker.uid, atk.uid], playerID) };
          }
        }
      }
      // No more profitable blocks — confirm.
      return { action: makeMove('confirmBlocks', [], playerID) };
    }

    if (ctx.currentPlayer !== playerID) {
      // It's the human's turn — return a no-op that the master will reject
      // without dispatching, so we don't loop on every state change.
      return { action: noop(playerID) };
    }

    // ── Easy bot: random legal move.
    if (this.difficulty === 'easy') {
      const all = enumerateMoves(G, ctx, playerID);
      if (all.length === 0) return { action: makeMove('passTurn', [], playerID) };
      const idx = Math.floor(Math.random() * all.length);
      return { action: all[idx] };
    }

    // ── Normal / Hard: ordered priority list.
    const p = G.players[playerID];
    const oppId = playerID === '0' ? '1' : '0';

    // 1. Tap untapped nodes for gas.
    const untapped = (p.nodes ?? []).find((n: any) => !n.tapped);
    if (untapped) return { action: makeMove('tapNode', [untapped.uid], playerID) };

    // 2. Play a node if we have one in hand and haven't yet.
    const extra = (p.machines ?? []).filter((m: any) => CARDS[m.defId]?.effect === 'extra_node_per_turn').length;
    if (p.nodesPlayedThisTurn < 1 + extra) {
      const nodeIdx = (p.hand ?? []).findIndex((id: string) => CARDS[id]?.type === 'node');
      if (nodeIdx >= 0) return { action: makeMove('playCard', [nodeIdx], playerID) };
    }

    // 3. Play the highest-priority castable card.
    const castable: Array<{ idx: number; def: CardDef; score: number }> = [];
    for (let i = 0; i < (p.hand?.length ?? 0); i++) {
      const def = CARDS[p.hand[i]];
      if (!def || def.type === 'node') continue;
      if (!canAffordHeuristic(p, def)) continue;
      castable.push({ idx: i, def, score: cardPriority(def, this.difficulty) });
    }
    castable.sort((a, b) => b.score - a.score);
    for (const pick of castable) {
      const target = pick.def.type === 'move'
        ? chooseTarget(G, 'me', playerID, oppId, pick.def, this.difficulty)
        : undefined;
      // Targeted move with no valid target → skip.
      const needs = pick.def.effect === 'destroyMeme' || pick.def.effect === 'bounceMeme' ||
                    pick.def.effect === 'destroyMachine' ||
                    pick.def.effect === 'damage2' || pick.def.effect === 'damage3' || pick.def.effect === 'damage5';
      if (needs && !target) continue;
      const args = needs ? [pick.idx, target] : [pick.idx];
      return { action: makeMove('playCard', args, playerID) };
    }

    // 4. Combat — declare profitable attackers (or face if Hard + opp wide open).
    const opp = G.players[oppId];
    const oppBlockers = (opp.memes ?? []).filter((m: any) => !m.tapped);
    const oppMaxBlockerPow = oppBlockers.reduce((mx: number, m: any) =>
      Math.max(mx, CARDS[m.defId]?.power ?? 0), 0);

    const myAttackers = (p.memes ?? []).filter((m: any) =>
      !m.summoningSick && !m.tapped &&
      !G.combat.attackers.some((a: any) => a.memeUid === m.uid));

    for (const m of myAttackers) {
      const def = CARDS[m.defId];
      const myPow = def?.power ?? 0;
      const myTough = (def?.toughness ?? 1) - (m.damage ?? 0);
      const wouldDie = oppMaxBlockerPow >= myTough;
      const wouldKillTarget = myPow >= 1 && oppBlockers.some((b: any) =>
        ((CARDS[b.defId]?.toughness ?? 1) - (b.damage ?? 0)) <= myPow);
      const shouldAttack = oppBlockers.length === 0 ||
                           (this.difficulty === 'hard') ||
                           (wouldKillTarget && !wouldDie) ||
                           (myPow >= 4); // big bodies always attack
      if (shouldAttack) return { action: makeMove('declareAttacker', [m.uid], playerID) };
    }

    if (G.combat?.attackers?.length > 0) {
      return { action: makeMove('confirmAttackers', [], playerID) };
    }

    // 5. Nothing left to do — end turn.
    return { action: makeMove('passTurn', [], playerID) };
  }
}
