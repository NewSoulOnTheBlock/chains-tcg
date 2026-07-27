# Chains TCG — Secure Backend (v2)

This backend replaces the single Koa server in `src/server.ts`. It exists because the
27 July 2026 audit (`SECURITY_AUDIT.pdf`) found that **no REST route was authenticated**
and that the custodial escrow could be drained with `curl`. Every design decision below
maps to a finding in that report.

## Non-negotiable rules

1. **No route trusts a client-supplied identity.** A `name`, `wallet` or `playerID` in a
   request body is data, never identity. Identity comes only from a verified session
   (`req.auth.profileId`). *(fixes C-3)*
2. **Money moves only from server-observed facts.** Match outcomes come from the game
   service's own authoritative state, never from an HTTP body. *(fixes C-1)*
3. **Every external value is idempotency-keyed in the database with a `UNIQUE`
   constraint**, not with an in-process check. *(fixes C-2, H-3)*
4. **No silent degradation.** If Postgres or Redis is unreachable the service fails its
   health check and exits; it never falls back to in-memory state. *(fixes H-3)*
5. **Secrets never reach the client bundle.** RPC access goes through a server-side proxy
   with its own rate limit. *(fixes H-5)*
6. **Personal data is need-to-know.** Shipping addresses and e-mails are readable only by
   their owner or an operator; wallet addresses are never in public listings. *(fixes H-2)*

## Services

```
                         ┌──────────────┐
   browser ──────────────►   gateway    │  nginx · TLS · rate limit · body cap · CORS · CSP
                         └──────┬───────┘
              ┌─────────────────┼───────────────────┬────────────────────┐
              ▼                 ▼                   ▼                    ▼
        ┌───────────┐    ┌─────────────┐     ┌────────────┐      ┌─────────────┐
        │   auth    │    │   profile   │     │    game    │      │    wager    │
        │  :4001    │    │    :4002    │     │   :4003    │      │    :4004    │
        └─────┬─────┘    └──────┬──────┘     └─────┬──────┘      └──────┬──────┘
              │                 │                  │                    │
              └────────┬────────┴─────────┬────────┴──────────┬─────────┘
                       ▼                  ▼                   ▼
                 ┌──────────┐       ┌──────────┐        ┌───────────┐
                 │ postgres │       │  redis   │        │ rpc-proxy │
                 │  :5432   │       │  :6379   │        │   :4005   │
                 └──────────┘       └──────────┘        └───────────┘
```

Only the gateway is published to the host. The service and datastore ports above
are container-internal; compose binds them to `127.0.0.1` for debugging only.

| Service | Owns | Never does |
|---|---|---|
| **auth** | nonces, signature verification, sessions, JWT issuing/rotation | business data |
| **profile** | profiles, decks, leaderboard, match history | payments, match state |
| **game** | boardgame.io server, match lifecycle, **authoritative results** | payouts |
| **wager** | escrow deposits, settlement, payouts, booster tickets | deciding who won |
| **rpc-proxy** | outbound EVM RPC with the real API key | anything user-facing, and `eth_sendRawTransaction` |

**Chain scope: EVM only.** The repo's `solana/` directory contains an Anchor program that was
never deployed, so nothing in this backend may depend on it. Escrow, deposits, payouts and
booster minting are EVM paths. The only Solana code that remains is wallet **login**
signature verification (ed25519), because players may still sign in with a Solana wallet.
That is a local `tweetnacl` check over bytes the auth service itself minted — it makes no
network call, so there is **no `SOLANA_RPC_URL`, no `SOLANA_CLUSTER` and no `/rpc/solana`**
anywhere in this stack. `ESCROW_TREASURY_SECRET` (the old custodial Solana treasury key) is
likewise gone; the EVM escrow signer is `WAGER_ESCROW_KEYPAIR`.

**Reads and writes take different paths.** The rpc-proxy is read-only: its allowlist has no
`eth_sendRawTransaction`, so a leaked proxy credential can never broadcast. Signed payouts
leave the wager service directly via `EVM_SUBMIT_RPC_URL`.

The **game service is the only source of match outcomes.** When a match ends it writes a
signed `match_results` row; the wager service settles strictly from those rows and never
from an inbound HTTP request. This is the structural fix for C-1 — there is no request
shape that can make the escrow pay out.

## Authentication model

Wallet-based, challenge–response. No passwords, no bearer-name.

```
POST /auth/nonce      { address, chain }        → { nonce, expiresAt }   nonce stored in redis, single use, 5 min TTL
POST /auth/verify     { address, chain, signature }
                        → verifies signature over the exact SIWE-style message
                        → { accessToken (JWT, 15 min), refreshToken (opaque, 30 d, rotated) }
POST /auth/refresh    { refreshToken }          → new pair, old one revoked (reuse ⇒ revoke family)
POST /auth/logout     Authorization: Bearer …   → revokes the refresh family
GET  /auth/me         Authorization: Bearer …   → { profileId, address, displayName, roles }
```

- Signature verification: EVM via `viem.verifyMessage`, Solana via `tweetnacl` over the
  ed25519 signature. The message embeds domain, nonce, address, chain id and issue time;
  the server re-derives it and refuses anything it did not mint. *(fixes C-3)*
- JWT: HS256 with `JWT_SECRET`, claims `{ sub: profileId, addr, chain, roles, jti }`.
  Access tokens are short-lived; refresh tokens live in Postgres, hashed, one row per
  device, rotated on every use with reuse-detection.
- Every other service validates the JWT locally (shared secret, no network hop) and
  populates `req.auth`. **A route with no `requireAuth` middleware is a bug**; the shared
  router helper refuses to register a non-public route without it.
- Operator actions require `roles` to contain `operator`; the operator list comes from env,
  never from the database, and admin token comparison uses `timingSafeEqual`. *(fixes L-1)*

## Database

Single Postgres instance, one schema per service, **migrations only** (no `CREATE TABLE IF
NOT EXISTS` at boot). Every table has `created_at timestamptz not null default now()`.

Key constraints that encode the audit fixes:

```sql
-- auth
create table auth.nonces        (nonce text primary key, address text not null, chain text not null,
                                 expires_at timestamptz not null, consumed_at timestamptz);
create table auth.sessions      (id uuid primary key, profile_id bigint not null references core.profiles(id),
                                 refresh_hash text not null unique, family_id uuid not null,
                                 revoked_at timestamptz, expires_at timestamptz not null);

-- core
create table core.profiles      (id bigserial primary key, address text not null, chain text not null,
                                 display_name citext not null unique, avatar_url text, bio text,
                                 wins int not null default 0, losses int not null default 0,
                                 unique (address, chain));
create table core.decks         (id bigserial primary key, profile_id bigint not null references core.profiles(id) on delete cascade,
                                 name text not null, cards jsonb not null);

-- game  (authoritative outcomes — the ONLY input the wager service accepts)
create table game.matches       (id text primary key, mode text not null, wager_id text,
                                 seat0_profile bigint references core.profiles(id),
                                 seat1_profile bigint references core.profiles(id),
                                 status text not null check (status in ('open','live','finished','void')),
                                 unlisted boolean not null default false);
create table game.match_results (match_id text primary key references game.matches(id),
                                 winner_seat smallint check (winner_seat in (0,1)),  -- null = draw
                                 reason text not null,            -- 'life','deckout','concede','timeout'
                                 finished_at timestamptz not null default now(),
                                 server_sig text not null);       -- HMAC over the row, so wager can verify provenance

-- wager  (C-2: one signature can fund exactly one seat of one match, forever)
create table wager.escrows      (id text primary key, amount_base bigint not null, token text not null,
                                 status text not null check (status in ('open','funded','settled','refunded','void')));
create table wager.deposits     (signature text primary key,               -- GLOBAL uniqueness
                                 escrow_id text not null references wager.escrows(id),
                                 seat smallint not null check (seat in (0,1)),
                                 profile_id bigint not null references core.profiles(id),
                                 amount_base bigint not null,
                                 unique (escrow_id, seat));                -- one deposit per seat
create table wager.payouts      (escrow_id text primary key references wager.escrows(id),
                                 tx_sig text not null unique, paid_at timestamptz not null default now());

-- boosters (H-3: reserve before mint)
create table wager.booster_intents (payment_sig text primary key, profile_id bigint not null,
                                    reserved_at timestamptz not null default now(),
                                    ticket_number int unique, mint_address text unique,
                                    status text not null check (status in ('reserved','minted','failed')));
create table wager.shipping        (ticket_id bigint primary key, profile_id bigint not null,
                                    payload jsonb not null);   -- readable only by owner or operator
```

Money-touching writes run inside `BEGIN … SELECT … FOR UPDATE … COMMIT`. The settlement
path takes a row lock on the escrow, so concurrent calls serialise instead of double-paying.
*(fixes M-2)*

## Deposit verification (C-2)

`markFunded` equivalent must, in one transaction:

1. `INSERT INTO wager.deposits (signature, …)` — a replayed signature violates the primary
   key and a second deposit for a seat violates `unique (escrow_id, seat)`. The database,
   not application logic, is the guard.
2. Verify on-chain: transfer exists, **exact** amount, correct mint, `from` is the
   authenticated profile's address, `to` is the escrow ATA, and the memo equals
   `chains:<escrowId>:<seat>` — **a missing or mismatched memo rejects the deposit**
   (previously only a warning).
3. Verify recency: the transaction must be newer than the escrow's `created_at`, so old
   unrelated transfers can never be redeemed.

## Settlement (C-1)

```
game service:  match ends → writes game.match_results with an HMAC over (match_id, winner_seat, reason, finished_at)
wager service: worker polls/subscribes → for each finished match with an escrow:
                 verify HMAC → lock escrow row → pay winner (or refund both on draw) → record payout tx
```

The canonical HMAC pre-image is, byte for byte in both services:

```
<match_id> "\n" <winner_seat|""> "\n" <reason> "\n" <finished_at ISO-8601 UTC, ms>
```

A draw serialises `winner_seat` as the empty string. **The game service must INSERT the
exact `finished_at` it hashed** — never `DEFAULT now()`, because the database clock is not
what was signed and the row would then be unverifiable. `services/game/src/results/sign.ts`
and `services/wager/src/domain/matchResult.ts` are the two implementations and must stay
identical.

There is **no public settlement endpoint.** The operator-only
`POST /wager/escrows/:id/void` exists solely for stuck escrows and requires the `operator`
role plus a reason string that is written to `core.audit_log`.

## Gateway hardening

- Body size cap **256 KB** on every route (`client_max_body_size`). *(fixes M-1)* There is
  no larger exception: the shipping form lives at
  `POST /wager/boosters/tickets/:n/shipping` and a postal address fits in 256 KB, so the
  old `/wager/shipping` 1 MB location was removed rather than left as an unused hole.
- Rate limits: 10 req/s burst 20 per IP globally; 5 req/min on `/auth/*`; 1 req/s on
  `/wager/*`; per-profile limits enforced in-service via Redis token buckets.
- CORS: explicit origin allowlist from env, credentials allowed, **never `*`**. The API is
  a different host from the web app (`api.ocva.online` vs `ocva.online`), so every browser
  call is cross-origin: `ALLOWED_ORIGINS` must name `https://ocva.online` and
  `https://www.ocva.online` exactly, and tokens travel in the `Authorization: Bearer`
  header rather than cookies — there is no shared cookie domain to lean on.
- TLS is **not** terminated here. The gateway expects to sit behind a terminator and to
  receive `X-Forwarded-Proto`, which it forwards to the services in place of `$scheme`.
- CSP: `default-src 'self'`, no third-party script hosts; PeerJS and model-viewer must be
  self-hosted or dropped. Subresource integrity on anything that remains. *(fixes H-9)*
- Public listings never include wallet addresses. Match listings never include
  `setupData` — the lobby returns seat counts and display names only, and deck lists stay
  server-side until the match starts. *(fixes H-7, H-2)*

## What the frontend has to change

1. Login becomes: request nonce → wallet signs → store the token pair → send
   `Authorization: Bearer` on every call. The `?name=` query parameter disappears.
   The API base is `https://api.ocva.online`; the signed message names `ocva.online`,
   the web app's own origin, because that is what the user sees in the wallet prompt.
2. Match results are no longer reported by the client at all.
3. Deposits post only the signature; the server derives who and how much.
4. RPC calls go to `/rpc/evm` instead of embedding keys.

## Layout

```
new-backend/
  ARCHITECTURE.md          this file — the contract every service implements
  docker-compose.yml       postgres · redis · gateway · 5 services
  .env.example
  gateway/nginx.conf
  db/migrations/           NNNN_name.sql, applied in order by the migrate job
  packages/shared/         JWT verify middleware, error envelope, logger, zod schemas, db pool, redis
  services/auth/
  services/profile/
  services/game/
  services/wager/
  services/rpc-proxy/
```

**Conventions for every service:** TypeScript, Fastify (or Express) with `zod` validation on
every input, structured JSON logs with a request id, `/healthz` (liveness) and `/readyz`
(dependencies), graceful shutdown, and a Dockerfile that runs as a non-root user.
Every service is typechecked in CI — nothing is excluded from `tsconfig`. *(fixes M-12)*
