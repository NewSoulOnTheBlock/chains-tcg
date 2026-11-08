// Compile + deploy CardPack to Robinhood Chain.
//
// SUPPORTED PATH: prefer `forge` with the compiler pinned in contracts/foundry.toml
// (solc 0.8.24). This solc-js script is a fallback and checks that the resolved solc matches
// that pin before deploying.
//
// Safety (contracts-19):
//   - DRY-RUN BY DEFAULT: compiles and prints the plan, broadcasts nothing. Pass --broadcast.
//   - Mainnet only behind --mainnet.
//   - MERGES into contracts/deployment.json (already did; kept).
//
// Usage:
//   node scripts/evm-deploy-pack.mjs                  # dry run
//   DEPLOYER_PK=<hex> CARD_PACK_MAX_SUPPLY=<n> ROBINHOOD_RPC=<url> \
//     node scripts/evm-deploy-pack.mjs --broadcast --mainnet
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { createWalletClient, createPublicClient, http, defineChain, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const BROADCAST = argv.includes('--broadcast');
const ALLOW_MAINNET = argv.includes('--mainnet') || process.env.I_KNOW_THIS_IS_MAINNET === '1';
const PINNED_SOLC = '0.8.24';

const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com';
// Robinhood Chain's official PUBLIC, KEYLESS endpoint (chain 4663). Set ROBINHOOD_RPC to use a
// provider endpoint; never inline a provider key.
const SITE = process.env.SITE || 'https://chains-tcg.vercel.app';
const looksMainnet = /mainnet/i.test(RPC);

const cardCount = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'nft', 'index.json'), 'utf8')).cardCount;
// Hard supply cap in tokens (0 = uncapped). CardPack mints (cardsPerPack + 1) tokens per pack.
const maxSupply = BigInt(process.env.CARD_PACK_MAX_SUPPLY ?? 0);

const resolvedSolc = (solc.version?.() || '').split('+')[0];
if (!resolvedSolc.startsWith(PINNED_SOLC)) {
  console.error(
    `solc ${resolvedSolc || '(unknown)'} does not match the pinned ${PINNED_SOLC} from foundry.toml.\n` +
    `Install solc@${PINNED_SOLC} or deploy via 'forge'.`,
  );
  process.exit(1);
}

function findImports(p) {
  const candidates = [path.join(ROOT, 'node_modules', p), path.join(ROOT, 'contracts', 'src', p)];
  for (const c of candidates) if (fs.existsSync(c)) return { contents: fs.readFileSync(c, 'utf8') };
  return { error: 'not found: ' + p };
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
console.log(`compiled ok with solc ${resolvedSolc}, cardCount ${cardCount}, maxSupply ${maxSupply}`);

const packPrice = parseEther('0.0035');

if (!BROADCAST) {
  console.log('\nDRY RUN (pass --broadcast to deploy). Plan:');
  console.log('  RPC       :', RPC, looksMainnet ? '(mainnet)' : '');
  console.log('  CardPack  : cardCount=' + cardCount, 'baseURI=' + `${SITE}/nft/`, 'packPrice=0.0035 ETH', 'maxSupply=' + maxSupply);
  if (maxSupply === 0n) console.warn('  NOTE: maxSupply=0 is UNCAPPED. Set CARD_PACK_MAX_SUPPLY for on-chain scarcity (contracts-09).');
  console.log('\nNothing was broadcast.');
  process.exit(0);
}

if (looksMainnet && !ALLOW_MAINNET) {
  console.error(`Refusing to broadcast to a mainnet RPC (${RPC}) without --mainnet.`);
  process.exit(1);
}
if (!process.env.DEPLOYER_PK) { console.error('Set DEPLOYER_PK to broadcast.'); process.exit(1); }

const robinhood = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pk = '0x' + process.env.DEPLOYER_PK.replace(/^0x/, '');
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: robinhood, transport: http(RPC) });
const pub = createPublicClient({ chain: robinhood, transport: http(RPC) });
console.log('deployer', account.address, formatEther(await pub.getBalance({ address: account.address })), 'ETH');

const hash = await wallet.deployContract({ abi: art.abi, bytecode: '0x' + art.evm.bytecode.object, args: [BigInt(cardCount), `${SITE}/nft/`, packPrice, maxSupply] });
const rcpt = await pub.waitForTransactionReceipt({ hash });
console.log('CardPack:', rcpt.contractAddress, '(tx', hash + ')');

const file = path.join(ROOT, 'contracts', 'deployment.json');
const dep = JSON.parse(fs.readFileSync(file, 'utf8'));
dep.cardPack = rcpt.contractAddress;
dep.cardPackPriceEth = '0.0035';
dep.cardCount = cardCount;
dep.cardPackMaxSupply = maxSupply.toString();
fs.writeFileSync(file, JSON.stringify(dep, null, 2));
console.log('updated contracts/deployment.json');
