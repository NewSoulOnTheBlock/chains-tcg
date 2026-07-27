-- 0001_schemas.sql
-- Extensions and the one-schema-per-service layout.
--
-- `citext` exists for `core.profiles.display_name`: the uniqueness of a display
-- name must be case-insensitive, otherwise "Alice" and "alice" are two accounts
-- and impersonation is free.

CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS game;
CREATE SCHEMA IF NOT EXISTS wager;

COMMENT ON SCHEMA auth  IS 'auth service: nonces and refresh-token sessions';
COMMENT ON SCHEMA core  IS 'profile service: profiles, decks, audit log';
COMMENT ON SCHEMA game  IS 'game service: matches and authoritative match results';
COMMENT ON SCHEMA wager IS 'wager service: escrows, deposits, payouts, boosters';
