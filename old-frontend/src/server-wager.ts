// src/server-wager.ts — server-side oracle that settles $MASTER wager matches.
// Reads SOLANA_ORACLE_KEYPAIR (JSON byte array) + VITE_SOLANA_RPC / SOLANA_RPC
// from env. When a wagered game ends, the server signs and sends a
// settle_match tx with the oracle keypair.

import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  ixSettleMatch, ixCancelMatch, matchIdFromHex, fetchMatch,
} from './wager-program';

const RPC_URL =
  process.env.VITE_SOLANA_RPC ||
  process.env.SOLANA_RPC ||
  'https://api.mainnet-beta.solana.com';

let _conn: Connection | null = null;
function conn(): Connection {
  if (!_conn) _conn = new Connection(RPC_URL, 'confirmed');
  return _conn;
}

let _oracle: Keypair | null | undefined;
function oracle(): Keypair | null {
  if (_oracle !== undefined) return _oracle;
  const raw = process.env.SOLANA_ORACLE_KEYPAIR;
  if (!raw) { _oracle = null; return null; }
  try {
    const bytes = Uint8Array.from(JSON.parse(raw));
    _oracle = Keypair.fromSecretKey(bytes);
    console.log('[wager] oracle loaded', _oracle.publicKey.toBase58());
    return _oracle;
  } catch (e) {
    console.error('[wager] failed to parse SOLANA_ORACLE_KEYPAIR', e);
    _oracle = null;
    return null;
  }
}

/**
 * Called when a wagered match ends. Signs + sends a settle (or cancel) tx with
 * the oracle keypair. Idempotent: if the on-chain match is already settled it
 * returns silently. Errors are logged but never thrown — the game result must
 * still be recorded regardless of on-chain outcome.
 */
export async function settleWagerMatch(opts: {
  onchainId: string;       // hex 32-byte match id
  winnerSeat?: '0' | '1';  // which seat won; omit for draw → cancel
  draw?: boolean;
}): Promise<void> {
  const kp = oracle();
  if (!kp) { console.warn('[wager] no oracle keypair set; cannot settle', opts.onchainId); return; }
  let matchId: Buffer;
  try { matchId = matchIdFromHex(opts.onchainId); }
  catch (e) { console.error('[wager] bad onchainId', opts.onchainId, e); return; }

  try {
    const m = await fetchMatch(conn(), matchId);
    if (!m) { console.warn('[wager] match not found on-chain', opts.onchainId); return; }
    if (m.state !== 'joined') {
      console.log('[wager] match not in Joined state, skipping', opts.onchainId, 'state=', m.state);
      return;
    }

    let ix;
    if (opts.draw || !opts.winnerSeat) {
      // Draw / no winner declared → return funds to both players via cancel.
      // (Program currently only allows cancel from Open state by creator. If
      //  this becomes a real issue we'll add an oracle-only `expire_match`.)
      console.warn('[wager] draw on wagered match — no settle path yet', opts.onchainId);
      return;
    } else {
      const winnerPk = opts.winnerSeat === '0' ? m.creator : m.opponent;
      ix = await ixSettleMatch({
        connection: conn(),
        oracle:     kp.publicKey,
        matchId,
        winner:     winnerPk,
      });
    }

    const tx = new Transaction().add(...ix);
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn().getLatestBlockhash('confirmed')).blockhash;
    const sig = await sendAndConfirmTransaction(conn(), tx, [kp], { commitment: 'confirmed' });
    console.log('[wager] settled', opts.onchainId, 'sig=', sig);
  } catch (e) {
    console.error('[wager] settle failed', opts.onchainId, e);
  }
}

/** Oracle-initiated cancel for stuck Open matches (creator never got an opponent). */
export async function oracleCancel(onchainId: string): Promise<void> {
  // Cancel can only be called by the creator per current program. Stub for now.
  console.log('[wager] oracleCancel not implemented (creator-only)', onchainId);
}
