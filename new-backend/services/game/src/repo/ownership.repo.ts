import { query, type PoolClient } from '@chains/shared';

/**
 * How many copies of each card a profile owns.
 *
 * `core.card_ownership` is the ONLY source of truth for this. The client keeps
 * a copy in `localStorage["ocva.collection.<name>"]`, but that copy is a display
 * cache and runs on the player's machine — it is never an input to a decision
 * here. A card absent from the returned map is owned zero times.
 */
export type OwnedQuantities = ReadonlyMap<string, number>;

/**
 * Owned quantities for `cardIds`, for one profile.
 *
 * ONE round trip for the whole decklist, never one per card: a join request
 * already holds a row lock on `game.matches`, and 60 sequential lookups inside
 * it would be both a latency floor and a cheap way to pin the pool.
 *
 * Pass `c` to read inside an open transaction — the join path checks ownership
 * under the same lock that claims the seat, so the answer cannot change between
 * the check and the claim.
 *
 * Rows with `qty = 0` are returned as 0, not dropped: per 0010, a row records
 * that a profile once held a card, and possession is `qty > 0`. Every caller
 * here compares quantities rather than testing for a row's existence, so a
 * spent-to-zero card reads exactly like one never owned.
 *
 * ── Why this SUMs ──────────────────────────────────────────────────────────
 * Since 0011 the primary key is (profile_id, card_id, SOURCE), so one card can
 * have two rows: `source = 'chain'` for tokens the player holds on the CardPack
 * ERC-721, `source = 'booster'` for cards a redemption granted. They are keyed
 * apart on purpose — the chain reconcile deletes what the address no longer
 * holds, and without the discriminator it would take booster cards with it.
 *
 * A player holding 2 copies on chain and 1 from a pack owns 3, and the SUM is
 * how that is spelled. Reading a bare `qty` here would return whichever row the
 * plan reached first, which under-reports ownership and refuses a ranked seat to
 * somebody who has paid for the cards twice over — a false negative on a paid
 * entitlement, which is worse than the false positive this module exists to
 * stop, because the player has no way to appeal it.
 *
 * `SUM()` returns numeric, which `pg` hands back as a string, hence the
 * `Number()` below — it was already there for bigint safety and now earns it.
 */
export async function getOwnedQuantities(
  profileId: string,
  cardIds: readonly string[],
  c?: PoolClient,
): Promise<OwnedQuantities> {
  const owned = new Map<string, number>();
  if (cardIds.length === 0) return owned;

  const text = `SELECT card_id, SUM(qty) AS qty
                  FROM core.card_ownership
                 WHERE profile_id = $1 AND card_id = ANY($2::text[])
                 GROUP BY card_id`;
  const params = [profileId, [...cardIds]];
  const { rows } = c
    ? await c.query<{ card_id: string; qty: string | number }>(text, params)
    : await query<{ card_id: string; qty: string | number }>(text, params);

  for (const r of rows) owned.set(r.card_id, Number(r.qty));
  return owned;
}
