-- 0005_wager.sql
-- Escrows, deposits, payouts and booster tickets.
--
-- Every constraint below is an audit fix. They exist so that correctness does
-- not depend on application logic being right:
--
--   deposits.signature PRIMARY KEY       — a payment signature can be redeemed
--                                          once, globally, forever  (C-2)
--   deposits UNIQUE (escrow_id, seat)    — one deposit per seat     (C-2)
--   payouts.escrow_id PRIMARY KEY        — one payout per escrow    (M-2)
--   payouts.tx_sig UNIQUE                — one on-chain tx recorded once
--   booster_intents.payment_sig PK       — reserve-before-mint      (H-3)
--   booster_intents.ticket_number UNIQUE — two buyers cannot get one ticket
--   booster_intents.mint_address UNIQUE  — one NFT per intent
--
-- The previous backend guarded these with an in-process Set that was lost on
-- restart and never shared between replicas.

CREATE TABLE wager.escrows (
    id          text        PRIMARY KEY,
    amount_base bigint      NOT NULL CHECK (amount_base > 0),
    token       text        NOT NULL,
    status      text        NOT NULL CHECK (status IN ('open', 'funded', 'settled', 'refunded', 'void')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN wager.escrows.amount_base IS
    'Amount in the token base unit (lamports / wei). bigint, never a float.';
COMMENT ON TABLE wager.escrows IS
    'Settlement takes SELECT … FOR UPDATE on the row, so concurrent settlements serialise instead of double-paying (M-2).';

CREATE INDEX escrows_status_idx ON wager.escrows (status, created_at);

CREATE TABLE wager.deposits (
    signature   text        PRIMARY KEY,
    escrow_id   text        NOT NULL REFERENCES wager.escrows(id),
    seat        smallint    NOT NULL CHECK (seat IN (0, 1)),
    profile_id  bigint      NOT NULL REFERENCES core.profiles(id),
    amount_base bigint      NOT NULL CHECK (amount_base > 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (escrow_id, seat)
);

COMMENT ON COLUMN wager.deposits.signature IS
    'On-chain transaction signature. GLOBAL primary key: a replay across escrows violates it (C-2).';
COMMENT ON COLUMN wager.deposits.profile_id IS
    'Derived from the authenticated session, never from the request body (C-3).';

CREATE INDEX deposits_escrow_idx  ON wager.deposits (escrow_id);
CREATE INDEX deposits_profile_idx ON wager.deposits (profile_id);

CREATE TABLE wager.payouts (
    escrow_id  text        PRIMARY KEY REFERENCES wager.escrows(id),
    tx_sig     text        NOT NULL UNIQUE,
    paid_at    timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Boosters: the ticket/mint is reserved BEFORE any mint is attempted, so a
-- crash between payment and mint leaves a 'reserved' row rather than an
-- unbounded retry that mints twice (H-3).
CREATE TABLE wager.booster_intents (
    payment_sig   text        PRIMARY KEY,
    profile_id    bigint      NOT NULL REFERENCES core.profiles(id),
    reserved_at   timestamptz NOT NULL DEFAULT now(),
    ticket_number int         UNIQUE,
    mint_address  text        UNIQUE,
    status        text        NOT NULL CHECK (status IN ('reserved', 'minted', 'failed')),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX booster_intents_profile_idx ON wager.booster_intents (profile_id);
CREATE INDEX booster_intents_status_idx  ON wager.booster_intents (status);

CREATE TABLE wager.shipping (
    ticket_id  bigint      PRIMARY KEY,
    profile_id bigint      NOT NULL REFERENCES core.profiles(id),
    payload    jsonb       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE wager.shipping IS
    'Personal data. Readable only by profile_id = req.auth.profileId, or by a caller holding the operator role (H-2). Never joined into a public listing.';

CREATE INDEX shipping_profile_idx ON wager.shipping (profile_id);
