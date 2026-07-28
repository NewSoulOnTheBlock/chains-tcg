-- 0013_profile_addresses.sql
-- One profile, many wallet addresses.
--
-- ── Why this exists ────────────────────────────────────────────────────────
-- Until this file, identity was `core.profiles UNIQUE (address, chain)`: one
-- wallet, one profile, forever. Two things break because of that, and both of
-- them now cost real money.
--
-- (1) ACCOUNT ABSTRACTION CANNOT SIGN IN AT ALL. An ERC-4337 smart account
--     cannot produce a signature that ecrecovers to its own address — that is
--     the entire reason ERC-1271 `isValidSignature` exists — so the EOA-only
--     verifier in `services/auth/src/signature.ts` rejected every AA wallet.
--     The schema was not the blocker there, but the fix arrives with this one:
--     an email-backed smart account is a SECOND wallet for a player who already
--     has a MetaMask EOA, not a second player.
--
-- (2) A PLAYER WITH TWO WALLETS BECAME TWO PEOPLE. Card ownership is
--     reconciled from the NFTs held by the authenticated address (0010, 0011)
--     and ranked standing hangs off `core.profiles.id` (0012). Someone who
--     minted booster packs with MetaMask and then signed in with a smart
--     account owned nothing and started a second, empty ladder standing. With a
--     weekly prize attached that is also a free multi-account vector: the
--     anti-smurf heuristics in 0012 key on profile id, so two profiles behind
--     one human were invisible to them by construction.
--
-- The product decision is one profile, many linked addresses. This file is the
-- table that makes that representable, plus the invariants that make it safe.
--
-- ══════════════════════════════════════════════════════════════════════════
-- (a) The primary key is the security control
-- ══════════════════════════════════════════════════════════════════════════
--
-- `PRIMARY KEY (address, chain)` — NOT `(profile_id, address, chain)`.
--
-- Globally unique means an address belongs to at most ONE profile, ever, at any
-- instant. That is what makes it impossible for two accounts to claim the same
-- NFTs: the wager service unions a profile's linked addresses and reconciles
-- holdings across them, so an address linked twice would have its entire
-- collection counted for two profiles at once — and a collection is what ranked
-- eligibility and the weekly prize are computed from.
--
-- Widening the key to include `profile_id` would turn that structural
-- impossibility into an application-level "did anyone remember to check", which
-- is the exact shape of the bug class this backend exists to remove (C-2's
-- `deposits.signature PRIMARY KEY`, 0010's `(profile_id, card_id)`). Do not do
-- it. There is no product requirement that needs it: a player who genuinely
-- sold a wallet unlinks it and the new owner links it (see §6).
--
-- ══════════════════════════════════════════════════════════════════════════
-- (b) `core.profiles.address` is NOT dropped here
-- ══════════════════════════════════════════════════════════════════════════
--
-- It stays, as the PRIMARY address, kept in lockstep with this table by the
-- triggers in §4. Three reasons:
--
--   * Rollback. Dropping the column in the same migration that introduces the
--     table means a revert loses every identity. Keeping it means 0013 can be
--     rolled back to 0012 by dropping only what 0013 created.
--   * Every existing query keeps working. `core.profiles.address` is read by
--     the auth service (`/auth/me`, token minting, `deriveRoles`), by the
--     profile service (`GET /api/profiles/me`) and by the wager service's
--     collection sync. None of them have to change on the same deploy.
--   * `UNIQUE (address, chain)` on `core.profiles` remains a second, independent
--     guard on the primary address specifically.
--
-- Removing it is a later migration, once nothing reads it.
--
-- ══════════════════════════════════════════════════════════════════════════
-- (c) Why this file introduces TRIGGERS — the first in db/migrations
-- ══════════════════════════════════════════════════════════════════════════
--
-- Migrations 0001–0012 use constraints only, deliberately: a CHECK or a UNIQUE
-- index is declarative, visible in `\d`, and cannot be reasoned around. Triggers
-- are the opposite and were avoided on purpose. This file breaks that, for one
-- reason that no constraint can express:
--
--     "every row in core.profiles has exactly one primary row here, and the two
--      copies of the primary address never disagree"
--
-- is a cross-table invariant. Enforcing it in the auth service alone would leave
-- it true only for rows the auth service wrote. It is not the only writer:
-- `services/wager/src/testing/db.ts` and the game service's test fixtures INSERT
-- into `core.profiles` directly, and the wager service's collection sync treats
-- "profile with zero linked addresses" as an integrity failure — correctly, since
-- its reconcile is DESTRUCTIVE and an empty address list would delete a player's
-- entire chain collection. A profile that can exist without an address row is
-- therefore a data-loss bug waiting for a writer that forgot.
--
-- So the trigger is doing the same job the constraints elsewhere do: making the
-- invariant a property of the database rather than of whoever writes to it.
-- Every function below is small, fully qualified, and does exactly one thing.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. The table
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS core.profile_addresses (
    profile_id bigint      NOT NULL REFERENCES core.profiles(id) ON DELETE CASCADE,
    address    text        NOT NULL,
    chain      text        NOT NULL,
    kind       text        NOT NULL DEFAULT 'eoa' CHECK (kind IN ('eoa','smart')),
    is_primary boolean     NOT NULL DEFAULT false,
    linked_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (address, chain)
);

-- ── On the missing `created_at` ────────────────────────────────────────────
-- ARCHITECTURE.md § Database says every table has `created_at`. `linked_at` IS
-- that column under a name that says what the timestamp means, and it carries
-- the same `NOT NULL DEFAULT now()`. The column list is a contract the wager
-- service is already coded against (`services/wager/src/db/profileAddresses.ts`
-- quotes it verbatim); adding a second, identical timestamp would be noise.

-- ── Lookup by owner ────────────────────────────────────────────────────────
-- The primary key indexes (address, chain), which serves sign-in: "who owns the
-- address that just signed?". The other direction — "what does this profile
-- own?" — is the collection sync's union and the caller's own address list, and
-- has no index without this one.
CREATE INDEX IF NOT EXISTS profile_addresses_profile_idx
    ON core.profile_addresses (profile_id);

-- ── Exactly one primary per profile ────────────────────────────────────────
-- A partial unique index, so the constraint applies only to rows where
-- `is_primary` is true; secondary addresses are unconstrained on this axis.
--
-- CONSEQUENCE FOR WRITERS: this index is not deferrable (a unique INDEX cannot
-- be), so it is checked row by row as a statement progresses. Promoting a
-- different address must therefore be TWO statements inside one transaction —
-- demote every primary for the profile, then promote the target — never one
-- `SET is_primary = (address = $1)` sweep, which can transiently hold two
-- primaries depending on the order the executor visits rows.
CREATE UNIQUE INDEX IF NOT EXISTS profile_addresses_one_primary
    ON core.profile_addresses (profile_id)
    WHERE is_primary;

COMMENT ON TABLE core.profile_addresses IS
    'Every wallet address a profile has proved control of. PRIMARY KEY (address, chain) is GLOBAL: an address belongs to at most one profile, which is what stops two accounts claiming the same on-chain collection. Written by the auth service only (sign-in, link, unlink); read by the wager service''s collection sync and by the caller''s own address list. Addresses in this table are NEVER included in a public listing (audit finding H-2) and there is no lookup-by-address route.';

COMMENT ON COLUMN core.profile_addresses.profile_id IS
    'Owner. ON DELETE CASCADE: a deleted profile takes its address links with it, the same as its decks (0002) and its collection (0010).';
COMMENT ON COLUMN core.profile_addresses.address IS
    'Normalised wallet address, same rules as core.profiles.address — EVM lowercase, Solana base58 verbatim. Part of the primary key, so an un-normalised spelling would become a SECOND identity for the same wallet. normalizeAddress() in packages/shared/src/chains.ts is the only thing that may produce a value for this column.';
COMMENT ON COLUMN core.profile_addresses.chain IS
    'Chain slug from CHAINS in packages/shared/src/chains.ts, not an EIP-155 id. Part of the primary key: the same address on two chains is two links, because it is two identities (see 0009).';
COMMENT ON COLUMN core.profile_addresses.kind IS
    'How the signature was verified when this address was linked: ''eoa'' = plain ECDSA ecrecover, ''smart'' = ERC-1271/ERC-6492 on-chain validation (an ERC-4337 account or a passkey wallet). ADVISORY ONLY — nothing authorises on it. It exists so support can tell why a login needed an RPC call, and so the share of smart accounts is measurable.';
COMMENT ON COLUMN core.profile_addresses.is_primary IS
    'The address mirrored into core.profiles.address. Exactly one per profile (partial unique index profile_addresses_one_primary), kept in sync in both directions by the triggers in this migration. It is a display/compatibility pointer, not a privilege: signing with ANY linked address reaches the same profile with the same rights.';
COMMENT ON COLUMN core.profile_addresses.linked_at IS
    'When control of this address was proved. Serves as this table''s created_at.';

COMMENT ON INDEX core.profile_addresses_one_primary IS
    'Exactly one primary address per profile. Not deferrable — promote by demoting first in a separate statement, then promoting.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. Unlink history — the relink audit trail and cooldown source
-- ══════════════════════════════════════════════════════════════════════════
--
-- The primary key in §1 stops an address being linked to two profiles AT ONCE.
-- It says nothing about SEQUENTIALLY: unlink from profile A, link to profile B,
-- repeat. Because a collection is derived from what the wallet holds on chain
-- rather than from anything we granted, that is a wallet-lending machine — one
-- whale wallet can dress account after account in a full collection, and with a
-- weekly prize attached that is the highest-value abuse left in the design.
--
-- This table records every unlink, permanently, and is the input to the cooldown
-- in §5. There is NO foreign key to core.profiles on purpose: the audit row must
-- outlive the profile, exactly like 0012's `ranked_match_ratings`. `profile_id`
-- here is a historical fact, not a live reference.
CREATE TABLE IF NOT EXISTS core.profile_address_unlinks (
    id          bigserial   PRIMARY KEY,
    address     text        NOT NULL,
    chain       text        NOT NULL,
    profile_id  bigint      NOT NULL,
    kind        text        NOT NULL,
    was_primary boolean     NOT NULL,
    linked_at   timestamptz NOT NULL,
    unlinked_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The cooldown lookup: "when did this address most recently leave a profile?"
CREATE INDEX IF NOT EXISTS profile_address_unlinks_address_idx
    ON core.profile_address_unlinks (address, chain, unlinked_at DESC);

-- Support lookup: "what has this profile given up?"
CREATE INDEX IF NOT EXISTS profile_address_unlinks_profile_idx
    ON core.profile_address_unlinks (profile_id, unlinked_at DESC);

COMMENT ON TABLE core.profile_address_unlinks IS
    'Permanent record of every address a profile has given up. Two jobs: it is the input to the relink cooldown (see the trigger profile_addresses_relink_cooldown), and it is the only way to see a wallet being cycled between accounts to lend a collection. Deliberately has NO foreign key to core.profiles — an audit row must survive the profile it names, like 0012''s ranked_match_ratings. Rows are written by a trigger, never by a service, so no writer can unlink without leaving the trail.';
COMMENT ON COLUMN core.profile_address_unlinks.profile_id IS
    'The profile the address was unlinked FROM. A historical fact with no FK: the profile may since have been deleted.';
COMMENT ON COLUMN core.profile_address_unlinks.linked_at IS
    'Copied from the deleted core.profile_addresses row, so the holding period is reconstructable from this table alone.';
COMMENT ON COLUMN core.profile_address_unlinks.unlinked_at IS
    'When the link was released. The cooldown in profile_addresses_relink_cooldown() measures from here.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. Backfill — every existing profile keeps its identity
-- ══════════════════════════════════════════════════════════════════════════
--
-- One row per existing profile, is_primary = true, kind = 'eoa'.
--
-- Why this cannot collide: `core.profiles` carries UNIQUE (address, chain), so
-- the source rows are already distinct on exactly the columns that form this
-- table's primary key. The INSERT therefore cannot conflict with itself, and
-- ON CONFLICT DO NOTHING makes a re-run a no-op rather than an error.
--
-- Why kind = 'eoa': every profile that exists predates smart-account sign-in, so
-- every one of them was created by a 65-byte ECDSA signature. That is not a
-- guess, it is what the old verifier's `HEX_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/`
-- gate mechanically guarantees — nothing else could ever have got through it.
INSERT INTO core.profile_addresses (profile_id, address, chain, kind, is_primary, linked_at)
SELECT p.id, p.address, p.chain, 'eoa', true, p.created_at
  FROM core.profiles p
ON CONFLICT (address, chain) DO NOTHING;

-- ── Prove the backfill, do not hope for it ─────────────────────────────────
-- 0009 used RAISE WARNING for its stranded-row check because it was reporting
-- an ambiguity a human had to resolve. This is different: a profile without
-- exactly one primary address after this statement is not ambiguous, it is a
-- broken invariant that the rest of this file (and the wager service's
-- destructive reconcile) depends on. Fail the migration, inside its own
-- transaction, so the deploy stops here instead of shipping half an identity
-- model. The migrate runner wraps each file in BEGIN/COMMIT, so raising rolls
-- the whole file back and 0013 is simply not recorded as applied.
DO $$
DECLARE
    orphans  bigint;
    multi    bigint;
    mismatch bigint;
BEGIN
    SELECT count(*) INTO orphans
      FROM core.profiles p
     WHERE NOT EXISTS (
             SELECT 1 FROM core.profile_addresses a
              WHERE a.profile_id = p.id AND a.is_primary
           );
    IF orphans > 0 THEN
        RAISE EXCEPTION
            'profile_addresses_backfill_incomplete: % core.profiles row(s) have no primary address after the backfill. Every profile must end up with exactly one. Refusing to apply 0013.',
            orphans;
    END IF;

    SELECT count(*) INTO multi
      FROM (SELECT profile_id FROM core.profile_addresses
             WHERE is_primary GROUP BY profile_id HAVING count(*) > 1) x;
    IF multi > 0 THEN
        RAISE EXCEPTION
            'profile_addresses_multiple_primary: % profile(s) hold more than one primary address. The partial unique index should have made this unrepresentable.',
            multi;
    END IF;

    -- The mirrored copy must agree with the source on day one, or the sync
    -- triggers in §4 would be silently papering over a difference.
    SELECT count(*) INTO mismatch
      FROM core.profiles p
      JOIN core.profile_addresses a ON a.profile_id = p.id AND a.is_primary
     WHERE (a.address, a.chain) IS DISTINCT FROM (p.address, p.chain);
    IF mismatch > 0 THEN
        RAISE EXCEPTION
            'profile_addresses_primary_mismatch: % profile(s) disagree with their primary address row. Refusing to apply 0013.',
            mismatch;
    END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. Keeping core.profiles.address and the primary row in lockstep
-- ══════════════════════════════════════════════════════════════════════════

-- ── 4a. A new profile gets its primary address row automatically ───────────
-- Not a convenience: it is what stops a profile ever existing with zero
-- addresses. The wager collection sync treats an empty address list for a
-- profile as an integrity failure precisely because its reconcile is
-- destructive, and `services/wager/src/testing/db.ts` / the game service's test
-- fixtures INSERT into core.profiles directly and never learn about this table.
-- With this trigger they do not have to.
--
-- The INSERT is unqualified by ON CONFLICT on purpose. If (address, chain) is
-- already linked to a DIFFERENT profile, this raises 23505 and the profile
-- creation fails — which is exactly right, and is the backstop for any writer
-- that resolves sign-in by `core.profiles` instead of by this table.
CREATE OR REPLACE FUNCTION core.profiles_link_primary_address()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO core.profile_addresses (profile_id, address, chain, kind, is_primary, linked_at)
    VALUES (NEW.id, NEW.address, NEW.chain, 'eoa', true, NEW.created_at);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profiles_link_primary_address ON core.profiles;
CREATE TRIGGER profiles_link_primary_address
    AFTER INSERT ON core.profiles
    FOR EACH ROW EXECUTE FUNCTION core.profiles_link_primary_address();

COMMENT ON FUNCTION core.profiles_link_primary_address() IS
    'Every new profile gets exactly one primary core.profile_addresses row. Guarantees no profile can exist with zero linked addresses, which the wager service''s destructive collection reconcile depends on. kind is ''eoa'' because the auth service upgrades it to ''smart'' only when a link actually needed ERC-1271/6492; a brand-new profile has not been through that path yet.';

-- ── 4b. profiles.address changes -> the primary row follows ────────────────
-- Nothing in the services does this today, and nothing should. It exists so
-- that a future migration or a manual correction cannot leave the mirrored copy
-- pointing at a wallet the profile no longer claims. If the new address is
-- already linked elsewhere, the primary-key violation aborts the UPDATE — which
-- is the correct answer, not an inconvenience.
CREATE OR REPLACE FUNCTION core.profiles_sync_primary_address()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE core.profile_addresses
       SET address = NEW.address,
           chain   = NEW.chain
     WHERE profile_id = NEW.id
       AND is_primary
       AND (address, chain) IS DISTINCT FROM (NEW.address, NEW.chain);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profiles_sync_primary_address ON core.profiles;
CREATE TRIGGER profiles_sync_primary_address
    AFTER UPDATE OF address, chain ON core.profiles
    FOR EACH ROW
    WHEN (OLD.address IS DISTINCT FROM NEW.address OR OLD.chain IS DISTINCT FROM NEW.chain)
    EXECUTE FUNCTION core.profiles_sync_primary_address();

COMMENT ON FUNCTION core.profiles_sync_primary_address() IS
    'core.profiles.address -> core.profile_addresses. The other half of the mirror. Terminates against its counterpart because each side only writes when the values actually differ.';

-- ── 4c. The primary row changes -> profiles.address follows ────────────────
-- This is the direction the auth service actually drives: linking a wallet and
-- promoting it to primary must move core.profiles.address, or `/auth/me`,
-- `GET /api/profiles/me`, the JWT `addr` claim and the wager service's sync
-- would keep naming the old wallet.
--
-- RECURSION: 4b and 4c call each other. It terminates after one hop in either
-- direction because each side's UPDATE carries an `IS DISTINCT FROM` predicate,
-- so the second hop matches zero rows and fires no further trigger.
CREATE OR REPLACE FUNCTION core.profile_addresses_sync_profile()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE core.profiles
       SET address = NEW.address,
           chain   = NEW.chain
     WHERE id = NEW.profile_id
       AND (address, chain) IS DISTINCT FROM (NEW.address, NEW.chain);
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profile_addresses_sync_profile ON core.profile_addresses;
CREATE TRIGGER profile_addresses_sync_profile
    AFTER INSERT OR UPDATE ON core.profile_addresses
    FOR EACH ROW
    WHEN (NEW.is_primary)
    EXECUTE FUNCTION core.profile_addresses_sync_profile();

COMMENT ON FUNCTION core.profile_addresses_sync_profile() IS
    'core.profile_addresses (is_primary) -> core.profiles.address/chain. Keeps the compatibility copy honest so that every pre-0013 query keeps returning the right wallet without being rewritten.';

-- ══════════════════════════════════════════════════════════════════════════
-- 5. A profile may never be left with no address
-- ══════════════════════════════════════════════════════════════════════════
--
-- Unlinking the last address, or the primary without promoting another first,
-- would leave a profile that cannot be signed into and whose collection sync
-- would enumerate nothing and DELETE the player's whole chain collection. The
-- auth service refuses both with a clean 409; this trigger is why that refusal
-- cannot be bypassed by any other writer or by a stray psql session.
--
-- CASCADE IS EXEMPT, and the test for it is `the profile is already gone`.
-- When `DELETE FROM core.profiles` cascades, PostgreSQL removes the parent row
-- first and runs the referential action afterwards in the same transaction, so
-- the lookup below finds nothing and the delete is allowed. That keeps
-- `DELETE FROM core.profiles WHERE address = ANY(...)` — which the game and
-- wager suites do constantly — working unchanged.
--
-- The same test decides whether an unlink is RECORDED: a cascade is a profile
-- being destroyed, not an address being given up, so it writes no history row
-- and starts no cooldown. Without that distinction every test fixture teardown
-- would poison its own addresses for the next run.
CREATE OR REPLACE FUNCTION core.profile_addresses_guard_unlink()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    remaining bigint;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.profiles WHERE id = OLD.profile_id) THEN
        -- Cascade from a profile delete. Nothing to protect, nothing to record.
        RETURN OLD;
    END IF;

    SELECT count(*) INTO remaining
      FROM core.profile_addresses
     WHERE profile_id = OLD.profile_id
       AND (address, chain) IS DISTINCT FROM (OLD.address, OLD.chain);

    IF remaining = 0 THEN
        RAISE EXCEPTION
            'profile_addresses_last_address: profile % cannot unlink its only address', OLD.profile_id
            USING ERRCODE = 'CH002';
    END IF;

    IF OLD.is_primary THEN
        RAISE EXCEPTION
            'profile_addresses_primary_address: profile % must promote another address to primary before unlinking this one', OLD.profile_id
            USING ERRCODE = 'CH003';
    END IF;

    INSERT INTO core.profile_address_unlinks
        (address, chain, profile_id, kind, was_primary, linked_at)
    VALUES (OLD.address, OLD.chain, OLD.profile_id, OLD.kind, OLD.is_primary, OLD.linked_at);

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS profile_addresses_guard_unlink ON core.profile_addresses;
CREATE TRIGGER profile_addresses_guard_unlink
    BEFORE DELETE ON core.profile_addresses
    FOR EACH ROW EXECUTE FUNCTION core.profile_addresses_guard_unlink();

COMMENT ON FUNCTION core.profile_addresses_guard_unlink() IS
    'Refuses to leave a profile with zero addresses (SQLSTATE CH002) or to unlink the primary without promoting another first (CH003), and records every genuine unlink in core.profile_address_unlinks. Exempts ON DELETE CASCADE by testing whether the parent profile still exists, so profile deletion and the test suites'' fixture teardown keep working and do not start a cooldown.';

-- ══════════════════════════════════════════════════════════════════════════
-- 6. Relink cooldown — the wallet-lending mitigation
-- ══════════════════════════════════════════════════════════════════════════
--
-- The abuse: unlink a wallet holding a full collection from account A, link it
-- to account B, sync, unlink, link to account C. The (address, chain) primary
-- key does not stop this because at no instant are two profiles holding it.
-- Ranked eligibility and the weekly prize are downstream of the collection, so
-- one whale wallet could outfit an unlimited number of accounts.
--
-- WHY A COOLDOWN AND NOT A PERMANENT BAN. "An address that has ever been linked
-- elsewhere may never be linked again" is the strongest rule and it was
-- rejected: it makes a genuine wallet handover, and the very common "I made this
-- profile with the wrong wallet" mistake, permanently unfixable without an
-- operator, and we have no operator tooling for it. A cooldown keeps the honest
-- cases self-service (wait, or use a different wallet) while making the abuse
-- pay one wallet per account per month instead of one wallet per account per
-- minute — and the history table above makes the pattern visible either way,
-- which a ban would not, because a banned attacker just stops trying.
--
-- RELINKING TO THE SAME PROFILE IS FREE. Returning an address to the profile it
-- came from grants nothing new: that profile already had it. Only crossing to a
-- different profile is rate-limited.
--
-- THE PERIOD IS HARDCODED, ON PURPOSE. A cooldown configurable by environment
-- variable is a cooldown an operator can silently set to zero. Changing it means
-- a new migration, which is reviewable and leaves a record.
CREATE OR REPLACE FUNCTION core.profile_addresses_relink_cooldown()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    cooldown  constant interval := interval '30 days';
    last_row  record;
    eligible  timestamptz;
BEGIN
    SELECT u.profile_id, u.unlinked_at INTO last_row
      FROM core.profile_address_unlinks u
     WHERE u.address = NEW.address
       AND u.chain   = NEW.chain
     ORDER BY u.unlinked_at DESC, u.id DESC
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NEW;                         -- never unlinked from anything
    END IF;
    IF last_row.profile_id = NEW.profile_id THEN
        RETURN NEW;                         -- going home
    END IF;

    eligible := last_row.unlinked_at + cooldown;
    IF eligible > now() THEN
        RAISE EXCEPTION
            'profile_addresses_relink_cooldown: this address was unlinked from another profile less than 30 days ago'
            USING ERRCODE = 'CH001',
                  DETAIL  = 'eligible_at=' || to_char(eligible AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profile_addresses_relink_cooldown ON core.profile_addresses;
CREATE TRIGGER profile_addresses_relink_cooldown
    BEFORE INSERT ON core.profile_addresses
    FOR EACH ROW EXECUTE FUNCTION core.profile_addresses_relink_cooldown();

COMMENT ON FUNCTION core.profile_addresses_relink_cooldown() IS
    'Refuses (SQLSTATE CH001) to link an address that was unlinked from a DIFFERENT profile within the last 30 days. Mitigates one wallet lending its on-chain collection to account after account, which the (address, chain) primary key does not prevent because the links are sequential rather than simultaneous. Fires on BEFORE INSERT, so it covers both the link route and first-time sign-in creating a fresh profile — otherwise "unlink, then sign in with it" would be a one-step bypass. The DETAIL field carries eligible_at as an ISO-8601 UTC timestamp for the API error body.';

-- ══════════════════════════════════════════════════════════════════════════
-- 7. auth.nonces gains a purpose discriminator
-- ══════════════════════════════════════════════════════════════════════════
--
-- The link flow reuses the existing challenge machinery — same builder, same
-- single-use Redis GETDEL, same auth.nonces audit row — but a sign-in challenge
-- and a link challenge must not be interchangeable. Without a discriminator, a
-- signature harvested by a phishing site under "Sign in to Chains TCG." could be
-- replayed at the link endpoint to attach the victim's wallet to the attacker's
-- profile, which hands over the victim's entire on-chain collection. The two
-- challenges now carry different statements (so the wallet prompt tells the
-- truth about what is being authorised) and this column records which was
-- minted, so the audit trail says what was actually signed.
--
-- DEFAULT 'signin' keeps every pre-0013 row correct: nothing but sign-in existed.
ALTER TABLE auth.nonces
    ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'signin'
        CHECK (purpose IN ('signin','link'));

COMMENT ON COLUMN auth.nonces.purpose IS
    'What this challenge was minted for: ''signin'' (public, exchanges for a token pair) or ''link'' (authenticated, attaches the signing address to the caller''s profile). The auth service refuses to consume a nonce for a purpose other than the one it was issued under, so a sign-in signature can never be replayed as a link. DEFAULT ''signin'' because that is all that existed before 0013.';

-- ══════════════════════════════════════════════════════════════════════════
-- 8. Custom SQLSTATEs raised by this file
-- ══════════════════════════════════════════════════════════════════════════
--
--   CH001  relink cooldown           -> auth returns 403 address_relink_cooldown
--   CH002  last address              -> auth returns 409 last_address
--   CH003  primary address           -> auth returns 409 primary_address
--
-- Class 'CH' is not used by PostgreSQL, so these cannot collide with a real
-- server error, and `pgErrorCode()` in packages/shared/src/errors.ts already
-- accepts the shape (/^[0-9A-Z]{5}$/). They are deliberately NOT added to that
-- module's PG_SQLSTATE map: that map produces generic messages, and these three
-- need a machine-readable `reason` a client can branch on, so the auth service
-- translates them itself.

-- ══════════════════════════════════════════════════════════════════════════
-- 9. Grants: there are none, and that is correct
-- ══════════════════════════════════════════════════════════════════════════
--
-- As with 0010: this backend has no per-service database roles. Every service
-- and the migration runner connect with the single POSTGRES_USER role. "Only
-- auth writes this table, wager only reads it" is a convention enforced by code
-- review and by which service owns which route, not by the database. The
-- invariants above are enforced for every writer precisely because they are
-- triggers and constraints rather than permissions.
