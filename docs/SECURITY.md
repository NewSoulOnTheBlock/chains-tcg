# Security

## Audit status

`SECURITY_AUDIT.pdf` (repo root) was committed on **2026-07-27** (commit
`62834ca`, the same commit that introduced `new-backend/`). As of this note,
**51 commits** have landed on top of that audit (`git rev-list --count
62834ca..HEAD`).

The audit therefore **predates** several security-relevant systems and cannot be
assumed to cover them. A re-audit is needed, scoped at least to:

- **Privy authentication** — the login/auth path added since the audit.
- **Vercel Postgres functions** — `api/chat.ts` and `api/presence.ts`
  (Neon-backed hub chat and presence).
- **EVM booster packs** — `src/pack-evm.ts`, `scripts/evm-deploy*.mjs`, and the
  `CardPack`/`MasterToken`/`WagerEscrow` contracts under `contracts/`.
- The `new-backend/` services as they exist now (auth, profile, game, wager).

Keeping the PDF at the repo root with no date/scope note implies coverage the
document cannot have; treat it as the **2026-07-27 snapshot only**.

## Where the current findings live

The 2026-11-01 code review re-examined the live paths and lists the open,
verified security items (TLS verification on Postgres pools, token revocation,
sign-in nonce consumption, chat admin identity, payout runner, smart-account
deposits, and the deployed-but-unused contract findings H-4/H-8/H-10/H-11). See:

- `docs/review/2026-11-01-code-review.md`
- `docs/review/2026-11-01-findings.json`

No conclusions beyond those documents are asserted here; this file only records
that the standalone PDF audit is stale and names what a follow-up review must
cover.

## Key rotation note (unverified)

`contracts/deployment.json` carries a note that a previously-committed Alchemy
RPC key is compromised and must be rotated (audit H-5). The key was removed from
the working tree but remains in git history, and there is no record in this repo
that the dashboard rotation actually occurred. Confirm rotation and record the
date here. (Review items contracts-21.)
