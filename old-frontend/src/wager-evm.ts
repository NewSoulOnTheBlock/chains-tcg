// src/wager-evm.ts
// Client-side wiring for the WagerEscrow contract on Robinhood Chain (chain 4663).
// The player's injected EVM wallet (MetaMask — same one used for sign-in) approves
// and deposits their stake; winners withdraw with claim(). Server-side create/settle
// live in src/wager-evm-server.ts.

import {
  createPublicClient, createWalletClient, custom, http, defineChain,
  keccak256, toBytes, parseAbi, type Address,
} from 'viem';

export const WAGER_CHAIN_ID = 4663;
export const ROBINHOOD_RPC =
  (import.meta.env.VITE_ROBINHOOD_RPC as string) ||
  'https://robinhood-mainnet.g.alchemy.com/v2/h7y2nsAnaBKL98b6RHAsM';

// Deployed 2026-07-27 (contracts/deployment.json). Override via env if redeployed.
export const WAGER_TOKEN = ((import.meta.env.VITE_WAGER_TOKEN as string) ||
  '0x66cf995bac9f4732c7cfed515811a79872a497c3') as Address;
export const WAGER_ESCROW = ((import.meta.env.VITE_WAGER_ESCROW as string) ||
  '0xdbc49ff2cf44d2ba1a844d80d1f82d472440cc3d') as Address;

export const robinhoodChain = defineChain({
  id: WAGER_CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC] } },
});

const escrowAbi = parseAbi([
  'function deposit(bytes32 id)',
  'function claim()',
  'function credits(address account) view returns (uint256)',
  'function pot(bytes32 id) view returns (uint256)',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

/** The game's matchID → the contract's bytes32 match key. */
export function matchKey(matchID: string): `0x${string}` {
  return keccak256(toBytes(matchID));
}

export const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC) });

function walletClient() {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error('No EVM wallet detected. Install MetaMask.');
  return createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
}

async function ensureRobinhoodChain() {
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

/** Approve (if needed) then deposit the wager for a match. Resolves once mined. */
export async function depositWager(matchID: string, wagerWei: bigint): Promise<`0x${string}`> {
  await ensureRobinhoodChain();
  const wc = walletClient();
  const [account] = await wc.getAddresses();
  const id = matchKey(matchID);

  const allowance = await publicClient.readContract({
    address: WAGER_TOKEN, abi: erc20Abi, functionName: 'allowance', args: [account, WAGER_ESCROW],
  });
  if (allowance < wagerWei) {
    const approveHash = await wc.writeContract({ account, address: WAGER_TOKEN, abi: erc20Abi, functionName: 'approve', args: [WAGER_ESCROW, wagerWei], gas: 150_000n });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
  }
  const depositHash = await wc.writeContract({ account, address: WAGER_ESCROW, abi: escrowAbi, functionName: 'deposit', args: [id], gas: 400_000n });
  await publicClient.waitForTransactionReceipt({ hash: depositHash });
  return depositHash;
}

/** Withdraw any winnings / refunds owed to the connected wallet. */
export async function claimWinnings(): Promise<`0x${string}`> {
  await ensureRobinhoodChain();
  const wc = walletClient();
  const [account] = await wc.getAddresses();
  const hash = await wc.writeContract({ account, address: WAGER_ESCROW, abi: escrowAbi, functionName: 'claim', gas: 300_000n });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Withdrawable balance (winnings + refunds) for an address. */
export function readCredits(addr: Address): Promise<bigint> {
  return publicClient.readContract({ address: WAGER_ESCROW, abi: escrowAbi, functionName: 'credits', args: [addr] });
}

/** Token balance for an address (18 decimals). */
export function tokenBalance(addr: Address): Promise<bigint> {
  return publicClient.readContract({ address: WAGER_TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [addr] });
}
