/**
 * The sign-in message.
 *
 * The critical property: **the client never supplies the message.** The server
 * mints it at `/auth/nonce`, keeps every field that went into it, and at
 * `/auth/verify` rebuilds the exact same string from its own stored copy before
 * checking the signature.
 *
 * That is what closes C-3. Under the old design a caller asserted an identity
 * and was believed. Here, the only string a signature can be checked against is
 * one this server composed, for this domain, for this address, with a nonce it
 * generated and can consume exactly once.
 */
import { getChain } from '@chains/shared';

export interface MintedMessageFields {
  domain: string;
  uri: string;
  statement: string;
  address: string;
  chain: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/**
 * SIWE-shaped (EIP-4361) and reused verbatim for Solana, so wallets on both
 * chains show the user the same recognisable text.
 */
export function buildSignInMessage(f: MintedMessageFields): string {
  const spec = getChain(f.chain);
  const chainIdLine = spec.chainId !== undefined ? String(spec.chainId) : spec.slug;

  return [
    `${f.domain} wants you to sign in with your ${spec.label} account:`,
    f.address,
    '',
    f.statement,
    '',
    `URI: ${f.uri}`,
    'Version: 1',
    `Chain ID: ${chainIdLine}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expiresAt}`,
  ].join('\n');
}
