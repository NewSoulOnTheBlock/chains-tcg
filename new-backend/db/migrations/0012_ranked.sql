-- 0012_ranked.sql
-- The ranked ladder: seasons, per-season rating, the MMR queue, and a per-match
-- rating audit row.
--
-- ── Where this came from ───────────────────────────────────────────────────
-- A working ladder already existed in `src/ranked/` on the legacy Koa server:
-- Glicko-2, eight tiers of four divisions, placements, a soft season reset, an
-- MMR queue with a widening window. The algorithms were fine. The two things
-- that could not come with them were the trust model and the schema, and both
-- of those are this file.
--
-- ══════════════════════════════════════════════════════════════════════════
-- (a) Identity is `core.profiles.id`, never a display name
-- ══════════════════════════════════════════════════════════════════════════
--
-- The legacy schema keyed every ranked table on `player_id TEXT`, and its own
-- type declaration admitted what that was:
--
--     playerId: string;   // we use the existing profile name as id
--
-- `core.profiles.display_name` is MUTABLE — the profile service exposes
-- `PATCH /api/profiles/me`, and a rename is a normal, supported action. Under
-- the legacy key, renaming detached a player from their entire ranked history
-- in complete silence: the ladder row, the queue entry and every recorded match
-- still named the old string, so the player appeared as a brand-new account at
-- 1500 and their old row sat on the leaderboard with nobody behind it. No error
-- is raised anywhere on that path, which is what makes it dangerous — the first
-- symptom is a support ticket about a lost rank, months later, with no way to
-- reconstruct which row belonged to whom.
--
-- That exact bug has already bitten this codebase once, in the client-side
-- collection cache keyed `ocva.collection.<name>`. It is not hypothetical.
--
-- So every table here keys on `core.profiles(id) bigint`, which is a bigserial
-- and never changes, with ON DELETE CASCADE wherever the profile genuinely owns
-- the row (its ladder standing, its queue entry). The audit row in
-- `ranked_match_ratings` is the one exception and says why below.
--
-- ══════════════════════════════════════════════════════════════════════════
-- (b) Why these tables live in `game` and not `core`
-- ══════════════════════════════════════════════════════════════════════════
--
-- 0010 put `core.card_ownership` in `core` because two services write and read
-- it from opposite sides, and because a collection belongs to a profile the
-- same way a deck does. Neither applies here. Rating is produced by exactly one
-- writer — the game service's authoritative result path — and consumed by the
-- game service's own ladder routes. Nothing in `profile` or `wager` touches it.
-- `GET /api/leaderboard` on the profile service stays what it is: a wins-ordered
-- list with no rating in it, unaffected by this file.
--
-- ══════════════════════════════════════════════════════════════════════════
-- (c) No table is created by a service at boot
-- ══════════════════════════════════════════════════════════════════════════
--
-- The legacy subsystem shipped an `initRankedSchema()` that ran
-- `CREATE TABLE IF NOT EXISTS` on every boot. This backend forbids that
-- (ARCHITECTURE.md § Database): schema comes from `db/migrations/` only, applied
-- by the one-shot `migrate` job that must exit 0 before any service starts. The
-- ported code has no DDL in it at all.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. Seasons
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS game.ranked_seasons (
    id                 text        PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    name               text        NOT NULL,
    started_at         timestamptz NOT NULL DEFAULT now(),
    ends_at            timestamptz NOT NULL,
    active             boolean     NOT NULL DEFAULT false,
    soft_reset_factor  double precision NOT NULL DEFAULT 0.5
                       CHECK (soft_reset_factor >= 0 AND soft_reset_factor <= 1),
    reward_definitions jsonb,
    balance_patch      text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > started_at)
);

-- ── "Exactly one active season" is a constraint, not a convention ──────────
-- The legacy code enforced this with `UPDATE ranked_seasons SET active = (id = $1)`
-- from application code, which is only correct if nothing else is writing at the
-- same time. The game service runs as N containers behind the gateway, each with
-- its own matchmaker tick calling `ensureActiveSeason()`; two of them bootstrapping
-- concurrently is the normal case at a rolling deploy, not an edge case.
--
-- With this index the loser of that race gets a 23505 and re-reads, so the worst
-- outcome is a retry. Without it, two seasons are active, `WHERE active LIMIT 1`
-- returns whichever the plan reached first, and two players in the same match can
-- have their ratings written into different seasons.
--
-- `((true))` is the idiom for "at most one row satisfying the predicate": the
-- index has a single constant key, so any second `active` row collides.
CREATE UNIQUE INDEX IF NOT EXISTS ranked_seasons_one_active
    ON game.ranked_seasons ((true)) WHERE active;

-- Result recording resolves the season from the match's `finished_at`, not from
-- whichever season happens to be active at the moment the sweeper runs. A match
-- played inside a season belongs to that season even if it is recorded after the
-- rollover — which is exactly what happens to the last few matches of a season,
-- every season.
CREATE INDEX IF NOT EXISTS ranked_seasons_window_idx
    ON game.ranked_seasons (started_at DESC, ends_at DESC);

COMMENT ON TABLE game.ranked_seasons IS
    'Ladder seasons. At most one is active at a time, enforced by ranked_seasons_one_active rather than by application code.';
COMMENT ON COLUMN game.ranked_seasons.soft_reset_factor IS
    'Carry-over into the NEXT season: newRating = 1500 + (oldRating - 1500) * factor. 0 = hard reset, 1 = no reset. Read from the season being left, not the season being entered.';
COMMENT ON COLUMN game.ranked_seasons.reward_definitions IS
    'Opaque JSON describing end-of-season rewards. Cosmetic and prize copy only — nothing in this backend pays out from it, and no code branches on its contents.';
COMMENT ON COLUMN game.ranked_seasons.balance_patch IS
    'Free-text marker for the card-balance revision this season ran under. Informational.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. Ladder standing, one row per profile PER SEASON
-- ══════════════════════════════════════════════════════════════════════════
--
-- ── Why (season_id, profile_id) and not just profile_id ────────────────────
-- The legacy table was keyed on the player alone, with `season_id` as an
-- ordinary column, and the season rollover was a loop that UPDATEd every row in
-- place: rating soft-reset, tier back to Bronze IV, placements back to 10,
-- season_id repointed. Its own comment said "archive standings" — nothing did.
-- The instant the rollover ran, the previous season's final ladder ceased to
-- exist. For a season with a prize attached, that is the one row you most need
-- to still be able to produce afterwards.
--
-- Keying per season makes the rollover an INSERT instead of a destructive UPDATE
-- over every account, so:
--   • last season's standings are still queryable, forever;
--   • a rollover is O(1) work, not O(players) inside a request path;
--   • the soft reset happens lazily, as the seeding expression on the first row
--     a player earns in the new season, so a player who never returns costs
--     nothing and a player who does gets the same number they would have got.
CREATE TABLE IF NOT EXISTS game.ranked_profiles (
    season_id            text        NOT NULL REFERENCES game.ranked_seasons(id) ON DELETE CASCADE,
    profile_id           bigint      NOT NULL REFERENCES core.profiles(id)       ON DELETE CASCADE,

    -- Hidden Glicko-2 state. Never served to a client.
    rating               double precision NOT NULL DEFAULT 1500,
    rating_deviation     double precision NOT NULL DEFAULT 350  CHECK (rating_deviation > 0),
    volatility           double precision NOT NULL DEFAULT 0.06 CHECK (volatility > 0),

    -- Visible ladder position.
    tier                 smallint    NOT NULL DEFAULT 0 CHECK (tier BETWEEN 0 AND 7),
    division             smallint    NOT NULL DEFAULT 4 CHECK (division BETWEEN 1 AND 4),
    lp                   integer     NOT NULL DEFAULT 0 CHECK (lp >= 0),

    wins                 integer     NOT NULL DEFAULT 0 CHECK (wins   >= 0),
    losses               integer     NOT NULL DEFAULT 0 CHECK (losses >= 0),
    draws                integer     NOT NULL DEFAULT 0 CHECK (draws  >= 0),
    placements_remaining smallint    NOT NULL DEFAULT 10 CHECK (placements_remaining BETWEEN 0 AND 50),

    -- Anti-smurf output. Recorded, deliberately not acted on — see below.
    smurf_flagged        boolean     NOT NULL DEFAULT false,
    smurf_reasons        jsonb,
    mmr_multiplier       double precision NOT NULL DEFAULT 1.0
                         CHECK (mmr_multiplier >= 1.0 AND mmr_multiplier <= 2.0),

    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),

    -- Mythic (tier 7) is a single unbounded pool with no divisions; every other
    -- tier is four divisions of 0-100 LP. Spelling that out here means the
    -- ladder arithmetic in ranks.ts cannot write a position the schema would
    -- consider impossible without the write failing loudly.
    CHECK (tier < 7 OR division = 1),
    CHECK (tier = 7 OR lp <= 100),

    -- ── The generated ordinal ─────────────────────────────────────────────
    -- A single integer where higher is strictly better, so the leaderboard can
    -- be ordered by the ladder the client actually SEES.
    --
    -- The legacy leaderboard ordered by hidden MMR and then stripped hidden MMR
    -- from the response, so the list was sorted by a column that was not in it:
    -- two players could be shown as Gold II / 40 LP and Gold II / 60 LP with the
    -- 40 above the 60, and no visible field explained it. On a ladder with a
    -- prize on rank 1, "why am I below them" has to be answerable from the
    -- response.
    --
    -- GENERATED ... STORED, not a column the writer maintains: Postgres computes
    -- it from tier/division/lp on every write, so it is incapable of drifting out
    -- of step with them. It matches `ordinalOf()` in ranks.ts exactly, including
    -- the Mythic special case (Mythic has no divisions, so its ordinal continues
    -- straight on above the top of Grandmaster).
    ladder_ordinal integer GENERATED ALWAYS AS (
        CASE WHEN tier >= 7 THEN 2800 + lp
             ELSE tier * 400 + (4 - division) * 100 + LEAST(lp, 100)
        END
    ) STORED,

    PRIMARY KEY (season_id, profile_id)
);

-- The season leaderboard: visible ladder first, hidden rating only as a
-- tiebreak between identical positions, profile_id last so the order is total
-- and a page boundary cannot show or skip a row.
CREATE INDEX IF NOT EXISTS ranked_profiles_standings_idx
    ON game.ranked_profiles (season_id, ladder_ordinal DESC, rating DESC, profile_id);

-- "Show me this player's ladder history" and the previous-season lookup that
-- seeds the soft reset.
CREATE INDEX IF NOT EXISTS ranked_profiles_profile_idx
    ON game.ranked_profiles (profile_id);

COMMENT ON TABLE game.ranked_profiles IS
    'One ladder standing per profile per season. Keyed on core.profiles(id): display names are mutable and keying on one would silently orphan a player''s ranked history at the first rename.';
COMMENT ON COLUMN game.ranked_profiles.rating IS
    'Hidden Glicko-2 rating (display scale, 1500 start). NEVER serialised to a client — the ladder shows tier/division/LP, and exposing the rating would turn every matchmaking decision into a readable number players optimise against.';
COMMENT ON COLUMN game.ranked_profiles.rating_deviation IS
    'Glicko-2 RD. Starts at 350 so a new account converges in roughly ten games, and widens by 50 (capped at 350) across a season boundary because the system has less recent evidence. This is the calibrated version of "let a strong new player climb fast".';
COMMENT ON COLUMN game.ranked_profiles.volatility IS
    'Glicko-2 sigma. Rises when results are erratic, which widens future RD.';
COMMENT ON COLUMN game.ranked_profiles.tier IS
    'Visible tier INDEX, 0-7 = Bronze, Silver, Gold, Platinum, Diamond, Master, Grandmaster, Mythic. Stored as a smallint rather than the name so ladder_ordinal can be arithmetic and so renaming a tier is a code change, not a data migration.';
COMMENT ON COLUMN game.ranked_profiles.division IS
    'IV (4, lowest) to I (1, highest). Forced to 1 for Mythic, which has no divisions.';
COMMENT ON COLUMN game.ranked_profiles.lp IS
    'Ladder points inside the current division, 0-100. Unbounded above 100 for Mythic only, which is how the top of the ladder stays ordered once everyone there is at the ceiling.';
COMMENT ON COLUMN game.ranked_profiles.ladder_ordinal IS
    'Generated: a total order over the VISIBLE ladder, higher is better. The leaderboard orders by this so the list is sorted by fields the response actually contains.';
COMMENT ON COLUMN game.ranked_profiles.placements_remaining IS
    'Rated games left before a visible rank is assigned. The rank is withheld until this reaches 0, then snapped from the hidden rating.';
COMMENT ON COLUMN game.ranked_profiles.smurf_flagged IS
    'Anti-smurf heuristics fired for this account. RECORDED ONLY — nothing in the rating path reads it. See mmr_multiplier.';
COMMENT ON COLUMN game.ranked_profiles.smurf_reasons IS
    'Human-readable strings explaining why smurf_flagged is set, for an operator to look at. Never served to the flagged player.';
COMMENT ON COLUMN game.ranked_profiles.mmr_multiplier IS
    'Legacy anti-smurf lever, deliberately pinned to 1.0. The legacy service multiplied the winner''s Glicko delta by up to 2.0, which breaks the algorithm in two ways: the update is no longer the calibrated estimate the RD and volatility describe, and the exchange stops being zero-sum, so the rating pool inflates by the excess on every flagged win. The column stays so the decision is visible and reversible in one place, with the CHECK bounding any future experiment.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. The matchmaking queue
-- ══════════════════════════════════════════════════════════════════════════
--
-- One row per queued profile. The primary key IS the "you cannot be in the
-- queue twice" rule; the legacy version relied on an application-level upsert
-- for the same thing, which is only as good as every future caller remembering.
CREATE TABLE IF NOT EXISTS game.ranked_queue (
    profile_id bigint      PRIMARY KEY REFERENCES core.profiles(id) ON DELETE CASCADE,
    season_id  text        NOT NULL    REFERENCES game.ranked_seasons(id) ON DELETE CASCADE,

    -- ── Why a deck_id and not a decklist ──────────────────────────────────
    -- The legacy queue stored `selected_deck_id TEXT`, which despite the name
    -- held a JSON-stringified array of card ids, taken from the request body.
    -- That is the C-3 pattern in full: the client chose what it was playing, the
    -- server wrote it down, and the pairer seated it. Here the column is a
    -- foreign key to `core.decks`, the row is written from the caller's ACTIVE
    -- deck resolved server-side, and the pairer re-reads the deck's contents at
    -- pairing time rather than trusting the snapshot — `core.decks.cards` stays
    -- editable while a player sits in the queue, exactly as it does while a
    -- match sits open in the lobby (see routes/lobby.ts on seat 0).
    deck_id    bigint      NOT NULL    REFERENCES core.decks(id) ON DELETE CASCADE,

    rating     double precision NOT NULL,
    region     text        NOT NULL DEFAULT 'global',
    queued_at  timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The pairer's only two access patterns: take the longest-waiting entry in a
-- region, then find the nearest rating to it.
CREATE INDEX IF NOT EXISTS ranked_queue_region_wait_idx
    ON game.ranked_queue (region, queued_at);
CREATE INDEX IF NOT EXISTS ranked_queue_region_rating_idx
    ON game.ranked_queue (region, rating);

COMMENT ON TABLE game.ranked_queue IS
    'Live matchmaking queue. Claimed with SELECT ... FOR UPDATE SKIP LOCKED so any number of game containers can pair concurrently without ever handing the same player to two matches.';
COMMENT ON COLUMN game.ranked_queue.deck_id IS
    'The caller''s active deck at enqueue time, resolved server-side. Pins WHICH deck, not its contents — the pairer re-validates legality and card ownership against core.decks/core.card_ownership as they stand at pairing time.';
COMMENT ON COLUMN game.ranked_queue.rating IS
    'Copy of the hidden rating, so the pairer can bracket without joining ranked_profiles on every tick. Refreshed on every enqueue; a stale copy costs at most one slightly-off pairing.';
COMMENT ON COLUMN game.ranked_queue.region IS
    'Advisory shard. The pairer only ever pairs within one region, so a client that invents a region strands itself — the accepted set is fixed by a zod enum on the route, and the default is the single shared pool.';
COMMENT ON COLUMN game.ranked_queue.queued_at IS
    'Preserved across a repeated enqueue, so re-joining does not reset the widening MMR window a player has already waited for.';

-- ══════════════════════════════════════════════════════════════════════════
-- 4. Per-match rating audit
-- ══════════════════════════════════════════════════════════════════════════
--
-- Written in the SAME transaction as `game.match_results`, immediately after the
-- INSERT ... ON CONFLICT DO NOTHING reports a row — which is precisely the
-- moment "this result is being recorded for the first time". That is where the
-- exactly-once property comes from, and it is the same guarantee the
-- `core.profiles.wins/losses` counters already ride on. There is no second
-- mechanism to get wrong.
--
-- `match_id` as the primary key is the belt to that braces: even a caller who
-- reached this table by some other path can only produce one rating event per
-- match, forever.
CREATE TABLE IF NOT EXISTS game.ranked_match_ratings (
    match_id             text        PRIMARY KEY REFERENCES game.matches(id) ON DELETE CASCADE,
    season_id            text        NOT NULL    REFERENCES game.ranked_seasons(id),

    -- ON DELETE SET NULL, not CASCADE: the profile does not own this row, the
    -- MATCH does. Deleting a player must not erase their opponent's record of a
    -- game they played and the rating they earned from it.
    seat0_profile        bigint      REFERENCES core.profiles(id) ON DELETE SET NULL,
    seat1_profile        bigint      REFERENCES core.profiles(id) ON DELETE SET NULL,

    winner_seat          smallint    CHECK (winner_seat IN (0, 1)),
    reason               text        NOT NULL,

    seat0_rating_before  double precision NOT NULL,
    seat0_rating_after   double precision NOT NULL,
    seat1_rating_before  double precision NOT NULL,
    seat1_rating_after   double precision NOT NULL,
    seat0_lp_delta       integer     NOT NULL,
    seat1_lp_delta       integer     NOT NULL,
    seat0_ordinal_after  integer     NOT NULL,
    seat1_ordinal_after  integer     NOT NULL,

    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ranked_match_ratings_season_idx
    ON game.ranked_match_ratings (season_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ranked_match_ratings_seat0_idx
    ON game.ranked_match_ratings (seat0_profile, created_at DESC);
CREATE INDEX IF NOT EXISTS ranked_match_ratings_seat1_idx
    ON game.ranked_match_ratings (seat1_profile, created_at DESC);

COMMENT ON TABLE game.ranked_match_ratings IS
    'What one ranked match did to two ratings. Written inside the game.match_results transaction, so it exists if and only if the result was recorded, exactly once. This is also the ladder''s audit trail: every rating a player holds is reconstructible by replaying these rows in order.';
COMMENT ON COLUMN game.ranked_match_ratings.winner_seat IS
    'NULL means a draw, matching game.match_results. A draw is a rated result: Glicko-2 scores it 0.5 for both, so ratings converge slightly and both RDs shrink. It moves no LP and increments neither wins nor losses.';
COMMENT ON COLUMN game.ranked_match_ratings.reason IS
    'Copied from game.match_results: life | deckout | concede | timeout. Every one of them is rated identically. A reason that dodged rating loss would be an instruction to use it — with a prize attached, "concede or stall to protect your rank" is the exploit, not the edge case.';
COMMENT ON COLUMN game.ranked_match_ratings.seat0_lp_delta IS
    'Visible LP moved for seat 0, already shaped by win expectancy and the placement multiplier. Recorded because the post-game screen must be able to say what happened without recomputing it.';
COMMENT ON COLUMN game.ranked_match_ratings.seat0_ordinal_after IS
    'Seat 0''s ladder_ordinal after this match, so a promotion or demotion is reconstructible from this row alone.';

-- ══════════════════════════════════════════════════════════════════════════
-- 5. What is NOT here
-- ══════════════════════════════════════════════════════════════════════════
--
-- The legacy subsystem also created `ranked_replay` (an append-only move log)
-- and `ranked_telemetry` (a fire-and-forget event firehose). Neither is created
-- here, and that is a decision rather than an oversight:
--
--   • replay — boardgame.io already stores the full, authoritative move log in
--     `bgio."Games"`, written by the master in this process. A second log
--     appended from a separate in-memory buffer would be a strictly worse copy
--     of it: lossy on crash, and able to disagree with the state that actually
--     decided the match. The ladder needs nothing from it.
--
--   • telemetry — the legacy flusher buffered events in process memory and
--     dropped them on any failed write ("flush failed; events lost?" is in the
--     source). The facts the ladder actually needs to be able to answer for —
--     what a match did to two ratings — are in ranked_match_ratings above, in
--     the same transaction as the result, and cannot be lost. Product analytics
--     is a real requirement and deserves a real pipeline, not a Map that empties
--     itself into Postgres every five seconds.
--
-- There is likewise NO table here that a client can write to. Rating changes
-- come from the authoritative result sweeper reading boardgame.io's own stored
-- `ctx.gameover`; no HTTP route in this backend accepts a winner, a rating, or
-- an LP delta, and adding one would undo the whole point of C-1.
