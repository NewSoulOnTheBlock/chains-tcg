// src/wallet.ts
// Lightweight browser wallet connectors — no external SDKs.
// EVM via injected providers (MetaMask, Rabby, Coinbase Wallet, OKX, ...),
// discovered through EIP-6963 so a browser with several wallets installed can
// connect and SIGN with the same one.
//
// ─── WHY THERE IS NO SOLANA HERE ANY MORE ───────────────────────────────────
// This game signs in and plays on Robinhood Chain only. The Solana connectors
// (`connectSolana`, Wallet-Standard discovery, `getSolanaWallet`, …) had no UI
// call site — App.tsx, Settings.tsx and Boosters.tsx only ever call
// `connectRobinhoodChain()` — yet importing `@solana/web3.js` here pulled
// several hundred KB (plus a Buffer polyfill) into first paint and registered
// Wallet-Standard listeners at import time (client-api-11). They are gone. The
// one place that still legitimately needs `@solana/web3.js` (`booster-mint.ts`,
// the server-side ticket mint) keeps its own import.

export type WalletChain = 'evm' | 'solana';
export type ConnectedWallet = { chain: WalletChain; address: string };

/** Minimal EIP-1193 surface we use. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * An EVM connection that also reports the EIP-155 network the wallet is
 * ACTUALLY on, read back from the provider after any switch, AND the exact
 * provider that connected — so the signing step uses the same one.
 *
 * Sign-in needs the chain id: the `chain` slug sent to `/auth/nonce` is the
 * identity namespace of `core.profiles (address, chain)` AND the `Chain ID:`
 * line the user reads in the message. Hardcoding the slug is how the message
 * ended up claiming "Chain ID: 1" for a wallet sitting on 4663. Derive it from
 * `chainId` instead — see `authChainForEvmChainId()` in `src/api/auth.ts`.
 */
export type ConnectedEvmWallet = ConnectedWallet & {
  chain: 'evm';
  chainId: number;
  /** The provider that returned the account. Pass to `signMessageEvm`. */
  provider: Eip1193Provider;
};

declare global {
  interface Window {
    ethereum?: Eip1193Provider & Record<string, unknown>;
  }
}

// ─── EIP-6963 multi-wallet discovery ────────────────────────────────────────
//
// With MetaMask + Rabby + Coinbase all installed, `window.ethereum` is whichever
// extension won the injection race, and the account that connected and the
// provider that signs can be two different wallets — the server then rejects a
// signature from a key it never issued a nonce for (client-api-22). EIP-6963
// lets each wallet announce itself with a stable identity so we can connect and
// sign through ONE chosen provider.

export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}
export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

const _announced: Eip6963ProviderDetail[] = [];

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (ev: Event) => {
    const detail = (ev as CustomEvent<Eip6963ProviderDetail>).detail;
    if (!detail?.info?.uuid || !detail.provider) return;
    if (_announced.some((d) => d.info.uuid === detail.info.uuid)) return;
    _announced.push(detail);
  });
  // Ask any already-loaded wallets to (re)announce.
  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { /* old browser */ }
}

/** Every injected EVM wallet that announced itself, for a picker UI. */
export function listEvmProviders(): Eip6963ProviderDetail[] {
  // Re-ping in case a wallet injected after the initial dispatch.
  if (typeof window !== 'undefined') {
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch { /* noop */ }
  }
  return [..._announced];
}

/** The provider the last connection used — the one sign-in must sign with. */
let _activeEvmProvider: Eip1193Provider | null = null;

/**
 * The provider to connect/sign with, given an optional explicit choice.
 *
 * Preference order: the caller's explicit pick → the single announced provider
 * → `window.ethereum`. When MORE THAN ONE wallet is announced and the caller
 * did not pick, the UI should present `listEvmProviders()` and pass the chosen
 * `provider`; absent that we fall back to `window.ethereum` (the user's default)
 * so behaviour is at least deterministic rather than injection-race-dependent.
 */
function selectEvmProvider(explicit?: Eip1193Provider): Eip1193Provider {
  if (explicit) return explicit;
  const announced = listEvmProviders();
  if (announced.length === 1) return announced[0].provider;
  const injected = typeof window !== 'undefined' ? window.ethereum : undefined;
  if (injected) return injected;
  if (announced.length > 0) return announced[0].provider;
  throw new Error('No EVM wallet detected. Install MetaMask, Rabby, or Coinbase Wallet.');
}

/**
 * The provider a later sign step should use. Returns the one the most recent
 * `connect*` used, falling back to a freshly selected default so a signature
 * is never taken from a different wallet than the one that connected.
 */
export function getActiveEvmProvider(): Eip1193Provider | null {
  if (_activeEvmProvider) return _activeEvmProvider;
  try { return selectEvmProvider(); } catch { return null; }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function shortAddr(a: string | null | undefined): string {
  if (!a) return '';
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export async function connectEvm(): Promise<ConnectedWallet> {
  const eth = selectEvmProvider();
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  const address = (accounts?.[0] || '').toLowerCase();
  if (!address) throw new Error('Wallet returned no account.');
  _activeEvmProvider = eth;
  return { chain: 'evm', address };
}

// ─── Robinhood Chain (Arbitrum L2 settling on Ethereum) ────────────────────
//
// THE ONLY NETWORK THIS GAME RUNS ON.
//
//   Chain ID   4663 (0x1237) mainnet · 46630 testnet
//   Gas token  ETH
//   RPC        https://rpc.mainnet.chain.robinhood.com   (public, no API key)
//   Explorer   https://robinhoodchain.blockscout.com
//
// The RPC endpoint is hardcoded on purpose. It carries no credential, so it is
// safe in the bundle — unlike the Alchemy key with an embedded API key that
// used to live here behind a `VITE_ROBINHOOD_RPC` override (INTEGRATION.md
// §8.5). Do not reintroduce an env variable for it.
//
// NOT TO BE CONFUSED WITH THE IN-GAME FACTIONS. `Color` values in `cards.ts`
// — `sol`, `eth`, `base`, `bnb`, `robinhood` — are card factions, the sets a
// deck is built from. They are flavour, not networks, and no card faction
// implies a chain the game talks to.
export const ROBINHOOD_CHAIN_PARAMS = {
  chainId: '0x1237',
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
};

export const ROBINHOOD_CHAIN = {
  chainId: 4663,
  chainIdHex: '0x1237',
  /** Testnet id, for reference. This build targets mainnet only. */
  testnetChainId: 46630,
  params: ROBINHOOD_CHAIN_PARAMS,
};

/** Is an injected EVM wallet (MetaMask etc.) present? */
export function detectEvmWallet(): { installed: boolean; label: string } {
  const announced = typeof window !== 'undefined' ? _announced : [];
  const injected = (typeof window !== 'undefined' ? window.ethereum : undefined) as
    | (Eip1193Provider & { isMetaMask?: boolean })
    | undefined;
  const installed = announced.length > 0 || !!injected;
  const label =
    announced.length === 1 ? announced[0].info.name
      : announced.length > 1 ? 'Browser Wallet'
      : injected?.isMetaMask ? 'MetaMask'
      : injected ? 'Browser Wallet'
      : 'MetaMask';
  return { installed, label };
}

/** Read the wallet's current EIP-155 chain id. Hex string in, number out. */
async function readEvmChainId(eth: Eip1193Provider): Promise<number> {
  const raw = await eth.request({ method: 'eth_chainId' });
  const n = typeof raw === 'string' ? Number.parseInt(raw, 16) : Number(raw);
  if (!Number.isFinite(n)) throw new Error('Wallet did not report a chain id.');
  return n;
}

/** MetaMask/EIP-1193 user-rejection. 4001 is the spec code; some wallets only set the text. */
function isUserRejection(e: unknown): boolean {
  const err = e as { code?: number; message?: string } | null;
  return err?.code === 4001 || /user rejected|user denied|rejected the request/i.test(String(err?.message ?? ''));
}

/**
 * Connect an injected EVM wallet and ensure it is on Robinhood Chain, adding the
 * network to the wallet if it isn't already there.
 *
 * This function is the ONLY authority on which network sign-in happens against.
 * It does not return until it has read `eth_chainId` back from the provider and
 * confirmed it is 4663 — a wallet that ignored or refused the switch produces a
 * clear error here rather than a signature over a message describing a network
 * the user is not on.
 *
 * It returns the provider it used; `_activeEvmProvider` is also set so
 * `signMessageEvm` signs with the SAME wallet. When several wallets are
 * installed, pass `opts.provider` from a `listEvmProviders()` picker.
 */
export async function connectRobinhoodChain(opts?: { provider?: Eip1193Provider }): Promise<ConnectedEvmWallet> {
  const eth = selectEvmProvider(opts?.provider);

  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  // Lowercase for EVM, matching `Session.address` and every `sameAddress`
  // comparison / cache key downstream (client-api-23). `connectEvm` already did
  // this; `connectRobinhoodChain` used to return the raw EIP-55 string.
  const address = (accounts?.[0] || '').toLowerCase();
  if (!address) throw new Error('Wallet returned no account.');

  // Pin the signing provider NOW, before any await that could change the race.
  _activeEvmProvider = eth;

  // Make sure the wallet is pointed at Robinhood Chain.
  if ((await readEvmChainId(eth)) !== ROBINHOOD_CHAIN.chainId) {
    try {
      await eth.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: ROBINHOOD_CHAIN.chainIdHex }],
      });
    } catch (e: unknown) {
      const err = e as { code?: number; message?: string };
      // 4902 = chain not added to the wallet yet → add it, which also switches.
      if (err?.code === 4902 || /Unrecognized chain|not been added/i.test(String(err?.message ?? ''))) {
        try {
          await eth.request({
            method: 'wallet_addEthereumChain',
            params: [ROBINHOOD_CHAIN.params],
          });
        } catch (addErr: unknown) {
          if (isUserRejection(addErr)) {
            throw new Error(
              'Robinhood Chain was not added. This game only runs on Robinhood Chain (4663) — approve adding the network in your wallet to sign in.',
            );
          }
          throw addErr;
        }
      } else if (isUserRejection(e)) {
        throw new Error(
          'Network switch rejected. This game only runs on Robinhood Chain (4663) — approve the switch in your wallet to sign in.',
        );
      } else {
        throw e;
      }
    }
  }

  // Read back rather than trust. `wallet_addEthereumChain` in particular can
  // succeed while leaving the wallet on its previous network.
  const chainId = await readEvmChainId(eth);
  if (chainId !== ROBINHOOD_CHAIN.chainId) {
    throw new Error(
      `Your wallet is still on chain ${chainId}. This game only runs on Robinhood Chain (${ROBINHOOD_CHAIN.chainId}) — switch networks in your wallet and try again.`,
    );
  }

  return { chain: 'evm', address, chainId, provider: eth };
}
