// solana/scripts/initialize.ts
// One-shot script: calls master_wager::initialize on mainnet (or whatever
// cluster `solana config get` points at) using the local ~/.config/solana/id.json
// keypair as admin.
//
//   ORACLE_PUBKEY=<base58>  ts-node scripts/initialize.ts
//
// Defaults: burn 10%, cancel timeout 15 min, min wager 1 $MASTER.

import {
  Connection, Keypair, Transaction, sendAndConfirmTransaction, PublicKey,
} from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ixInitialize, MASTER_MINT, masterUi,
} from '../../src/wager-program';

const ORACLE_PUBKEY = process.env.ORACLE_PUBKEY;
if (!ORACLE_PUBKEY) { console.error('Set ORACLE_PUBKEY env var (base58)'); process.exit(1); }

// Default to devnet. Hitting mainnet-beta must be explicit (contracts-18): pass
// `--i-know-this-is-mainnet` (or set I_KNOW_THIS_IS_MAINNET=1) AND point SOLANA_RPC at a
// mainnet endpoint. A mainnet RPC without the acknowledgement is refused.
const RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const ACK_MAINNET =
  process.argv.includes('--i-know-this-is-mainnet') || process.env.I_KNOW_THIS_IS_MAINNET === '1';
const looksMainnet = /mainnet/i.test(RPC);
if (looksMainnet && !ACK_MAINNET) {
  console.error(
    `Refusing to run against a mainnet RPC (${RPC}) without --i-know-this-is-mainnet.\n` +
    `This signs a real initialize() tx. Re-run with the flag if that is intended.`,
  );
  process.exit(1);
}

async function main() {
  const adminPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(adminPath, 'utf8'))));
  console.log('Admin :', admin.publicKey.toBase58());
  console.log('Oracle:', ORACLE_PUBKEY);
  console.log('Mint  :', MASTER_MINT.toBase58());
  console.log('RPC   :', RPC);

  const conn = new Connection(RPC, 'confirmed');
  const ix = ixInitialize({
    admin: admin.publicKey,
    masterMint: MASTER_MINT,
    oracle: new PublicKey(ORACLE_PUBKEY),
    burnBps: 1000,                 // 10% of pot burned
    cancelTimeoutSecs: 60 * 15,    // 15 min auto-cancel for Open matches
    minWager: masterUi(1),         // 1 $MASTER min
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: 'confirmed' });
  console.log('\ninitialize() sent — sig:', sig);
}

main().catch(e => { console.error(e); process.exit(1); });
