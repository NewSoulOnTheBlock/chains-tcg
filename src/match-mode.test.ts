// src/match-mode.test.ts
//
// The mode picker's logic, tested without a DOM or a network.
//
// The cases that matter are the ones that lie to a player: offering wager while
// its money path is pointed at the wrong chain, calling a never-synced
// collection an illegal deck, or flagging a Basic Node the server does not even
// look at.

import { beforeEach, describe, expect, it } from 'vitest';
import { CARDS, COLORS } from './cards';
import { __resetCollectionForTests, applyServerSnapshot, ownedCount, ownershipKnown } from './collection';
import {
  MODE_BLURB,
  MODE_LABEL,
  OFFERED_MODES,
  evaluateRankedDeck,
  pickQuickMatch,
  shortfallLines,
} from './match-mode';

const NON_NODES = Object.keys(CARDS).filter((id) => !id.startsWith('node_'));
const CARD = NON_NODES[0]!;
const OTHER = NON_NODES[1]!;
const THIRD = NON_NODES[2]!;
const NODE = `node_${COLORS[0]}`;

/** Ownership known, with these confirmed counts. */
const owns = (cards: Record<string, number>) => ({
  known: true,
  ownedCount: (id: string) => cards[id] ?? 0,
});
/** Nobody has ever scanned the chain for this player. */
const unknownOwnership = { known: false, ownedCount: () => 0 };

describe('offered modes', () => {
  it('offers casual and ranked, and NEVER wager', () => {
    expect([...OFFERED_MODES]).toEqual(['casual', 'ranked']);
    // The money path answers `eth_chainId` with Sepolia while the contracts are
    // on Robinhood 4663. A stake made from this client would be unrecoverable,
    // so there is no option and no disabled teaser either.
    expect(OFFERED_MODES).not.toContain('wager');
  });

  it('has a label and a blurb for every offered mode', () => {
    for (const mode of OFFERED_MODES) {
      expect(MODE_LABEL[mode]).toBeTruthy();
      expect(MODE_BLURB[mode].length).toBeGreaterThan(20);
    }
  });
});

describe('evaluateRankedDeck', () => {
  it('says nothing at all when there is no active deck', () => {
    expect(evaluateRankedDeck(null, owns({}))).toEqual({ status: 'no-deck' });
    expect(evaluateRankedDeck([], owns({}))).toEqual({ status: 'no-deck' });
    expect(evaluateRankedDeck(undefined, owns({}))).toEqual({ status: 'no-deck' });
  });

  it('reports UNKNOWN rather than illegal when the collection was never synced', () => {
    // The whole point: "we have not looked" must never render as "you own none
    // of this". That is how you tell a paying customer their cards are gone.
    const result = evaluateRankedDeck([CARD, CARD, CARD], unknownOwnership);
    expect(result.status).toBe('unknown');
  });

  it('clears a deck whose non-Node cards are all owned', () => {
    const deck = [...Array(56).fill(NODE), CARD, CARD, OTHER, OTHER];
    const result = evaluateRankedDeck(deck, owns({ [CARD]: 2, [OTHER]: 3 }));
    expect(result).toEqual({ status: 'ready', nodes: 56, checked: 4 });
  });

  it('clears an all-Node deck — Nodes are free, unlimited and exempt', () => {
    // `services/game/src/lib/seating.ts` skips `node_*` outright, so 60 Nodes
    // against an empty collection is a legal ranked deck.
    const result = evaluateRankedDeck(Array(60).fill(NODE), owns({}));
    expect(result).toEqual({ status: 'ready', nodes: 60, checked: 0 });
  });

  it('counts the shortfall BY QUANTITY, exactly as the server does', () => {
    const deck = [...Array(57).fill(NODE), CARD, CARD, CARD];
    const result = evaluateRankedDeck(deck, owns({ [CARD]: 1 }));
    if (result.status !== 'short') throw new Error('expected short');
    expect(result.missingCards).toBe(1);
    expect(result.missingCopies).toBe(2); // 3 needed, 1 owned
    expect(result.shortfall[0]).toMatchObject({ cardId: CARD, need: 3, owned: 1, name: CARDS[CARD].name });
    expect(result.nodes).toBe(57);
    expect(result.checked).toBe(3);
  });

  it('never flags a Basic Node, however many the deck runs', () => {
    const deck = [...Array(59).fill(NODE), CARD];
    const result = evaluateRankedDeck(deck, owns({}));
    if (result.status !== 'short') throw new Error('expected short');
    expect(result.shortfall.map((s) => s.cardId)).toEqual([CARD]);
  });

  it('puts the biggest gap first', () => {
    const deck = [CARD, OTHER, OTHER, OTHER, OTHER, THIRD, THIRD];
    const result = evaluateRankedDeck(deck, owns({ [THIRD]: 1 }));
    if (result.status !== 'short') throw new Error('expected short');
    expect(result.shortfall.map((s) => s.cardId)).toEqual([OTHER, CARD, THIRD]);
    expect(result.missingCopies).toBe(4 + 1 + 1);
  });

  it('is silent about a card the player owns more copies of than the deck runs', () => {
    expect(evaluateRankedDeck([CARD], owns({ [CARD]: 4 })).status).toBe('ready');
  });
});

describe('evaluateRankedDeck against the real collection store', () => {
  // The lobby calls it with `ownershipKnown` / `ownedCount` straight from
  // `src/collection.ts`; this pins that wiring rather than the shape of a mock.
  beforeEach(() => { __resetCollectionForTests(); });

  const live = () => ({ known: ownershipKnown(), ownedCount });

  it('is UNKNOWN before any sync, even though ownedCount answers 0', () => {
    expect(evaluateRankedDeck([CARD, CARD], live()).status).toBe('unknown');
  });

  it('turns into a real answer once a sync confirms the snapshot', () => {
    applyServerSnapshot({ cards: {}, synced: true, syncedAt: '2026-07-27T10:00:00.000Z' });
    expect(evaluateRankedDeck([CARD, CARD], live()).status).toBe('short');

    applyServerSnapshot({ cards: { [CARD]: 2 }, synced: true, syncedAt: '2026-07-27T10:05:00.000Z' });
    expect(evaluateRankedDeck([CARD, CARD], live()).status).toBe('ready');
  });
});

describe('shortfallLines', () => {
  const gap = (name: string, need: number, owned: number) => ({ cardId: name, name, need, owned });

  it('says "none owned" when the player has none of the card', () => {
    expect(shortfallLines([gap('PEPE', 3, 0)])).toEqual(['PEPE — 3 needed, none owned']);
  });

  it('names the partial holding when they have some', () => {
    expect(shortfallLines([gap('PEPE', 3, 1)])).toEqual(['PEPE — 3 needed, 1 owned']);
  });

  it('collapses the tail so a starter deck is not a wall of text', () => {
    const many = Array.from({ length: 9 }, (_, i) => gap(`C${i}`, 2, 0));
    const lines = shortfallLines(many);
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('and 5 more cards');
  });

  it('uses the singular for a single remaining card', () => {
    const five = Array.from({ length: 5 }, (_, i) => gap(`C${i}`, 1, 0));
    expect(shortfallLines(five)[4]).toBe('and 1 more card');
  });
});

describe('pickQuickMatch', () => {
  const seat = (displayName: string | null) => ({ filled: displayName !== null, displayName });
  const empty = { filled: false, displayName: null };
  const row = (matchID: string, mode: string, host: string | null = 'Host') =>
    ({ matchID, mode, seats: [seat(host), empty] });

  it('prefers a casual seat', () => {
    const open = [row('r', 'ranked'), row('c', 'casual')];
    expect(pickQuickMatch(open, 'Me', true)?.matchID).toBe('c');
  });

  it('will not seat a deck that would fail the ranked ownership check', () => {
    // Otherwise "find a match" is a button that can only 400 for a starter deck.
    expect(pickQuickMatch([row('r', 'ranked')], 'Me', false)).toBeUndefined();
    expect(pickQuickMatch([row('r', 'ranked')], 'Me', true)?.matchID).toBe('r');
  });

  it('never takes a wager seat — this client has no stake flow', () => {
    expect(pickQuickMatch([row('w', 'wager')], 'Me', true)).toBeUndefined();
  });

  it('skips our own matches (joining one is a self_challenge) and full ones', () => {
    const mine = { matchID: 'mine', mode: 'casual', seats: [seat('Me'), empty] };
    const full = { matchID: 'full', mode: 'casual', seats: [seat('A'), seat('B')] };
    expect(pickQuickMatch([mine, full], 'Me', true)).toBeUndefined();
  });

  it('returns nothing for an empty lobby', () => {
    expect(pickQuickMatch([], 'Me', true)).toBeUndefined();
  });
});
