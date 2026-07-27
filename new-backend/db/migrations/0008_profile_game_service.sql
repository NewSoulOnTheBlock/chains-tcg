-- 0008_profile_game_service.sql
-- Requested by the profile (:4002) and game (:4003) services.
--
-- Everything here is additive to 0002_core and 0004_game. No table is created
-- by a service at boot; this file is the only place these columns come from.

-- ── core.decks: an "active deck" pointer ────────────────────────────────────
-- The game service seats a player from their ACTIVE deck, server-side, at join
-- time. Without a pointer there is no way to answer "which deck is this player
-- bringing?" without trusting the client to name one — which is exactly the
-- C-3 pattern this backend exists to remove.
ALTER TABLE core.decks ADD COLUMN IF NOT EXISTS is_active  boolean     NOT NULL DEFAULT false;
ALTER TABLE core.decks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- At most one active deck per profile, enforced by the database rather than by
-- "clear then set" application logic that a concurrent request could interleave.
CREATE UNIQUE INDEX IF NOT EXISTS decks_one_active_per_profile
    ON core.decks (profile_id) WHERE is_active;

COMMENT ON COLUMN core.decks.is_active IS
    'The deck the game service seats this profile with. Exactly one per profile (partial unique index).';

-- ── game.matches: lobby + seating columns ──────────────────────────────────
-- `game.matches` is the lobby. An open match exists here BEFORE any
-- boardgame.io match does, which is what lets GET /games/lobby answer without
-- ever touching setupData (H-7).
ALTER TABLE game.matches ADD COLUMN IF NOT EXISTS invited_profile   bigint      REFERENCES core.profiles(id);
ALTER TABLE game.matches ADD COLUMN IF NOT EXISTS wager_amount_base bigint;
ALTER TABLE game.matches ADD COLUMN IF NOT EXISTS seat0_deck_id     bigint      REFERENCES core.decks(id);
ALTER TABLE game.matches ADD COLUMN IF NOT EXISTS seat1_deck_id     bigint      REFERENCES core.decks(id);
ALTER TABLE game.matches ADD COLUMN IF NOT EXISTS started_at        timestamptz;
ALTER TABLE game.matches ADD COLUMN IF NOT EXISTS updated_at        timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN game.matches.invited_profile IS
    'Set for a direct challenge. Combined with unlisted, this is what makes private matches invisible to everyone else — the filter is a WHERE clause, never client-side (H-7).';
COMMENT ON COLUMN game.matches.wager_amount_base IS
    'Advisory display amount in base units, shown in the lobby. The wager service owns the escrow and the authoritative amount; nothing on a game-service route can move money.';
COMMENT ON COLUMN game.matches.seat0_deck_id IS
    'The deck the server attached to this seat. The client never sends a decklist.';

-- Lobby listing and the challenge inbox.
CREATE INDEX IF NOT EXISTS matches_open_idx
    ON game.matches (created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS matches_invited_idx
    ON game.matches (invited_profile) WHERE status = 'open';

-- ── boardgame.io's own storage ─────────────────────────────────────────────
-- bgio-postgres is a sequelize adapter: its `connect()` calls `sequelize.sync()`,
-- which issues CREATE TABLE IF NOT EXISTS "Games". That is vendor-internal and
-- unavoidable short of forking the adapter, so it is confined to a schema of its
-- own. The game service never creates this schema — if the migration has not
-- run, it fails to boot rather than quietly writing into `public`.
CREATE SCHEMA IF NOT EXISTS bgio;
COMMENT ON SCHEMA bgio IS
    'boardgame.io internal match storage ("Games": state, log, metadata). Opaque vendor table, written only by the game service. The authoritative outcome is game.match_results, never anything in here.';

-- ── optional: exact leaderboard ordering ───────────────────────────────────
-- The profile service orders by (wins DESC, losses ASC, id ASC); 0002_core's
-- profiles_wins_idx covers the leading column. Add this only if the top-50 query
-- shows up in pg_stat_statements.
-- CREATE INDEX IF NOT EXISTS profiles_leaderboard_idx
--     ON core.profiles (wins DESC, losses ASC, id ASC);
