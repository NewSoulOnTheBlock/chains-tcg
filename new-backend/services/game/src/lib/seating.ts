import { randomBytes } from 'node:crypto';
import { AppError } from '@chains/shared';
import { validateDeck } from '../game/cards.js';
import type { ActiveDeck } from '../repo/decks.repo.js';

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
