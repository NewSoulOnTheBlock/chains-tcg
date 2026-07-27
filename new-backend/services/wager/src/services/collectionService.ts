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
import {
  listOwnedCards,
  readSyncState,
  reconcileChainCards,
  recordSync,
  type OwnedCardRow,
} from '../db/ownership.js';
import { assertMatchesChain, cardIdForIndex } from '../nft/cardCatalogue.js';
import type { CardPackReader } from '../chain/cardPackReader.js';

export interface CollectionServiceDeps {
  /** Null when no CardPack contract is configured — sync is then unavailable. */
  cardPack: CardPackReader | null;
}

/**
 * What the caller owns, and whether the server has ever looked.
 *
 * THE `synced` FLAG IS NOT DECORATION. An empty `cards` means two different
 * things, and the difference is the difference between two messages to the
 * player:
 *
 *   `synced: false`  the server has never enumerated this wallet. The honest
 *                    thing to say is "sync your collection". Saying "you own no
 *                    cards" here is the server asserting something false about
 *                    the player's property, typically right before refusing
 *                    them a ranked seat over it.
 *   `synced: true`   the server enumerated the wallet and it held nothing. Now
 *                    "you own no cards" is true, and prompting for another sync
 *                    is just noise.
 *
 * Before 0011 these were indistinguishable — `syncedAt` came from
 * `max(updated_at)` over the ownership rows, which is null in both cases.
 *
 * BACKWARD COMPATIBILITY: `cards`, `distinct`, `total` and `syncedAt` keep their
 * names, types and meanings; `synced` and `syncedBlock` are additive. The only
 * change a existing client can observe is that `syncedAt` is now null in
 * strictly fewer cases — it was already null for a synced-but-empty profile, and
 * now it is not.
 */
export interface CollectionView {
  /** Card id → quantity owned, summed across chain and booster rows. Absent, never zero. */
  cards: Record<string, number>;
  /** Distinct card ids owned. */
  distinct: number;
  /** Cards owned in total, counting duplicates. */
  total: number;
  /**
   * Whether a chain sync has EVER completed for this profile.
   *
   * Read from the existence of the profile's `core.card_ownership_sync` row,
   * which is written on every successful sync whether or not it found any
   * cards. This is the field to branch on; the two timestamps below are for
   * display.
   */
  synced: boolean;
  /**
   * When the last successful sync committed, ISO-8601, or null if there has
   * never been one. Null now means exactly `synced === false`.
   */
  syncedAt: string | null;
  /**
   * Head block that snapshot is true as of, or null if never synced.
   *
   * The chain's own clock. `syncedAt` answers "how long ago by our clock",
   * which nothing on chain can be compared against; this one composes with
   * re-orgs, a lagging RPC endpoint, and any second reader.
   */
  syncedBlock: number | null;
}

/** Fold owned rows into the wire shape. Shared so sync and read cannot drift. */
function viewOf(rows: readonly OwnedCardRow[]): Pick<CollectionView, 'cards' | 'distinct' | 'total'> {
  const cards: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    cards[row.cardId] = row.qty;
    total += row.qty;
  }
  return { cards, distinct: rows.length, total };
}

/** Only ever the caller's own collection. There is no "collection by wallet" route. */
export async function getMyCollection(auth: AuthContext): Promise<CollectionView> {
  const rows = await listOwnedCards(getPool(), auth.profileId);
  const state = await readSyncState(getPool(), auth.profileId);
  return {
    ...viewOf(rows),
    synced: state !== null,
    syncedAt: state ? state.syncedAt.toISOString() : null,
    syncedBlock: state ? state.blockNumber : null,
  };
}

export interface SyncResult extends CollectionView {
  /**
   * Head block the snapshot was taken at.
   *
   * Always equal to `syncedBlock` on a successful sync. Kept under its original
   * name because clients already read it, and this response predates
   * `syncedBlock` existing on the shared view.
   */
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
 *   4. reconcile, record the sync, and re-read the merged collection, in ONE
 *      transaction.
 *
 * Step 4 is a full reconcile of the `source = 'chain'` rows: sold cards are
 * deleted. The chain is the truth and this is a projection of it, not a ledger
 * that only grows. Booster-granted rows are a different partition and are left
 * alone — they were never on chain, so their absence from a chain snapshot means
 * nothing (0011).
 *
 * The sync-state row is written INSIDE that transaction, not after it. Written
 * after, a crash between commit and update leaves the collection replaced and
 * the snapshot pointer claiming an older block — or, on a first sync, claiming
 * the player has never synced while their cards sit in the table.
 *
 * The returned collection is RE-READ rather than assembled from `counts`.
 * `counts` is the chain half only; a player with booster cards owns more than it
 * describes, and returning it would make a sync response contradict the very
 * next `GET /wager/collection`.
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

  const outcome = await withTransaction(async (client: PoolClient) => {
    const summary = await reconcileChainCards(client, { profileId: auth.profileId, counts });
    const syncedAt = await recordSync(client, {
      profileId: auth.profileId,
      // The CONTRACT, not the player's wallet: the wallet is already
      // `core.profiles.address` and cannot change for a profile, whereas
      // repointing CARD_PACK_ADDRESS makes every stored snapshot a statement
      // about a different collection.
      address: reader.contractAddress,
      chainId: reader.chainId,
      blockNumber: snapshot.blockNumber,
      tokenCount: snapshot.tokens.length,
    });
    const rows = await listOwnedCards(client, auth.profileId);
    return { summary, syncedAt, rows };
  });

  const { summary } = outcome;

  log().info('card_ownership_synced', {
    profile_id: auth.profileId,
    chain_contract: reader.contractAddress,
    chain_id: reader.chainId,
    block_number: snapshot.blockNumber,
    tokens_held: snapshot.tokens.length,
    tokens_transferred_away: snapshot.transferredAway,
    distinct_cards: summary.distinctCards,
    total_cards: summary.totalCards,
    cards_removed: summary.removedCards,
  });

  return {
    ...viewOf(outcome.rows),
    synced: true,
    syncedAt: outcome.syncedAt.toISOString(),
    syncedBlock: snapshot.blockNumber,
    blockNumber: snapshot.blockNumber,
    transferredAway: snapshot.transferredAway,
    removed: summary.removedCards,
  };
}
