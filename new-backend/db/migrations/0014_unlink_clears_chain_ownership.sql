-- 0014_unlink_clears_chain_ownership.sql
-- Unlinking a wallet takes its cards with it.
--
-- ── Why this exists ────────────────────────────────────────────────────────
-- 0013 turned a profile into a SET of wallets and gave that set a door in both
-- directions: `POST /auth/addresses` links, `DELETE /auth/addresses/:chain/:address`
-- unlinks. Card ownership is reconciled from the NFTs held by that set into
-- `core.card_ownership` with `source = 'chain'` (0010, 0011). Nothing removed
-- those rows when a wallet left the set, so the borrow was free:
--
--   1. borrow a wallet holding a full collection, link it, sync,
--   2. unlink it and hand it back,
--   3. keep the collection.
--
-- Step 3 works because `core.card_ownership` is a STORED PROJECTION, not a live
-- read, and the only thing that ever refreshes it is the player pressing sync —
-- which a player sitting on a snapshot they no longer deserve will never press
-- again. `services/game/src/lib/seating.ts` gates a ranked seat on that table
-- and on nothing else, so the borrowed deck keeps being seated indefinitely,
-- with a weekly prize hanging off the ladder.
--
-- 0013 § 6's 30-day relink cooldown does NOT cover this. It constrains the
-- LENDER: their wallet cannot be attached to a third profile for a month. It
-- says nothing about the BORROWER, who is not trying to link anything — they
-- already have what they came for. One wallet still dresses one account per
-- month, permanently, for free; and because the cooldown pushes the cycle out
-- to monthly it makes the pattern *quieter* rather than the abuse harder.
--
-- Ownership being server-side is the entire reason this backend exists (see
-- ROADMAP-ownership.md). A server-side snapshot that outlives the wallet it was
-- derived from is a client-side collection with extra steps.
--
-- ══════════════════════════════════════════════════════════════════════════
-- (a) Why a trigger, and not the auth service's unlink handler
-- ══════════════════════════════════════════════════════════════════════════
--
-- The same argument 0013 § c made, unchanged and no weaker for being reused:
-- the auth service is not the only thing that removes rows from
-- `core.profile_addresses`. The table is deleted from by `ON DELETE CASCADE`
-- from `core.profiles`, by the wager suite's own fixtures
-- (`collectionLinkedAddresses.test.ts` deletes a link directly to simulate an
-- unlink), by the auth suite's cleanup, and by whatever psql session an operator
-- opens at 3am. An invariant that holds only when one particular service
-- remembers to call one particular function is not an invariant, it is a
-- convention with a good reputation.
--
-- And the failure mode of forgetting is the silent kind. Nothing raises, nothing
-- logs; a profile simply keeps a collection, and the only symptom is a ranked
-- standing that should not exist. Constraints and triggers are how the rest of
-- this schema refuses to depend on a caller's memory (0007's
-- `deposits.signature PRIMARY KEY`, 0010's `(profile_id, card_id)`, 0011's
-- source-scoped key, 0013's guard); this is the same move for the same reason.
--
-- ══════════════════════════════════════════════════════════════════════════
-- (b) DELETE and force a re-scan — not an inline re-reconcile
-- ══════════════════════════════════════════════════════════════════════════
--
-- The tempting alternative is to re-derive the collection from the REMAINING
-- wallets on the way out, so an honest player with two wallets keeps the cards
-- held by the one they did not unlink. It was rejected, for three reasons that
-- compound:
--
--   * It needs the chain. A re-reconcile means `eth_getLogs` plus an `ownerOf`
--     per candidate token, per remaining wallet, on the unlink request path.
--     That is seconds of latency on an endpoint whose whole job is to delete one
--     row, against a public endpoint this project does not operate.
--   * It can fail. The RPC times out, the log window is refused, the node lags.
--     A failed re-reconcile leaves EXACTLY the stale snapshot this file exists
--     to remove — the failure mode of the fix is the bug.
--   * It cannot be done here anyway. A trigger has no network, so it would have
--     to move back into the application, which is where (a) came in.
--
-- Deleting is one indexed statement, cannot fail halfway, needs nothing outside
-- the transaction it is already in, and fails CLOSED: the worst case is that a
-- player who genuinely owns their cards has to press SCAN CHAIN once. The
-- opposite design's worst case is a collection nobody controls.
--
-- The `core.card_ownership_sync` row goes with the cards, and that is not
-- tidying. 0011 made the EXISTENCE of that row mean "this profile has been
-- enumerated at least once", and `collectionService.getMyCollection` turns it
-- into `synced: false` — which the client already renders as "your collection
-- has not been read from the chain yet" with a SCAN CHAIN button. Leaving the
-- row behind after emptying the cards would produce the one state 0011 went out
-- of its way to make unrepresentable: `synced: true, cards: {}`, the server
-- asserting the player owns nothing, immediately before refusing them a seat
-- over it. Deleting both puts the profile back into the honest never-synced
-- state, and the UX for that state already exists.
--
-- ══════════════════════════════════════════════════════════════════════════
-- (c) `source = 'booster'` rows are NOT touched
-- ══════════════════════════════════════════════════════════════════════════
--
-- This is the whole point of 0011's discriminator. Booster cards were granted by
-- us inside `redeemTicket()`; they were never on a chain and are not tied to any
-- wallet, so a wallet leaving the profile says nothing whatsoever about them.
-- Deleting them would destroy a paid item because of an unrelated action — the
-- exact bug 0011 exists to prevent, arriving from a new direction.
--
-- Both DELETEs below are scoped by `source`, the same way every statement in
-- `services/wager/src/db/ownership.ts` is. That `AND source = 'chain'` is not
-- decoration; it is the safety property of this file.
--
-- ══════════════════════════════════════════════════════════════════════════
-- (d) ON DELETE CASCADE is exempt, by the same test 0013 § 5 uses
-- ══════════════════════════════════════════════════════════════════════════
--
-- `DELETE FROM core.profiles` cascades into `core.profile_addresses`, and the
-- game suite's fixtures do exactly that on every `beforeEach`
-- (`DELETE FROM core.profiles WHERE address = ANY(...)`). PostgreSQL removes the
-- parent row first and runs the referential action afterwards in the same
-- transaction, so `NOT EXISTS (SELECT 1 FROM core.profiles WHERE id = ...)` is a
-- reliable "this is a cascade, not an unlink" test — 0013 § 5 already relies on
-- it, and this file reuses it rather than inventing a second signal that could
-- disagree with the first.
--
-- The exemption is safe because it CANNOT leak. `core.card_ownership.profile_id`
-- (0010) and `core.card_ownership_sync.profile_id` (0011) both carry
-- `REFERENCES core.profiles(id) ON DELETE CASCADE` of their own, so a deleted
-- profile's cards are removed by the same statement that removed its address
-- rows, whether or not this trigger does anything. Skipping is not a hole; it is
-- declining to delete rows that are already on their way out.
--
-- The exemption is worth having because it keeps the trigger's MEANING exact. A
-- profile ceasing to exist is not a wallet being given up, and this trigger
-- models the second thing. It also keeps fixture teardown from firing two
-- full-table deletes per address row across three suites, but that is a benefit,
-- not the reason.
--
-- What the exemption does NOT do is weaken the unlink case. Every path that
-- removes a link while the profile survives — the auth service's `unlinkAddress`,
-- a fixture, a manual psql DELETE — lands in the branch below and clears the
-- snapshot. And note that 0013 § 5 already refuses to unlink the last address or
-- the primary without promoting first, so the only deletes that reach here with
-- a live parent are genuine secondary unlinks: precisely the borrowed wallet.

-- ══════════════════════════════════════════════════════════════════════════
-- 1. The trigger
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION core.profile_addresses_clear_chain_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM core.profiles WHERE id = OLD.profile_id) THEN
        -- Cascade from a profile delete. Its cards cascade too; see § d.
        RETURN NULL;
    END IF;

    -- Chain-sourced rows only. Booster grants are a different partition and a
    -- different truth (0011, § c above).
    DELETE FROM core.card_ownership
     WHERE profile_id = OLD.profile_id
       AND source = 'chain';

    -- And the profile goes back to "never synced", so the client prompts for a
    -- scan instead of reporting an empty collection as fact (§ b).
    DELETE FROM core.card_ownership_sync
     WHERE profile_id = OLD.profile_id;

    RETURN NULL;
END;
$$;

-- AFTER, not BEFORE: the snapshot should be dropped because a link WAS removed,
-- not because one is about to be attempted. A BEFORE trigger also runs ahead of
-- 0013's `profile_addresses_guard_unlink`, which is what refuses to unlink the
-- last address or the primary — so a refused unlink would still have wiped the
-- collection on its way to raising. Ordering between two BEFORE triggers is
-- alphabetical, which is not a thing to stake a player's collection on.
--
-- FOR EACH ROW, matching 0013's guard. Unlinks arrive one row at a time (the
-- auth service's DELETE is keyed on `(profile_id, address, chain)`), and a
-- multi-row delete simply repeats a statement that has already removed
-- everything it can find. Idempotent by construction, so there is nothing to
-- gain from a statement-level trigger and a transition table.
DROP TRIGGER IF EXISTS profile_addresses_clear_chain_ownership ON core.profile_addresses;
CREATE TRIGGER profile_addresses_clear_chain_ownership
    AFTER DELETE ON core.profile_addresses
    FOR EACH ROW EXECUTE FUNCTION core.profile_addresses_clear_chain_ownership();

COMMENT ON FUNCTION core.profile_addresses_clear_chain_ownership() IS
    'Unlinking a wallet drops the profile''s ENTIRE chain-sourced collection (core.card_ownership WHERE source = ''chain'') and its core.card_ownership_sync row, so the profile falls back to the honest never-synced state and must re-scan to prove what it still holds. Stops "borrow a wallet, link, sync, unlink, keep the cards", which the 30-day relink cooldown does not address because it constrains the lender rather than the borrower. Booster-granted rows are left untouched — they were never derived from a wallet (0011). Exempts ON DELETE CASCADE by testing whether the parent profile still exists, the same test 0013''s unlink guard uses; a deleted profile''s cards cascade on their own.';

-- ══════════════════════════════════════════════════════════════════════════
-- 2. Backfill — profiles that are ALREADY holding a stale snapshot
-- ══════════════════════════════════════════════════════════════════════════
--
-- The trigger above only covers unlinks from now on. Any profile that unlinked a
-- wallet between 0013 landing and this file landing is still sitting on exactly
-- the snapshot this migration exists to remove, and it will sit on it forever,
-- because nothing re-reads it.
--
-- `core.profile_address_unlinks` is what makes those profiles findable: 0013 § 2
-- records every genuine unlink permanently, precisely so the pattern is visible
-- after the fact. A profile is stale if its most recent unlink is NEWER than the
-- sync its stored cards came from — i.e. `synced_at <= unlinked_at`. A profile
-- that has re-synced since its last unlink has already proved what it holds and
-- is left alone; clearing it would cost a real player a scan for nothing.
--
-- A profile with chain rows and NO sync row at all is also cleared. That pairing
-- should be unreachable (`recordSync` runs in the same transaction as the
-- reconcile), and if it exists the rows cannot be attributed to any enumeration,
-- which is the definition of a snapshot that cannot be trusted.
--
-- ORDER MATTERS: the cards go first, because the staleness test reads
-- `core.card_ownership_sync` and deleting those rows first would erase the
-- evidence the first statement needs. Both statements are re-runnable — a second
-- pass finds no chain rows and no sync rows for the same profiles — so this
-- block satisfies the house rule the same way 0013 § 3's backfill does.
DO $$
DECLARE
    cleared_cards bigint;
    cleared_syncs bigint;
BEGIN
    DELETE FROM core.card_ownership o
     WHERE o.source = 'chain'
       AND EXISTS (
             SELECT 1
               FROM core.profile_address_unlinks u
               LEFT JOIN core.card_ownership_sync s ON s.profile_id = u.profile_id
              WHERE u.profile_id = o.profile_id
                AND (s.profile_id IS NULL OR s.synced_at <= u.unlinked_at)
           );
    GET DIAGNOSTICS cleared_cards = ROW_COUNT;

    DELETE FROM core.card_ownership_sync s
     WHERE EXISTS (
             SELECT 1
               FROM core.profile_address_unlinks u
              WHERE u.profile_id = s.profile_id
                AND s.synced_at <= u.unlinked_at
           );
    GET DIAGNOSTICS cleared_syncs = ROW_COUNT;

    -- RAISE NOTICE, not EXCEPTION: unlike 0013 § 3, finding rows here is not a
    -- broken invariant, it is this migration doing the job it was written for.
    -- It is announced because the affected players will be asked to re-scan and
    -- whoever runs the deploy should know how many that is.
    IF cleared_cards > 0 OR cleared_syncs > 0 THEN
        RAISE NOTICE
            'profile_addresses_stale_ownership_cleared: removed % chain-sourced card row(s) and % sync row(s) belonging to profiles that unlinked a wallet after their last sync. Those profiles now report synced = false and must re-scan.',
            cleared_cards, cleared_syncs;
    END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 3. No new SQLSTATE, and no new table
-- ══════════════════════════════════════════════════════════════════════════
--
-- This file raises nothing. 0013 § 8's CH001/CH002/CH003 exist because an unlink
-- can be REFUSED and the auth service has to turn each refusal into a distinct
-- client-visible reason. Clearing a snapshot is never a refusal — the unlink
-- succeeds, and the collection is rebuilt by the player's next scan — so there is
-- nothing for a client to branch on and nothing to translate.
--
-- The audit trail also already exists and is not duplicated here: 0013 § 2's
-- `core.profile_address_unlinks` records who unlinked what and when, which is
-- exactly the row that explains why a collection reset. A second history table
-- for the consequence of a recorded cause would be two things to keep in step.
--
-- ══════════════════════════════════════════════════════════════════════════
-- 4. Grants: still none, still correct
-- ══════════════════════════════════════════════════════════════════════════
--
-- As with 0010 and 0013: there are no per-service database roles. Every service
-- connects as the single POSTGRES_USER, and "only auth writes
-- core.profile_addresses" is a convention held up by code review and route
-- ownership. The invariant in § 1 is enforced for every writer precisely because
-- it is a trigger rather than a permission.
