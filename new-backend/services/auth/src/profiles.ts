/**
 * Profile lookup and first-login creation.
 *
 * `core.profiles` carries `unique (address, chain)` and `display_name citext
 * unique`. Both are enforced by the database, so two simultaneous first logins
 * for the same wallet resolve to one profile rather than two, and a duplicate
 * display name is impossible regardless of application logic.
 */
import { randomBytes } from 'node:crypto';
import { isUniqueViolation, query, withTransaction } from '@chains/shared';

export interface ProfileRow {
  /** bigint, rendered as a string so large ids never lose precision in JSON. */
  id: string;
  address: string;
  chain: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  wins: number;
  losses: number;
}

const COLS = 'id::text as id, address, chain, display_name, avatar_url, bio, wins, losses';

export async function findProfileById(id: string): Promise<ProfileRow | undefined> {
  const res = await query<ProfileRow>(`select ${COLS} from core.profiles where id = $1::bigint`, [id]);
  return res.rows[0];
}

/** Candidate display names, most desirable first. */
function displayNameCandidates(address: string): string[] {
  const base = shortName(address);
  const out = [base];
  for (let i = 2; i <= 6; i += 1) out.push(`${base}-${i}`);
  // Practically unreachable, but the loop must terminate on something unique.
  for (let i = 0; i < 4; i += 1) out.push(`${base}-${randomBytes(3).toString('hex')}`);
  return out;
}

/**
 * `0x1234…9abc` / `7Xk2…q4Rt`. Uses U+2026 rather than "..." so the name stays
 * inside the 32-character display-name limit and reads as one token.
 */
function shortName(address: string): string {
  if (address.length <= 11) return address;
  const head = address.startsWith('0x') ? address.slice(0, 6) : address.slice(0, 4);
  return `${head}…${address.slice(-4)}`;
}

/**
 * Return the profile for (address, chain), creating it on first sign-in.
 *
 * Each insert attempt runs inside its own SAVEPOINT: a `display_name`
 * unique-violation aborts only that savepoint, leaving the transaction usable
 * for the next candidate. Without this, the first collision would poison the
 * whole transaction.
 */
export async function findOrCreateProfile(
  address: string,
  chain: string,
): Promise<{ profile: ProfileRow; created: boolean }> {
  return withTransaction(async (tx) => {
    const existing = await tx.query<ProfileRow>(
      `select ${COLS} from core.profiles where address = $1 and chain = $2`,
      [address, chain],
    );
    const found = existing.rows[0];
    if (found) return { profile: found, created: false };

    for (const candidate of displayNameCandidates(address)) {
      await tx.query('SAVEPOINT profile_insert');
      try {
        const inserted = await tx.query<ProfileRow>(
          `insert into core.profiles (address, chain, display_name)
           values ($1, $2, $3)
           on conflict (address, chain) do nothing
           returning ${COLS}`,
          [address, chain, candidate],
        );
        await tx.query('RELEASE SAVEPOINT profile_insert');

        const row = inserted.rows[0];
        if (row) return { profile: row, created: true };

        // `do nothing` fired — a concurrent first login won the race.
        const raced = await tx.query<ProfileRow>(
          `select ${COLS} from core.profiles where address = $1 and chain = $2`,
          [address, chain],
        );
        const racedRow = raced.rows[0];
        if (racedRow) return { profile: racedRow, created: false };
      } catch (err) {
        await tx.query('ROLLBACK TO SAVEPOINT profile_insert');
        // A display_name collision is retryable. Anything else is a real fault.
        if (!isUniqueViolation(err)) throw err;
      }
    }

    throw new Error('exhausted display name candidates for a new profile');
  });
}
