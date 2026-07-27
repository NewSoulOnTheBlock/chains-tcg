-- 0002_core.sql
-- Profiles and decks.
--
-- Two UNIQUE constraints here are security controls, not tidiness:
--   unique (address, chain)  — one wallet is exactly one profile, so a second
--                              sign-in cannot mint a duplicate identity.
--   display_name citext unique — case-insensitive, so display names cannot be
--                              used to impersonate another player.

CREATE TABLE core.profiles (
    id           bigserial   PRIMARY KEY,
    address      text        NOT NULL,
    chain        text        NOT NULL,
    display_name citext      NOT NULL UNIQUE,
    avatar_url   text,
    bio          text,
    wins         int         NOT NULL DEFAULT 0,
    losses       int         NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (address, chain)
);

COMMENT ON COLUMN core.profiles.address IS
    'Normalised wallet address. EVM stored lowercase; Solana base58 verbatim (case-sensitive).';
COMMENT ON COLUMN core.profiles.chain IS
    'Chain slug: solana | ethereum | base | arbitrum | polygon.';
COMMENT ON TABLE core.profiles IS
    'Wallet addresses in this table are NEVER included in public listings (audit finding H-2).';

CREATE INDEX profiles_chain_idx ON core.profiles (chain);
CREATE INDEX profiles_wins_idx  ON core.profiles (wins DESC, id);

CREATE TABLE core.decks (
    id         bigserial   PRIMARY KEY,
    profile_id bigint      NOT NULL REFERENCES core.profiles(id) ON DELETE CASCADE,
    name       text        NOT NULL,
    cards      jsonb       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX decks_profile_idx ON core.decks (profile_id);

-- One deck name per owner. Prevents a client-supplied name silently
-- overwriting or duplicating another of the caller's decks.
CREATE UNIQUE INDEX decks_profile_name_uniq ON core.decks (profile_id, lower(name));
