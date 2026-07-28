/**
 * The collection routes on a database where 0013 has NOT been applied.
 *
 * `core.profile_addresses` is created by a migration the auth service owns, and
 * migrations and service images do not land in the same instant. So there is a
 * window — and, if a rollback goes badly, a longer one — in which this service
 * is running the multi-wallet code against a database that has never heard of
 * account linking.
 *
 * Two ways to get that wrong, and both are worse than the behaviour pinned
 * below:
 *
 *   CRASH OR REFUSE. A 503 on `POST /wager/collection/sync` because another
 *   service's migration has not run yet turns a deploy-ordering detail into a
 *   player-visible outage, for a feature that worked perfectly the day before.
 *
 *   TREAT "NO TABLE" AS "NO WALLETS". The reconcile is destructive: everything
 *   absent from the address list is DELETED. An empty list is not a smaller
 *   collection, it is every chain-derived card on the deployment, gone, one
 *   sync at a time. This is the failure that decides the whole design.
 *
 * So it degrades to the session address alone, which is exactly what this
 * service did before account linking existed — correct, just narrower than it
 * should be. The remaining risk is that nobody notices, and a deployment sits
 * there syncing one wallet forever while looking healthy; that is why the
 * fallback logs at ERROR on every single call rather than once per process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../platform/shared.js';
import type { AuthContext, Logger } from '../platform/shared.js';
import { setLoggerForTest } from '../platform/logger.js';
import {
  closeTestDatabase,
  makeProfile,
  restoreProfileAddresses,
  setupTestDatabase,
  simulateMissingProfileAddresses,
  testDatabaseUrl,
  truncateAll,
} from '../testing/db.js';
import { getMyCollection, syncMyCollection } from '../services/collectionService.js';
import type { CollectionServiceDeps } from '../services/collectionService.js';
import type { CardPackReader, HoldingsSnapshot } from '../chain/cardPackReader.js';
import { CARD_COUNT } from '../nft/cardCatalogue.js';

const HAS_DB = testDatabaseUrl() !== null;
const suite = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn('[wager] TEST_DATABASE_URL not set — degraded collection tests SKIPPED');
}

const WALLET = '0xaaaa000000000000000000000000000000000011';

class FakeCardPack {
  askedFor: string[] = [];
  constructor(private readonly holdings: Record<string, HoldingsSnapshot>) {}
  get contractAddress(): string {
    return '0x57200fb533b33823f8bd2ac8f3649e3b643830b3';
  }
  get chainId(): number {
    return 4663;
  }
  async cardCount(): Promise<number> {
    return CARD_COUNT;
  }
  async getBlockNumber(): Promise<number> {
    return 1;
  }
  async holdingsOf(owner: string): Promise<HoldingsSnapshot> {
    const key = owner.toLowerCase();
    this.askedFor.push(key);
    return this.holdings[key] ?? { blockNumber: 1, tokens: [], transferredAway: 0 };
  }
}

function depsFor(fake: FakeCardPack): CollectionServiceDeps {
  return { cardPack: fake as unknown as CardPackReader };
}

function authFor(profileId: string, address: string): AuthContext {
  return { profileId, address, chain: 'robinhood', roles: [] } as unknown as AuthContext;
}

function snapshot(blockNumber: number, cardIndexes: number[]): HoldingsSnapshot {
  return {
    blockNumber,
    transferredAway: 0,
    tokens: cardIndexes.map((cardIndex, i) => ({ tokenId: BigInt(i), cardIndex })),
  };
}

/** Capture the process logger without printing. */
function captureLog(): { events: Array<{ msg: string; fields?: Record<string, unknown> }> } {
  const events: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger = {
    level: 'debug' as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields?: Record<string, unknown>) => events.push({ msg, fields }),
    child: () => logger,
  };
  setLoggerForTest(logger as unknown as Logger);
  return { events };
}

suite('collection on a database without core.profile_addresses', () => {
  let player = '';

  beforeAll(async () => {
    await setupTestDatabase();
    await simulateMissingProfileAddresses();
  });

  afterAll(async () => {
    // Put the schema back before the pool closes: the wager suite shares one
    // database, and leaving it mid-migration would be a trap for whatever runs
    // next against it by hand.
    await restoreProfileAddresses();
    await closeTestDatabase();
  });

  beforeEach(async () => {
    setLoggerForTest(null);
    await truncateAll();
    player = await makeProfile('player', WALLET);
  });

  it('the table really is absent — otherwise this whole file proves nothing', async () => {
    const { rows } = await query<{ present: string | null }>(
      `SELECT to_regclass('core.profile_addresses')::text AS present`,
    );
    expect(rows[0]!.present).toBeNull();
  });

  it('syncs the session wallet and reports it, exactly as before linking existed', async () => {
    const fake = new FakeCardPack({ [WALLET]: snapshot(1234, [43, 22, 74]) });
    const result = await syncMyCollection(depsFor(fake), authFor(player, WALLET));

    expect(fake.askedFor).toEqual([WALLET]);
    expect(result.cards).toEqual({ robinhood_margin: 1, sol_fartcoin: 1, base_wallet: 1 });
    expect(result.total).toBe(3);
    expect(result.blockNumber).toBe(1234);
    expect(result.syncedBlock).toBe(1234);
    expect(result.synced).toBe(true);
    expect(result.addresses).toEqual([WALLET]);
    expect(result.addressesSkipped).toBe(0);
  });

  it('DOES NOT EMPTY THE COLLECTION it cannot enumerate wallets for', async () => {
    const holdings = { [WALLET]: snapshot(10, [43, 22]) };
    await syncMyCollection(depsFor(new FakeCardPack(holdings)), authFor(player, WALLET));

    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM core.card_ownership
        WHERE profile_id = $1 AND source = 'chain'`,
      [player],
    );
    // The whole point. A missing table read as "this profile has no wallets"
    // would have produced zero rows here, and the response would still have
    // looked like a successful sync.
    expect(rows[0]!.n).toBe('2');
  });

  it('GET still renders the stored collection', async () => {
    const fake = new FakeCardPack({ [WALLET]: snapshot(10, [43]) });
    await syncMyCollection(depsFor(fake), authFor(player, WALLET));

    const view = await getMyCollection(depsFor(fake), authFor(player, WALLET));
    expect(view.cards).toEqual({ robinhood_margin: 1 });
    expect(view.synced).toBe(true);
    expect(view.addresses).toEqual([WALLET]);
  });

  it('reports the missing table at ERROR on EVERY call, not once per process', async () => {
    const { events } = captureLog();
    try {
      const fake = new FakeCardPack({ [WALLET]: snapshot(10, [43]) });
      await syncMyCollection(depsFor(fake), authFor(player, WALLET));
      await syncMyCollection(depsFor(fake), authFor(player, WALLET));
      await getMyCollection(depsFor(fake), authFor(player, WALLET));
    } finally {
      setLoggerForTest(null);
    }

    const missing = events.filter((e) => e.msg === 'profile_addresses_missing');
    // A fallback that stops complaining is a fallback nobody notices.
    expect(missing).toHaveLength(3);
    expect(missing[0]!.fields).toMatchObject({
      reason: 'table_absent',
      fallback: 'session_address_only',
    });
  });
});
