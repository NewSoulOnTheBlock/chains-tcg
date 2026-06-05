# Memetic Masters TCG

A Magic-the-Gathering-inspired turn-based card game built on **boardgame.io**, themed around 5 blockchains.

## The Five Chains

| Chain | Color | Slot |
|---|---|---|
| BnB | orange/gold | fast cheap memes, ramp |
| Solana | purple | burst, draw, removal |
| Avalanche / AVAX | red | big bodies, lifelink |
| Ethereum | white | control, removal, finishers |
| XRP | black | sneaky bodies, hard removal |

## Rules summary

- **Life:** 20. Drop opponent to 0 → you win.
- **Cards:** 4 types.
  - **Nodes** — like lands. Play **one per turn**. Tap for 1 gas of their color.
  - **Memes** — creatures with Power/Toughness. Can attack the turn after they're played (no summoning sickness on turn 2+).
  - **Machines** — permanents with passive global effects (artifacts/enchantments).
  - **Moves** — one-shot spells (instants/sorceries) that resolve and go to graveyard.
- **Gas:** each Node taps for 1 gas of its color. Gas drains at end of turn.
- **Turn structure (per player):**
  1. Untap all your stuff, draw 1 card (skipped on Turn 1 for the starter).
  2. Main phase: play cards, tap Nodes for gas, declare attackers.
  3. Combat: confirm attackers → defender assigns blockers → resolve damage.
  4. End: discard down to 7, drain gas, hand off the turn.
- **Combat:** unblocked attackers damage the defending player. Blocked attackers fight blockers (damage compares to toughness). Damage clears at end of combat.
- **Win condition:** opponent at ≤ 0 life, or empty deck on draw.

## Card pool

5 chains × (4 memes + 2 machines + 2 moves) + nodes — see `src/cards.ts`. Each starter deck = 12 Nodes + 4 of every non-node card in that color = 30 cards.

## Running

### Local development (server + client with hot reload)

```bash
npm install
npm run serve        # terminal 1 — backend on :8000 (lobby + REST API + Postgres if DATABASE_URL set)
npm run dev          # terminal 2 — Vite dev server on :5173, proxies /api /games /socket.io to :8000
```

Open `http://localhost:5173` in **two different browser windows** (different tabs/profiles work too — each uses `sessionStorage` for its own identity). Each window logs in as a separate profile, picks a chain, creates or joins a match in the lobby, then plays.

Without `DATABASE_URL`, profile data lives in the server's in-memory store (resets on restart). To use Postgres locally:

```bash
$env:DATABASE_URL = "postgres://user:pass@localhost:5432/chains"
npm run serve
```

## Deploying to Render.com

This repo includes a `render.yaml` blueprint that provisions one Node web service + one free Postgres database, and wires `DATABASE_URL` automatically.

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Blueprint**, point at the repo, click **Apply**.
3. Render builds (`npm ci && npm run build`) and starts (`npm start`) the web service. The boardgame.io socket.io server, lobby REST API, custom `/api/*` profile endpoints, and the static React build are all served from the same port.
4. The production site lives at `https://www.masterstcg.com`. `ALLOW_ORIGIN` is set in `render.yaml` to permit both the apex (`https://masterstcg.com`) and `www` host; it accepts a comma-separated list if you need to add more origins.

Share the URL with anyone — they sign in with a name, see all open matches, and either join one or create their own. Win/loss records persist globally in Postgres and show up on the in-app leaderboard.

### Environment variables

| Var | Purpose |
|---|---|
| `PORT` | Port to listen on (Render sets this automatically). |
| `DATABASE_URL` | Postgres connection string. Without it, server uses an in-memory fallback. |
| `PGSSL` | Set to `1` to force SSL on Postgres (required on Render). |
| `ALLOW_ORIGIN` | Production origin(s) to permit for socket.io + REST connections. Accepts a single URL or a comma-separated list (e.g. `https://www.masterstcg.com,https://masterstcg.com`). |
| `VITE_SERVER_BASE` | (Build-time, optional) Override server URL the client connects to. Leave empty to use same origin. |
| `VITE_API_BASE` | (Build-time, optional) Override REST API base. Leave empty for same origin. |

## Architecture

- `src/cards.ts` — card definitions, color palette, 60-card starter decks.
- `src/Game.ts` — boardgame.io `Game`: state shape, all moves, combat resolution, `playerView` for hidden state.
- `src/Board.tsx` — React UI: hand, battlefield, gas, combat, target picker, chat, profile header.
- `src/App.tsx` — Login → Lobby (create/join match) → MatchSeat with `SocketIO` multiplayer.
- `src/server.ts` — boardgame.io `Server` (Koa) + custom `/api/*` REST API + static-serves the React `dist/`.
- `src/db.ts` — Postgres profile store with in-memory fallback.
- `src/profiles.ts` — client-side HTTP wrapper around the profile API.
- `render.yaml` — Render blueprint (web service + Postgres).

## Hidden information

The deck contents are stored in `G.secret.decks` and stripped to size-only via `playerView`. Opponent's hand is replaced with `'hidden'` placeholders before being sent to your client. The framework's authoritative master (in-browser via `Local()`, or remote via `SocketIO`) is the only thing that ever sees the full state.

## Determinism

All shuffles and any future random effects use the `random` API. Set a fixed `seed` on the game object to make matches reproducible for tests.
