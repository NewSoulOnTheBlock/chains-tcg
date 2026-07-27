import { AppError, isUniqueViolation, query, queryOne, withTransaction } from '@chains/shared';

export interface DeckRow {
  id: string;
  name: string;
  cards: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface RawDeck {
  id: string;
  name: string;
  cards: unknown;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function toDeck(r: RawDeck): DeckRow {
  return {
    id: r.id,
    name: r.name,
    cards: Array.isArray(r.cards) ? (r.cards as unknown[]).map(String) : [],
    isActive: r.is_active,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT_COLS = `id::text, name, cards, is_active, created_at, updated_at`;

function nameTaken(): AppError {
  return AppError.conflict('You already have a deck with that name', {
    reason: 'deck_name_taken',
  });
}

/**
 * EVERY query below constrains on `profile_id = $auth` in the WHERE clause.
 * Ownership is never read from a body field and never checked in application
 * code after the fact — a row that is not yours simply does not match, so the
 * failure mode is "404 Deck not found", not "403 after we loaded it".
 */
export async function listDecks(profileId: string): Promise<DeckRow[]> {
  const { rows } = await query<RawDeck>(
    `SELECT ${SELECT_COLS} FROM core.decks
      WHERE profile_id = $1
      ORDER BY created_at ASC, id ASC`,
    [profileId],
  );
  return rows.map(toDeck);
}

export async function getDeck(profileId: string, deckId: string): Promise<DeckRow | null> {
  const r = await queryOne<RawDeck>(
    `SELECT ${SELECT_COLS} FROM core.decks WHERE id = $1 AND profile_id = $2`,
    [deckId, profileId],
  );
  return r ? toDeck(r) : null;
}

export async function createDeck(
  profileId: string,
  name: string,
  cards: string[],
): Promise<DeckRow> {
  try {
    return await withTransaction(async (c) => {
      const { rows } = await c.query<RawDeck>(
        `INSERT INTO core.decks (profile_id, name, cards)
         VALUES ($1, $2, $3::jsonb)
         RETURNING ${SELECT_COLS}`,
        [profileId, name, JSON.stringify(cards)],
      );
      const created = rows[0];
      if (!created) throw AppError.internal('deck insert returned no row');

      // The first deck a profile owns becomes the active one, so the game
      // service always has something to seat them with.
      const { rowCount } = await c.query(
        `UPDATE core.decks SET is_active = TRUE
          WHERE id = $2 AND profile_id = $1
            AND NOT EXISTS (SELECT 1 FROM core.decks WHERE profile_id = $1 AND is_active)`,
        [profileId, created.id],
      );
      return toDeck({ ...created, is_active: (rowCount ?? 0) > 0 });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

export async function updateDeck(
  profileId: string,
  deckId: string,
  patch: { name?: string; cards?: string[] },
): Promise<DeckRow> {
  const sets: string[] = [];
  const args: unknown[] = [deckId, profileId];
  if (patch.name !== undefined) {
    args.push(patch.name);
    sets.push(`name = $${args.length}`);
  }
  if (patch.cards !== undefined) {
    args.push(JSON.stringify(patch.cards));
    sets.push(`cards = $${args.length}::jsonb`);
  }
  if (sets.length === 0) {
    const existing = await getDeck(profileId, deckId);
    if (!existing) throw AppError.notFound('Deck not found');
    return existing;
  }
  sets.push('updated_at = now()');

  try {
    const updated = await queryOne<RawDeck>(
      `UPDATE core.decks SET ${sets.join(', ')}
        WHERE id = $1 AND profile_id = $2
        RETURNING ${SELECT_COLS}`,
      args,
    );
    if (!updated) throw AppError.notFound('Deck not found');
    return toDeck(updated);
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

export async function deleteDeck(profileId: string, deckId: string): Promise<void> {
  await withTransaction(async (c) => {
    const { rows } = await c.query<{ is_active: boolean }>(
      `DELETE FROM core.decks WHERE id = $1 AND profile_id = $2 RETURNING is_active`,
      [deckId, profileId],
    );
    const deleted = rows[0];
    if (!deleted) throw AppError.notFound('Deck not found');
    if (!deleted.is_active) return;
    // Promote the oldest survivor so the profile keeps an active deck.
    await c.query(
      `UPDATE core.decks SET is_active = TRUE
        WHERE id = (
          SELECT id FROM core.decks WHERE profile_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1
        )`,
      [profileId],
    );
  });
}

export async function activateDeck(profileId: string, deckId: string): Promise<DeckRow> {
  return withTransaction(async (c) => {
    // Clear then set, in one transaction: `core.decks` carries a partial unique
    // index on (profile_id) WHERE is_active, so the two statements must be
    // atomic or the second one violates it.
    await c.query(
      `UPDATE core.decks SET is_active = FALSE WHERE profile_id = $1 AND is_active AND id <> $2`,
      [profileId, deckId],
    );
    const { rows } = await c.query<RawDeck>(
      `UPDATE core.decks SET is_active = TRUE, updated_at = now()
        WHERE id = $1 AND profile_id = $2
        RETURNING ${SELECT_COLS}`,
      [deckId, profileId],
    );
    const r = rows[0];
    if (!r) throw AppError.notFound('Deck not found');
    return toDeck(r);
  });
}
