/**
 * `core.profile_addresses` — the wallets linked to one profile.
 *
 * Account abstraction sign-in makes a profile a set of addresses rather than
 * one: a player mints booster packs with MetaMask, later signs in with an
 * email-backed smart account, and must still own their cards. The table is
 * owned by the auth service; this service only ever READS it, and only ever for
 * the authenticated profile id.
 *
 *     core.profile_addresses (
 *       profile_id bigint      not null references core.profiles(id) on delete cascade,
 *       address    text        not null,
 *       chain      text        not null,
 *       kind       text        not null default 'eoa' check (kind in ('eoa','smart')),
 *       is_primary boolean     not null default false,
 *       linked_at  timestamptz not null default now(),
 *       primary key (address, chain)
 *     )
 *
 * The primary key is `(address, chain)`, NOT `(profile_id, address, chain)`, and
 * that is the property this service leans on: an address belongs to at most one
 * profile, globally. Two profiles cannot both claim the same wallet, so a union
 * across a profile's addresses can never include a token another profile also
 * counts.
 *
 * ── WHY THIS RETURNS `null` AND NOT `[]` ───────────────────────────────────
 *
 * Three states, and collapsing any two of them is a data-loss bug:
 *
 *   `null`   the TABLE does not exist. The linking migration has not landed on
 *            this database yet. Nothing is known about linked addresses, and the
 *            caller must degrade to the session identity rather than conclude
 *            the player has no wallets.
 *   `[]`     the table exists and has NO ROW for this profile. Every profile is
 *            backfilled with exactly one row, so this is an integrity failure —
 *            loud, but still not a statement that the player owns nothing.
 *   rows     the answer.
 *
 * The reconcile that consumes this is destructive: everything absent from the
 * union is DELETED. `[]` read as "no wallets" would enumerate nothing, hand the
 * reconcile an empty set, and delete the player's entire chain collection. So
 * the distinction is carried in the type rather than left to a caller to
 * remember, the same way `readSyncState` carries never-synced as `null`.
 */
import type { Pool, PoolClient } from 'pg';

/** SQLSTATE 42P01, `undefined_table`. */
const UNDEFINED_TABLE = '42P01';

export interface LinkedAddress {
  /** Verbatim as stored. Normalisation is the caller's job — it is chain-specific. */
  address: string;
  /** Chain SLUG (`robinhood`, `ethereum`, `base`, …), not an EIP-155 id. */
  chain: string;
  kind: 'eoa' | 'smart';
  isPrimary: boolean;
}

interface RawLinkedAddress {
  address: string;
  chain: string;
  kind: string;
  is_primary: boolean;
}

/**
 * Every address linked to ONE profile, or `null` if the table is not there yet.
 *
 * `profileId` is always the AUTHENTICATED profile id (H-2). There is no
 * lookup-by-address function here and there must never be one: the whole point
 * of the `(address, chain)` primary key is that this direction is the only one
 * a request can influence, and it can only ever influence it to the caller's
 * own profile.
 *
 * Ordered so a sync is reproducible for support: primary first, then by chain
 * and address. The caller re-sorts what it actually enumerates, but a stable
 * read order keeps the two logs comparable.
 */
export async function listLinkedAddresses(
  q: Pool | PoolClient,
  profileId: string,
): Promise<LinkedAddress[] | null> {
  try {
    const { rows } = await q.query<RawLinkedAddress>(
      `SELECT address, chain, kind, is_primary
         FROM core.profile_addresses
        WHERE profile_id = $1::bigint
        ORDER BY is_primary DESC, chain ASC, address ASC`,
      [profileId],
    );
    return rows.map((row) => ({
      address: row.address,
      chain: row.chain,
      kind: row.kind === 'smart' ? 'smart' : 'eoa',
      isPrimary: row.is_primary,
    }));
  } catch (err) {
    // Only `undefined_table` degrades. Anything else — a permission error, a
    // dead connection, a statement timeout — is a real failure and must
    // propagate, because swallowing it would hand the reconcile a short list.
    if (err && typeof err === 'object' && (err as { code?: string }).code === UNDEFINED_TABLE) {
      return null;
    }
    throw err;
  }
}
