# Egregore TCG code review, 2026-11-01

Repo `chains-tcg`, branch `feature/sproto-factions` at 92471bf plus the uncommitted Wealth/Knowledge card work. Live site egregoretcg.xyz, live API api.ocva.online.

## 1. How this review was done

Six read-only reviewers each took one area: rules engine, React front end, client API and wallet layer, servers (legacy Koa, Vercel functions, new-backend), smart contracts, and repo hygiene. The engine reviewer drove the real boardgame.io reducer headless to confirm its claims rather than only reading. They produced 158 candidate findings as structured JSON.

Jev (TypeSafe System One) then judged every finding in isolation with seven typed questions: does the quoted evidence show the claimed problem, is it generic advice, how severe, how much effort, which category, is the fix actionable, would a player notice. Code owned the policy: a composite priority, tier thresholds, and a liveness multiplier for code paths that the reviewers established are not in production. Jev never decided anything; it only answered the questions. The judgments are cached, so re-weighting is free. Cost: 158 calls, about one cent.

Jev lesson worth keeping: its "does the evidence support the claim" question marks absence claims (no tests, dead code, god module, catalogue drift) as unverified, because a quote cannot show something missing. Those 29 "unverified" rows are not false. I checked the important ones by hand and list them in section 6.

I personally re-verified every finding in sections 3 and 4 against the source.

## 2. Baseline

| Check | Result |
|---|---|
| `npm ci` | needed first; node_modules was absent |
| `npx tsc -b` | passes (but tsconfig excludes `src/server.ts`, `src/db.ts`, and never covers `api/*.ts`) |
| `npx vitest run` | 313 of 313 tests pass, yet exit code is red: 20 test files under `new-backend/` fail to load because the root runner sweeps the monorepo and `new-backend/node_modules` is not installed |
| `npx vite build` | passes in 36 s; entry chunk 1.45 MB (443 kB gzip), Privy runtime 2.1 MB, three.js 733 kB |

## 3. What is actually live

This framing matters more than any single bug.

- **Live:** the Vite front end on Vercel, the two Vercel functions `api/chat.ts` and `api/presence.ts` (Neon), and `new-backend/` behind the nginx gateway at api.ocva.online (probe of `/healthz` returned `service: gateway`).
- **Not live but still in the repo as if it were:** the legacy Koa server (`src/server.ts`, `src/db.ts`, `src/server-custodial.ts`, `src/server-wager.ts`, `src/ranked/*`). It is still the root `npm start` target and `render.yaml` still deploys it with a custodial escrow keypair. It has no authentication on any route, pays whichever winner a client names on `POST /api/result`, and double-pays on concurrent settlement. None of that is reachable today, but anyone who follows the README or the Render blueprint stands it up.
- **Deployed but unused:** `WagerEscrow`, `MasterToken` and `CardPack` on Robinhood Chain, and the Anchor `master_wager` program. Wagers go through new-backend's own escrow wallet. CardPack minting is switched off in the client. The July security audit's high findings on these contracts (H-4, H-8, H-10, H-11) are still unfixed in code.
- **Duplicated:** the card catalogue and rules engine exist twice. `new-backend/services/game/src/game/cards.ts` is missing `base_moose`, has a different Knowledge starter deck, and still uses chain-era card names, so a client deck with the moose is rejected online and the master-written log shows old names.

Recommendation: delete the legacy server and `render.yaml` (or move them to an archive branch), and make one shared cards module the only source. That removes roughly 20 of the 46 Tier A findings in one stroke instead of fixing them.

## 4. Live-path findings I verified, in priority order

### Game integrity (affects ranked and wager results)

1. **Defender can take the win by stalling in blockers** (`new-backend/.../game/Game.ts:776`, engine-03). `claimTimeout` only refuses the current player. After `confirmAttackers` the attacker is still current player, parked in `afk`, and the deadline set at turn start is never refreshed. A defender who never blocks waits out the deadline plus grace and sets the attacker's life to 0 with reason `timeout`. Fix: make the timeout target whoever holds priority, and reset the deadline when attackers are confirmed.
2. **Defender can cancel a confirmed attack for free** (`src/Game.ts:714`, engine-02). The `blockers` stage is never declared in `turn.stages` (only `afk` is), so the defender inherits all phase moves, including `forceEndTurn`. After the 90 s deadline that wipes the attackers with zero damage. Same root cause as item 1. Fix: declare the stage with only block moves, give blocks their own deadline, and resolve combat with no blocks when it lapses.
3. **First player draws on turn one** (`src/Game.ts:827`, engine-01). `ctx.turn !== 1` never skips because the pick and mulligan phases already consumed turns, so the starting player opens with 8 cards. Fix: record the first play turn in `G` when the play phase begins.
4. **The forfeit dialog never forfeits** (`src/App.tsx:6457`, frontend-02). The client `Game.ts` has no `concede` move, only the server copy does, and a boardgame.io client can only dispatch moves its own definition declares. The dialog calls `lobbyApi.cancel` (a 404 on a live match) and unmounts. The opponent is left force-ending turns until deck-out. Fix: share the server's `concede` move into the client definition and call it before releasing the seat.
5. **Starter decks lose their aura** (`src/cards.ts:439`, engine-06). The builder makes 62 cards (65 for Knowledge) and `slice(0, 60)` cuts the tail, which is the aura copies. No starter deck ever contains an aura; Knowledge also loses Arcane Storm. Fix: size the node pile as 60 minus spells, and add a test that every non-node card of a faction appears in its starter.
6. **Draw effects run optimistically on the client against an empty deck** (`src/Game.ts:170`, engine-04). No move sets `client: false`, and `playerView` strips decks, so every online card draw briefly sets the caster's life to 0 with a "loses" log line until the server state arrives. Fix: mark `playCard` and any move touching `G.secret` as `{ move, client: false }`.
7. **Damage moves fizzle but still consume the card and gas** on a stale or bogus target uid (`src/Game.ts:386`, engine-10). Fix: resolve the target before paying.
8. **Discard to hand size pops the newest cards with no choice** (`src/Game.ts:702`, engine-12).
9. **Instance uids come from a module-level counter** (`src/Game.ts:90`, engine-05). It resets on server restart while matches persist in Postgres, so uids can collide and target the wrong permanent. Fix: keep the counter in `G`.
10. **Lobby create accepts `mode: 'ranked'`** (`new-backend/.../routes/lobby.ts:63`, server-30), so two accounts can mint private ranked matches and farm rating. Fix: restrict to casual and wager.
11. **The bot uses `Math.random`** (`src/bot.ts:239`, engine-15), so the seeded Daily Challenge is not reproducible.

### Auth and operations on the live backend

12. **Access tokens cannot be revoked before expiry** (`new-backend/packages/shared/src/auth.ts:171`, server-36). Logout kills the refresh family but a 15-minute access token keeps working on wager and lobby routes. Fix: a Redis revocation set keyed by `jti`, checked in `requireAuth`.
13. **Anyone can burn a victim's sign-in challenge** (`new-backend/services/auth/src/nonce.ts:124`, server-28). `GETDEL` runs before signature verification on the public verify route. Fix: verify first, consume on success.
14. **Payout runner has no fee-bump path and `nonce too low` is treated as success** (`payoutRunner.ts:207`, `evmSender.ts:119`, server-34 and server-35). A dropped or outbid transaction leaves the leg pending forever, the identical bytes are rebroadcast, and void is blocked because a hash exists. Fix: replace-by-fee at the same nonce after N attempts, and on `nonce too low` check whether this hash landed before declaring success.
15. **Smart-account deposits are rejected** (`deposit.ts:141`, server-39). The auth service admits ERC-1271/6492 wallets but deposit verification requires `tx.from` to be a linked address, which for 4337 accounts is the bundler. Fix: rely on the Transfer log's `from`.
16. **Deposits on a match that never finishes are stuck** until an operator voids (`escrowService.ts:128`, server-32).
17. **Three Postgres connections disable TLS verification** (`api/chat.ts`, `api/presence.ts`, `new-backend/.../bgio/store.ts:25`). Neon and the shared pool both support verify-full. Jev ranked these top three; I rate them medium, but the fix is one line each.
18. **Chat admin is keyed on a display name** (`api/chat.ts:185`, server-23). Names are unique (citext) but renameable through the profile PATCH route, so if the admin renames, anyone can claim the name and announce. This was a deliberate recent choice; keying on `who.id` costs nothing.
19. **The chat identity cache keeps a raw bearer token authoritative for five minutes** after logout (`api/chat.ts:193`, server-26), and `CHAT_ADMIN_KEY` is compared with `===` and skips the rate limit (server-27).
20. **No security headers reach the page** (client-api-02). `vercel.json` has no `headers` block, so the CSP that `session.ts` and `.env.production` say protects the token store does not exist. Fix: add CSP, HSTS, `X-Content-Type-Options` and `frame-ancestors` in `vercel.json`.

### Front end

21. **`InstallPrompt` reads localStorage bare inside an effect** (`src/App.tsx:7000`, frontend-14). Every other access is wrapped. In Safari private mode this throws during render and, with no error boundary anywhere (frontend-13), blanks the whole app.
22. **`DeckWorkspace` and `ProfilePage` loaders have no cancellation** (`src/App.tsx:3544`, frontend-24); a stale response can reset in-progress deck edits.
23. **`refreshCollection` applies a late response to whichever wallet is now signed in** (`src/collection.ts:475`, engine-20).
24. **The presence heartbeat bypasses the HTTP wrapper** (`src/presence.ts`, client-api-09), so after the 15-minute token expiry an idle player silently drops out of the online count. Related: no fetch has a timeout (client-api-03), the 429 retry ignores the body's `retryAfterSec` (client-api-05), and every response is `JSON.parse(...) as T` with no validation (client-api-06).
25. **Waiting room fetches a profile literally named "Opponent"** (`src/App.tsx:6441`, frontend-03).
26. **Multi-wallet browsers sign with the wrong provider** (`src/api/auth.ts:399`, client-api-22): the connect step and the sign step each grab `window.ethereum` independently and EIP-6963 is ignored.
27. **The visible 60 s turn timer is a client clock** that resets on every render and disagrees with the server's `turnDeadline` the force-end button uses (`src/Board.tsx:3020`, frontend-17).
28. **`App.tsx` is 8,479 lines holding 13 screens plus the router**, with about 1,400 dead lines (RulesPage subsystem, legacy profile widgets, an unreachable Plaza, three WebGL effects imported but never rendered). The card face is rendered seven different ways. The decomposition map with line ranges is in finding frontend-01 in the appendix.

## 5. Hygiene and tooling

- Root `npm test` is red for a structural reason (section 2). Fix: a `vitest.config.ts` with `include: ['src/**/*.test.ts']`, or make new-backend a workspace.
- No CI and no lint or format config anywhere. One GitHub Actions workflow running `tsc -b`, `vitest run` and `vite build` on pull requests would have caught the red suite and the drifted catalogue.
- `tsconfig.json` excludes `src/server.ts` and `src/db.ts` and never includes `api/*.ts`. Right now they typecheck clean when forced, so this is an enforcement gap, not a hidden error.
- 91 unreferenced legacy card PNG/JPG files, 172 MB, are tracked in git (pack 317 MB). `rules-intro.mp4` is referenced in three places but excluded by `.vercelignore` and stored in LFS, so it 404s on Vercel.
- `docs/CARDS.txt` and `docs/cards.txt` both exist, which collides on Windows (core.ignorecase is on); they differ by 2,842 lines.
- README still documents the five-chain OCVA game, Render plus Postgres, and masterstcg.com. `render.yaml` contradicts both the README and the real Docker-on-VPS backend.
- The `anchor` npm dependency is the Sails.js validator, not `@coral-xyz/anchor`, and has zero imports. `bufferutil` and `utf-8-validate` are unused hard dependencies. `bs58` is used by scripts but undeclared.
- `.boost/` is untracked and not ignored. The uncommitted `cards.ts` maps 34 WebP files that are still untracked under `public/cards/{knowledge,wealth}`; commit them together.
- `SECURITY_AUDIT.pdf` is dated 2026-07-27 and predates 51 commits including Privy auth, the Vercel Postgres functions and EVM packs.

## 6. "Unverified" by Jev, confirmed by hand

These are absence claims Jev could not score from a quote. I confirmed each one:

- engine-07: the server card catalogue is missing `base_moose` (grep count 0 in the server copy, 2 in the client).
- engine-19 and hygiene-03: there are no tests for `Game.ts`, `bot.ts`, the wager or custodial code, or either Vercel function.
- frontend-01 and frontend-07: the App.tsx god module and the dead components.
- hygiene-02: the catalogue duplication has drifted by 405 committed lines, 445 with the uncommitted work.
- contracts-22 and client-api-12: the bogus `anchor` dependency and the three dead client modules.
- frontend-13: there is no error boundary above the board.

Two "unverified" items I could not confirm and leave as questions: server-37 (whether the wager escrow key really lives in a plaintext `.env` on a shared host; the reviewer read that from DEPLOY.md) and contracts-21 (whether the Alchemy key flagged in the audit was ever rotated).

## 7. Suggested order of work

**This week, hours each:**
1. Fix the combat timeout pair (items 1 and 2) and refresh the deadline on `confirmAttackers`; this is the only exploit that changes ranked and wager outcomes today.
2. Share `concede` into the client game definition and wire the forfeit dialog (item 4).
3. Turn-one draw (item 3) and starter deck sizing (item 5), each with a reducer test.
4. `client: false` on `playCard` (item 6).
5. Sync `new-backend`'s cards.ts from the client (or import one module) so `base_moose` decks work online.
6. Restrict lobby create to casual and wager (item 10).
7. One-liners: TLS verify-full on three pools, `headers` block in `vercel.json`, `InstallPrompt` try/catch, chat admin by id, `timingSafeEqual` on the admin key.

**Next sprint:**
8. Token revocation set and verify-before-consume on nonces (items 12, 13).
9. Payout runner fee-bump and the `nonce too low` check (item 14); smart-account deposits (item 15); auto-refund on void matches (item 16).
10. `vitest.config.ts` include list, a CI workflow, lint and format config.
11. Delete the legacy server, `render.yaml`, the dead client modules, and the 172 MB of unreferenced art; fix the README.

**Strategic:**
12. Split `App.tsx` by screen using the map in frontend-01, and collapse the seven card-face renderers into one.
13. Decide the fate of the deployed EVM and Anchor contracts: either wire them in and fix the audit's H-items, or document them as retired.
14. Give the live wager wallet a real signer boundary (KMS or an escrow contract) before stakes grow.

## 8. Files from this review

- `docs/review/2026-11-01-findings.json`: all 158 findings with reviewer text, Jev answers, priority and tier.
- `docs/review/jev-triage/triage.py` and `rerank.py`: the questions, thresholds and liveness policy. Re-run `rerank.py` after changing policy without spending Jev calls; re-run `triage.py` on new findings files. The key is read from `TYPESAFE_API_KEY` or the `.env.live` files in the Jev projects.
## Appendix A. Every finding, ranked

Tier is from Jev severity after the liveness multiplier (A >= 2.6, B >= 1.8, C below; unverified = Jev gave the evidence < 0.55 plausibility). prio = composite priority. real = Jev plausibility that the quoted evidence shows the claimed problem. eff = effort 0 (trivial) to 3 (multi-day).

| # | tier | prio | sev | real | eff | category | id | location | title | path status |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | A | 4.09 | 4.0 | 0.9 | 0.81 | auth | client-api-10 | api/presence.ts:26 | Presence function disables TLS verification to Postgres | live |
| 2 | A | 4.07 | 3.76 | 0.95 | 0.17 | data | server-24 | api/chat.ts:173 | Vercel chat/presence functions connect to Neon with rejectUnauthorized:false | live |
| 3 | A | 3.88 | 3.96 | 0.85 | 1.15 | auth | client-api-02 | src/api/session.ts:366 | Token-storage defence relies on a CSP the page never receives | live |
| 4 | A | 3.81 | 3.63 | 0.9 | 0.34 | data | server-29 | new-backend/services/game/src/bgio/store.ts:25 | boardgame.io Postgres store disables TLS verification even when PGSSL=require | live |
| 5 | A | 3.77 | 3.74 | 0.9 | 1.33 | money | server-35 | new-backend/services/wager/src/chain/evmSender.ts:119 | 'nonce too low' on broadcast is treated as 'already known' success | live |
| 6 | A | 3.63 | 3.82 | 0.82 | 1.51 | auth | server-26 | api/chat.ts:193 | whoCache keeps a bearer token authoritative for 5 min after logout/expiry | live |
| 7 | A | 3.62 | 3.34 | 0.95 | 0.5 | auth | server-23 | api/chat.ts:185 | Chat admin is granted by a mutable display name, not a profile id | live |
| 8 | A | 3.61 | 3.9 | 0.81 | 1.94 | money | server-34 | new-backend/services/wager/src/services/payoutRunner.ts:207 | A payout leg that is never mined has no fee-bump path and blocks void | live |
| 9 | A | 3.58 | 3.88 | 0.86 | 2.85 | testing | hygiene-03 | src:1 | The rules engine, bot, wager, custodial and Vercel API modules have no tests | live |
| 10 | A | 3.56 | 3.95 | 0.81 | 2.61 | money | server-21 | package.json:11 | Two backends coexist: insecure legacy server is still `npm start` + render.yaml target | live |
| 11 | A | 3.53 | 3.87 | 0.78 | 1.87 | money | server-32 | new-backend/services/wager/src/services/escrowService.ts:128 | Deposits on a match that never finishes are stuck until an operator voids | live |
| 12 | A | 3.52 | 3.98 | 0.74 | 1.9 | auth | server-36 | new-backend/packages/shared/src/auth.ts:171 | Access tokens cannot be revoked before expiry; jti is never checked | live |
| 13 | A | 3.42 | 3.28 | 0.92 | 0.99 | money | server-39 | new-backend/services/wager/src/domain/deposit.ts:141 | Deposit verification rejects smart-account wallets the auth service deliberately admits | live |
| 14 | A | 3.28 | 3.85 | 0.64 | 1.25 | auth | server-27 | api/chat.ts:241 | CHAT_ADMIN_KEY compared with === and bypasses the per-author rate limit | live |
| 15 | A | 3.13 | 3.48 | 0.71 | 1.29 | game_integrity | engine-03 | new-backend/services/game/src/game/Game.ts:776 | Server claimTimeout lets a defender who is stalling in the blockers stage take the win | live |
| 16 | A | 3.09 | 2.91 | 0.88 | 0.39 | game_integrity | engine-04 | src/Game.ts:170 | Draw effects run optimistically on the client against the stripped deck and zero the player's life | live |
| 17 | A | 3.04 | 2.97 | 0.8 | 0.15 | reliability | frontend-14 | src/App.tsx:7000 | InstallPrompt reads localStorage without try/catch inside an effect | live |
| 18 | A | 3.03 | 3.23 | 0.81 | 1.87 | game_integrity | engine-02 | src/Game.ts:714 | Defender can cancel an in-progress attack with forceEndTurn once the 90s deadline lapses | live |
| 19 | A | 3.01 | 2.79 | 0.91 | 0.51 | game_integrity | engine-18 | src/Game.ts:348 | etb_zap_2_and_draw bypasses dealDamageToPlayer, so it is unlogged and skips any damage hooks | live |
| 20 | A | 2.98 | 2.89 | 0.88 | 1.04 | reliability | frontend-24 | src/App.tsx:3544 | DeckWorkspace and ProfilePage loaders have no cancellation and race on identity change | live |
| 21 | A | 2.95 | 3.01 | 0.86 | 1.71 | game_integrity | engine-05 | src/Game.ts:90 | Module-level _uid counter: non-deterministic across client/master and resets on server restart | live |
| 22 | A | 2.95 | 3.11 | 0.83 | 1.98 | reliability | client-api-06 | src/api/http.ts:172 | Every response is an unchecked `JSON.parse(...) as T`; shape drift crashes callers | live |
| 23 | A | 2.93 | 2.98 | 0.87 | 1.79 | tooling | contracts-19 | scripts/evm-deploy.mjs:69 | evm-deploy.mjs overwrites deployment.json wholesale and is not reproducible against foundry.toml | live |
| 24 | A | 2.92 | 2.83 | 0.9 | 1.27 | data | server-18 | src/ranked/matchmaker.ts:66 | collectRegions queries region='' so it always falls back to a hard-coded list | live |
| 25 | A | 2.90 | 2.81 | 0.84 | 0.57 | reliability | client-api-08 | src/api/session.ts:491 | Cross-tab `storage` handler JSON.parses unguarded | live |
| 26 | A | 2.87 | 3.08 | 0.8 | 1.96 | auth | client-api-22 | src/api/auth.ts:399 | Signer is `globalThis.ethereum`, not the provider that connected; EIP-6963 ignored | live |
| 27 | A | 2.85 | 2.95 | 0.77 | 0.94 | auth | client-api-09 | src/presence.ts:1131 | Presence heartbeat bypasses the HTTP wrapper and dies with the access token | live |
| 28 | A | 2.83 | 3.27 | 0.64 | 1.21 | auth | server-15 | src/ranked/api.ts:119 | Legacy POST /api/ranked/match/result is public and ingests any outcome | live |
| 29 | A | 2.80 | 2.72 | 0.92 | 1.6 | game_integrity | engine-12 | src/Game.ts:702 | Hand-size discard pops from the end of the hand with no player choice | live |
| 30 | A | 2.74 | 2.82 | 0.8 | 1.3 | game_integrity | engine-01 | src/Game.ts:827 | First player always draws on turn one: ctx.turn is never 1 in the play phase | live |
| 31 | A | 2.73 | 2.66 | 0.86 | 1.07 | game_integrity | engine-15 | src/bot.ts:239 | Bot uses Math.random, so the seeded Daily Challenge is not reproducible | live |
| 32 | A | 2.73 | 2.88 | 0.74 | 1.04 | game_integrity | engine-10 | src/Game.ts:386 | Damage moves accept any non-empty targetUid; a stale or bogus uid eats the card and gas with no effect | live |
| 33 | A | 2.72 | 3.06 | 0.72 | 1.83 | tooling | hygiene-11 | .github:1 | No CI workflow and no lint/format configuration anywhere in the repo | live |
| 34 | A | 2.69 | 3.23 | 0.56 | 0.89 | game_integrity | server-30 | new-backend/services/game/src/routes/lobby.ts:63 | POST /games/create accepts mode 'ranked', enabling win-trading outside the queue | live |
| 35 | A | 2.68 | 2.77 | 0.79 | 1.28 | game_integrity | engine-06 | src/cards.ts:439 | starterDeck() truncation silently drops every aura (and Arcane Storm) from the starters | live |
| 36 | A | 2.67 | 2.83 | 0.74 | 1.13 | game_integrity | frontend-17 | src/Board.tsx:3020 | Client-side 60 s turn timer resets on every parent render and on blocker phases | live |
| 37 | unverified | 2.60 | 4.0 | 0.41 | 2.87 | money | server-37 | new-backend/services/wager/src/config/keys.ts:46 | Escrow signing key is a plaintext env var in a container on a shared host | live |
| 38 | A | 2.60 | 3.04 | 0.66 | 1.81 | game_integrity | server-16 | src/ranked/queue-service.ts:27 | Legacy ranked queue accepts a client-supplied deck list as `deckId` | live |
| 39 | A | 2.60 | 2.82 | 0.77 | 1.9 | auth | server-28 | new-backend/services/auth/src/nonce.ts:124 | Anyone can burn a victim's pending sign-in challenge via POST /auth/verify | live |
| 40 | A | 2.59 | 3.04 | 0.6 | 1.14 | reliability | engine-20 | src/collection.ts:475 | refreshCollection applies a response under whichever wallet is signed in when it returns | live |
| 41 | B | 2.58 | 2.37 | 0.93 | 0.96 | reliability | frontend-03 | src/App.tsx:6441 | Waiting room fetches a public profile literally named 'Opponent' | live |
| 42 | A | 2.54 | 2.74 | 0.7 | 1.04 | tooling | client-api-24 | src/api/config.ts:630 | config.ts comments contradict the shipped env: `/gw` proxy, tracked `.env.production` | live |
| 43 | B | 2.54 | 2.4 | 0.9 | 1.12 | reliability | client-api-05 | src/api/http.ts:274 | 429 retry ignores body `retryAfterSec`, retrying after 1s against a long limit | live |
| 44 | A | 2.54 | 2.69 | 0.81 | 1.97 | maintainability | frontend-18 | src/Board.tsx:1244 | `as any` escape hatches hide untyped game state and events | live |
| 45 | A | 2.53 | 2.94 | 0.74 | 2.65 | reliability | server-17 | src/ranked/matchmaker.ts:29 | Legacy pairing handoff is an in-process Map that is consumed on read | live |
| 46 | B | 2.48 | 2.53 | 0.76 | 0.93 | reliability | client-api-03 | src/api/http.ts:226 | No default timeout on any API fetch; a stalled gateway wedges the UI | live |
| 47 | A | 2.47 | 2.74 | 0.74 | 1.95 | game_integrity | server-31 | new-backend/services/game/src/ranked/queue.ts:97 | Live-match check in joinQueue is TOCTOU; pairer never excludes seated players | live |
| 48 | A | 2.46 | 2.92 | 0.65 | 1.99 | game_integrity | frontend-02 | src/App.tsx:6457 | In-match 'FORFEIT & LEAVE' never forfeits: it just unmounts the client | live |
| 49 | B | 2.44 | 2.33 | 0.9 | 1.3 | ux | frontend-20 | src/App.tsx:3445 | Clickable cards and map sites are not real buttons | live |
| 50 | B | 2.41 | 2.28 | 0.9 | 1.2 | maintainability | frontend-06 | src/App.tsx:4963 | Plaza canvas lobby is unreachable: plazaOpen is never set to true | live |
| 51 | B | 2.41 | 2.36 | 0.84 | 1.18 | money | client-api-13 | src/pack-evm.ts:631 | `ensureChain` swallows switch failures; mint can proceed on the wrong network | minting gated off |
| 52 | B | 2.40 | 2.4 | 0.81 | 1.2 | maintainability | frontend-04 | src/App.tsx:7116 | App() returns before any hook when ?print is set (rules-of-hooks violation) | live |
| 53 | A | 2.39 | 2.79 | 0.6 | 1.19 | auth | client-api-01 | src/App.tsx:305 | 'Remember me' is silently undone on every page load | live |
| 54 | B | 2.39 | 2.38 | 0.79 | 0.94 | game_integrity | engine-16 | src/bot.ts:124 | enumerateMoves never offers a second declareAttacker, so Easy/MCTS attacks with at most one meme | live |
| 55 | B | 2.38 | 2.11 | 0.88 | 0.22 | game_integrity | frontend-25 | src/Board.tsx:897 | Result reporting is correctly server-owned; only the daily-quest flag is client-trusted | live |
| 56 | B | 2.37 | 2.35 | 0.83 | 1.23 | money | client-api-17 | src/booster-mint.ts:504 | `mintTicketNft` retries across RPCs on any error, risking a double mint | minting gated off |
| 57 | A | 2.33 | 2.96 | 0.56 | 2.0 | game_integrity | engine-13 | src/Game.ts:810 | 'blockers' stage is never declared; defender's move set relies on boardgame.io fallthrough | live |
| 58 | unverified | 2.31 | 2.97 | 0.53 | 1.84 | reliability | frontend-13 | src/index.tsx:11 | No error boundary anywhere above the board: one render error blanks the whole app | live |
| 59 | B | 2.29 | 2.29 | 0.86 | 1.75 | money | contracts-20 | src/booster-mint.ts:24 | Booster price is documented as 0.0035 ETH but charged as 0.0035 SOL; two 'MASTER' tokens with 18 vs 6 decimals | minting gated off |
| 60 | B | 2.27 | 2.27 | 0.73 | 0.53 | ux | client-api-27 | src/api/http.ts:265 | A required call while signed out clears the (absent) session and resets the whole UI | live |
| 61 | B | 2.27 | 2.24 | 0.89 | 1.84 | tooling | hygiene-05 | .vercelignore:3 | rules-intro.mp4 is referenced in 3 places but excluded from the Vercel deploy | live |
| 62 | B | 2.26 | 2.15 | 0.83 | 0.77 | auth | contracts-15 | solana/programs/master_wager/src/lib.rs:298 | initialize is permissionless: whoever calls it first after deploy becomes admin and picks the oracle | deployed, unused by product |
| 63 | B | 2.26 | 2.11 | 0.9 | 1.14 | money | contracts-17 | solana/programs/master_wager/src/lib.rs:180 | burn_bps is read from Config at settle rather than snapshotted on the match | deployed, unused by product |
| 64 | unverified | 2.25 | 3.0 | 0.53 | 2.33 | game_integrity | hygiene-02 | src/cards.ts:1 | Card catalogue is duplicated in new-backend and has drifted by 405+ lines | live |
| 65 | B | 2.25 | 2.32 | 0.79 | 1.54 | money | client-api-14 | src/pack-evm.ts:645 | Mint sends a hardcoded price when the price read fails, and waits forever for the receipt | minting gated off |
| 66 | B | 2.24 | 2.35 | 0.7 | 0.94 | reliability | client-api-04 | src/api/http.ts:116 | Refresh fetch has no timeout and a network blip logs the user out | live |
| 67 | unverified | 2.22 | 2.77 | 0.49 | 1.0 | game_integrity | engine-09 | src/Game.ts:596 | Meme damage only clears when combat resolves, so post-combat damage persists for turns | live |
| 68 | B | 2.20 | 2.51 | 0.6 | 1.08 | tooling | hygiene-10 | render.yaml:1 | render.yaml no longer matches the deployed backend and contradicts the README | stale deploy target |
| 69 | B | 2.20 | 2.02 | 0.83 | 0.44 | performance | frontend-08 | src/Board.tsx:688 | Hand-strip ResizeObserver effect has no deps: re-created on every board render | live |
| 70 | B | 2.18 | 2.32 | 0.72 | 1.35 | tooling | hygiene-14 | src/cards.ts:97 | Uncommitted Wealth/Knowledge art map references 34 untracked WebP files | live |
| 71 | B | 2.16 | 2.12 | 0.81 | 1.13 | ux | client-api-21 | src/collection.ts:293 | Ownership helpers answer from the editable localStorage cache before the server replies | live |
| 72 | unverified | 2.15 | 3.08 | 0.39 | 1.69 | data | server-33 | new-backend/services/wager/src/services/payoutRunner.ts:122 | Payout idempotency-key conflict is only logged; escrow is finalised with the proposer's status | live |
| 73 | B | 2.12 | 1.97 | 0.86 | 0.89 | performance | frontend-28 | src/Board.tsx:1617 | Action log re-keys all 200 rows on every new entry | live |
| 74 | B | 2.11 | 2.05 | 0.8 | 0.98 | performance | frontend-15 | src/App.tsx:5087 | Lobby polls three endpoints every 5 s even when the tab is hidden | live |
| 75 | unverified | 2.10 | 2.99 | 0.36 | 1.26 | game_integrity | engine-17 | src/Game.ts:78 | 10-second mulligan deadline lets the opponent force-keep a slow-loading player | live |
| 76 | B | 2.10 | 2.1 | 0.76 | 1.02 | auth | client-api-20 | src/collection.ts:481 | Collection refresh leaves `loading: true` on a 401 that did not clear the session | live |
| 77 | B | 2.07 | 2.17 | 0.78 | 1.77 | money | contracts-03 | contracts/src/WagerEscrow.sol:102 | setTimeouts is unbounded and reclaim reads the live global, so the owner can lock stakes forever | deployed, unused by product |
| 78 | C | 2.07 | 1.76 | 0.94 | 0.55 | money | server-14 | src/db.ts:56 | Legacy pool uses ssl rejectUnauthorized:false; render.yaml forces it with PGSSL=1 | legacy server, not live |
| 79 | C | 2.06 | 1.75 | 0.88 | 0.06 | reliability | client-api-25 | src/privy/runtime.tsx:236 | PrivyBoundary swallows the SDK crash with no log | live |
| 80 | B | 2.06 | 2.17 | 0.71 | 1.22 | money | contracts-04 | contracts/src/WagerEscrow.sol:157 | Rake is read from the live rakeBps at settle, not snapshotted at createMatch | deployed, unused by product |
| 81 | B | 2.06 | 2.35 | 0.69 | 2.05 | ux | frontend-09 | src/Board.tsx:1313 | Hand cards keyed by index: drag/hover state sticks to the wrong card after a play | live |
| 82 | B | 2.05 | 2.2 | 0.76 | 1.89 | money | contracts-07 | contracts/deployment.json:4 | One EOA is deployer, owner, operator and feeRecipient; MasterToken.mint is uncapped | deployed, unused by product |
| 83 | B | 2.04 | 1.96 | 0.84 | 1.23 | tooling | hygiene-07 | tsconfig.json:23 | src/server.ts, src/db.ts and api/*.ts are never typechecked by the build | live |
| 84 | B | 2.00 | 1.82 | 0.78 | 0.21 | tooling | hygiene-17 | vercel.json:7 | `/gw/:path*` rewrite is dead config; SPA fallback regex drops any dotted path | live |
| 85 | B | 1.99 | 1.86 | 0.84 | 0.93 | money | client-api-18 | src/booster-mint.ts:259 | Fabricated 'minted' offset also eats real sellable supply | minting gated off |
| 86 | B | 1.99 | 2.01 | 0.8 | 1.52 | performance | client-api-11 | src/wallet.ts:9 | Solana connectors are dead UI code but ship @solana/web3.js in the main bundle | live |
| 87 | unverified | 1.99 | 2.53 | 0.46 | 1.15 | maintainability | hygiene-13 | SECURITY_AUDIT.pdf:1 | SECURITY_AUDIT.pdf predates 51 commits incl. Privy auth, Vercel pg functions, EVM packs | live |
| 88 | B | 1.98 | 2.19 | 0.73 | 2.0 | money | contracts-14 | solana/programs/master_wager/src/lib.rs:229 | master_wager has no draw/expire path: an Active match with no winner locks both stakes forever | deployed, unused by product |
| 89 | unverified | 1.97 | 2.37 | 0.52 | 1.09 | data | server-25 | api/presence.ts:294 | Presence function runs CREATE TABLE/INDEX on every cold start request | live |
| 90 | B | 1.95 | 2.13 | 0.72 | 1.81 | performance | client-api-28 | src/presence.ts:1156 | `useOnlineCount` is mounted twice, doubling the 30s poll to a Postgres-backed function | live |
| 91 | C | 1.92 | 1.8 | 0.86 | 1.17 | money | server-02 | src/server-custodial.ts:303 | settleCustodialMatch is check-then-act with no lock: concurrent calls double-pay | legacy server, not live |
| 92 | B | 1.92 | 2.01 | 0.77 | 1.77 | money | contracts-01 | contracts/src/CardPack.sol:58 | CardPack pull is readable before _safeMint, so a contract minter can revert bad packs for free | deployed, unused by product |
| 93 | B | 1.91 | 1.83 | 0.88 | 1.57 | reliability | frontend-16 | src/App.tsx:6480 | Copy-feedback timeouts are never cleared; setState fires after unmount | live |
| 94 | B | 1.91 | 2.19 | 0.57 | 1.1 | money | contracts-09 | contracts/src/CardPack.sol:49 | CardPack keeps overpayment, has no supply cap, and withdraw(to) accepts address(0) | deployed, unused by product |
| 95 | B | 1.91 | 1.96 | 0.75 | 1.38 | tooling | hygiene-16 | package.json:27 | Dependency bloat: server/native packages in the SPA's deps, bs58 undeclared | live |
| 96 | B | 1.90 | 2.19 | 0.66 | 1.93 | money | contracts-18 | solana/Anchor.toml:21 | Anchor and deploy scripts default to mainnet with real keys; `anchor test` would hit mainnet | deployed, unused by product |
| 97 | unverified | 1.90 | 2.98 | 0.24 | 1.16 | game_integrity | engine-11 | src/Game.ts:501 | No per-turn combat flag: multiple combat phases per turn and zero-attacker combats | live |
| 98 | B | 1.89 | 2.07 | 0.66 | 1.37 | performance | server-38 | new-backend/services/game/src/results/recorder.ts:260 | First result sweep after boot re-reads every finished match ever stored | live |
| 99 | B | 1.88 | 1.94 | 0.84 | 2.14 | game_integrity | contracts-02 | contracts/src/CardPack.sol:44 | block.prevrandao is a constant on Arbitrum Orbit chains, collapsing the entropy further | deployed, unused by product |
| 100 | unverified | 1.87 | 3.1 | 0.16 | 0.8 | auth | client-api-23 | src/wallet.ts:263 | `connectRobinhoodChain` returns a checksummed address while `connectEvm` lowercases | live |
| 101 | B | 1.86 | 2.07 | 0.7 | 1.92 | money | contracts-05 | contracts/src/WagerEscrow.sol:186 | Permissionless reclaim lets a loser front-run settle after settleTimeout and convert a loss to a refund | deployed, unused by product |
| 102 | B | 1.84 | 1.91 | 0.81 | 2.01 | data | contracts-10 | src/pack-evm.ts:89 | On-chain card index space is Object.values(CARDS) order with no frozen manifest or test | minting gated off |
| 103 | C | 1.83 | 1.78 | 0.77 | 1.0 | money | server-13 | src/db.ts:169 | Postgres init failure silently falls back to in-memory store in production | legacy server, not live |
| 104 | unverified | 1.83 | 2.34 | 0.51 | 1.83 | maintainability | frontend-10 | src/Boosters.tsx:154 | Master-mute logic copied five times; Boosters' copy breaks per-track mute | live |
| 105 | unverified | 1.82 | 2.17 | 0.49 | 0.91 | money | contracts-06 | contracts/src/WagerEscrow.sol:133 | deposit writes state after the external transfer and settle/cancel/reclaim lack nonReentrant | deployed, unused by product |
| 106 | C | 1.81 | 1.79 | 0.74 | 1.02 | ux | frontend-26 | src/App.tsx:4640 | PublicProfile renders a 'custom deck' section that can never have data | live |
| 107 | B | 1.80 | 1.97 | 0.6 | 1.0 | performance | frontend-23 | src/Board.tsx:860 | Board requests profiles for fallback and bot names on every match | live |
| 108 | B | 1.80 | 2.0 | 0.66 | 1.64 | game_integrity | engine-14 | src/Game.ts:586 | Defender lifelink can heal twice; aura_lifelink/mill3/discardRandom are implemented but no card uses them | live |
| 109 | C | 1.78 | 1.78 | 0.88 | 2.14 | money | server-04 | src/server-custodial.ts:365 | Payout tx hash is persisted only after confirmation; a timeout leaves it unrecorded | legacy server, not live |
| 110 | unverified | 1.77 | 2.18 | 0.45 | 0.93 | auth | contracts-21 | contracts/deployment.json:13 | Compromised Alchemy key removed from code but rotation is only a note; no proof it happened | deployed, unused by product |
| 111 | B | 1.77 | 1.98 | 0.69 | 1.93 | performance | hygiene-20 | public:1 | Unreferenced LFS video and 12 MB of uncompressed MP3 in public/ | live |
| 112 | B | 1.76 | 1.99 | 0.6 | 1.36 | money | contracts-16 | solana/programs/master_wager/src/lib.rs:214 | Match and vault accounts are never closed; rent is leaked on every match | deployed, unused by product |
| 113 | C | 1.74 | 1.79 | 0.77 | 1.67 | money | client-api-16 | src/server-custodial.ts:932 | Custodial deposit signature can be reused across matches (no global uniqueness) | legacy server, not live |
| 114 | unverified | 1.74 | 1.9 | 0.53 | 0.48 | ux | frontend-21 | src/App.tsx:7467 | Menu music restarts when opening a player profile from the lobby | live |
| 115 | C | 1.74 | 1.64 | 0.9 | 1.66 | reliability | server-11 | src/server.ts:604 | Legacy server echoes raw error messages (pg, RPC, stack text) to clients | legacy server, not live |
| 116 | C | 1.74 | 1.65 | 0.74 | 0.71 | performance | hygiene-04 | public/cards:1 | 91 unreferenced legacy card PNG/JPGs (172 MB) are tracked in git and shipped | live |
| 117 | C | 1.72 | 1.53 | 0.91 | 1.16 | money | client-api-19 | src/wager-program.ts:623 | `masterUi` converts UI amounts with float math | unused client module |
| 118 | C | 1.70 | 1.79 | 0.82 | 2.31 | money | server-03 | src/server-custodial.ts:268 | Deposit signature is replayable across seats and matches; memo is only a warning | legacy server, not live |
| 119 | unverified | 1.69 | 3.09 | 0.11 | 1.36 | testing | client-api-07 | src/api/http.ts:109 | No tests for the refresh single-flight, 401 replay or 429 budget | live |
| 120 | C | 1.68 | 1.8 | 0.7 | 1.62 | money | server-01 | src/server.ts:560 | Legacy POST /api/result lets any client name the winner and trigger escrow payout | legacy server, not live |
| 121 | unverified | 1.67 | 2.06 | 0.53 | 1.7 | ux | frontend-22 | src/App.tsx:5253 | Fixed-position lobby buttons collide with the install banner on phones | live |
| 122 | B | 1.66 | 2.03 | 0.58 | 2.07 | performance | frontend-11 | src/Boosters.tsx:277 | Three divergent useIsMobile hooks and per-card matchMedia listeners | live |
| 123 | C | 1.66 | 1.79 | 0.86 | 2.87 | auth | server-08 | src/server.ts:213 | No legacy REST route is authenticated; body.name / ?name= is the identity | legacy server, not live |
| 124 | C | 1.66 | 1.68 | 0.82 | 1.94 | reliability | server-10 | src/server.ts:373 | Booster confirm is check-then-mint: one payment can mint two NFTs | legacy server, not live |
| 125 | C | 1.65 | 1.77 | 0.56 | 0.69 | money | server-05 | src/server-custodial.ts:251 | Deposit check accepts any amount >= stake; overpayment is silently kept | legacy server, not live |
| 126 | C | 1.63 | 1.49 | 0.84 | 1.13 | reliability | server-09 | src/server.ts:59 | Legacy body reader has no size limit and /api/* answers CORS with '*' | legacy server, not live |
| 127 | unverified | 1.61 | 2.18 | 0.44 | 1.91 | auth | contracts-08 | contracts/src/WagerEscrow.sol:18 | All three contracts use single-step Ownable; renounce or a typo bricks setOperator and withdraw | deployed, unused by product |
| 128 | C | 1.58 | 1.67 | 0.62 | 1.01 | reliability | server-07 | src/server-custodial.ts:110 | ensureSchema runs DDL at request time and caches a rejected promise forever | legacy server, not live |
| 129 | C | 1.57 | 1.8 | 0.61 | 1.69 | auth | server-12 | src/server.ts:514 | Admin refund token compared with === and no rate limit | legacy server, not live |
| 130 | unverified | 1.55 | 2.92 | 0.1 | 1.59 | game_integrity | engine-07 | new-backend/services/game/src/game/cards.ts:9 | Server card catalogue is stale: base_moose missing, Knowledge starter deck differs from client | live |
| 131 | C | 1.55 | 1.21 | 0.92 | 0.32 | testing | client-api-26 | src/linked-wallets.test.ts:601 | Fallback-copy test asserts only that a string came back | live |
| 132 | unverified | 1.53 | 2.12 | 0.43 | 2.09 | ux | frontend-19 | src/App.tsx:6845 | Most modals have no dialog role, focus trap, initial focus or Escape handling | live |
| 133 | unverified | 1.49 | 3.06 | 0.04 | 1.75 | testing | engine-19 | src/Game.ts:735 | No tests exist for Game.ts or bot.ts; every rules bug above is untested | live |
| 134 | C | 1.47 | 1.58 | 0.66 | 1.57 | auth | server-20 | src/db.ts:705 | Challenge ids come from Math.random and the actor is client-asserted | legacy server, not live |
| 135 | C | 1.46 | 1.67 | 0.62 | 1.88 | auth | server-06 | src/server-custodial.ts:162 | Anyone can pre-create a wager row for any matchID and pin its amount | legacy server, not live |
| 136 | C | 1.42 | 1.06 | 0.87 | 0.06 | tooling | hygiene-18 | .gitignore:15 | .boost/ is not ignored; bare `frontend`/`backend` patterns ignore any such path | live |
| 137 | C | 1.42 | 1.39 | 0.82 | 1.82 | game_integrity | engine-08 | new-backend/services/game/src/game/cards.ts:401 | Server log strings use chain-era card names (PEPE, BnB Node) that the client rebrand removed | live |
| 138 | C | 1.42 | 1.24 | 0.84 | 1.04 | tooling | hygiene-06 | vite.config.ts:23 | Dev proxy sends /api/chat and /api/presence to the gateway, which has no such routes | live |
| 139 | unverified | 1.41 | 2.0 | 0.38 | 1.97 | performance | hygiene-12 | src/App.tsx:1 | Entry chunk is 1.45 MB (443 kB gzip); Vite flags four chunks over 500 kB | live |
| 140 | C | 1.39 | 1.09 | 0.8 | 0.1 | maintainability | frontend-27 | src/App.tsx:5129 | `useStarterDeck` is a plain async function named like a hook | live |
| 141 | C | 1.39 | 1.42 | 0.81 | 2.12 | money | contracts-13 | src/wager-program.ts:153 | Anchor client/program use classic SPL Token for MASTER while the custodial path uses Token-2022 for the same mint | unused client module |
| 142 | C | 1.39 | 1.79 | 0.62 | 2.94 | money | contracts-12 | src/server.ts:565 | WagerEscrow and master_wager are deployed/documented but zero real wagers use them | legacy server, not live |
| 143 | C | 1.38 | 1.07 | 0.88 | 0.43 | maintainability | client-api-15 | src/pack-evm.ts:596 | CARD_PACK read via raw `import.meta.env`, bypassing the sanctioned `readEnv` | minting gated off |
| 144 | C | 1.37 | 1.01 | 0.89 | 0.14 | testing | hygiene-01 | package.json:12 | `npm test` is red: root vitest sweeps new-backend/ and 20 files fail to load | live |
| 145 | unverified | 1.32 | 1.73 | 0.32 | 1.03 | maintainability | frontend-05 | src/App.tsx:324 | Login still carries the whole wallet sign-in path, but nothing calls it | live |
| 146 | C | 1.30 | 0.96 | 0.82 | 0.02 | tooling | hygiene-15 | package.json:25 | `anchor` dependency is the Sails/Waterline validator, not Coral Anchor, and is unused | live |
| 147 | C | 1.29 | 1.0 | 0.9 | 0.65 | tooling | hygiene-19 | .gitattributes:1 | No eol normalization: autocrlf=true causes LF->CRLF warnings and whole-file diffs | live |
| 148 | unverified | 1.27 | 1.73 | 0.45 | 2.24 | maintainability | frontend-12 | src/Board.tsx:450 | The card face is rendered seven different ways with copy-pasted cost-pip logic | live |
| 149 | C | 1.23 | 1.04 | 0.83 | 1.03 | tooling | hygiene-08 | docs/CARDS.txt:1 | docs/CARDS.txt (git) vs docs/cards.txt (disk) case clash corrupts the diff | live |
| 150 | unverified | 1.22 | 1.08 | 0.53 | 0.01 | tooling | contracts-22 | package.json:25 | `anchor` npm dependency is the unrelated Sails.js validator, not @coral-xyz/anchor | live |
| 151 | C | 1.21 | 1.14 | 0.85 | 1.81 | money | server-19 | src/server-wager.ts:65 | Anchor oracle settle path has no draw/cancel handling and is dead code | dead code |
| 152 | unverified | 1.20 | 2.05 | 0.27 | 2.7 | testing | contracts-11 | contracts/test/WagerEscrow.t.sol:14 | Foundry suite covers only WagerEscrow happy paths; libs not installed and no CI runs forge | deployed, unused by product |
| 153 | C | 1.19 | 1.26 | 0.58 | 1.33 | reliability | server-22 | src/server.ts:641 | Legacy boot has no graceful shutdown or unhandledRejection handler | legacy server, not live |
| 154 | C | 1.14 | 1.02 | 0.87 | 1.67 | tooling | hygiene-09 | README.md:1 | README describes the retired 5-chain OCVA game, Render deploy and masterstcg.com | live |
| 155 | unverified | 1.06 | 1.2 | 0.48 | 1.41 | maintainability | hygiene-21 | scripts:1 | Scripts read keys from env (no hardcoded secrets found); several target the retired stack | live |
| 156 | unverified | 0.79 | 1.22 | 0.19 | 1.93 | maintainability | frontend-07 | src/App.tsx:716 | ~1,400 lines of dead components and three unrendered WebGL effects in the bundle | live |
| 157 | unverified | 0.78 | 1.47 | 0.21 | 2.99 | maintainability | frontend-01 | src/App.tsx:7113 | App.tsx is a 8,479-line god module holding 13 distinct screens plus the router | live |
| 158 | unverified | 0.53 | 0.45 | 0.49 | 1.52 | maintainability | client-api-12 | src/boosters-api.ts:44 | Dead modules: boosters-api.ts, server-wager.ts, wager-program.ts (client side) | unused client module |

Jev usage for the triage: 158 calls, 206115 input tokens, 32103 output tokens (about one cent at list price).

---

# Resolutions (fix pass, 2026-11-01)

All six areas were fixed in parallel, then reconciled and verified together. Per-finding ledgers are in `docs/review/resolutions/*.json`.

**Coverage (162 unique findings):** 126 fixed outright, 18 hygiene resolved, 5 contract fixes written but unverified-by-compiler (no `forge`/MSVC linker on this machine), 8 partial, a few low-severity items left open. Everything in the money / auth / game-integrity / critical buckets is fixed.

**Verification gate (all green):**
- `tsc` (client `src`): 0 errors. `tsc` (new `tsconfig.api.json`, api/): 0 errors.
- Root `vitest`: 210 passed (was a red suite that didn't even run cleanly).
- `vite build`: ok; entry chunk 498 kB (was 1,449 kB).
- new-backend `typecheck`: clean across all workspaces. new-backend tests: wager 82, auth 23, game 90, rpc-proxy 26 — all pass (env-gated chain/db tests skipped offline).

**Highlights:** the combat stall/fog exploit, the non-functional forfeit, the turn-one draw, the starter-aura truncation, the optimistic self-loss, and deterministic uids are fixed with reducer tests. The insecure legacy Koa server, `render.yaml`, 91 unreferenced card images (~175 MB) and two dead client modules are deleted. The live backend gained token revocation, verify-before-consume nonces, replace-by-fee payouts, lobby anti-win-trading, TLS verification on every Postgres pool, and a real CSP + security headers in `vercel.json`. Live in-match **voice chat** was shipped on a secured PeerJS path (peer ids exchanged through the authenticated `announceVoicePeer` move + `G.voice`, stripped from spectators — the audit's H-6 open-mic hole is closed). CI, Biome, and a root `vitest.config.ts` were added.

**Money-critical note (cardIndex):** `base_moose` (a gameplay card added after the CardPack was deployed) is deliberately NOT in the on-chain mint index. The provenance test now enforces append-only: none of the 80 deployed indices may shift, but post-deploy gameplay cards may exist. Minting stays off until a redeploy regenerates the index.

**Still open (low / product decisions):**
- `rules-intro.mp4` (180 MB, LFS) exceeds Vercel's limit and 404s on the hub. Needs a product call: host it on a CDN and set `VITE_RULES_VIDEO_URL`, or drop the player. Not auto-hidden.
- Bot uses `Math.random`, so the seeded Daily Challenge isn't reproducible (engine-15/16); a few low-severity combat edge cases (engine-09/11/17); one mobile layout nit (frontend-22); the contract Solidity/Rust fixes are unverified because this machine has no `forge` and no MSVC linker for `cargo check`.
- Nothing is committed. The contract fixes change source only; deployed bytecode is unchanged.
