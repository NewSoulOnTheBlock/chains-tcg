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
 * THE CONFLICT BETWEEN THEM, stated plainly: they share one `(profile_id,
 * card_id)` key, so a reconcile deletes anything `grantCards` added. That is
 * safe today only because the booster path cannot grant at all —
 * `BOOSTER_CARD_POOL` is empty by design and `minter.enabled` is false, so
 * `redeemTicket` never reaches `grantCards` on any deployment. Before the
 * booster product is switched on, the table needs a `source` discriminator so
 * the two can coexist; the exact DDL is in this change's report. Until then the
 * pool must stay empty.
 *
 * Both writers MUST run inside the caller's transaction (hence `PoolClient`, not
 * `Pool`). A booster that hands out card ids in one transaction and records
 * ownership in another can hand out cards nobody owns, and the failure is
 * silent.
 */
import type { Pool, PoolClient } from 'pg';

export interface OwnedCardRow {
  cardId: string;
  qty: number;
  updatedAt: Date;
}

interface RawOwnedCard {
  card_id: string;
  qty: number;
  updated_at: Date;
}

const OWNERSHIP_COLUMNS = `card_id, qty, updated_at`;

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
 * Add cards to a profile's collection.
 *
 * MUST be called inside the transaction that also records why the cards were
 * granted (the redemption row), so the two commit or roll back together.
 *
 * One statement regardless of pack size: the tallied ids travel as two parallel
 * arrays through `unnest`, so a 30-card pack is a single round trip rather than
 * 30 while the ticket row is held under `FOR UPDATE`.
 */
export async function grantCards(
  client: PoolClient,
  input: { profileId: string; cardIds: readonly string[] },
): Promise<GrantSummary> {
  const tallied = tallyCardIds(input.cardIds);
  if (tallied.length === 0) return { distinctCards: 0, totalCards: 0 };

  await client.query(
    `INSERT INTO core.card_ownership (profile_id, card_id, qty)
     SELECT $1::bigint, g.card_id, g.qty
       FROM unnest($2::text[], $3::int[]) AS g(card_id, qty)
     ON CONFLICT (profile_id, card_id)
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
 */
export async function reconcileChainCards(
  client: PoolClient,
  input: { profileId: string; counts: ReadonlyMap<string, number> },
): Promise<ReconcileSummary> {
  const cardIds = [...input.counts.keys()];
  const quantities = cardIds.map((id) => input.counts.get(id)!);

  const removed = await client.query(
    `DELETE FROM core.card_ownership
      WHERE profile_id = $1::bigint AND NOT (card_id = ANY($2::text[]))`,
    [input.profileId, cardIds],
  );

  if (cardIds.length > 0) {
    await client.query(
      `INSERT INTO core.card_ownership (profile_id, card_id, qty)
       SELECT $1::bigint, g.card_id, g.qty
         FROM unnest($2::text[], $3::int[]) AS g(card_id, qty)
       ON CONFLICT (profile_id, card_id)
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

/**
 * When this profile's collection was last written.
 *
 * Derived from `max(updated_at)` because the agreed table carries no snapshot
 * row. That is enough to answer "is this stale?" but NOT "as of which block?",
 * and it is null for a profile that owns nothing. A dedicated sync-state table
 * is requested in this change's report; seating cannot reason about block-level
 * staleness until it exists.
 */
export async function lastSyncedAt(
  q: Pool | PoolClient,
  profileId: string,
): Promise<Date | null> {
  const { rows } = await q.query<{ at: Date | null }>(
    `SELECT max(updated_at) AS at FROM core.card_ownership WHERE profile_id = $1`,
    [profileId],
  );
  return rows[0]?.at ?? null;
}

/**
 * Everything one profile owns.
 *
 * Only ever called with the AUTHENTICATED profile id (H-2). There is no
 * "collection by wallet address" function here, and there must never be one —
 * the legacy `GET /api/boosters/tickets/:wallet` was exactly that shape.
 *
 * Rows at `qty = 0` are filtered out rather than reported as owning zero: the
 * table's check constraint allows the value, so a future decrementing caller
 * cannot make this read start emitting phantom entries.
 */
export async function listOwnedCards(
  q: Pool | PoolClient,
  profileId: string,
): Promise<OwnedCardRow[]> {
  const { rows } = await q.query<RawOwnedCard>(
    `SELECT ${OWNERSHIP_COLUMNS} FROM core.card_ownership
      WHERE profile_id = $1 AND qty > 0
      ORDER BY card_id ASC`,
    [profileId],
  );
  return rows.map(mapOwnedCard);
}
