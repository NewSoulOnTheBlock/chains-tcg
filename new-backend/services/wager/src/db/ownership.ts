/**
 * Card ownership persistence.
 *
 * `core.card_ownership` is the single source of truth for who owns which cards.
 * The client keeps a `localStorage` copy, but only as a display cache — it is
 * never an input to a decision, because it runs on the player's machine and can
 * be edited from devtools. With a prize attached, that edit is the highest-value
 * attack in the product, so the server never reads the client's copy.
 *
 * There are two writers, and they have deliberately different shapes:
 *
 *  `grantCards`           ADDITIVE (`qty = qty + n`). A booster redemption gave
 *                         the player something; nothing was taken away.
 *  `reconcileChainCards`  AUTHORITATIVE (`qty = n`, plus DELETE of anything
 *                         absent). The CardPack NFTs are tradeable, so the chain
 *                         is not a growing ledger — a player can mint, sync,
 *                         sell, and must not keep the cards. An additive sync
 *                         would make "sell your collection and keep playing it"
 *                         the cheapest exploit in the product.
 *
 * THE CONFLICT BETWEEN THEM, resolved by 0011: they used to share one
 * `(profile_id, card_id)` key, so a reconcile deleted anything `grantCards`
 * added — silent loss of a paid item, dormant only because `BOOSTER_CARD_POOL`
 * is empty and `minter.enabled` is false. The primary key is now
 * `(profile_id, card_id, SOURCE)`, and each writer works exclusively inside its
 * own partition:
 *
 *   `grantCards`          writes and owns `source = 'booster'`,
 *   `reconcileChainCards` writes, and DELETES, only `source = 'chain'`.
 *
 * Every write and every DELETE in this file is scoped to one `source`. That
 * scoping is the whole safety property: drop it from the DELETE and the sell
 * exploit closes but the booster bug reopens; drop it from an INSERT and the
 * cards land in the other writer's partition, where the next sync removes them.
 *
 * The cost lands on readers, and it is not optional: there can be TWO ROWS per
 * (profile_id, card_id), so ownership is `SUM(qty)` grouped by card_id — never a
 * bare `qty`, and still never `EXISTS (...)`. `listOwnedCards` below and the
 * game service's `getOwnedQuantities` are the two readers that exist.
 *
 * Both writers MUST run inside the caller's transaction (hence `PoolClient`, not
 * `Pool`). A booster that hands out card ids in one transaction and records
 * ownership in another can hand out cards nobody owns, and the failure is
 * silent. `recordSync` runs under the same rule for the same reason.
 */
import type { Pool, PoolClient } from 'pg';

/**
 * One card a profile owns, TOTALLED ACROSS SOURCES.
 *
 * There is deliberately no `source` field. A caller that branched on where a
 * card came from would be asking a question the product does not have: a card
 * plays the same whether it was minted or pulled from a pack. `source` exists to
 * keep two writers from deleting each other's rows, not to be read back.
 */
export interface OwnedCardRow {
  cardId: string;
  qty: number;
  /** Most recent write across this card's sources. */
  updatedAt: Date;
}

interface RawOwnedCard {
  card_id: string;
  qty: number;
  updated_at: Date;
}

function mapOwnedCard(row: RawOwnedCard): OwnedCardRow {
  return { cardId: row.card_id, qty: row.qty, updatedAt: row.updated_at };
}

export interface GrantSummary {
  /** Rows touched — one per distinct card id. */
  distinctCards: number;
  /** Cards granted, counting duplicates. */
  totalCards: number;
}

/**
 * Collapse a rolled pack into one entry per DISTINCT card id.
 *
 * A pack rolls with replacement (`domain/packRoll.ts` picks `pool[n % len]`
 * independently 30 times), so the same id appears more than once routinely —
 * with an 80-card pool it is the common case, not the edge case. Postgres
 * refuses `ON CONFLICT DO UPDATE` when one statement presents the same conflict
 * key twice ("ON CONFLICT DO UPDATE command cannot affect row a second time"),
 * so duplicates have to become quantities BEFORE they reach the database.
 *
 * Insertion order is preserved, which keeps the emitted SQL parameters stable
 * for a given roll and therefore reproducible for support.
 */
export function tallyCardIds(cardIds: readonly string[]): Array<{ cardId: string; qty: number }> {
  const counts = new Map<string, number>();
  for (const id of cardIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts].map(([cardId, qty]) => ({ cardId, qty }));
}

/**
 * Add cards to a profile's collection, as `source = 'booster'`.
 *
 * MUST be called inside the transaction that also records why the cards were
 * granted (the redemption row), so the two commit or roll back together.
 *
 * One statement regardless of pack size: the tallied ids travel as two parallel
 * arrays through `unnest`, so a 30-card pack is a single round trip rather than
 * 30 while the ticket row is held under `FOR UPDATE`.
 *
 * `source` is written explicitly rather than left to the column DEFAULT. The
 * default is `'chain'` — the conservative landing spot for a forgetful INSERT,
 * because the reconcile is authoritative over that partition — so a grant that
 * omitted the column would file the player's paid cards where the next sync
 * deletes them. Naming it here is what makes that impossible.
 */
export async function grantCards(
  client: PoolClient,
  input: { profileId: string; cardIds: readonly string[] },
): Promise<GrantSummary> {
  const tallied = tallyCardIds(input.cardIds);
  if (tallied.length === 0) return { distinctCards: 0, totalCards: 0 };

  await client.query(
    `INSERT INTO core.card_ownership (profile_id, card_id, qty, source)
     SELECT $1::bigint, g.card_id, g.qty, 'booster'
       FROM unnest($2::text[], $3::int[]) AS g(card_id, qty)
     ON CONFLICT (profile_id, card_id, source)
       DO UPDATE SET qty = core.card_ownership.qty + excluded.qty,
                     updated_at = now()`,
    [
      input.profileId,
      tallied.map((t) => t.cardId),
      tallied.map((t) => t.qty),
    ],
  );

  return { distinctCards: tallied.length, totalCards: input.cardIds.length };
}

export interface ReconcileSummary {
  /** Distinct card ids the chain says the profile holds. */
  distinctCards: number;
  /** Cards held in total, counting duplicates. */
  totalCards: number;
  /** Rows deleted because the profile no longer holds that card at all. */
  removedCards: number;
}

/**
 * Replace a profile's collection with exactly what the chain reports.
 *
 * `counts` is the COMPLETE holdings set. Callers must never pass a partial
 * enumeration: everything absent from it is deleted, so an incomplete snapshot
 * destroys holdings rather than merely under-reporting them. `CardPackReader`
 * throws rather than returning a partial answer for exactly this reason.
 *
 * Two statements, one transaction: delete what is gone, then upsert what is
 * held. The delete runs first so a card whose quantity dropped to zero and a
 * card that was never held take the same path.
 *
 * DELETE, not `qty = 0`, and that is a deliberate departure from 0010's comment
 * about keeping a zero row as an audit breadcrumb. The breadcrumb is worth
 * having, but it is only safe while every reader spells ownership `qty > 0`;
 * one future reader writing `EXISTS (...)` turns every sold card back into a
 * playable one. Against a prize, absence is the fail-safe encoding, and the
 * breadcrumb now lives in `core.card_ownership_sync` (0011) where it belongs.
 *
 * SCOPED TO `source = 'chain'`, on both statements. Without it on the DELETE,
 * this function reaches into the booster partition and removes cards a player
 * paid for, because they are by construction absent from a list of tokens the
 * chain reports — cards that were never on chain cannot appear in a chain
 * snapshot. That is the bug 0011 exists to prevent, and this WHERE clause is
 * where it is actually prevented.
 */
export async function reconcileChainCards(
  client: PoolClient,
  input: { profileId: string; counts: ReadonlyMap<string, number> },
): Promise<ReconcileSummary> {
  const cardIds = [...input.counts.keys()];
  const quantities = cardIds.map((id) => input.counts.get(id)!);

  const removed = await client.query(
    `DELETE FROM core.card_ownership
      WHERE profile_id = $1::bigint
        AND source = 'chain'
        AND NOT (card_id = ANY($2::text[]))`,
    [input.profileId, cardIds],
  );

  if (cardIds.length > 0) {
    await client.query(
      `INSERT INTO core.card_ownership (profile_id, card_id, qty, source)
       SELECT $1::bigint, g.card_id, g.qty, 'chain'
         FROM unnest($2::text[], $3::int[]) AS g(card_id, qty)
       ON CONFLICT (profile_id, card_id, source)
         DO UPDATE SET qty = excluded.qty, updated_at = now()`,
      [input.profileId, cardIds, quantities],
    );
  }

  return {
    distinctCards: cardIds.length,
    totalCards: quantities.reduce((a, b) => a + b, 0),
    removedCards: removed.rowCount ?? 0,
  };
}

/** One profile's chain-sync state — `core.card_ownership_sync`, 0011. */
export interface SyncState {
  /** The CardPack contract the snapshot came from, lowercased. */
  address: string;
  /** EIP-155 chain it was read on. */
  chainId: number;
  /** Head block the snapshot is true as of. */
  blockNumber: number;
  /** Tokens held at that block, before folding duplicates into quantities. */
  tokenCount: number;
  syncedAt: Date;
}

interface RawSyncState {
  address: string;
  chain_id: number;
  block_number: string;
  token_count: number;
  synced_at: Date;
}

/**
 * Record that a chain sync completed.
 *
 * MUST run in the same transaction as the `reconcileChainCards` it describes, or
 * it can claim a block whose card rows were rolled back — a snapshot pointer to
 * data that does not exist.
 *
 * `block_number` is bigint in the database and travels as a string because `pg`
 * refuses to guess about precision. Block heights outgrow 2^31 and `int` was
 * never an option; `number` survives to 2^53 and the JS side stays comfortable.
 */
export async function recordSync(
  client: PoolClient,
  input: {
    profileId: string;
    address: string;
    chainId: number;
    blockNumber: number;
    tokenCount: number;
  },
): Promise<Date> {
  const { rows } = await client.query<{ synced_at: Date }>(
    `INSERT INTO core.card_ownership_sync
       (profile_id, address, chain_id, block_number, token_count, synced_at)
     VALUES ($1::bigint, $2, $3, $4::bigint, $5, now())
     ON CONFLICT (profile_id) DO UPDATE
       SET address      = excluded.address,
           chain_id     = excluded.chain_id,
           block_number = excluded.block_number,
           token_count  = excluded.token_count,
           synced_at    = excluded.synced_at
     RETURNING synced_at`,
    [
      input.profileId,
      input.address.toLowerCase(),
      input.chainId,
      String(input.blockNumber),
      input.tokenCount,
    ],
  );
  return rows[0]!.synced_at;
}

/**
 * This profile's sync state, or null if it has NEVER synced.
 *
 * The null is the point. Before 0011 this was `max(updated_at)` over the
 * ownership rows, which is also null for a profile that synced and holds
 * nothing — so "we have never looked at your wallet" and "we looked, and you
 * hold nothing" were the same answer. They call for opposite product
 * behaviour: one is a prompt to sync, the other is an empty collection. Telling
 * a player who has never synced that they own no cards is the server asserting
 * something false about their property, immediately before refusing them a
 * ranked seat over it.
 *
 * Here the row's EXISTENCE carries that fact, and it is written on every
 * successful sync regardless of how many cards were found.
 */
export async function readSyncState(
  q: Pool | PoolClient,
  profileId: string,
): Promise<SyncState | null> {
  const { rows } = await q.query<RawSyncState>(
    `SELECT address, chain_id, block_number, token_count, synced_at
       FROM core.card_ownership_sync
      WHERE profile_id = $1`,
    [profileId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    address: row.address,
    chainId: row.chain_id,
    blockNumber: Number(row.block_number),
    tokenCount: row.token_count,
    syncedAt: row.synced_at,
  };
}

/**
 * Everything one profile owns, ACROSS SOURCES.
 *
 * Only ever called with the AUTHENTICATED profile id (H-2). There is no
 * "collection by wallet address" function here, and there must never be one —
 * the legacy `GET /api/boosters/tickets/:wallet` was exactly that shape.
 *
 * `SUM(qty) GROUP BY card_id` because 0011 keys the table on
 * (profile_id, card_id, source): a card held 2× on chain and 1× from a pack is
 * two rows and is owned 3 times. A bare `qty` would return one of the two rows
 * and under-report the player's own collection back to them.
 *
 * `HAVING SUM(qty) > 0` and not `WHERE qty > 0`. Under the current CHECK
 * (`qty >= 0`) the two agree on every possible row, so this is not a bug fix —
 * it is putting the predicate where the definition lives. Ownership is a
 * statement about the TOTAL, so it is tested on the total; a pre-aggregate
 * filter only happens to give the same answer because no partition can hold a
 * negative. If a spend or burn path ever relaxes that constraint, this query
 * keeps meaning what it says and the other one starts reporting a player as
 * owning cards their net position does not include.
 */
export async function listOwnedCards(
  q: Pool | PoolClient,
  profileId: string,
): Promise<OwnedCardRow[]> {
  const { rows } = await q.query<RawOwnedCard>(
    `SELECT card_id, SUM(qty)::int AS qty, max(updated_at) AS updated_at
       FROM core.card_ownership
      WHERE profile_id = $1
      GROUP BY card_id
     HAVING SUM(qty) > 0
      ORDER BY card_id ASC`,
    [profileId],
  );
  return rows.map(mapOwnedCard);
}
