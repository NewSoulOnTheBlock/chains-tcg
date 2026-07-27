/**
 * The card-index guard.
 *
 * `CardPack.cardOf(tokenId)` returns a NUMBER. That number only means a card
 * because of the order of `src/nft/cardIndex.ts`, which is itself a side effect
 * of object-literal ordering in `<repo>/src/cards.ts`. Insert one card in the
 * middle of that file and every later index shifts: every ownership row derived
 * from an old index silently becomes a different card, with no error anywhere,
 * on a table that is about to gate a 1 ETH prize.
 *
 * That is the single most dangerous failure mode in chain-derived ownership, so
 * it is pinned three ways:
 *
 *   1. shape — 80 entries, contiguous, unique, no Nodes (always runs),
 *   2. provenance — re-derived from the root catalogue when it is on disk
 *      (skipped in a Docker build, where `../../../../../src` does not exist),
 *   3. the chain — `cardCount()` from the live contract, opt-in via
 *      `CHAIN_LIVE_TESTS=1` so an offline run is not flaky. The same comparison
 *      runs unconditionally in production: `assertMatchesChain()` is called on
 *      every sync before anything is written.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AppError } from '../platform/shared.js';
import { assertMatchesChain, cardIdForIndex, CARD_COUNT, CARD_INDEX } from '../nft/cardCatalogue.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `<repo>/src/cards.ts` — present in a checkout, absent inside a service image. */
const ROOT_CATALOGUE = path.resolve(HERE, '../../../../../src/cards.ts');

/** The pack minted by 0xC910…60Ee — indexes verified against the live contract. */
const KNOWN_PACK_INDEXES = [43, 22, 74, 76, 40, 50];
const KNOWN_PACK_CARD_IDS = [
  'robinhood_margin',
  'sol_fartcoin',
  'base_wallet',
  'base_tip',
  'robinhood_dividend',
  'eth_wojak',
];

describe('on-chain card index', () => {
  it('has exactly the 80 cards the contract was deployed with', () => {
    expect(CARD_COUNT).toBe(80);
    expect(CARD_INDEX).toHaveLength(80);
  });

  it('is contiguous, unique and free of basic Nodes', () => {
    expect(new Set(CARD_INDEX).size).toBe(CARD_INDEX.length);
    for (const id of CARD_INDEX) {
      expect(id).toMatch(/^[a-z0-9_]+$/);
      // Nodes are granted to everyone and are excluded from the token space by
      // `gen-nft-metadata.mts` (`c.type !== 'node'`). One slipping in would
      // shift every later index.
      expect(id.startsWith('node_')).toBe(false);
    }
  });

  it('resolves the indexes of the pack that has actually been minted', () => {
    expect(KNOWN_PACK_INDEXES.map(cardIdForIndex)).toEqual(KNOWN_PACK_CARD_IDS);
  });

  it('throws on an index outside the manifest instead of inventing an id', () => {
    expect(() => cardIdForIndex(80)).toThrow(/outside the manifest/);
    expect(() => cardIdForIndex(-1)).toThrow(/outside the manifest/);
  });

  it('THE SHIFT GUARD: a cardCount the chain disagrees with stops the sync', () => {
    expect(() => assertMatchesChain(CARD_COUNT)).not.toThrow();
    // 81 is what a single inserted card looks like from here.
    const err = (() => {
      try {
        assertMatchesChain(81);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).details).toMatchObject({
      reason: 'card_index_out_of_sync',
      manifest_card_count: 80,
      chain_card_count: 81,
    });
  });

  const hasRoot = existsSync(ROOT_CATALOGUE);
  const provenance = hasRoot ? it : it.skip;
  if (!hasRoot) {
    // eslint-disable-next-line no-console
    console.warn('[wager] root src/cards.ts not on disk — card index provenance test SKIPPED');
  }

  provenance('re-derives byte-for-byte from the root catalogue', async () => {
    // The exact derivation `scripts/gen-nft-metadata.mts` performs.
    const mod = (await import(ROOT_CATALOGUE)) as {
      CARDS: Record<string, { id: string; type: string }>;
    };
    const derived = Object.values(mod.CARDS)
      .filter((c) => c.type !== 'node')
      .map((c) => c.id);
    expect(derived).toEqual([...CARD_INDEX]);
  });

  const live = process.env.CHAIN_LIVE_TESTS === '1' ? it : it.skip;

  live('matches the deployed contract’s cardCount()', async () => {
    const { CardPackReader } = await import('../chain/cardPackReader.js');
    const reader = new CardPackReader({
      rpcUrl: process.env.CARD_PACK_RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com',
      chainId: 4663,
      contract: process.env.CARD_PACK_ADDRESS ?? '0x57200fb533b33823f8bd2ac8f3649e3b643830b3',
      deployBlock: 0,
      logWindow: 50_000,
      maxTokenScan: 20_000,
      timeoutMs: 20_000,
    });
    expect(await reader.cardCount()).toBe(CARD_COUNT);
  });
});
