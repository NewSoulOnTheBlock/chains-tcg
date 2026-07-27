# Chains TCG — Backend

Microservices backend: an nginx gateway in front of a boardgame.io game
server and an Express profile/REST service, backed by PostgreSQL and Redis.
Both Node services consume the shared rules package
[`@chains/game-core`](../packages/game-core) as raw TypeScript via `tsx`.

## Architecture

```
                         ┌─────────────────────────────┐
  frontend (Next.js)     │   gateway  (nginx :8080)    │
  http://localhost:3000 ─►                             │
                         │  /api/*        ──► profile  │
                         │  /games/*      ──► game     │
                         │  /socket.io/*  ──► game (ws)│
                         └───────┬──────────────┬──────┘
                                 │              │
                    ┌────────────▼───┐   ┌──────▼─────────┐
                    │ profile :8001  │   │  game :8000    │
                    │ Express REST   │   │  boardgame.io  │
                    │ profiles/decks │   │  lobby + ws    │
                    │ matches/board  │   │  (pg-backed    │
                    └───┬───────┬────┘   │   matches)     │
                        │       │        └───────┬────────┘
              ┌─────────▼──┐ ┌──▼────────┐       │
              │ postgres 16│ │ redis 7   │       │
              │ (pgdata)   │ │ (cache)   │       │
              └─────▲──────┘ └───────────┘       │
                    └────────────────────────────┘
```

Both services import `ChainsTCG` / `validateDeck` from `@chains/game-core`
(a `file:` dependency), so game rules live in exactly one place.

## Run the full stack (Docker)

```sh
cd backend
docker compose up --build
```

Zero config required — every env var has a default (see `.env.example`;
copy it to `.env` to override `POSTGRES_PASSWORD` or `ALLOW_ORIGIN`).

Everything is reachable through the gateway at **http://localhost:8080**:

```sh
curl http://localhost:8080/api/healthz          # profile service health
curl http://localhost:8080/games/chains-tcg     # boardgame.io match list
```

The services are also published directly for debugging: game on `:8000`,
profile on `:8001`.

`db/init.sql` runs automatically on the postgres container's **first** boot.
To re-run it after schema changes, drop the volume:
`docker compose down -v && docker compose up --build`.

## Run services locally (no Docker)

Game service alone needs nothing else:

```sh
cd backend/services/game
npm install
npm run dev            # http://localhost:8000  (PORT=xxxx to override)
```

Profile service needs a local PostgreSQL (seeded with `db/init.sql`) and
optionally Redis — without Redis it still works, just uncached:

```sh
createdb chains && psql chains -f backend/db/init.sql   # once
cd backend/services/profile
npm install
DATABASE_URL=postgres://chains:chains@localhost:5432/chains \
REDIS_URL=redis://localhost:6379 \
npm run dev            # http://localhost:8001
```

## Endpoints

### Gateway (`:8080`)

| Route | Upstream |
| --- | --- |
| `/api/*` | profile service |
| `/games/*` | game service (boardgame.io lobby REST) |
| `/socket.io/*` | game service (websocket, boardgame.io multiplayer) |
| anything else | `404 {"error":"not found"}` |

CORS is handled by the upstream services; nginx adds no CORS headers.

### Profile service

| Method + path | Description |
| --- | --- |
| `POST /api/profiles` `{name}` | Upsert profile by name (case-insensitive) → `{id,name,wins,losses,avatarUrl,bio}` |
| `GET /api/profiles/:name` | Fetch profile, 404 if missing |
| `PATCH /api/profiles/:name` `{avatarUrl?, bio?}` | Update avatar URL and/or bio (empty string or null clears) → full profile |
| `GET /api/profiles/:name/matches?limit=20` | Recent matches, newest first → `[{id, opponent, result: 'win'\|'loss', mode, createdAt}]` (limit clamped to 1–100) |
| `GET /api/profiles/:name/decks` | List the profile's decks |
| `POST /api/profiles/:name/decks` `{name, cards: string[]}` | Create deck; validated with `validateDeck` (400 + `issues` if illegal) |
| `PUT /api/decks/:id` `{name?, cards?}` | Rename and/or replace cards (cards re-validated) |
| `DELETE /api/decks/:id` | Delete deck |
| `POST /api/matches` `{winner, loser, mode?}` | Record match (profile names); increments wins/losses transactionally, busts leaderboard cache |
| `GET /api/leaderboard` | Top 50 by wins; redis-cached 30 s |
| `GET /healthz`, `GET /api/healthz` | `{ok, postgres, redis}` |

### Game service

| Method + path | Description |
| --- | --- |
| `GET /games/chains-tcg` | boardgame.io lobby: list matches |
| `POST /games/chains-tcg/create` | Create match (boardgame.io lobby API) |
| `/socket.io/*` | Realtime game transport |
| `GET /healthz` | `{ok:true}` (direct only — not routed by the gateway) |

## How the frontend connects

Point the frontend at the gateway, `http://localhost:8080`:

- boardgame.io `SocketIO` client + Lobby API → `server: 'http://localhost:8080'`
  (nginx proxies `/games/*` and upgrades `/socket.io/*` websockets).
- Profile/deck/leaderboard REST → `http://localhost:8080/api/...`.

`http://localhost:3000` is allowed by the game server's origin list out of
the box; add extra origins via `ALLOW_ORIGIN` (comma-separated).

## Notes / v1 limitations

- **Match storage is persistent**: the game service stores boardgame.io match
  state in Postgres via `bgio-postgres` (a `Games` table in the shared
  `chains` database), so matches survive game-service restarts. This is driven
  by `DATABASE_URL` (set in docker-compose); when it is unset (bare local
  dev without docker), the server logs a warning and falls back to the
  default in-memory store, where restarts drop matches.
- No auth: profiles are trusted by name, matching the current game design.
- Redis is a pure cache; the profile API degrades gracefully if it is down.
