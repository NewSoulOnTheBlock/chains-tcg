// src/wager-evm-server.ts
// Server-side wiring for WagerEscrow on Robinhood Chain. The server holds the
// OPERATOR key and is the only party allowed to open and settle matches, so the
// winner is paid automatically at match end.
//
// Env: ROBINHOOD_RPC, WAGER_ESCROW, OPERATOR_PK (never shipped to the client).

import { createWalletClient, createPublicClient, http, defineChain, keccak256, toBytes, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.ROBINHOOD_RPC || 'https://robinhood-mainnet.g.alchemy.com/v2/h7y2nsAnaBKL98b6RHAsM';
const ESCROW = (process.env.WAGER_ESCROW || '0xdbc49ff2cf44d2ba1a844d80d1f82d472440cc3d') as `0x${string}`;

const robinhood = defineChain({
  id: 4663, name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const abi = parseAbi([
  'function createMatch(bytes32 id, address p1, address p2, uint128 wager)',
  'function settle(bytes32 id, address winner)',
  'function settleDraw(bytes32 id)',
  'function cancelMatch(bytes32 id)',
]);

export const matchKey = (matchID: string): `0x${string}` => keccak256(toBytes(matchID));

function operator() {
  const pk = process.env.OPERATOR_PK;
  if (!pk) throw new Error('OPERATOR_PK not set — cannot sign wager settlement.');
  const account = privateKeyToAccount(('0x' + pk.replace(/^0x/, '')) as `0x${string}`);
  return {
    account,
    wallet: createWalletClient({ account, chain: robinhood, transport: http(RPC) }),
    pub: createPublicClient({ chain: robinhood, transport: http(RPC) }),
  };
}

export async function createEvmMatch(matchID: string, p1: `0x${string}`, p2: `0x${string}`, wagerWei: bigint): Promise<`0x${string}`> {
  const { account, wallet, pub } = operator();
  const hash = await wallet.writeContract({ account, address: ESCROW, abi, functionName: 'createMatch', args: [matchKey(matchID), p1, p2, wagerWei] });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

/** Automatic payout: pays the pot (minus rake) to the winner. Call on match end. */
export async function settleEvmMatch(matchID: string, winner: `0x${string}`): Promise<`0x${string}`> {
  const { account, wallet, pub } = operator();
  const hash = await wallet.writeContract({ account, address: ESCROW, abi, functionName: 'settle', args: [matchKey(matchID), winner] });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

export async function settleEvmDraw(matchID: string): Promise<`0x${string}`> {
  const { account, wallet, pub } = operator();
  const hash = await wallet.writeContract({ account, address: ESCROW, abi, functionName: 'settleDraw', args: [matchKey(matchID)] });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
