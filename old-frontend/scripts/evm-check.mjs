import { createPublicClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.ROBINHOOD_RPC || 'https://robinhood-mainnet.g.alchemy.com/v2/h7y2nsAnaBKL98b6RHAsM';
const pk = ('0x' + (process.env.DEPLOYER_PK || '')).replace('0x0x', '0x');
const acct = privateKeyToAccount(pk);
const client = createPublicClient({ transport: http(RPC) });

const [chainId, bal, gas] = await Promise.all([
  client.getChainId(),
  client.getBalance({ address: acct.address }),
  client.getGasPrice().catch(() => 0n),
]);
console.log('deployer:', acct.address);
console.log('chainId :', chainId);
console.log('balance :', formatEther(bal), 'ETH');
console.log('gasPrice:', gas.toString(), 'wei');
