// B6 (C-1: HMAC provenance of match results) and B7 (C-2: deposit replay).
// Talks to the gateway for the legitimate paths and straight to Postgres for
// the "attacker already has a database connection" scenarios.
import { createHmac, randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const GW = 'http://localhost:8080';
const envFile = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const HMAC_SECRET = envFile.MATCH_RESULT_HMAC_SECRET;
const pool = new pg.Pool({
  connectionString: `postgres://chains:${envFile.POSTGRES_PASSWORD}@127.0.0.1:5432/chains`,
});

const results = [];
let failures = 0;
function check(name, ok, evidence) {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (evidence) console.log(`        ${evidence}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let authCalls = 0;
async function req(method, path, { body, token } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (path.startsWith('/auth/')) { authCalls++; await sleep(authCalls > 8 ? 12500 : 200); }
    else await sleep(300); // /wager/ is the 1 r/s zone
    const h = {};
    if (body !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    const r = await fetch(GW + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (r.status === 429 && attempt < 10) { await sleep(3000); continue; }
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  }
}

async function signIn(account) {
  const n = await req('POST', '/auth/nonce', { body: { address: account.address, chain: 'base' } });
  const signature = await account.signMessage({ message: n.json.message });
  const v = await req('POST', '/auth/verify', { body: { address: account.address, chain: 'base', signature, nonce: n.json.nonce } });
  if (v.status !== 200) throw new Error(`verify ${v.status} ${v.text}`);
  return v.json;
}

/** The wager service's canonical pre-image, reimplemented independently here. */
function canonical({ matchId, winnerSeat, reason, finishedAt }) {
  return [matchId, winnerSeat === null ? '' : String(winnerSeat), reason, finishedAt.toISOString()].join('\n');
}
const sign = (row) => createHmac('sha256', HMAC_SECRET).update(canonical(row), 'utf8').digest('hex');

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ B6  C-1: settlement accepts ONLY HMAC-verified game.match_results rows ═══\n');

// ── B6.0  the cross-service contract, on a row the GAME SERVICE actually wrote
const realRows = await pool.query(
  `SELECT match_id, winner_seat, reason, finished_at, server_sig FROM game.match_results
   ORDER BY finished_at DESC LIMIT 1`);
if (realRows.rowCount === 0) {
  check('B6.0 a real game-service-written result exists', false, 'no rows in game.match_results — run verify-core.mjs first');
} else {
  const r = realRows.rows[0];
  const recomputed = sign({ matchId: r.match_id, winnerSeat: r.winner_seat, reason: r.reason, finishedAt: r.finished_at });
  check('B6.0 the row the GAME service wrote verifies under the WAGER service\'s canonical pre-image',
    recomputed === r.server_sig,
    `match_id=${r.match_id}\n        stored finished_at = ${r.finished_at.toISOString()}  (NOT now(); the game service inserted the exact value it hashed)\n        pre-image  = ${JSON.stringify(canonical({ matchId: r.match_id, winnerSeat: r.winner_seat, reason: r.reason, finishedAt: r.finished_at }))}\n        stored     server_sig = ${r.server_sig}\n        recomputed server_sig = ${recomputed}`);

  const drift = Math.abs(Date.now() - r.finished_at.getTime());
  check('B6.0b finished_at is the value the game service hashed, not a database now()',
    drift < 10 * 60 * 1000,
    `finished_at=${r.finished_at.toISOString()} row created within the last ${(drift / 1000).toFixed(1)}s; the HMAC above only verifies because the INSERT used this exact timestamp`);
}

// ── build a fresh live match with an escrow attached
const A = privateKeyToAccount(generatePrivateKey());
const B = privateKeyToAccount(generatePrivateKey());
const sA = await signIn(A);
const sB = await signIn(B);
const tag = randomBytes(3).toString('hex');
await req('PATCH', '/api/profiles/me', { token: sA.accessToken, body: { displayName: `esc_a_${tag}` } });
await req('PATCH', '/api/profiles/me', { token: sB.accessToken, body: { displayName: `esc_b_${tag}` } });
const deck = Array(60).fill('node_eth');
const dA = await req('POST', '/api/decks', { token: sA.accessToken, body: { name: 'd', cards: deck } });
const dB = await req('POST', '/api/decks', { token: sB.accessToken, body: { name: 'd', cards: deck } });
await req('POST', `/api/decks/${dA.json.deck.id}/activate`, { token: sA.accessToken });
await req('POST', `/api/decks/${dB.json.deck.id}/activate`, { token: sB.accessToken });
const m = await req('POST', '/games/create', { token: sA.accessToken, body: { mode: 'casual' } });
const matchId = m.json.matchID;
await req('POST', `/games/${matchId}/join`, { token: sB.accessToken, body: {} });

const stakes = await req('GET', '/wager/stakes', { token: sA.accessToken });
console.log(`  server-decided stake tiers: ${JSON.stringify(stakes.json)}`);
const esc = await req('POST', '/wager/escrows', { token: sA.accessToken, body: { matchId, tier: 0 } });
check('B6.1 an escrow opens at a SERVER-chosen amount (client named tier 0, never an amount)',
  esc.status === 201 && esc.json.escrow.amountBase === '1000000',
  `${esc.status} ${JSON.stringify(esc.json.escrow)}`);
const escrowId = esc.json.escrow.id;

const badAmount = await req('POST', '/wager/escrows', { token: sA.accessToken, body: { matchId, tier: 0, amountBase: '999999999' } });
check('B6.1b an `amountBase` smuggled into the escrow body is a 400 (strictBody)',
  badAmount.status === 400, `${badAmount.status} ${badAmount.text.slice(0, 160)}`);

// ── B6.2  BOGUS server_sig
const finishedAt = new Date();
await pool.query(
  `INSERT INTO game.match_results (match_id, winner_seat, reason, finished_at, server_sig)
   VALUES ($1, 0, 'life', $2, $3)`,
  [matchId, finishedAt.toISOString(), 'deadbeef'.repeat(8)]);
console.log(`\n  inserted a FORGED game.match_results row directly into Postgres:`);
console.log(`    match_id=${matchId} winner_seat=0 server_sig=${'deadbeef'.repeat(8)}`);
console.log(`  waiting 3 settlement poll cycles (SETTLEMENT_POLL_MS=5000)...`);
await sleep(17000);

const payoutAfterBogus = await pool.query(`SELECT * FROM wager.payouts WHERE escrow_id = $1`, [escrowId]);
const escrowAfterBogus = await pool.query(`SELECT status FROM wager.escrows WHERE id = $1`, [escrowId]);
const legsAfterBogus = await pool.query(`SELECT * FROM wager.payout_legs WHERE escrow_id = $1`, [escrowId]);
check('B6.2 the settlement worker REFUSES a forged row: no payout, no legs, escrow untouched',
  payoutAfterBogus.rowCount === 0 && legsAfterBogus.rowCount === 0 && escrowAfterBogus.rows[0].status === 'open',
  `wager.payouts rows for escrow = ${payoutAfterBogus.rowCount}, wager.payout_legs rows = ${legsAfterBogus.rowCount}, wager.escrows.status = '${escrowAfterBogus.rows[0].status}' (unchanged)`);

// ── B6.3  repair the signature to a genuine HMAC
const goodSig = sign({ matchId, winnerSeat: 0, reason: 'life', finishedAt });
await pool.query(`UPDATE game.match_results SET server_sig = $2 WHERE match_id = $1`, [matchId, goodSig]);
console.log(`\n  replaced server_sig with a correctly-HMAC'd value: ${goodSig}`);
console.log(`  waiting 3 settlement poll cycles...`);
await sleep(17000);

const payoutAfterGood = await pool.query(`SELECT escrow_id, kind, winner_seat, status, amount_base FROM wager.payouts WHERE escrow_id = $1`, [escrowId]);
const escrowAfterGood = await pool.query(`SELECT status FROM wager.escrows WHERE id = $1`, [escrowId]);
check('B6.3 the same row with a VALID HMAC is accepted and settled',
  payoutAfterGood.rowCount === 1,
  `wager.payouts = ${JSON.stringify(payoutAfterGood.rows[0])}, wager.escrows.status = '${escrowAfterGood.rows[0]?.status}'  (kind='noop' because no seat was ever funded — a pot that was never assembled is never paid)`);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n═══ B7  C-2: one deposit signature funds exactly one seat of one escrow, forever ═══\n');

// TWO more escrows, both left OPEN, so the HTTP replay attempts below are
// rejected by the replay guard itself and not incidentally by escrow state.
// (Escrow 1 above is already 'settled' after B6.3.)
async function openEscrow() {
  const mm = await req('POST', '/games/create', { token: sA.accessToken, body: { mode: 'casual' } });
  await req('POST', `/games/${mm.json.matchID}/join`, { token: sB.accessToken, body: {} });
  const e = await req('POST', '/wager/escrows', { token: sA.accessToken, body: { matchId: mm.json.matchID, tier: 0 } });
  return e.json.escrow.id;
}
const escrowId2 = await openEscrow();   // holds the genuine seat-0 deposit
const escrowId3 = await openEscrow();   // the cross-escrow replay target

// Seat 0's genuine deposit, written exactly as the service writes it.
const SIG = '0x' + randomBytes(32).toString('hex');
await pool.query(
  `INSERT INTO wager.deposits (signature, escrow_id, seat, profile_id, from_address, amount_base)
   VALUES ($1, $2, 0, $3, $4, 1000000)`,
  [SIG, escrowId2, sA.profile.profileId, A.address.toLowerCase()]);
const st2 = await pool.query(`SELECT status FROM wager.escrows WHERE id=$1`, [escrowId2]);
const st3 = await pool.query(`SELECT status FROM wager.escrows WHERE id=$1`, [escrowId3]);
console.log(`  escrow2 ${escrowId2} (status=${st2.rows[0].status}) seat 0 funded with signature ${SIG}`);
console.log(`  escrow3 ${escrowId3} (status=${st3.rows[0].status}) left empty as the cross-escrow target\n`);

async function expectViolation(label, sql, params) {
  try {
    await pool.query(sql, params);
    return { ok: false, detail: 'INSERT SUCCEEDED — constraint did not fire' };
  } catch (err) {
    return { ok: err.code === '23505', detail: `SQLSTATE ${err.code} on constraint "${err.constraint}": ${err.detail}` };
  }
}

const r1 = await expectViolation('same sig, other seat, same escrow',
  `INSERT INTO wager.deposits (signature, escrow_id, seat, profile_id, from_address, amount_base)
   VALUES ($1, $2, 1, $3, $4, 1000000)`,
  [SIG, escrowId2, sB.profile.profileId, B.address.toLowerCase()]);
check('B7.1 reusing the signature for the SECOND SEAT of the same escrow violates a DB constraint',
  r1.ok, r1.detail);

const r2 = await expectViolation('same sig, different escrow',
  `INSERT INTO wager.deposits (signature, escrow_id, seat, profile_id, from_address, amount_base)
   VALUES ($1, $2, 0, $3, $4, 1000000)`,
  [SIG, escrowId3, sA.profile.profileId, A.address.toLowerCase()]);
check('B7.2 reusing the signature for a DIFFERENT ESCROW violates a DB constraint',
  r2.ok, r2.detail);

const r3 = await expectViolation('different sig, seat already funded',
  `INSERT INTO wager.deposits (signature, escrow_id, seat, profile_id, from_address, amount_base)
   VALUES ($1, $2, 0, $3, $4, 1000000)`,
  ['0x' + randomBytes(32).toString('hex'), escrowId2, sA.profile.profileId, A.address.toLowerCase()]);
check('B7.3 a SECOND deposit for an already-funded seat violates unique (escrow_id, seat)',
  r3.ok, r3.detail);

// The HTTP surface must report the same thing rather than swallowing it.
const apiReplay = await req('POST', `/wager/escrows/${escrowId2}/deposits`, { token: sB.accessToken, body: { txHash: SIG } });
check('B7.4 the HTTP deposit route surfaces the constraint as 409, not a silent accept',
  apiReplay.status === 409,
  `POST /wager/escrows/${escrowId2}/deposits {txHash: <seat 0's signature>} as seat 1 (escrow still 'open') → ${apiReplay.status} ${apiReplay.text}`);

const apiCross = await req('POST', `/wager/escrows/${escrowId3}/deposits`, { token: sA.accessToken, body: { txHash: SIG } });
check('B7.5 the same signature offered to a DIFFERENT escrow over HTTP is also 409',
  apiCross.status === 409,
  `POST /wager/escrows/${escrowId3}/deposits {txHash: <same signature>} (different escrow, still 'open') → ${apiCross.status} ${apiCross.text}`);

const depositCount = await pool.query(`SELECT count(*)::int AS n FROM wager.deposits WHERE signature = $1`, [SIG]);
check('B7.6 after all replay attempts exactly ONE row holds that signature',
  depositCount.rows[0].n === 1,
  `SELECT count(*) FROM wager.deposits WHERE signature='${SIG}' → ${depositCount.rows[0].n}`);

// No settlement endpoint exists at all (the structural half of C-1).
const settleAttempts = await Promise.all([
  req('POST', `/wager/escrows/${escrowId}/settle`, { token: sA.accessToken, body: { winnerSeat: 0 } }),
  req('POST', '/wager/settle', { token: sA.accessToken, body: { escrowId, winnerSeat: 0 } }),
  req('POST', '/api/result', { token: sA.accessToken, body: { matchID: matchId, winner: '0' } }),
]);
check('B6.4 there is NO settlement endpoint: the legacy POST /api/result and every settle-shaped route 404',
  settleAttempts.every((r) => r.status === 404),
  settleAttempts.map((r, i) => `${['POST /wager/escrows/:id/settle', 'POST /wager/settle', 'POST /api/result'][i]} → ${r.status}`).join('; '));

const voidNoRole = await req('POST', `/wager/escrows/${escrowId3}/void`, { token: sA.accessToken, body: { reason: 'integration test probe' } });
check('B6.5 the operator-only void route rejects a player token with 403',
  voidNoRole.status === 403,
  `POST /wager/escrows/${escrowId3}/void as a player → ${voidNoRole.status} ${voidNoRole.text}`);

console.log('\n═══ SUMMARY ═══');
console.log(`${results.length - failures}/${results.length} checks passed`);
if (failures) results.filter((r) => !r.ok).forEach((r) => console.log(' - ' + r.name));
await pool.end();
process.exit(failures ? 1 : 0);
