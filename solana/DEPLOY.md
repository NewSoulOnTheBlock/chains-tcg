# Memetic Masters — $MASTER Wager Program Deploy Runbook

The on-chain wager program is an Anchor (v0.32.1) Solana program that escrows
$MASTER deposits from two players, burns 10% of the total pot on settle, and
sends the remaining 90% to the winner.

- **Program ID** (default): `9JnG7C3uBVnMgx5tSAxSb9ccSuwCC4LkmyV26goXe1pC`
- **$MASTER mint**: `DpPowzjETiU6421ReuwBB8XmDB7sMyB2JGzFLssYpump` (6 decimals)
- **Burn rate**: 10% of pot (1000 bps; max 20%)
- **Cancel timeout**: 15 min before Open matches can be cancelled by creator

---

## 1. Build (requires WSL / Linux / Docker)

`anchor build` on native Windows hits a known symlink bug in the
`platform-tools-windows-x86_64.tar.bz2` v1.48 bundle that ships with
`solana 2.2.x` — extraction fails with OS 183. Build inside WSL2 instead:

```bash
# in WSL Ubuntu, one-time setup:
sh -c "$(curl -sSfL https://release.solana.com/v1.18.20/install)"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.32.1 && avm use 0.32.1

# build:
cd /mnt/c/Users/roota/chains-tcg/solana
anchor build
```

The compiled artifact lands at `target/deploy/master_wager.so`. Verify the
program id matches `declare_id!` in `programs/master_wager/src/lib.rs`:

```bash
solana address -k target/deploy/master_wager-keypair.json
# → 9JnG7C3uBVnMgx5tSAxSb9ccSuwCC4LkmyV26goXe1pC
```

## 2. Fund the deployer wallet

You need ~3 SOL to deploy a fresh program of this size.

```bash
solana config set --url mainnet-beta
solana address                # show deployer pubkey
# fund it via exchange withdrawal / Phantom transfer, etc.
solana balance
```

## 3. Deploy

```bash
solana program deploy \
  target/deploy/master_wager.so \
  --url mainnet \
  --keypair ~/.config/solana/id.json \
  --program-id target/deploy/master_wager-keypair.json
```

Save the printed program id (should match the one above).

## 4. Generate the oracle keypair

The oracle is the only key allowed to call `settle_match`. It lives on the
Render server and signs settle txs when a wagered game ends.

```bash
cd /mnt/c/Users/roota/chains-tcg/solana
ts-node scripts/gen-oracle.ts
```

This writes `oracle.json` and prints:
- the oracle pubkey
- the `SOLANA_ORACLE_KEYPAIR=[…]` line to paste into Render env vars

**Fund the oracle** with ~0.1 SOL so it can pay tx fees:

```bash
solana transfer <ORACLE_PUBKEY> 0.1 --allow-unfunded-recipient
```

## 5. Initialize the Config PDA

This must be run once. Sets oracle, burn rate, cancel timeout, min wager.

```bash
ORACLE_PUBKEY=<ORACLE_PUBKEY> ts-node scripts/initialize.ts
```

## 6. Configure Render

Add these env vars on the Render service:

- `SOLANA_ORACLE_KEYPAIR` — full JSON byte array from step 4
- `SOLANA_RPC` *(optional)* — e.g. Helius / Quicknode mainnet URL. Default is
  the public `api.mainnet-beta.solana.com` which is rate-limited.
- `VITE_SOLANA_RPC` *(optional)* — same URL for the frontend bundle.

Redeploy the service.

## 7. Smoke test on mainnet

1. Open the lobby in two Phantom sessions (e.g. two browser profiles).
2. Create a wagered match with the smallest allowed amount (1 $MASTER).
3. Both wallets sign deposit txs.
4. Play the match to completion.
5. Check on-chain: the winner's ATA receives 1.8 $MASTER and 0.2 $MASTER is
   burned (decreases total supply).

```bash
spl-token balance <WINNER_ATA>
spl-token display DpPowzjETiU6421ReuwBB8XmDB7sMyB2JGzFLssYpump
```

---

## Open issues / future work

- **Draws and disconnects.** The game can technically end in a draw or a
  permanent disconnect. The program has no `expire_match` instruction yet, so
  matches in the `joined` state with no winner stay stuck. Mitigation for v1:
  the server only flags a winner when `ctx.gameover.winner` is set; on a draw
  no settle is sent and funds remain in the vault. Add an oracle-only
  `expire_match` (returns both deposits) before this becomes a real problem.
- **Oracle as single point of compromise.** If the Render dyno is compromised
  the attacker can drain any active wager to themselves. v2: multisig or
  time-locked oracle.
- **$MASTER decimals.** Hardcoded to 6. Verify before deploy via
  `spl-token display DpPowzjETiU6421ReuwBB8XmDB7sMyB2JGzFLssYpump`.
