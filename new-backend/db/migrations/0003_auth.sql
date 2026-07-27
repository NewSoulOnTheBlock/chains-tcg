-- 0003_auth.sql
-- Sign-in challenges and refresh-token sessions.
--
-- `auth.nonces` is the durable audit trail and the second single-use guard;
-- Redis holds the authoritative one (GETDEL). `consumed_at IS NULL` in the
-- UPDATE predicate is what makes a replay fail even if Redis were flushed.
--
-- `auth.sessions.refresh_hash` is UNIQUE and holds a SHA-256 hash, never the
-- token. A database dump therefore contains no usable credential.

CREATE TABLE auth.nonces (
    nonce       text        PRIMARY KEY,
    address     text        NOT NULL,
    chain       text        NOT NULL,
    expires_at  timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE auth.nonces IS
    'Single-use sign-in challenges. Consumed via UPDATE … WHERE consumed_at IS NULL.';

CREATE INDEX nonces_expires_idx ON auth.nonces (expires_at);
CREATE INDEX nonces_address_idx ON auth.nonces (chain, address);

CREATE TABLE auth.sessions (
    id           uuid        PRIMARY KEY,
    profile_id   bigint      NOT NULL REFERENCES core.profiles(id) ON DELETE CASCADE,
    refresh_hash text        NOT NULL UNIQUE,
    family_id    uuid        NOT NULL,
    revoked_at   timestamptz,
    expires_at   timestamptz NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN auth.sessions.refresh_hash IS
    'sha256(refresh token), hex. UNIQUE — the token itself is never stored.';
COMMENT ON COLUMN auth.sessions.family_id IS
    'Rotation chain. Presenting an already-revoked token revokes the whole family (reuse detection).';

CREATE INDEX sessions_family_idx  ON auth.sessions (family_id);
CREATE INDEX sessions_profile_idx ON auth.sessions (profile_id);
CREATE INDEX sessions_expires_idx ON auth.sessions (expires_at) WHERE revoked_at IS NULL;
