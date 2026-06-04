// Custodial $MASTER wager client — alternative to the on-chain Anchor program.
//
// Flow:
//   1. createMatch / joinMatch calls `requestWagerIntent(matchID, playerID, amount)`
//      to learn the escrow pubkey + memo string the server expects.
//   2. We build a single tx that (a) SPL-transfers `amount` $MASTER from the
//      player's ATA to the escrow's ATA, and (b) appends a Memo with
//      `mm:<matchID>:<playerID>` so the server can attribute the deposit even
//      across restarts. Phantom signs and we send it.
//   3. We POST `/api/wager/funded` with the resulting signature so the server
//      verifies it on-chain and marks the seat funded.
//
// The Anchor path (src/wager-program.ts) is untouched and still used when
// VITE_WAGER_MODE !== 'custodial'.

import {
  Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  createTransferInstruction, getAccount, TOKEN_2022_PROGRAM_ID,
  TokenAccountNotFoundError, TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import { MASTER_MINT, MASTER_DECIMALS, sendIxs, type WalletAdapter, masterUi } from './wager-program';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

const SERVER_BASE = (import.meta as any).env?.VITE_SERVER_URL || '';

// Kept for back-compat with any imports; always 'custodial' now that the
// on-chain (Anchor) wager path has been removed.
export const CUSTODIAL_WAGER_MODE: 'custodial' = 'custodial';

export type WagerIntent = {
  escrowPubkey: string;
  escrowAta: string;
  mint: string;
  amount: string;      // base units as a string (avoid bigint JSON issues)
  memo: string;
  decimals: number;
};

async function postJson(path: string, body: any): Promise<any> {
  const r = await fetch(`${SERVER_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `${path} → ${r.status}`);
  return j;
}

export async function requestWagerIntent(args: {
  matchID: string; playerID: '0' | '1'; amount: number;
}): Promise<WagerIntent> {
  const j = await postJson('/api/wager/intent', args);
  return j.intent as WagerIntent;
}

/** Build and sign a deposit tx for the custodial escrow, then report it to the server. */
export async function depositCustodialWager(args: {
  connection: Connection;
  wallet: WalletAdapter;
  intent: WagerIntent;
}): Promise<string> {
  const { connection, wallet, intent } = args;
  if (!wallet.publicKey) throw new Error('Wallet not connected');
  const mint = new PublicKey(intent.mint);
  const escrow = new PublicKey(intent.escrowPubkey);
  // $MASTER (pump.fun) is a Token-2022 mint — all ATA derivations + ixs
  // must specify the 2022 program id, otherwise we look up the wrong ATA
  // (and would get "no MASTER ATA" errors even when the user holds plenty).
  const fromAta = await getAssociatedTokenAddress(
    mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID,
  );
  const toAta = new PublicKey(intent.escrowAta);

  const ixs: TransactionInstruction[] = [];

  // Sanity: ensure the escrow ATA exists; player pays the tiny rent if not (one-time).
  try { await getAccount(connection, toAta, undefined, TOKEN_2022_PROGRAM_ID); }
  catch (e: any) {
    if (e instanceof TokenAccountNotFoundError || e instanceof TokenInvalidAccountOwnerError) {
      ixs.push(createAssociatedTokenAccountInstruction(
        wallet.publicKey, toAta, escrow, mint, TOKEN_2022_PROGRAM_ID,
      ));
    } else {
      throw new Error(`Could not verify escrow token account (RPC error: ${e?.message ?? e}). Please try again.`);
    }
  }
  let payerAccount: PublicKey = fromAta;
  let foundBalance = false;
  try {
    const acct = await getAccount(connection, fromAta, undefined, TOKEN_2022_PROGRAM_ID);
    foundBalance = acct.amount >= BigInt(intent.amount);
    if (!foundBalance) {
      throw new Error(`Your $MASTER balance is too low for this wager (need ${intent.amount} base units, have ${acct.amount.toString()}).`);
    }
  } catch (e: any) {
    if (e instanceof TokenAccountNotFoundError || e instanceof TokenInvalidAccountOwnerError) {
      const parsed = await connection.getParsedTokenAccountsByOwner(
        wallet.publicKey, { mint, programId: TOKEN_2022_PROGRAM_ID },
      ).catch(err => {
        throw new Error(`Could not look up your $MASTER token accounts (RPC error: ${err?.message ?? err}). Please try again.`);
      });
      const need = BigInt(intent.amount);
      const hit = parsed.value.find(p => {
        const raw = p.account.data.parsed?.info?.tokenAmount?.amount;
        try { return raw && BigInt(raw) >= need; } catch { return false; }
      });
      if (!hit) {
        const total = parsed.value.reduce((acc, p) => {
          const raw = p.account.data.parsed?.info?.tokenAmount?.amount;
          try { return acc + (raw ? BigInt(raw) : 0n); } catch { return acc; }
        }, 0n);
        if (total === 0n) {
          throw new Error('This wallet has no $MASTER. Acquire some first, or connect a different wallet.');
        }
        throw new Error(`This wallet does not have a single $MASTER account with enough balance for this wager (need ${intent.amount} base units, max account balance found = ${total.toString()}). Consolidate balances or lower the wager.`);
      }
      payerAccount = hit.pubkey;
      foundBalance = true;
    } else if (/balance is too low/i.test(String(e?.message))) {
      throw e;
    } else {
      throw new Error(`Could not verify your $MASTER balance (RPC error: ${e?.message ?? e}). If this persists, set VITE_SOLANA_RPC to a private RPC endpoint.`);
    }
  }
  if (!foundBalance) {
    throw new Error('This wallet has no $MASTER. Acquire some first, or connect a different wallet.');
  }

  ixs.push(createTransferInstruction(
    payerAccount, toAta, wallet.publicKey, BigInt(intent.amount), [], TOKEN_2022_PROGRAM_ID,
  ));

  // Memo on its own instruction so the server can find it deterministically.
  ixs.push(new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(intent.memo, 'utf8'),
  }));

  void SystemProgram; // silence unused import in some bundlers
  const sig = await sendIxs(connection, wallet, ixs);

  // Report to server (signed → server verifies on-chain).
  await postJson('/api/wager/funded', {
    matchID: intent.memo.split(':')[1],
    playerID: intent.memo.split(':')[2],
    pubkey: wallet.publicKey.toBase58(),
    signature: sig,
  });
  return sig;
}

/** Convert UI $MASTER amount to base-unit string (avoids JSON bigint pain). */
export function masterUiToString(amount: number): string {
  return masterUi(amount).toString();
}

void MASTER_MINT; void MASTER_DECIMALS;
