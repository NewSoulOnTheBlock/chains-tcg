/**
 * Which wallets a profile's card collection is derived from.
 *
 * Ownership used to be "the address you signed in with". With account
 * abstraction sign-in and account linking it is "every address linked to this
 * profile that could physically hold the token" — a player who minted packs
 * with MetaMask and then signed in with an email-backed smart account must
 * still own their cards.
 *
 * This module answers ONE question — which addresses — and deliberately does
 * not enumerate, reconcile, or throw about policy. `collectionService` applies
 * the refusals, because the two callers want different things from the same
 * answer: a sync must refuse rather than reconcile against a suspect list, and
 * a read must still be able to render a collection.
 *
 * ── ONLY ADDRESSES ON THE CONTRACT'S CHAIN ─────────────────────────────────
 *
 * `profile_addresses.chain` holds a chain SLUG. CardPack is an ERC-721 at a
 * fixed address on EIP-155 4663; an address linked on `base` or `solana` cannot
 * hold one of its tokens, and asking a 4663 node about it would return an empty
 * answer that is indistinguishable from "sold everything". So the eligible set
 * is the addresses whose slug resolves, through the shared chain registry, to
 * the reader's own chain id — matched on the ID, never on the string
 * `'robinhood'`, so a testnet deployment (46630) or a renamed slug is handled by
 * configuration rather than by an edit here.
 *
 * Skipped addresses are counted and their chains reported, never silently
 * dropped: "your Solana wallet holds no CardPack tokens" is a true and useful
 * thing to be able to say, and a chain slug that suddenly starts being skipped
 * is the first symptom of a registry change.
 *
 * ── THE ADDRESSES COME FROM THE DATABASE ───────────────────────────────────
 *
 * Never from a request body, a query string or a path segment — that was audit
 * finding H-2, a read-anyone's-holdings-by-wallet leak. The only inputs here are
 * the authenticated `profileId` and, in the degraded case below, the session's
 * own proven address.
 */
import { AppError, CHAINS, getPool, normalizeAddress } from '../platform/shared.js';
import type { AuthContext, ChainSpec } from '../platform/shared.js';
import { log } from '../platform/logger.js';
import { listLinkedAddresses } from '../db/profileAddresses.js';

/**
 * Where the address list came from.
 *
 *   `linked`            `core.profile_addresses`, the real answer.
 *   `session_fallback`  the table or the profile's row was missing, so the
 *                       session identity was used instead. See below.
 */
export type AddressSource = 'linked' | 'session_fallback';

export interface AddressPlan {
  /**
   * Addresses to enumerate: on the contract's chain, normalised, de-duplicated,
   * sorted. MAY BE EMPTY — the caller decides whether that is a refusal or an
   * empty collection.
   */
  addresses: string[];
  /** Linked addresses that cannot hold this contract's tokens, by chain slug. */
  skipped: Array<{ chain: string; count: number }>;
  source: AddressSource;
  /**
   * Chain slugs in the shared registry that map to the contract's chain id.
   *
   * EMPTY IS A MISCONFIGURATION, and a dangerous one: if nothing maps to the
   * reader's chain id then no linked address is ever eligible, every profile
   * enumerates nothing, and a full reconcile deletes every collection on the
   * deployment. Surfaced here so the sync can refuse instead.
   */
  chainSlugs: string[];
}

const ALL_CHAINS: ChainSpec[] = Object.values(CHAINS);

/** Registry slugs for an EIP-155 chain id. Normally one; never assumed to be. */
export function slugsForChainId(chainId: number): string[] {
  return ALL_CHAINS.filter((c) => c.kind === 'evm' && c.chainId === chainId)
    .map((c) => c.slug)
    .sort();
}

/**
 * Fold the eligible rows into a canonical, de-duplicated, sorted list.
 *
 * De-duplication is on the NORMALISED address, not on `(address, chain)`. The
 * table's primary key is `(address, chain)`, so one wallet linked under two
 * slugs that both resolve to the same chain id is two rows and one wallet —
 * impossible today, when only `robinhood` maps to 4663, but this code matches on
 * chain id precisely so that it does not have to be re-audited when that stops
 * being true. Enumerating a wallet twice would double every quantity it holds.
 */
function canonicalise(entries: Array<{ address: string; chain: string }>): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    // Throws on an address that does not belong to its chain. Deliberately not
    // caught: an unparseable row means the list is not the list, and the
    // reconcile that consumes it deletes everything the list omits.
    seen.add(normalizeAddress(entry.chain, entry.address));
  }
  return [...seen].sort();
}

/**
 * The wallets `profileId`'s chain-sourced collection is derived from.
 *
 * ── GRACEFUL DEGRADATION, AND WHY IT IS NOT SILENT ─────────────────────────
 *
 * The linking migration may not have landed on this database yet, and a profile
 * could conceivably be missing its backfilled row. Both cases degrade to the
 * SESSION ADDRESS ALONE, which is exactly the behaviour this service had before
 * account linking existed: correct, just narrower than it should be. The
 * alternatives are worse in both directions — refusing the sync takes the
 * feature down for every player on a deploy-ordering accident, and treating "no
 * rows" as "no wallets" hands the reconcile an empty set and deletes real
 * collections.
 *
 * Using the session address here is not a re-opening of H-2. It is not supplied
 * by the request: the access token was minted by the auth service for this exact
 * `(profileId, address, chain)` after a signature check, so it is the one
 * address already proven to belong to this profile.
 *
 * It is NOT chain-filtered, unlike the linked rows. The fallback's entire job is
 * to reproduce the pre-linking behaviour, which enumerated the session address
 * unconditionally; filtering it would turn a missing migration into a wiped
 * collection, which is the failure this fallback exists to prevent. The session
 * chain is logged so a mismatch is visible.
 *
 * Both degraded paths log at ERROR with their own event name. That is what keeps
 * this from becoming a deployment that quietly syncs one wallet forever: the
 * fallback is survivable, but it is never quiet, and `profile_addresses_missing`
 * firing in production is an alert, not a debug line.
 *
 * The session address is NEVER merged into a non-empty linked list. If the
 * player unlinked the wallet they are still holding a session for, the database
 * is the authority and that wallet stops counting — otherwise unlinking would do
 * nothing until the token expired, and two profiles could count the same tokens
 * in the window between an unlink and a re-link.
 */
export async function resolveCollectionAddresses(
  auth: AuthContext,
  chainId: number,
): Promise<AddressPlan> {
  const chainSlugs = slugsForChainId(chainId);
  const linked = await listLinkedAddresses(getPool(), auth.profileId);

  if (linked === null || linked.length === 0) {
    const reason = linked === null ? 'table_absent' : 'no_rows_for_profile';
    log().error('profile_addresses_missing', {
      profile_id: auth.profileId,
      reason,
      session_chain: auth.chain,
      fallback: 'session_address_only',
      // Say the consequence out loud in the log itself; whoever reads this at
      // 3am should not have to find this file to know what it cost.
      effect: 'collection sync covers only the wallet this session signed in with',
    });
    return {
      addresses: canonicalise([{ address: auth.address, chain: auth.chain }]),
      skipped: [],
      source: 'session_fallback',
      chainSlugs,
    };
  }

  const eligible = linked.filter((row) => chainSlugs.includes(row.chain));
  const skippedByChain = new Map<string, number>();
  for (const row of linked) {
    if (chainSlugs.includes(row.chain)) continue;
    skippedByChain.set(row.chain, (skippedByChain.get(row.chain) ?? 0) + 1);
  }
  const skipped = [...skippedByChain]
    .map(([chain, count]) => ({ chain, count }))
    .sort((a, b) => a.chain.localeCompare(b.chain));

  if (skipped.length > 0) {
    log().info('profile_addresses_skipped', {
      profile_id: auth.profileId,
      card_chain_id: chainId,
      card_chain_slugs: chainSlugs,
      // Chains and counts, never the addresses: this is an info-level line.
      skipped: skipped.map((s) => `${s.chain}:${s.count}`),
    });
  }

  const addresses = canonicalise(eligible);

  if (chainSlugs.includes(auth.chain)) {
    const sessionAddress = normalizeAddress(auth.chain, auth.address);
    if (!addresses.includes(sessionAddress)) {
      // The wallet this session authenticated with is not linked to the profile
      // the same session names. Legitimate immediately after an unlink, and
      // otherwise a linking bug — either way the database wins, so this is a
      // report and not a merge.
      log().error('session_address_not_linked', {
        profile_id: auth.profileId,
        session_chain: auth.chain,
        linked_on_card_chain: eligible.length,
      });
    }
  }

  return { addresses, skipped, source: 'linked', chainSlugs };
}

/**
 * Refuse a destructive reconcile whose address list cannot be trusted.
 *
 * Called by the sync and NOT by the read: a `GET` that renders whatever is
 * stored is harmless in both of these states, while a reconcile against a wrong
 * list deletes cards. Both refusals are the same shape as `assertMatchesChain`
 * — stop before the write, do not degrade to a best effort.
 */
export function assertSyncable(plan: AddressPlan, chainId: number): void {
  if (plan.chainSlugs.length === 0) {
    // No slug in the registry maps to the chain the reader is pinned to, so
    // nothing could ever be eligible. Left to run, this deletes every
    // chain-sourced card on the deployment, one sync at a time.
    log().error('card_chain_unmapped', { card_chain_id: chainId });
    throw AppError.unavailable('Card ownership cannot be synced on this deployment', {
      reason: 'card_chain_unmapped',
      chain_id: chainId,
    });
  }

  if (plan.addresses.length === 0) {
    // Reachable only from a `linked` plan — the fallback always yields exactly
    // one address. The profile has wallets and none of them are on the card
    // chain, which is either a genuinely off-chain account or a slug that no
    // longer matches the registry. Reconciling would empty the collection, and
    // the second reading is far more likely than the first, so it refuses.
    log().error('no_addresses_on_card_chain', {
      card_chain_id: chainId,
      card_chain_slugs: plan.chainSlugs,
      skipped: plan.skipped.map((s) => `${s.chain}:${s.count}`),
    });
    throw AppError.unavailable('No linked wallet can hold cards on this chain', {
      reason: 'no_addresses_on_card_chain',
      chain_id: chainId,
      chains: plan.chainSlugs,
    });
  }
}
