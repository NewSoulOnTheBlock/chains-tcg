// src/pack-evm.ts
// Client wiring for the CardPack booster contract on Robinhood Chain (chain 4663).
// Buying a pack mints 5 random cards + 1 foil random card as NFTs; this decodes the
// PackMinted event and maps card indexes back to the in-game cards for the reveal.
//
// ─── WHY THIS FILE DOES NOT USE THE BACKEND'S RPC PROXY ─────────────────────
//
// `RPC_URL` (`${VITE_API_BASE}/rpc/evm`) is scoped to ONE network chosen by
// server env — production answers `eth_chainId` with `0xaa36a7`, i.e. Sepolia.
// This game runs on Robinhood Chain (4663), so the proxy cannot read this
// contract at all: no price, no balance, no `PackMinted` receipt to decode.
//
// The migration rule it looks like this breaks is "no RPC credential may
// appear in the bundle" (INTEGRATION.md §8.5). Read that precisely: the
// problem was a CREDENTIAL. This file used to carry a live Alchemy key plus a
// `VITE_ROBINHOOD_RPC` override, and both are gone for good. What replaces
// them is Robinhood Chain's own PUBLIC, KEYLESS endpoint — there is no secret
// in it, nothing to rotate, and nothing an attacker gains by reading the
// bundle. Verified: it answers `eth_chainId` with `0x1237`.
//
// It is deliberately a hardcoded constant rather than a `VITE_*` variable. An
// env-injected URL is exactly how the Alchemy key got into the bundle in the
// first place, and there is only ever one right value here.
//
// Writes never went through any RPC we control: `mintPack` broadcasts through
// the user's own injected wallet, which is what the proxy's
// `eth_sendRawTransaction` 403 requires anyway.

import {
  createPublicClient, createWalletClient, custom, http, defineChain,
  parseAbi, decodeEventLog, type Address,
} from 'viem';
import { ROBINHOOD_CHAIN_PARAMS } from './wallet';
import { readEnv } from './api/config';
import { CARDS } from './cards';

/**
 * Robinhood Chain's public JSON-RPC. No API key, no account, no rate-limit
 * token — safe to ship. Do NOT replace this with an env variable.
 */
export const ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

/** Blockscout, for linking a confirmed mint transaction. */
export const ROBINHOOD_EXPLORER_URL = 'https://robinhoodchain.blockscout.com';

/** Explorer link for a transaction hash. */
export function robinhoodTxUrl(hash: string): string {
  return `${ROBINHOOD_EXPLORER_URL}/tx/${hash}`;
}

/**
 * Pack minting reads and writes real chain state through the public endpoint
 * above and the user's own wallet, so it is available.
 *
 * Note this is INDEPENDENT of the backend's own booster tickets
 * (`/wager/boosters/*`), which report `mintingEnabled: false` and never issue
 * an NFT (see `src/api/wager.ts`). These are two different products.
 */
// OFF while packs move to Solana / $GORE (see docs/solana-migration.md). The
// Boosters page shows COMING SOON and `open()` refuses to mint.
export const PACK_MINTING_AVAILABLE: boolean = false;

/** Shown if the flag above is ever turned off. */
export const PACK_MINTING_UNAVAILABLE_MESSAGE =
  'Booster packs are on their way. Minting opens soon.';

/**
 * CardPack address. Read via the sanctioned `readEnv` (config.ts) so Vite and
 * Node (vitest / tsx) agree on it and a test or script can override it through
 * `process.env.VITE_CARD_PACK`; a bare `import.meta.env` read could not be
 * overridden that way (client-api-15). The literal is the one documented mainnet
 * fallback.
 */
export const CARD_PACK = ((readEnv('VITE_CARD_PACK') as string | undefined) ||
  '0x57200fb533b33823f8bd2ac8f3649e3b643830b3') as Address;
/** Display-only default price. NOT used as an on-chain fallback — see fetchPackPrice. */
export const PACK_PRICE_ETH = '0.0035';
export const ROBINHOOD_CHAIN_ID = 4663;
/** Robinhood Chain testnet, for reference — this build targets mainnet only. */
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
// Gas limit we submit mintPack with (this chain's estimateGas is unreliable).
export const MINT_GAS_LIMIT = 1_500_000n;
/** Cap the receipt wait so a dropped tx doesn't spin the UI forever. */
export const RECEIPT_TIMEOUT_MS = 120_000;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID, name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: ROBINHOOD_EXPLORER_URL } },
});

const packAbi = parseAbi([
  'function mintPack() payable returns (uint256[] ids)',
  'function packPrice() view returns (uint256)',
  'event PackMinted(address indexed buyer, uint256[] tokenIds, uint256[] cardIndexes, uint256 foilTokenId)',
]);

// Ordered non-node cards = the on-chain card-index space. MUST match gen-nft-metadata.mts.
const CATALOG = Object.values(CARDS).filter((c) => c.type !== 'node');

export type RevealedCard = { index: number; id: string; name: string; image?: string; foil: boolean };

const pub = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });

function walletClient() {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error('No EVM wallet detected. Install MetaMask.');
  return createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
}

/**
 * Ensure the wallet is on Robinhood Chain, FAILING LOUDLY if it is not.
 *
 * The old version swallowed every switch error except 4902, so a user rejection
 * (4001) or a wallet that ignored the request fell straight through to
 * `writeContract`, which could send 0.0035 ETH on whatever chain the wallet was
 * actually on (client-api-13). Now a rejection throws, and — like
 * `connectRobinhoodChain` in wallet.ts — we read `eth_chainId` BACK and refuse
 * to proceed unless it is 4663, because `wallet_addEthereumChain` can resolve
 * without selecting the network.
 */
async function ensureChain(): Promise<void> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error('No EVM wallet detected. Install MetaMask.');

  if ((await getWalletChainId()) === ROBINHOOD_CHAIN_ID) return;

  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] });
  } catch (e: any) {
    if (e?.code === 4902 || /Unrecognized chain|not been added/i.test(String(e?.message ?? ''))) {
      await eth.request({ method: 'wallet_addEthereumChain', params: [ROBINHOOD_CHAIN_PARAMS] });
    } else {
      throw new Error(
        `Could not switch to Robinhood Chain (${ROBINHOOD_CHAIN_ID}). Approve the network switch in your wallet and try again.`,
      );
    }
  }

  const after = await getWalletChainId();
  if (after !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `Your wallet is still on chain ${after ?? '?'}. Booster mint only works on Robinhood Chain (${ROBINHOOD_CHAIN_ID}) — switch networks and try again.`,
    );
  }
}

/**
 * The CURRENT on-chain pack price. THROWS on an RPC failure rather than
 * guessing: the old fallback to a hardcoded 0.0035 ETH let a stale guess be
 * sent as `value` when the real price had changed, so the tx reverted and the
 * user ate the gas (client-api-14). Block the buy instead and let the caller
 * surface the error; `PACK_PRICE_ETH` is for DISPLAY only.
 */
export async function fetchPackPrice(): Promise<bigint> {
  try {
    return await pub.readContract({ address: CARD_PACK, abi: packAbi, functionName: 'packPrice' });
  } catch {
    throw new Error('Could not read the current pack price from the chain. Please try again in a moment.');
  }
}

/** Native ETH balance of an address on Robinhood Chain. */
export function getEthBalance(addr: Address): Promise<bigint> {
  return pub.getBalance({ address: addr });
}

/** The currently connected account (silent — no popup), or null. */
export async function getConnectedAccount(): Promise<Address | null> {
  const eth = (window as any).ethereum;
  if (!eth) return null;
  try {
    const accts: string[] = await eth.request({ method: 'eth_accounts' });
    return (accts?.[0] as Address) ?? null;
  } catch { return null; }
}

/** The wallet's current chain id (decimal), or null. */
export async function getWalletChainId(): Promise<number | null> {
  const eth = (window as any).ethereum;
  if (!eth) return null;
  try { return parseInt(await eth.request({ method: 'eth_chainId' }), 16); }
  catch { return null; }
}

/** Ask the wallet to switch to Robinhood Chain (adds it if unknown). Never silent. */
export async function switchToRobinhood(): Promise<void> {
  await ensureChain();
}

/** Authoritative cost estimate: contract price + a gas allowance at live gas price. */
export async function packCostEstimate(): Promise<{ price: bigint; gasCost: bigint; total: bigint }> {
  const price = await fetchPackPrice();
  let gasCost = 0n;
  try { gasCost = (await pub.getGasPrice()) * MINT_GAS_LIMIT; } catch { /* leave 0 if RPC can't price */ }
  return { price, gasCost, total: price + gasCost };
}

function decodePackFromReceipt(logs: readonly { address: string; data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]] | [] }[]): RevealedCard[] {
  for (const log of logs) {
    if (log.address.toLowerCase() !== CARD_PACK.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: packAbi, data: log.data, topics: log.topics as any });
      if (ev.eventName === 'PackMinted') {
        const a = ev.args as any;
        const idxs = a.cardIndexes as bigint[];
        const tokenIds = a.tokenIds as bigint[];
        const foilTokenId = a.foilTokenId as bigint;
        return idxs.map((bi, i) => {
          const index = Number(bi);
          const c = CATALOG[index];
          return { index, id: c?.id ?? String(index), name: c?.name ?? `#${index}`, image: c?.image, foil: tokenIds[i] === foilTokenId };
        });
      }
    } catch { /* not our event */ }
  }
  return [];
}

/**
 * Buy one booster pack. Submits the tx, invokes `onHash` as soon as the wallet
 * returns the hash (so the UI can advance to the pending state), then waits for
 * the on-chain receipt and decodes the authoritative PackMinted result.
 * Card results always come from the confirmed receipt — never the client.
 */
export async function mintPack(onHash?: (hash: `0x${string}`) => void): Promise<RevealedCard[]> {
  await ensureChain();
  const wc = walletClient();
  const [account] = await wc.getAddresses();
  const price = await fetchPackPrice(); // recheck price immediately before submit

  // Simulate (eth_call) FIRST: if the mint would revert — wrong price, sold
  // out, paused — this throws here, free, instead of after the user has signed
  // and paid gas for an on-chain revert (client-api-14).
  await pub.simulateContract({
    account, address: CARD_PACK, abi: packAbi, functionName: 'mintPack', value: price, gas: MINT_GAS_LIMIT,
  });

  const hash = await wc.writeContract({ account, address: CARD_PACK, abi: packAbi, functionName: 'mintPack', value: price, gas: MINT_GAS_LIMIT });
  onHash?.(hash);
  return waitAndDecode(hash);
}

/** Resume a pending mint after a refresh: wait for the known hash and decode. */
export async function resumePack(hash: `0x${string}`): Promise<RevealedCard[]> {
  return waitAndDecode(hash);
}

/**
 * Wait for a mint receipt with a bounded timeout and decode it.
 *
 * `waitForTransactionReceipt` with no `timeout` polls indefinitely, so a hash
 * dropped from the mempool leaves the UI's pending state unresolved forever
 * (client-api-14). Time out instead and tell the user to check the explorer;
 * `resumePack(hash)` can retry later.
 */
async function waitAndDecode(hash: `0x${string}`): Promise<RevealedCard[]> {
  let rcpt;
  try {
    rcpt = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
  } catch {
    throw new Error(
      `Still waiting on your mint. It may still confirm — check ${robinhoodTxUrl(hash)} and reopen Boosters to resume.`,
    );
  }
  if (rcpt.status !== 'success') throw new Error('Transaction reverted on-chain.');
  return decodePackFromReceipt(rcpt.logs as any);
}
