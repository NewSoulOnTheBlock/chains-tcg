// src/wallet.ts
// Lightweight browser wallet connectors — no external SDKs.
// EVM via window.ethereum (MetaMask, Rabby, Coinbase Wallet, OKX, ...)
// Solana via legacy window.<name> injection AND the Wallet Standard protocol
// (https://github.com/wallet-standard/wallet-standard), which is how modern
// Solana wallets — including Jupiter Mobile, Glow, Coinbase, OKX, etc. —
// announce themselves to dApps.

import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

export type WalletChain = 'evm' | 'solana';
export type ConnectedWallet = { chain: WalletChain; address: string };
export type SolanaWalletKind = 'phantom' | 'solflare' | 'backpack' | 'jupiter';

declare global {
  interface Window {
    ethereum?: any;
    solana?: any;
    solflare?: any;
    backpack?: any;
    phantom?: any;
    jupiter?: any;
  }
}

// ─── Wallet Standard discovery ─────────────────────────────────────────────
// The Wallet Standard handshake works in two directions:
//   • Wallets dispatch  'wallet-standard:register-wallet' with detail = (api) => api.register(wallet)
//   • Apps  dispatch  'wallet-standard:app-ready' with detail = { register } so already-loaded wallets can self-register
// We do both as soon as this module loads in a browser.
const _wsWallets: any[] = [];
const _wsListeners: Array<() => void> = [];

function _addWalletStandardWallet(w: any) {
  if (!w || _wsWallets.includes(w)) return;
  _wsWallets.push(w);
  for (const fn of _wsListeners) { try { fn(); } catch { /* noop */ } }
}

if (typeof window !== 'undefined') {
  const register = (...wallets: any[]) => {
    for (const w of wallets) _addWalletStandardWallet(w);
    return () => { /* unregister noop */ };
  };
  // Listen for wallets registering themselves.
  window.addEventListener('wallet-standard:register-wallet', (ev: any) => {
    try { ev?.detail?.({ register }); } catch { /* noop */ }
  });
  // Tell already-loaded wallets we're here.
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', {
      detail: { register },
    }));
  } catch { /* noop on very old browsers */ }
}

/** Find a Wallet Standard wallet whose `name` contains the given substring (case-insensitive). */
function findWalletStandardWallet(nameNeedle: string): any | null {
  const needle = nameNeedle.toLowerCase();
  for (const w of _wsWallets) {
    const name = String(w?.name ?? '').toLowerCase();
    if (name.includes(needle)) return w;
  }
  return null;
}

/**
 * Wrap a Wallet Standard wallet in the same `{ publicKey, signTransaction,
 * connect, disconnect }` shape that the rest of the app expects. We keep a
 * cache keyed on the underlying wallet so repeat lookups return the same
 * adapter (so React state comparisons work).
 */
const _wsAdapterCache = new WeakMap<any, any>();
function wrapWalletStandard(wallet: any, friendlyName: string): any {
  const cached = _wsAdapterCache.get(wallet);
  if (cached) return cached;

  const adapter: any = {
    _wsWallet: wallet,
    _label: friendlyName,
    publicKey: null as PublicKey | null,
    isWalletStandard: true,
    async connect(_opts?: { onlyIfTrusted?: boolean }) {
      const connectFeature = wallet?.features?.['standard:connect'];
      if (!connectFeature?.connect) {
        throw new Error(`${friendlyName} does not expose standard:connect.`);
      }
      const silent = !!_opts?.onlyIfTrusted;
      const res = await connectFeature.connect(silent ? { silent: true } : undefined);
      const accounts = res?.accounts ?? wallet?.accounts ?? [];
      const acct = accounts[0];
      if (!acct) throw new Error(`${friendlyName} returned no account.`);
      adapter.publicKey = new PublicKey(acct.address);
      adapter._account = acct;
      return { publicKey: adapter.publicKey };
    },
    async disconnect() {
      const f = wallet?.features?.['standard:disconnect'];
      try { await f?.disconnect?.(); } catch { /* noop */ }
      adapter.publicKey = null;
      adapter._account = null;
    },
    async signTransaction(tx: Transaction | VersionedTransaction): Promise<any> {
      const acct = adapter._account ?? wallet?.accounts?.[0];
      if (!acct) throw new Error(`${friendlyName} is not connected.`);
      const f = wallet?.features?.['solana:signTransaction'];
      if (!f?.signTransaction) {
        // Some wallets only expose signAndSendTransaction; we can't satisfy
        // the wager flow with that because we co-sign with the escrow keypair.
        throw new Error(`${friendlyName} does not support signTransaction. Use a different wallet for $MASTER wagers.`);
      }
      // Wallet Standard's signTransaction takes serialized bytes for the
      // 'solana:signTransaction' feature.
      const isVersioned = typeof (tx as VersionedTransaction).version === 'number';
      const txBytes = isVersioned
        ? (tx as VersionedTransaction).serialize()
        : (tx as Transaction).serialize({ requireAllSignatures: false, verifySignatures: false });
      const out = await f.signTransaction({
        account: acct,
        transaction: txBytes,
        chain: 'solana:mainnet',
      });
      const arr = Array.isArray(out) ? out : [out];
      const signedBytes: Uint8Array = arr[0]?.signedTransaction ?? arr[0];
      if (!signedBytes) throw new Error(`${friendlyName} returned no signed transaction.`);
      return isVersioned
        ? VersionedTransaction.deserialize(signedBytes)
        : Transaction.from(signedBytes);
    },
  };
  _wsAdapterCache.set(wallet, adapter);
  // Pre-populate publicKey + account from any already-authorized session.
  try {
    const acct = wallet?.accounts?.[0];
    if (acct?.address) {
      adapter.publicKey = new PublicKey(acct.address);
      adapter._account = acct;
    }
  } catch { /* noop */ }
  // Subscribe to wallet account changes so .publicKey stays current.
  try {
    const ev = wallet?.features?.['standard:events'];
    ev?.on?.('change', (props: any) => {
      if (props && 'accounts' in props) {
        const acct = props.accounts?.[0];
        if (acct?.address) {
          adapter.publicKey = new PublicKey(acct.address);
          adapter._account = acct;
        } else {
          adapter.publicKey = null;
          adapter._account = null;
        }
      }
    });
  } catch { /* noop */ }
  return adapter;
}

export function shortAddr(a: string | null | undefined): string {
  if (!a) return '';
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export async function connectEvm(): Promise<ConnectedWallet> {
  const eth = window.ethereum;
  if (!eth) throw new Error('No EVM wallet detected. Install MetaMask, Rabby, or Coinbase Wallet.');
  const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
  const address = (accounts?.[0] || '').toLowerCase();
  if (!address) throw new Error('Wallet returned no account.');
  return { chain: 'evm', address };
}

export async function connectSolana(): Promise<ConnectedWallet> {
  // Try Phantom first, then Solflare, then Backpack, then Jupiter.
  for (const kind of ['phantom', 'solflare', 'backpack', 'jupiter'] as SolanaWalletKind[]) {
    const p = getSolanaProviderRaw(kind);
    if (p) {
      const w = await connectSolanaWith(kind);
      return w;
    }
  }
  throw new Error('No Solana wallet detected. Install Phantom, Solflare, Backpack, or Jupiter.');
}

export async function connectSolanaWith(kind: SolanaWalletKind): Promise<ConnectedWallet> {
  const provider = getSolanaProviderRaw(kind);
  if (!provider) throw new Error(`${labelFor(kind)} not detected. Install the extension.`);
  await robustSolanaConnect(provider, kind);
  const address = String(provider.publicKey?.toString?.() ?? '');
  if (!address) throw new Error(`${labelFor(kind)} returned no public key.`);
  return { chain: 'solana', address };
}

/**
 * Phantom (and other Solana wallets) occasionally throw "Unexpected error"
 * (-32603) when `.connect()` is called against a stale provider — most often
 * after a page navigation, after the user manually disconnected from the
 * extension, or when a previous connect popup never resolved. We work around
 * this with a 3-step handshake:
 *   1. Try eager `connect({ onlyIfTrusted: true })` — silent, no popup.
 *   2. If that fails, call `disconnect()` to clear any stuck state.
 *   3. Call `connect()` normally to show the popup.
 * Any thrown error from steps 1+2 is swallowed; only step 3 surfaces errors.
 */
async function robustSolanaConnect(provider: any, kind: SolanaWalletKind): Promise<void> {
  // Already have a live publicKey? Trust it.
  if (provider.publicKey) return;
  // Step 1: eager (no popup) — many wallets resolve here on repeat visits.
  try {
    await provider.connect({ onlyIfTrusted: true });
    if (provider.publicKey) return;
  } catch { /* expected on first visit / cleared trust */ }
  // Step 2: clear any stuck session.
  try { await provider.disconnect?.(); } catch { /* noop */ }
  // Step 3: real connect. Map known errors to friendlier messages, and
  // auto-retry once if Phantom's MV3 service worker was asleep.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await provider.connect();
      return;
    } catch (e: any) {
      const code = e?.code;
      const msg  = String(e?.message ?? '');
      if (code === 4001 || /reject/i.test(msg)) {
        throw new Error(`${labelFor(kind)} connection cancelled.`);
      }
      // Phantom MV3 service-worker-asleep symptom: content script logs
      // "Failed to send message to service worker" and connect rejects with
      // a generic -32603. First retry after a short delay usually succeeds
      // because the failed call itself wakes the worker.
      const isWorkerAsleep =
        code === -32603 ||
        /unexpected/i.test(msg) ||
        /disconnected port/i.test(msg) ||
        /service worker/i.test(msg);
      // Extension context invalidated: Phantom was reloaded/updated while
      // this page was still open. The injected provider is now a zombie
      // pointing into a dead extension context — no retry helps, the page
      // itself must be reloaded to get a fresh content-script injection.
      const isContextDead = /context invalidated/i.test(msg);
      if (isContextDead) {
        throw new Error(
          `${labelFor(kind)} was reloaded or updated while this page was open, so its connection to the page is broken. Please reload the page (Ctrl+R / Cmd+R) and try again.`
        );
      }
      if (isWorkerAsleep && attempt === 0) {
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      if (isWorkerAsleep) {
        throw new Error(
          `${labelFor(kind)} is sleeping (known Phantom 26.x bug). To wake it: click the ${labelFor(kind)} extension icon in your browser toolbar so the popup opens, then immediately click Connect here again. If that fails, disable and re-enable the extension in chrome://extensions.`
        );
      }
      throw e;
    }
  }
}

function getSolanaProviderRaw(kind: SolanaWalletKind): any {
  if (kind === 'phantom') {
    if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
    if (window.solana?.isPhantom) return window.solana;
    const ws = findWalletStandardWallet('phantom');
    if (ws) return wrapWalletStandard(ws, 'Phantom');
    return null;
  }
  if (kind === 'solflare') {
    if (window.solflare?.isSolflare) return window.solflare;
    const ws = findWalletStandardWallet('solflare');
    if (ws) return wrapWalletStandard(ws, 'Solflare');
    return null;
  }
  if (kind === 'backpack') {
    if (window.backpack?.isBackpack) return window.backpack;
    if ((window as any).xnft?.solana) return (window as any).xnft.solana;
    const ws = findWalletStandardWallet('backpack');
    if (ws) return wrapWalletStandard(ws, 'Backpack');
    return null;
  }
  if (kind === 'jupiter') {
    // Jupiter Mobile (and the in-app browser) inject via the Wallet Standard.
    // Some legacy builds expose window.jupiter — we check both.
    if ((window as any).jupiter?.solana?.isJupiter) return (window as any).jupiter.solana;
    if ((window as any).jupiter?.isJupiter) return (window as any).jupiter;
    if ((window as any).jupiter?.solana) return (window as any).jupiter.solana;
    const ws =
      findWalletStandardWallet('jupiter') ||
      findWalletStandardWallet('jup');
    if (ws) return wrapWalletStandard(ws, 'Jupiter');
    return null;
  }
  return null;
}

function labelFor(kind: SolanaWalletKind): string {
  return kind === 'phantom'  ? 'Phantom'
       : kind === 'solflare' ? 'Solflare'
       : kind === 'backpack' ? 'Backpack'
       : kind === 'jupiter'  ? 'Jupiter'
       : 'Wallet';
}

/** Returns which Solana wallets are currently installed. */
export function detectSolanaWallets(): Array<{ kind: SolanaWalletKind; label: string; installed: boolean }> {
  return (['phantom', 'solflare', 'backpack', 'jupiter'] as SolanaWalletKind[]).map(kind => ({
    kind,
    label: labelFor(kind),
    installed: !!getSolanaProviderRaw(kind),
  }));
}

/**
 * Returns a live Solana wallet provider (with publicKey + signTransaction) for the
 * given wallet kind, connecting if needed. Throws if the wallet is not installed.
 */
export async function getSolanaWallet(kind: SolanaWalletKind = 'phantom'): Promise<any> {
  const provider = getSolanaProviderRaw(kind);
  if (!provider) throw new Error(`${labelFor(kind)} wallet required. Install the extension to wager $MASTER.`);
  await robustSolanaConnect(provider, kind);
  return provider;
}

/** Back-compat helper — defaults to Phantom for existing call sites. */
export async function getPhantom(): Promise<any> {
  return getSolanaWallet('phantom');
}
