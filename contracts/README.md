# WagerEscrow — On-Chain Virtual Arena wager contract (Robinhood Chain)

`WagerEscrow` escrows 1v1 wagered matches on Robinhood Chain (EVM L2, chain id **4663**).
Both players stake an ERC-20; the game server (the `operator`) reports the winner on
match end, and the pot (minus an optional rake) is credited to the winner for withdrawal.

## Match flow

1. **Operator** `createMatch(id, p1, p2, wager)` — opens a match (`id` = the game's matchID hashed to bytes32).
2. Each **player** `approve()`s the token then `deposit(id)` — stakes are pulled in with balance-delta accounting (fee-on-transfer safe). When both are in, the match is `Funded`.
3. On match end the **operator** calls `settle(id, winner)` (or `settleDraw(id)`). The pot minus rake is credited to the winner; the rake accrues to `feeRecipient`.
4. Anyone with a credit balance calls `claim()` to withdraw (pull payment).

**Safety valves** (no funds can ever be locked):
- `cancelMatch(id)` — operator aborts, refunding deposits.
- `reclaim(id)` — permissionless: refunds if a match isn't funded within `fundingTimeout` (default 1h) or isn't settled within `settleTimeout` (default 1d) after funding.

## Security

Built to the ethskills checklist: OpenZeppelin **SafeERC20** for all transfers, **balance-delta**
accounting for fee-on-transfer tokens, **ReentrancyGuard** + checks-effects-interactions on every
external-call path, operator-gated settlement, and **pull payments** (winners withdraw; the contract
never pushes). Rake is capped at 20% (2000 bps). `pragma ^0.8.20`, OZ v5.

## Build / test

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build
forge test -vvv          # unit + fuzz (pot conservation, rake split, timeouts, access control)
```

## Deploy to Robinhood Chain

```bash
export ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com   # public + keyless; never commit a provider key
export PRIVATE_KEY=0x...            # deployer (becomes owner)
export WAGER_TOKEN=0x...            # $MASTER ERC-20 on Robinhood Chain
export OPERATOR=0x...               # the game server's settle wallet
export FEE_RECIPIENT=0x...          # rake sink
export RAKE_BPS=1000                # 10% (matches CUSTODIAL_BURN_BPS)
forge script script/Deploy.s.sol:Deploy --rpc-url robinhood --broadcast
```

## Server / client integration (next step)

- **Client** (deposit): the player's wallet `approve`s the escrow for `wager`, then calls `deposit(id)`. Use viem/wagmi against chain 4663.
- **Server** (`src/server-wager.ts` EVM port): on match creation call `createMatch`; on the boardgame.io match end, the server's `OPERATOR` key calls `settle(id, winner)` — this is the "automatic payout on match won." The server signs with a private key held only server-side (never shipped to the client).
- `id` = `keccak256(matchID)` so the onchain id maps 1:1 to the game's match.

This contract replaces the Solana Anchor `master_wager` program (`solana/programs/master_wager`) for the Robinhood Chain migration.
