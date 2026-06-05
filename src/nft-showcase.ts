// src/nft-showcase.ts
//
// Tiny DAS (Digital Asset Standard) helper for showing the Sproto Gremlin
// NFT collection on the in-game profile screen. Falls back gracefully when
// no DAS-capable RPC is available.

export const SPROTO_COLLECTION_MINT = '5Vz7xGnYzVKVyWZVRThZpAC3zLZHJHgEtPZSMa736MSU';

/**
 * The 10 Sproto Gremlin Core assets minted from the treasury wallet.
 * These are checked as a fallback when DAS isn't available or hasn't
 * indexed the assets yet. They were minted standalone (no Collection
 * grouping was set at mint time), so DAS won't return them under the
 * collection query above — knowing their mints lets us still surface them.
 */
export const KNOWN_SPROTO_MINTS: string[] = [
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

export type OwnedNft = {
  mint: string;
  name: string;
  image: string;
  number?: number;          // e.g. 1..10 if the on-chain name encodes "#N"
};

/**
 * RPC pool. DAS is widely supported on Helius; public nodes don't have it.
 * We try whichever URL the app is already configured to use first, then
 * a couple of DAS-friendly endpoints.
 */
function dasRpcPool(): string[] {
  const env = (import.meta as any)?.env?.VITE_SOLANA_RPC as string | undefined;
  const pool: string[] = [];
  if (env && /^https?:\/\//.test(env)) pool.push(env);
  // Known DAS endpoints that work without an API key in dev. These may rate-
  // limit; we never throw if they fail.
  pool.push('https://rpc.ankr.com/solana');
  pool.push('https://mainnet.helius-rpc.com');
  return Array.from(new Set(pool));
}

async function dasCall<T = any>(method: string, params: any): Promise<T | null> {
  for (const url of dasRpcPool()) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.error) continue;
      if (j?.result) return j.result as T;
    } catch {
      // try next URL
    }
  }
  return null;
}

function parseEditionNumber(name: string): number | undefined {
  const m = /#(\d+)/.exec(name);
  return m ? Number(m[1]) : undefined;
}

/**
 * List Sproto Gremlin NFTs owned by `walletAddress`. Combines:
 *   1. DAS `getAssetsByOwner` filtered by collection grouping.
 *   2. Per-asset `getAsset` lookup of the 10 known mints (fallback).
 */
export async function listOwnedSprotoGremlins(walletAddress: string): Promise<OwnedNft[]> {
  if (!walletAddress) return [];

  const found = new Map<string, OwnedNft>();

  // ── 1. DAS by collection ────────────────────────────────────────────────
  const byOwner = await dasCall<{ items: any[] }>('getAssetsByOwner', {
    ownerAddress: walletAddress,
    page: 1,
    limit: 200,
  });
  if (byOwner?.items?.length) {
    for (const it of byOwner.items) {
      const groups = it?.grouping ?? [];
      const inCollection = groups.some(
        (g: any) => g?.group_key === 'collection' && g?.group_value === SPROTO_COLLECTION_MINT,
      );
      if (!inCollection) continue;
      const name  = String(it?.content?.metadata?.name ?? 'Sproto Gremlin');
      const image = String(it?.content?.links?.image ?? it?.content?.files?.[0]?.uri
                            ?? '/sproto-gremlin.png');
      found.set(it.id, { mint: it.id, name, image, number: parseEditionNumber(name) });
    }
  }

  // ── 2. Fallback: known mints (Core assets minted standalone) ────────────
  for (const mint of KNOWN_SPROTO_MINTS) {
    if (found.has(mint)) continue;
    const asset = await dasCall<any>('getAsset', { id: mint });
    if (!asset) continue;
    const owner = asset?.ownership?.owner;
    if (owner !== walletAddress) continue;
    const name  = String(asset?.content?.metadata?.name ?? 'Sproto Gremlin');
    const image = String(asset?.content?.links?.image ?? asset?.content?.files?.[0]?.uri
                          ?? '/sproto-gremlin.png');
    found.set(mint, { mint, name, image, number: parseEditionNumber(name) });
  }

  const items = Array.from(found.values());
  items.sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
  return items;
}
