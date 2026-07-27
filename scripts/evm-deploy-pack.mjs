// Compile + deploy CardPack to Robinhood Chain.
// Usage: DEPLOYER_PK=<hex> node scripts/evm-deploy-pack.mjs
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { createWalletClient, createPublicClient, http, defineChain, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = process.cwd();
const RPC = process.env.ROBINHOOD_RPC || 'https://robinhood-mainnet.g.alchemy.com/v2/h7y2nsAnaBKL98b6RHAsM';
const SITE = process.env.SITE || 'https://chains-tcg.vercel.app';
const pk = '0x' + process.env.DEPLOYER_PK.replace(/^0x/, '');

const cardCount = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'nft', 'index.json'), 'utf8')).cardCount;

function findImports(p) {
  const c = path.join(ROOT, 'node_modules', p);
  return fs.existsSync(c) ? { contents: fs.readFileSync(c, 'utf8') } : { error: 'not found: ' + p };
}
const input = {
  language: 'Solidity',
  sources: { 'CardPack.sol': { content: fs.readFileSync(path.join(ROOT, 'contracts', 'src', 'CardPack.sol'), 'utf8') } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
const art = out.contracts['CardPack.sol']['CardPack'];
console.log('compiled ok, cardCount', cardCount);

const robinhood = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: robinhood, transport: http(RPC) });
const pub = createPublicClient({ chain: robinhood, transport: http(RPC) });
console.log('deployer', account.address, formatEther(await pub.getBalance({ address: account.address })), 'ETH');

const packPrice = parseEther('0.0035');
const hash = await wallet.deployContract({ abi: art.abi, bytecode: '0x' + art.evm.bytecode.object, args: [BigInt(cardCount), `${SITE}/nft/`, packPrice] });
const rcpt = await pub.waitForTransactionReceipt({ hash });
console.log('CardPack:', rcpt.contractAddress, '(tx', hash + ')');

const file = path.join(ROOT, 'contracts', 'deployment.json');
const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
dep.cardPack = rcpt.contractAddress;
dep.cardPackPriceEth = '0.0035';
dep.cardCount = cardCount;
fs.writeFileSync(file, JSON.stringify(dep, null, 2));
console.log('updated contracts/deployment.json');
