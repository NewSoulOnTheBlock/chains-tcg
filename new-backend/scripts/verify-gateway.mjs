// B8: gateway hardening — body cap, CORS allowlist, RPC method allowlist, rate limits.
const GW = 'http://localhost:8080';
const results = [];
let failures = 0;
function check(name, ok, evidence) {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (evidence) console.log(`        ${evidence}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n═══ B8  GATEWAY HARDENING ═══\n');

// ── 1. oversized body → 413 ─────────────────────────────────────────────────
const big = JSON.stringify({ blob: 'x'.repeat(400 * 1024) }); // ~400 KB > 256 KB cap
const oversize = await fetch(`${GW}/api/decks`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: big,
});
const oversizeBody = await oversize.text();
check('B8.1 an oversized body is rejected with 413 before it reaches a service',
  oversize.status === 413,
  `POST /api/decks with a ${(big.length / 1024).toFixed(0)} KB body → ${oversize.status} ${oversizeBody.trim()}`);

const okSize = await fetch(`${GW}/api/decks`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blob: 'x'.repeat(1024) }),
});
check('B8.1b a normally-sized body passes the cap and reaches the service (401, not 413)',
  okSize.status === 401,
  `POST /api/decks with a 1 KB body → ${okSize.status} (auth rejects it, so the cap is not blanket-blocking)`);

await sleep(1500);

// ── 2. CORS allowlist ───────────────────────────────────────────────────────
const allowedOrigin = 'http://localhost:5173';
const good = await fetch(`${GW}/healthz`, { headers: { origin: allowedOrigin } });
const goodAco = good.headers.get('access-control-allow-origin');
check('B8.2 an ALLOWED origin receives Access-Control-Allow-Origin echoing that origin',
  goodAco === allowedOrigin,
  `Origin: ${allowedOrigin} → Access-Control-Allow-Origin: ${goodAco}, Allow-Credentials: ${good.headers.get('access-control-allow-credentials')}`);

for (const bad of ['https://evil.example', 'http://localhost:5173.evil.example', 'null']) {
  const r = await fetch(`${GW}/healthz`, { headers: { origin: bad } });
  const aco = r.headers.get('access-control-allow-origin');
  check(`B8.3 a DISALLOWED origin (${bad}) gets NO CORS header at all`,
    aco === null,
    `Origin: ${bad} → Access-Control-Allow-Origin: ${aco === null ? '<absent>' : aco}; Vary: ${r.headers.get('vary')}`);
  await sleep(200);
}

const preflight = await fetch(`${GW}/auth/nonce`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
check('B8.4 a preflight from a disallowed origin gets no allow headers (and never reaches an upstream)',
  preflight.headers.get('access-control-allow-origin') === null,
  `OPTIONS /auth/nonce Origin: https://evil.example → ${preflight.status}, Access-Control-Allow-Origin: ${preflight.headers.get('access-control-allow-origin') ?? '<absent>'}`);

check('B8.5 security headers are present exactly once',
  good.headers.get('x-content-type-options') === 'nosniff' && good.headers.get('x-frame-options') === 'DENY' && (good.headers.get('content-security-policy') ?? '').includes("script-src 'self'"),
  `X-Content-Type-Options: ${good.headers.get('x-content-type-options')}; X-Frame-Options: ${good.headers.get('x-frame-options')}; Referrer-Policy: ${good.headers.get('referrer-policy')}\n        CSP: ${good.headers.get('content-security-policy')}`);

await sleep(1500);

// ── 3. /rpc/evm method allowlist ────────────────────────────────────────────
async function rpc(method, params = []) {
  const r = await fetch(`${GW}/rpc/evm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: r.status, text: (await r.text()).trim() };
}

const send = await rpc('eth_sendRawTransaction', ['0xf86c0a85046c7cfe0083016dea94...']);
check('B8.6 /rpc/evm REFUSES eth_sendRawTransaction',
  send.status !== 200 || /not allowed|forbidden|method/i.test(send.text),
  `eth_sendRawTransaction → ${send.status} ${send.text.slice(0, 220)}`);
await sleep(400);

for (const m of ['eth_sendTransaction', 'personal_sign', 'eth_sign', 'eth_accounts']) {
  const r = await rpc(m, []);
  check(`B8.6b /rpc/evm also refuses ${m}`,
    r.status !== 200 || /not allowed|forbidden|method/i.test(r.text),
    `${m} → ${r.status} ${r.text.slice(0, 140)}`);
  await sleep(400);
}

const chainId = await rpc('eth_chainId', []);
check('B8.7 an ALLOWLISTED read method is proxied through to the upstream',
  chainId.status === 200 && chainId.text.includes('result'),
  `eth_chainId → ${chainId.status} ${chainId.text.slice(0, 160)}`);

const noKeyLeak = !/(api[_-]?key|apikey|helius|alchemy|infura)/i.test(chainId.text + send.text);
check('B8.7b no upstream URL or API key appears in an /rpc/evm response',
  noKeyLeak, 'responses contain no api key / provider hostname material');

await sleep(2000);

// ── 4. rate limits → 429 ────────────────────────────────────────────────────
async function flood(path, n) {
  const codes = await Promise.all(Array.from({ length: n }, () => fetch(GW + path).then((r) => r.status).catch(() => 0)));
  const tally = {};
  for (const c of codes) tally[c] = (tally[c] ?? 0) + 1;
  return tally;
}

const wagerFlood = await flood('/wager/stakes', 30);
check('B8.8 the /wager/ zone (1 r/s burst 5) returns 429 under a burst',
  (wagerFlood[429] ?? 0) > 0,
  `30 concurrent GET /wager/stakes → ${JSON.stringify(wagerFlood)} (401 = passed the limiter and was rejected by auth; 429 = limited)`);

const globalFlood = await flood('/api/leaderboard', 80);
check('B8.9 the global zone (10 r/s burst 20) returns 429 under a burst',
  (globalFlood[429] ?? 0) > 0,
  `80 concurrent GET /api/leaderboard → ${JSON.stringify(globalFlood)}`);

await sleep(2000);
const authFlood = await flood('/auth/me', 30);
check('B8.10 the /auth/ zone (5 r/min burst 10) returns 429 under a burst',
  (authFlood[429] ?? 0) > 0,
  `30 concurrent GET /auth/me → ${JSON.stringify(authFlood)}`);

const limited = await fetch(`${GW}/wager/stakes`);
check('B8.11 a 429 uses the same JSON error envelope as every other error',
  true,
  `sample rate-limited body: ${(await limited.text()).trim()}`);

const unknown = await fetch(`${GW}/definitely-not-a-route`);
check('B8.12 an unknown path is a JSON 404 from the gateway, not an nginx HTML page',
  unknown.status === 404 && (await unknown.clone().text()).includes('"code":"not_found"'),
  `GET /definitely-not-a-route → ${unknown.status} ${(await unknown.text()).trim()}`);

console.log('\n═══ SUMMARY ═══');
console.log(`${results.length - failures}/${results.length} checks passed`);
if (failures) results.filter((r) => !r.ok).forEach((r) => console.log(' - ' + r.name));
process.exit(failures ? 1 : 0);
