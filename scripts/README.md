# scripts/

What each script is for and whether it is still live for **Egregore TCG**.
None contain hardcoded secrets — they read keys from `process.env`.

| Script | Purpose | Status |
|---|---|---|
| `render-cards.mjs` | Render every card to PNG via the Vite dev server + Playwright (`npm run render:cards`). Only consumer of the `playwright`/`wait-on` devDeps. | **Current** dev utility |
| `export-masterquest-lore.mts` | Bundle the masterquest lore (`src/masterquest/lore.ts`) into `public/lore/masterquest.md`. | **Current** one-shot |
| `evm-deploy.mjs` | Compile (solc-js + OZ) and deploy `MasterToken` + `WagerEscrow` to Robinhood Chain. | EVM contracts are **deployed but unused** by the product; see review `contracts-12`, `contracts-19`. |
| `evm-deploy-pack.mjs` | Compile + deploy `CardPack` to Robinhood Chain. | EVM, deployed but unused; pack minting is gated off (`PACK_MINTING_AVAILABLE = false`). |
| `evm-check.mjs` / `evm-sim-mint.mjs` | Read-only chain checks / dry-run mint against the deployed EVM contracts. | EVM, unused by product. |
| `gen-nft-metadata.mts` | Generate ERC-721 metadata for every card. Card-index ordering must match `src/pack-evm.ts` (review `contracts-10`). | EVM, unused by product. |
| `attach-sprotos-to-collection.mts` / `mint-sprotos.mts` | OCVA/Memetic-Masters-era Solana scripts (reference `public/sproto-gremlin.json` etc.). | **Legacy** — verify relevance before use. |

Notes:
- The review flags the Solana/EVM-era scripts as written for the retired stack
  (`hygiene-21`). They are left in place (owned elsewhere) but documented here
  so their status is explicit.
- The old Koa-server deploy scripts and `render.yaml` have been removed with the
  legacy server.
