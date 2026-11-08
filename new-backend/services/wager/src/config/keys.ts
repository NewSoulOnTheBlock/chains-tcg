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
import { statSync } from 'node:fs';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Hex } from 'viem';

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Addresses of the DOCUMENTED throwaway keypairs from DEPLOY.md §"Placeholder
 * wager keypairs — NO REAL MONEY". Booting with one of these is only ever
 * intended for a no-real-money deployment, so it must be an explicit opt-in
 * (ALLOW_PLACEHOLDER_WAGER_KEYS=1) rather than the silent default (server-37).
 */
const PLACEHOLDER_ADDRESSES = new Set(
  [
    '0x0Cdd5ceB3A8EFe77920e06a69E445861017891Ec',
    '0x2fA2a0CC28E456dF38C45BCbEFe0eA6a3Ad4c634',
  ].map((a) => a.toLowerCase()),
);

/**
 * Refuse to boot if the file the signing keys were read from is readable by
 * anyone but its owner (server-37). The keys live in `/opt/chains-tcg/.env`,
 * which DEPLOY.md requires to be mode 600 / root-owned; set WAGER_KEY_ENV_FILE
 * to that path so a drift to 0644 stops the service instead of leaking the key.
 * POSIX only — Windows mode bits do not carry this meaning.
 */
function assertKeyFileSecure(): void {
  const path = process.env.WAGER_KEY_ENV_FILE;
  if (!path || process.platform === 'win32') return;
  let mode: number;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    return; // absent or unreadable: nothing to assert here
  }
  if (mode & 0o077) {
    throw new Error(
      `WAGER_KEY_ENV_FILE ${path} is group/other-accessible (mode ${mode.toString(8)}). ` +
        'The escrow signing key must live in a file that is mode 600 and owned by the ' +
        'service user (DEPLOY.md §2). Refusing to start (server-37).',
    );
  }
}

/** Refuse the documented placeholder keys unless explicitly allowed. */
function assertNotPlaceholder(escrowAddress: string, treasuryAddress: string): void {
  const hit = [escrowAddress, treasuryAddress].some((a) => PLACEHOLDER_ADDRESSES.has(a));
  if (!hit) return;
  if (process.env.ALLOW_PLACEHOLDER_WAGER_KEYS === '1') {
    // Only addresses are ever logged here, never key material.
    console.warn(
      '[wager] WARNING: booting with the DOCUMENTED PLACEHOLDER escrow/treasury keypairs ' +
        '(ALLOW_PLACEHOLDER_WAGER_KEYS=1). No real funds may pass through this deployment.',
    );
    return;
  }
  throw new Error(
    'Refusing to start with the documented PLACEHOLDER wager/treasury keypairs (server-37). ' +
      'Generate real keys for a funded deployment, or set ALLOW_PLACEHOLDER_WAGER_KEYS=1 to run a ' +
      'no-real-money deployment deliberately.',
  );
}

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
  // Fail before the keys are even parsed if the file they came from is exposed.
  assertKeyFileSecure();

  const escrow = toAccount(source.WAGER_ESCROW_KEYPAIR, 'WAGER_ESCROW_KEYPAIR');
  const treasury = toAccount(source.BOOSTER_TREASURY_KEYPAIR, 'BOOSTER_TREASURY_KEYPAIR');
  if (escrow.address.toLowerCase() === treasury.address.toLowerCase()) {
    throw new Error(
      'BOOSTER_TREASURY_KEYPAIR must be a different key from WAGER_ESCROW_KEYPAIR (H-4): ' +
        'the wager escrow holds player funds and must never double as the shop treasury.',
    );
  }
  const escrowAddress = escrow.address.toLowerCase();
  const treasuryAddress = treasury.address.toLowerCase();
  assertNotPlaceholder(escrowAddress, treasuryAddress);
  return {
    escrow,
    treasury,
    escrowAddress,
    treasuryAddress,
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
