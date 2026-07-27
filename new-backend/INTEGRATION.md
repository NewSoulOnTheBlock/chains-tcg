# INTEGRATION.md — running the five services together

[`ARCHITECTURE.md`](./ARCHITECTURE.md) is the contract. [`README.md`](./README.md) is the
per-service reference. **This file is what you need to boot the whole stack, what has
actually been verified end to end, and what is still a stub.**

The five services were built in parallel by separate agents, each sandboxed to its own
directory. Nothing had ever run together before this pass. What follows is the state after
integration.

---

## 1. Run it

```bash
cd new-backend
cp .env.example .env          # then fill in the REQUIRED values — see §4
npm install                   # once; all five workspaces resolve @chains/shared from here
docker compose up -d --build  # gateway on http://localhost:8080
docker compose ps
```

Everything except the gateway is bound to `127.0.0.1`. In production **publish only the
gateway.**

Health:

```bash
curl -s localhost:8080/healthz                    # gateway's own liveness
for p in 4001 4002 4003 4004 4005; do curl -s localhost:$p/readyz; echo; done
```

`/healthz` and `/readyz` live at each container's root and are deliberately **not** routed
through the gateway.

Useful:

```bash
docker compose logs -f wager          # the settlement worker logs one line per pass
docker compose exec postgres psql -U chains -d chains
docker compose down                   # keeps volumes
docker compose down -v                # drops the database
```

### Boot order

`migrate` is a one-shot job that must exit 0 before any service starts; every service
declares `migrate: service_completed_successfully`. `wager` additionally waits for
`rpc-proxy` to be healthy, and `gateway` waits for **all five** — nginx resolves upstream
hostnames once at startup, so a service that is not up yet makes the gateway fail to boot.

> **If you rebuild a single service, restart the gateway afterwards.**
> `docker compose up -d --build game && docker compose restart gateway`
> A rebuilt container gets a new IP and nginx is still holding the old one.

### Host port collisions

Published ports are `8080` (gateway) and `5432/6379/4001–4005` on loopback. All are
`${VAR:-default}` in `docker-compose.yml`; if something else on the host owns one, change
it in `.env` (`POSTGRES_PORT`, `REDIS_PORT`, `GATEWAY_PORT`, …) rather than stopping the
other container. Nothing in the stack talks to another service through a published port —
they use the compose network — so remapping is always safe.

---

## 2. Hostnames, TLS and CORS

| | Production | Local dev |
|---|---|---|
| Web app | `https://ocva.online`, `https://www.ocva.online` | `http://localhost:5173` |
| This API | `https://api.ocva.online` | `http://localhost:8080` |
| `AUTH_DOMAIN` | `ocva.online` | `localhost:8080` |

**TLS is not terminated here.** nginx listens on plain `:8080` and expects to sit behind a
terminator (load balancer / ingress / Cloudflare). It reads `X-Forwarded-Proto` from that
terminator and forwards it to the services in place of `$scheme`; `TRUST_PROXY_HOPS=1`
because there is exactly one hop. Do not add `ssl_certificate` to `gateway/nginx.conf`.
That also means **nothing but the terminator may reach port 8080** — a client that could
hit it directly could assert `X-Forwarded-Proto: https`.

**The API is a different host from the web app**, so every browser call is cross-origin:

- Tokens travel in the **`Authorization: Bearer` header, never in cookies.** There is no
  shared cookie domain between `ocva.online` and `api.ocva.online`, and nothing here is
  `SameSite`-protected. Store the pair in memory or `localStorage`; the access token is
  15 minutes and the refresh token rotates.
- `ALLOWED_ORIGINS` must name the web origins **exactly**, including scheme:
  `https://ocva.online,https://www.ocva.online`. `www` is a separate origin to a browser.
- CORS headers come from the gateway and **only** the gateway. No service sets
  `Access-Control-*`; two layers would emit duplicate `Access-Control-Allow-Origin`, which
  browsers reject outright.
- The entrypoint refuses `*` and falls back to a match-nothing regex when the variable is
  empty. It fails closed.

### The signed message domain — the security-relevant one

`AUTH_DOMAIN` is what the wallet displays and what binds a signature to this deployment.
**It is read from env and from nothing else.** It is *not* derived from the request's
`Host` or `Origin` header — that was checked during integration and was already correct.
This matters: if the domain came from a client-controlled header, any site could ask a
wallet to sign `evil.example wants you to sign in…` and replay the signature here.

Two further properties, both already implemented:

- `/auth/verify` re-derives the message from its own stored nonce record and compares it to
  the stored copy; it will not verify a signature over any string it did not mint.
- It additionally rejects a stored nonce whose `domain` differs from the current
  `AUTH_DOMAIN`, so rotating the value invalidates in-flight challenges instead of
  accepting both old and new.

Integration change: `AUTH_DOMAIN`/`AUTH_URI` are now `:?required` in `docker-compose.yml`.
They previously defaulted to `localhost:8080`, which meant a production deploy that forgot
to set them would silently mint challenges for `localhost` — exactly the class of bug this
backend exists to prevent.

---

## 3. Route table

Auth levels: **public** = no token; **auth** = any valid access token; **operator** =
token whose `roles` contains `operator`, which comes from `OPERATOR_ADDRESSES` in env and
never from the database (L-1). The shared `route()` helper throws at startup if a route
declares neither `public: true` nor an auth requirement — a missing check is a boot
failure, not a silent hole (C-3).

### auth — :4001, gateway prefix `/auth/` (5 r/min burst 10)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/nonce` | public | mints the SIWE-style challenge; single-use, 5 min TTL, per-IP + per-address buckets |
| POST | `/auth/verify` | public | signature → token pair; consumes the nonce atomically (`GETDEL`) |
| POST | `/auth/refresh` | public | rotates; **reuse revokes the whole family** |
| POST | `/auth/logout` | auth | revokes the family the access token's `jti` belongs to |
| GET | `/auth/me` | auth | the caller's own profile **including their address** |

### profile — :4002, gateway prefix `/api/` (10 r/s burst 20)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/profiles/me` | auth | the only route that returns a wallet address, and only to its owner |
| PATCH | `/api/profiles/me` | auth | operates on `req.auth.profileId` only; there is no route that takes a target profile |
| GET | `/api/profiles/:displayName` | public | display name, avatar, bio, wins, losses, level — **no address** |
| GET | `/api/profiles/:displayName/matches` | public | match history |
| GET | `/api/leaderboard` | public | **no addresses** |
| GET | `/api/decks` | auth | the caller's decks |
| POST | `/api/decks` | auth | card legality + copy limits; size not enforced (work in progress decks) |
| PUT | `/api/decks/:id` | auth | ownership is the `WHERE` clause |
| DELETE | `/api/decks/:id` | auth | ownership is the `WHERE` clause |
| POST | `/api/decks/:id/activate` | auth | **full 60-card legality enforced here and only here** |

### game — :4003, gateway prefixes `/games/` and `/socket.io/`

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/games/lobby` | auth | returns `{matchID, mode, seats[{filled, displayName}], createdAt}` — never `setupData`, decklists or credentials |
| GET | `/games/invites` | auth | matches addressed to the caller |
| POST | `/games/create` | auth | seats the caller at seat 0; attaches their **active** deck server-side |
| POST | `/games/:id/join` | auth | seats the caller at seat 1; materialises the boardgame.io match |
| GET | `/games/:id/seat` | auth | the caller's OWN seat + boardgame.io credentials; a non-participant gets **404**, not 403 |
| POST | `/games/:id/cancel` | auth | cancel your own still-open match |
| WS | `/socket.io/` | boardgame.io credentials | the match transport |

boardgame.io's own lobby REST API (`GET /games/:name`, `/create`, `/join`, `/playAgain`)
is **not mounted** — `Server.run()` is never called, so those routes do not exist in the
process at all. That is the H-7 fix.

**There is no route anywhere that accepts a match result.**

### wager — :4004, gateway prefix `/wager/` (1 r/s burst 5)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/wager/stakes` | auth | the server-decided stake allowlist |
| POST | `/wager/escrows` | auth (participant) | body names a **tier index**, never an amount |
| GET | `/wager/escrows/:id` | auth (participant/operator) | funding booleans per seat; never the opponent's address |
| POST | `/wager/escrows/:id/deposits` | auth (participant) | body is `{txHash}` only; seat and payer come from the session |
| POST | `/wager/escrows/:id/void` | **operator** | stuck-escrow escape hatch; mandatory reason, written to `core.audit_log` |
| GET | `/wager/boosters/supply` | public | remaining supply |
| POST | `/wager/boosters/intents` | auth | server-issued offer: nonce, exact price, expiry |
| POST | `/wager/boosters/confirm` | auth | binds a payment tx to one offer |
| GET | `/wager/boosters/tickets` | auth | the caller's tickets |
| GET | `/wager/boosters/tickets/:n` | auth | one ticket, owner only |
| POST | `/wager/boosters/tickets/:n/redeem/{digital,physical,merch}` | auth | one redemption per kind per ticket (DB constraint) |
| GET | `/wager/boosters/tickets/:n/shipping` | auth (owner or operator) | personal data, H-2 |

**There is no settlement endpoint.** `POST /wager/settle`, `POST /wager/escrows/:id/settle`
and the legacy `POST /api/result` all 404. Payouts are decided by the worker, from
HMAC-verified `game.match_results` rows, and by nothing else.

### rpc-proxy — :4005, gateway prefix `/rpc/` (10 r/s burst 20)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/rpc/evm` | public (+ optional auth) | read-only JSON-RPC; a valid token buys a higher per-profile bucket, an internal token buys the service tier |
| GET | `/rpc/evm` | public | 405 with `Allow: POST` |

**EVM only.** There is no `/rpc/solana` — the Anchor program was never deployed.
`eth_sendRawTransaction`, `eth_sendTransaction`, `eth_sign`, `personal_sign` and
`eth_accounts` are refused with 403. `RPC_ALLOWED_METHODS` can only narrow the built-in
allowlist, never widen it, so a leaked proxy credential is not a broadcast path. Signed
payouts leave the wager service directly via `EVM_SUBMIT_RPC_URL`.

---

## 4. Environment reference

`.env` is gitignored and holds real values. `.env.example` is the only file in git and
**must never contain a real secret** — it documents the generation command instead.

### Required — the stack will not render or boot without these

| Variable | Used by | How to generate |
|---|---|---|
| `JWT_SECRET` | all | `openssl rand -hex 32` (≥32 chars) |
| `POSTGRES_PASSWORD` | postgres, all | `openssl rand -base64 24 \| tr -d '=+/'` |
| `MATCH_RESULT_HMAC_SECRET` | **game + wager, shared** | `openssl rand -hex 32` |
| `ALLOWED_ORIGINS` | gateway | exact web origins, comma-separated, never `*` |
| `AUTH_DOMAIN` / `AUTH_URI` | auth | `ocva.online` / `https://ocva.online` |
| `EVM_RPC_URL` | rpc-proxy | your provider URL **with** the API key |
| `WAGER_ESCROW_KEYPAIR` | wager | `printf '0x%s\n' "$(openssl rand -hex 32)"` |
| `BOOSTER_TREASURY_KEYPAIR` | wager | same, **a different key** — see H-4 below |
| `BOOSTER_PACK_SEED_SECRET` | wager | `openssl rand -hex 32` |

**H-4:** `loadKeys()` derives both addresses and **refuses to start if they are equal.**
The legacy booster mint fell back to the escrow key when the treasury key was unset, so one
hot wallet held both player stakes and the mint authority; compromising the shop key
drained every open wager. There is no fallback here. For real money use a hardware signer
or a KMS — an env var is a dev affordance.

### Optional — sensible defaults, safe to leave alone in dev

| Variable | Default | Meaning |
|---|---|---|
| `EVM_SUBMIT_RPC_URL` | Sepolia public node | where signed payouts are broadcast; **cannot** be the proxy |
| `EVM_CHAIN_ID` | `11155111` | Sepolia |
| `EVM_MIN_CONFIRMATIONS` | `2` | blocks before a deposit counts |
| `WAGER_TOKEN_ADDRESS` | Sepolia USDC | the **only** ERC-20 the escrow accepts |
| `WAGER_TOKEN_DECIMALS` | `6` | display only; all arithmetic is base units |
| `WAGER_STAKE_TIERS_BASE` | `1000000,5000000,25000000` | the amount allowlist; a client names an index, never an amount |
| `WAGER_BURN_ADDRESS` / `WAGER_BURN_BPS` | `0x…dead` / `1000` | protocol cut (10%), modelled as an ordinary payout leg; `0` disables |
| `BOOSTER_PRICE_WEI` | `3500000000000000` | native-currency price |
| `BOOSTER_SUPPLY_CAP` | `2000` | runtime cap; the DB counter row is a second, independent bound |
| `BOOSTER_CARD_POOL` | *(empty)* | **empty on purpose** — with no pool, digital redemption answers 503 rather than inventing card ids |
| `RPC_PROXY_INTERNAL_TOKEN` | *(empty)* | reaches rpc-proxy as `RPC_INTERNAL_TOKEN` and wager as `RPC_PROXY_INTERNAL_TOKEN`; buys a rate-limit tier and **nothing else** |
| `RPC_ALLOWED_METHODS` | *(empty)* | narrows the built-in allowlist only |
| `SETTLEMENT_ENABLED` / `SETTLEMENT_POLL_MS` | `true` / `5000` | the settlement worker |
| `OPERATOR_ADDRESSES` | *(empty)* | `chain:address` pairs; the **only** source of the operator role |

### Removed during integration

`SOLANA_RPC_URL`, `SOLANA_CLUSTER` and `ESCROW_TREASURY_SECRET` are gone from
`.env.example` and `docker-compose.yml`. The chain scope is EVM only. Solana **login**
signature verification stays in the auth service — it is a local ed25519 check over bytes
the server minted, not a chain call, and needs no endpoint.

---

## 5. What integration had to fix

The services were individually sound. Everything below was a seam between them.

1. **The C-1 HMAC pre-image did not match across services — this was the important one.**
   `services/game/src/results/sign.ts` joined the tuple with `|`; the wager service's
   `canonicalMatchResultMessage` joined it with `\n`. Both were internally consistent and
   both had passing unit tests, because each service only ever tested against itself. In
   production **every legitimate match result would have failed HMAC verification and no
   winner would ever have been paid.** The game service was changed to `\n` (the documented
   canonical form) and both files now carry a comment pointing at the other.
2. **wager and rpc-proxy env was never wired into compose.** The wager service fails
   closed at boot without its keypairs, so the container never started. Added all of §4,
   with `:?required` on the three real secrets and defaults for the rest.
3. **`RPC_PROXY_INTERNAL_TOKEN` vs `RPC_INTERNAL_TOKEN`.** The two services named the same
   shared secret differently. One `.env` variable now feeds both under their own names.
4. **Dead Solana config.** Removed `SOLANA_RPC_URL`, `SOLANA_CLUSTER`,
   `ESCROW_TREASURY_SECRET`; `SOLANA_RPC_URL` was `:?required`, so the stack could not even
   render without a value for a service that no longer reads it.
5. **`/wager/shipping` in nginx matched no route** and granted it a 1 MB body cap. The real
   route is `/wager/boosters/tickets/:n/shipping`, which the `/wager/` prefix already
   covers. Removed — an unused location that relaxes the body cap is a hole with no upside.
6. **`ARCHITECTURE.md` documented the void route as `POST /wager/:id/void`**; the
   implemented path is `POST /wager/escrows/:id/void`. Corrected, along with the Solana
   references and the now-removed 1 MB shipping exception.
7. **`npm install` had never been run at the root**, so no workspace was in the lockfile.
   Run; all five resolve `@chains/shared` from `packages/shared`.
8. **`AUTH_DOMAIN`/`AUTH_URI` defaulted to localhost** in compose. Made `:?required`.
9. **`X-Forwarded-Proto` was hardcoded to `$scheme`**, which is always `http` behind a TLS
   terminator. Now honours an inbound value and falls back to `$scheme`.

Nothing needed fixing in the Dockerfiles, the build contexts, the migration ordering or the
workspace resolution — all six images built and the full stack came up on the first
`docker compose up` once the env was wired.

---

## 6. What is verified

Every claim below was executed against the running stack **through the gateway on :8080**.
67/67 checks pass (33 + 14 + 20). Transcripts are in the integration report.

| # | Claim | Evidence |
|---|---|---|
| 1 | `/readyz` on every service reports its dependencies reachable | auth/profile/game/wager all `{"postgres":"ok","redis":"ok"}`; rpc-proxy `{"redis":"ok"}` — it declares no postgres dependency because it uses none |
| 2 | Full auth flow | nonce → EIP-191 sign → verify → HS256 JWT → `/auth/me` → refresh rotates → old refresh 401 → **successor also 401** (family revoked) → replayed nonce 401 |
| 3 | Authorization is real | unauthenticated protected route → 401; tampered JWT → 401; A editing/deleting/activating B's deck → **404 from the ownership `WHERE` clause**, B's row unchanged, with a *valid* body field so it is not body validation; `profileId` in a body → 400 (`strictBody`); spoofed `X-Profile-Id`/`X-Auth-Roles`/`X-Operator` headers stripped by the gateway |
| 4 | Profile/deck | 60-card deck created and activated; illegal deck → 400; public profile view and `/api/leaderboard` contain **no wallet address**; `/api/profiles/me` does return the owner's own address |
| 5 | Game | match created and joined by two separate authenticated identities; `/games/lobby` returns only `{matchID, mode, seats[{filled, displayName}], createdAt}`; **real socket.io play through the gateway** — both seats synced, opponent's hand masked (`"hidden"` ×7) and both decks wiped in `playerView`, a move with forged credentials silently discarded, a legal `concede` applied and broadcast (`_stateID 0→1`, `ctx.gameover={"winner":"0","reason":"concede"}`) |
| 6 | **C-1** | a row forged directly in Postgres with `server_sig=deadbeef…` → worker logs `match_result_sig_invalid`, `settlement_pass_complete rejected:1`, **zero** `wager.payouts` rows, zero legs, escrow still `open`. Replacing only `server_sig` with a correct HMAC → `paid:1`, payout row appears, escrow `settled`. Separately, the row the **game service itself** wrote for the socket match verifies byte-for-byte under the **wager service's** canonical pre-image — confirming the game service inserts the exact `finished_at` it hashed, not `now()` |
| 7 | **C-2** | one signature, then: same sig for the other seat → `23505 deposits_pkey`; same sig for a different escrow → `23505 deposits_pkey`; a different sig for an already-funded seat → `23505 deposits_escrow_id_seat_key`. Over HTTP both replays return `409 signature_already_used` against escrows still `open`. Exactly one row ends up holding the signature |
| 8 | Gateway hardening | 400 KB body → `413`; disallowed origins (`evil.example`, a suffix-confusion origin, `null`) get **no** `Access-Control-Allow-Origin`; `/rpc/evm` refuses `eth_sendRawTransaction`/`eth_sendTransaction`/`eth_sign`/`personal_sign`/`eth_accounts` with 403 while `eth_chainId` proxies through (`0xaa36a7`); all three rate-limit zones return 429 under a burst |

Also verified: there is no settlement endpoint (`POST /wager/settle`,
`/wager/escrows/:id/settle` and the legacy `POST /api/result` all 404); the operator-only
void route returns 403 to a player token; an escrow body carrying `amountBase` is a 400.

### Reproducing

```bash
node scripts/verify-core.mjs      # readiness, auth, authorization, profile/deck, game + socket
node scripts/verify-money.mjs     # C-1 and C-2
node scripts/verify-gateway.mjs   # body cap, CORS, RPC allowlist, rate limits
```

These scripts **pace themselves under the real rate limits and back off on 429 rather than
relaxing them**, so `verify-core` takes a few minutes. Run them one at a time; run them
against a stack that has been up for a minute so the `/auth/` bucket is not already spent.

---

## 7. What is still stubbed

Be explicit about this before anyone points real money at it.

- **Booster minting is `TODO: chain integration pending`.** `UnavailableTicketMinter` is
  wired in `bootstrap.ts`; reservation, ticket numbering, the supply cap and the
  idempotency constraints are all real and enforced in the database, but **no NFT is ever
  minted.** `booster_intents.mint_address` and `token_id` stay `NULL`.
- **There is no deployed escrow contract.** `escrows.deposit_address` is a *recorded EOA
  per escrow* — the address the wager service's own key controls, frozen at escrow
  creation so rotating the key cannot redefine what an existing escrow accepts. Funds sit
  in a hot wallet, not in a contract. This is the single largest gap between this design
  and a trustworthy one.
- **Digital redemption is off.** `BOOSTER_CARD_POOL` is empty, so the route answers 503
  rather than inventing card ids. That is deliberate.
- **No payout has ever been executed on-chain.** The C-1 test settles a `noop` plan (no
  seat was funded), so `payoutRunner`'s sign → persist → broadcast → reconcile path is
  covered by unit tests but has **never run against a real chain**. Deposit verification
  (`verifyDepositTx`) has likewise never seen a real transfer.
- **The Solana Anchor program in `solana/` is dead code** and nothing in this backend
  references it.

---

## 8. Frontend migration checklist

Cutting the legacy app in `src/` over to this backend. API base is
**`https://api.ocva.online`**, with `VITE_*` overrides pointing at `http://localhost:8080`
for local development:

```bash
# .env.production
VITE_API_BASE=https://api.ocva.online
# .env.development
VITE_API_BASE=http://localhost:8080
```

1. **Wallet login replaces `?name=`.** Delete every path that takes an identity from a
   query parameter, a body field or `localStorage`. The new flow is:
   `POST /auth/nonce {address, chain}` → wallet signs the returned `message` **verbatim**
   → `POST /auth/verify {address, chain, signature, nonce}` → store the pair. Send
   `Authorization: Bearer <accessToken>` on every call. Refresh at
   `POST /auth/refresh {refreshToken}` and **replace both tokens** — reuse of a refresh
   token revokes the entire family and forces a re-sign. Tokens are **not** cookies; the
   API is a different origin.
2. **The lobby moves to `GET /games/lobby`.** boardgame.io's `GET /games/chains-tcg` no
   longer exists. The response is `{matchID, mode, seats[{filled, displayName}],
   createdAt}` — no `setupData`, no decklists, no player ids. Create with
   `POST /games/create`, join with `POST /games/:id/join` (empty body), and get your own
   seat + socket credentials from `GET /games/:id/seat`. **Do not send a deck** — the
   server attaches your active deck from `core.decks`. Set one with
   `POST /api/decks/:id/activate` first, or create/join returns an error.
3. **The client stops reporting match results entirely.** Delete `POST /api/result` and
   every call site. The game service derives outcomes from its own boardgame.io state and
   writes them itself. There is no endpoint to call and no request shape that can name a
   winner. Read history from `GET /api/profiles/:displayName/matches`.
4. **Deposits post only a signature.** `POST /wager/escrows/:id/deposits {txHash}` —
   nothing else. The seat comes from the session, the amount from the escrow, the payer
   from the verified transfer log. Open an escrow with `POST /wager/escrows {matchId,
   tier}` where `tier` is an **index into the server's allowlist**; there is no `amount`
   field and sending one is a 400. Read available tiers from `GET /wager/stakes`.
5. **RPC goes through `/rpc/evm`.** Remove `scripts/inject-rpc.mjs` and every
   `VITE_SOLANA_RPC` / `VITE_*_RPC` / `HELIUS_API_KEY` reference — no RPC credential may
   appear in the bundle. Point viem/ethers at `${VITE_API_BASE}/rpc/evm`. It is
   **read-only**: `eth_sendRawTransaction` is refused, so the browser must broadcast
   through the user's own wallet provider, not through us.
6. **CSP consequences.** The gateway sends `default-src 'self'; script-src 'self'` with no
   third-party hosts. `@google/model-viewer` from jsDelivr, Google Fonts and PeerJS
   (`index.html:28,31`) **will be blocked**. Self-host them with subresource integrity or
   drop them.
7. **Error handling is uniform.** Every error from every service and from the gateway is
   `{"error":{"code":"…","message":"…","details":{…}}}`. Write one parser. Handle `401`
   by refreshing once then re-signing, and `429` by honouring `Retry-After`.
8. **Ids are strings.** `profileId`, deck ids and match ids are bigint-safe decimal
   strings. Do not `parseInt` them.

---

## 9. Top risks before this handles real money

1. **Custodial hot wallet, no escrow contract.** `WAGER_ESCROW_KEYPAIR` is a plain env var
   inside a container, and it holds every player's stake. Anyone with the env, a shell in
   the container, or a copy of the compose file can drain it. The database guarantees are
   excellent; the key custody is not. This needs a contract, or at minimum a KMS/HSM signer
   with a withdrawal policy, before it holds anything.
2. **The payout path has never touched a chain.** Sign → persist → broadcast → reconcile is
   well-argued and unit-tested, but the first real payout will be the first execution.
   Exercise it on a testnet with a funded key, including a forced crash between broadcast
   and record, before mainnet.
3. **Deposit verification is unproven.** `verifyDepositTx` checks amount, token, sender,
   recipient, recency and confirmations, and has never seen a real ERC-20 `Transfer` log.
   Same treatment needed.
4. **`MATCH_RESULT_HMAC_SECRET` is the whole of C-1.** Anyone holding it plus a database
   connection can mint a payable result. It is shared by two services as an env var. It
   should be rotatable, and rotation needs a plan (rows signed under the old key become
   unverifiable). Consider a signature scheme where the wager service holds only a public
   key, so a wager-side compromise cannot forge results at all.
5. **The two verified fixes were verified against a `noop` settlement.** The C-1 test
   settled an escrow with no deposits. A funded escrow paying a real winner, a draw
   refunding both payers, and a partial refund have not been executed end to end.
6. **No alerting on the settlement worker.** `/readyz` fails if a pass has not completed in
   ~60s, which restarts the container — but a worker that completes passes while
   *rejecting* every candidate looks healthy. `match_result_sig_invalid` at any rate above
   zero means either an attack or a broken contract (it was broken until this pass) and
   should page someone.
7. **Booster supply cap is enforced in two places** (the `booster_counter` row and
   `BOOSTER_SUPPLY_CAP`) that can disagree. The service takes the minimum, which is safe,
   but the duplication invites drift.
8. **Rate limits are per-IP at the gateway.** An authenticated attacker behind rotating IPs
   defeats them; the per-profile Redis buckets are the real defence and are only applied on
   some routes. Audit that every money-touching route has one.
9. **No audit-log review path.** `core.audit_log` is written on operator actions and never
   read by anything. An operator voiding escrows to an address they control would leave a
   perfect trail that nobody looks at.
