/**
 * One-shot: attach the 10 standalone Sproto Gremlin Core assets to the
 * "Genesis Set OG" Metaplex Core Collection (5Vz7…6MSU). Treasury wallet
 * is the update authority of both the collection and the assets.
 *
 * Usage:
 *   $env:MINTER_SECRET_KEY_BS58 = "..."
 *   npx tsx scripts/attach-sprotos-to-collection.mts
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  keypairIdentity, publicKey as umiPublicKey,
} from '@metaplex-foundation/umi';
import { update, fetchCollection } from '@metaplex-foundation/mpl-core';

const SECRET = process.env.MINTER_SECRET_KEY_BS58;
if (!SECRET) { console.error('Need MINTER_SECRET_KEY_BS58'); process.exit(1); }

const COLLECTION = '5Vz7xGnYzVKVyWZVRThZpAC3zLZHJHgEtPZSMa736MSU';

const MINTS = [
  'Htvwx1UkNyxCFyUATgZGaSJknX6P1SLFvTmWv12yqRCk',
  '55Bxcd3429VsGioMaKQmVhi476fR3tvMbUfeqeuAwb2M',
  '7vxqz95mXAktHVqc2XEiSbAVvQsUeUYcosmi5Aof8oHJ',
  'HtGSMGHqRs8wJfvj9e9snSJo1ZRdRnML7oth4Xj1kfpK',
  '7nD2Ju4tLtayy4jP8tMY3Ggit6kC7Yc8L3GigMKSj86R',
  'Ha3GXpruSZMSWkMiygKoJ9zAavz7gswBtEEX4crhHd99',
  'J8JhF5EW3EPJzLqVUvu7wmbE9k2LGC5yTx7JVvn2PJ5k',
  'HSLCpLntHrgymVwBzCGHKBCb3M5RiFLZLnozW3R7uVWU',
  'Bxh7aisAM4ZcNG4FgUrBqXx35bT4DKGTBPPBa6hgyR47',
  'YX9qtt17VPZ5pLxP7spzj8ygH1ZJXGxs1LVRu5f68jA',
];

const RPC_POOL = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://solana-mainnet.public.blastapi.io',
  'https://solana.drpc.org',
];

const kp = Keypair.fromSecretKey(bs58.decode(SECRET));
console.log('[attach] authority:', kp.publicKey.toBase58());
console.log('[attach] collection:', COLLECTION);
console.log('[attach] assets    :', MINTS.length);

function umiFor(url: string) {
  const u = createUmi(url);
  const eddsa = u.eddsa.createKeypairFromSecretKey(kp.secretKey);
  return u.use(keypairIdentity(eddsa));
}

async function attachOne(mint: string): Promise<string> {
  let lastErr: any = null;
  for (const url of RPC_POOL) {
    try {
      const u = umiFor(url);
      // Fetch full collection (needed by `update` to assert the new parent).
      const collection = await fetchCollection(u, umiPublicKey(COLLECTION));
      const res = await update(u, {
        asset: umiPublicKey(mint),
        // No `collection:` — the asset is currently standalone.
        newCollection: umiPublicKey(COLLECTION),
        // Provide the fetched collection object so the ix sees current plugins.
        // (mpl-core's `update` accepts either a PublicKey or the full account.)
      } as any).sendAndConfirm(u, { confirm: { commitment: 'confirmed' } });
      return bs58.encode(Buffer.from(res.signature));
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 200);
      console.warn(`  ${mint.slice(0,8)}… via ${new URL(url).host} failed: ${msg}`);
      lastErr = e;
    }
  }
  throw new Error(`attach failed on all RPCs: ${String(lastErr?.message ?? lastErr).slice(0, 200)}`);
}

const results: Array<{ mint: string; sig?: string; err?: string }> = [];
for (let i = 0; i < MINTS.length; i++) {
  const mint = MINTS[i];
  process.stdout.write(`attach ${i+1}/${MINTS.length}  ${mint.slice(0,8)}… `);
  try {
    const sig = await attachOne(mint);
    console.log(`OK  ${sig.slice(0, 20)}…`);
    results.push({ mint, sig });
  } catch (e: any) {
    console.error(`FAIL: ${e?.message}`);
    results.push({ mint, err: String(e?.message ?? e) });
  }
  await new Promise(r => setTimeout(r, 600));
}

const ok = results.filter(r => r.sig);
console.log(`\n=== ${ok.length}/${results.length} attached to collection ${COLLECTION} ===`);
for (const r of ok) console.log(`  ${r.mint}  https://solscan.io/tx/${r.sig}`);
const bad = results.filter(r => r.err);
if (bad.length) {
  console.log(`\n=== ${bad.length} failed ===`);
  for (const r of bad) console.log(`  ${r.mint}  ${r.err}`);
}
