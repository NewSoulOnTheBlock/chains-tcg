-- 0004_game.sql
-- Matches and their authoritative outcomes.
--
-- `game.match_results` is the ONLY input the wager service accepts when
-- deciding a payout (audit finding C-1). It is written by the game service from
-- its own state when a match ends, never from an inbound HTTP body, and carries
-- an HMAC over the row so the wager service can verify provenance.
--
-- `match_id` is the PRIMARY KEY, so a match can produce exactly one result,
-- once, forever — a second "the match ended" write is a constraint violation
-- rather than a second payout.

CREATE TABLE game.matches (
    id            text        PRIMARY KEY,
    mode          text        NOT NULL,
    wager_id      text,
    seat0_profile bigint      REFERENCES core.profiles(id),
    seat1_profile bigint      REFERENCES core.profiles(id),
    status        text        NOT NULL CHECK (status IN ('open', 'live', 'finished', 'void')),
    unlisted      boolean     NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE game.matches IS
    'Public listings expose seat counts and display names only — never setupData, deck lists or wallet addresses (H-7, H-2).';

CREATE INDEX matches_status_idx ON game.matches (status, created_at DESC);
CREATE INDEX matches_seat0_idx  ON game.matches (seat0_profile);
CREATE INDEX matches_seat1_idx  ON game.matches (seat1_profile);

-- One escrow funds one match. Without this, two matches could both claim the
-- same wager and both be settled from it.
CREATE UNIQUE INDEX matches_wager_uniq ON game.matches (wager_id) WHERE wager_id IS NOT NULL;

CREATE TABLE game.match_results (
    match_id    text        PRIMARY KEY REFERENCES game.matches(id),
    winner_seat smallint    CHECK (winner_seat IN (0, 1)),
    reason      text        NOT NULL,
    finished_at timestamptz NOT NULL DEFAULT now(),
    server_sig  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN game.match_results.winner_seat IS
    'NULL means a draw.';
COMMENT ON COLUMN game.match_results.reason IS
    'How the match ended: life | deckout | concede | timeout. Left unconstrained so the game service can add outcomes without a migration.';
COMMENT ON COLUMN game.match_results.server_sig IS
    'HMAC over (match_id, winner_seat, reason, finished_at) using the game service key. The wager service verifies this before paying.';

CREATE INDEX match_results_finished_idx ON game.match_results (finished_at);
