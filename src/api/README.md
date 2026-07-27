# `src/api` — the client for the secure backend

Everything the app knows about the backend lives here. No component builds a URL,
reads a token, or parses an error envelope on its own.

```ts
import { auth, decks, lobby, profiles, wager, ApiError } from './api';
```

Base URL comes from `VITE_API_BASE` (`src/api/config.ts`), defaulting to
`http://localhost:8080`:

```bash
# .env.production
VITE_API_BASE=https://api.ocva.online
# .env.development
VITE_API_BASE=http://localhost:8080
```

---

## 1. The auth flow, end to end

Sign-in is a wallet challenge–response. The server mints the exact string to be
signed, and refuses to verify a signature over any string it did not mint.

```
┌────────┐                    ┌──────────┐                  ┌────────┐
│ wallet │                    │  client  │                  │ server │
└───┬────┘                    └────┬─────┘                  └───┬────┘
    │                              │  POST /auth/nonce          │
    │                              │  {address, chain}          │
    │                              ├───────────────────────────>│
    │                              │  {nonce, message, …}       │  mints + stores
    │                              │<───────────────────────────┤  the challenge
    │  sign `message` VERBATIM     │                            │  (5 min, single use)
    │<─────────────────────────────┤                            │
    │  signature                   │                            │
    ├─────────────────────────────>│  POST /auth/verify         │
    │                              │  {address, chain,          │  re-derives the
    │                              │   signature, nonce}        │  message from its
    │                              ├───────────────────────────>│  own record and
    │                              │  {accessToken,             │  consumes the nonce
    │                              │   refreshToken, profile}   │  atomically
    │                              │<───────────────────────────┤
```

In code, `auth.signIn()` does all three steps:

```ts
import { connectEvm } from '../wallet';
import { auth } from './api';

const { address } = await connectEvm();
await auth.signIn({ address, chain: 'ethereum' });
```

Solana works the same way, but you must pass the live provider, because the
signature has to come from the connected wallet instance:

```ts
import { connectSolanaWith, getSolanaWallet } from '../wallet';

const { address } = await connectSolanaWith('phantom');
const provider = await getSolanaWallet('phantom');
await auth.signIn({ address, chain: 'solana', solanaProvider: provider });
```

### Three rules that break sign-in if you get them wrong

1. **Sign `message` verbatim.** Do not trim, re-wrap, normalise newlines or
   re-encode it. The server compares against its own stored copy.
2. **`chain` is a server slug: `ethereum | base | arbitrum | polygon | solana`.**
   There is no `evm` — sending it is a 400. `src/wallet.ts` uses a coarser
   `'evm' | 'solana'` for provider selection; translate with
   `auth.toAuthChain()`.
3. **Only one nonce is outstanding per `(chain, address)`.** Requesting a second
   one invalidates the first. Do not pre-fetch a challenge you are not about to
   use.

---

## 2. Token lifecycle

| Token | Lifetime | Where it goes |
|---|---|---|
| `accessToken` | 15 min (`expiresIn: 900`) | `Authorization: Bearer …` on every call |
| `refreshToken` | ~30 days, **rotating** | body of `POST /auth/refresh` only |

Tokens are **never cookies** — the API is a different origin from the web app
and there is no shared cookie domain.

```
sign in ──> access(15m) + refresh
                │
     access expires, next call gets 401
                │
                ▼
        POST /auth/refresh  ──>  NEW access + NEW refresh   (both replaced)
                │
      old refresh presented again?
                │
                ▼
        ENTIRE FAMILY REVOKED  ──>  user must sign again
```

**`http.ts` handles all of this for you.** On a 401 it refreshes **once** and
replays the request. Concurrent 401s share a single in-flight refresh — ten
requests failing at the same moment trigger one `POST /auth/refresh`, not ten.
If the refresh fails, the session is cleared and a `SessionExpiredError` is
thrown.

> **Never retry a refresh in a loop.** Reuse of a spent refresh token revokes
> the whole family server-side, so a retry storm does not degrade gracefully —
> it logs the user out permanently. This is why the layer fails closed after one
> attempt.

React to sign-out from anywhere:

```ts
useEffect(() => onSessionChange((s) => setSignedIn(s !== null)), []);
```

### Token storage

`src/api/session.ts` is the only module that touches storage. **Both tokens are
kept in `sessionStorage` by default.**

The audit flagged M-4, "long-lived credentials in `localStorage`". Putting the
15-minute access token in `sessionStorage` while leaving the multi-day refresh
token in `localStorage` does not fix that — the refresh token *is* the long-lived
credential, and an XSS payload that steals it mints access tokens indefinitely.

So: `sessionStorage` for both. The credential is scoped to one tab and dies with
it, reloads still work, and it composes with the server's rotation-plus-reuse-
detection. The cost is real and worth stating: **closing the tab signs you out,
and a second tab needs a fresh signature.** `setPersistence('local')` exists as
an explicit opt-in for a "Remember me on this device" checkbox — never enable it
by default.

Storage choice only bounds the blast radius. The actual mitigation for M-4 is
the gateway's `default-src 'self'; script-src 'self'` CSP, which keeps
third-party script out of the page in the first place.

---

## 3. Which calls are public

Public calls work while signed out and never trigger a sign-in prompt. They are
safe on a logged-out landing page.

| Call | Auth | Notes |
|---|---|---|
| `profiles.getLeaderboard()` | **public** | top 50, no `limit` param, no addresses |
| `profiles.getPublicProfile(name)` | **public** | no address, no id, no chain |
| `profiles.getMatches(name)` | **public** | the only source of match history |
| `auth.requestNonce()` / `verifySignature()` / `refresh()` | **public** | the sign-in endpoints themselves |
| everything else | **auth** | `profiles.getMe`, all of `decks`, `lobby`, `wager` |

`profiles.getMe()` is the only route that returns a wallet address, and only to
its owner.

> `auth.getMe()` and `profiles.getMe()` are **different endpoints with different
> shapes.** `auth.getMe()` (`GET /auth/me`) is flat, calls the id `profileId`,
> and includes `roles` — use it for operator checks. `profiles.getMe()`
> (`GET /api/profiles/me`) wraps in `{profile}`, calls the id `id`, and adds
> `level` + `createdAt` — use it for the profile screen. `/auth/me` also sits
> behind the tight `/auth/` rate-limit bucket (5 r/min at the gateway), so do
> **not** poll it; poll `/api/profiles/me` instead.

---

## 4. The error envelope

Every error from every service and from the gateway:

```json
{ "error": { "code": "…", "message": "…", "details": { } } }
```

All of it is normalised into a single `ApiError`. Network failures become
`ApiError` too, with `status: 0`.

```ts
try {
  await decks.activate(id);
} catch (e) {
  if (!(e instanceof ApiError)) throw e;
  if (e.isRateLimited) toast(`Slow down — retry in ${e.retryAfter}s`);
  else if (e.isAuthError) promptSignIn();
  else toast(e.message);
}
```

### `code` is transport, `details.reason` is the cause

This is the single most common mistake. **`error.code` is a closed 12-value enum
describing the HTTP semantics** — `bad_request`, `unauthorized`, `forbidden`,
`not_found`, `method_not_allowed`, `conflict`, `payload_too_large`,
`unsupported_media_type`, `unprocessable`, `rate_limited`, `internal`,
`unavailable`. The domain cause lives in **`details.reason`**.

There is no `code: "no_active_deck"`. It is `code: "bad_request"` +
`details.reason: "no_active_deck"`. Branch on `err.reason`:

```ts
if (err.reason === 'no_active_deck') goToDeckBuilder();
```

Never string-match on `message` — it is human-facing prose.

### Helpers on `ApiError`

`isAuthError` (401) · `isForbidden` (403) · `isNotFound` (404) ·
`isConflict` (409) · `isRateLimited` (429) · `isValidationError` (400) ·
`isNetworkError` (status 0) · `isServerError` (5xx) · `isRetryable`
(the server's own `details.retryable` hint) · `reason` · `hasReason(...)` ·
`issues` · `retryAfter`.

### Two different `details.issues` shapes

Both arrive as `code: "bad_request"`:

| Producer | Issue shape | Discriminator |
|---|---|---|
| body/param validation (zod) | `{path, message, code}` | no `details.reason` |
| deck legality | `{code, message}` — no `path` | `details.reason === 'invalid_deck'` |

Use `decks.isDeckLegalityError(e)` / `decks.deckIssues(e)` rather than
inspecting `details` by hand.

### Rate limits and retries

`http.ts` honours `Retry-After` with a **bounded** retry: at most 2 retries, and
only when the wait is ≤10s. It retries **only methods HTTP defines as
idempotent** — `GET`, `HEAD`, `PUT`, `DELETE`. `POST` and `PATCH` are **never**
retried unless a call site explicitly opts in with `retryOn429: true`, which
only `auth.requestNonce()` does (minting a throwaway challenge is harmless).

`wager.submitDeposit()` is explicitly opted **out**: it binds a transaction hash
to an escrow seat, and a blind replay is exactly what the server's 409
uniqueness constraints exist to catch.

Gateway buckets: `/auth/` 5 r/min burst 10 · `/api/` 10 r/s burst 20 ·
`/wager/` 1 r/s burst 5.

---

## 5. IDs are strings

`profileId`, deck ids, match ids and escrow ids are **bigint-safe decimal
strings**. Amounts (`amountBase`, `wagerAmount`) are decimal strings in token
base units.

**Never `parseInt` or `Number()` any of them.** Values above 2^53 lose precision
silently and you will read or write the wrong row. Every id in this layer is
typed `string`; keep it that way. Use `wager.formatAmount()` to display amounts
without going through `Number`.

Things that genuinely are numbers: `seat` (`0 | 1`), `tier`, `decimals`,
`wins`, `losses`, `level`, `rank`, `expiresIn`.

> `seat` is a **number**; boardgame.io's `playerID` is the **string** form of the
> same value (`'0'` / `'1'`). Both are returned by `lobby.join()`. Do not
> conflate them.

---

## 6. Porting a legacy call

| Legacy | New | Notes |
|---|---|---|
| `GET /api/leaderboard` | `profiles.getLeaderboard()` | now `{leaderboard, generatedAt, cached}`, top 50 fixed, no addresses |
| `GET /api/profile/:name` | `profiles.getPublicProfile(name)` | no address, no wallet fields |
| `GET /api/profile-by-wallet/:addr` | **gone** | no route maps an address to a profile; the address is private |
| `POST /api/profile` (upsert by name) | `auth.signIn()` | identity comes from a wallet signature, never a name |
| `POST /api/profile/update` | `profiles.patchMe()` | edits the **caller's own** profile only; there is no target-profile route |
| `GET /api/deck` / deck endpoints | `decks.list()` / `create` / `update` / `remove` | `cards` is a flat `string[]` with repetition, not `[{id,count}]` |
| *(no equivalent)* | `decks.activate(id)` | **new and required** — the only full 60-card legality gate; you must have an active deck to play |
| `LobbyClient.listMatches('chains-tcg')` | `lobby.getLobby()` | boardgame.io's lobby REST API is **not mounted**; those routes do not exist |
| `LobbyClient.createMatch(...)` | `lobby.create()` | **do not send a deck** — the server attaches your active one |
| `LobbyClient.joinMatch(...)` | `lobby.join(matchId)` | empty body; returns `{seat, playerID, credentials}` |
| *(credentials from `createMatch`)* | `lobby.getSeat(matchId)` | your own seat + boardgame.io credentials; **a non-participant gets 404, not 403** |
| `POST /api/result` | **NO REPLACEMENT — THE CLIENT NEVER REPORTS A RESULT** | see below |
| `VITE_SOLANA_RPC` / `HELIUS_API_KEY` | `RPC_URL` from `config.ts` | read-only proxy; `eth_sendRawTransaction` is 403, so broadcast through the user's wallet |

### `POST /api/result` has no replacement

Delete the endpoint and every call site. **There is no route anywhere that
accepts a match result**, and no request shape that can name a winner. The game
service derives outcomes from its own boardgame.io state, signs them with an
HMAC shared only with the wager service, and writes them itself. Payouts are
decided by a background worker from those verified rows and by nothing else —
`POST /wager/settle` and `POST /wager/escrows/:id/settle` also 404.

Read history from `profiles.getMatches(displayName)`. Observe settlement by
polling `wager.getEscrow(id)`.

---

## 7. Lobby gotchas

- **Never send a deck.** The bodies are strict objects; a stray `deck` key is a
  400. The server attaches your active deck — that is the point.
- **No active deck ⇒ `create()` and `join()` fail** with
  `details.reason === 'no_active_deck'`. Use `lobby.isDeckBlockedError(e)` to
  route the player to the deck screen. The sibling `'invalid_active_deck'` means
  they have one but it is no longer legal.
- **`getSeat()` returns two shapes.** While `status === 'open'`, `credentials`
  is `null` and `playerID` is **absent**. Poll until `status !== 'open'` before
  connecting the socket.
- **404 means "not found", not "not allowed."** Non-participants, unlisted
  matches you were not invited to, and other people's decks all return 404 by
  design.
- The open-match cap is 3 per profile (`reason: 'too_many_open_matches'`).

---

## 8. Wager — what is stubbed

`src/api/wager.ts` carries the full list. The short version, from
INTEGRATION.md §7:

- **Booster minting does not exist.** No NFT is ever minted; the DB constraints
  are real but `mint_address` stays `NULL`. `GET /wager/boosters/supply`
  reports `mintingEnabled: false`. **The UI must not promise a mint** — no
  "minted!" copy, no token links.
- **No payout has ever run on-chain**, and deposit verification has never seen a
  real transfer.
- **There is no deployed escrow contract.** `depositAddress` is an EOA
  controlled by a hot wallet. Do not describe deposits as "locked in a smart
  contract".
- **Digital redemption is off** (empty card pool → 503).

Stakes are a **tier index into the server's allowlist**, never an amount:

```ts
const { tiers, decimals } = await wager.getStakes();
await wager.createEscrow({ matchId, tier: 0 });   // index — there is no `amount` field
```

Sending `amountBase` is a 400. Never hardcode a tier index; the list is
positional and operator-configurable.

---

## 9. Known server-side issues found while building this

1. **A deck that has been played cannot be deleted.** `DELETE /api/decks/:id`
   on a deck ever seated into a match returns
   `400 {"code":"bad_request","message":"Referenced resource does not exist"}` —
   a raw Postgres FK violation (23503) from `game.matches` leaking through the
   error mapper, with **no `details.reason`**. Cancelling the match does not
   release the reference. Use `decks.isUndeletableDeckError(e)`; the deck
   builder should offer rename/replace instead of delete for played decks.
2. **`GET /auth/me` sits behind the `/auth/` bucket** (5 r/min burst 10 at the
   gateway), which is far tighter than the `/api/` bucket. It is not a pollable
   route. Use `GET /api/profiles/me` for anything repeated.
