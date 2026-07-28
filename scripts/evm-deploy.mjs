// Compile (solc-js + OZ) and deploy MasterToken + WagerEscrow to Robinhood Chain.
// Usage: DEPLOYER_PK=<hex> node scripts/evm-deploy.mjs
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { createWalletClient, createPublicClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = process.cwd();
const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com';
// Robinhood Chain's official PUBLIC, KEYLESS endpoint (chain 4663). A live
// Alchemy key used to sit here as the fallback and was readable by anyone with
// the repo. Set ROBINHOOD_RPC to use a provider endpoint; never inline a key.
const pk = '0x' + process.env.DEPLOYER_PK.replace(/^0x/, '');

const robinhood = {
  id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

// ── Compile ────────────────────────────────────────────────────────────────
function findImports(p) {
  // Resolve @openzeppelin/... and any local contracts/src import.
  const candidates = [path.join(ROOT, 'node_modules', p), path.join(ROOT, 'contracts', 'src', p)];
  for (const c of candidates) if (fs.existsSync(c)) return { contents: fs.readFileSync(c, 'utf8') };
  return { error: 'File not found: ' + p };
}
const read = (f) => fs.readFileSync(path.join(ROOT, 'contracts', 'src', f), 'utf8');
const input = {
  language: 'Solidity',
  sources: {
    'MasterToken.sol': { content: read('MasterToken.sol') },
    'WagerEscrow.sol': { content: read('WagerEscrow.sol') },
  },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errs = (out.errors || []).filter(e => e.severity === 'error');
if (errs.length) { console.error(errs.map(e => e.formattedMessage).join('\n')); process.exit(1); }
const pick = (file, name) => ({ abi: out.contracts[file][name].abi, bytecode: '0x' + out.contracts[file][name].evm.bytecode.object });
const Master = pick('MasterToken.sol', 'MasterToken');
const Escrow = pick('WagerEscrow.sol', 'WagerEscrow');
console.log('compiled ok');

// ── Deploy ───────────────────────────────────────────────────────────────────
const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: robinhood, transport: http(RPC) });
const pub = createPublicClient({ chain: robinhood, transport: http(RPC) });
console.log('deployer', account.address, formatEther(await pub.getBalance({ address: account.address })), 'ETH');

async function deploy(name, artifact, args) {
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  console.log(`${name}: ${rcpt.contractAddress}  (tx ${hash})`);
  return rcpt.contractAddress;
}

const token = await deploy('MasterToken', Master, []);
const rakeBps = 1000; // 10%
const escrow = await deploy('WagerEscrow', Escrow, [token, account.address, account.address, rakeBps]);

const result = {
  chainId: 4663, rpc: RPC, deployer: account.address,
  masterToken: token, wagerEscrow: escrow, operator: account.address, feeRecipient: account.address, rakeBps,
};
fs.writeFileSync(path.join(ROOT, 'contracts', 'deployment.json'), JSON.stringify(result, null, 2));
console.log('\nsaved contracts/deployment.json\n', result);
