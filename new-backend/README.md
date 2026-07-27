# Chains TCG — secure backend (v2)

This replaces the single Koa server in `src/server.ts`. The design contract is
[`ARCHITECTURE.md`](./ARCHITECTURE.md); this file is how to run it.

Five services behind one nginx gateway, one Postgres, one Redis:

| Service | Port | Owns |
|---|---|---|
| gateway | 8080 | TLS termination point, rate limits, body cap, CORS, CSP |
| auth | 4001 | nonces, signature verification, sessions, JWT issuing/rotation |
| profile | 4002 | profiles, decks, leaderboard, match history |
| game | 4003 | boardgame.io server, match lifecycle, **authoritative results** |
| wager | 4004 | escrow deposits, settlement, payouts, booster tickets |
| rpc-proxy | 4005 | outbound EVM RPC holding the real API key (read-only; no `eth_sendRawTransaction`) |

---

## Run it

```bash
cd new-backend
make env                  # writes .env from .env.example with generated secrets
docker compose up --build # gateway on http://localhost:8080
```

`make env` generates `JWT_SECRET`, `POSTGRES_PASSWORD` and
`MATCH_RESULT_HMAC_SECRET` with `openssl rand`; the wager service additionally
needs `WAGER_ESCROW_KEYPAIR`, `BOOSTER_TREASURY_KEYPAIR` (two DIFFERENT keys —
H-4) and `BOOSTER_PACK_SEED_SECRET`. See
[`INTEGRATION.md`](./INTEGRATION.md) for the full env reference and the
end-to-end verification transcript. There are no defaults for those
three: `docker compose` refuses to render without them, which is deliberate.

Just the auth path (no other service needed):

```bash
docker compose up -d postgres redis migrate auth
node scripts/smoke-auth.mjs        # or: make smoke
docker compose down
```

Useful targets: `make help`, `make ps`, `make logs`, `make migrate-status`,
`make psql`, `make clean` (drops volumes).

### Running one service locally

The services are npm workspaces, so everything installs once from this
directory.

```bash
npm install
npm run build --workspace @chains/shared   # services import the built dist/

docker compose up -d postgres redis migrate  # dependencies only

export $(grep -v '^#' .env | grep -v '^$' | xargs)
export DATABASE_URL="postgres://chains:$POSTGRES_PASSWORD@127.0.0.1:5432/chains"
export REDIS_URL="redis://127.0.0.1:6379"

npm run build --workspace @chains/auth
node services/auth/dist/index.js
```

`@chains/shared` must be rebuilt after any change to it — services consume
`packages/shared/dist`, not its TypeScript sources.

### Migrations

```bash
make migrate           # apply pending
make migrate-status    # show applied / pending
```

The runner applies `db/migrations/NNNN_*.sql` in filename order, each in its own
transaction, recording `version` + SHA-256 checksum in `public.schema_migrations`.
Re-running is a no-op. Editing an already-applied file is refused — the checksum
mismatch aborts the run, so environments cannot silently diverge. Fix forward
with a new file.

**No service issues DDL.** There is no `CREATE TABLE IF NOT EXISTS` anywhere
outside the runner's own ledger bootstrap.

---

## The auth flow, end to end

Wallet-based challenge–response. No passwords, no `?name=`.

### 1. Request a challenge

```bash
curl -s -X POST https://api.ocva.online/auth/nonce \
  -H 'content-type: application/json' \
  -d '{"address":"0x3fbcb9611488b3383b9563ec83e64d8430c34e6e","chain":"base"}'
```

```json
{
  "nonce": "783a91490cb6dc4491266c976adbea83",
  "message": "ocva.online wants you to sign in with your Base account:\n0x3fbc…\n\nSign in to Chains TCG.\n\nURI: https://ocva.online\nVersion: 1\nChain ID: 8453\nNonce: 783a91490cb6dc4491266c976adbea83\nIssued At: 2026-07-27T15:24:52.720Z\nExpiration Time: 2026-07-27T15:29:52.720Z",
  "expiresAt": "2026-07-27T15:29:52.720Z",
  "domain": "ocva.online",
  "chainId": "8453"
}
```

The `message` is minted **by the server** and stored in Redis with a 5-minute
TTL. The client signs it verbatim; it is returned only so the wallet has the
exact bytes. On verify the server rebuilds the string from its own stored copy —
it will not verify a signature over anything it did not mint.

Supported `chain` values: `solana`, `ethereum`, `base`, `arbitrum`, `polygon`,
`robinhood`.

**The web app signs in with `robinhood`** — Robinhood Chain, EIP-155 id `4663`,
the only network this game runs on. The slug is the identity namespace of
`core.profiles (address, chain)` as well as the `Chain ID:` line the wallet
shows, so it must match the network the wallet is actually on. The other slugs
remain accepted (an EVM signature is chain-agnostic ecrecover) but produce
*different profiles* for the same wallet.

### 2. Sign it and exchange it for tokens

```bash
curl -s -X POST https://api.ocva.online/auth/verify \
  -H 'content-type: application/json' \
  -d '{"address":"0x3fbc…","chain":"base","signature":"0x…"}'
```

```json
{
  "tokenType": "Bearer",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "expiresIn": 900,
  "refreshToken": "dfQAF9lMfh7u…",
  "refreshExpiresAt": "2026-08-26T15:24:52.000Z",
  "profile": {
    "profileId": "5",
    "address": "0x3fbcb9611488b3383b9563ec83e64d8430c34e6e",
    "chain": "base",
    "displayName": "0x3fbc…4e6e",
    "roles": ["player"]
  }
}
```

The nonce is consumed atomically (`GETDEL`). Replaying the same signature
returns 401. On first verify the `core.profiles` row is created, with the
display name defaulting to the short address form.

- EVM signatures are checked with `viem.verifyMessage` (EIP-191).
- Solana signatures are checked with `tweetnacl` ed25519 over the raw UTF-8
  message, with the key and signature base58-decoded.
- EVM addresses are normalised to lowercase before storage and comparison, so
  a checksummed and a lowercase spelling are one identity, not two.

### 3. Call an authenticated route

```bash
curl -s https://api.ocva.online/auth/me -H "authorization: Bearer $ACCESS_TOKEN"
```

```json
{"profileId":"5","address":"0x3fbc…","chain":"base","displayName":"0x3fbc…4e6e",
 "avatarUrl":null,"bio":null,"wins":0,"losses":0,"roles":["player"]}
```

### 4. Rotate

```bash
curl -s -X POST https://api.ocva.online/auth/refresh \
  -H 'content-type: application/json' \
  -d '{"refreshToken":"dfQAF9lMfh7u…"}'
```

Returns a new pair. The presented token is revoked in the same transaction.
Presenting it again returns 401 **and revokes the entire session family** — the
successor token dies too. That is reuse detection: if a refresh token is
replayed, either the attacker or the victim is holding a stolen copy, so both
are logged out and the user must re-sign.

### 5. Log out

```bash
curl -s -X POST https://api.ocva.online/auth/logout \
  -H "authorization: Bearer $ACCESS_TOKEN" \
  -H 'content-type: application/json' -d '{}'
```

Revokes the family the access token's `jti` belongs to.

### Errors

One envelope everywhere, from the gateway and from every service:

```json
{ "error": { "code": "unauthorized", "message": "Invalid refresh token" } }
```

`code` is one of `bad_request`, `unauthorized`, `forbidden`, `not_found`,
`method_not_allowed`, `conflict`, `payload_too_large`, `unsupported_media_type`,
`unprocessable`, `rate_limited`, `internal`, `unavailable`. Stack traces, SQL
and driver messages never appear in a response — they go to the structured log,
correlated by the `x-request-id` header returned on every response.

---

## Audit findings → mechanism

| # | Finding | Mechanism that fixes it |
|---|---|---|
| **C-1** | `POST /api/result` (`src/server.ts:557`) let any client post `{matchID, winner, loser, draw}` plus `wager:{onchainId, winnerSeat}` and be paid out. | No settlement endpoint exists. The game service writes `game.match_results` from its own authoritative state with an HMAC (`MATCH_RESULT_HMAC_SECRET`) over the row; the wager service settles only from those rows after verifying the HMAC. `match_id` is the PRIMARY KEY, so one match yields one result, once. There is no request shape that can make the escrow pay. |
| **C-2** | Deposit replay was guarded by in-process state (`memBoosterPaymentSigs`, `src/db.ts:44`), lost on restart and not shared between replicas. | `wager.deposits.signature` is a **global PRIMARY KEY** and `UNIQUE (escrow_id, seat)` caps one deposit per seat. The database is the guard, not application logic. Per ARCHITECTURE.md the wager service must also verify amount, mint, sender, recipient, a `chains:<escrowId>:<seat>` memo (mismatch = reject, previously only a warning) and recency against `escrows.created_at`. |
| **C-3** | No REST route was authenticated; `body.name` was accepted as identity (`src/server.ts:201, 212, 228`). | Wallet challenge–response issues a JWT; `requireAuth()` populates `req.auth` and it is the only identity source. The shared `route()` helper **throws at startup** if a route declares neither `auth: 'required'`/`roles` nor an explicit `public: true`. The gateway additionally strips `X-Profile-Id`, `X-Auth-Roles`, `X-Operator`, `X-Admin-Token` from inbound requests. |
| **H-2** | Wallet addresses, e-mails and shipping details were exposed in listings. | Wallet addresses live in `core.profiles` and are documented as never appearing in a public listing; `wager.shipping` is readable only where `profile_id = req.auth.profileId` or the caller holds `operator`. `/auth/me` returns the caller's own address only. |
| **H-3** | `src/db.ts` fell back to `Map`/`Set` in-memory stores when Postgres was unreachable (`src/db.ts:21–51, 170`), silently disabling every idempotency guard; boosters minted before reserving. | `packages/shared/src/db.ts` and `redis.ts` have **no fallback path**: a missing/unreachable dependency throws, `startService()` exits 1 before listening, and `/readyz` fails so the container is restarted. Booster ordering is reserve-then-mint: `wager.booster_intents.payment_sig` is the PK with `status='reserved'`, and `ticket_number`/`mint_address` are UNIQUE. |
| **H-5** | `scripts/inject-rpc.mjs` baked `HELIUS_API_KEY` into `VITE_SOLANA_RPC`, shipping the key in the browser bundle. | The key exists only as `EVM_RPC_URL` inside the rpc-proxy container. The stack is EVM-only, so there is no `/rpc/solana` and no `SOLANA_RPC_URL`; Solana remains only as a local ed25519 *login* signature check in the auth service. The browser calls `/rpc/evm`; the gateway rate-limits the prefix and the service applies a method allowlist and per-profile buckets. |
| **H-9** | `index.html:28` loaded `@google/model-viewer` from `cdn.jsdelivr.net`; `index.html:31` loaded Google Fonts. | Gateway CSP: `default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'`, with no third-party host permitted anywhere. model-viewer, PeerJS and the fonts must be self-hosted or dropped — the policy blocks them otherwise. `'unsafe-inline'` is granted to `style-src` only, never `script-src`. |
| **M-1** | The Koa server set no request body limit at all. | `client_max_body_size 256k` at nginx `http` level, so it applies to every route, with no exception. Services independently cap `express.json()` at the same 256 KB (auth at 64 KB). Oversize requests get a 413 in the standard envelope. |
| **M-2** | Settlement had no row lock, so concurrent calls could double-pay. | `withTransaction()` in the shared package, used with `SELECT … FOR UPDATE` on the escrow row, so concurrent settlements serialise. `wager.payouts.escrow_id` is the PRIMARY KEY and `tx_sig` is UNIQUE, so a double payout is a constraint violation even if the lock were dropped. The same pattern already guards refresh-token rotation. |
| **M-12** | `tsconfig.json` carried `"exclude": ["src/server.ts", "src/db.ts"]` — the two most security-critical files were not typechecked. | Every workspace has its own `tsconfig.json` with `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride` and **no `exclude`**. `make typecheck` runs `tsc --noEmit` across all of them; nothing is opted out. |

Also carried over from the contract: the `operator` role comes from
`OPERATOR_ADDRESSES` in env and never from the database (L-1), and privileged
actions are written to `core.audit_log` with the actor taken from `req.auth`.

---

## Shared package API

Every service depends on `"@chains/shared": "*"` and imports from the package
root. TypeScript, ESM, `module: NodeNext` — relative imports inside a service
need the `.js` extension; importing `@chains/shared` does not.

```ts
import { AppError, route, requireAuth, validateBody, startService } from '@chains/shared';
```

### env

```ts
loadEnv(schema, { serviceName }) // parse process.env or exit(1) with every offending var listed
baseEnvShape        // NODE_ENV, LOG_LEVEL, TRUST_PROXY_HOPS, SHUTDOWN_GRACE_MS
postgresEnvShape    // DATABASE_URL (required), PGPOOL_MAX, PGSSL, PG_STATEMENT_TIMEOUT_MS
redisEnvShape       // REDIS_URL (required)
jwtEnvShape         // JWT_SECRET (>=32 chars, required), JWT_ISSUER, JWT_AUDIENCE, ACCESS_TOKEN_TTL_SEC
operatorEnvShape    // OPERATOR_ADDRESSES
serviceEnvShape     // all of the above, spread into your own z.object({...})
parseOperatorAddresses(raw) / isOperatorAddress(set, chain, address)
```

### db

```ts
initDb({ logger })                       // once, at startup; throws without DATABASE_URL
getPool() / query(sql, params) / queryOne(sql, params)
withTransaction(async (tx) => { … }, { isolation? })
db.readyCheck()                          // throws on failure — namespaced, see note below
closeDb()
isUniqueViolation(err) / isForeignKeyViolation(err)
```

`db` and `redis` both export `readyCheck`, so they are also exposed as
namespaces: `import { db, redis } from '@chains/shared'` → `db.readyCheck()`,
`redis.readyCheck()`.

`bigint` columns come back as **strings** (pg default) — keep them that way in
JSON. Ids are cast with `id::text` in queries.

### redis

```ts
initRedis({ logger }) / getRedis() / closeRedis()
redis.readyCheck()
getDel(key)                              // atomic read-and-delete — single-use tokens
setIfAbsent(key, value, ttlSec)
tokenBucket(key, limit, windowSec, cost = 1)
  → { allowed, remaining, retryAfterSec, limit }
```

`tokenBucket` is one Lua `EVAL`, so the check-and-consume is atomic.

### ratelimit

```ts
rateLimit({ name, limit, windowSec, by, cost?, exemptRoles? })  // express middleware
// by: 'ip' | 'profile' | 'address' | (req) => string | null
rateLimitAll(...opts)                    // returns RequestHandler[]
clientIp(req)
```

Sets `RateLimit-Limit`, `RateLimit-Remaining`, `Retry-After`; rejects with
`AppError.rateLimited()`.

### auth

```ts
signAccessToken({ profileId, address, chain, roles?, jti?, ttlSec? }) → string
verifyAccessToken(token) → AuthContext            // throws AppError.unauthorized
requireAuth()                                      // express middleware
optionalAuth()                                     // only legal on public routes
requireRole('operator') / requireOperator()
deriveRoles(chain, address) → string[]             // ['player'] (+ 'operator' from env)
timingSafeEqualStr(a, b)
configureAuth({ secret?, issuer?, audience?, accessTtlSec?, operators? })
route(router, def) / routes(router, defs) / registeredRoutes()
```

**JWT claim shape** — fixed, do not extend without updating ARCHITECTURE.md:

```jsonc
{
  "sub":   "5",            // core.profiles.id, decimal string (bigint-safe)
  "addr":  "0x3fbc…4e6e",  // normalised address
  "chain": "base",
  "roles": ["player"],     // may contain "operator"
  "jti":   "84f17fc8-…",   // the auth.sessions.id that minted this token
  "iat": 1785165892, "exp": 1785166792,
  "iss": "chains-auth", "aud": "chains-api"
}
```

HS256 only, implemented directly on `node:crypto`. The verifier accepts exactly
one algorithm, so `alg: none` and RS256→HS256 confusion are not representable.

**`req.auth`** (populated by `requireAuth`):

```ts
{ profileId: string; address: string; chain: string; roles: string[]; jti: string; expiresAt: number }
```

**The route helper.** This is the safety rail for C-3 — it throws at
registration time, i.e. before the server ever listens:

```ts
route(app, {
  method: 'get',
  path: '/api/profiles/me',
  auth: 'required',                      // or roles: ['operator'], or public: true
  middleware: [validateQuery(Q), rateLimit({ name: 'profile:get', by: 'profile', limit: 60, windowSec: 60 })],
  summary: 'the caller profile',
  handler: async (req, res) => { … req.auth!.profileId … },
});
```

Exactly one of `public: true` or `auth: 'required'` / `roles: [...]` must be
present. Declaring neither, both, or `optionalAuth` on a non-public route throws
with the offending method and path in the message.

### validate

```ts
validateBody(schema) / validateQuery(schema) / validateParams(schema)   // middleware
validatedBody(req, schema) / validatedQuery(...) / validatedParams(...) // typed accessors
strictBody({ … })   // z.strictObject — unknown keys are a 400, not silently dropped
z                   // re-exported zod (v4)
zChain zAddress zEvmAddress zBase58 zUuid zBigIntString zIdParam
zOpaqueToken zSignature zDisplayName zPagination
```

Parsed output lands on `req.valid.{body,query,params}`. `req.query` and
`req.params` are **not** mutated (they are getters in Express 5). Use
`strictBody` for every request body — it is what turns a stray `profileId` in a
payload into a 400 instead of a trusted field.

### errors

```ts
class AppError            // .badRequest .unauthorized .forbidden .notFound .conflict
                          // .unprocessable .rateLimited .payloadTooLarge .internal .unavailable
errorEnvelope(code, message, details?)
errorHandler(logger)      // register LAST
notFoundHandler()         // register after all routes
asyncHandler(fn)
fromDatabaseError(err) / pgErrorCode(err) / isAppError(err)
```

Anything that is not an `AppError` becomes a flat `500 internal`. SQLSTATEs are
mapped to safe codes (`23505` → `conflict`, `23503` → `bad_request`, …) with
generic messages; the constraint body never reaches the client.

### log

```ts
createLogger({ service, level?, base? }) → Logger   // .debug .info .warn .error .child
requestContext(logger)                              // sets req.id, req.log, x-request-id header
nullLogger()
```

Keys such as `authorization`, `token`, `refresh_hash`, `signature`, `password`,
`database_url` are replaced with `[redacted]` at any depth.

### service

```ts
startService({ name, port, deps: { postgres, redis }, bodyLimit?, logLevel?,
               trustProxyHops?, shutdownGraceMs?, extraReadyChecks? },
             ({ app, logger }) => mountRoutes(app))
createApp(options, logger) / finalizeApp(app, logger)
```

`startService` connects and **verifies** the declared dependencies, exits 1 if
any is unreachable, registers `/healthz` and `/readyz`, mounts your routes,
attaches the 404 + error handlers in the right order, listens, and installs
SIGTERM/SIGINT graceful shutdown.

It deliberately installs **no CORS middleware** — see below.

### chains

```ts
CHAINS, CHAIN_SLUGS, ChainSlug, getChain(slug), isSupportedChain(slug)
normalizeAddress(chain, address)   // EVM → lowercase, Solana → verbatim; throws if invalid
isValidAddress(chain, address), addressesEqual(chain, a, b), shortAddress(address)
```

Always store and compare `normalizeAddress()` output. `core.profiles` is keyed
on `unique (address, chain)`, so an unnormalised address creates a second
identity for the same wallet.

---

## Conventions for the other services

- **Path prefixes are not rewritten.** The gateway proxies `/auth/` → `auth:4001`
  with the path intact, so the auth service mounts `/auth/nonce`, not `/nonce`.
  Do the same: profile mounts `/api/…`, game mounts `/games/…` and `/socket.io/…`,
  wager mounts `/wager/…`, rpc-proxy mounts `/rpc/…`. `/healthz` and `/readyz`
  stay at the container root and are not exposed through the gateway.
- **CORS belongs to the gateway and only the gateway.** Do not add
  `Access-Control-*` headers or a `cors` middleware — two layers produce
  duplicate `Access-Control-Allow-Origin` values, which browsers reject outright.
  The allowlist has one source: `ALLOWED_ORIGINS`.
- **Docker build context is `new-backend/`**, not the service directory:
  `build: { context: ., dockerfile: ./services/<name>/Dockerfile }`. Copy
  `services/auth/Dockerfile` — it builds `@chains/shared` first, prunes dev
  dependencies, runs as `USER node`, and healthchecks `/readyz` with Node's
  global `fetch` (no curl in the image).
- **Every table already exists.** Add migrations to `db/migrations/`, never DDL
  in a service.
- Money-touching writes: `withTransaction` + `SELECT … FOR UPDATE`.
- Never log or return a wallet address in a public listing.

### Environment variables the compose file already wires

Shared by every service: `NODE_ENV`, `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`,
`JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `ACCESS_TOKEN_TTL_SEC`,
`OPERATOR_ADDRESSES`, `TRUST_PROXY_HOPS`, `PGPOOL_MAX`, `SERVICE_NAME`, `PORT`.

| Service | Additional |
|---|---|
| auth | `AUTH_DOMAIN`, `AUTH_URI`, `AUTH_STATEMENT`, `NONCE_TTL_SEC`, `REFRESH_TOKEN_TTL_SEC`, `AUTH_RL_IP_LIMIT`, `AUTH_RL_IP_WINDOW_SEC`, `AUTH_RL_ADDRESS_LIMIT`, `AUTH_RL_ADDRESS_WINDOW_SEC` |
| game | `MATCH_RESULT_HMAC_SECRET` |
| wager | `MATCH_RESULT_HMAC_SECRET`, `RPC_PROXY_URL`, `RPC_PROXY_INTERNAL_TOKEN`, `WAGER_ESCROW_KEYPAIR`, `BOOSTER_TREASURY_KEYPAIR`, `BOOSTER_PACK_SEED_SECRET`, `EVM_SUBMIT_RPC_URL`, `EVM_CHAIN_ID`, `EVM_MIN_CONFIRMATIONS`, `WAGER_TOKEN_ADDRESS`, `WAGER_TOKEN_DECIMALS`, `WAGER_STAKE_TIERS_BASE`, `WAGER_BURN_ADDRESS`, `WAGER_BURN_BPS`, `BOOSTER_PRICE_WEI`, `BOOSTER_SUPPLY_CAP`, `BOOSTER_CARD_POOL`, `SETTLEMENT_ENABLED`, `SETTLEMENT_POLL_MS` |
| rpc-proxy | `EVM_RPC_URL`, `RPC_ALLOWED_METHODS`, `RPC_INTERNAL_TOKEN` (fed from `RPC_PROXY_INTERNAL_TOKEN`) |
| gateway | `ALLOWED_ORIGINS` |

Every one of them is documented in [`.env.example`](./.env.example). If a
service needs another variable, add it there **and** to `docker-compose.yml`.

---

## Gateway

In production the gateway answers on **`https://api.ocva.online`** and the web app is
served from **`https://ocva.online`**. TLS is terminated in front of this container, not
in it — nginx here listens on plain :8080 and trusts the `X-Forwarded-Proto` it is given.
Because API and web app are different hosts, every browser call is cross-origin: tokens go
in the `Authorization` header (never cookies) and `ALLOWED_ORIGINS` must list the web
origins exactly.

`gateway/nginx.conf` is mounted as an nginx template and rendered at boot; the
only substitution is `${ALLOWED_ORIGINS_REGEX}`, derived from the comma-separated
`ALLOWED_ORIGINS` by `gateway/docker-entrypoint.d/05-cors-allowlist.envsh`. That
script exits non-zero if `ALLOWED_ORIGINS` contains `*`, and falls back to a
regex that matches nothing if the variable is empty — the gateway fails closed,
never open.

| Prefix | Upstream | Rate limit |
|---|---|---|
| `/auth/` | auth:4001 | 5 r/min burst 10, plus the global 10 r/s |
| `/api/` | profile:4002 | 10 r/s burst 20 |
| `/games/` | game:4003 | 10 r/s burst 20 |
| `/socket.io/` | game:4003 (websocket upgrade) | 10 r/s burst 40 |
| `/wager/` | wager:4004 | 1 r/s burst 5 |
| `/rpc/` | rpc-proxy:4005 | 10 r/s burst 20 |
| anything else | — | JSON 404 |

Per-IP limits stop here. Per-profile limits are enforced in-service with
`rateLimit({ by: 'profile' })`, because an authenticated attacker behind
rotating IPs defeats the former but not the latter.

---

## Layout

```
new-backend/
  ARCHITECTURE.md            the contract
  README.md                  this file
  docker-compose.yml         postgres · redis · migrate · gateway · 5 services
  Makefile                   env, build, typecheck, up, migrate, smoke
  package.json               npm workspaces root
  .env.example
  db/
    Dockerfile               the one-shot migrate image
    package.json             standalone (deliberately not a workspace)
    migrate.mjs              ordered, transactional, checksummed runner
    migrations/
      0001_schemas.sql       citext + auth/core/game/wager schemas
      0002_core.sql          profiles, decks
      0003_auth.sql          nonces, sessions
      0004_game.sql          matches, match_results
      0005_wager.sql         escrows, deposits, payouts, booster_intents, shipping
      0006_audit_log.sql     core.audit_log
  gateway/
    Dockerfile
    nginx.conf
    docker-entrypoint.d/05-cors-allowlist.envsh
  packages/shared/           @chains/shared
    src/{index,env,log,errors,db,redis,auth,validate,ratelimit,service,chains,types}.ts
  scripts/
    smoke-auth.mjs           end-to-end auth assertions
  services/
    auth/                    :4001  ← this service
    profile/ game/ wager/ rpc-proxy/
```
