// src/booster-mint.ts
// Server-side helpers for the real Booster Pack Ticket mint flow.
//
// Two-step flow:
//   1. Client asks for a payment intent (price + treasury pubkey).
//   2. Client builds + signs a SystemProgram.transfer to the treasury, sends it.
//   3. Client calls /confirm with the tx signature.
//   4. Server verifies the tx on-chain (correct payer, recipient, amount, not
//      already used), then mints a Metaplex Core NFT ticket to the buyer.
//
// We deliberately keep the buyer's payment as a single SystemProgram.transfer
// — minimal wallet UI, smallest possible failure surface. The mint happens
// server-side using the treasury keypair, paid for out of treasury balance
// (~0.0015 SOL/mint).
//
// Required env:
//   CUSTODIAL_ESCROW_KEYPAIR or BOOSTER_TREASURY_KEYPAIR  base58 [u8] JSON.
//                                                          The recipient of
//                                                          all sale SOL AND
//                                                          the mint authority.
//   VITE_SOLANA_RPC / SOLANA_RPC / HELIUS_API_KEY          RPC endpoint.
//
// Optional env:
//   BOOSTER_PRICE_SOL        Price in SOL (default 0.4).
//   BOOSTER_SUPPLY_CAP       Max tickets mintable (default 2000).
//   BOOSTER_METADATA_URI     Override the NFT metadata URI (default
//                            https://www.masterstcg.com/booster-ticket.json).

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
} from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  generateSigner, keypairIdentity, publicKey as umiPublicKey,
} from '@metaplex-foundation/umi';
import { create, mplCore } from '@metaplex-foundation/mpl-core';

// ── Config ─────────────────────────────────────────────────────────────────

export const BOOSTER_PRICE_SOL = Number(process.env.BOOSTER_PRICE_SOL ?? 0.2);
export const BOOSTER_PRICE_LAMPORTS = Math.round(BOOSTER_PRICE_SOL * 1e9);
export const BOOSTER_SUPPLY_CAP = Number(process.env.BOOSTER_SUPPLY_CAP ?? 100);
// Display-only offset added to the on-chain mint count for marketing/scarcity.
// Real mints still tick the count upward on top of this baseline.
export const BOOSTER_MINTED_OFFSET = Number(process.env.BOOSTER_MINTED_OFFSET ?? 37);

const METADATA_URI = process.env.BOOSTER_METADATA_URI
  ?? 'https://www.masterstcg.com/booster-ticket.json';

const RPC_URL =
  process.env.VITE_SOLANA_RPC ||
  process.env.SOLANA_RPC ||
  (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : '') ||
  'https://solana-rpc.publicnode.com';

const RPC_POOL: string[] = Array.from(new Set([
  // Public nodes first — they're reliable, free, and immune to the
  // "invalid api key" failure mode we hit when HELIUS_API_KEY drifts.
  'https://solana-rpc.publicnode.com',
  'https://solana-mainnet.public.blastapi.io',
  'https://solana.drpc.org',
  'https://api.mainnet-beta.solana.com',
  // User-configured RPC last — it can still take over if env is set + valid,
  // but we don't gate the booster mint on it.
  RPC_URL,
]));

// ── Connection w/ failover ─────────────────────────────────────────────────

let _connIdx = 0;
let _conn: Connection | null = null;
function buildConn(idx: number): Connection {
  const c = new Connection(RPC_POOL[idx], 'confirmed');
  const orig = (c as any)._rpcRequest.bind(c);
  (c as any)._rpcRequest = async (method: string, args: any[]) => {
    const tryOne = async (i: number): Promise<any> => {
      const url = RPC_POOL[i];
      const conn2 = i === idx ? c : new Connection(url, 'confirmed');
      const fn = i === idx ? orig : (conn2 as any)._rpcRequest.bind(conn2);
      try {
        const res = await Promise.race([
          fn(method, args),
          new Promise((_, rej) => setTimeout(() => rej(new Error('rpc timeout')), 12000)),
        ]);
        if (res && (res as any).error) throw new Error(JSON.stringify((res as any).error));
        return res;
      } catch (e) {
        const next = (i + 1) % RPC_POOL.length;
        if (next === idx) throw e;
        console.warn(`[booster-mint] RPC ${url} failed (${(e as Error).message}), trying ${RPC_POOL[next]}`);
        return tryOne(next);
      }
    };
    return tryOne(idx);
  };
  return c;
}
function conn(): Connection {
  if (!_conn) _conn = buildConn(_connIdx);
  return _conn;
}

// ── Treasury keypair ───────────────────────────────────────────────────────

let _treasury: Keypair | null | undefined;
export function treasury(): Keypair | null {
  if (_treasury !== undefined) return _treasury;
  const raw = process.env.BOOSTER_TREASURY_KEYPAIR
    ?? process.env.CUSTODIAL_ESCROW_KEYPAIR;
  if (!raw) { _treasury = null; return null; }
  try {
    _treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    console.log('[booster-mint] treasury', _treasury.publicKey.toBase58());
    return _treasury;
  } catch (e) {
    console.error('[booster-mint] bad treasury keypair', e);
    _treasury = null;
    return null;
  }
}

export function treasuryPubkey(): string | null {
  const k = treasury();
  return k ? k.publicKey.toBase58() : null;
}

export function boosterMintEnabled(): boolean {
  return treasury() !== null;
}

// ── Step 1: build an unsigned payment transaction ──────────────────────────

/**
 * Returns a base64-encoded, unsigned legacy Transaction with one
 * SystemProgram.transfer(buyer → treasury, BOOSTER_PRICE_LAMPORTS).
 * Fee payer = buyer. Client signs and sends.
 */
export async function buildPaymentTx(buyerAddress: string): Promise<{
  txBase64: string;
  treasury: string;
  lamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
}> {
  const t = treasury();
  if (!t) throw new Error('Booster treasury is not configured');
  const buyer = new PublicKey(buyerAddress);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: buyer,
      toPubkey: t.publicKey,
      lamports: BOOSTER_PRICE_LAMPORTS,
    }),
  );
  tx.feePayer = buyer;
  const { blockhash, lastValidBlockHeight } = await conn().getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  // serialize *unsigned* (must require all signatures off, else .serialize throws)
  const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return {
    txBase64: raw.toString('base64'),
    treasury: t.publicKey.toBase58(),
    lamports: BOOSTER_PRICE_LAMPORTS,
    blockhash,
    lastValidBlockHeight,
  };
}

// ── Step 2: verify a confirmed payment by signature ────────────────────────

export type VerifiedPayment = {
  buyer: string;
  signature: string;
  lamports: number;
  slot: number;
};

/**
 * Confirms the tx landed on-chain and contains a SystemProgram.transfer of
 * BOOSTER_PRICE_LAMPORTS from `claimedBuyer` to the treasury. Returns the
 * verified payment record on success; throws on any mismatch.
 */
export async function verifyPayment(
  signature: string, claimedBuyer: string,
): Promise<VerifiedPayment> {
  const t = treasury();
  if (!t) throw new Error('Booster treasury is not configured');

  // Wait up to ~60s for the tx to finalize.
  const deadline = Date.now() + 60_000;
  let tx: any = null;
  while (Date.now() < deadline) {
    tx = await conn().getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (tx) break;
    await new Promise(r => setTimeout(r, 1500));
  }
  if (!tx) throw new Error('tx not found on-chain (or timed out)');
  if (tx.meta?.err) throw new Error(`tx failed on-chain: ${JSON.stringify(tx.meta.err)}`);

  // Walk pre/post balances on the treasury account to confirm the lamports
  // delta matches BOOSTER_PRICE_LAMPORTS. This is more robust than parsing
  // instructions, which can be hidden behind ALTs or program wrappers.
  const accountKeys: PublicKey[] = (tx.transaction.message.staticAccountKeys
    ?? tx.transaction.message.accountKeys
    ?? []).map((k: any) => (k instanceof PublicKey ? k : new PublicKey(k)));

  const treasuryIdx = accountKeys.findIndex(k => k.equals(t.publicKey));
  if (treasuryIdx < 0) throw new Error('tx does not touch treasury account');

  const pre = tx.meta?.preBalances?.[treasuryIdx];
  const post = tx.meta?.postBalances?.[treasuryIdx];
  if (typeof pre !== 'number' || typeof post !== 'number') {
    throw new Error('tx is missing pre/post balance metadata');
  }
  const delta = post - pre;
  if (delta < BOOSTER_PRICE_LAMPORTS) {
    throw new Error(`underpaid: treasury received ${delta} lamports, need ${BOOSTER_PRICE_LAMPORTS}`);
  }

  // Buyer must have signed the tx (and therefore appears as a signer key).
  // Verify the claimed buyer is among signers AND is the fee payer (idx 0).
  const buyerPk = new PublicKey(claimedBuyer);
  const feePayer = accountKeys[0];
  if (!feePayer || !feePayer.equals(buyerPk)) {
    throw new Error(`fee payer mismatch: claimed ${claimedBuyer}, actual ${feePayer?.toBase58()}`);
  }

  return {
    buyer: claimedBuyer,
    signature,
    lamports: delta,
    slot: tx.slot ?? 0,
  };
}

// ── Step 3: mint the Booster Pack Ticket NFT (Metaplex Core) ───────────────

/**
 * Build an Umi client against a specific RPC URL. We don't cache a single
 * Umi instance anymore because `mintTicketNft` walks the RPC pool when a
 * mint fails (e.g. dead Helius key, rate-limited public node) and needs to
 * be able to spin up a fresh Umi on the next URL.
 */
function umiFor(rpcUrl: string) {
  const t = treasury();
  if (!t) throw new Error('Booster treasury is not configured');
  const u = createUmi(rpcUrl).use(mplCore());
  const kp = u.eddsa.createKeypairFromSecretKey(t.secretKey);
  u.use(keypairIdentity(kp));
  return u;
}

/**
 * Order the RPC pool for mint attempts. We deliberately demote Helius-with-
 * a-suspect-key to the back so a misconfigured HELIUS_API_KEY env (which we
 * have seen return -32401 "invalid api key") doesn't gate the whole mint.
 * Public nodes go first because Metaplex Core mint is a single small tx
 * that any healthy mainnet RPC will land cheaply.
 */
function mintRpcOrder(): string[] {
  const PUBLIC_FIRST = [
    'https://solana-rpc.publicnode.com',
    'https://solana-mainnet.public.blastapi.io',
    'https://solana.drpc.org',
    'https://api.mainnet-beta.solana.com',
  ];
  const others = RPC_POOL.filter(u => !PUBLIC_FIRST.includes(u));
  // De-dupe while preserving order.
  return Array.from(new Set([...PUBLIC_FIRST, ...others]));
}

export type MintedTicket = {
  mintAddress: string;
  signature: string;
};

/**
 * Mint a Booster Pack Ticket Metaplex Core asset to `ownerAddress`. The
 * treasury keypair (mint authority) pays the ~0.0015 SOL rent. `ticketNumber`
 * is appended to the on-chain name so each ticket is uniquely identifiable.
 */
export async function mintTicketNft(
  ownerAddress: string, ticketNumber: number,
): Promise<MintedTicket> {
  const urls = mintRpcOrder();
  let lastErr: any = null;
  for (const url of urls) {
    try {
      const u = umiFor(url);
      const asset = generateSigner(u);
      const res = await create(u, {
        asset,
        name: `Booster Pack Ticket #${ticketNumber}`,
        uri: METADATA_URI,
        owner: umiPublicKey(ownerAddress),
      }).sendAndConfirm(u, { confirm: { commitment: 'confirmed' } });
      console.log(`[booster-mint] minted #${ticketNumber} via ${url}`);
      return {
        mintAddress: asset.publicKey.toString(),
        signature: Buffer.from(res.signature).toString('base64'),
      };
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      // Helpful diagnostics for the most common failure modes.
      const looksLikeAuth = /401|invalid api key|unauthor/i.test(msg);
      const looksLikeRate = /429|rate limit|too many/i.test(msg);
      console.warn(`[booster-mint] mint via ${url} failed${looksLikeAuth ? ' (auth)' : looksLikeRate ? ' (rate-limit)' : ''}: ${msg}`);
      lastErr = e;
      continue;
    }
  }
  throw new Error(`mint failed on every RPC in pool: ${String(lastErr?.message ?? lastErr)}`);
}
