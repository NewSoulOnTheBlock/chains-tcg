/**
 * Which wallets a profile is allowed to PAY from.
 *
 * The money paths in this service — escrow deposits (C-2) and booster purchases
 * (H-3) — verify that an on-chain transaction came from the player claiming it.
 * Until account linking landed, "the player" was one address and the check was
 * `tx.from === auth.address`. It is not one address any more.
 *
 * ── WHY `auth.address` IS NO LONGER THE ANSWER ─────────────────────────────
 *
 * `POST /auth/verify` mints the access token with the profile's PRIMARY address
 * in the `addr` claim, deliberately: the claim has to match what `/auth/me` and
 * `GET /api/profiles/me` report and it has to survive `/auth/refresh`, which has
 * no signing address to reproduce. So `auth.address` is now "this profile's
 * canonical wallet", NOT "the wallet this session signed with" and certainly not
 * "the wallet this player will pay from".
 *
 * A player who signs in with their smart account and pays from their MetaMask —
 * or the reverse — would have had a perfectly good payment rejected as
 * `not_sent_by_depositor`, with a message telling them the transaction was not
 * sent by their wallet when it demonstrably was. That is a support ticket nobody
 * could close. The two addresses were always equal before linking, so nothing
 * caught it.
 *
 * ── THE SET COMES FROM THE DATABASE, FOR THE AUTHENTICATED PROFILE ─────────
 *
 * Never from a request body, a query string or a path segment. Audit finding
 * H-2 was a by-wallet-address leak and widening a comparison is exactly where it
 * would come back: "accept a payment from the address in the request" is the
 * same bug wearing a different hat. The only inputs here are `auth.profileId`
 * and, in the degraded case below, the session's own proven address.
 *
 * This is deliberately a narrower module than `collectionAddresses.ts`. That one
 * answers "which wallets do we enumerate NFTs for", is filtered to the CardPack
 * contract's own chain id, and feeds a destructive reconcile. This one answers
 * "who may this profile's money come from", and feeds a comparison that fails
 * closed.
 *
 * ── EVERY EVM CHAIN, NOT THE MONEY CHAIN ───────────────────────────────────
 *
 * The set is not filtered to the chain the deposit is being verified on, and
 * that is a decision rather than an oversight.
 *
 * `core.profile_addresses.chain` records where control of a wallet was PROVED,
 * not where it may spend. An EOA is one keypair with the same address on every
 * EVM chain; a signature proving control on `robinhood` proves control of the
 * identical account on `base`. Filtering to the verifier's chain id would refuse
 * a payment from a wallet the player has already proved, on the grounds that
 * they proved it somewhere else.
 *
 * It would also collide head-on with a known defect: ROADMAP-ownership.md § 3
 * records that the wager money path is still pointed at Sepolia (11155111) while
 * sign-in, the game and the contracts are all on Robinhood Chain (4663). Pinning
 * this set to the verifier's chain id would make it EMPTY for every real player
 * the day the wager product is switched on, and the symptom would be "all
 * deposits rejected" with nothing in the logs pointing at the chain id.
 *
 * Non-EVM rows are dropped instead of normalised. A Solana base58 address can
 * never equal an EVM `tx.from`, so it contributes nothing to the comparison, and
 * running it through EVM normalisation is pure risk for no gain.
 */
import { CHAINS, isValidAddress } from '../platform/shared.js';
import type { AuthContext, ChainSpec, Pool, PoolClient } from '../platform/shared.js';
import { log } from '../platform/logger.js';
import { listLinkedAddresses } from '../db/profileAddresses.js';

/** Where the set came from. Mirrors `AddressSource` in `collectionAddresses`. */
export type TransactingAddressSource = 'linked' | 'session_fallback';

export interface TransactingAddresses {
  /**
   * Lower-cased EVM addresses this profile may transact from, de-duplicated and
   * sorted.
   *
   * MAY BE EMPTY — a profile whose only wallets are on Solana has no EVM address
   * to pay from, and an empty set rejects every EVM payment. That is the same
   * answer the pre-linking code gave (a base58 `auth.address` never matched a
   * hex `tx.from`) and it is the fail-closed direction, so it is left to the
   * membership test rather than raised as a special case.
   */
  addresses: readonly string[];
  source: TransactingAddressSource;
}

const ALL_CHAINS: ChainSpec[] = Object.values(CHAINS);

/** Registry slugs whose chains are EVM. Everything else cannot produce a `tx.from`. */
const EVM_SLUGS = new Set(ALL_CHAINS.filter((c) => c.kind === 'evm').map((c) => c.slug));

/**
 * Fold rows into the canonical comparison set.
 *
 * UNPARSEABLE ROWS ARE SKIPPED, not thrown on, and this is the opposite of
 * `collectionAddresses.canonicalise` on purpose. There, a row that cannot be
 * read means the address list is not the list, and the destructive reconcile
 * that consumes it would delete everything the list omits — so it must abort.
 * Here, a short list rejects a payment: recoverable, visible to the player
 * immediately, and never the wrong way round. Throwing would turn one corrupt
 * row into a 500 on every deposit the profile attempts.
 *
 * It is still an integrity failure, so it is reported at ERROR.
 */
function canonicalise(
  profileId: string,
  entries: readonly { address: string; chain: string }[],
): string[] {
  const seen = new Set<string>();
  let malformed = 0;
  for (const entry of entries) {
    if (!EVM_SLUGS.has(entry.chain)) continue;
    if (!isValidAddress(entry.chain, entry.address)) {
      malformed += 1;
      continue;
    }
    seen.add(entry.address.trim().toLowerCase());
  }
  if (malformed > 0) {
    // Counts and chains only, never the addresses themselves.
    log().error('transacting_address_malformed', { profile_id: profileId, malformed });
  }
  return [...seen].sort();
}

/**
 * Every wallet linked to `auth.profileId` that could have sent an EVM
 * transaction.
 *
 * `q` is normally the caller's TRANSACTION client, not the pool. A deposit reads
 * this set and then writes a row on the strength of it; reading inside the same
 * transaction means a concurrent unlink cannot land between the two and leave a
 * deposit attributed to a wallet the profile no longer holds.
 *
 * ── DEGRADATION, AND WHY IT IS NOT SILENT ──────────────────────────────────
 *
 * If `core.profile_addresses` is absent (the linking migration has not landed on
 * this database) or holds no row for this profile, the set degrades to the
 * SESSION ADDRESS ALONE — exactly the behaviour these paths had before linking
 * existed. Refusing instead would take payments down for every player on a
 * deploy-ordering accident; treating "no rows" as "no wallets" would reject
 * every payment on the deployment with a message that blames the player's
 * wallet. Both degraded paths log at ERROR, so a deployment cannot quietly
 * accept only one wallet forever.
 *
 * Using the session address here is not a re-opening of H-2: the token was
 * minted by the auth service for this exact profile after a signature check, so
 * it is an address already proven to belong to this profile — not one the
 * request chose.
 *
 * The session address is NEVER merged into a non-empty linked set, for the same
 * reason `collectionAddresses` refuses to merge it: if the player unlinked the
 * wallet they still hold a session for, the database is the authority and that
 * wallet stops being able to fund anything as this profile. Merging would leave
 * an unlinked wallet spending as its old profile until the token expired.
 */
export async function resolveTransactingAddresses(
  q: Pool | PoolClient,
  auth: AuthContext,
): Promise<TransactingAddresses> {
  const linked = await listLinkedAddresses(q, auth.profileId);

  if (linked === null || linked.length === 0) {
    const reason = linked === null ? 'table_absent' : 'no_rows_for_profile';
    log().error('profile_addresses_missing', {
      profile_id: auth.profileId,
      reason,
      session_chain: auth.chain,
      fallback: 'session_address_only',
      // Say the consequence out loud, so whoever reads this at 3am does not
      // have to find this file to know what it cost.
      effect: 'payments are accepted only from the wallet this session signed in with',
    });
    return {
      addresses: canonicalise(auth.profileId, [{ address: auth.address, chain: auth.chain }]),
      source: 'session_fallback',
    };
  }

  return { addresses: canonicalise(auth.profileId, linked), source: 'linked' };
}
