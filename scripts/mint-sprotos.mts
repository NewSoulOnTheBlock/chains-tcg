/**
 * One-shot: mint 10 editioned "Sproto Gremlin" Metaplex Core NFTs to a recipient wallet.
 *
 * Usage:
 *   $env:MINTER_SECRET_KEY_BS58 = "..."
 *   $env:SPROTO_RECIPIENT       = "yGrBsck53t9MeBqz2WNvRynhtfFhisHVt9UQbH4ddxp"
 *   npx tsx scripts/mint-sprotos.mts
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  generateSigner, keypairIdentity, publicKey as umiPublicKey,
} from '@metaplex-foundation/umi';
import { create } from '@metaplex-foundation/mpl-core';

const SECRET = process.env.MINTER_SECRET_KEY_BS58;
const RECIPIENT = process.env.SPROTO_RECIPIENT;
const METADATA_URI = process.env.SPROTO_METADATA_URI ?? 'https://www.masterstcg.com/sproto-gremlin.json';
const COUNT = Number(process.env.SPROTO_COUNT ?? 10);

if (!SECRET || !RECIPIENT) {
  console.error('Need MINTER_SECRET_KEY_BS58 and SPROTO_RECIPIENT env vars');
  process.exit(1);
}

const RPC_POOL = [
  'https://solana-rpc.publicnode.com',
  'https://solana-mainnet.public.blastapi.io',
  'https://solana.drpc.org',
  'https://api.mainnet-beta.solana.com',
];

const kp = Keypair.fromSecretKey(bs58.decode(SECRET));
console.log('[mint-sprotos] minter pubkey:', kp.publicKey.toBase58());
console.log('[mint-sprotos] recipient    :', RECIPIENT);
console.log('[mint-sprotos] metadata uri :', METADATA_URI);
console.log('[mint-sprotos] minting      :', COUNT, 'NFTs');

function umiFor(url: string) {
  const u = createUmi(url);
  const eddsa = u.eddsa.createKeypairFromSecretKey(kp.secretKey);
  return u.use(keypairIdentity(eddsa));
}

async function mintOne(n: number): Promise<{ mint: string; sig: string }> {
  let lastErr: any = null;
  for (const url of RPC_POOL) {
    try {
      const u = umiFor(url);
      const asset = generateSigner(u);
      const res = await create(u, {
        asset,
        name: `Sproto Gremlin #${n}`,
        uri: METADATA_URI,
        owner: umiPublicKey(RECIPIENT!),
      }).sendAndConfirm(u, { confirm: { commitment: 'confirmed' } });
      return {
        mint: asset.publicKey.toString(),
        sig: bs58.encode(Buffer.from(res.signature)),
      };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 140);
      console.warn(`  #${n} via ${new URL(url).host} failed: ${msg}`);
      lastErr = e;
    }
  }
  throw new Error(`#${n} failed on all RPCs: ${String(lastErr?.message ?? lastErr).slice(0, 200)}`);
}

const results: Array<{ n: number; mint: string; sig: string }> = [];
for (let n = 1; n <= COUNT; n++) {
  process.stdout.write(`minting #${n}/${COUNT}... `);
  try {
    const r = await mintOne(n);
    console.log(`OK  mint=${r.mint}  sig=${r.sig.slice(0, 24)}...`);
    results.push({ n, ...r });
  } catch (e: any) {
    console.error('FAIL:', e?.message);
  }
  // Small spacing to be polite to public RPCs
  await new Promise(r => setTimeout(r, 600));
}

console.log('\n=== RESULTS ===');
for (const r of results) {
  console.log(`#${r.n}  mint=${r.mint}  https://solscan.io/tx/${r.sig}`);
}
console.log(`\n${results.length}/${COUNT} minted to ${RECIPIENT}`);
