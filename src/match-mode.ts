// src/match-mode.ts
//
// WHICH MATCH MODES THIS CLIENT OFFERS, and whether the player's active deck
// qualifies for the one they picked.
//
// ─── THE THREE MODES ────────────────────────────────────────────────────────
// `POST /games/create` takes `mode: 'casual' | 'ranked' | 'wager'`, and the game
// service enforces the difference itself:
//
//   casual  ungated. The 5 free starter decks exist precisely so anyone can
//           play without owning a single booster card.
//   ranked  every NON-Node card in the caller's active deck is checked against
//           `core.card_ownership` BY QUANTITY — a deck running 3 copies needs 3
//           owned. Both seats are checked, and the host is re-checked at join.
//           A failure is 400 + `details.reason = 'unowned_cards'`.
//   wager   the same ownership check plus real money.
//
// ─── WAGER IS DELIBERATELY NOT OFFERED ──────────────────────────────────────
// The money path is pointed at the wrong chain: the production RPC proxy
// answers `eth_chainId` with Sepolia while the game and the contracts live on
// Robinhood 4663, so a real stake would be unrecoverable. `OFFERED_MODES` is
// therefore casual + ranked, and there is no disabled teaser for wager either —
// an affordance for a feature that could lose someone's money should not be on
// screen at all. See `WAGERS_AVAILABLE` in App.tsx for the second half of that
// story.
//
// ─── RANKED MATCHES ARE NOT THE RANKED LADDER ───────────────────────────────
// A ranked MATCH is a match tagged `ranked` whose decks are ownership-checked —
// that works today. The ranked LADDER (rating, seasons, a queue) does not exist
// server-side; see `src/ranked-client.ts`. Do not let one imply the other.

import { CARDS, isBasicNode } from './cards';

/** A mode this client will actually send. Wager is excluded on purpose. */
export type OfferedMode = 'casual' | 'ranked';

/** The picker's options, in display order. NEVER add 'wager' to this. */
export const OFFERED_MODES: readonly OfferedMode[] = ['casual', 'ranked'];

export const MODE_LABEL: Record<OfferedMode, string> = {
  casual: 'CASUAL',
  ranked: 'RANKED',
};

/** One line under the picker, explaining what the choice actually costs. */
export const MODE_BLURB: Record<OfferedMode, string> = {
  casual: 'Open to any legal deck, including the free starter decks. Nothing is checked against your collection.',
  ranked: 'The server checks every non-Node card in your active deck against the cards you own on-chain.',
};

// ── Ranked deck eligibility ─────────────────────────────────────────────────

/** One card the deck runs more copies of than the player owns. */
export interface RankedShortfall {
  cardId: string;
  /** Display name, or the id when the catalogue does not know the card. */
  name: string;
  /** Copies in the deck. */
  need: number;
  /** Copies the server confirms the player owns. */
  owned: number;
}

/**
 * Can this deck be seated in a ranked match?
 *
 * The three states are genuinely different and must not be collapsed:
 *
 *   no-deck  nothing to check yet — the server would refuse with
 *            `no_active_deck` long before it looked at ownership.
 *   unknown  the collection has NEVER been synced. We have not looked, so we
 *            do not know. Prompt a chain scan; do NOT claim the deck is
 *            illegal — that is how you tell a paying customer their cards are
 *            gone.
 *   short    synced, and the deck runs cards the player does not own. This is
 *            the expected answer for a starter deck (22 Nodes + ~38 non-Node
 *            cards) and is the design, not a fault.
 *   ready    synced and fully covered. No friction.
 */
export type RankedEligibility =
  | { status: 'no-deck' }
  | { status: 'unknown' }
  | { status: 'ready'; nodes: number; checked: number }
  | {
      status: 'short';
      /** Worst gap first, then alphabetical. Never empty. */
      shortfall: RankedShortfall[];
      /** Total copies that would have to be acquired. */
      missingCopies: number;
      /** Distinct cards short. */
      missingCards: number;
      /** Non-Node copies in the deck that WERE covered. */
      nodes: number;
      checked: number;
    };

/**
 * Mirror the server's ranked seating check against a local snapshot.
 *
 * ADVISORY ONLY. The server is the authority — this exists so the player is
 * told before they press the button, not so the client can refuse to send one.
 * Never use it to disable creating a match: the snapshot can lag a pack that
 * has just been minted, and a client-side "no" would be a dead end.
 *
 * Basic Nodes are skipped exactly as `services/game/src/lib/seating.ts` skips
 * `node_*` — they are free, unlimited, and never reported by the server. A deck
 * of 55 Nodes and 5 pulled cards is a perfectly legal ranked deck; nothing here
 * should suggest a full playset is required.
 */
export function evaluateRankedDeck(
  deckCards: readonly string[] | null | undefined,
  ownership: { known: boolean; ownedCount: (id: string) => number },
): RankedEligibility {
  if (!deckCards || deckCards.length === 0) return { status: 'no-deck' };
  // "We have not looked" is not "you own nothing". Answer nothing at all.
  if (!ownership.known) return { status: 'unknown' };

  let nodes = 0;
  const counts = new Map<string, number>();
  for (const id of deckCards) {
    if (isBasicNode(id)) { nodes += 1; continue; }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const shortfall: RankedShortfall[] = [];
  let checked = 0;
  for (const [cardId, need] of counts) {
    checked += need;
    const owned = ownership.ownedCount(cardId);
    if (need <= owned) continue;
    shortfall.push({ cardId, name: CARDS[cardId]?.name ?? cardId, need, owned });
  }

  if (shortfall.length === 0) return { status: 'ready', nodes, checked };

  // Biggest gap first — that is the card the player has to solve for.
  shortfall.sort((a, b) => (b.need - b.owned) - (a.need - a.owned) || a.name.localeCompare(b.name));
  return {
    status: 'short',
    shortfall,
    missingCopies: shortfall.reduce((sum, s) => sum + (s.need - s.owned), 0),
    missingCards: shortfall.length,
    nodes,
    checked,
  };
}

/**
 * The shortfall as lines for a list, longest gap first, with the tail collapsed
 * so a starter deck (~20 offending cards) does not produce a wall of text.
 */
export function shortfallLines(shortfall: readonly RankedShortfall[], limit = 4): string[] {
  const shown = shortfall.slice(0, limit).map((s) =>
    s.owned === 0
      ? `${s.name} — ${s.need} needed, none owned`
      : `${s.name} — ${s.need} needed, ${s.owned} owned`,
  );
  const rest = shortfall.length - shown.length;
  if (rest > 0) shown.push(`and ${rest} more card${rest === 1 ? '' : 's'}`);
  return shown;
}

// ── Quick match ─────────────────────────────────────────────────────────────

/** The bit of a lobby row this file needs. Keeps the tests free of the API. */
interface QuickMatchCandidate {
  matchID: string;
  mode: string;
  seats: ReadonlyArray<{ filled: boolean; displayName: string | null }>;
}

/**
 * Pick the open match Quick Match should take a seat in.
 *
 * Quick Match is the casual on-ramp, so it prefers a casual match and only
 * falls back to a ranked one when the player's deck would actually survive the
 * ownership check — otherwise it would hand a starter-deck player a guaranteed
 * `unowned_cards` 400 for a button labelled "find a match".
 *
 * Wager matches are never taken: this client has no stake flow to fund one.
 * Our own matches are skipped because joining one is a `self_challenge`.
 */
export function pickQuickMatch<T extends QuickMatchCandidate>(
  open: readonly T[],
  myName: string,
  rankedReady: boolean,
): T | undefined {
  const joinable = open.filter(
    (m) => m.seats.some((s) => !s.filled) && !m.seats.some((s) => s.displayName === myName),
  );
  return (
    joinable.find((m) => m.mode === 'casual') ??
    (rankedReady ? joinable.find((m) => m.mode === 'ranked') : undefined)
  );
}
