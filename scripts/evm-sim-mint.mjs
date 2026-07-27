import { createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.ROBINHOOD_RPC || 'https://robinhood-mainnet.g.alchemy.com/v2/h7y2nsAnaBKL98b6RHAsM';
const PACK = '0x57200fb533b33823f8bd2ac8f3649e3b643830b3';
const abi = parseAbi([
  'function mintPack() payable returns (uint256[])',
  'function packPrice() view returns (uint256)',
]);
const account = privateKeyToAccount('0x' + process.env.DEPLOYER_PK.replace(/^0x/, ''));
const pub = createPublicClient({ transport: http(RPC) });

const price = await pub.readContract({ address: PACK, abi, functionName: 'packPrice' });
console.log('packPrice(wei):', price.toString());
const bal = await pub.getBalance({ address: account.address });
console.log('caller:', account.address, 'balance:', bal.toString());

try {
  const gas = await pub.estimateContractGas({ address: PACK, abi, functionName: 'mintPack', value: price, account: account.address });
  console.log('estimateGas:', gas.toString());
} catch (e) { console.error('estimateGas FAIL:', e.shortMessage || e.message); }

try {
  await pub.simulateContract({ address: PACK, abi, functionName: 'mintPack', value: price, account: account.address });
  console.log('simulate: OK (call would succeed)');
} catch (e) { console.error('simulate FAIL:', e.shortMessage || e.message); }
