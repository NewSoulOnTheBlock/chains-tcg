// src/wallet.ts
// Lightweight browser wallet connectors — no external SDKs.
// EVM via window.ethereum (MetaMask, Rabby, Coinbase Wallet, OKX, ...)
// Solana via window.solana (Phantom), window.solflare (Solflare), window.backpack (Backpack).

export type WalletChain = 'evm' | 'solana';
export type ConnectedWallet = { chain: WalletChain; address: string };
export type SolanaWalletKind = 'phantom' | 'solflare' | 'backpack';

declare global {
  interface Window {
    ethereum?: any;
    solana?: any;
    solflare?: any;
    backpack?: any;
    phantom?: any;
  }
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
  // Try Phantom first, then Solflare, then Backpack.
  for (const kind of ['phantom', 'solflare', 'backpack'] as SolanaWalletKind[]) {
    const p = getSolanaProviderRaw(kind);
    if (p) {
      const w = await connectSolanaWith(kind);
      return w;
    }
  }
  throw new Error('No Solana wallet detected. Install Phantom, Solflare, or Backpack.');
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
    // Phantom may inject as window.phantom.solana OR window.solana with isPhantom.
    if (window.phantom?.solana?.isPhantom) return window.phantom.solana;
    if (window.solana?.isPhantom) return window.solana;
    return null;
  }
  if (kind === 'solflare') {
    if (window.solflare?.isSolflare) return window.solflare;
    return null;
  }
  if (kind === 'backpack') {
    // Backpack exposes window.backpack (Solana), and sometimes window.xnft.solana.
    if (window.backpack?.isBackpack) return window.backpack;
    if ((window as any).xnft?.solana) return (window as any).xnft.solana;
    return null;
  }
  return null;
}

function labelFor(kind: SolanaWalletKind): string {
  return kind === 'phantom' ? 'Phantom' : kind === 'solflare' ? 'Solflare' : 'Backpack';
}

/** Returns which Solana wallets are currently installed. */
export function detectSolanaWallets(): Array<{ kind: SolanaWalletKind; label: string; installed: boolean }> {
  return (['phantom', 'solflare', 'backpack'] as SolanaWalletKind[]).map(kind => ({
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
