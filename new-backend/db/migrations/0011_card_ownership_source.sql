-- 0011_card_ownership_source.sql
-- Let chain-derived ownership and booster grants coexist, and record when a
-- profile's snapshot was actually taken.
--
-- ── What changed under 0010 ────────────────────────────────────────────────
-- 0010 was written for one writer: a booster redemption, additive, one row per
-- (profile_id, card_id). Since then the primary writer became the CardPack
-- ERC-721 on Robinhood Chain (4663), and the wager service does not add to
-- `core.card_ownership` — it RECONCILES it. Enumerate the address's tokens,
-- upsert what is held, DELETE everything else. That is not an over-reach: the
-- tokens are tradeable, so an additive sync would make "mint, sync, sell, keep
-- playing them" the cheapest exploit in the product.
--
-- Two writers, one destructive, sharing one key. That is this file.

-- ══════════════════════════════════════════════════════════════════════════
-- (a) `source` — a discriminator, so the reconcile can say what it owns
-- ══════════════════════════════════════════════════════════════════════════
--
-- ── The bug this prevents ──────────────────────────────────────────────────
-- Both writers key on (profile_id, card_id). The reconcile's DELETE is
--
--     DELETE FROM core.card_ownership
--      WHERE profile_id = $1 AND NOT (card_id = ANY($2::text[]))
--
-- and `$2` is *the chain's* card list. A card that arrived from a booster is by
-- construction absent from it, so the next sync silently deletes it. The player
-- paid money for that pack. Nothing logs it, nothing errors, and the collection
-- is simply smaller than it was — the exact silent-data-loss shape that 0007
-- removed from ticket numbering and 0010 removed from concurrent grants.
--
-- It has never fired on any deployment, and that is luck plus one deliberate
-- constraint: `BOOSTER_CARD_POOL` is empty and `minter.enabled` is false, so
-- `redeemTicket` cannot reach `grantCards`. That is a configuration keeping a
-- schema bug dormant. Filling the pool — a one-line change that looks like
-- content, not like a migration — would arm it. Fix the schema first so the
-- pool can be filled by somebody who has never read this file.
--
-- ── Why a discriminator and not a second table ─────────────────────────────
-- A `core.booster_card_ownership` alongside `core.card_ownership` would also
-- separate the writers, but it moves the merge into every reader: seating,
-- the collection route, and anything added later would each have to remember to
-- UNION both, and the one that forgets under-reports ownership and locks a
-- legitimate player out of ranked. One table with a discriminator makes the
-- merge a GROUP BY that a reader cannot forget to write, because forgetting it
-- means writing a query that returns duplicate card_ids and fails review.
--
-- The cost is real and stated plainly: every reader must now aggregate.
-- `SELECT qty ... WHERE card_id = ANY(...)` is no longer well-defined — it
-- returns one row per source. See the reader note at the bottom of this file.
ALTER TABLE core.card_ownership
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'chain'
        CHECK (source IN ('chain', 'booster'));

-- ── Why the backfill is 'chain', and why DEFAULT is the whole backfill ─────
-- Every row that exists when this runs was written by `reconcileChainCards`.
-- It cannot have come from the booster path: that path terminates at an empty
-- `BOOSTER_CARD_POOL` with a 503 before it reaches a transaction. So the
-- column DEFAULT is not a convenience here, it is the correct historical
-- answer, and no UPDATE statement is needed. If a future deployment ever ran
-- with a populated pool BEFORE this migration, its booster rows would be
-- mislabelled 'chain' and the next sync would delete them — that ordering is
-- why this file ships before the pool is filled and not after.
--
-- DEFAULT stays on the column rather than being dropped after the backfill.
-- An INSERT that omits `source` is a bug, but it is a bug that should land in
-- the reconcile's own partition rather than fail a NOT NULL at 3am; 'chain' is
-- the conservative landing spot because the reconcile is authoritative over it
-- and will correct it on the next sync. A booster grant that forgot `source`
-- would lose its cards on the next sync, which is why `grantCards` names the
-- column explicitly instead of relying on this.

-- ── The primary key swap ───────────────────────────────────────────────────
-- The PK is the concurrency control, not a lookup convenience (0010 says this
-- at length and it is still true). Widening it to include `source` gives each
-- writer its own arbitration target:
--
--     ON CONFLICT (profile_id, card_id, source) DO UPDATE ...
--
-- so two sources incrementing the same card in the same millisecond serialise
-- on two different rows instead of fighting over one, and neither can see or
-- clobber the other's quantity.
--
-- ── Why this is a DO block ─────────────────────────────────────────────────
-- `ALTER TABLE ... DROP CONSTRAINT` has an IF EXISTS form, but IF EXISTS alone
-- is not enough to make this re-runnable: on a second run the constraint DOES
-- exist — it is just the new three-column one — so a bare DROP would remove the
-- correct key and the following ADD would rebuild it, which is a full index
-- rebuild disguised as a no-op, and leaves a window with no unique index at all
-- for every concurrent upsert to race through.
--
-- So the guard is on the constraint's COLUMN LIST, not on its existence. Three
-- outcomes, all explicit:
--   no PK at all      -> add the three-column one (a repaired table),
--   (profile_id, card_id)          -> swap it,
--   (profile_id, card_id, source)  -> already done, touch nothing,
--   anything else     -> refuse loudly rather than guess. Somebody re-keyed
--                        this table by hand and the reconcile's correctness
--                        depends on knowing exactly what it is upserting into.
DO $$
DECLARE
    pk_name text;
    pk_cols text;
BEGIN
    SELECT c.conname,
           string_agg(a.attname, ',' ORDER BY k.ord)
      INTO pk_name, pk_cols
      FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum   = k.attnum
     WHERE c.conrelid = 'core.card_ownership'::regclass
       AND c.contype  = 'p'
     GROUP BY c.oid, c.conname;

    IF pk_cols IS NULL THEN
        ALTER TABLE core.card_ownership
            ADD CONSTRAINT card_ownership_pkey PRIMARY KEY (profile_id, card_id, source);

    ELSIF pk_cols = 'profile_id,card_id' THEN
        EXECUTE format('ALTER TABLE core.card_ownership DROP CONSTRAINT %I', pk_name);
        ALTER TABLE core.card_ownership
            ADD CONSTRAINT card_ownership_pkey PRIMARY KEY (profile_id, card_id, source);

    ELSIF pk_cols = 'profile_id,card_id,source' THEN
        NULL;  -- second run: nothing to do, and nothing rebuilt

    ELSE
        RAISE EXCEPTION
            'card_ownership_pkey_unexpected: core.card_ownership''s primary key is (%) — expected (profile_id, card_id) to swap or (profile_id, card_id, source) already in place. Refusing to guess: reconcileChainCards() upserts against this exact key and a wrong one loses cards silently.',
            pk_cols;
    END IF;
END $$;

-- ── The old index is still the right one, and still redundant ──────────────
-- `card_ownership_profile_idx` on (profile_id) was already covered by the old
-- PK's leading column and is still covered by the new one. 0010 explains why it
-- exists anyway; nothing here changes that calculus. No new index is added for
-- the aggregate read either: `WHERE profile_id = $1 AND card_id = ANY(...)`
-- with `GROUP BY card_id` is served by the (profile_id, card_id, source) PK
-- index as a two-column prefix scan, and grouping a handful of rows per profile
-- needs no help.

-- ══════════════════════════════════════════════════════════════════════════
-- (b) `core.card_ownership_sync` — block-level sync state
-- ══════════════════════════════════════════════════════════════════════════
--
-- ── The bug this prevents ──────────────────────────────────────────────────
-- Until now `syncedAt` was derived as
--
--     SELECT max(updated_at) FROM core.card_ownership WHERE profile_id = $1
--
-- which is NULL in two completely different situations:
--
--   * the player has never synced — the server knows nothing about their
--     wallet, and the honest answer is "sync your collection";
--   * the player synced and holds nothing — the server knows exactly what they
--     hold, which is nothing.
--
-- One state calls for a prompt, the other for a plain empty collection. Read
-- from the ownership rows they are the same NULL, so the product has to pick
-- one wrong answer for the other case: either nag a player who is correctly
-- empty, or tell a player who has never synced "you own no cards" — which,
-- against a ranked gate they are about to be refused entry by, is the server
-- stating something false about their property.
--
-- A snapshot's existence is a fact about the SYNC, not about the rows it wrote.
-- Zero rows is a perfectly good result. So the fact belongs in its own row,
-- which exists whether or not the sync found anything.
--
-- ── Why block_number, when synced_at already answers "how stale?" ──────────
-- A timestamp answers "how long ago", which is a question about our clock. The
-- chain's clock is the block height, and it is the only one that composes with
-- anything else: a re-org, a lagging RPC endpoint, or a second reader can all
-- be compared against a block number and none of them against `now()`. Seating
-- cannot currently reason about staleness at all; when it needs to ("refuse a
-- ranked seat on a snapshot older than N blocks"), this is the column it reads,
-- and backfilling it later would mean inventing block numbers for existing rows.
--
-- ── Why token_count and not just a count of the rows written ──────────────
-- `token_count` is TOKENS ENUMERATED, before they were folded into per-card
-- quantities. It is the reconciliation handle for a support question: the
-- explorer shows a wallet holding 12 CardPack tokens, this row says 12, and the
-- ownership rows say 9 distinct cards. Those three numbers agreeing is what
-- distinguishes "the sync worked and you own duplicates" from "the enumeration
-- came back short", which the ownership rows alone cannot tell you.
CREATE TABLE IF NOT EXISTS core.card_ownership_sync (
    profile_id   bigint      PRIMARY KEY REFERENCES core.profiles(id) ON DELETE CASCADE,
    address      text        NOT NULL,
    chain_id     int         NOT NULL,
    block_number bigint      NOT NULL,
    token_count  int         NOT NULL,
    synced_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Why one row per profile, replaced in place, and not a history table ────
-- `profile_id` is the whole primary key: this is CURRENT STATE, and the sync
-- that wrote it is the sync that also rewrote the ownership rows. Keeping a row
-- per sync would be a different and useful thing — an audit trail — but it
-- would also make "what is the current snapshot?" a
-- `DISTINCT ON (profile_id) ... ORDER BY synced_at DESC` that every reader has
-- to get right, in exchange for history nothing consumes yet. `core.audit_log`
-- (0006) is where a per-sync trail belongs if one is ever wanted.
--
-- The row is written in the SAME TRANSACTION as the reconcile it describes, so
-- it cannot claim a block whose cards were rolled back, and cards cannot land
-- with no record of where they came from. That is the same rule as the booster
-- path: the grant and the reason for the grant commit together or not at all.

-- ── Documentation ──────────────────────────────────────────────────────────
COMMENT ON TABLE core.card_ownership_sync IS
    'One row per profile whose collection has ever been derived from chain state. Its EXISTENCE is the answer to "has this player ever synced?" — a question core.card_ownership cannot answer, because owning nothing and never having asked both produce zero rows. Written by the wager service inside the same transaction as the reconcile it describes.';

COMMENT ON COLUMN core.card_ownership_sync.profile_id IS
    'Owner, and the entire primary key: this is current state, one snapshot per profile, replaced in place. ON DELETE CASCADE, like the collection it describes.';
COMMENT ON COLUMN core.card_ownership_sync.address IS
    'The CardPack ERC-721 contract the snapshot was derived from, lowercased. NOT the player''s wallet — that is already core.profiles.address and is immutable for a profile, so storing it here would be a copy that can only go stale. The contract is the axis that actually moves: CARD_PACK_ADDRESS is deployment configuration, and repointing it makes every stored snapshot a statement about a different collection.';
COMMENT ON COLUMN core.card_ownership_sync.chain_id IS
    'EIP-155 chain the contract was read on — 4663 (Robinhood Chain) on every current deployment. Stored with the address because a contract address alone does not identify a contract.';
COMMENT ON COLUMN core.card_ownership_sync.block_number IS
    'Head block the enumeration was taken at. Everything in core.card_ownership with source = ''chain'' for this profile is true as of here and says nothing about any later block. bigint, not int: block heights outgrow 2^31.';
COMMENT ON COLUMN core.card_ownership_sync.token_count IS
    'Tokens the address held at block_number, BEFORE folding duplicates into per-card quantities. Reconciles against a block explorer directly; the ownership rows do not, because they are already aggregated.';
COMMENT ON COLUMN core.card_ownership_sync.synced_at IS
    'When the reconcile committed, by our clock. Useful for rate-limiting and for showing a player something human; block_number is the one to compare snapshots with.';

COMMENT ON COLUMN core.card_ownership.source IS
    'Which writer owns this row: ''chain'' (derived from the CardPack ERC-721, authoritative and destructive — the reconcile deletes chain rows the address no longer holds) or ''booster'' (granted by a redemption, additive, never deleted by a sync). Part of the primary key so the two cannot overwrite or delete each other. EVERY READER MUST AGGREGATE: a profile holding 2 copies on chain and 1 from a pack has two rows and owns 3.';

-- ── Restating one line of 0010 that is no longer true ──────────────────────
-- 0010_card_ownership.sql is applied and checksummed; editing it would abort
-- every migration run rather than correct anything, so — as with 0009 §4 and
-- `core.profiles.chain` — the correction is made forward, here.
--
-- 0010's "Why card_id is text with no foreign key" section ends:
--
--     "Rows are written only from a server-side pool (BOOSTER_CARD_POOL), never
--      from a request body."
--
-- That was true when it was written and is not true now. The primary writer is
-- the chain sync, and its card ids come from `cardIdForIndex()` resolving a
-- token's on-chain card index against the manifest in `nft/cardCatalogue.ts`.
--
-- The claim the sentence was actually making — that no card id ever originates
-- in a request body — survives intact, and is now enforced in three places
-- rather than one: the booster pool is server-side configuration, the chain
-- index is read from the contract, and an index outside the manifest throws
-- instead of inventing an id. The rest of that section stands unchanged.
COMMENT ON COLUMN core.card_ownership.card_id IS
    'Card id from the catalogue in src/cards.ts. Deliberately unconstrained by a foreign key — the catalogue is code, not a table. Basic Nodes are granted to every player implicitly and are not expected to appear here. Card ids never originate in a request body: a ''chain'' row''s id comes from cardIdForIndex() resolving the token''s on-chain card index against the manifest (an index outside it throws rather than inventing an id), and a ''booster'' row''s id comes from the server-side BOOSTER_CARD_POOL. This supersedes 0010''s "written only from a server-side pool (BOOSTER_CARD_POOL)", which predates chain-derived ownership.';

-- ── A note for the next reader of core.card_ownership ─────────────────────
-- There can now be MORE THAN ONE ROW per (profile_id, card_id). Any query that
-- selects `qty` without aggregating is wrong, and wrong in the direction that
-- hurts: it returns whichever row the plan happened to reach first, which
-- under-reports a player who owns copies from both sources and refuses them a
-- ranked seat they have paid for twice over. The correct shape is
--
--     SELECT card_id, SUM(qty) AS qty
--       FROM core.card_ownership
--      WHERE profile_id = $1 AND card_id = ANY($2::text[])
--      GROUP BY card_id
--
-- and ownership remains `SUM(qty) > 0`, never `EXISTS (...)` — 0010's rule,
-- unchanged, just summed.
