// Custodial $MASTER wager server — escrows deposits in a server-controlled
// wallet and pays out on game end. Lives beside the Anchor settle path
// (src/server-wager.ts); the client chooses one or the other via
// VITE_WAGER_MODE.
//
// Required env:
//   CUSTODIAL_ESCROW_KEYPAIR   JSON byte array for the escrow Keypair (mainnet
//                              hot wallet — keep small, rotate often).
//   VITE_SOLANA_RPC / SOLANA_RPC  RPC endpoint (mainnet by default).
//
// Optional env:
//   CUSTODIAL_BURN_BPS         basis points burned (default 1000 = 10%).
//   CUSTODIAL_MIN_WAGER_UI     min wager in UI units (default 1).
//   CUSTODIAL_MAX_WAGER_UI     max wager in UI units (default 1_000_000).

import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createTransferInstruction, createBurnInstruction, getAccount, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { MASTER_MINT, MASTER_DECIMALS, masterUi } from './wager-program';
import { getPool } from './db';

const RPC_URL =
  process.env.VITE_SOLANA_RPC ||
  process.env.SOLANA_RPC ||
  'https://api.mainnet-beta.solana.com';

const BURN_BPS = Number(process.env.CUSTODIAL_BURN_BPS ?? 1000); // 10%
const MIN_UI = Number(process.env.CUSTODIAL_MIN_WAGER_UI ?? 1);
const MAX_UI = Number(process.env.CUSTODIAL_MAX_WAGER_UI ?? 1_000_000);

let _conn: Connection | null = null;
function conn(): Connection {
  if (!_conn) _conn = new Connection(RPC_URL, 'confirmed');
  return _conn;
}

let _escrow: Keypair | null | undefined;
function escrow(): Keypair | null {
  if (_escrow !== undefined) return _escrow;
  const raw = process.env.CUSTODIAL_ESCROW_KEYPAIR;
  if (!raw) { _escrow = null; return null; }
  try {
    _escrow = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    console.log('[custodial] escrow', _escrow.publicKey.toBase58());
    return _escrow;
  } catch (e) {
    console.error('[custodial] bad CUSTODIAL_ESCROW_KEYPAIR', e);
    _escrow = null;
    return null;
  }
}

let _schemaReady: Promise<void> | null = null;
async function ensureSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    const pool = getPool();
    if (!pool) throw new Error('Postgres not initialized');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS custodial_wagers (
        match_id    TEXT PRIMARY KEY,
        amount      TEXT NOT NULL,
        mint        TEXT NOT NULL,
        p0_pubkey   TEXT,
        p0_sig      TEXT,
        p1_pubkey   TEXT,
        p1_sig      TEXT,
        settle_sig  TEXT,
        settled_at  BIGINT,
        refunded    BOOLEAN DEFAULT FALSE,
        created_at  BIGINT NOT NULL
      );
    `);
  })();
  return _schemaReady;
}

function memoFor(matchID: string, playerID: string): string {
  return `mm:${matchID}:${playerID}`;
}

export function isCustodialEnabled(): boolean { return !!escrow(); }

/** Returns the deposit instructions a player must run. Upserts the row so we
 *  can attribute deposits even before the player actually signs. */
export async function createIntent(args: {
  matchID: string; playerID: '0' | '1'; amount: number;
}): Promise<{
  escrowPubkey: string; escrowAta: string; mint: string; amount: string;
  memo: string; decimals: number;
}> {
  const kp = escrow();
  if (!kp) throw new Error('Custodial wagers not enabled on this server');
  if (!Number.isFinite(args.amount) || args.amount < MIN_UI || args.amount > MAX_UI) {
    throw new Error(`Wager must be between ${MIN_UI} and ${MAX_UI} $MASTER`);
  }
  if (args.playerID !== '0' && args.playerID !== '1') throw new Error('bad playerID');
  if (!args.matchID || args.matchID.length > 64) throw new Error('bad matchID');

  await ensureSchema();
  const pool = getPool()!;

  const amountBase = masterUi(args.amount).toString();
  const escrowAta = (await getAssociatedTokenAddress(MASTER_MINT, kp.publicKey, false, TOKEN_2022_PROGRAM_ID)).toBase58();

  await pool.query(
    `INSERT INTO custodial_wagers (match_id, amount, mint, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (match_id) DO NOTHING`,
    [args.matchID, amountBase, MASTER_MINT.toBase58(), Date.now()],
  );
  // Reject mismatched amounts on a second intent for the same match.
  const r = await pool.query<{ amount: string }>(
    `SELECT amount FROM custodial_wagers WHERE match_id = $1`,
    [args.matchID],
  );
  if (r.rows[0]?.amount !== amountBase) {
    throw new Error('amount does not match the existing wager for this match');
  }

  return {
    escrowPubkey: kp.publicKey.toBase58(),
    escrowAta,
    mint: MASTER_MINT.toBase58(),
    amount: amountBase,
    memo: memoFor(args.matchID, args.playerID),
    decimals: MASTER_DECIMALS,
  };
}

/** Verify the player's deposit landed on-chain with the right amount + memo,
 *  then persist their pubkey + sig so settle can find them. */
export async function markFunded(args: {
  matchID: string; playerID: '0' | '1'; pubkey: string; signature: string;
}): Promise<{ ok: true; both: boolean }> {
  const kp = escrow();
  if (!kp) throw new Error('Custodial wagers not enabled on this server');
  if (args.playerID !== '0' && args.playerID !== '1') throw new Error('bad playerID');

  await ensureSchema();
  const pool = getPool()!;
  const row = (await pool.query<{ amount: string; p0_sig: string|null; p1_sig: string|null }>(
    `SELECT amount, p0_sig, p1_sig FROM custodial_wagers WHERE match_id = $1`,
    [args.matchID],
  )).rows[0];
  if (!row) throw new Error('unknown match (no intent on file)');

  // Idempotent: if this seat is already funded, just report current state.
  const already = args.playerID === '0' ? row.p0_sig : row.p1_sig;
  if (already === args.signature) return { ok: true, both: !!(row.p0_sig && row.p1_sig) };

  const tx = await conn().getParsedTransaction(args.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) throw new Error('signature not found on-chain (try again in a few seconds)');
  if (tx.meta?.err) throw new Error('deposit tx failed on-chain');

  const player = new PublicKey(args.pubkey);
  const playerAta = (await getAssociatedTokenAddress(MASTER_MINT, player, false, TOKEN_2022_PROGRAM_ID)).toBase58();
  const escrowAta = (await getAssociatedTokenAddress(MASTER_MINT, kp.publicKey, false, TOKEN_2022_PROGRAM_ID)).toBase58();
  const expectedMemo = memoFor(args.matchID, args.playerID);
  const expectedAmount = BigInt(row.amount);

  // Walk the parsed instructions for a matching SPL transfer + memo.
  let sawTransfer = false;
  let sawMemo = false;
  const allInstrs: any[] = [
    ...(tx.transaction.message.instructions as any[]),
    ...((tx.meta?.innerInstructions ?? []).flatMap(i => i.instructions) as any[]),
  ];
  for (const ix of allInstrs) {
    const program = (ix as any).program;
    const parsed = (ix as any).parsed;
    // Accept both classic SPL Token and Token-2022 (pump.fun moved to 2022).
    const isToken = program === 'spl-token' || program === 'spl-token-2022';
    if (isToken && parsed?.type === 'transfer') {
      const info = parsed.info;
      const matchSrc = info.source === playerAta;
      const matchDst = info.destination === escrowAta;
      const amt = BigInt(info.amount ?? info.tokenAmount?.amount ?? 0);
      if (matchSrc && matchDst && amt >= expectedAmount) sawTransfer = true;
    } else if (isToken && parsed?.type === 'transferChecked') {
      const info = parsed.info;
      const matchSrc = info.source === playerAta;
      const matchDst = info.destination === escrowAta;
      const amt = BigInt(info.tokenAmount?.amount ?? 0);
      if (matchSrc && matchDst && amt >= expectedAmount) sawTransfer = true;
    } else if ((ix as any).programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' ||
               program === 'spl-memo') {
      const memoText = typeof parsed === 'string' ? parsed : (parsed?.info?.memo ?? '');
      if (String(memoText).includes(expectedMemo)) sawMemo = true;
    }
  }
  // Log memo to make missing-memo cases obvious in prod.
  if (!sawTransfer) throw new Error('deposit tx did not transfer the expected $MASTER amount to escrow');
  if (!sawMemo) console.warn('[custodial] memo missing on', args.signature, 'expected', expectedMemo);

  const col = args.playerID === '0' ? 'p0' : 'p1';
  await pool.query(
    `UPDATE custodial_wagers
        SET ${col}_pubkey = $2, ${col}_sig = $3
      WHERE match_id = $1`,
    [args.matchID, args.pubkey, args.signature],
  );
  const after = (await pool.query<{ p0_sig: string|null; p1_sig: string|null }>(
    `SELECT p0_sig, p1_sig FROM custodial_wagers WHERE match_id = $1`,
    [args.matchID],
  )).rows[0];
  return { ok: true, both: !!(after.p0_sig && after.p1_sig) };
}

/** Pay the winner and burn the protocol cut. Called from /api/result.
 *  Idempotent — second call is a no-op if settle_sig already set. */
export async function settleCustodialMatch(opts: {
  matchID: string;
  winnerSeat?: '0' | '1';
  draw?: boolean;
}): Promise<void> {
  const kp = escrow();
  if (!kp) { console.warn('[custodial] no escrow configured; cannot settle'); return; }
  await ensureSchema();
  const pool = getPool()!;
  const row = (await pool.query<{
    amount: string; p0_pubkey: string|null; p1_pubkey: string|null;
    p0_sig: string|null; p1_sig: string|null;
    settle_sig: string|null; refunded: boolean;
  }>(
    `SELECT amount, p0_pubkey, p1_pubkey, p0_sig, p1_sig, settle_sig, refunded
       FROM custodial_wagers WHERE match_id = $1`,
    [opts.matchID],
  )).rows[0];
  if (!row) { console.warn('[custodial] no wager row for', opts.matchID); return; }
  if (row.settle_sig || row.refunded) {
    console.log('[custodial] already settled/refunded', opts.matchID);
    return;
  }
  if (!row.p0_sig || !row.p1_sig) {
    console.warn('[custodial] settle skipped — both seats not funded', opts.matchID);
    return;
  }
  const amountBase = BigInt(row.amount);
  const pot = amountBase * 2n;

  // Draw → refund each player their stake. (No burn on draw.)
  if (opts.draw || !opts.winnerSeat) {
    try {
      const ixs = [];
      for (const [seat, pubkey] of [['0', row.p0_pubkey], ['1', row.p1_pubkey]] as const) {
        if (!pubkey) continue;
        const dest = new PublicKey(pubkey);
        const destAta = await getAssociatedTokenAddress(MASTER_MINT, dest, false, TOKEN_2022_PROGRAM_ID);
        try { await getAccount(conn(), destAta, undefined, TOKEN_2022_PROGRAM_ID); }
        catch { ixs.push(createAssociatedTokenAccountInstruction(kp.publicKey, destAta, dest, MASTER_MINT, TOKEN_2022_PROGRAM_ID)); }
        const srcAta = await getAssociatedTokenAddress(MASTER_MINT, kp.publicKey, false, TOKEN_2022_PROGRAM_ID);
        ixs.push(createTransferInstruction(srcAta, destAta, kp.publicKey, amountBase, [], TOKEN_2022_PROGRAM_ID));
        void seat;
      }
      const tx = new Transaction().add(...ixs);
      tx.feePayer = kp.publicKey;
      tx.recentBlockhash = (await conn().getLatestBlockhash('confirmed')).blockhash;
      const sig = await sendAndConfirmTransaction(conn(), tx, [kp], { commitment: 'confirmed' });
      await pool.query(
        `UPDATE custodial_wagers SET refunded = TRUE, settle_sig = $2, settled_at = $3 WHERE match_id = $1`,
        [opts.matchID, sig, Date.now()],
      );
      console.log('[custodial] refunded draw', opts.matchID, 'sig=', sig);
    } catch (e) { console.error('[custodial] refund failed', opts.matchID, e); }
    return;
  }

  // Normal settle: 90% to winner, 10% burned.
  const winnerPubkeyStr = opts.winnerSeat === '0' ? row.p0_pubkey : row.p1_pubkey;
  if (!winnerPubkeyStr) {
    console.warn('[custodial] winner has no recorded pubkey', opts.matchID);
    return;
  }
  const burn = (pot * BigInt(BURN_BPS)) / 10_000n;
  const payout = pot - burn;

  try {
    const winner = new PublicKey(winnerPubkeyStr);
    const winnerAta = await getAssociatedTokenAddress(MASTER_MINT, winner, false, TOKEN_2022_PROGRAM_ID);
    const escrowAta = await getAssociatedTokenAddress(MASTER_MINT, kp.publicKey, false, TOKEN_2022_PROGRAM_ID);

    const ixs = [];
    try { await getAccount(conn(), winnerAta, undefined, TOKEN_2022_PROGRAM_ID); }
    catch { ixs.push(createAssociatedTokenAccountInstruction(kp.publicKey, winnerAta, winner, MASTER_MINT, TOKEN_2022_PROGRAM_ID)); }
    ixs.push(createTransferInstruction(escrowAta, winnerAta, kp.publicKey, payout, [], TOKEN_2022_PROGRAM_ID));
    if (burn > 0n) {
      ixs.push(createBurnInstruction(escrowAta, MASTER_MINT, kp.publicKey, burn, [], TOKEN_2022_PROGRAM_ID));
    }
    const tx = new Transaction().add(...ixs);
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn().getLatestBlockhash('confirmed')).blockhash;
    const sig = await sendAndConfirmTransaction(conn(), tx, [kp], { commitment: 'confirmed' });
    await pool.query(
      `UPDATE custodial_wagers SET settle_sig = $2, settled_at = $3 WHERE match_id = $1`,
      [opts.matchID, sig, Date.now()],
    );
    console.log('[custodial] settled', opts.matchID, 'payout=', payout.toString(), 'burn=', burn.toString(), 'sig=', sig);
  } catch (e) {
    console.error('[custodial] settle failed', opts.matchID, e);
  }
}

/** Public-safe wager status for a match. Returns null if unknown. */
export async function getWagerStatus(matchID: string): Promise<null | {
  matchID: string;
  amountBase: string;
  decimals: number;
  p0Funded: boolean;
  p1Funded: boolean;
  settled: boolean;
  refunded: boolean;
  settleSig: string | null;
}> {
  await ensureSchema();
  const pool = getPool();
  if (!pool) return null;
  const r = await pool.query<{
    amount: string; p0_sig: string|null; p1_sig: string|null;
    settle_sig: string|null; refunded: boolean;
  }>(
    `SELECT amount, p0_sig, p1_sig, settle_sig, refunded
       FROM custodial_wagers WHERE match_id = $1`,
    [matchID],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    matchID,
    amountBase: row.amount,
    decimals: MASTER_DECIMALS,
    p0Funded: !!row.p0_sig,
    p1Funded: !!row.p1_sig,
    settled: !!row.settle_sig && !row.refunded,
    refunded: row.refunded,
    settleSig: row.settle_sig,
  };
}

/** Admin-only: refund whichever seats are funded for a match. Marks the row
 *  refunded so the normal settle path becomes a no-op afterwards. */
export async function adminRefund(matchID: string): Promise<{
  ok: true; refundedSeats: Array<'0' | '1'>; sig: string | null;
}> {
  const kp = escrow();
  if (!kp) throw new Error('Custodial wagers not enabled on this server');
  await ensureSchema();
  const pool = getPool()!;
  const row = (await pool.query<{
    amount: string; p0_pubkey: string|null; p1_pubkey: string|null;
    p0_sig: string|null; p1_sig: string|null;
    settle_sig: string|null; refunded: boolean;
  }>(
    `SELECT amount, p0_pubkey, p1_pubkey, p0_sig, p1_sig, settle_sig, refunded
       FROM custodial_wagers WHERE match_id = $1`,
    [matchID],
  )).rows[0];
  if (!row) throw new Error('no wager row for that matchID');
  if (row.settle_sig && !row.refunded) throw new Error('already settled — cannot refund');
  if (row.refunded) return { ok: true, refundedSeats: [], sig: row.settle_sig };

  const amountBase = BigInt(row.amount);
  const escrowAta = await getAssociatedTokenAddress(MASTER_MINT, kp.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const ixs = [];
  const refundedSeats: Array<'0' | '1'> = [];
  for (const [seat, pubkey, sig] of [
    ['0', row.p0_pubkey, row.p0_sig] as const,
    ['1', row.p1_pubkey, row.p1_sig] as const,
  ]) {
    if (!sig || !pubkey) continue;
    const dest = new PublicKey(pubkey);
    const destAta = await getAssociatedTokenAddress(MASTER_MINT, dest, false, TOKEN_2022_PROGRAM_ID);
    try { await getAccount(conn(), destAta, undefined, TOKEN_2022_PROGRAM_ID); }
    catch { ixs.push(createAssociatedTokenAccountInstruction(kp.publicKey, destAta, dest, MASTER_MINT, TOKEN_2022_PROGRAM_ID)); }
    ixs.push(createTransferInstruction(escrowAta, destAta, kp.publicKey, amountBase, [], TOKEN_2022_PROGRAM_ID));
    refundedSeats.push(seat);
  }
  if (ixs.length === 0) {
    await pool.query(`UPDATE custodial_wagers SET refunded = TRUE WHERE match_id = $1`, [matchID]);
    return { ok: true, refundedSeats: [], sig: null };
  }
  const tx = new Transaction().add(...ixs);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn().getLatestBlockhash('confirmed')).blockhash;
  const sig = await sendAndConfirmTransaction(conn(), tx, [kp], { commitment: 'confirmed' });
  await pool.query(
    `UPDATE custodial_wagers SET refunded = TRUE, settle_sig = $2, settled_at = $3 WHERE match_id = $1`,
    [matchID, sig, Date.now()],
  );
  console.log('[custodial] admin-refunded', matchID, 'seats=', refundedSeats, 'sig=', sig);
  return { ok: true, refundedSeats, sig };
}
