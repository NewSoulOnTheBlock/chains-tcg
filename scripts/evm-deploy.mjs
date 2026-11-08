// Compile (solc-js + OZ) and deploy MasterToken + WagerEscrow to Robinhood Chain.
//
// SUPPORTED PATH: the reproducible, byte-verifiable deploy is `forge script`
// (contracts/script/Deploy.s.sol) with the compiler pinned in contracts/foundry.toml
// (solc 0.8.24, 200 runs). This solc-js script is a convenience fallback and checks that
// the resolved solc matches that pin; if it does not, it refuses to deploy.
//
// Safety (contracts-19):
//   - DRY-RUN BY DEFAULT: compiles and prints the plan, broadcasts nothing. Pass --broadcast.
//   - Mainnet only behind --mainnet (a mainnet RPC without it is refused).
//   - OPERATOR / FEE_RECIPIENT read from env (default to the deployer with a loud warning).
//   - MERGES into contracts/deployment.json instead of overwriting the pack/other keys.
//
// Usage:
//   node scripts/evm-deploy.mjs                 # dry run (no key needed)
//   DEPLOYER_PK=<hex> OPERATOR=0x.. FEE_RECIPIENT=0x.. \
//     ROBINHOOD_RPC=<url> node scripts/evm-deploy.mjs --broadcast --mainnet
import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';
import { createWalletClient, createPublicClient, http, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const BROADCAST = argv.includes('--broadcast');
const ALLOW_MAINNET = argv.includes('--mainnet') || process.env.I_KNOW_THIS_IS_MAINNET === '1';
const PINNED_SOLC = '0.8.24';

const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com';
// Robinhood Chain's official PUBLIC, KEYLESS endpoint (chain 4663). Set ROBINHOOD_RPC to use a
// provider endpoint; never inline a provider key.
const looksMainnet = /mainnet/i.test(RPC);

const robinhood = {
  id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

// ── Compile ────────────────────────────────────────────────────────────────
const resolvedSolc = (solc.version?.() || '').split('+')[0];
if (!resolvedSolc.startsWith(PINNED_SOLC)) {
  console.error(
    `solc ${resolvedSolc || '(unknown)'} does not match the pinned ${PINNED_SOLC} from foundry.toml.\n` +
    `Install solc@${PINNED_SOLC} or deploy via 'forge script' (the supported, reproducible path).`,
  );
  process.exit(1);
}

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
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join('\n')); process.exit(1); }
const pick = (file, name) => ({ abi: out.contracts[file][name].abi, bytecode: '0x' + out.contracts[file][name].evm.bytecode.object });
const Master = pick('MasterToken.sol', 'MasterToken');
const Escrow = pick('WagerEscrow.sol', 'WagerEscrow');
console.log(`compiled ok with solc ${resolvedSolc}`);

const rakeBps = Number(process.env.RAKE_BPS ?? 1000); // 10%

if (!BROADCAST) {
  console.log('\nDRY RUN (pass --broadcast to deploy). Plan:');
  console.log('  RPC          :', RPC, looksMainnet ? '(mainnet)' : '');
  console.log('  MasterToken  : <new>  (18-decimal, capped supply)');
  console.log('  WagerEscrow  : token=<MasterToken> operator=$OPERATOR feeRecipient=$FEE_RECIPIENT rakeBps=' + rakeBps);
  console.log('\nNothing was broadcast.');
  process.exit(0);
}

if (looksMainnet && !ALLOW_MAINNET) {
  console.error(`Refusing to broadcast to a mainnet RPC (${RPC}) without --mainnet.`);
  process.exit(1);
}
if (!process.env.DEPLOYER_PK) { console.error('Set DEPLOYER_PK to broadcast.'); process.exit(1); }

const pk = '0x' + process.env.DEPLOYER_PK.replace(/^0x/, '');
const account = privateKeyToAccount(pk);
const operator = process.env.OPERATOR || account.address;
const feeRecipient = process.env.FEE_RECIPIENT || account.address;
if (!process.env.OPERATOR || !process.env.FEE_RECIPIENT) {
  console.warn(
    '\nWARNING: OPERATOR and/or FEE_RECIPIENT not set — defaulting to the deployer EOA.\n' +
    'This recreates the audit H-4 single-key setup (owner = operator = feeRecipient).\n' +
    'Set both to distinct low-privilege / treasury / multisig addresses for production.\n',
  );
}

// ── Deploy ───────────────────────────────────────────────────────────────────
const wallet = createWalletClient({ account, chain: robinhood, transport: http(RPC) });
const pub = createPublicClient({ chain: robinhood, transport: http(RPC) });
console.log('deployer', account.address, formatEther(await pub.getBalance({ address: account.address })), 'ETH');
console.log('operator', operator, '\nfeeRecipient', feeRecipient);

async function deploy(name, artifact, args) {
  const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  console.log(`${name}: ${rcpt.contractAddress}  (tx ${hash})`);
  return rcpt.contractAddress;
}

const token = await deploy('MasterToken', Master, []);
const escrow = await deploy('WagerEscrow', Escrow, [token, operator, feeRecipient, rakeBps]);

// Merge into the existing deployment.json so pack/other keys survive (contracts-19).
const file = path.join(ROOT, 'contracts', 'deployment.json');
const dep = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
Object.assign(dep, {
  chainId: 4663, rpc: RPC, deployer: account.address,
  masterToken: token, wagerEscrow: escrow, operator, feeRecipient, rakeBps,
});
fs.writeFileSync(file, JSON.stringify(dep, null, 2));
console.log('\nmerged into contracts/deployment.json\n', dep);
