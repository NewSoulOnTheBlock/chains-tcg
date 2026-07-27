// src/collection.test.ts
//
// The ownership model, tested without a network or a DOM.
//
// The cases that matter here are the ones that lose a paying customer their
// cards: telling a never-synced player they own nothing, flagging Basic Nodes
// the server does not even check, or letting an optimistic post-mint overlay
// leak into an ownership decision.

import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { unownedIssues } from './api/collection';
import { CARDS, COLORS, DECK_SIZE, MAX_COPIES_NONBASIC } from './cards';
import {
  STARTING_NODES,
  __resetCollectionForTests,
  applyOptimisticGrant,
  applyServerSnapshot,
  deckCap,
  getCollection,
  getCollectionState,
  ownedCount,
  ownershipIssues,
  ownershipKnown,
  validateOwnedDeck,
} from './collection';

/** A real non-Node card id, so `validateDeck` does not report it as unknown. */
const CARD = Object.keys(CARDS).find((id) => !id.startsWith('node_'))!;
const OTHER = Object.keys(CARDS).filter((id) => !id.startsWith('node_'))[1]!;
const NODE = `node_${COLORS[0]}`;

/** A snapshot the server has actually written (`synced: true`). */
function serverHas(cards: Record<string, number>) {
  applyServerSnapshot({ cards, synced: true, syncedAt: '2026-07-27T10:00:00.000Z' });
}

beforeEach(() => { __resetCollectionForTests(); });

describe('Basic Nodes', () => {
  it('are synthesised locally, because the server never reports them', () => {
    serverHas({ [CARD]: 2 });
    const owned = getCollection();
    for (const color of COLORS) expect(owned[`node_${color}`]).toBe(STARTING_NODES);
  });

  it('are uncapped in a deck — the server skips them in the ownership check', () => {
    serverHas({});
    expect(deckCap(NODE)).toBe(Infinity);
    // A 60-Node deck is legal. The old client capped this at the display grant
    // of 20 and invented an ownership failure the server would never raise.
    expect(ownershipIssues(Array(60).fill(NODE))).toEqual([]);
  });

  it('are never flagged even when the deck runs more than the display grant', () => {
    serverHas({ [CARD]: 1 });
    const deck = [...Array(40).fill(NODE), ...Array(20).fill(CARD)];
    const issues = ownershipIssues(deck);
    expect(issues.every((i) => !i.message.includes('Node'))).toBe(true);
    expect(issues).toHaveLength(1); // only the 20 × CARD against 1 owned
  });
});

describe('"never synced" is not "owns nothing"', () => {
  it('refuses to answer anything while `synced` is false', () => {
    applyServerSnapshot({ cards: {}, synced: false, syncedAt: null });
    const state = getCollectionState();
    expect(state.needsSync).toBe(true);
    expect(ownershipKnown()).toBe(false);
    // The critical assertion: no "you don't own this" for anything. An empty
    // collection we have never looked up is UNKNOWN, not empty.
    expect(ownershipIssues([CARD, CARD, CARD])).toEqual([]);
    expect(deckCap(CARD)).toBe(MAX_COPIES_NONBASIC);
  });

  it('answers "you own nothing" once `synced` is true and the map is empty', () => {
    applyServerSnapshot({ cards: {}, synced: true, syncedAt: '2026-07-27T10:00:00.000Z' });
    expect(getCollectionState().needsSync).toBe(false);
    expect(ownershipKnown()).toBe(true);
    expect(ownershipIssues([CARD])).toHaveLength(1);
  });

  it('falls back to syncedAt when a server predates the `synced` field', () => {
    applyServerSnapshot({ cards: {}, syncedAt: null });
    expect(ownershipKnown()).toBe(false); // errs towards "prompt a scan"
    applyServerSnapshot({ cards: {}, syncedAt: '2026-07-27T10:00:00.000Z' });
    expect(ownershipKnown()).toBe(true);
  });

  it('accepts an empty result from a sync WE performed as proof of emptiness', () => {
    applyServerSnapshot({ cards: {}, synced: false, syncedAt: null }, { confirmedBySync: true });
    expect(getCollectionState().needsSync).toBe(false);
    expect(ownershipKnown()).toBe(true);
  });

  it('enforces nothing at all when signed out', () => {
    expect(getCollectionState().source).toBe('signed-out');
    expect(ownershipIssues(Array(60).fill(CARD))).toEqual([]);
  });
});

describe('deckCap', () => {
  it('is the smaller of what you own and the 4-copy format limit', () => {
    serverHas({ [CARD]: 2, [OTHER]: 9 });
    expect(deckCap(CARD)).toBe(2);
    expect(deckCap(OTHER)).toBe(MAX_COPIES_NONBASIC);
  });

  it('falls back to the format limit when ownership is unknown', () => {
    expect(deckCap(CARD)).toBe(MAX_COPIES_NONBASIC);
  });
});

describe('ownershipIssues', () => {
  it('reports the shortfall per card, using the display name', () => {
    serverHas({ [CARD]: 1 });
    const [issue] = ownershipIssues([CARD, CARD, CARD]);
    expect(issue.code).toBe('owned');
    expect(issue.message).toContain(CARDS[CARD].name);
    expect(issue.message).toContain('3');
    expect(issue.message).toContain('1');
  });

  it('says "open a booster pack" when the player owns none', () => {
    serverHas({ [OTHER]: 4 });
    const [issue] = ownershipIssues([CARD]);
    expect(issue.message).toMatch(/booster/i);
  });

  it('is silent when the collection covers the deck', () => {
    serverHas({ [CARD]: 4 });
    expect(ownershipIssues([CARD, CARD, CARD, CARD])).toEqual([]);
  });
});

describe('validateOwnedDeck', () => {
  it('combines format legality with ownership', () => {
    serverHas({ [CARD]: 1 });
    const deck = [...Array(59).fill(NODE), CARD];
    const result = validateOwnedDeck(deck);
    expect(result.size).toBe(DECK_SIZE);
    expect(result.ok).toBe(true);

    const short = validateOwnedDeck([CARD, CARD]);
    expect(short.ok).toBe(false);
    expect(short.issues.some((i) => i.code === 'size')).toBe(true);
    expect(short.issues.some((i) => i.code === 'owned')).toBe(true);
  });
});

describe('post-mint optimistic overlay', () => {
  it('shows the new cards immediately but never counts them as owned', () => {
    serverHas({ [CARD]: 1 });
    applyOptimisticGrant([CARD, OTHER]);

    // Display: the player sees their pack.
    expect(getCollection()[CARD]).toBe(2);
    expect(getCollection()[OTHER]).toBe(1);
    expect(getCollectionState().pendingCount).toBe(2);

    // Decisions: still only what the server confirms.
    expect(ownedCount(CARD)).toBe(1);
    expect(ownedCount(OTHER)).toBe(0);
    expect(ownershipIssues([CARD, CARD])).toHaveLength(1);
  });

  it('dissolves as the chain indexer catches up', () => {
    serverHas({ [CARD]: 1 });
    applyOptimisticGrant([CARD, OTHER]);
    expect(getCollectionState().pendingCount).toBe(2);

    // First sync: only one of the two tokens has been indexed.
    serverHas({ [CARD]: 2 });
    expect(getCollectionState().pendingCount).toBe(1);
    expect(getCollection()[OTHER]).toBe(1);

    // Second sync: the server accounts for the whole pack.
    serverHas({ [CARD]: 2, [OTHER]: 1 });
    expect(getCollectionState().pendingCount).toBe(0);
    expect(ownedCount(OTHER)).toBe(1);
  });

  it('shrinks rather than double-counting when the server outruns it', () => {
    serverHas({ [CARD]: 1 });
    applyOptimisticGrant([CARD]);
    serverHas({ [CARD]: 5 });
    expect(getCollectionState().pendingCount).toBe(0);
    expect(getCollection()[CARD]).toBe(5);
  });
});

describe('the server snapshot replaces, never merges', () => {
  it('drops cards the player has sold', () => {
    serverHas({ [CARD]: 4, [OTHER]: 4 });
    // CardPack NFTs are tradeable, so a reconcile deletes what is gone. An
    // additive client would make "sell your collection and keep playing it"
    // the cheapest exploit in the product.
    serverHas({ [CARD]: 4 });
    expect(ownedCount(OTHER)).toBe(0);
    expect(getCollectionState().total).toBe(4);
    expect(getCollectionState().distinct).toBe(1);
  });

  it('ignores any node_* id the server sends, and junk quantities', () => {
    serverHas({ [CARD]: 3, [NODE]: 1, bogus: -2, nonsense: 0 } as Record<string, number>);
    expect(getCollection()[NODE]).toBe(STARTING_NODES);
    expect(getCollectionState().total).toBe(3);
  });
});

describe('unowned_cards rejection parsing', () => {
  const err = new ApiError({
    status: 400,
    code: 'bad_request',
    message: 'Your active deck contains cards you do not own',
    details: {
      reason: 'unowned_cards',
      deckId: '12',
      issues: [
        { code: 'unowned', cardId: 'eth_pepe', need: 3, owned: 0, message: 'Your deck runs 3 × PEPE but you own 0.' },
        { nonsense: true },
      ],
    },
  });

  it('keeps the numeric fields ApiError.issues strips out', () => {
    const issues = unownedIssues(err);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ cardId: 'eth_pepe', need: 3, owned: 0, code: 'unowned' });
  });

  it('returns nothing for an unrelated error', () => {
    expect(unownedIssues(new ApiError({ status: 400, code: 'bad_request', message: 'nope' }))).toEqual([]);
  });
});
