/**
 * Profile lookup and first-login creation.
 *
 * ── Identity is now a SET of addresses ─────────────────────────────────────
 *
 * Before migration 0013, "which profile is this?" was
 * `core.profiles WHERE address = $1 AND chain = $2` — one wallet, one profile,
 * and a player with two wallets was two people. Sign-in now resolves through
 * `core.profile_addresses`, whose `(address, chain)` primary key is GLOBAL, so:
 *
 *   * signing with ANY linked address reaches the SAME profile;
 *   * an address with no row still creates a new profile, exactly as before;
 *   * an address cannot resolve to two profiles, because it cannot be linked
 *     to two profiles.
 *
 * `core.profiles.address` is still written and still carries
 * `UNIQUE (address, chain)`; it is the PRIMARY address, mirrored from the
 * `is_primary` row by the triggers in 0013 and kept so that every pre-existing
 * query keeps working. It is no longer the lookup key.
 *
 * `display_name citext unique` is unchanged and still enforced by the database,
 * so two simultaneous first logins for the same wallet resolve to one profile
 * rather than two, and a duplicate display name is impossible regardless of
 * application logic.
 */
import { randomBytes } from 'node:crypto';
import { AppError, isUniqueViolation, pgErrorCode, query, withTransaction } from '@chains/shared';

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

/** Relink cooldown, raised by 0013's BEFORE INSERT trigger. */
const SQLSTATE_RELINK_COOLDOWN = 'CH001';

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
 * A profile creation refused by the relink cooldown.
 *
 * "Unlink the wallet from profile A, then sign in fresh with it to make profile
 * B" is the one-step version of the wallet-lending abuse, so 0013's trigger
 * fires on profile creation too and this is where that lands. It is a 403 and
 * not a 401: nothing is wrong with the signature, and telling the user their
 * wallet failed would send them to reconnect a wallet that works fine.
 */
function relinkCooldownError(err: unknown): AppError {
  const detail = (err as { detail?: unknown })?.detail;
  const match =
    typeof detail === 'string'
      ? /eligible_at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(detail)
      : null;
  return AppError.forbidden(
    'This wallet was recently unlinked from another profile and cannot start a new one yet',
    match
      ? { reason: 'address_relink_cooldown', eligibleAt: match[1] }
      : { reason: 'address_relink_cooldown' },
  );
}

/**
 * Return the profile that owns (address, chain), creating it on first sign-in.
 *
 * Step 1 is a `core.profile_addresses` lookup, which is what makes a secondary
 * wallet sign in to the profile it belongs to instead of minting a new one.
 *
 * Step 2, creation, is unchanged in shape. Each insert attempt runs inside its
 * own SAVEPOINT: a `display_name` unique-violation aborts only that savepoint,
 * leaving the transaction usable for the next candidate. Without this, the first
 * collision would poison the whole transaction.
 *
 * The address row for a brand-new profile is ALSO created by 0013's
 * `profiles_link_primary_address` trigger, so the insert below is a no-op in
 * practice. It stays because the invariant has to hold for every writer — the
 * game and wager test fixtures INSERT into `core.profiles` directly and never
 * learn about the new table, and a profile with zero linked addresses would make
 * the wager service's DESTRUCTIVE collection reconcile enumerate nothing and
 * delete a real collection — while this call site is where a reader of the auth
 * service should be able to see that a new profile ends up with exactly one
 * primary address.
 */
export async function findOrCreateProfile(
  address: string,
  chain: string,
): Promise<{ profile: ProfileRow; created: boolean }> {
  return withTransaction(async (tx) => {
    const linked = await tx.query<ProfileRow>(
      `select ${COLS}
         from core.profiles p
        where p.id = (select a.profile_id
                        from core.profile_addresses a
                       where a.address = $1 and a.chain = $2)`,
      [address, chain],
    );
    const found = linked.rows[0];
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
        if (row) {
          await tx.query(
            `insert into core.profile_addresses (profile_id, address, chain, kind, is_primary)
             values ($1::bigint, $2, $3, 'eoa', true)
             on conflict (address, chain) do nothing`,
            [row.id, address, chain],
          );
          return { profile: row, created: true };
        }

        // `do nothing` fired — a concurrent first login won the race.
        const raced = await tx.query<ProfileRow>(
          `select ${COLS} from core.profiles where address = $1 and chain = $2`,
          [address, chain],
        );
        const racedRow = raced.rows[0];
        if (racedRow) return { profile: racedRow, created: false };
      } catch (err) {
        // The cooldown is a decision, not a retryable collision: rolling back to
        // the savepoint and trying the next display name would hit it again.
        if (pgErrorCode(err) === SQLSTATE_RELINK_COOLDOWN) throw relinkCooldownError(err);

        await tx.query('ROLLBACK TO SAVEPOINT profile_insert');
        // A display_name collision is retryable. Anything else is a real fault.
        if (!isUniqueViolation(err)) throw err;
      }
    }

    throw new Error('exhausted display name candidates for a new profile');
  });
}

/**
 * Roles for a profile, computed over EVERY address it has linked.
 *
 * `deriveRoles()` in the shared package answers for one `chain:address` pair
 * against `OPERATOR_ADDRESSES` — env, never the database (L-1), and that is
 * unchanged. What changes is which pairs are asked about.
 *
 * Roles must be a property of the PROFILE, not of the wallet that happened to
 * sign this session, for two reasons:
 *
 *   * `/auth/verify` and `/auth/refresh` would otherwise disagree. Refresh has
 *     no signing address to work from — it recomputes from the profile — so an
 *     operator who signed in with a secondary wallet would silently lose the
 *     role fifteen minutes later, on token rotation.
 *   * It grants nothing new. An address only appears in this list after a fresh
 *     signature FROM that address, so "linked an operator wallet" already means
 *     "controls the operator wallet", which is what OPERATOR_ADDRESSES names.
 */
export async function deriveProfileRoles(
  profileId: string,
  deriveRoles: (chain: string, address: string) => string[],
): Promise<string[]> {
  const res = await query<{ address: string; chain: string }>(
    `select address, chain from core.profile_addresses where profile_id = $1::bigint`,
    [profileId],
  );
  const roles = new Set<string>();
  for (const row of res.rows) {
    for (const role of deriveRoles(row.chain, row.address)) roles.add(role);
  }
  // A profile with no rows is an integrity failure the 0013 triggers make
  // unrepresentable, but never return an empty role set: 'player' is the floor.
  roles.add('player');
  return [...roles];
}
