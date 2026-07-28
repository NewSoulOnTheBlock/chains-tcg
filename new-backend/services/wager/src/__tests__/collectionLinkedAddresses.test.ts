/**
 * Ownership across every wallet linked to a profile.
 *
 * A player mints booster packs with MetaMask, later signs in with an
 * email-backed smart account, and must still own their cards. `core.profiles`
 * holds one address; `core.profile_addresses` holds all of them, and a sync has
 * to reconcile against the UNION of their holdings.
 *
 * The reader is faked — there is no network in a test run — but the database is
 * real, because the property under test is what survives in
 * `core.card_ownership` after the reconcile, and the reconcile is destructive.
 *
 * What this pins, in rough order of how expensive getting it wrong would be:
 *
 *  - ONE reconcile against the union, never one per address. Per-address is the
 *    obvious shape and it deletes A's cards on B's pass and B's on A's.
 *  - A FAILED enumeration aborts the whole sync. A short union is not a smaller
 *    collection, it is a deletion.
 *  - Selling from one wallet still removes exactly that card, and nothing else.
 *  - Booster-granted rows are untouched, however many wallets are involved.
 *  - Wallets on other chains are skipped and counted, not enumerated.
 *  - A one-wallet profile behaves exactly as it did before any of this.
 *  - No address ever comes from a request (H-2), and one profile's linked
 *    wallets are invisible to another's sync.
 *
 * Every profile's PRIMARY link is written by 0013's
 * `profiles_link_primary_address` trigger when `makeProfile` inserts it, not by
 * this file — which is why nothing below links a profile's own address, and why
 * `is_primary` is never passed. A profile with zero linked addresses cannot
 * exist, and the destructive reconcile depends on that.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError, query } from '../platform/shared.js';
import type { AuthContext, Logger } from '../platform/shared.js';
import { setLoggerForTest } from '../platform/logger.js';
import {
  closeTestDatabase,
  linkAddress,
  makeProfile,
  setupTestDatabase,
  testDatabaseUrl,
  truncateAll,
} from '../testing/db.js';
import { getMyCollection, syncMyCollection } from '../services/collectionService.js';
import type { CollectionServiceDeps } from '../services/collectionService.js';
import { slugsForChainId } from '../services/collectionAddresses.js';
import type { CardPackReader, HoldingsSnapshot } from '../chain/cardPackReader.js';
import { CARD_COUNT } from '../nft/cardCatalogue.js';

const HAS_DB = testDatabaseUrl() !== null;
const suite = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn('[wager] TEST_DATABASE_URL not set — linked address tests SKIPPED');
}

/** The wallet a player minted with. */
const METAMASK = '0xaaaa000000000000000000000000000000000011';
/** The smart account they later signed in with. */
const SMART = '0xcccc000000000000000000000000000000000033';
/** A third wallet, linked later still. */
const LEDGER = '0xdddd000000000000000000000000000000000044';
/** Somebody else entirely. */
const MALLORY = '0xbbbb000000000000000000000000000000000022';
/** A Solana wallet: base58, case-sensitive, and no CardPack token can live on it. */
const SOLANA = 'So11111111111111111111111111111111111111112';

/** Robinhood Chain, where CardPack lives. */
const CARD_CHAIN_ID = 4663;

interface FakeOptions {
  chainCardCount?: number;
  chainId?: number;
  /** Addresses whose enumeration throws, simulating an RPC that failed. */
  failing?: string[];
  head?: number;
}

/**
 * Minimal stand-in for the real reader.
 *
 * `askedFor` is the important part: it is how a test proves which wallets the
 * service decided to enumerate, which is the whole subject of this file.
 */
class FakeCardPack {
  askedFor: string[] = [];
  constructor(
    private readonly holdings: Record<string, HoldingsSnapshot>,
    private readonly opts: FakeOptions = {},
  ) {}
  get contractAddress(): string {
    return '0x57200fb533b33823f8bd2ac8f3649e3b643830b3';
  }
  get chainId(): number {
    return this.opts.chainId ?? CARD_CHAIN_ID;
  }
  async cardCount(): Promise<number> {
    return this.opts.chainCardCount ?? CARD_COUNT;
  }
  async getBlockNumber(): Promise<number> {
    return this.opts.head ?? 1;
  }
  async holdingsOf(owner: string): Promise<HoldingsSnapshot> {
    const key = owner.toLowerCase();
    this.askedFor.push(key);
    if (this.opts.failing?.includes(key)) {
      // The exact shape `CardPackReader` throws when a log window fails.
      throw AppError.unavailable('Card chain data is temporarily unavailable', {
        reason: 'card_chain_unavailable',
      });
    }
    return this.holdings[key] ?? { blockNumber: 1, tokens: [], transferredAway: 0 };
  }
}

function depsFor(fake: FakeCardPack): CollectionServiceDeps {
  return { cardPack: fake as unknown as CardPackReader };
}

/**
 * A session. `chain` is the slug the web app signs in with since migration
 * 0009; the profile's other wallets are whatever `core.profile_addresses` says.
 */
function authFor(profileId: string, address: string, chain = 'robinhood'): AuthContext {
  return { profileId, address, chain, roles: [] } as unknown as AuthContext;
}

/**
 * `tokenBase` keeps token ids distinct between wallets. An ERC-721 has one
 * owner, so two wallets sharing a token id is not a real state — one test
 * constructs it deliberately to prove the de-duplication net.
 */
function snapshot(
  blockNumber: number,
  cardIndexes: number[],
  opts: { transferredAway?: number; tokenBase?: number } = {},
): HoldingsSnapshot {
  const base = opts.tokenBase ?? 0;
  return {
    blockNumber,
    transferredAway: opts.transferredAway ?? 0,
    tokens: cardIndexes.map((cardIndex, i) => ({ tokenId: BigInt(base + i), cardIndex })),
  };
}

async function storedChainCards(profileId: string): Promise<Record<string, number>> {
  const { rows } = await query<{ card_id: string; qty: number }>(
    `SELECT card_id, qty FROM core.card_ownership
      WHERE profile_id = $1 AND source = 'chain' ORDER BY card_id`,
    [profileId],
  );
  return Object.fromEntries(rows.map((r) => [r.card_id, r.qty]));
}

suite('card ownership across linked addresses', () => {
  let player = '';
  let other = '';

  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  beforeEach(async () => {
    // `core.profiles` is truncated CASCADE, which carries the linked addresses
    // with it. Each profile comes back with exactly one primary link, on
    // `robinhood`, courtesy of the trigger.
    await truncateAll();
    player = await makeProfile('player', METAMASK);
    other = await makeProfile('other', MALLORY);
  });

  // ── the union ─────────────────────────────────────────────────────────────

  it('THE POINT: two linked wallets produce the union of their holdings', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const fake = new FakeCardPack({
      // Minted with MetaMask, before account abstraction existed.
      [METAMASK]: snapshot(100, [43, 22], { tokenBase: 0 }),
      // Pulled later, through the smart account.
      [SMART]: snapshot(100, [74, 76], { tokenBase: 10 }),
    });

    const result = await syncMyCollection(depsFor(fake), authFor(player, SMART));

    expect(result.cards).toEqual({
      robinhood_margin: 1, // 43, MetaMask
      sol_fartcoin: 1, // 22, MetaMask
      base_wallet: 1, // 74, smart account
      base_tip: 1, // 76, smart account
    });
    expect(result.total).toBe(4);
    expect(result.addresses).toEqual([METAMASK, SMART].sort());
    expect(fake.askedFor.sort()).toEqual([METAMASK, SMART].sort());

    // And it SURVIVED. If the reconcile ran per address, whichever wallet was
    // enumerated last would be the only one left in the table.
    expect(await storedChainCards(player)).toEqual({
      base_tip: 1,
      base_wallet: 1,
      robinhood_margin: 1,
      sol_fartcoin: 1,
    });
  });

  it('the same card in two wallets is one row with the summed quantity', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const fake = new FakeCardPack({
      [METAMASK]: snapshot(100, [43, 43], { tokenBase: 0 }),
      [SMART]: snapshot(100, [43], { tokenBase: 10 }),
    });

    const result = await syncMyCollection(depsFor(fake), authFor(player, METAMASK));
    expect(result.cards).toEqual({ robinhood_margin: 3 });
    expect(result.distinct).toBe(1);
    expect(result.total).toBe(3);
  });

  it('a third wallet linked later brings its cards in on the next sync', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const holdings: Record<string, HoldingsSnapshot> = {
      [METAMASK]: snapshot(100, [43], { tokenBase: 0 }),
      [SMART]: snapshot(100, [22], { tokenBase: 10 }),
      [LEDGER]: snapshot(100, [74], { tokenBase: 20 }),
    };
    const fake = new FakeCardPack(holdings);

    const before = await syncMyCollection(depsFor(fake), authFor(player, SMART));
    expect(before.cards).toEqual({ robinhood_margin: 1, sol_fartcoin: 1 });

    await linkAddress({ profileId: player, address: LEDGER });
    const after = await syncMyCollection(depsFor(fake), authFor(player, SMART));

    expect(after.cards).toEqual({ robinhood_margin: 1, sol_fartcoin: 1, base_wallet: 1 });
    expect(after.addresses).toEqual([METAMASK, LEDGER, SMART].sort());
  });

  it('the recorded block is the OLDEST head the union was read at', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const fake = new FakeCardPack({
      [METAMASK]: snapshot(900, [43], { tokenBase: 0 }),
      [SMART]: snapshot(1000, [22], { tokenBase: 10 }),
    });

    const result = await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    // A snapshot is one claim about the whole profile, so the strongest honest
    // claim is bounded by its oldest component. Reporting 1000 would tell a
    // staleness check the collection is fresher than the earliest read
    // supports.
    expect(result.blockNumber).toBe(900);
    expect(result.syncedBlock).toBe(900);
    expect((await getMyCollection(depsFor(fake), authFor(player, METAMASK))).syncedBlock).toBe(900);
  });

  it('a token id seen under two wallets is counted once', async () => {
    // Not a real chain state — an ERC-721 has exactly one owner — but one
    // wallet enumerated twice would look exactly like this, and it would hand
    // the player a playset they do not own.
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const fake = new FakeCardPack({
      [METAMASK]: snapshot(100, [43], { tokenBase: 7 }),
      [SMART]: snapshot(100, [43], { tokenBase: 7 }),
    });

    const result = await syncMyCollection(depsFor(fake), authFor(player, METAMASK));
    expect(result.cards).toEqual({ robinhood_margin: 1 });

    const { rows } = await query<{ token_count: number }>(
      `SELECT token_count FROM core.card_ownership_sync WHERE profile_id = $1`,
      [player],
    );
    expect(rows[0]!.token_count).toBe(1);
  });

  // ── the reconcile is still destructive, and still exact ───────────────────

  it('selling from ONE wallet removes exactly that card and nothing else', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const holdings: Record<string, HoldingsSnapshot> = {
      [METAMASK]: snapshot(100, [43, 22], { tokenBase: 0 }),
      [SMART]: snapshot(100, [74], { tokenBase: 10 }),
    };
    const fake = new FakeCardPack(holdings);
    await syncMyCollection(depsFor(fake), authFor(player, METAMASK));
    expect(await storedChainCards(player)).toEqual({
      base_wallet: 1,
      robinhood_margin: 1,
      sol_fartcoin: 1,
    });

    // The MetaMask wallet sells `sol_fartcoin`. The smart account is untouched.
    holdings[METAMASK] = snapshot(200, [43], { tokenBase: 0, transferredAway: 1 });
    holdings[SMART] = snapshot(200, [74], { tokenBase: 10 });
    const result = await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    expect(result.cards).toEqual({ robinhood_margin: 1, base_wallet: 1 });
    expect(result.removed).toBe(1);
    expect(result.transferredAway).toBe(1);
    // The smart account's card is still there. Under a per-address reconcile
    // it would not be.
    expect(await storedChainCards(player)).toEqual({ base_wallet: 1, robinhood_margin: 1 });
  });

  it('emptying one wallet does not empty the other', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const holdings: Record<string, HoldingsSnapshot> = {
      [METAMASK]: snapshot(100, [43, 22], { tokenBase: 0 }),
      [SMART]: snapshot(100, [74, 76], { tokenBase: 10 }),
    };
    const fake = new FakeCardPack(holdings);
    await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    holdings[METAMASK] = snapshot(200, [], { transferredAway: 2 });
    const result = await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    expect(result.cards).toEqual({ base_wallet: 1, base_tip: 1 });
    expect(result.removed).toBe(2);
  });

  it('a booster-granted card survives a reconcile across several wallets', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });
    // What a redemption writes. `eth_pepe` was never on chain, so it is absent
    // from every wallet's snapshot by construction — the exact shape that the
    // `source` partition (0011) exists to protect, and widening the wallet set
    // does not change it.
    await query(
      `INSERT INTO core.card_ownership (profile_id, card_id, qty, source)
       VALUES ($1, 'eth_pepe', 2, 'booster')`,
      [player],
    );

    const fake = new FakeCardPack({
      [METAMASK]: snapshot(100, [43], { tokenBase: 0 }),
      [SMART]: snapshot(100, [22], { tokenBase: 10 }),
    });
    const result = await syncMyCollection(depsFor(fake), authFor(player, SMART));

    expect(result.cards).toEqual({ robinhood_margin: 1, sol_fartcoin: 1, eth_pepe: 2 });
    expect(await storedChainCards(player)).toEqual({
      robinhood_margin: 1,
      sol_fartcoin: 1,
    });
  });

  // ── partial failure ───────────────────────────────────────────────────────

  it('ONE WALLET FAILING ABORTS THE SYNC AND DELETES NOTHING', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const holdings: Record<string, HoldingsSnapshot> = {
      [METAMASK]: snapshot(100, [43, 22], { tokenBase: 0 }),
      [SMART]: snapshot(100, [74], { tokenBase: 10 }),
    };
    await syncMyCollection(depsFor(new FakeCardPack(holdings)), authFor(player, METAMASK));
    const before = await storedChainCards(player);
    expect(Object.keys(before)).toHaveLength(3);

    // The smart account's RPC read fails. Its cards are therefore missing from
    // the union — and reconciling that union would delete them, which is
    // indistinguishable from the player having sold them.
    const broken = new FakeCardPack(holdings, { failing: [SMART] });
    await expect(
      syncMyCollection(depsFor(broken), authFor(player, METAMASK)),
    ).rejects.toMatchObject({ details: { reason: 'card_chain_unavailable' } });

    expect(await storedChainCards(player)).toEqual(before);
  });

  it('a failed union leaves the previous block pointer untouched', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const holdings: Record<string, HoldingsSnapshot> = {
      [METAMASK]: snapshot(100, [43], { tokenBase: 0 }),
      [SMART]: snapshot(100, [22], { tokenBase: 10 }),
    };
    const ok = new FakeCardPack(holdings);
    await syncMyCollection(depsFor(ok), authFor(player, METAMASK));

    holdings[METAMASK] = snapshot(500, [43], { tokenBase: 0 });
    const broken = new FakeCardPack(holdings, { failing: [SMART] });
    await expect(syncMyCollection(depsFor(broken), authFor(player, METAMASK))).rejects.toThrow();

    // A pointer at 500 over block-100 cards would be a snapshot claiming data
    // that was rolled back.
    expect((await getMyCollection(depsFor(ok), authFor(player, METAMASK))).syncedBlock).toBe(100);
  });

  it('an index outside the manifest in the SECOND wallet still writes nothing', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const holdings: Record<string, HoldingsSnapshot> = {
      [METAMASK]: snapshot(100, [43], { tokenBase: 0 }),
      [SMART]: snapshot(100, [22], { tokenBase: 10 }),
    };
    await syncMyCollection(depsFor(new FakeCardPack(holdings)), authFor(player, METAMASK));

    holdings[SMART] = snapshot(200, [999], { tokenBase: 10 });
    await expect(
      syncMyCollection(depsFor(new FakeCardPack(holdings)), authFor(player, METAMASK)),
    ).rejects.toThrow(/outside the manifest/);

    expect(await storedChainCards(player)).toEqual({
      robinhood_margin: 1,
      sol_fartcoin: 1,
    });
  });

  // ── chains ────────────────────────────────────────────────────────────────

  it('resolves the CardPack chain by EIP-155 id, not by the string "robinhood"', () => {
    expect(slugsForChainId(CARD_CHAIN_ID)).toEqual(['robinhood']);
    expect(slugsForChainId(1)).toEqual(['ethereum']);
    expect(slugsForChainId(8453)).toEqual(['base']);
    // Solana has no EIP-155 id and can never match one.
    expect(slugsForChainId(0)).toEqual([]);
  });

  it('enumerates only wallets on the contract’s chain, and counts what it skipped', async () => {
    await linkAddress({ profileId: player, address: SMART, chain: 'base', kind: 'smart' });
    await linkAddress({ profileId: player, address: LEDGER, chain: 'ethereum' });

    const fake = new FakeCardPack({
      [METAMASK]: snapshot(100, [43], { tokenBase: 0 }),
      // Present in the fake, so a wrongly-enumerated wallet would show up as
      // extra cards rather than as nothing.
      [SMART]: snapshot(100, [74], { tokenBase: 10 }),
      [LEDGER]: snapshot(100, [76], { tokenBase: 20 }),
    });

    const result = await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    expect(result.cards).toEqual({ robinhood_margin: 1 });
    expect(result.addresses).toEqual([METAMASK]);
    expect(result.addressesSkipped).toBe(2);
    expect(fake.askedFor).toEqual([METAMASK]);
  });

  it('refuses rather than empties when no linked wallet is on the card chain', async () => {
    const fake = new FakeCardPack({ [METAMASK]: snapshot(100, [43, 22], { tokenBase: 0 }) });
    await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    // Now the same profile, read through a reader pinned to a chain no slug in
    // the registry maps to. Left to run, this enumerates nothing, hands the
    // reconcile an empty set, and deletes every chain-sourced card on the
    // deployment one profile at a time.
    const unmapped = new FakeCardPack({}, { chainId: 999_999 });
    await expect(
      syncMyCollection(depsFor(unmapped), authFor(player, METAMASK)),
    ).rejects.toMatchObject({ details: { reason: 'card_chain_unmapped' } });

    // A profile whose wallets are all on other chains is the same refusal for
    // the same reason: a slug that stopped matching the registry looks exactly
    // like a player who genuinely holds nothing here.
    const offChain = await makeProfile(
      'offchain',
      '0xeeee000000000000000000000000000000000055',
      'base',
    );
    await expect(
      syncMyCollection(
        depsFor(fake),
        authFor(offChain, '0xeeee000000000000000000000000000000000055', 'base'),
      ),
    ).rejects.toMatchObject({ details: { reason: 'no_addresses_on_card_chain' } });

    expect(await storedChainCards(player)).toEqual({
      robinhood_margin: 1,
      sol_fartcoin: 1,
    });
  });

  // ── H-2: the addresses come from the database, for the caller only ────────

  it('one profile’s linked wallets are invisible to another profile’s sync', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const fake = new FakeCardPack({
      [METAMASK]: snapshot(100, [43], { tokenBase: 0 }),
      [SMART]: snapshot(100, [22], { tokenBase: 10 }),
      [MALLORY]: snapshot(100, [74], { tokenBase: 20 }),
    });

    await syncMyCollection(depsFor(fake), authFor(other, MALLORY));

    // Mallory's sync asked about Mallory's wallet and nothing else, and left
    // the other profile's collection alone.
    expect(fake.askedFor).toEqual([MALLORY]);
    expect(await storedChainCards(other)).toEqual({ base_wallet: 1 });
    expect(await storedChainCards(player)).toEqual({});
  });

  it('a wallet unlinked from the profile stops counting on the next sync', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const fake = new FakeCardPack({
      [METAMASK]: snapshot(100, [43], { tokenBase: 0 }),
      [SMART]: snapshot(100, [22], { tokenBase: 10 }),
    });
    await syncMyCollection(depsFor(fake), authFor(player, METAMASK));
    expect(await storedChainCards(player)).toEqual({ robinhood_margin: 1, sol_fartcoin: 1 });

    // The player unlinks the smart account. The database is the authority on
    // what belongs to the profile, so its cards go — otherwise unlinking would
    // do nothing, and the same wallet could be counted by two profiles at once
    // in the window before a token expired.
    await query(`DELETE FROM core.profile_addresses WHERE address = $1`, [SMART]);
    const result = await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    expect(result.cards).toEqual({ robinhood_margin: 1 });
    expect(result.addresses).toEqual([METAMASK]);
  });

  it('a session whose wallet is not linked does not smuggle that wallet in', async () => {
    // A profile whose only wallet is the smart account, carrying a session that
    // still names an EOA. The token is authentic — it was minted for this
    // profile id — but the linking table says that wallet is not this
    // profile's, and the linking table is the authority.
    const smartOnly = await makeProfile('smart-only', SMART);

    const events: string[] = [];
    const capture = {
      level: 'debug' as const,
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string) => events.push(msg),
      child: () => capture,
    };
    setLoggerForTest(capture as unknown as Logger);
    let result;
    try {
      const fake = new FakeCardPack({
        [METAMASK]: snapshot(100, [43], { tokenBase: 0 }),
        [SMART]: snapshot(100, [22], { tokenBase: 10 }),
      });
      result = await syncMyCollection(depsFor(fake), authFor(smartOnly, METAMASK));
      expect(fake.askedFor).toEqual([SMART]);
    } finally {
      setLoggerForTest(null);
    }

    expect(result.cards).toEqual({ sol_fartcoin: 1 });
    expect(result.addresses).toEqual([SMART]);
    // Reported, because outside an unlink it means the linking table and the
    // token disagree about who this profile is.
    expect(events).toContain('session_address_not_linked');
  });

  // ── the one-wallet profile, unchanged ─────────────────────────────────────

  it('a profile with ONE linked wallet behaves exactly as it always has', async () => {
    const holdings: Record<string, HoldingsSnapshot> = {
      [METAMASK]: snapshot(1234, [43, 22, 74, 76, 40, 50], { tokenBase: 0 }),
    };
    const fake = new FakeCardPack(holdings);
    const result = await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    // The real pack held by 0xC910…60Ee, byte for byte the assertion the
    // single-address suite makes.
    expect(result.cards).toEqual({
      robinhood_margin: 1,
      sol_fartcoin: 1,
      base_wallet: 1,
      base_tip: 1,
      robinhood_dividend: 1,
      eth_wojak: 1,
    });
    expect(result.total).toBe(6);
    expect(result.distinct).toBe(6);
    expect(result.blockNumber).toBe(1234);
    expect(result.syncedBlock).toBe(1234);
    expect(result.transferredAway).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.synced).toBe(true);
    expect(result.syncedAt).not.toBeNull();
    expect(result.addresses).toEqual([METAMASK]);
    expect(result.addressesSkipped).toBe(0);

    holdings[METAMASK] = snapshot(2000, [43], { tokenBase: 0, transferredAway: 5 });
    const after = await syncMyCollection(depsFor(fake), authFor(player, METAMASK));
    expect(after.cards).toEqual({ robinhood_margin: 1 });
    expect(after.removed).toBe(5);
    expect(after.transferredAway).toBe(5);
  });

  // ── what the sync row records ─────────────────────────────────────────────

  it('records the CONTRACT and the union’s token count, never a wallet', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });

    const fake = new FakeCardPack({
      [METAMASK]: snapshot(9001, [43, 43], { tokenBase: 0 }),
      [SMART]: snapshot(9002, [22], { tokenBase: 10 }),
    });
    await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    const { rows } = await query<{
      address: string;
      chain_id: number;
      block_number: string;
      token_count: number;
    }>(
      `SELECT address, chain_id, block_number, token_count
         FROM core.card_ownership_sync WHERE profile_id = $1`,
      [player],
    );

    expect(rows[0]).toMatchObject({
      // `core.card_ownership_sync.address` was NEVER the player's wallet — 0011
      // documents it as the CardPack contract, because repointing
      // CARD_PACK_ADDRESS makes every stored snapshot a statement about a
      // different collection. So there is no "first address" to be silently
      // recorded here, and the multi-wallet sync needs no column change for it.
      address: '0x57200fb533b33823f8bd2ac8f3649e3b643830b3',
      chain_id: CARD_CHAIN_ID,
      block_number: '9001',
      // TOKENS across the whole union, not distinct cards: three tokens over
      // two wallets, two cards.
      token_count: 3,
    });
  });

  it('still keeps exactly one sync row per profile', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });
    const fake = new FakeCardPack({
      [METAMASK]: snapshot(100, [43], { tokenBase: 0 }),
      [SMART]: snapshot(100, [22], { tokenBase: 10 }),
    });
    await syncMyCollection(depsFor(fake), authFor(player, METAMASK));
    await syncMyCollection(depsFor(fake), authFor(player, SMART));

    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM core.card_ownership_sync WHERE profile_id = $1`,
      [player],
    );
    expect(rows[0]!.n).toBe('1');
  });

  // ── the read route ────────────────────────────────────────────────────────

  it('GET reports the caller’s own wallets, and keeps every legacy field', async () => {
    await linkAddress({ profileId: player, address: SMART, kind: 'smart' });
    await linkAddress({ profileId: player, address: SOLANA, chain: 'solana' });

    const fake = new FakeCardPack({
      [METAMASK]: snapshot(100, [43], { tokenBase: 0 }),
      [SMART]: snapshot(100, [22], { tokenBase: 10 }),
    });
    await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    const view = await getMyCollection(depsFor(fake), authFor(player, METAMASK));
    expect(view.cards).toEqual({ robinhood_margin: 1, sol_fartcoin: 1 });
    expect(view.distinct).toBe(2);
    expect(view.total).toBe(2);
    expect(view.synced).toBe(true);
    expect(view.syncedAt).not.toBeNull();
    expect(view.syncedBlock).toBe(100);
    expect(view.addresses).toEqual([METAMASK, SMART].sort());
    // The solana row is linked and cannot hold an ERC-721 on 4663.
    expect(view.addressesSkipped).toBe(1);
  });

  it('GET does not 503 when a sync would refuse', async () => {
    const fake = new FakeCardPack({ [METAMASK]: snapshot(100, [43], { tokenBase: 0 }) });
    await syncMyCollection(depsFor(fake), authFor(player, METAMASK));

    // A reader pinned to an unmapped chain. The sync refuses; the read still
    // renders what is stored, because showing a player their own collection
    // cannot delete anything.
    const unmapped = new FakeCardPack({}, { chainId: 999_999 });
    const view = await getMyCollection(depsFor(unmapped), authFor(player, METAMASK));
    expect(view.cards).toEqual({ robinhood_margin: 1 });
    expect(view.addresses).toEqual([]);
  });

  // ── the profile that has no linked row at all ─────────────────────────────

  it('a profile with no linked row degrades to the session wallet, loudly', async () => {
    // 0013 makes this state unreachable: a trigger writes the primary row on
    // every profile INSERT and another refuses to delete the last one. The
    // trigger is disabled here to construct it anyway, because the property
    // being tested is that the wager service's DESTRUCTIVE reconcile does not
    // depend on another service's trigger still being installed. Zero rows read
    // as "no wallets" hands the reconcile an empty set and deletes the player's
    // whole collection; it degrades to the pre-linking behaviour instead, and
    // says so at ERROR.
    await query(
      `ALTER TABLE core.profile_addresses DISABLE TRIGGER profile_addresses_guard_unlink`,
    );
    await query(`DELETE FROM core.profile_addresses WHERE profile_id = $1::bigint`, [player]);
    await query(
      `ALTER TABLE core.profile_addresses ENABLE TRIGGER profile_addresses_guard_unlink`,
    );

    const events: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const capture = {
      level: 'debug' as const,
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (msg: string, fields?: Record<string, unknown>) => events.push({ msg, fields }),
      child: () => capture,
    };
    setLoggerForTest(capture as unknown as Logger);
    let result;
    try {
      const fake = new FakeCardPack({ [METAMASK]: snapshot(100, [43, 22], { tokenBase: 0 }) });
      result = await syncMyCollection(depsFor(fake), authFor(player, METAMASK));
    } finally {
      setLoggerForTest(null);
    }

    expect(result.cards).toEqual({ robinhood_margin: 1, sol_fartcoin: 1 });
    expect(result.addresses).toEqual([METAMASK]);
    expect(events.filter((e) => e.msg === 'profile_addresses_missing')[0]?.fields).toMatchObject({
      reason: 'no_rows_for_profile',
    });
  });
});
