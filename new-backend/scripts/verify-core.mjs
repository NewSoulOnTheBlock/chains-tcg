// End-to-end verification through the gateway on :8080.
// Covers B2 (auth), B3 (authorization), B4 (profile/deck), B5 (game + socket).
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { io } from 'socket.io-client';

const GW = 'http://localhost:8080';
const results = [];
let failures = 0;

function check(name, ok, evidence) {
  results.push({ name, ok, evidence });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (evidence) console.log(`        ${evidence}`);
}

// ── gateway rate-limit pacing ────────────────────────────────────────────────
// These limits are part of what we are verifying, so we do NOT relax them; we
// stay under them. nginx: global 10r/s burst 20, /auth/ 5r/min burst 10.
let authCalls = 0;
async function pace(path) {
  if (path.startsWith('/auth/')) {
    authCalls += 1;
    // Spend the burst of 10 first, then hold to the 5 r/min sustained rate.
    if (authCalls > 8) await new Promise((r) => setTimeout(r, 12500));
    else await new Promise((r) => setTimeout(r, 150));
  } else {
    await new Promise((r) => setTimeout(r, 130));
  }
}

async function req(method, path, { body, token, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    await pace(path);
    const h = { ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    const r = await fetch(GW + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    // The gateway rate limits are real and are verified separately (B8). Here
    // they are only in the way, so back off and retry rather than weaken them.
    if (r.status === 429 && attempt < 8) {
      process.stdout.write(`        (429 on ${path}, backing off 13s)\n`);
      await new Promise((res) => setTimeout(res, 13000));
      continue;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    return { status: r.status, json, text, headers: r.headers };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────── auth helper
async function signIn(account, label) {
  const nonceRes = await req('POST', '/auth/nonce', {
    body: { address: account.address, chain: 'base' },
  });
  if (nonceRes.status !== 200) throw new Error(`${label} nonce failed ${nonceRes.status} ${nonceRes.text}`);
  const { nonce, message } = nonceRes.json;
  const signature = await account.signMessage({ message });
  const verifyRes = await req('POST', '/auth/verify', {
    body: { address: account.address, chain: 'base', signature, nonce, message },
  });
  if (verifyRes.status !== 200) throw new Error(`${label} verify failed ${verifyRes.status} ${verifyRes.text}`);
  return { nonce, message, signature, ...verifyRes.json };
}

// ══════════════════════════════════════════════════════════ B2: auth flow
console.log('\n═══ B2  AUTH: nonce → sign → verify → JWT → /auth/me → refresh → replay rejected ═══\n');

const keyA = generatePrivateKey();
const keyB = generatePrivateKey();
const A = privateKeyToAccount(keyA);
const B = privateKeyToAccount(keyB);
console.log(`identity A = ${A.address}`);
console.log(`identity B = ${B.address}\n`);

const nonceA = await req('POST', '/auth/nonce', { body: { address: A.address, chain: 'base' } });
check('B2.1 POST /auth/nonce issues a server-minted challenge', nonceA.status === 200 && /^[0-9a-f]{32}$/.test(nonceA.json.nonce),
  `${nonceA.status}, nonce=${nonceA.json?.nonce}, message starts "${nonceA.json?.message?.split('\n')[0]}"`);

const sigA = await A.signMessage({ message: nonceA.json.message });
const verifyA = await req('POST', '/auth/verify', {
  body: { address: A.address, chain: 'base', signature: sigA, nonce: nonceA.json.nonce, message: nonceA.json.message },
});
check('B2.2 POST /auth/verify exchanges an EVM signature for a token pair', verifyA.status === 200 && !!verifyA.json.accessToken && !!verifyA.json.refreshToken,
  `${verifyA.status}, profileId=${verifyA.json?.profile?.profileId}, expiresIn=${verifyA.json?.expiresIn}, roles=${JSON.stringify(verifyA.json?.profile?.roles)}`);

let tokenA = verifyA.json.accessToken;
const jwtClaims = JSON.parse(Buffer.from(tokenA.split('.')[1], 'base64url').toString());
const jwtHeader = JSON.parse(Buffer.from(tokenA.split('.')[0], 'base64url').toString());
check('B2.3 JWT is HS256 with the documented claim shape', jwtHeader.alg === 'HS256' && jwtClaims.sub && jwtClaims.addr && jwtClaims.jti,
  `header=${JSON.stringify(jwtHeader)} claims=${JSON.stringify({ sub: jwtClaims.sub, addr: jwtClaims.addr, chain: jwtClaims.chain, roles: jwtClaims.roles, iss: jwtClaims.iss, aud: jwtClaims.aud })}`);

const meA = await req('GET', '/auth/me', { token: tokenA });
check('B2.4 GET /auth/me accepts the JWT and returns the caller', meA.status === 200 && meA.json.address === A.address.toLowerCase(),
  `${meA.status} ${JSON.stringify(meA.json)}`);

const refresh1 = await req('POST', '/auth/refresh', { body: { refreshToken: verifyA.json.refreshToken } });
check('B2.5 POST /auth/refresh rotates the pair', refresh1.status === 200 && refresh1.json.refreshToken !== verifyA.json.refreshToken,
  `${refresh1.status}, new refresh differs from old (old=${verifyA.json.refreshToken.slice(0, 12)}… new=${refresh1.json?.refreshToken?.slice(0, 12)}…)`);
tokenA = refresh1.json.accessToken;

const refreshReplay = await req('POST', '/auth/refresh', { body: { refreshToken: verifyA.json.refreshToken } });
check('B2.6 the OLD refresh token is rejected (reuse detection)', refreshReplay.status === 401,
  `${refreshReplay.status} ${refreshReplay.text}`);

const successorAfterReuse = await req('POST', '/auth/refresh', { body: { refreshToken: refresh1.json.refreshToken } });
check('B2.7 reuse revokes the whole family — the successor token dies too', successorAfterReuse.status === 401,
  `${successorAfterReuse.status} ${successorAfterReuse.text}`);

const nonceReplay = await req('POST', '/auth/verify', {
  body: { address: A.address, chain: 'base', signature: sigA, nonce: nonceA.json.nonce, message: nonceA.json.message },
});
check('B2.8 a replayed nonce+signature is rejected (GETDEL single-use)', nonceReplay.status === 401,
  `${nonceReplay.status} ${nonceReplay.text}`);

// A's family was revoked by the reuse-detection test; sign in again for the rest.
await sleep(500);
const sessionA = await signIn(A, 'A');
tokenA = sessionA.accessToken;
const sessionB = await signIn(B, 'B');
let tokenB = sessionB.accessToken;
const profileIdA = sessionA.profile.profileId;
const profileIdB = sessionB.profile.profileId;
console.log(`\n  re-signed in: A profileId=${profileIdA}, B profileId=${profileIdB}`);

// ══════════════════════════════════════════════ B3 (part 1): unauthenticated
console.log('\n═══ B3  AUTHORIZATION ═══\n');

const noAuth = await req('GET', '/api/decks');
check('B3.1 unauthenticated call to a protected route is 401', noAuth.status === 401,
  `GET /api/decks (no Authorization) → ${noAuth.status} ${noAuth.text}`);

const noAuth2 = await req('GET', '/games/lobby');
check('B3.2 unauthenticated /games/lobby is 401', noAuth2.status === 401,
  `GET /games/lobby (no Authorization) → ${noAuth2.status} ${noAuth2.text}`);

const badToken = await req('GET', '/api/profiles/me', { token: tokenA.slice(0, -4) + 'AAAA' });
check('B3.3 a tampered JWT signature is 401', badToken.status === 401,
  `GET /api/profiles/me (mutated signature) → ${badToken.status} ${badToken.text}`);

// ══════════════════════════════════════════════════ B4: profile + deck
console.log('\n═══ B4  PROFILE / DECK ═══\n');

const tag = Math.random().toString(36).slice(2, 8);
const nameA = `alice_${tag}`;
const nameB = `bob_${tag}`;

const patchA = await req('PATCH', '/api/profiles/me', { token: tokenA, body: { displayName: nameA, bio: 'integration test A' } });
const patchB = await req('PATCH', '/api/profiles/me', { token: tokenB, body: { displayName: nameB } });
check('B4.1 PATCH /api/profiles/me renames only the caller', patchA.status === 200 && patchB.status === 200 && patchA.json.profile.displayName === nameA,
  `A→${nameA} (${patchA.status}), B→${nameB} (${patchB.status})`);

const deck60 = Array(60).fill('node_eth');
const deckA = await req('POST', '/api/decks', { token: tokenA, body: { name: 'A main', cards: deck60 } });
const deckB = await req('POST', '/api/decks', { token: tokenB, body: { name: 'B main', cards: deck60 } });
check('B4.2 a legal 60-card deck is accepted', deckA.status === 201 && deckB.status === 201,
  `A deck id=${deckA.json?.deck?.id} (${deckA.status}), B deck id=${deckB.json?.deck?.id} (${deckB.status}), 60 cards`);

const illegal = await req('POST', '/api/decks', { token: tokenA, body: { name: 'illegal', cards: Array(5).fill('not_a_real_card') } });
check('B4.3 an illegal deck is rejected on card legality', illegal.status === 400,
  `${illegal.status} ${illegal.text.slice(0, 180)}`);

const actA = await req('POST', `/api/decks/${deckA.json.deck.id}/activate`, { token: tokenA });
const actB = await req('POST', `/api/decks/${deckB.json.deck.id}/activate`, { token: tokenB });
check('B4.4 activation requires and passes the full 60-card rule', actA.status === 200 && actB.status === 200,
  `A activate ${actA.status}, B activate ${actB.status}`);

// ══════════════════════════════════════════════ B3 (part 2): cross-profile
const editOthers = await req('PUT', `/api/decks/${deckB.json.deck.id}`, { token: tokenA, body: { name: 'stolen by A' } });
const stillOwned = await req('GET', '/api/decks', { token: tokenB });
const bDeckName = stillOwned.json?.decks?.find((d) => String(d.id) === String(deckB.json.deck.id))?.name;
check("B3.4 A's token cannot mutate B's deck — fails on the ownership WHERE clause", editOthers.status === 404 && bDeckName === 'B main',
  `PUT /api/decks/${deckB.json.deck.id} as A → ${editOthers.status} ${editOthers.text}; B's deck name still "${bDeckName}" (body field "name" was valid, so this is not body validation)`);

const deleteOthers = await req('DELETE', `/api/decks/${deckB.json.deck.id}`, { token: tokenA });
check("B3.5 A's token cannot delete B's deck", deleteOthers.status === 404,
  `DELETE /api/decks/${deckB.json.deck.id} as A → ${deleteOthers.status} ${deleteOthers.text}`);

const activateOthers = await req('POST', `/api/decks/${deckB.json.deck.id}/activate`, { token: tokenA });
check("B3.6 A's token cannot activate B's deck", activateOthers.status === 404,
  `POST /api/decks/${deckB.json.deck.id}/activate as A → ${activateOthers.status}`);

const spoofBody = await req('PATCH', '/api/profiles/me', { token: tokenA, body: { profileId: profileIdB, displayName: 'hijack_' + tag } });
check('B3.7 a profileId smuggled into the body is a 400, not a trusted field (strictBody)', spoofBody.status === 400,
  `PATCH /api/profiles/me {profileId:${profileIdB},…} as A → ${spoofBody.status} ${spoofBody.text.slice(0, 200)}`);

const spoofHeader = await req('GET', '/api/profiles/me', { token: tokenA, headers: { 'x-profile-id': profileIdB, 'x-auth-roles': 'operator', 'x-operator': '1' } });
check('B3.8 X-Profile-Id / X-Auth-Roles / X-Operator headers are stripped by the gateway', spoofHeader.status === 200 && spoofHeader.json.profile.displayName === nameA,
  `GET /api/profiles/me with spoofed identity headers → still ${nameA} (profileId ${profileIdA}), not ${profileIdB}`);

// ────────────────────────────────────── B4 continued: public views
const pub = await req('GET', `/api/profiles/${nameA}`);
const pubStr = JSON.stringify(pub.json);
const leak1 = pubStr.toLowerCase().includes(A.address.toLowerCase()) || /"address"|"chain"|"wallet"/.test(pubStr);
check('B4.5 public profile view contains NO wallet address', pub.status === 200 && !leak1,
  `${pub.status} GET /api/profiles/${nameA} → ${pubStr}`);

const lb = await req('GET', '/api/leaderboard');
const lbStr = JSON.stringify(lb.json);
const leak2 = lbStr.toLowerCase().includes(A.address.toLowerCase()) || lbStr.toLowerCase().includes(B.address.toLowerCase()) || /"address"|"wallet"/.test(lbStr);
check('B4.6 /api/leaderboard contains NO wallet address', lb.status === 200 && !leak2,
  `GET /api/leaderboard → ${lbStr.slice(0, 400)}${lbStr.length > 400 ? '…' : ''}`);

const ownProfile = await req('GET', '/api/profiles/me', { token: tokenA });
check('B4.7 the owner CAN see their own address (H-2: need-to-know, not hidden from self)', ownProfile.json?.profile?.address === A.address.toLowerCase(),
  `GET /api/profiles/me → address=${ownProfile.json?.profile?.address}`);

// ══════════════════════════════════════════════════════════ B5: game
console.log('\n═══ B5  GAME: create, join, lobby projection, socket play ═══\n');

const create = await req('POST', '/games/create', { token: tokenA, body: { mode: 'casual' } });
check('B5.1 POST /games/create seats the caller at seat 0', create.status === 201 && create.json.seat === 0,
  `${create.status} ${JSON.stringify(create.json)}`);
const matchId = create.json.matchID;

const lobbyBefore = await req('GET', '/games/lobby', { token: tokenB });
const lobbyStr = JSON.stringify(lobbyBefore.json);
const lobbyLeak = /setupData|decklist|"deck"|"cards"|"credentials"|"secret"/i.test(lobbyStr)
  || lobbyStr.toLowerCase().includes(A.address.toLowerCase());
check('B5.2 GET /games/lobby exposes no setupData, decklists, credentials or addresses', lobbyBefore.status === 200 && !lobbyLeak,
  `GET /games/lobby as B → ${lobbyStr}`);

const join = await req('POST', `/games/${matchId}/join`, { token: tokenB, body: {} });
check('B5.3 POST /games/:id/join seats a SECOND authenticated identity at seat 1', join.status === 200 && join.json.seat === 1,
  `${join.status} ${JSON.stringify(join.json)}`);

const joinAgain = await req('POST', `/games/${matchId}/join`, { token: tokenB, body: {} });
check('B5.4 a full match cannot be joined again', joinAgain.status === 409 || joinAgain.status === 404,
  `${joinAgain.status} ${joinAgain.text}`);

const seatA = await req('GET', `/games/${matchId}/seat`, { token: tokenA });
const seatB = await req('GET', `/games/${matchId}/seat`, { token: tokenB });
check('B5.5 each player gets ONLY their own boardgame.io credentials', seatA.status === 200 && seatB.status === 200 && seatA.json.credentials && seatB.json.credentials && seatA.json.credentials !== seatB.json.credentials,
  `A: seat=${seatA.json.seat} creds=${String(seatA.json.credentials).slice(0, 10)}… | B: seat=${seatB.json.seat} creds=${String(seatB.json.credentials).slice(0, 10)}…`);

const outsiderKey = generatePrivateKey();
const outsider = privateKeyToAccount(outsiderKey);
const sessionC = await signIn(outsider, 'C');
const seatC = await req('GET', `/games/${matchId}/seat`, { token: sessionC.accessToken });
check('B5.6 a non-participant gets 404 for the seat route (not 403 — existence is not confirmed)', seatC.status === 404,
  `GET /games/${matchId}/seat as an outsider → ${seatC.status} ${seatC.text}`);

// ────────────────────────────────────────────── real websocket play
console.log('\n  --- boardgame.io socket.io play over the gateway ---');

function connect(seat, credentials) {
  return new Promise((resolve, reject) => {
    const socket = io('http://localhost:8080/chains-tcg', {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
    });
    const t = setTimeout(() => reject(new Error(`seat ${seat} socket timed out`)), 15000);
    socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
    socket.on('connect', () => {
      socket.emit('sync', matchId, String(seat), credentials, 2);
    });
    socket.on('sync', (mid, syncInfo) => {
      clearTimeout(t);
      resolve({ socket, syncInfo });
    });
  });
}

const c0 = await connect(0, seatA.json.credentials);
const c1 = await connect(1, seatB.json.credentials);
check('B5.7 both seats connect over a REAL websocket through the gateway and receive sync', !!c0.syncInfo?.state && !!c1.syncInfo?.state,
  `seat0 _stateID=${c0.syncInfo.state._stateID} phase=${c0.syncInfo.state.ctx.phase} hand=${c0.syncInfo.state.G.players['0'].hand.length} cards | seat1 _stateID=${c1.syncInfo.state._stateID} hand=${c1.syncInfo.state.G.players['1'].hand.length} cards`);

const oppHand = c0.syncInfo.state.G.players['1'].hand;
const ownHand = c0.syncInfo.state.G.players['0'].hand;
check("B5.8 playerView hides the opponent's hand contents over the socket", Array.isArray(oppHand) && oppHand.length === 7 && oppHand.every((c) => c === 'hidden') && ownHand.every((c) => c !== 'hidden'),
  `seat0's view of seat1's hand = ${JSON.stringify(oppHand)} (7 cards, every one masked); seat0's OWN hand = ${JSON.stringify(ownHand)}; both players' deck contents wiped: G.secret.decks = ${JSON.stringify(c0.syncInfo.state.G.secret.decks)}`);

// forged credentials must not move state
let forgedUpdate = null;
c0.socket.on('update', (mid, state) => { forgedUpdate = state; });
const stateIdBefore = c0.syncInfo.state._stateID;
c1.socket.emit('update', { type: 'MAKE_MOVE', payload: { type: 'concede', args: [], playerID: '1', credentials: 'forged-credentials' } }, stateIdBefore, matchId, '1');
await sleep(1500);
check('B5.9 a move with FORGED boardgame.io credentials is discarded by the master', forgedUpdate === null,
  `emitted concede as seat 1 with credentials="forged-credentials" → no 'update' broadcast, _stateID still ${stateIdBefore}`);

// real move: seat 1 concedes
const gameoverSeen = new Promise((resolve) => {
  const onUpdate = (mid, state) => { if (state.ctx.gameover) resolve(state); };
  c0.socket.on('update', onUpdate);
});
c1.socket.emit('update', { type: 'MAKE_MOVE', payload: { type: 'concede', args: [], playerID: '1', credentials: seatB.json.credentials } }, stateIdBefore, matchId, '1');
const finalState = await Promise.race([gameoverSeen, sleep(12000).then(() => null)]);
check('B5.10 a LEGAL move with real credentials is applied and broadcast to the opponent', !!finalState && finalState.ctx.gameover,
  finalState ? `seat 1 conceded → seat 0 received update: _stateID ${stateIdBefore}→${finalState._stateID}, ctx.gameover=${JSON.stringify(finalState.ctx.gameover)}, seat1 life=${finalState.G.players['1'].life}` : 'no gameover broadcast within 12s');

c0.socket.close();
c1.socket.close();

// ─────────────────────────────────────────────────── summary
console.log('\n═══ SUMMARY ═══');
console.log(`${results.length - failures}/${results.length} checks passed`);
console.log(JSON.stringify({
  matchId,
  profileIdA, profileIdB,
  nameA, nameB,
  addrA: A.address.toLowerCase(), addrB: B.address.toLowerCase(),
  tokenA, tokenB,
  deckA: deckA.json?.deck?.id, deckB: deckB.json?.deck?.id,
}, null, 2));
if (failures) { console.log('\nFAILED CHECKS:'); results.filter((r) => !r.ok).forEach((r) => console.log(' - ' + r.name)); }
process.exit(failures ? 1 : 0);
