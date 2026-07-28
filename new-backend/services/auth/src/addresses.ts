/**
 * `core.profile_addresses` — the wallets one profile has proved control of.
 *
 * This service is the ONLY writer. The wager service reads the table to union a
 * player's on-chain holdings across their wallets; nothing else touches it.
 *
 * ── The rule that runs through every function here ─────────────────────────
 *
 * The database decides, and this module translates. There is no
 * "SELECT … then INSERT if free" anywhere below, because between the SELECT and
 * the INSERT two concurrent requests both see "free" and both proceed — which
 * for this table means one address linked to two profiles, and therefore one
 * on-chain collection counted for two ladder standings. The `(address, chain)`
 * primary key is the arbiter (migration 0013 § a), and the job here is to turn
 * its SQLSTATE into an error a client can act on. Same shape as the wager
 * service's deposit idempotency (C-2).
 *
 * ── SQLSTATEs raised by 0013 ───────────────────────────────────────────────
 *
 *   23505  primary key / partial unique index — address taken, or two primaries
 *   CH001  relink cooldown (§6)
 *   CH002  cannot unlink a profile's only address (§5)
 *   CH003  cannot unlink the primary without promoting another first (§5)
 */
import { AppError, pgErrorCode, query, withTransaction } from '@chains/shared';
import type { SignerKind } from './signature.js';

/** Custom SQLSTATEs, defined in db/migrations/0013_profile_addresses.sql § 8. */
const SQLSTATE_RELINK_COOLDOWN = 'CH001';
const SQLSTATE_LAST_ADDRESS = 'CH002';
const SQLSTATE_PRIMARY_ADDRESS = 'CH003';
const SQLSTATE_UNIQUE_VIOLATION = '23505';

export interface LinkedAddressRow {
  address: string;
  chain: string;
  kind: SignerKind;
  is_primary: boolean;
  linked_at: string;
}

export interface LinkedAddress {
  address: string;
  chain: string;
  kind: SignerKind;
  isPrimary: boolean;
  linkedAt: string;
}

const COLS = 'address, chain, kind, is_primary, linked_at';

function toView(row: LinkedAddressRow): LinkedAddress {
  return {
    address: row.address,
    chain: row.chain,
    kind: row.kind === 'smart' ? 'smart' : 'eoa',
    isPrimary: row.is_primary,
    linkedAt: new Date(row.linked_at).toISOString(),
  };
}

/**
 * Every address linked to ONE profile.
 *
 * `profileId` is always the AUTHENTICATED profile id. There is deliberately no
 * "whose is this address?" function exposed to a route: audit finding H-2 was
 * exactly a by-wallet-address leak, and the `(address, chain)` primary key means
 * such a function would answer for any wallet in the system, not just the
 * caller's. The only lookup that direction is `findProfileIdByAddress` below,
 * and it is reachable solely from a verified signature.
 */
export async function listAddresses(profileId: string): Promise<LinkedAddress[]> {
  const res = await query<LinkedAddressRow>(
    `select ${COLS}
       from core.profile_addresses
      where profile_id = $1::bigint
      order by is_primary desc, chain asc, address asc`,
    [profileId],
  );
  return res.rows.map(toView);
}

/**
 * The profile that owns `(address, chain)`, or `undefined`.
 *
 * This is how sign-in resolves identity now: any linked address reaches the
 * same profile. `core.profiles.address` is no longer consulted for lookup — it
 * is a mirror of the primary row, kept in step by the triggers in 0013.
 */
export async function findProfileIdByAddress(
  address: string,
  chain: string,
): Promise<string | undefined> {
  const res = await query<{ profile_id: string }>(
    `select profile_id::text as profile_id
       from core.profile_addresses
      where address = $1 and chain = $2`,
    [address, chain],
  );
  return res.rows[0]?.profile_id;
}

/**
 * Turn 0013's cooldown SQLSTATE into a client-safe error.
 *
 * The trigger puts `eligible_at=<ISO-8601>` in DETAIL so the client can show a
 * date instead of "try again later". No other part of the DETAIL is forwarded —
 * a driver error string never reaches a response body.
 */
function relinkCooldownError(err: unknown): AppError {
  const detail = (err as { detail?: unknown })?.detail;
  const match =
    typeof detail === 'string'
      ? /eligible_at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(detail)
      : null;
  return AppError.forbidden(
    'This address was recently unlinked from another profile and cannot be linked again yet',
    match ? { reason: 'address_relink_cooldown', eligibleAt: match[1] } : { reason: 'address_relink_cooldown' },
  );
}

export interface LinkAddressInput {
  profileId: string;
  address: string;
  chain: string;
  kind: SignerKind;
}

/**
 * Link an address to a profile. The caller must already have verified a fresh,
 * `link`-purpose signature FROM THAT ADDRESS — this function proves nothing.
 *
 * Never a primary: linking must not silently move `core.profiles.address` and
 * with it the wallet shown in `/auth/me`, the JWT `addr` claim and every
 * pre-0013 query. Promotion is a separate, explicit action.
 */
export async function linkAddress(input: LinkAddressInput): Promise<LinkedAddress> {
  try {
    const res = await query<LinkedAddressRow>(
      `insert into core.profile_addresses (profile_id, address, chain, kind, is_primary)
       values ($1::bigint, $2, $3, $4, false)
       returning ${COLS}`,
      [input.profileId, input.address, input.chain, input.kind],
    );
    return toView(res.rows[0]!);
  } catch (err) {
    const sqlstate = pgErrorCode(err);

    if (sqlstate === SQLSTATE_RELINK_COOLDOWN) throw relinkCooldownError(err);

    if (sqlstate === SQLSTATE_UNIQUE_VIOLATION) {
      // The database rejected it. This read is only to phrase the refusal — it
      // is not a check that could have been done first, because between any
      // such check and the INSERT the answer can change.
      const mine = await query<{ one: number }>(
        `select 1 as one
           from core.profile_addresses
          where address = $1 and chain = $2 and profile_id = $3::bigint`,
        [input.address, input.chain, input.profileId],
      );
      if (mine.rowCount === 1) {
        throw AppError.conflict('This address is already linked to your profile', {
          reason: 'address_already_linked',
        });
      }
      // Deliberately says nothing about WHICH profile (H-2): no id, no display
      // name, no chain-of-custody. "Taken" is all a client needs and all a
      // prober may learn.
      throw AppError.conflict('This address is already linked to another profile', {
        reason: 'address_linked_elsewhere',
      });
    }

    throw err;
  }
}

export interface UnlinkAddressInput {
  profileId: string;
  address: string;
  chain: string;
}

/**
 * Unlink an address from the caller's profile.
 *
 * Ownership is the `WHERE` clause, not a preceding check — the same pattern the
 * deck routes use, and the reason A cannot delete B's row even by knowing it
 * exists. A row that is not the caller's produces `rowCount = 0` and a 404,
 * which is also the answer for an address that is not linked at all: a caller
 * must not be able to tell "someone else has this" from "nobody has this".
 */
export async function unlinkAddress(input: UnlinkAddressInput): Promise<void> {
  try {
    const res = await query(
      `delete from core.profile_addresses
        where profile_id = $1::bigint and address = $2 and chain = $3`,
      [input.profileId, input.address, input.chain],
    );
    if (res.rowCount !== 1) {
      throw AppError.notFound('That address is not linked to your profile', {
        reason: 'address_not_linked',
      });
    }
  } catch (err) {
    const sqlstate = pgErrorCode(err);
    if (sqlstate === SQLSTATE_LAST_ADDRESS) {
      throw AppError.conflict('A profile must keep at least one address', {
        reason: 'last_address',
      });
    }
    if (sqlstate === SQLSTATE_PRIMARY_ADDRESS) {
      throw AppError.conflict('Promote another address to primary before unlinking this one', {
        reason: 'primary_address',
      });
    }
    throw err;
  }
}

/**
 * Make one of the caller's linked addresses the primary.
 *
 * TWO statements, one transaction, in this order. `profile_addresses_one_primary`
 * is a partial unique INDEX and therefore cannot be deferred, so it is checked
 * row by row as a statement runs: a single
 * `set is_primary = (address = $1)` sweep can transiently hold two primaries,
 * depending only on the order the executor happens to visit the rows, and would
 * fail intermittently. Demote first, then promote.
 *
 * No signature is required. Every linked address has already had control proved
 * at link time, and promotion grants no access that signing with the address
 * would not already grant — all linked addresses reach the same profile with
 * the same rights. What it does change is which wallet `core.profiles.address`
 * names, which is why it is an explicit action rather than a side effect.
 */
export async function setPrimaryAddress(input: UnlinkAddressInput): Promise<LinkedAddress> {
  return withTransaction(async (tx) => {
    const target = await tx.query<LinkedAddressRow>(
      `select ${COLS}
         from core.profile_addresses
        where profile_id = $1::bigint and address = $2 and chain = $3
          for update`,
      [input.profileId, input.address, input.chain],
    );
    if (target.rowCount !== 1) {
      throw AppError.notFound('That address is not linked to your profile', {
        reason: 'address_not_linked',
      });
    }

    await tx.query(
      `update core.profile_addresses
          set is_primary = false
        where profile_id = $1::bigint and is_primary`,
      [input.profileId],
    );

    const promoted = await tx.query<LinkedAddressRow>(
      `update core.profile_addresses
          set is_primary = true
        where profile_id = $1::bigint and address = $2 and chain = $3
        returning ${COLS}`,
      [input.profileId, input.address, input.chain],
    );
    return toView(promoted.rows[0]!);
  });
}

/**
 * Record that this address was most recently proved by an on-chain check.
 *
 * `kind` is advisory — nothing authorises on it — but it should stay true: an
 * address first seen as an EOA can later be a deployed smart account at the
 * same address (a 4337 wallet counterfactually deployed after its first
 * sign-in), and support needs to know why a login started costing an RPC call.
 * Only ever upgrades `eoa` -> `smart`; a `smart` row is never downgraded,
 * because a contract account cannot become an EOA.
 */
export async function noteSignerKind(input: {
  address: string;
  chain: string;
  kind: SignerKind;
}): Promise<void> {
  if (input.kind !== 'smart') return;
  await query(
    `update core.profile_addresses
        set kind = 'smart'
      where address = $1 and chain = $2 and kind <> 'smart'`,
    [input.address, input.chain],
  );
}
