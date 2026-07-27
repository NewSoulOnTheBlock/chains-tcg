/**
 * Wallet signature verification.
 *
 * EVM    — `viem.verifyMessage`, which applies the EIP-191 personal_sign prefix
 *          and recovers the signer. The recovered address is compared against
 *          the *normalised* claimed address, so a checksummed and a lowercase
 *          spelling of the same wallet cannot become two identities.
 * Solana — ed25519 over the raw UTF-8 message bytes via tweetnacl, with the
 *          public key and signature decoded from base58.
 *
 * `message` here is always the server-minted string rebuilt from Redis. This
 * function never sees, and cannot be given, a client-supplied message.
 */
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { verifyMessage as verifyEvmMessage } from 'viem';
import { AppError, getChain, normalizeAddress } from '@chains/shared';

const HEX_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/; // r(32) + s(32) + v(1)

async function verifyEvm(address: string, message: string, signature: string): Promise<boolean> {
  if (!HEX_SIGNATURE_RE.test(signature)) return false;
  try {
    return await verifyEvmMessage({
      address: address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

function verifySolana(address: string, message: string, signature: string): boolean {
  let publicKey: Uint8Array;
  let sig: Uint8Array;
  try {
    publicKey = bs58.decode(address);
    sig = bs58.decode(signature);
  } catch {
    return false;
  }
  if (publicKey.length !== 32 || sig.length !== 64) return false;

  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, publicKey);
  } catch {
    return false;
  }
}

/**
 * Verify `signature` over `message` for `address` on `chain`.
 * Returns the normalised address on success; throws `unauthorized` otherwise.
 */
export async function verifyWalletSignature(input: {
  chain: string;
  address: string;
  message: string;
  signature: string;
}): Promise<string> {
  const spec = getChain(input.chain);
  const address = normalizeAddress(spec.slug, input.address);

  const ok =
    spec.kind === 'evm'
      ? await verifyEvm(address, input.message, input.signature)
      : verifySolana(address, input.message, input.signature);

  if (!ok) {
    // Deliberately identical message for "wrong key", "malformed signature" and
    // "wrong message" so the endpoint is not an oracle.
    throw AppError.unauthorized('Signature verification failed');
  }
  return address;
}
