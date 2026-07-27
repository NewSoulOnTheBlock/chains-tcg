/**
 * The caller's card collection.
 *
 * Ownership is DERIVED FROM THE CHAIN. The CardPack ERC-721 on Robinhood Chain
 * is what a player actually holds; `core.card_ownership` is a queryable
 * projection of it, so seating can check a deck without an RPC round trip per
 * card. The client's `localStorage` copy is a display cache and is never read
 * here — it runs on the player's machine, and with a prize attached, editing one
 * localStorage value is the highest-payoff attack in the product.
 *
 * Two operations:
 *   `getMyCollection`  reads the stored snapshot. Cheap, no network.
 *   `syncMyCollection` re-derives the snapshot from chain state and replaces it.
 *
 * Both take the address from `AuthContext`, never from a request. Identity is
 * `(address, chain)` proven at login, so the address is already authenticated;
 * accepting one from a body or a path would recreate audit finding H-2, where
 * anyone could read anyone's holdings by knowing their wallet.
 */
import type { PoolClient } from 'pg';
import { AppError, getPool, withTransaction } from '../platform/shared.js';
import type { AuthContext } from '../platform/shared.js';
import { log } from '../platform/logger.js';
import { lastSyncedAt, listOwnedCards, reconcileChainCards } from '../db/ownership.js';
import { assertMatchesChain, cardIdForIndex } from '../nft/cardCatalogue.js';
import type { CardPackReader } from '../chain/cardPackReader.js';

export interface CollectionServiceDeps {
  /** Null when no CardPack contract is configured — sync is then unavailable. */
  cardPack: CardPackReader | null;
}

export interface CollectionView {
  /** Card id → quantity owned. Cards not owned are absent, never zero. */
  cards: Record<string, number>;
  /** Distinct card ids owned. */
  distinct: number;
  /** Cards owned in total, counting duplicates. */
  total: number;
  /**
   * When this snapshot was last written, or null if it never has been.
   *
   * Derived from `max(updated_at)`, so it is also null for a player who owns
   * nothing — "never synced" and "synced, owns nothing" are indistinguishable
   * until the sync-state table exists. Callers must not treat null as proof of
   * a stale snapshot.
   */
  syncedAt: string | null;
}

/** Only ever the caller's own collection. There is no "collection by wallet" route. */
export async function getMyCollection(auth: AuthContext): Promise<CollectionView> {
  const rows = await listOwnedCards(getPool(), auth.profileId);
  const cards: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    cards[row.cardId] = row.qty;
    total += row.qty;
  }
  const at = await lastSyncedAt(getPool(), auth.profileId);
  return {
    cards,
    distinct: rows.length,
    total,
    syncedAt: at ? at.toISOString() : null,
  };
}

export interface SyncResult extends CollectionView {
  /** Head block the snapshot was taken at. */
  blockNumber: number;
  /** Tokens the address once received but no longer holds. */
  transferredAway: number;
  /** Rows removed because the profile no longer holds that card. */
  removed: number;
}

/**
 * Re-derive the caller's collection from chain state and replace the stored one.
 *
 * Ordering matters and is not incidental:
 *   1. verify the manifest still agrees with the contract's immutable
 *      `cardCount()` — a shifted card index silently rewrites history, so it is
 *      checked before anything is written, every time,
 *   2. enumerate holdings (complete, or an exception — never partial),
 *   3. resolve indexes to card ids, failing closed on an unknown index,
 *   4. reconcile in ONE transaction.
 *
 * Step 4 is a full reconcile: sold cards are deleted. The chain is the truth and
 * this is a projection of it, not a ledger that only grows.
 */
export async function syncMyCollection(
  deps: CollectionServiceDeps,
  auth: AuthContext,
): Promise<SyncResult> {
  const reader = deps.cardPack;
  if (!reader) {
    throw AppError.unavailable('Card ownership sync is not available on this deployment', {
      reason: 'card_pack_unconfigured',
    });
  }

  // The manifest is checked against the chain BEFORE any write. `cardCount` is
  // immutable in CardPack.sol, so a mismatch always means this service's card
  // index moved — which would map every token to the wrong card.
  assertMatchesChain(await reader.cardCount());

  // The address comes from the proven session identity, never from a request.
  const snapshot = await reader.holdingsOf(auth.address);

  const counts = new Map<string, number>();
  for (const token of snapshot.tokens) {
    // Throws on an index outside the manifest rather than inventing an id.
    const cardId = cardIdForIndex(token.cardIndex);
    counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  }

  const summary = await withTransaction((client: PoolClient) =>
    reconcileChainCards(client, { profileId: auth.profileId, counts }),
  );

  log().info('card_ownership_synced', {
    profile_id: auth.profileId,
    chain_contract: reader.contractAddress,
    block_number: snapshot.blockNumber,
    tokens_held: snapshot.tokens.length,
    tokens_transferred_away: snapshot.transferredAway,
    distinct_cards: summary.distinctCards,
    total_cards: summary.totalCards,
    cards_removed: summary.removedCards,
  });

  const cards: Record<string, number> = {};
  for (const [cardId, qty] of counts) cards[cardId] = qty;

  return {
    cards,
    distinct: summary.distinctCards,
    total: summary.totalCards,
    syncedAt: new Date().toISOString(),
    blockNumber: snapshot.blockNumber,
    transferredAway: snapshot.transferredAway,
    removed: summary.removedCards,
  };
}
