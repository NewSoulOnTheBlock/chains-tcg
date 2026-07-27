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

/** Buy one booster pack; resolves to the 5 cards + 1 foil that were minted. */
export async function mintPack(): Promise<RevealedCard[]> {
  await ensureChain();
  const wc = walletClient();
  const [account] = await wc.getAddresses();
  const price = await fetchPackPrice();

  // Explicit gas limit: this chain's estimateGas can return a bogus huge value for
  // value-bearing calls, which then exceeds the per-tx cap. mintPack is ~430k gas.
  const hash = await wc.writeContract({ account, address: CARD_PACK, abi: packAbi, functionName: 'mintPack', value: price, gas: 1_500_000n });
  const rcpt = await pub.waitForTransactionReceipt({ hash });

  for (const log of rcpt.logs) {
    if (log.address.toLowerCase() !== CARD_PACK.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: packAbi, data: log.data, topics: log.topics });
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
