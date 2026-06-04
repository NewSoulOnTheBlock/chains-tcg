// src/boosters-api.ts
// HTTP client for the /api/boosters/* endpoints.
//
// NOTE: backend currently returns MOCK data — there's no on-chain mint yet.
// See plan.md (session-state) for the full booster pipeline plan. The shape
// of these calls is locked so when Phase 3/4 lands (Anchor program + treasury
// service) the wire-up only needs server-side changes.

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch { /* noop */ }
    throw new Error(`${path}: ${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
  }
  return res.json() as Promise<T>;
}

export type BoosterSupply = {
  minted: number;
  cap: number;
  remaining: number;
  priceSol: number;
  priceMaster: number;
  /** 'preview' = mock backend, 'live' = on-chain mints active. */
  mode: 'preview' | 'live';
};

export type SealedPack = {
  packId: string;
  mintedAt: number;
  /** ISO mint address once on-chain; null in preview mode. */
  nftMint: string | null;
};

export type OwnedCard = {
  cardId: string;
  qty: number;
  /** Per-copy mint addresses; empty in preview mode. */
  nftMints: string[];
};

export type BoosterInventory = {
  sealed: SealedPack[];
  owned: OwnedCard[];
};

export async function getBoosterSupply(): Promise<BoosterSupply> {
  return http<BoosterSupply>('/api/boosters/supply');
}

export async function getBoosterInventory(wallet: string): Promise<BoosterInventory> {
  return http<BoosterInventory>(`/api/boosters/inventory/${encodeURIComponent(wallet)}`);
}

export type BuyIntentResponse =
  | { ok: true; packId: string; mode: 'preview' | 'live'; /** future fields: txBase64, mintAddress, etc. */ }
  | { ok: false; error: string };

export async function buyBoosterIntent(
  wallet: string,
  currency: 'sol' | 'master',
): Promise<BuyIntentResponse> {
  return http<BuyIntentResponse>('/api/boosters/buy-intent', {
    method: 'POST',
    body: JSON.stringify({ wallet, currency }),
  });
}

export type OpenIntentResponse =
  | { ok: true; cardIds: string[]; mode: 'preview' | 'live' }
  | { ok: false; error: string };

export async function openBoosterPack(
  wallet: string,
  packId: string,
): Promise<OpenIntentResponse> {
  return http<OpenIntentResponse>('/api/boosters/open-intent', {
    method: 'POST',
    body: JSON.stringify({ wallet, packId }),
  });
}
