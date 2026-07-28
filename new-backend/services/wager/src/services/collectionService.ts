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
 *   `getMyCollection`  reads the stored snapshot. Cheap, one extra index read.
 *   `syncMyCollection` re-derives the snapshot from chain state and replaces it.
 *
 * ── ONE PROFILE, SEVERAL WALLETS ───────────────────────────────────────────
 *
 * A profile is no longer one address. Account abstraction sign-in comes with
 * account linking, so a player who minted booster packs with MetaMask and then
 * signed in with an email-backed smart account must still own their cards. The
 * addresses come from `core.profile_addresses` for the AUTHENTICATED profile id
 * — see `collectionAddresses.ts` — and never from a request body, a query
 * string or a path segment. Identity is proven at login and the collection is
 * always the caller's; accepting an address from a request would recreate audit
 * finding H-2, where anyone could read anyone's holdings by knowing their
 * wallet.
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
import { assertSyncable, resolveCollectionAddresses } from './collectionAddresses.js';

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
  /**
   * The caller's OWN wallets that chain ownership is derived from — every
   * address linked to this profile on the chain CardPack lives on, lowercased
   * and sorted. Additive; no existing client reads it.
   *
   * On `POST /wager/collection/sync` this is exactly the set that was
   * enumerated. On `GET /wager/collection` it is the set a sync WOULD cover
   * right now, which is not necessarily the set the stored snapshot came from:
   * linking a wallet changes this list immediately and changes `cards` only at
   * the next sync. That gap is the useful signal — a client can compare it
   * against what it last synced and prompt — but it is a gap, and closing it
   * properly needs a column on `core.card_ownership_sync` that this service is
   * not allowed to add (see the note on `recordSync` below).
   *
   * Empty on a deployment with no CardPack contract configured: nothing there
   * derives ownership from a chain at all.
   */
  addresses: string[];
  /**
   * Linked wallets on OTHER chains, which cannot hold a CardPack token and are
   * therefore not enumerated. A count, not a list — the client's use for it is
   * "2 of your wallets are not on this chain", and the addresses themselves are
   * already in `addresses` when they are relevant.
   */
  addressesSkipped: number;
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

/**
 * Only ever the caller's own collection. There is no "collection by wallet"
 * route, and `deps` is here for the contract's chain id, not to read it.
 *
 * This does NOT apply `assertSyncable`. Its refusals exist to stop a
 * destructive reconcile running against an address list that cannot be trusted;
 * rendering already-stored rows is harmless in both of those states, and a read
 * route that 503s on a misconfiguration takes the collection screen down for a
 * problem only the sync has.
 */
export async function getMyCollection(
  deps: CollectionServiceDeps,
  auth: AuthContext,
): Promise<CollectionView> {
  const rows = await listOwnedCards(getPool(), auth.profileId);
  const state = await readSyncState(getPool(), auth.profileId);
  const plan = deps.cardPack
    ? await resolveCollectionAddresses(auth, deps.cardPack.chainId)
    : null;
  return {
    ...viewOf(rows),
    synced: state !== null,
    syncedAt: state ? state.syncedAt.toISOString() : null,
    syncedBlock: state ? state.blockNumber : null,
    addresses: plan ? plan.addresses : [],
    addressesSkipped: plan ? plan.skipped.reduce((n, s) => n + s.count, 0) : 0,
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
  /**
   * Tokens the profile's addresses once received but no longer hold, summed
   * across every address enumerated.
   */
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
 *   2. resolve WHICH WALLETS this profile owns cards through, and refuse rather
 *      than reconcile if that list cannot be trusted,
 *   3. enumerate holdings for every one of them (complete, or an exception —
 *      never partial), and union the result,
 *   4. resolve indexes to card ids, failing closed on an unknown index,
 *   5. reconcile, record the sync, and re-read the merged collection, in ONE
 *      transaction.
 *
 * ── UNION FIRST, THEN EXACTLY ONE RECONCILE ────────────────────────────────
 *
 * Step 5 is destructive: every chain-sourced card absent from what it is handed
 * is DELETED. So the per-address loop in step 3 accumulates into a single
 * `counts` map and the reconcile runs ONCE, for the profile.
 *
 * Reconciling per address would be the obvious shape and it is a data-loss bug.
 * Address A's pass would hand the reconcile only A's cards, deleting everything
 * held by B; B's pass would then delete everything held by A. A player with two
 * linked wallets would end each sync owning whichever wallet happened to be
 * enumerated last, and the loss is silent — the response would look like a
 * successful sync of a smaller collection. There is no per-address partition in
 * `core.card_ownership` to reconcile inside, and adding one would be the wrong
 * fix: ownership is a fact about the PROFILE, so the snapshot that replaces it
 * has to be a fact about the profile too.
 *
 * ── PARTIAL ENUMERATION ABORTS THE WHOLE SYNC ──────────────────────────────
 *
 * The loop does not catch. `CardPackReader` already throws rather than returning
 * a short list when a log window fails, precisely because a truncated read is
 * indistinguishable from a player who sold everything; the same reasoning
 * applies one level up. If address B's enumeration fails, the union is missing
 * B's cards, and reconciling it deletes them. So one address failing fails the
 * sync, nothing is written, and the previous snapshot — including its block
 * pointer — stays exactly as it was. An incomplete answer is never written
 * down.
 *
 * ── WHICH BLOCK THE SNAPSHOT CLAIMS ────────────────────────────────────────
 *
 * Each address is enumerated against its own head block, so a multi-address
 * sync has several. The recorded one is the MINIMUM. The snapshot is a single
 * claim about the whole profile, and the strongest claim it can honestly make
 * is bounded by its oldest component: reporting the maximum would tell a
 * staleness check that the collection is fresher than the earliest read
 * actually supports. With one address, minimum and maximum are the same number
 * and nothing changes.
 *
 * ── TOKEN IDS ARE DE-DUPLICATED ────────────────────────────────────────────
 *
 * An ERC-721 token has exactly one owner, so the same token cannot appear under
 * two addresses of the same profile and a plain sum would already be correct.
 * It is de-duplicated anyway, because the cost is a `Set` and the failure it
 * covers is silent: one wallet linked under two chain slugs that both resolve
 * to this chain id would be enumerated twice, doubling every quantity it holds
 * and handing a player a playset they do not own. `collectionAddresses` also
 * de-duplicates the addresses themselves; this is the second net, and it counts
 * what it caught.
 *
 * Step 5 is a full reconcile of the `source = 'chain'` rows: sold cards are
 * deleted. The chain is the truth and this is a projection of it, not a ledger
 * that only grows. Booster-granted rows are a different partition and are left
 * alone — they were never on chain, so their absence from a chain snapshot means
 * nothing (0011), and they are not tied to any wallet, so widening the wallet
 * set does not touch them.
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

  // Every wallet linked to the AUTHENTICATED profile, from the database. Never
  // an address the caller supplied, and never only the one they signed in with.
  const plan = await resolveCollectionAddresses(auth, reader.chainId);
  // Refuses instead of reconciling when the list cannot be trusted. Before the
  // write, like every other guard on this path.
  assertSyncable(plan, reader.chainId);

  const counts = new Map<string, number>();
  const seenTokens = new Set<string>();
  let blockNumber = Number.POSITIVE_INFINITY;
  let tokensHeld = 0;
  let transferredAway = 0;
  let duplicateTokens = 0;

  // SEQUENTIAL, not `Promise.all`. Each `holdingsOf` is already internally
  // concurrent against a public endpoint this project does not operate, and a
  // rejected member of a fan-out leaves its siblings running with nobody
  // waiting on them. Profiles have a handful of addresses, not hundreds.
  for (const address of plan.addresses) {
    // Deliberately not caught. A failure here means the union is missing this
    // address's cards, and the reconcile below deletes everything the union
    // omits — so the whole sync fails and the previous snapshot stands.
    const snapshot = await reader.holdingsOf(address);
    blockNumber = Math.min(blockNumber, snapshot.blockNumber);
    transferredAway += snapshot.transferredAway;

    for (const token of snapshot.tokens) {
      const tokenKey = token.tokenId.toString();
      if (seenTokens.has(tokenKey)) {
        duplicateTokens += 1;
        continue;
      }
      seenTokens.add(tokenKey);
      // Throws on an index outside the manifest rather than inventing an id.
      const cardId = cardIdForIndex(token.cardIndex);
      counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
      tokensHeld += 1;
    }
  }

  // Unreachable while `assertSyncable` holds — it refuses an empty list — but
  // the recorded block must never be `Infinity`, and a head read is cheaper
  // than a lie about which block a snapshot is true as of.
  if (!Number.isFinite(blockNumber)) blockNumber = await reader.getBlockNumber();

  const outcome = await withTransaction(async (client: PoolClient) => {
    // ONE reconcile, for the profile, against the UNION. Running this per
    // address would delete each address's cards on the next address's pass.
    const summary = await reconcileChainCards(client, { profileId: auth.profileId, counts });
    const syncedAt = await recordSync(client, {
      profileId: auth.profileId,
      // The CONTRACT, not a player wallet — and note that this is why widening
      // a sync from one address to several needs no schema change here. The
      // column never held the wallet: `core.card_ownership_sync.address` is
      // documented in 0011 as the CardPack contract, because repointing
      // CARD_PACK_ADDRESS makes every stored snapshot a statement about a
      // different collection, while the wallet was already in core.profiles.
      // So there is no "first address" being silently recorded here; there is
      // no address of the player's recorded here at all.
      address: reader.contractAddress,
      chainId: reader.chainId,
      blockNumber,
      // Tokens held across EVERY address enumerated, after de-duplication.
      // Still reconciles against a block explorer, just against as many wallet
      // pages as `addresses` names.
      tokenCount: tokensHeld,
    });
    const rows = await listOwnedCards(client, auth.profileId);
    return { summary, syncedAt, rows };
  });

  const { summary } = outcome;

  log().info('card_ownership_synced', {
    profile_id: auth.profileId,
    chain_contract: reader.contractAddress,
    chain_id: reader.chainId,
    block_number: blockNumber,
    // Counts, not the wallets themselves: this is an info-level line.
    addresses: plan.addresses.length,
    address_source: plan.source,
    addresses_skipped: plan.skipped.map((s) => `${s.chain}:${s.count}`),
    tokens_held: tokensHeld,
    tokens_transferred_away: transferredAway,
    duplicate_tokens: duplicateTokens,
    distinct_cards: summary.distinctCards,
    total_cards: summary.totalCards,
    cards_removed: summary.removedCards,
  });

  return {
    ...viewOf(outcome.rows),
    synced: true,
    syncedAt: outcome.syncedAt.toISOString(),
    syncedBlock: blockNumber,
    blockNumber,
    transferredAway,
    removed: summary.removedCards,
    addresses: plan.addresses,
    addressesSkipped: plan.skipped.reduce((n, s) => n + s.count, 0),
  };
}
