-- Chains TCG — initial schema. Executed once by the postgres container on
-- first boot (docker-entrypoint-initdb.d). Idempotent so it can also be run
-- manually against an existing database.

CREATE TABLE IF NOT EXISTS profiles (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  wins        int NOT NULL DEFAULT 0,
  losses      int NOT NULL DEFAULT 0,
  avatar_url  text,
  bio         text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Columns added after the first release — kept here (and mirrored by the
-- profile service's startup ensure-schema step) so existing volumes pick
-- them up without a re-init.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio text;

-- Case-insensitive uniqueness on name ("Alice" and "alice" are one profile).
CREATE UNIQUE INDEX IF NOT EXISTS profiles_name_lower_idx ON profiles (lower(name));

CREATE TABLE IF NOT EXISTS decks (
  id          serial PRIMARY KEY,
  profile_id  int NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name        text NOT NULL DEFAULT 'Untitled Deck',
  cards       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS decks_profile_id_idx ON decks (profile_id);

CREATE TABLE IF NOT EXISTS matches (
  id          serial PRIMARY KEY,
  winner_id   int REFERENCES profiles(id) ON DELETE SET NULL,
  loser_id    int REFERENCES profiles(id) ON DELETE SET NULL,
  mode        text NOT NULL DEFAULT 'casual',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS matches_winner_id_idx ON matches (winner_id);
CREATE INDEX IF NOT EXISTS matches_loser_id_idx  ON matches (loser_id);
CREATE INDEX IF NOT EXISTS matches_created_at_idx ON matches (created_at DESC);

-- Leaderboard reads sort by wins.
CREATE INDEX IF NOT EXISTS profiles_wins_idx ON profiles (wins DESC);
