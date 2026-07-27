# Chains TCG

A Magic-the-Gathering-inspired turn-based trading card game themed around 5 blockchains, built on **boardgame.io**.

## Repository layout

```
frontend/            New client — Next.js (App Router) + Tailwind + shadcn/ui, mobile-first
backend/             Microservices — Docker Compose + PostgreSQL + Redis
  gateway/           nginx reverse proxy (single public entrypoint, :8080)
  services/game/     boardgame.io match server (lobby REST + socket.io realtime)
  services/profile/  REST API — profiles, decks, match results, leaderboard
  db/                PostgreSQL schema
packages/game-core/  Shared game rules (cards, game state machine, bot AI)
                     — imported by both the frontend and the game service
old-frontend/        The previous Vite/React app (kept intact for reference:
                     wallet, boosters, wagers, ranked, Solana/EVM integrations)
```

## The game (rules summary)

- **Life:** 20. Drop your opponent to 0 → you win.
- **Chains (colors):** BnB (gold), Solana (purple), Ethereum (silver), Robinhood (green), Base (blue).
- **Card types:** **Nodes** (lands — tap for 1 gas), **Memes** (creatures with Power/Toughness),
  **Machines** (permanents with passive effects), **Auras** (attach to memes), **Moves** (one-shot spells).
- **Turns:** untap + draw → main (play cards, tap nodes for gas, declare attackers) →
  combat (blocks, damage) → cleanup (discard to 7, gas drains).
- Starter deck per chain = 12 Nodes + 4× each non-node card of that color.

Full rules and card pool live in `packages/game-core/src/cards.ts` and `Game.ts`.

## Quick start

### 1. Backend (Docker)

```bash
cd backend
docker compose up --build
# gateway on http://localhost:8080  (→ game :8000, profile :8001, postgres, redis)
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
# http://localhost:3000  — talks to the gateway at http://localhost:8080
```

Open two browser windows to play multiplayer, or hit **Play vs Bot** for solo.

### Without Docker

The game service runs standalone (no DB needed for matches):

```bash
cd backend/services/game && npm install && npm run dev   # :8000
```

The profile service needs `DATABASE_URL` (Postgres) and optionally `REDIS_URL`.

## Card art

Card images are not generated yet — the UI renders styled placeholder frames.
Drop final art into `frontend/public/cards/<cardId>.png` and it is picked up automatically.
