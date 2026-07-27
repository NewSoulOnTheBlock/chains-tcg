-- 0010_card_ownership.sql
-- Move card ownership out of the player's browser and into the database.
--
-- ── Why this exists ────────────────────────────────────────────────────────
-- Until this file, ownership of a card was a string in the player's own
-- localStorage:
--
--     ocva.collection.<name>  ->  {"node_sol": 20, ...}
--
-- That is not a weak control, it is the absence of one. The client runs on the
-- player's machine, so "which cards do I own" was answered by the attacker.
-- Two devtools lines granted the entire catalogue, and nothing server-side
-- could contradict it: `wager.redemptions.card_ids` records that a redemption
-- handed out some card ids, but never that a profile *holds* them, so there was
-- no query that could even be asked.
--
-- Ranked play has a prize attached. That inverts the economics of the whole
-- product: editing one localStorage value pays better than playing, which makes
-- this the highest-value attack surface in the backend. See ROADMAP-ownership.md.
--
-- After this migration the browser copy still exists, but it is demoted to a
-- display cache — something the client may render, never something the server
-- reads back as an input to a decision. That is the same C-3 shape as 0008's
-- active-deck pointer: the server re-derives the fact instead of being told it.
--
-- ── Why `core` and not `wager` ─────────────────────────────────────────────
-- Two services touch this table from opposite sides: wager writes it when a
-- booster is redeemed, game reads it when seating a ranked match. A collection
-- belongs to the profile, alongside `core.profiles` and `core.decks`, the same
-- way a deck does. Putting it in `wager` would make the game service reach into
-- the money schema to answer a question that has nothing to do with money.

-- ── The table ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.card_ownership (
    profile_id bigint      NOT NULL REFERENCES core.profiles(id) ON DELETE CASCADE,
    card_id    text        NOT NULL,
    qty        int         NOT NULL CHECK (qty >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, card_id)
);

-- ── Why the primary key is (profile_id, card_id) ───────────────────────────
-- This composite key is the concurrency control, not a lookup convenience.
-- Granting one more copy of a card is:
--
--     INSERT INTO core.card_ownership (profile_id, card_id, qty)
--     VALUES ($1, $2, 1)
--     ON CONFLICT (profile_id, card_id)
--       DO UPDATE SET qty = core.card_ownership.qty + 1, updated_at = now();
--
-- ON CONFLICT needs a unique index to arbitrate against; this key is it. With
-- it, two redemptions landing in the same millisecond serialise on the row and
-- both increments survive. Without it the only way to write is read-modify-
-- write, where both transactions read 3, both write 4, and one card the player
-- paid for silently evaporates — the same lost-update bug 0007 removed from
-- ticket numbering by replacing MAX(ticket_number)+1 with a locked counter.
--
-- The database is the security control here, exactly as with
-- `deposits.signature PRIMARY KEY` (C-2) and `redemptions (ticket_number, kind)`.
-- Application-level "check then insert" is not an alternative, it is the bug.

-- ── Why card_id is text with no foreign key ────────────────────────────────
-- The card catalogue lives in code (`src/cards.ts`), not in a table, and it is
-- deployed with the client. A foreign key would require mirroring the whole
-- catalogue into the database and keeping the two in lockstep on every card
-- release. The integrity that actually matters runs the other way: an unknown
-- card_id here grants nothing, because seating checks the deck's cards against
-- this table, and a card nobody can put in a deck can never be seated. Rows are
-- written only from a server-side pool (BOOSTER_CARD_POOL), never from a
-- request body.

-- ── Why qty >= 0 and not qty > 0 ───────────────────────────────────────────
-- Zero is a meaningful state: "this profile held this card and no longer does".
-- Keeping the row preserves updated_at as an audit breadcrumb and keeps the
-- upsert above total — it never has to decide between INSERT and DELETE.
--
-- The consequence is a rule for every reader: ownership is `qty > 0`, never
-- `EXISTS (...)`. A row's existence proves history, not possession. The CHECK
-- is the backstop for the spend/burn path that does not exist yet, so that the
-- first bug in it fails loudly at the constraint instead of quietly minting a
-- negative balance that a later increment would launder back into positive.

-- ── The index ──────────────────────────────────────────────────────────────
-- Note for future readers: this is redundant. The primary key already builds a
-- btree on (profile_id, card_id), and Postgres uses a leading-column prefix of
-- a composite index for `WHERE profile_id = $1`, which is the whole-collection
-- read. It is created because it is part of the agreed table contract that the
-- wager and game services were written against. It costs one small index's
-- worth of writes and nothing else. If it is ever dropped, do it in a new
-- migration and expect no plan change.
CREATE INDEX IF NOT EXISTS card_ownership_profile_idx
    ON core.card_ownership (profile_id);

-- ── Documentation ──────────────────────────────────────────────────────────
COMMENT ON TABLE core.card_ownership IS
    'Authoritative record of which profile holds which cards. The browser''s localStorage collection is a display cache only and is never read back as an input to a server decision. Written by the wager service inside the redemption transaction; read by the game service when seating a ranked match.';

COMMENT ON COLUMN core.card_ownership.profile_id IS
    'Owner. ON DELETE CASCADE: a deleted profile takes its collection with it, the same as its decks (0002_core).';
COMMENT ON COLUMN core.card_ownership.card_id IS
    'Card id from the catalogue in src/cards.ts. Deliberately unconstrained by a foreign key — the catalogue is code, not a table. Basic Nodes are granted to every player implicitly and are not expected to appear here.';
COMMENT ON COLUMN core.card_ownership.qty IS
    'Copies held. Ownership is qty > 0 — a row with qty = 0 records that the profile once held this card, not that it holds it now. Incremented by an ON CONFLICT upsert so concurrent grants cannot lose a copy.';
COMMENT ON COLUMN core.card_ownership.updated_at IS
    'Last grant or spend. Maintained by the upsert (DO UPDATE SET updated_at = now()), not by a trigger — a writer that forgets it leaves a stale timestamp, not a wrong quantity.';

-- ── Grants: there are none, and that is correct ────────────────────────────
-- Do not go looking for a missing GRANT for this table. This backend has no
-- per-service database roles. Every service — auth, profile, game, wager,
-- rpc-proxy — and the migration runner itself connect with the single role from
-- POSTGRES_USER (default `chains`, the database owner created by initdb), via
-- the one DATABASE_URL defined in the `x-service-env` anchor in
-- docker-compose.yml. No migration from 0001 to 0009 issues CREATE ROLE, GRANT
-- or REVOKE, and this one continues that.
--
-- So the "wager writes, game only reads" split described in ROADMAP-ownership.md
-- is a convention enforced by code review and by which service owns which
-- route — not by the database. Isolating it properly means creating per-service
-- roles for every table at once, in its own migration, plus a DATABASE_URL per
-- service in compose. That is a worthwhile piece of hardening and it is
-- deliberately not smuggled in here: granting privileges on one table while the
-- other twenty stay open to everyone buys no security and hides the fact that
-- the boundary does not exist.
