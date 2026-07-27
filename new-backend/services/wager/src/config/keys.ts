/**
 * Keypair loading. Two DISTINCT EVM keys, both required at boot (H-4).
 *
 *   WAGER_ESCROW_KEYPAIR      holds players' escrowed stakes, signs payouts
 *   BOOSTER_TREASURY_KEYPAIR  receives booster sale proceeds
 *
 * The legacy booster mint did:
 *     process.env.BOOSTER_TREASURY_KEYPAIR ?? process.env.CUSTODIAL_ESCROW_KEYPAIR
 * which silently collapsed both roles into one hot wallet — a compromise of the
 * shop key drained every open wager. There is no fallback here, and startup
 * fails if the two keys are the same.
 *
 * Nothing in this module ever logs a private key. Only addresses are logged.
 */
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function toAccount(raw: string, label: string): PrivateKeyAccount {
  const trimmed = raw.trim();
  const normalised = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!PRIVATE_KEY_RE.test(normalised)) {
    // Never echo the value, not even a prefix of it.
    throw new Error(`${label}: expected a 0x-prefixed 32-byte hex private key`);
  }
  try {
    return privateKeyToAccount(normalised as Hex);
  } catch {
    // Deliberately swallow the underlying error: it can echo key material.
    throw new Error(`${label}: not a valid secp256k1 private key`);
  }
}

export interface ServiceKeys {
  escrow: PrivateKeyAccount;
  treasury: PrivateKeyAccount;
  /** Lower-case escrow address — what deposits must credit. */
  escrowAddress: string;
  /** Lower-case treasury address — what booster payments must credit. */
  treasuryAddress: string;
}

let cached: ServiceKeys | null = null;

export function loadKeys(source: {
  WAGER_ESCROW_KEYPAIR: string;
  BOOSTER_TREASURY_KEYPAIR: string;
}): ServiceKeys {
  const escrow = toAccount(source.WAGER_ESCROW_KEYPAIR, 'WAGER_ESCROW_KEYPAIR');
  const treasury = toAccount(source.BOOSTER_TREASURY_KEYPAIR, 'BOOSTER_TREASURY_KEYPAIR');
  if (escrow.address.toLowerCase() === treasury.address.toLowerCase()) {
    throw new Error(
      'BOOSTER_TREASURY_KEYPAIR must be a different key from WAGER_ESCROW_KEYPAIR (H-4): ' +
        'the wager escrow holds player funds and must never double as the shop treasury.',
    );
  }
  return {
    escrow,
    treasury,
    escrowAddress: escrow.address.toLowerCase(),
    treasuryAddress: treasury.address.toLowerCase(),
  };
}

export function keys(): ServiceKeys {
  if (!cached) throw new Error('keys not initialised — call initKeys() during boot');
  return cached;
}

export function initKeys(source: {
  WAGER_ESCROW_KEYPAIR: string;
  BOOSTER_TREASURY_KEYPAIR: string;
}): ServiceKeys {
  cached = loadKeys(source);
  return cached;
}

/** For tests only. */
export function setKeysForTest(k: ServiceKeys | null): void {
  cached = k;
}
