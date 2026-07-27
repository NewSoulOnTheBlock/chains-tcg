#!/usr/bin/env node
/**
 * End-to-end smoke test for the auth service.
 *
 * Generates throwaway keypairs (one EVM, one Solana), then walks the whole
 * flow and asserts the security properties, not just the happy path:
 *
 *   nonce -> sign -> verify -> tokens
 *   /auth/me with the access token
 *   refresh -> new pair
 *   the OLD refresh token is rejected                  (rotation + reuse detection)
 *   presenting the old one again revokes the family    (the new one dies too)
 *   a replayed nonce is rejected                       (single use)
 *   /auth/me without a token is 401                    (no anonymous access)
 *   a tampered access token is 401                     (HMAC actually checked)
 *
 * Usage:  node scripts/smoke-auth.mjs [baseUrl]
 *         AUTH_URL=http://127.0.0.1:4001 node scripts/smoke-auth.mjs
 */
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE = process.argv[2] || process.env.AUTH_URL || 'http://127.0.0.1:4001';

let passed = 0;
let failed = 0;

function ok(name, extra = '') {
  passed += 1;
  console.log(`  [32mPASS[0m  ${name}${extra ? `  ${extra}` : ''}`);
}
function bad(name, detail) {
  failed += 1;
  console.log(`  [31mFAIL[0m  ${name}\n        ${detail}`);
}
function assert(cond, name, detail) {
  if (cond) ok(name);
  else bad(name, detail ?? 'assertion failed');
}

async function call(path, { method = 'POST', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, body: json, requestId: res.headers.get('x-request-id') };
}

/* --------------------------------------------------------------- signers */

function evmSigner() {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    label: 'EVM (base)',
    chain: 'base',
    address: account.address,
    sign: (message) => account.signMessage({ message }),
  };
}

function solanaSigner() {
  const kp = nacl.sign.keyPair();
  return {
    label: 'Solana',
    chain: 'solana',
    address: bs58.encode(kp.publicKey),
    sign: async (message) =>
      bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)),
  };
}

/* ------------------------------------------------------------------ flow */

async function runChain(signer) {
  console.log(`\n[1m${signer.label}[0m  ${signer.address}`);

  /* 1. nonce ----------------------------------------------------------- */
  const nonceRes = await call('/auth/nonce', { body: { address: signer.address, chain: signer.chain } });
  assert(nonceRes.status === 200, '1. POST /auth/nonce -> 200', `got ${nonceRes.status} ${JSON.stringify(nonceRes.body)}`);
  assert(Boolean(nonceRes.requestId), '   response carries x-request-id', 'header missing');
  const { nonce, message } = nonceRes.body ?? {};
  assert(typeof nonce === 'string' && nonce.length === 32, '   nonce is 128 bits of hex', `got ${nonce}`);
  assert(
    typeof message === 'string' && message.includes(`Nonce: ${nonce}`) && message.includes('Expiration Time:'),
    '   server minted the message (domain, nonce, issued-at)',
    `unexpected message: ${JSON.stringify(message)}`,
  );

  /* 2. verify ---------------------------------------------------------- */
  const signature = await signer.sign(message);
  const verifyRes = await call('/auth/verify', {
    body: { address: signer.address, chain: signer.chain, signature },
  });
  assert(verifyRes.status === 200, '2. POST /auth/verify -> 200', `got ${verifyRes.status} ${JSON.stringify(verifyRes.body)}`);
  const { accessToken, refreshToken, profile } = verifyRes.body ?? {};
  assert(typeof accessToken === 'string' && accessToken.split('.').length === 3, '   access token is a JWT');
  assert(typeof refreshToken === 'string' && refreshToken.length >= 40, '   refresh token is opaque');
  assert(Boolean(profile?.profileId), '   profile created / returned', JSON.stringify(profile));
  assert(Boolean(profile?.displayName), `   default display name = ${profile?.displayName}`);

  /* 3. /auth/me -------------------------------------------------------- */
  const meRes = await call('/auth/me', { method: 'GET', token: accessToken });
  assert(meRes.status === 200, '3. GET /auth/me with token -> 200', `got ${meRes.status} ${JSON.stringify(meRes.body)}`);
  assert(
    meRes.body?.profileId === profile?.profileId,
    '   identity comes from the token',
    `${meRes.body?.profileId} != ${profile?.profileId}`,
  );

  const anonRes = await call('/auth/me', { method: 'GET' });
  assert(anonRes.status === 401, '   GET /auth/me without a token -> 401', `got ${anonRes.status}`);
  assert(anonRes.body?.error?.code === 'unauthorized', '   error envelope shape', JSON.stringify(anonRes.body));

  const tamperedRes = await call('/auth/me', {
    method: 'GET',
    token: `${accessToken.slice(0, -4)}AAAA`,
  });
  assert(tamperedRes.status === 401, '   tampered access token -> 401', `got ${tamperedRes.status}`);

  /* 4. refresh --------------------------------------------------------- */
  const refreshRes = await call('/auth/refresh', { body: { refreshToken } });
  assert(refreshRes.status === 200, '4. POST /auth/refresh -> 200', `got ${refreshRes.status} ${JSON.stringify(refreshRes.body)}`);
  const rotated = refreshRes.body ?? {};
  assert(rotated.refreshToken !== refreshToken, '   refresh token rotated', 'server returned the same token');

  const meAfter = await call('/auth/me', { method: 'GET', token: rotated.accessToken });
  assert(meAfter.status === 200, '   new access token works', `got ${meAfter.status}`);

  /* 5. old refresh token is dead --------------------------------------- */
  const replayRefresh = await call('/auth/refresh', { body: { refreshToken } });
  assert(replayRefresh.status === 401, '5. replayed OLD refresh token -> 401', `got ${replayRefresh.status}`);

  /* 5b. reuse detection revoked the whole family ----------------------- */
  const familyDead = await call('/auth/refresh', { body: { refreshToken: rotated.refreshToken } });
  assert(
    familyDead.status === 401,
    '   reuse revoked the family (current token also dead)',
    `got ${familyDead.status} — family was not revoked`,
  );

  /* 6. replayed nonce -------------------------------------------------- */
  const replayVerify = await call('/auth/verify', {
    body: { address: signer.address, chain: signer.chain, signature },
  });
  assert(replayVerify.status === 401, '6. replayed nonce + signature -> 401', `got ${replayVerify.status}`);

  /* 7. a fresh login still works, and logout revokes ------------------- */
  const n2 = await call('/auth/nonce', { body: { address: signer.address, chain: signer.chain } });
  const sig2 = await signer.sign(n2.body.message);
  const v2 = await call('/auth/verify', { body: { address: signer.address, chain: signer.chain, signature: sig2 } });
  assert(v2.status === 200, '7. second login succeeds', `got ${v2.status}`);
  assert(v2.body?.profile?.profileId === profile?.profileId, '   same profile, not a duplicate');

  const logout = await call('/auth/logout', { body: {}, token: v2.body.accessToken });
  assert(logout.status === 200, '   POST /auth/logout -> 200', `got ${logout.status} ${JSON.stringify(logout.body)}`);
  const afterLogout = await call('/auth/refresh', { body: { refreshToken: v2.body.refreshToken } });
  assert(afterLogout.status === 401, '   refresh after logout -> 401', `got ${afterLogout.status}`);

  /* 8. wrong-key signature --------------------------------------------- */
  const n3 = await call('/auth/nonce', { body: { address: signer.address, chain: signer.chain } });
  const impostor = signer.chain === 'solana' ? solanaSigner() : evmSigner();
  const wrongSig = await impostor.sign(n3.body.message);
  const v3 = await call('/auth/verify', {
    body: { address: signer.address, chain: signer.chain, signature: wrongSig },
  });
  assert(v3.status === 401, '8. signature from a different key -> 401', `got ${v3.status}`);
}

async function main() {
  console.log(`Auth smoke test against ${BASE}`);

  const health = await call('/readyz', { method: 'GET' });
  if (health.status !== 200) {
    console.error(`\nauth service is not ready at ${BASE} (/readyz -> ${health.status})`);
    process.exit(1);
  }
  console.log(`  [32mPASS[0m  /readyz -> 200 ${JSON.stringify(health.body?.checks ?? {})}`);
  passed += 1;

  await runChain(evmSigner());
  await runChain(solanaSigner());

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
