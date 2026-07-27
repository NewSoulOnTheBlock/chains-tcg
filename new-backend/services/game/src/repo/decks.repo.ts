import { queryOne } from '@chains/shared';

export interface ActiveDeck {
  id: string;
  name: string;
  cards: string[];
}

/**
 * Read a profile's ACTIVE deck. The game service attaches decks to a match
 * itself, at seat time, from this table — the client never sends a decklist and
 * therefore can never send a stacked one, nor see the opponent's.
 */
export async function getActiveDeck(profileId: string): Promise<ActiveDeck | null> {
  const r = await queryOne<{ id: string; name: string; cards: unknown }>(
    `SELECT id::text, name, cards
       FROM core.decks
      WHERE profile_id = $1 AND is_active
      LIMIT 1`,
    [profileId],
  );
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    cards: Array.isArray(r.cards) ? (r.cards as unknown[]).map(String) : [],
  };
}
