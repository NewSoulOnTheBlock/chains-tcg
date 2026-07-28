import { createPublicClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com';
// Robinhood Chain's official PUBLIC, KEYLESS endpoint (chain 4663). A live
// Alchemy key used to sit here as the fallback and was readable by anyone with
// the repo. Set ROBINHOOD_RPC to use a provider endpoint; never inline a key.
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
