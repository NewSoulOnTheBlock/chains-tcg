# Egregore TCG

A turn-based trading-card game in the Magic tradition, built on
**boardgame.io** and themed around five **Sproto Gremlin** factions.

- **Play:** [egregoretcg.xyz](https://egregoretcg.xyz) (Vite + React SPA on Vercel)
- **API:** `api.ocva.online` (the `new-backend/` monorepo, deployed separately)
- **Repo:** `NewSoulOnTheBlock/chains-tcg`

> **History.** This project began as *On-Chain Virtual Arena* (OCVA), a
> five-blockchain game on masterstcg.com deployed through Render. That stack
> is retired. Anything that still mentions Render, Supabase or masterstcg is
> legacy and can be ignored. The repo name `chains-tcg` and the internal
> card-id prefixes (`bnb_`, `sol_`, `eth_`, `robinhood_`, `base_`) are
> leftovers from that era.

---

## Contents

1. [The game](#the-game)
2. [Card set](#card-set)
3. [Card art pipeline](#card-art-pipeline)
4. [Repository layout](#repository-layout)
5. [Running locally](#running-locally)
6. [Scripts](#scripts)
7. [Testing and CI](#testing-and-ci)
8. [Deployment](#deployment)
9. [Environment variables](#environment-variables)
10. [Security](#security)
11. [Code review and docs](#code-review-and-docs)

---

## The game

Two players, 20 life each. Win by dropping the opponent to 0 life or by
making them draw from an empty deck.

**Card types**

| Type | What it is |
|---|---|
| **Node** | Land. One per turn. Tap for 1 gas of its faction's color. |
| **Meme** | Creature with Power / Toughness. Attacks and blocks. |
| **Machine** | Permanent with a passive effect. |
| **Aura** | Enchantment that attaches to a single Meme. |
| **Move** | One-shot spell. |

**Turn structure**

1. Untap, then draw (the first player skips the draw on turn one).
2. Main phase: play Nodes and cards, tap Nodes for gas, declare attackers.
3. Combat: confirm attackers, defender assigns blocks, damage resolves.
4. End: discard down to hand size, unspent gas drains.

**Decks** are 60 cards (`DECK_SIZE` in `src/cards.ts`). Each faction ships a
starter deck in `STARTER_DECKS`; `validateDeck` enforces legality. Hidden
information (libraries, the opponent's hand) lives in `G.secret` and is
stripped per seat by `playerView`.

**Modes** available from the hub: casual lobby matches, ranked queue, solo
play against the built-in bot (`src/bot.ts`), a daily challenge, the
**Masterquest** single-player map, and in-match voice chat over PeerJS.

### The five factions

Factions are defined in `COLOR_META` in `src/cards.ts`.

| Internal key | Faction | Color | Identity |
|---|---|---|---|
| `bnb` | **Spirit** | white | go wide, lift the whole host, cleanse the field |
| `sol` | **Rebel** | red | burn, snipe, hit first and fast |
| `eth` | **Jester** | black | removal, control, the last laugh |
| `robinhood` | **Wealth** | green | lifegain midrange, sturdy bodies, compounding |
| `base` | **Knowledge** | blue | card advantage, tricks, cheap swarm |

---

## Card set

The catalogue is the single source of truth in `src/cards.ts`. It currently
holds **85 cards**:

| Type | Count |
|---|---|
| Node | 5 (one per faction) |
| Meme | 40 |
| Machine | 20 |
| Aura | 5 |
| Move | 15 |

A plain-text dump of every card (name, type, cost, rules text) is generated
into `docs/CARDS.txt`. Regenerate it whenever the catalogue changes.

---

## Card art pipeline

Finished card renders come from the external **card-forge** tool as
**1064 x 1478 WebP** files with frame and text already baked in. They are
vendored by faction under `public/cards/`:

```
public/cards/
  spirit/     jester/     knowledge/
  rebel/      wealth/
```

`FULL_CARDS` in `src/cards.ts` maps a card id to its WebP. A card with no
entry falls back to a generated faction sigil, so the game never breaks on a
missing render. The legacy loose PNG/JPG art that used to sit directly in
`public/cards/` has been removed from the tree in this release.

---

## Repository layout

```
.
+-- src/                    Front end (Vite + React 18 + boardgame.io client)
|   +-- cards.ts            Card catalogue, COLOR_META, FULL_CARDS, starter decks
|   +-- Game.ts             boardgame.io game: state, moves, combat, playerView
|   +-- bot.ts              Solo-mode AI opponent
|   +-- App.tsx, Board.tsx  Hub, lobby, match seat, board rendering
|   +-- api/                Typed HTTP client for the gateway (auth, lobby, ranked, wager...)
|   +-- components/         Shared UI (CardFace, Modal, responsive helpers)
|   +-- hooks/              Shared hooks split out of App.tsx
|   +-- screens/            Rulebook, ErrorBoundary and other split-out screens
|   +-- masterquest/        Single-player map, lore and progress
|   +-- privy/              Privy auth flow and env validation
+-- api/                    Vercel functions (Neon Postgres): hub chat + presence
+-- migrations/             SQL for the Neon chat/presence database (run by hand)
+-- public/cards/           Card art WebPs, one folder per faction
+-- docs/                   CARDS.txt, SECURITY.md, code-review reports
+-- scripts/                Dev utilities and chain scripts (see scripts/README.md)
+-- new-backend/            Live API monorepo: auth, profile, game, wager, rpc-proxy, gateway
+-- contracts/              EVM contracts (Foundry): CardPack, MasterToken, WagerEscrow
+-- solana/                 Anchor programs from the OCVA era
+-- .github/workflows/      CI (front end + backend)
+-- biome.json              Lint config
+-- vitest.config.ts        Front-end test config
+-- vercel.json             SPA rewrites, /gw proxy, security headers
```

**`new-backend/`** is deployed on its own (Docker on a VPS behind Caddy; see
`new-backend/DEPLOY.md`, `ARCHITECTURE.md` and `INTEGRATION.md`). It is not
built or deployed by this repo's Vercel project.

**`contracts/`** and **`solana/`** are deployed on-chain but **not used by the
product today**. Pack minting is gated off (`PACK_MINTING_AVAILABLE = false`).
They are kept for reference and have their own test suites.

---

## Running locally

Requirements: Node 20+, npm.

```bash
npm install          # root; .npmrc pins legacy-peer-deps (required, see the file)
npm run dev          # Vite dev server on http://localhost:5173
```

The dev server proxies `/auth`, `/api`, `/games`, `/wager`, `/rpc` and
`/socket.io` to the live gateway (`VITE_DEV_API_PROXY`, default
`https://api.ocva.online`), so you can play against production without
running a backend.

Two routes are Vercel functions rather than gateway routes and are **not**
proxied: `/api/chat` and `/api/presence`. They return 404 under `npm run dev`
unless you run `vercel dev` with the chat database env set.

To develop against a local backend instead, run `new-backend/` per its own
README and point `VITE_DEV_API_PROXY` at it.

---

## Scripts

```bash
npm run dev           # Vite dev server
npm run build         # tsc -b && vite build  ->  dist/
npm run preview       # serve the production build locally
npm run typecheck     # tsc for the browser (tsconfig.json) and api/ (tsconfig.api.json)
npm test              # vitest, src/**/*.test.ts and api/ tests
npm run lint          # Biome lint (lint only, no formatting)
npm run render:cards  # render every card to PNG via Playwright (dev utility)
```

`scripts/README.md` documents every script in `scripts/`, including which
ones are current and which are chain-era leftovers.

---

## Testing and CI

The front end has a vitest suite covering the game engine (`Game.test.ts`),
card catalogue, collection, ranked client, match modes, linked wallets, error
text, Privy auth flow and the API HTTP layer. `new-backend/` has its own
vitest suites per service, and `contracts/` has Foundry tests for all three
contracts.

GitHub Actions (`.github/workflows/ci.yml`) runs on every push and PR:

| Job | Steps |
|---|---|
| **Front end** | `npm ci`, `npm run typecheck`, `npm test`, `npm run build` |
| **new-backend** | `npm ci`, `npm run typecheck`, `npx vitest run` |

Lint is not a CI gate yet. `npm run lint` currently reports a large backlog
of Biome findings; treat it as advisory until that is burned down.

---

## Deployment

The SPA deploys to **Vercel** from this repo (`vercel.json`):

- `/gw/*` is rewritten to `https://api.ocva.online/*` so REST and RPC calls
  are same-origin. The boardgame.io socket connects directly to
  `VITE_SOCKET_URL`.
- All non-file paths fall through to `index.html` for client routing.
- Security headers are set on every response: HSTS, `X-Frame-Options: DENY`,
  `nosniff`, a strict Referrer-Policy, a Permissions-Policy that only allows
  the microphone (voice chat), and a **report-only** Content-Security-Policy.
  See `docs/review/csp.md` for the plan to enforce it.
- `api/chat.ts` and `api/presence.ts` run as Vercel functions against a Neon
  Postgres database. Run `migrations/presence.sql` once by hand against that
  database before the first deploy; the function does no DDL on the request
  path.

The backend is deployed independently from `new-backend/` (see its
`DEPLOY.md`).

---

## Environment variables

**Build-time, committed in `.env.production`** (all public by design):

| Var | Purpose |
|---|---|
| `VITE_API_BASE` | REST + RPC base. `/gw` in production (same-origin rewrite). |
| `VITE_SOCKET_URL` | boardgame.io socket.io origin (`https://api.ocva.online`). |
| `VITE_PRIVY_APP_ID` | Privy app id. |
| `VITE_DEV_API_PROXY` | Dev-only: where the Vite proxy forwards gateway routes. |

**Runtime, set in the Vercel dashboard** (never committed):

| Var | Purpose |
|---|---|
| `CHAT_DATABASE_URL` | Neon connection string for hub chat and presence. |
| `CHAT_ADMINS` / `CHAT_ADMIN_IDS` | Comma-separated wallet addresses / profile ids that may post announcements. |
| `CHAT_ADMIN_KEY` | Shared secret for scripted admin posts via `x-chat-admin-key`. |
| `PRESENCE_AUTOMIGRATE` | Set to `1` only on throwaway/preview DBs to let the first request create the table. |

Copy `.env.example` to `.env.local` for local overrides. `new-backend/` has
its own `.env.example`.

---

## Security

`docs/SECURITY.md` is the entry point. In short: the `SECURITY_AUDIT.pdf` at
the repo root is a **2026-07-27 snapshot** that predates Privy auth, the
Vercel functions, the EVM pack contracts and the current shape of
`new-backend/`. Open, verified security items from the 2026-11-01 code review
are tracked in `docs/review/`.

Please report vulnerabilities privately rather than in public issues.

---

## Code review and docs

| Doc | What it covers |
|---|---|
| `docs/review/2026-11-01-code-review.md` | Full review: engine, front end, client/wallet, servers, contracts, hygiene |
| `docs/review/2026-11-01-findings.json` | Every finding, machine-readable |
| `docs/review/*.json`, `resolutions/`, `jev-triage/` | Per-area findings and how each was resolved or triaged |
| `docs/review/csp.md` | Content-Security-Policy rollout plan |
| `docs/SECURITY.md` | Audit status and where open security items live |
| `docs/CARDS.txt` | Generated card list |
| `new-backend/ARCHITECTURE.md`, `DEPLOY.md`, `INTEGRATION.md` | Backend design, deployment and client integration |
| `scripts/README.md` | Status of every script |
| `src/api/README.md` | Front-end API client conventions |
