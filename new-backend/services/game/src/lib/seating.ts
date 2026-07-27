import { randomBytes } from 'node:crypto';
import { AppError, type PoolClient } from '@chains/shared';
import { CARDS, isBasicNode, validateDeck } from '../game/cards.js';
import type { ActiveDeck } from '../repo/decks.repo.js';
import type { MatchMode } from '../repo/matches.repo.js';
import { getOwnedQuantities } from '../repo/ownership.repo.js';

/**
 * boardgame.io seat credentials.
 *
 * Minted SERVER-SIDE (audit C-3): the client never proposes a `playerName` or
 * a `credentials` value. 256 bits from the CSPRNG, base64url so it survives
 * query strings and headers untouched.
 */
export function mintCredentials(): string {
  return randomBytes(32).toString('base64url');
}

/** A deck must be fully legal before it can be seated into a real match. */
export function assertSeatableDeck(deck: ActiveDeck | null): asserts deck is ActiveDeck {
  if (!deck) {
    throw AppError.badRequest(
      'You have no active deck — create one and activate it before playing',
      { reason: 'no_active_deck' },
    );
  }
  const result = validateDeck(deck.cards, { requireSize: true });
  if (!result.ok) {
    throw AppError.badRequest('Your active deck is not legal', {
      reason: 'invalid_active_deck',
      deckId: deck.id,
      issues: result.issues,
    });
  }
}

/**
 * Modes that seat WITHOUT an ownership check.
 *
 * Deliberately a denylist, not an allowlist: a mode added later is gated until
 * somebody writes its exemption here on purpose. The failure mode of getting
 * this backwards is "a new mode silently accepts cards nobody owns", which is
 * the exact hole this module exists to close.
 *
 * `casual` is exempt because nothing is at stake in it, and because a player is
 * entitled to keep a casual deck active that would not qualify for ranked —
 * which is why this check lives at seating and not at deck `activate()`.
 *
 * `solo` is not listed because it is not a server mode at all: `SoloClient.tsx`
 * runs boardgame.io's `Local()` transport in the browser, creates no
 * `game.matches` row and never calls this service.
 */
const UNGATED_MODES: ReadonlySet<string> = new Set<MatchMode>(['casual']);

/** Whether seating a deck into `mode` requires server-recorded ownership. */
export function requiresOwnedCards(mode: MatchMode): boolean {
  return !UNGATED_MODES.has(mode);
}

/**
 * One card the deck runs more copies of than the profile owns.
 *
 * Same shape as a `validateDeck` issue (`code` + player-readable `message`), so
 * the client's existing `errorIssues()` renders it with no change; the
 * structured fields ride alongside for anything that wants to be precise.
 */
export interface UnownedCardIssue {
  code: 'unowned';
  cardId: string;
  /** Copies the decklist runs. */
  need: number;
  /** Copies `core.card_ownership` records for this profile. */
  owned: number;
  message: string;
}

/**
 * Cards in `cards` that `profileId` does not own enough copies of.
 *
 * QUANTITY, not presence: a deck running 3 copies needs `qty >= 3`. Checking
 * only "do they own one" would let a single pull unlock a full playset — the
 * same hole in a smaller size.
 *
 * Basic Nodes are granted to everyone and are never looked up: `isBasicNode()`
 * is the catalogue's own definition (the one `validateDeck` uses to exempt them
 * from the 4-copy cap), so this cannot drift from the card data.
 */
export async function findUnownedCards(
  profileId: string,
  cards: readonly string[],
  c?: PoolClient,
): Promise<UnownedCardIssue[]> {
  const need = new Map<string, number>();
  for (const id of cards) {
    if (isBasicNode(id)) continue;
    need.set(id, (need.get(id) ?? 0) + 1);
  }
  if (need.size === 0) return [];

  const owned = await getOwnedQuantities(profileId, [...need.keys()], c);

  const issues: UnownedCardIssue[] = [];
  for (const [cardId, n] of need) {
    const have = owned.get(cardId) ?? 0;
    if (have >= n) continue;
    issues.push({
      code: 'unowned',
      cardId,
      need: n,
      owned: have,
      message: `Your deck runs ${n} × ${CARDS[cardId]?.name ?? cardId} but you own ${have}.`,
    });
  }
  // Stable order so the rendered list does not depend on decklist ordering.
  issues.sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0));
  return issues;
}

/**
 * Gate a seat on real, server-recorded card ownership.
 *
 * Split out of `assertSeatableDeck` rather than folded into it because that one
 * is an assertion function (`asserts deck is ActiveDeck`) and TypeScript forbids
 * an assertion signature on an async function. Keeping the synchronous format
 * assertion intact means both call sites still narrow `ActiveDeck | null` for
 * free, with no cast and no `!`, and the DB round trip stays visibly separate
 * from the pure legality check.
 *
 * `mode` must come from `game.matches` on the join path — never from a request
 * body. A client that could name its own mode would simply say `casual` and
 * seat into a ranked match anyway.
 */
export async function assertDeckOwnership(
  profileId: string,
  deck: ActiveDeck,
  mode: MatchMode,
  c?: PoolClient,
): Promise<void> {
  if (!requiresOwnedCards(mode)) return;

  const issues = await findUnownedCards(profileId, deck.cards, c);
  if (issues.length === 0) return;

  throw AppError.badRequest('Your active deck contains cards you do not own', {
    reason: 'unowned_cards',
    deckId: deck.id,
    issues,
  });
}

export interface SeatSetup {
  names: [string, string];
  decks: [string[], string[]];
}

export interface MatchSetupData {
  names: [string, string];
  decks: [string[], string[]];
  colors: [null, null];
  wager: { kind: 'free' } | { kind: 'master'; amount?: number; onchainId?: string };
  mode: string;
}

/**
 * Build the boardgame.io `setupData`.
 *
 * This object contains BOTH decklists, which is exactly why it must never be
 * served over HTTP: our lobby reads `game.matches` and never touches
 * boardgame.io's storage, and boardgame.io's own lobby routes — the ones that
 * would return `setupData` — are not listening (see src/bgio/server.ts).
 *
 * In-match, `Game.playerView` strips deck contents to counts and the
 * opponent's hand to placeholders, so a seated player never sees the other
 * decklist either.
 */
export function buildSetupData(
  seats: SeatSetup,
  mode: string,
  wager: { amountBase: string | null; wagerId: string | null },
): MatchSetupData {
  const amount = wager.amountBase !== null ? Number(wager.amountBase) : undefined;
  return {
    names: seats.names,
    decks: seats.decks,
    // Both seats bring a validated custom deck, so nobody enters the colour
    // pick phase and no deck can arrive from the client as a `chooseColor` arg.
    colors: [null, null],
    wager:
      mode === 'wager'
        ? {
            kind: 'master',
            ...(amount !== undefined && Number.isFinite(amount) ? { amount } : {}),
            ...(wager.wagerId !== null ? { onchainId: wager.wagerId } : {}),
          }
        : { kind: 'free' },
    mode,
  };
}
