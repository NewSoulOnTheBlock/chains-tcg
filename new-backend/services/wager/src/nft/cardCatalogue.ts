/**
 * Index-to-card-id resolution, and the guard that keeps it honest.
 *
 * `cardIndex.ts` next to this file is generated data. Everything that decides
 * anything lives here.
 *
 * The whole risk in chain-derived ownership is a silent off-by-N: the contract
 * stores a card as a NUMBER (`cardOf(tokenId)`), and the number only means
 * something because of an array whose order is a side effect of object literal
 * ordering in `<repo>/src/cards.ts`. Insert one card in the middle of that file
 * and every stored ownership row after it becomes a different card, with no
 * error anywhere. So:
 *
 *  - `assertMatchesChain()` compares the manifest length against the contract's
 *    own immutable `cardCount()` before ANY ownership is written. A mismatch
 *    stops the sync; it does not degrade to a best effort.
 *  - `cardIdForIndex()` throws on an index outside the manifest rather than
 *    inventing a placeholder id.
 *  - `__tests__/cardIndex.test.ts` re-derives the list from the root catalogue.
 *
 * `cardCount` is `immutable` in CardPack.sol, so it cannot drift underneath a
 * deployed contract — a mismatch always means the manifest moved, never the
 * chain.
 */
import { AppError } from '../platform/shared.js';
import { CARD_COUNT, CARD_INDEX } from './cardIndex.js';

export { CARD_COUNT, CARD_INDEX };

/**
 * The card id at an on-chain card index.
 *
 * Throws rather than returning a fallback. A card id this service cannot resolve
 * is a mapping bug, and writing `"#57"` into a collection that gates a prize
 * would hide it.
 */
export function cardIdForIndex(index: number): string {
  const id = CARD_INDEX[index];
  if (id === undefined) {
    throw new Error(
      `card index ${index} is outside the manifest (0..${CARD_COUNT - 1}) — ` +
        'the vendored card index is out of sync with the deployed CardPack',
    );
  }
  return id;
}

/**
 * Refuse to proceed unless the contract agrees about how many cards exist.
 *
 * Called on every sync, not once at boot: a boot-time check would pass forever
 * against a contract address that later changed in configuration.
 */
export function assertMatchesChain(chainCardCount: number): void {
  if (chainCardCount !== CARD_COUNT) {
    throw AppError.unavailable(
      'Card ownership cannot be synced on this deployment',
      {
        reason: 'card_index_out_of_sync',
        manifest_card_count: CARD_COUNT,
        chain_card_count: chainCardCount,
      },
    );
  }
}
