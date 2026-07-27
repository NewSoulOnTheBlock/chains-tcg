-- 0009_robinhood_chain.sql
-- Add Robinhood Chain (EIP-155 id 4663) as a first-class identity namespace and
-- move the accounts that were created under the wrong one.
--
-- ── Why this exists ────────────────────────────────────────────────────────
-- The game runs on Robinhood Chain and on nothing else, but the chain registry
-- in `packages/shared/src/chains.ts` only knew ethereum | base | arbitrum |
-- polygon | solana. The web app therefore signed in with `ethereum` as a stand-
-- in: the signature verified (EIP-191 ecrecover is chain-agnostic), but the
-- message the user read said "Chain ID: 1" while their wallet was on 4663, and
-- every profile was recorded under a chain the app never touches.
--
-- `core.profiles` is UNIQUE (address, chain). That makes the slug part of the
-- identity: the same wallet under a different slug is a DIFFERENT PROFILE, with
-- a different id, different decks and a different match history. Changing the
-- app's slug without this migration would strand every existing account behind
-- an inaccessible row. That is why the data move and the registry change ship
-- together, and why doing it now — while only throwaway accounts exist — was
-- the last cheap moment.
--
-- ── What is moved, and what deliberately is not ────────────────────────────
-- MOVED:      chain = 'ethereum'  →  chain = 'robinhood'
--             Every such row was minted by this app's own sign-in flow or by
--             the API-layer verification scripts, both of which hardcoded
--             'ethereum'. At the time of writing that is 8 rows, all created
--             on 2026-07-27, none with any on-chain history. No wallet in this
--             database was ever a genuine Ethereum-mainnet identity, because
--             the only client that can reach this deployment is the web app,
--             and the web app only ever runs on 4663.
--
-- NOT MOVED:  chain = 'base' (3 rows). Those come from the backend's own
--             `scripts/verify-*.mjs` / `smoke-auth.mjs`, which sign in on
--             'base' and 'solana'. They are test fixtures for a different
--             namespace, not misfiled app accounts, and rewriting them would
--             invent an identity the app never created.
--
-- NOT MOVED:  `auth.nonces`. Those rows are the single-use-challenge audit
--             trail with a 5-minute TTL. Rewriting `chain` there would falsify
--             a record of what was actually signed. They expire on their own.
--
-- ── Safety ────────────────────────────────────────────────────────────────
-- The UNIQUE (address, chain) constraint cannot be violated by this file:
--   * the UPDATE skips any address that ALREADY has a 'robinhood' row, so it
--     can never collide with an existing target;
--   * the source rows are distinct by construction — UNIQUE (address,
--     'ethereum') means no two of them share an address — so the statement
--     cannot collide with itself either.
-- It is therefore idempotent: a second run matches zero rows.

-- ── 1. Move the misfiled profiles ──────────────────────────────────────────
UPDATE core.profiles p
   SET chain = 'robinhood'
 WHERE p.chain = 'ethereum'
   AND NOT EXISTS (
         SELECT 1
           FROM core.profiles q
          WHERE q.address = p.address
            AND q.chain   = 'robinhood'
       );

-- ── 2. Refuse to leave a split brain unannounced ───────────────────────────
-- If a wallet somehow held BOTH slugs, the row above was skipped rather than
-- guessed at. Surface it loudly instead of letting two half-identities sit
-- there silently. (Zero at the time of writing.)
DO $$
DECLARE
    stranded bigint;
BEGIN
    SELECT count(*) INTO stranded FROM core.profiles WHERE chain = 'ethereum';
    IF stranded > 0 THEN
        RAISE WARNING
            'chain_migration_incomplete: % core.profiles row(s) still on chain=''ethereum'' because the same address already has a ''robinhood'' profile. Merge or delete them by hand — this migration will not guess which identity owns the decks and match history.',
            stranded;
    END IF;
END $$;

-- ── 3. Invalidate sessions minted under the old namespace ──────────────────
-- Access tokens carry a `chain` claim. Authorization keys on `sub` (the profile
-- id), never on the claim, so a stale one grants nothing it did not already
-- grant — but a token asserting `chain: "ethereum"` for a profile now recorded
-- as `robinhood` is a lie, and `deriveRoles()` matches OPERATOR_ADDRESSES on
-- `chain:address`. Revoking the refresh families forces one clean re-sign under
-- the correct namespace; the 15-minute access tokens age out on their own.
UPDATE auth.sessions s
   SET revoked_at = now()
  FROM core.profiles p
 WHERE s.profile_id = p.id
   AND s.revoked_at IS NULL
   AND p.chain = 'robinhood';

-- ── 4. Keep the column's documentation honest ──────────────────────────────
-- 0002_core.sql is applied and checksummed; it cannot be edited. Restate the
-- comment here, which is the only forward-only way to correct it.
COMMENT ON COLUMN core.profiles.chain IS
    'Chain slug from CHAINS in packages/shared/src/chains.ts: solana | ethereum | base | arbitrum | polygon | robinhood. THE WEB APP SIGNS IN WITH ''robinhood'' (Robinhood Chain, EIP-155 4663) — that is the namespace real accounts live in. Part of UNIQUE (address, chain): changing which slug the app sends strands every account created before the change (see migration 0009).';
