// src/pack-evm.ts
// Client wiring for the CardPack booster contract on Robinhood Chain (chain 4663).
// Buying a pack mints 5 random cards + 1 foil random card as NFTs; this decodes the
// PackMinted event and maps card indexes back to the in-game cards for the reveal.

import {
  createPublicClient, createWalletClient, custom, http, defineChain,
  parseEther, parseAbi, decodeEventLog, type Address,
} from 'viem';
import { CARDS } from './cards';

export const ROBINHOOD_RPC =
  (import.meta.env.VITE_ROBINHOOD_RPC as string) ||
  'https://robinhood-mainnet.g.alchemy.com/v2/h7y2nsAnaBKL98b6RHAsM';
export const CARD_PACK = ((import.meta.env.VITE_CARD_PACK as string) ||
  '0x57200fb533b33823f8bd2ac8f3649e3b643830b3') as Address;
export const PACK_PRICE_ETH = '0.0035';
export const ROBINHOOD_CHAIN_ID = 4663;
// Gas limit we submit mintPack with (this chain's estimateGas is unreliable).
export const MINT_GAS_LIMIT = 1_500_000n;

export const robinhoodChain = defineChain({
  id: 4663, name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC] } },
});

const packAbi = parseAbi([
  'function mintPack() payable returns (uint256[] ids)',
  'function packPrice() view returns (uint256)',
  'event PackMinted(address indexed buyer, uint256[] tokenIds, uint256[] cardIndexes, uint256 foilTokenId)',
]);

// Ordered non-node cards = the on-chain card-index space. MUST match gen-nft-metadata.mts.
const CATALOG = Object.values(CARDS).filter((c) => c.type !== 'node');

export type RevealedCard = { index: number; id: string; name: string; image?: string; foil: boolean };

const pub = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC) });

function walletClient() {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error('No EVM wallet detected. Install MetaMask.');
  return createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
}

async function ensureChain() {
  const eth = (window as any).ethereum;
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] });
  } catch (e: any) {
    if (e?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: [ROBINHOOD_RPC] }],
      });
    }
  }
}

export async function fetchPackPrice(): Promise<bigint> {
  try { return await pub.readContract({ address: CARD_PACK, abi: packAbi, functionName: 'packPrice' }); }
  catch { return parseEther(PACK_PRICE_ETH); }
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

  const hash = await wc.writeContract({ account, address: CARD_PACK, abi: packAbi, functionName: 'mintPack', value: price, gas: MINT_GAS_LIMIT });
  onHash?.(hash);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error('Transaction reverted on-chain.');
  return decodePackFromReceipt(rcpt.logs as any);
}

/** Resume a pending mint after a refresh: wait for the known hash and decode. */
export async function resumePack(hash: `0x${string}`): Promise<RevealedCard[]> {
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== 'success') throw new Error('Transaction reverted on-chain.');
  return decodePackFromReceipt(rcpt.logs as any);
}
