// src/wager-program.ts
//
// Minimal browser/Node SDK for the master_wager Solana program. Built directly
// against @solana/web3.js + @solana/spl-token so we don't drag the Anchor TS
// runtime into the frontend bundle.
//
// Instruction discriminators MUST match the Rust IDL: Anchor derives them as
// sha256("global:<snake_case_name>")[..8]. We hardcode the bytes here.

import {
  PublicKey, Connection, Transaction, TransactionInstruction, SystemProgram,
  SYSVAR_RENT_PUBKEY, Keypair, Signer,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction, getAccount,
} from '@solana/spl-token';

// ── Constants ────────────────────────────────────────────────────────────────

export const MASTER_WAGER_PROGRAM_ID = new PublicKey(
  '9JnG7C3uBVnMgx5tSAxSb9ccSuwCC4LkmyV26goXe1pC',
);
export const MASTER_MINT = new PublicKey(
  'DpPowzjETiU6421ReuwBB8XmDB7sMyB2JGzFLssYpump',
);
export const MASTER_DECIMALS = 6; // pump.fun standard

const CONFIG_SEED = Buffer.from('config');
const MATCH_SEED  = Buffer.from('match');
const VAULT_SEED  = Buffer.from('vault');

// ── PDA helpers ──────────────────────────────────────────────────────────────

export function findConfigPda(programId = MASTER_WAGER_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
}
export function findMatchPda(matchId: Buffer | Uint8Array, programId = MASTER_WAGER_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([MATCH_SEED, Buffer.from(matchId)], programId);
}
export function findVaultPda(matchId: Buffer | Uint8Array, programId = MASTER_WAGER_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, Buffer.from(matchId)], programId);
}

// ── Match-id derivation ──────────────────────────────────────────────────────

/** Random 32-byte id for a new wager match. */
export function newMatchId(): Buffer {
  const buf = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < 32; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return Buffer.from(buf);
}
export function matchIdToHex(id: Buffer | Uint8Array): string {
  return Buffer.from(id).toString('hex');
}
export function matchIdFromHex(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

// ── Anchor discriminators (sha256("global:<name>")[..8], precomputed) ────────

const DISC = {
  initialize:   Buffer.from([175,175,109,31,13,152,155,237]),
  set_config:   Buffer.from([108,158,154,175,212,98,52,66]),
  create_match: Buffer.from([107,2,184,145,70,142,17,165]),
  join_match:   Buffer.from([244,8,47,130,192,59,179,44]),
  settle_match: Buffer.from([71,124,117,96,191,217,116,24]),
  cancel_match: Buffer.from([142,136,247,45,92,112,180,83]),
};

// ── Borsh-ish encoders (the few primitives we need) ──────────────────────────

function u16le(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function i64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n), 0); return b;
}
function u64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b;
}
function pk(p: PublicKey): Buffer { return Buffer.from(p.toBytes()); }

// ── Instruction builders ─────────────────────────────────────────────────────

export function ixInitialize(args: {
  admin: PublicKey;
  masterMint: PublicKey;
  oracle: PublicKey;
  burnBps: number;
  cancelTimeoutSecs: number | bigint;
  minWager: bigint | number;
}): TransactionInstruction {
  const [config] = findConfigPda();
  const data = Buffer.concat([
    DISC.initialize,
    pk(args.oracle),
    u16le(args.burnBps),
    i64le(args.cancelTimeoutSecs),
    u64le(args.minWager),
  ]);
  return new TransactionInstruction({
    programId: MASTER_WAGER_PROGRAM_ID,
    keys: [
      { pubkey: args.admin,       isSigner: true,  isWritable: true  },
      { pubkey: config,           isSigner: false, isWritable: true  },
      { pubkey: args.masterMint,  isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function ixSetConfig(args: {
  admin: PublicKey;
  newOracle?: PublicKey | null;
  newBurnBps?: number | null;
  newCancelTimeoutSecs?: bigint | number | null;
  newMinWager?: bigint | number | null;
}): TransactionInstruction {
  const [config] = findConfigPda();
  const opt = (b: Buffer | null) => b ? Buffer.concat([Buffer.from([1]), b]) : Buffer.from([0]);
  const data = Buffer.concat([
    DISC.set_config,
    opt(args.newOracle ? pk(args.newOracle) : null),
    opt(args.newBurnBps != null ? u16le(args.newBurnBps) : null),
    opt(args.newCancelTimeoutSecs != null ? i64le(args.newCancelTimeoutSecs) : null),
    opt(args.newMinWager != null ? u64le(args.newMinWager) : null),
  ]);
  return new TransactionInstruction({
    programId: MASTER_WAGER_PROGRAM_ID,
    keys: [
      { pubkey: args.admin, isSigner: true,  isWritable: false },
      { pubkey: config,     isSigner: false, isWritable: true  },
    ],
    data,
  });
}

export async function ixCreateMatch(args: {
  connection: Connection;
  creator: PublicKey;
  matchId: Buffer;            // 32 bytes
  wagerAmount: bigint;
  masterMint?: PublicKey;
}): Promise<TransactionInstruction[]> {
  const mint = args.masterMint ?? MASTER_MINT;
  const [config]   = findConfigPda();
  const [matchPda] = findMatchPda(args.matchId);
  const [vault]    = findVaultPda(args.matchId);
  const creatorAta = await getAssociatedTokenAddress(mint, args.creator);

  const ixs: TransactionInstruction[] = [];

  // Ensure creator has an ATA for $MASTER (idempotent — only adds if missing).
  try { await getAccount(args.connection, creatorAta); }
  catch {
    ixs.push(createAssociatedTokenAccountInstruction(args.creator, creatorAta, args.creator, mint));
  }

  const data = Buffer.concat([
    DISC.create_match,
    args.matchId,
    u64le(args.wagerAmount),
  ]);

  ixs.push(new TransactionInstruction({
    programId: MASTER_WAGER_PROGRAM_ID,
    keys: [
      { pubkey: args.creator, isSigner: true,  isWritable: true  },
      { pubkey: config,       isSigner: false, isWritable: false },
      { pubkey: matchPda,     isSigner: false, isWritable: true  },
      { pubkey: vault,        isSigner: false, isWritable: true  },
      { pubkey: mint,         isSigner: false, isWritable: false },
      { pubkey: creatorAta,   isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ],
    data,
  }));
  return ixs;
}

export async function ixJoinMatch(args: {
  connection: Connection;
  opponent: PublicKey;
  matchId: Buffer;
  masterMint?: PublicKey;
}): Promise<TransactionInstruction[]> {
  const mint = args.masterMint ?? MASTER_MINT;
  const [matchPda] = findMatchPda(args.matchId);
  const [vault]    = findVaultPda(args.matchId);
  const oppAta     = await getAssociatedTokenAddress(mint, args.opponent);

  const ixs: TransactionInstruction[] = [];
  try { await getAccount(args.connection, oppAta); }
  catch {
    ixs.push(createAssociatedTokenAccountInstruction(args.opponent, oppAta, args.opponent, mint));
  }

  ixs.push(new TransactionInstruction({
    programId: MASTER_WAGER_PROGRAM_ID,
    keys: [
      { pubkey: args.opponent, isSigner: true,  isWritable: true  },
      { pubkey: matchPda,      isSigner: false, isWritable: true  },
      { pubkey: vault,         isSigner: false, isWritable: true  },
      { pubkey: oppAta,        isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: DISC.join_match,
  }));
  return ixs;
}

export async function ixSettleMatch(args: {
  connection: Connection;
  oracle: PublicKey;
  matchId: Buffer;
  winner: PublicKey;
  masterMint?: PublicKey;
}): Promise<TransactionInstruction[]> {
  const mint = args.masterMint ?? MASTER_MINT;
  const [config]   = findConfigPda();
  const [matchPda] = findMatchPda(args.matchId);
  const [vault]    = findVaultPda(args.matchId);
  const winnerAta  = await getAssociatedTokenAddress(mint, args.winner);

  const ixs: TransactionInstruction[] = [];
  try { await getAccount(args.connection, winnerAta); }
  catch {
    // Oracle pays the rent so we don't require the winner to have done anything first.
    ixs.push(createAssociatedTokenAccountInstruction(args.oracle, winnerAta, args.winner, mint));
  }

  ixs.push(new TransactionInstruction({
    programId: MASTER_WAGER_PROGRAM_ID,
    keys: [
      { pubkey: args.oracle, isSigner: true,  isWritable: false },
      { pubkey: config,      isSigner: false, isWritable: false },
      { pubkey: matchPda,    isSigner: false, isWritable: true  },
      { pubkey: vault,       isSigner: false, isWritable: true  },
      { pubkey: mint,        isSigner: false, isWritable: true  },
      { pubkey: winnerAta,   isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DISC.settle_match, pk(args.winner)]),
  }));
  return ixs;
}

export async function ixCancelMatch(args: {
  connection: Connection;
  creator: PublicKey;
  matchId: Buffer;
  masterMint?: PublicKey;
}): Promise<TransactionInstruction[]> {
  const mint = args.masterMint ?? MASTER_MINT;
  const [config]   = findConfigPda();
  const [matchPda] = findMatchPda(args.matchId);
  const [vault]    = findVaultPda(args.matchId);
  const creatorAta = await getAssociatedTokenAddress(mint, args.creator);

  return [new TransactionInstruction({
    programId: MASTER_WAGER_PROGRAM_ID,
    keys: [
      { pubkey: args.creator, isSigner: true,  isWritable: true  },
      { pubkey: config,       isSigner: false, isWritable: false },
      { pubkey: matchPda,     isSigner: false, isWritable: true  },
      { pubkey: vault,        isSigner: false, isWritable: true  },
      { pubkey: creatorAta,   isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: DISC.cancel_match,
  })];
}

// ── On-chain account decoders ────────────────────────────────────────────────

const MATCH_LAYOUT_OFFSET = 8;
export type MatchAccount = {
  matchId:     Buffer;
  creator:     PublicKey;
  opponent:    PublicKey;
  wagerAmount: bigint;
  mint:        PublicKey;
  state:       'open' | 'joined' | 'settled' | 'cancelled';
  winner:      PublicKey;
  createdAt:   bigint;
  config:      PublicKey;
  bump:        number;
  vaultBump:   number;
};
export async function fetchMatch(conn: Connection, matchId: Buffer): Promise<MatchAccount | null> {
  const [pda] = findMatchPda(matchId);
  const acc = await conn.getAccountInfo(pda);
  if (!acc) return null;
  const d = acc.data;
  let o = MATCH_LAYOUT_OFFSET;
  const matchIdBuf = Buffer.from(d.subarray(o, o + 32)); o += 32;
  const creator    = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const opponent   = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const wagerAmount = d.readBigUInt64LE(o); o += 8;
  const mint       = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const stateByte  = d.readUInt8(o); o += 1;
  const winner     = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const createdAt  = d.readBigInt64LE(o); o += 8;
  const config     = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const bump       = d.readUInt8(o); o += 1;
  const vaultBump  = d.readUInt8(o); o += 1;
  const stateMap = ['open','joined','settled','cancelled'] as const;
  return {
    matchId: matchIdBuf, creator, opponent, wagerAmount, mint,
    state: stateMap[stateByte] ?? 'open', winner, createdAt, config, bump, vaultBump,
  };
}

// ── Convenience wrappers (browser; uses wallet adapter) ──────────────────────

export type WalletAdapter = {
  publicKey: PublicKey | null;
  signTransaction(tx: Transaction): Promise<Transaction>;
};

/** Build, sign, send a tx and confirm. Returns signature. */
export async function sendIxs(
  conn: Connection, wallet: WalletAdapter, ixs: TransactionInstruction[], extraSigners: Signer[] = [],
): Promise<string> {
  if (!wallet.publicKey) throw new Error('Wallet not connected');
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  if (extraSigners.length) tx.partialSign(...extraSigners);
  const signed = await wallet.signTransaction(tx);
  const raw = signed.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
  // Robust confirmation loop:
  //  - Re-broadcast the signed tx every 2s (defends against single-RPC drops).
  //  - Poll signature status. Accept on confirmed/finalized.
  //  - If the blockhash window passes, do ONE last status check (the tx may
  //    have landed even if our confirm timed out) before declaring failure.
  const deadline = Date.now() + 120_000; // ~2min ceiling for stubborn RPCs.
  let confirmed = false;
  while (Date.now() < deadline) {
    try {
      const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const s = st?.value?.[0];
      if (s) {
        if (s.err) throw new Error(`tx failed on-chain: ${JSON.stringify(s.err)}`);
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
          confirmed = true;
          break;
        }
      }
      // Best-effort current height to bail early if blockhash truly expired.
      try {
        const bh = await conn.getBlockHeight('confirmed');
        if (bh > lastValidBlockHeight + 150 && !s) {
          // 150-slot grace past the window; if still nothing, give up.
          break;
        }
      } catch { /* RPC hiccup; keep polling */ }
      // Rebroadcast (best-effort — ignore failures, the pool failover handles it).
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    } catch (e: any) {
      // If status check itself failed, just try again next loop.
      if (/tx failed on-chain/.test(String(e?.message))) throw e;
    }
    await new Promise(r => setTimeout(r, 2_000));
  }
  if (!confirmed) {
    // Final check after the loop in case the last status poll missed a
    // confirmation that landed mid-tick.
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => null);
    const s = st?.value?.[0];
    if (s && !s.err && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
      confirmed = true;
    }
  }
  if (!confirmed) {
    throw new Error(`Transaction ${sig} did not confirm in time. It may still land — check Solscan in a minute before retrying.`);
  }
  return sig;
}

/** Convert UI $MASTER amount (e.g. 100) to base units (e.g. 100_000000n). */
export function masterUi(n: number | bigint): bigint {
  if (typeof n === 'bigint') return n * 10n ** BigInt(MASTER_DECIMALS);
  return BigInt(Math.floor(n * 10 ** MASTER_DECIMALS));
}

/** Keep server-side helper signature stable. */
export function uiMaster(base: bigint): number {
  return Number(base) / 10 ** MASTER_DECIMALS;
}

void Keypair;
