// src/wallet.ts
// Lightweight browser wallet connectors — no external SDKs.
// EVM via window.ethereum (MetaMask, Rabby, Coinbase Wallet, OKX, ...)
// Solana via window.solana (Phantom).

export type WalletChain = 'evm' | 'solana';
export type ConnectedWallet = { chain: WalletChain; address: string };

declare global {
  interface Window {
    ethereum?: any;
    solana?: any;
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
  const sol = window.solana;
  if (!sol || !sol.isPhantom) throw new Error('No Solana wallet detected. Install Phantom.');
  const res = await sol.connect();
  const address = String(res?.publicKey?.toString?.() ?? sol.publicKey?.toString?.() ?? '');
  if (!address) throw new Error('Wallet returned no public key.');
  return { chain: 'solana', address };
}

/** Returns the live Phantom provider (with signTransaction), connecting if needed. */
export async function getPhantom(): Promise<any> {
  const sol = window.solana;
  if (!sol || !sol.isPhantom) throw new Error('Phantom wallet required for $MASTER wagers. Install Phantom.');
  if (!sol.publicKey) await sol.connect();
  return sol;
}
