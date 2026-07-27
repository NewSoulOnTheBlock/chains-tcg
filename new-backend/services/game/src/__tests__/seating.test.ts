/**
 * Ranked seating is gated on server-recorded card ownership (ROADMAP step 4).
 *
 * Card ownership used to live only in the browser
 * (`localStorage["ocva.collection.<name>"]`), so any player could grant
 * themselves the whole catalogue from devtools and enter ranked with it. These
 * tests pin the server-side control that replaces that: the decklist is counted
 * against `core.card_ownership`, per card, by QUANTITY, for the modes that have
 * something at stake — and for nothing else.
 *
 * `core.card_ownership` itself is mocked here: this file is about the decision,
 * not about SQL. The one query the decision makes is asserted on directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@chains/shared';
import { CARDS, isBasicNode, starterDeck } from '../game/cards.js';
import type { ActiveDeck } from '../repo/decks.repo.js';
import type { MatchMode } from '../repo/matches.repo.js';
import {
  assertDeckOwnership,
  findUnownedCards,
  requiresOwnedCards,
  type UnownedCardIssue,
} from '../lib/seating.js';
import { getOwnedQuantities } from '../repo/ownership.repo.js';

vi.mock('../repo/ownership.repo.js', () => ({ getOwnedQuantities: vi.fn() }));

const lookup = vi.mocked(getOwnedQuantities);

const PROFILE = '77';

/** The profile owns exactly `entries`; anything absent is owned zero times. */
function collection(entries: Record<string, number>): void {
  lookup.mockImplementation(async (_profileId, cardIds) => {
    const owned = new Map<string, number>();
    for (const id of cardIds) {
      const qty = entries[id];
      if (qty !== undefined) owned.set(id, qty);
    }
    return owned;
  });
}

/** Copies of each NON-Node card in a decklist — i.e. exactly what it demands. */
function nonNodeCounts(cards: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of cards) {
    if (isBasicNode(id)) continue;
    counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

function deck(cards: string[]): ActiveDeck {
  return { id: '4001', name: 'Test deck', cards };
}

/** The ids actually sent to `core.card_ownership` on the most recent call. */
function queriedIds(): string[] {
  const call = lookup.mock.calls.at(-1);
  if (!call) throw new Error('ownership was never queried');
  return [...call[1]];
}

function detailsOf(err: unknown): { reason: string; deckId: string; issues: UnownedCardIssue[] } {
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).details as {
    reason: string;
    deckId: string;
    issues: UnownedCardIssue[];
  };
}

const ETH = starterDeck('eth');

beforeEach(() => {
  lookup.mockReset();
});

describe('which modes are gated', () => {
  it('gates ranked', () => {
    expect(requiresOwnedCards('ranked')).toBe(true);
  });

  it('gates wager — real stakes, so at least the ranked bar', () => {
    expect(requiresOwnedCards('wager')).toBe(true);
  });

  it('leaves casual alone', () => {
    expect(requiresOwnedCards('casual')).toBe(false);
  });

  it('gates by default, so a mode added later is not silently exempt', () => {
    expect(requiresOwnedCards('tournament' as MatchMode)).toBe(true);
  });
});

describe('ranked seating', () => {
  it('seats a deck whose every card is owned', async () => {
    collection(nonNodeCounts(ETH));
    await expect(assertDeckOwnership(PROFILE, deck(ETH), 'ranked')).resolves.toBeUndefined();
  });

  it('asks for the whole decklist in ONE query, deduplicated', async () => {
    collection(nonNodeCounts(ETH));
    await assertDeckOwnership(PROFILE, deck(ETH), 'ranked');

    expect(lookup).toHaveBeenCalledTimes(1);
    const ids = queriedIds();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(Object.keys(nonNodeCounts(ETH)));
  });

  it('rejects a deck missing one card, naming it in `issues`', async () => {
    const owned = nonNodeCounts(ETH);
    delete owned.eth_pepe;
    collection(owned);

    const err = await assertDeckOwnership(PROFILE, deck(ETH), 'ranked').catch((e: unknown) => e);
    const details = detailsOf(err);

    expect((err as AppError).code).toBe('bad_request');
    expect(details.reason).toBe('unowned_cards');
    expect(details.deckId).toBe('4001');
    expect(details.issues).toEqual([
      {
        code: 'unowned',
        cardId: 'eth_pepe',
        need: 3,
        owned: 0,
        message: `Your deck runs 3 × ${CARDS.eth_pepe?.name} but you own 0.`,
      },
    ]);
  });

  it('rejects 1 owned copy of a card the deck runs 3 of — one pull is not a playset', async () => {
    collection({ ...nonNodeCounts(ETH), eth_pepe: 1 });

    const err = await assertDeckOwnership(PROFILE, deck(ETH), 'ranked').catch((e: unknown) => e);
    const issues = detailsOf(err).issues;

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ cardId: 'eth_pepe', need: 3, owned: 1 });
  });

  it('treats a qty = 0 row as not owned — a row proves history, not possession', async () => {
    // 0010 keeps the row when a card is spent to zero. Reading ownership as
    // `EXISTS (...)` rather than `qty > 0` would hand the card back.
    collection({ ...nonNodeCounts(ETH), eth_pepe: 0 });

    const issues = detailsOf(
      await assertDeckOwnership(PROFILE, deck(ETH), 'ranked').catch((e: unknown) => e),
    ).issues;

    expect(issues).toEqual([
      {
        code: 'unowned',
        cardId: 'eth_pepe',
        need: 3,
        owned: 0,
        message: `Your deck runs 3 × ${CARDS.eth_pepe?.name} but you own 0.`,
      },
    ]);
  });

  it('accepts exactly enough copies and no more', async () => {
    collection({ ...nonNodeCounts(ETH), eth_pepe: 3 });
    await expect(assertDeckOwnership(PROFILE, deck(ETH), 'ranked')).resolves.toBeUndefined();
  });

  it('lists every offending card individually, in a stable order', async () => {
    const owned = nonNodeCounts(ETH);
    delete owned.eth_pepe;
    owned.eth_andy = 1;
    collection(owned);

    const issues = detailsOf(
      await assertDeckOwnership(PROFILE, deck(ETH), 'ranked').catch((e: unknown) => e),
    ).issues;

    expect(issues.map((i) => i.cardId)).toEqual(['eth_andy', 'eth_pepe']);
  });
});

describe('basic Nodes are exempt', () => {
  it('does not reject a Node-heavy deck for its Nodes', async () => {
    // The collection is empty of Nodes on purpose — nobody is ever recorded as
    // owning them, because everybody does.
    collection({ eth_pepe: 2 });
    const nodeHeavy = [...Array(58).fill('node_eth'), 'eth_pepe', 'eth_pepe'];

    await expect(assertDeckOwnership(PROFILE, deck(nodeHeavy), 'ranked')).resolves.toBeUndefined();
    expect(queriedIds()).toEqual(['eth_pepe']);
  });

  it('does not query at all for an all-Node deck', async () => {
    collection({});
    const allNodes = Array(60).fill('node_sol') as string[];

    await expect(assertDeckOwnership(PROFILE, deck(allNodes), 'ranked')).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('exempts every basic Node in the catalogue', async () => {
    collection({});
    const everyNode = Object.keys(CARDS).filter((id) => CARDS[id]?.type === 'node');

    expect(everyNode.length).toBeGreaterThan(0);
    expect(await findUnownedCards(PROFILE, everyNode)).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('casual and solo are unaffected', () => {
  it('seats a casual deck of cards the player owns none of, without a lookup', async () => {
    collection({});
    await expect(assertDeckOwnership(PROFILE, deck(ETH), 'casual')).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('never touches solo — solo has no seating path to gate', async () => {
    // `src/SoloClient.tsx` runs boardgame.io's `Local()` transport in the
    // browser: no lobby call, no `game.matches` row, so nothing here executes
    // for it. The server's whole mode vocabulary is casual | ranked | wager
    // (`MatchMode`, and the `POST /games/create` body enum).
    const serverModes: MatchMode[] = ['casual', 'ranked', 'wager'];
    expect(serverModes).not.toContain('solo' as MatchMode);
    expect(lookup).not.toHaveBeenCalled();
  });
});
