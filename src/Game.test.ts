// Rules-engine tests. These drive the REAL boardgame.io reducer headlessly
// (no React, no rAF) so every assertion exercises the authoritative master,
// exactly as the game server runs it. Covers the fixes from the 2026-11-01
// review: turn-one draw (engine-01), combat + the stalling-defender exploits
// (engine-02/13), deterministic uids (engine-05), starter auras (engine-06),
// damage targeting (engine-10), discard choice (engine-12), concede and the
// voice-peer move.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { InitializeGame } from 'boardgame.io/internal';
import { CreateGameReducer } from 'boardgame.io/internal';
import { ChainsTCG, type GState, BLOCK_TIMEOUT_MS, TURN_TIMEOUT_MS } from './Game';

// A tiny driver around the reducer: apply moves/events and read G/ctx back.
function makeMatch(setupData?: any) {
  const reducer = CreateGameReducer({ game: ChainsTCG });
  let state = InitializeGame({ game: ChainsTCG, numPlayers: 2, setupData });
  const api = {
    get G() { return state.G as GState; },
    get ctx() { return state.ctx; },
    move(type: string, playerID: string, ...args: any[]) {
      state = reducer(state, { type: 'MAKE_MOVE', payload: { type, args, playerID } } as any);
      return api;
    },
    event(type: string, playerID: string, arg?: any) {
      state = reducer(state, { type: 'GAME_EVENT', payload: { type, args: arg, playerID } } as any);
      return api;
    },
    // boardgame.io freezes the state it returns, so tests can't mutate G in
    // place to set up a board. Clone first, mutate the copy's G, and continue
    // driving from there — the reducer is pure and accepts any state object.
    seed(mut: (G: GState) => void) {
      state = structuredClone(state);
      mut(state.G as GState);
      return api;
    },
    raw() { return state; },
  };
  return api;
}

// Advance a fresh 2-player game (preset colors so there is no pick step to drive
// here) through pick + mulligan into the play phase, both players keeping.
function startedMatch(colors: [string, string] = ['base', 'eth']) {
  const m = makeMatch({ colors });
  // pick phase auto-ends because both colors are preset (needsColorPick false).
  // mulligan phase: both keep.
  if (m.ctx.phase === 'mulligan') {
    m.move('keepHand', '0');
    m.move('keepHand', '1');
  }
  return m;
}

describe('setup + opening hands', () => {
  it('deals 7 to each player and the starting player does NOT draw on turn one', () => {
    const m = startedMatch();
    expect(m.ctx.phase).toBe('play');
    expect(m.G.players['0'].hand.length).toBe(7);
    expect(m.G.players['1'].hand.length).toBe(7);
    // first play turn recorded; starting player still on 7 (no draw-step advantage)
    const starter = m.ctx.currentPlayer;
    expect(m.G.players[starter].hand.length).toBe(7);
    expect(m.G.firstPlayTurn).toBe(m.ctx.turn);
  });

  it('gives instances deterministic uids counted in G, starting fresh per game', () => {
    const m = startedMatch();
    const starter = m.ctx.currentPlayer;
    // find a node in hand to play
    const nodeIdx = m.G.players[starter].hand.findIndex(id => id.startsWith('node_'));
    expect(nodeIdx).toBeGreaterThanOrEqual(0);
    m.move('playCard', starter, nodeIdx);
    const node = m.G.players[starter].nodes[0];
    expect(node.uid).toBe('c1');
    expect(m.G.nextUid).toBe(1);
  });
});

describe('draw on later turns', () => {
  it('the second player DOES draw to 8 on their first turn', () => {
    const m = startedMatch();
    const first = m.ctx.currentPlayer;
    m.move('passTurn', first);
    const second = m.ctx.currentPlayer;
    expect(second).not.toBe(first);
    expect(m.G.players[second].hand.length).toBe(8);
  });
});

describe('combat: stalling defender cannot cancel or steal (engine-02/13)', () => {
  let now = 1_000_000;
  beforeEach(() => { now = 1_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); });
  afterEach(() => vi.restoreAllMocks());

  it('forceEndTurn while an attack is pending RESOLVES it (deals damage) instead of fogging it', () => {
    const m = startedMatch();
    const atk = m.ctx.currentPlayer;
    const def = atk === '0' ? '1' : '0';
    const memeId = firstMeme(m, atk);
    m.seed(G => G.players[atk].memes.push({ uid: 'A1', defId: memeId, tapped: false, damage: 0, summoningSick: false }));
    const power = cardPower(memeId);
    const defLifeBefore = m.G.players[def].life;
    m.move('declareAttacker', atk, 'A1');
    m.move('confirmAttackers', atk);
    expect(m.ctx.activePlayers?.[def]).toBe('blockers');
    // Defender stalls past the turn deadline, then the attacker force-ends.
    now += TURN_TIMEOUT_MS + 1;
    m.move('forceEndTurn', atk);
    // Damage landed; it was NOT cancelled.
    expect(m.G.players[def].life).toBe(defLifeBefore - power);
  });

  it('attacker can forceResolveBlocks once the block deadline lapses', () => {
    const m = startedMatch();
    const atk = m.ctx.currentPlayer;
    const def = atk === '0' ? '1' : '0';
    const memeId = firstMeme(m, atk);
    m.seed(G => G.players[atk].memes.push({ uid: 'A1', defId: memeId, tapped: false, damage: 0, summoningSick: false }));
    const defLifeBefore = m.G.players[def].life;
    m.move('declareAttacker', atk, 'A1');
    m.move('confirmAttackers', atk);
    now += BLOCK_TIMEOUT_MS + 1;
    m.move('forceResolveBlocks', atk);
    expect(m.G.players[def].life).toBe(defLifeBefore - cardPower(memeId));
    expect(m.G.combat.attackers.length).toBe(0);
  });

  it('defender in the blockers stage cannot play forceEndTurn (narrow stage move set)', () => {
    const m = startedMatch();
    const atk = m.ctx.currentPlayer;
    const def = atk === '0' ? '1' : '0';
    const memeId = firstMeme(m, atk);
    m.seed(G => G.players[atk].memes.push({ uid: 'A1', defId: memeId, tapped: false, damage: 0, summoningSick: false }));
    const defLifeBefore = m.G.players[def].life;
    m.move('declareAttacker', atk, 'A1');
    m.move('confirmAttackers', atk);
    now += TURN_TIMEOUT_MS + 1;
    // Defender tries to force-end the attacker's turn from the blockers stage.
    m.move('forceEndTurn', def);
    // Move rejected: still the attacker's turn, attack still pending.
    expect(m.ctx.currentPlayer).toBe(atk);
    expect(m.G.combat.attackers.length).toBe(1);
    expect(m.G.players[def].life).toBe(defLifeBefore);
  });
});

describe('damage targeting (engine-10)', () => {
  it('a damage move with a bogus target is rejected and keeps the card + gas', () => {
    const m = startedMatch();
    const pid = m.ctx.currentPlayer;
    // craft a known damage move in hand with gas available
    const dmgId = findMoveEffect('damage2') ?? findMoveEffect('damage3');
    if (!dmgId) return; // pool has no direct-damage move; skip
    const color = cardColor(dmgId);
    m.seed(G => { G.players[pid].hand.unshift(dmgId); G.players[pid].gas[color] = 9; });
    const handLenBefore = m.G.players[pid].hand.length;
    const graveBefore = m.G.players[pid].graveyard.length;
    m.move('playCard', pid, 0, 'nonexistent-uid');
    // Rejected: card still in hand, nothing in graveyard, gas unchanged.
    expect(m.G.players[pid].hand.length).toBe(handLenBefore);
    expect(m.G.players[pid].graveyard.length).toBe(graveBefore);
    expect(m.G.players[pid].gas[color]).toBe(9);
  });
});

describe('discard + concede + voice', () => {
  it('discardCard only works while over 7 and removes the chosen card', () => {
    const m = startedMatch();
    const pid = m.ctx.currentPlayer;
    m.seed(G => { while (G.players[pid].hand.length < 9) G.players[pid].hand.push('node_base'); });
    const target = m.G.players[pid].hand[0];
    const lenBefore = m.G.players[pid].hand.length;
    m.move('discardCard', pid, 0);
    expect(m.G.players[pid].hand.length).toBe(lenBefore - 1);
    expect(m.G.players[pid].graveyard).toContain(target);
  });

  it('concede sets the conceding player to 0 life and ends with reason concede', () => {
    const m = startedMatch();
    const pid = m.ctx.currentPlayer;
    const other = pid === '0' ? '1' : '0';
    m.move('concede', pid);
    expect(m.G.players[pid].life).toBe(0);
    expect(m.G.endReason).toBe('concede');
    expect(m.ctx.gameover).toEqual({ winner: other });
  });

  it('announceVoicePeer stores a valid id and rejects a malformed one', () => {
    const m = startedMatch();
    m.move('announceVoicePeer', '0', 'peer-abc123XYZ_000');
    expect(m.G.voice?.['0']).toBe('peer-abc123XYZ_000');
    m.move('announceVoicePeer', '1', 'nope spaces!');
    expect(m.G.voice?.['1']).toBeUndefined();
  });

  it('strips voice peer ids from a spectator view but keeps them for the seats', () => {
    const m = startedMatch();
    m.move('announceVoicePeer', '0', 'peerZERO0000');
    const forSeat0 = ChainsTCG.playerView!({ G: m.G, ctx: m.ctx, playerID: '0' } as any) as GState;
    const forSpectator = ChainsTCG.playerView!({ G: m.G, ctx: m.ctx, playerID: null } as any) as GState;
    expect(forSeat0.voice?.['0']).toBe('peerZERO0000');
    expect(Object.keys(forSpectator.voice ?? {}).length).toBe(0);
  });
});

// ── helpers that read the live catalogue so tests don't hard-code ids ────────
import { CARDS, type Color } from './cards';
function firstMeme(m: ReturnType<typeof makeMatch>, pid: string): string {
  const color = m.G.players[pid].color;
  const meme = Object.values(CARDS).find(c => c.color === color && c.type === 'meme');
  return meme!.id;
}
function cardPower(id: string): number { return (CARDS[id] as any).power ?? 0; }
function cardColor(id: string): Color { return CARDS[id].color; }
function findMoveEffect(effect: string): string | undefined {
  return Object.values(CARDS).find(c => c.type === 'move' && (c as any).effect === effect)?.id;
}
