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
 */
export async function getOwnedQuantities(
  profileId: string,
  cardIds: readonly string[],
  c?: PoolClient,
): Promise<OwnedQuantities> {
  const owned = new Map<string, number>();
  if (cardIds.length === 0) return owned;

  const text = `SELECT card_id, qty
                  FROM core.card_ownership
                 WHERE profile_id = $1 AND card_id = ANY($2::text[])`;
  const params = [profileId, [...cardIds]];
  const { rows } = c
    ? await c.query<{ card_id: string; qty: number }>(text, params)
    : await query<{ card_id: string; qty: number }>(text, params);

  for (const r of rows) owned.set(r.card_id, Number(r.qty));
  return owned;
}
