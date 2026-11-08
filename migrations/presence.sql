-- Presence table for the /api/presence Vercel function (server-25).
--
-- This targets the Neon CHAT database (CHAT_DATABASE_URL), which is SEPARATE
-- from the new-backend primary Postgres. It is NOT in new-backend/db/migrations
-- on purpose: the `make migrate` runner would apply that folder to the wrong
-- database. Run this ONCE by hand against the Neon chat project, e.g.:
--
--   psql "$CHAT_DATABASE_URL" -f migrations/presence.sql
--
-- After this runs, the function does no DDL on the request path. (For a
-- throwaway/preview DB you may instead set PRESENCE_AUTOMIGRATE=1 to let the
-- first request create the table.)

CREATE TABLE IF NOT EXISTS player_presence (
  profile_id text PRIMARY KEY,
  last_seen  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS player_presence_last_seen ON player_presence (last_seen);
