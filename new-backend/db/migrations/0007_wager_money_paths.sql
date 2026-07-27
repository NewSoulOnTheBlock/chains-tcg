-- 0007_wager_money_paths.sql
--
-- Everything the wager service needs on top of 0005_wager.sql, and nothing that
-- 0005 or 0006 already created. This backend is EVM-only; the Solana custodial
-- path the previous server used has been removed entirely.
--
-- 0005 already gives us the constraints that close C-2 —
-- `deposits.signature PRIMARY KEY` and `deposits UNIQUE (escrow_id, seat)` —
-- plus `payouts.escrow_id PRIMARY KEY`, `payouts.tx_sig UNIQUE` and
-- `booster_intents.payment_sig PRIMARY KEY`. Those are untouched.
--
-- What is added, and why:
--
--   escrows.match_id         one escrow per match, enforced from the wager side.
--                            0004 has `game.matches.wager_id` UNIQUE; this is
--                            the same invariant expressed where the wager
--                            service can enforce it without writing to the game
--                            service's table.
--   escrows.deposit_address  the address a deposit for THIS escrow must credit,
--                            frozen at creation. Rotating the escrow key can
--                            therefore never redefine what an existing escrow
--                            accepts — and it is the hook a per-escrow deposit
--                            vault slots into later without a code change.
--   deposits.from_address    the wallet that actually paid. Refunds and winnings
--                            go back here, never to an address from a request or
--                            re-derived from a profile row.
--   deposits.block_*         the on-chain facts we verified, kept for audit.
--   payouts.*                the exactly-once state machine: one DECISION per
--                            escrow, with `tx_sig` nullable because a decision
--                            now exists before any transaction does.
--   payout_legs              one TRANSACTION per recipient. EVM has no batching
--                            primitive without a deployed contract, so a draw
--                            refund is two transfers. Each leg keeps its own
--                            hash and — critically — its own NONCE for life, so
--                            a replacement and its original are mutually
--                            exclusive by consensus rule.
--   booster_offers           server-issued purchase intents (nonce, exact price,
--                            expiry) so a payment binds to one intent instead of
--                            "any historical transfer to the treasury".
--   booster_counter          ticket numbering under FOR UPDATE, never MAX+1,
--                            with the supply cap enforced in the same
--                            transaction as the reservation.
--   redemptions / shipping   one redemption of each kind per ticket, and the
--                            personal data hanging off the redemption.

-- ── escrows ──────────────────────────────────────────────────────────────────
ALTER TABLE wager.escrows
    ADD COLUMN match_id        text NOT NULL,
    ADD COLUMN deposit_address text NOT NULL;

ALTER TABLE wager.escrows
    ADD CONSTRAINT escrows_match_uniq UNIQUE (match_id),
    ADD CONSTRAINT escrows_match_fk FOREIGN KEY (match_id) REFERENCES game.matches(id);

COMMENT ON COLUMN wager.escrows.match_id IS
    'The match this escrow funds. UNIQUE: two matches can never share one pot.';
COMMENT ON COLUMN wager.escrows.token IS
    'ERC-20 contract address, lower-case.';
COMMENT ON COLUMN wager.escrows.deposit_address IS
    'Address a deposit must credit, lower-case, frozen when the escrow is created.';

-- ── deposits ─────────────────────────────────────────────────────────────────
-- `signature` (0005) holds the EVM transaction hash. The name is kept so the
-- primary key that closes C-2 is not dropped and recreated.
ALTER TABLE wager.deposits
    ADD COLUMN from_address text NOT NULL,
    ADD COLUMN block_number bigint,
    ADD COLUMN block_time   timestamptz,
    ADD COLUMN log_index    int;

COMMENT ON COLUMN wager.deposits.signature IS
    'EVM transaction hash, lower-case. GLOBAL primary key: a replay against any other escrow or seat violates it (C-2).';
COMMENT ON COLUMN wager.deposits.from_address IS
    'Wallet that funded this seat, taken from req.auth and verified against the ERC-20 Transfer log. Refunds and payouts are sent here.';

-- ── payouts ──────────────────────────────────────────────────────────────────
-- 0005 modelled a payout as a fact ("this escrow was paid with this tx"). The
-- exactly-once protocol needs it to be a CLAIM that exists before the payment
-- does, so tx_sig and paid_at become nullable and a status column is added.
ALTER TABLE wager.payouts
    ALTER COLUMN tx_sig  DROP NOT NULL,
    ALTER COLUMN paid_at DROP NOT NULL,
    ALTER COLUMN paid_at DROP DEFAULT;

ALTER TABLE wager.payouts
    ADD COLUMN kind text NOT NULL DEFAULT 'winner'
        CHECK (kind IN ('winner', 'draw_refund', 'partial_refund', 'void_refund', 'noop')),
    ADD COLUMN winner_seat smallint CHECK (winner_seat IN (0, 1)),
    ADD COLUMN amount_base bigint NOT NULL DEFAULT 0 CHECK (amount_base >= 0),
    ADD COLUMN burn_base   bigint NOT NULL DEFAULT 0 CHECK (burn_base >= 0),
    ADD COLUMN status text NOT NULL DEFAULT 'preparing'
        CHECK (status IN ('preparing', 'sending', 'paid', 'failed')),
    ADD COLUMN idempotency_key text NOT NULL,
    ADD COLUMN attempts int NOT NULL DEFAULT 0,
    ADD COLUMN last_error text,
    ADD COLUMN lease_until timestamptz;

ALTER TABLE wager.payouts
    ADD CONSTRAINT payouts_idempotency_uniq UNIQUE (idempotency_key);

ALTER TABLE wager.payouts ALTER COLUMN kind DROP DEFAULT;

CREATE INDEX payouts_status_idx ON wager.payouts (status, lease_until);

COMMENT ON TABLE wager.payouts IS
    'One settlement DECISION per escrow. The primary key is what stops two workers forming two opinions; the legs below are the transactions that carry it out.';
COMMENT ON COLUMN wager.payouts.lease_until IS
    'Soft lock for the settlement worker, so replicas do not reconcile the same row simultaneously without holding a DB transaction open across the network.';

-- ── payout legs ──────────────────────────────────────────────────────────────
CREATE TABLE wager.payout_legs (
    escrow_id   text        NOT NULL REFERENCES wager.payouts(escrow_id) ON DELETE CASCADE,
    leg_index   int         NOT NULL,
    to_address  text        NOT NULL,
    amount_base bigint      NOT NULL CHECK (amount_base > 0),
    purpose     text        NOT NULL CHECK (purpose IN ('payout', 'refund', 'burn')),
    status      text        NOT NULL CHECK (status IN ('preparing', 'sending', 'paid', 'failed')),
    tx_hash     text        UNIQUE,
    raw_tx      text,
    nonce       bigint,
    attempts    int         NOT NULL DEFAULT 0,
    last_error  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    paid_at     timestamptz,
    PRIMARY KEY (escrow_id, leg_index)
);

CREATE INDEX payout_legs_status_idx ON wager.payout_legs (status);
CREATE INDEX payout_legs_nonce_idx  ON wager.payout_legs (nonce) WHERE nonce IS NOT NULL;

COMMENT ON COLUMN wager.payout_legs.tx_hash IS
    'Recorded BEFORE the transaction is broadcast — keccak256 of the signed bytes is known offline. UNIQUE, so one on-chain transaction can never be credited to two legs.';
COMMENT ON COLUMN wager.payout_legs.raw_tx IS
    'The signed transaction. Kept so a stalled attempt is rebroadcast byte-for-byte: identical hash, so a duplicate cannot exist.';
COMMENT ON COLUMN wager.payout_legs.nonce IS
    'Kept for the life of the leg. A replacement reuses it, so the replacement and the original are mutually exclusive on-chain by consensus rule rather than by our bookkeeping.';

-- ── booster offers (server-issued purchase intents) ──────────────────────────
CREATE TABLE wager.booster_offers (
    nonce      text           PRIMARY KEY,
    profile_id bigint         NOT NULL REFERENCES core.profiles(id),
    address    text           NOT NULL,
    amount_wei numeric(78, 0) NOT NULL CHECK (amount_wei > 0),
    recipient  text           NOT NULL,
    status     text           NOT NULL CHECK (status IN ('open', 'consumed')),
    expires_at timestamptz    NOT NULL,
    created_at timestamptz    NOT NULL DEFAULT now()
);

CREATE INDEX booster_offers_profile_idx ON wager.booster_offers (profile_id, created_at DESC);

COMMENT ON TABLE wager.booster_offers IS
    'Price and recipient are decided here, server-side. A payment binds to exactly one offer by carrying its nonce as calldata, and must be newer than the offer — the legacy verifier accepted ANY historical transfer to the treasury.';
COMMENT ON COLUMN wager.booster_offers.amount_wei IS
    'numeric(78,0), not bigint: wei overflows int8 above ~9.2 ETH.';

-- ── booster reservations ─────────────────────────────────────────────────────
ALTER TABLE wager.booster_intents
    ADD COLUMN nonce          text NOT NULL,
    ADD COLUMN owner_address  text NOT NULL,
    ADD COLUMN amount_wei     numeric(78, 0) NOT NULL CHECK (amount_wei > 0),
    ADD COLUMN token_id       text,
    ADD COLUMN mint_tx_hash   text,
    ADD COLUMN failure_reason text,
    ADD COLUMN minted_at      timestamptz;

ALTER TABLE wager.booster_intents
    ALTER COLUMN ticket_number SET NOT NULL,
    ADD CONSTRAINT booster_intents_nonce_uniq UNIQUE (nonce),
    ADD CONSTRAINT booster_intents_nonce_fk FOREIGN KEY (nonce)
        REFERENCES wager.booster_offers(nonce);

COMMENT ON COLUMN wager.booster_intents.payment_sig IS
    'EVM payment transaction hash. Primary key: a payment can be redeemed exactly once, globally, forever (H-3).';
COMMENT ON COLUMN wager.booster_intents.mint_address IS
    'Ticket contract, once on-chain issuance exists. NULL while a reservation awaits issuance — the ticket number is already the buyer''s regardless.';

-- ── ticket numbering + supply cap ────────────────────────────────────────────
CREATE TABLE wager.booster_counter (
    id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
    next_ticket_number int     NOT NULL DEFAULT 1 CHECK (next_ticket_number > 0),
    supply_cap         int     NOT NULL CHECK (supply_cap >= 0),
    reserved_count     int     NOT NULL DEFAULT 0 CHECK (reserved_count >= 0)
);

-- Single row. Seed the cap here; BOOSTER_SUPPLY_CAP in env applies as a second,
-- lower bound at runtime (the service uses the minimum of the two).
INSERT INTO wager.booster_counter (id, next_ticket_number, supply_cap, reserved_count)
VALUES (true, 1, 2000, 0);

COMMENT ON TABLE wager.booster_counter IS
    'Ticket numbers come from here under SELECT … FOR UPDATE, inside the same transaction that inserts the reservation and checks the cap. The old server used MAX(ticket_number)+1, which two concurrent buyers could read identically.';

-- ── redemptions and shipping (H-2) ───────────────────────────────────────────
CREATE TABLE wager.redemptions (
    id            bigserial   PRIMARY KEY,
    ticket_number int         NOT NULL REFERENCES wager.booster_intents(ticket_number),
    profile_id    bigint      NOT NULL REFERENCES core.profiles(id),
    kind          text        NOT NULL CHECK (kind IN ('digital', 'physical', 'merch')),
    card_ids      text[],
    tracking      text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (ticket_number, kind)
);

COMMENT ON CONSTRAINT redemptions_ticket_number_kind_key ON wager.redemptions IS
    'One redemption of each kind per ticket. Double-redemption is a constraint violation, not a lost race.';

-- 0005 keyed shipping by `ticket_id`, which cannot hold both the physical and
-- the merch address for one ticket. Re-keyed to the redemption it belongs to.
-- Safe to drop: this table has never held production data.
DROP TABLE IF EXISTS wager.shipping;

CREATE TABLE wager.shipping (
    redemption_id bigint      PRIMARY KEY REFERENCES wager.redemptions(id) ON DELETE CASCADE,
    profile_id    bigint      NOT NULL REFERENCES core.profiles(id),
    payload       jsonb       NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX shipping_profile_idx ON wager.shipping (profile_id);

COMMENT ON TABLE wager.shipping IS
    'Personal data. Readable only by profile_id = req.auth.profileId or a caller holding the operator role (H-2). No route anywhere maps a wallet address to these rows.';
