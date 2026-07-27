// solana/scripts/gen-oracle.ts
// Generates a Solana keypair for the wager-settle oracle, writes it to disk,
// and prints the env-var-formatted secret bytes to paste into Render.
//
//   ts-node scripts/gen-oracle.ts
//
// Output:
//   oracle.json              — the keypair (DO NOT COMMIT)
//   SOLANA_ORACLE_KEYPAIR   — printed to stdout, paste into Render env
//
// After generation: fund the oracle pubkey with ~0.1 SOL for tx fees.

import { Keypair } from '@solana/web3.js';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const out = path.resolve(__dirname, '..', 'oracle.json');

if (existsSync(out)) {
  console.error(`refusing to overwrite ${out} — delete it first if you really mean it.`);
  process.exit(1);
}

const kp = Keypair.generate();
const bytes = Array.from(kp.secretKey);
writeFileSync(out, JSON.stringify(bytes));

console.log(`\nGenerated oracle keypair → ${out}`);
console.log(`  Pubkey:  ${kp.publicKey.toBase58()}`);
console.log('\nNext steps:');
console.log(`  1. Fund the oracle with SOL for tx fees:`);
console.log(`       solana transfer ${kp.publicKey.toBase58()} 0.1 --allow-unfunded-recipient`);
console.log(`  2. Set this Render env var (copy the whole line):\n`);
console.log(`SOLANA_ORACLE_KEYPAIR=${JSON.stringify(bytes)}\n`);
console.log(`  3. Use ${kp.publicKey.toBase58()} as the oracle arg to initialize.\n`);
