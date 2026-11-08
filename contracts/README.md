> ## ⚠️ These source fixes do NOT change the deployed bytecode
>
> The 2026-11-01 review (`docs/review/2026-11-01-code-review.md` §3, §7) fixed the audit
> findings (H-4, H-8, H-10, H-11, L-6, L-7, L-9 and the `contracts-*` items) **in source
> only**. The contracts already live on-chain and are **not redeployed** by editing these
> files, so the deployed instances still carry every original vulnerability. The fixes take
> effect only on a fresh redeploy to new addresses.
>
> **Currently deployed (unchanged, still vulnerable) — Robinhood Chain (chain 4663):**
> | Contract | Address |
> |---|---|
> | MasterToken | `0x66cf995bac9f4732c7cfed515811a79872a497c3` |
> | WagerEscrow | `0xdbc49ff2cf44d2ba1a844d80d1f82d472440cc3d` |
> | CardPack | `0x57200fb533b33823f8bd2ac8f3649e3b643830b3` |
> | deployer = owner = operator = feeRecipient | `0x793a5e8b8Ff431cC2D8eE41e8ec2D9ad70247E60` |
>
> **Solana (mainnet-beta):** `master_wager` program `9JnG7C3uBVnMgx5tSAxSb9ccSuwCC4LkmyV26goXe1pC`.
>
> **Status (contracts-12): these contracts are DEPLOYED BUT UNUSED by the product.** Live
> wagers run through `new-backend`'s own escrow wallet; CardPack minting is gated off in the
> client (`src/pack-evm.ts` `PACK_MINTING_AVAILABLE = false`). No real funds sit in these
> contracts. Before wiring any of them into the product, redeploy from this fixed source and
> re-audit — do not point production at the addresses above.

# WagerEscrow — On-Chain Virtual Arena wager contract (Robinhood Chain)

`WagerEscrow` escrows 1v1 wagered matches on Robinhood Chain (EVM L2, chain id **4663**).
Both players stake an ERC-20; the game server (the `operator`) reports the winner on
match end, and the pot (minus an optional rake) is credited to the winner for withdrawal.

## Match flow

1. **Operator** `createMatch(id, p1, p2, wager)` — opens a match (`id` = the game's matchID hashed to bytes32). The current rake and timeouts are **snapshotted onto the match**.
2. Each **player** `approve()`s the token then `deposit(id)` — stakes are pulled in with balance-delta accounting (fee-on-transfer safe). When both are in, the match is `Funded`.
3. On match end the **operator** calls `settle(id, winner)` (decisive) or `settleDraw(id)` (draw/void, refunds both, no rake). The pot minus the snapshotted rake is credited to the winner; the rake accrues to `feeRecipient`.
4. Anyone with a credit balance calls `claim()` to withdraw (pull payment).

**Safety valves** (no funds can ever be locked):
- `cancelMatch(id)` — operator aborts, refunding deposits.
- `reclaim(id)` — permissionless: refunds if a match isn't funded within its snapshotted `fundingTimeout` (default 1h), or isn't settled within its snapshotted `settleTimeout` (default 1d) **plus a 1h operator-exclusive grace** after funding. The grace stops a losing player front-running `settle` with `reclaim` (contracts-05).

## Security

Built to the ethskills checklist: OpenZeppelin **SafeERC20** for all transfers, **balance-delta**
accounting for fee-on-transfer tokens, **ReentrancyGuard + checks-effects-interactions on every
external-call path** (deposit/settle/settleDraw/cancelMatch/reclaim/claim all `nonReentrant`,
so a hook-bearing token cannot cross-re-enter during a deposit — H-11/contracts-06),
operator-gated settlement, and **pull payments** (winners withdraw; the contract never pushes).
Rake is capped at 20% (2000 bps) and **snapshotted per match** so a later `setRake` cannot change
an open match (contracts-04). Timeouts are **bounded** (funding ≤ 24h, settle ≤ 7d) and
**snapshotted per match**, so an admin change cannot retroactively lock stakes (H-10/contracts-03).
Ownership is **Ownable2Step** and `renounceOwnership` is disabled on all three contracts
(contracts-08). `pragma ^0.8.20`, OZ v5.

`MasterToken` mint is **capped** at `MAX_SUPPLY` (10M) — a leaked owner key can no longer mint
unbounded supply (H-4/contracts-07). `CardPack` uses **commit/reveal** randomness seeded from a
future blockhash plus an operator beacon (H-8/contracts-01, contracts-02), refunds overpayment,
enforces an optional on-chain supply cap, and rejects `withdraw(address(0))` (contracts-09).

### ⚠️ Single-EOA / key-management risk (audit H-4, contracts-07)

In the recorded deployment one externally-owned account
(`0x793a…7E60`) is **deployer = owner = operator = feeRecipient** across all three EVM
contracts, and the Solana `master_wager` oracle is a single server-held keypair. That one key
can settle matches, change rake/timeouts, drain CardPack revenue and (on the old bytecode) mint
unlimited MASTER. **A single leaked env var = every escrowed stake + unlimited token supply.**

Recommended before any production use:
- Transfer ownership of all three contracts to a **multisig or timelock** (then `acceptOwnership`).
- Run the `operator` on a **separate low-privilege hot key**, not the owner key.
- Point `feeRecipient` at a **treasury** address, not the deployer.
- On Solana, move the oracle to a multisig / time-locked authority (DEPLOY.md open issue).
- `MasterToken` supply is now capped in source; after distribution, hand ownership to a
  custodian that will never call `mint`.

### Key rotation (audit H-5, contracts-21)

A live **Alchemy RPC key** was committed to this repo (nine files) and is therefore
**compromised**. The source now uses the public keyless endpoint
(`https://rpc.mainnet.chain.robinhood.com`) everywhere and `deployment.json` carries a note,
but **removing it from the working tree does not rotate it** — it remains in git history and
remains valid until rotated at the provider.

Required actions (NOT yet confirmed done):
1. **Rotate/delete** the exposed Alchemy key in the Alchemy dashboard. Also rotate the Helius
   key if it was ever bundled into the client (audit H-5).
2. **Verify** the old key is dead: a request to the old endpoint with the old key must return
   401/403, and the Alchemy dashboard must show the key removed with no further usage.
3. Record the rotation **date and operator** here or in `SECURITY.md` once performed.
4. Treat the old key as burned; consider rewriting git history to purge it.
5. Never commit a provider key again — use env vars (`ROBINHOOD_RPC`, `VITE_*`), server-side only.

> Rotation status: **UNVERIFIED as of 2026-11-01.** No evidence in the repo that the key was
> actually rotated. Do not assume it was.

## Build / test

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build
forge test -vvv          # WagerEscrow + CardPack + MasterToken suites
```

> The Foundry test suites (`test/WagerEscrow.t.sol`, `test/CardPack.t.sol`,
> `test/MasterToken.t.sol`) were extended for the 2026-11-01 fixes but are **UNEXECUTED** in
> that review: `forge` is not installed and `contracts/lib` is not vendored in the checkout.
> They are written to compile by inspection against OZ v5 + forge-std. Run `forge test` before
> trusting them. There is no CI running `forge` yet (audit L-7 / hygiene-11).

## Deploy to Robinhood Chain

**Supported, reproducible path** — `forge script` with the compiler pinned in `foundry.toml`
(solc 0.8.24, 200 runs):

```bash
export ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com   # public + keyless; never commit a provider key
export PRIVATE_KEY=0x...            # deployer (becomes owner)
export WAGER_TOKEN=0x...            # $MASTER ERC-20 on Robinhood Chain
export OPERATOR=0x...               # the game server's settle wallet (NOT the owner key)
export FEE_RECIPIENT=0x...          # treasury / rake sink (NOT the deployer)
export RAKE_BPS=1000                # 10%
forge script script/Deploy.s.sol:Deploy --rpc-url robinhood --broadcast
```

The solc-js scripts (`scripts/evm-deploy.mjs`, `scripts/evm-deploy-pack.mjs`) are a fallback:
they **dry-run by default** (pass `--broadcast`), refuse a mainnet RPC without `--mainnet`,
read `OPERATOR`/`FEE_RECIPIENT` from env, merge into `deployment.json`, and refuse to run unless
the resolved solc matches the pinned `0.8.24`.

## Server / client integration (next step)

- **Client** (deposit): the player's wallet `approve`s the escrow for `wager`, then calls `deposit(id)`. Use viem/wagmi against chain 4663.
- **Server** (`OPERATOR` key): on match creation call `createMatch`; on the boardgame.io match end, the operator key calls `settle(id, winner)` / `settleDraw(id)`. The operator signs server-side only (never shipped to the client), and should be a key distinct from the owner.
- `id` = `keccak256(matchID)` so the onchain id maps 1:1 to the game's match.

This EVM contract set is the Robinhood Chain successor to the Solana Anchor `master_wager`
program (`solana/programs/master_wager`). Both are deployed but unused by the product today
(contracts-12); pick one and wire it in deliberately, or document them as retired.
