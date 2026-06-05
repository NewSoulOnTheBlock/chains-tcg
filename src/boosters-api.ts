// src/boosters-api.ts
// HTTP client for the REAL Booster Pack Ticket mint flow (Metaplex Core).
//
// Flow:
//   1. getBoosterSupply()                 → price + treasury pubkey + remaining
//   2. buildBuyIntent(wallet)             → unsigned tx (SOL transfer to treasury)
//   3. confirmPayment(wallet, signature)  → server mints NFT ticket to wallet
//   4. getMyTickets(wallet)               → list owned tickets + redemption status
//   5. redeemDigital / redeemPhysical / redeemMerch

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

// ── Supply / config ────────────────────────────────────────────────────────

export type BoosterSupply = {
  minted: number;
  cap: number;
  remaining: number;
  priceSol: number;
  priceLamports: number;
  treasury: string | null;
  mode: 'live' | 'preview';
};

export async function getBoosterSupply(): Promise<BoosterSupply> {
  return http<BoosterSupply>('/api/boosters/supply');
}

// ── Mint flow ──────────────────────────────────────────────────────────────

export type BuyIntent = {
  ok: true;
  txBase64: string;
  treasury: string;
  lamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
};

export async function buildBuyIntent(wallet: string): Promise<BuyIntent> {
  return http<BuyIntent>('/api/boosters/buy-intent', {
    method: 'POST',
    body: JSON.stringify({ wallet }),
  });
}

export type ShippingAddress = {
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  email?: string;
};

export type TicketRow = {
  mintAddress: string;
  buyerWallet: string;
  ticketNumber: number;
  paymentSig: string;
  priceSol: number;
  mintedAt: number;
  digitalRedeemedAt: number | null;
  digitalCardIds: string[] | null;
  physicalRedeemedAt: number | null;
  physicalAddress: ShippingAddress | null;
  physicalTracking: string | null;
  merchRedeemedAt: number | null;
  merchAddress: ShippingAddress | null;
  merchTracking: string | null;
};

export type ConfirmResult = {
  ok: true;
  ticket: TicketRow;
  mintSignature: string;
};

export async function confirmPayment(wallet: string, signature: string): Promise<ConfirmResult> {
  return http<ConfirmResult>('/api/boosters/confirm', {
    method: 'POST',
    body: JSON.stringify({ wallet, signature }),
  });
}

// ── Inventory + redemption ─────────────────────────────────────────────────

export async function getMyTickets(wallet: string): Promise<{ wallet: string; tickets: TicketRow[] }> {
  return http(`/api/boosters/tickets/${encodeURIComponent(wallet)}`);
}

export async function redeemDigital(mintAddress: string, wallet: string): Promise<{ ok: true; cardIds: string[]; ticket: TicketRow }> {
  return http('/api/boosters/redeem-digital', {
    method: 'POST',
    body: JSON.stringify({ mintAddress, wallet }),
  });
}

export async function redeemPhysical(mintAddress: string, wallet: string, address: ShippingAddress): Promise<{ ok: true; ticket: TicketRow }> {
  return http('/api/boosters/redeem-physical', {
    method: 'POST',
    body: JSON.stringify({ mintAddress, wallet, address }),
  });
}

export async function redeemMerch(mintAddress: string, wallet: string, address: ShippingAddress): Promise<{ ok: true; ticket: TicketRow }> {
  return http('/api/boosters/redeem-merch', {
    method: 'POST',
    body: JSON.stringify({ mintAddress, wallet, address }),
  });
}
