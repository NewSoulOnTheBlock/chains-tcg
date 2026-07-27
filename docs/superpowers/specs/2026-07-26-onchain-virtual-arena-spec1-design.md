# On-Chain Virtual Arena — Spec 1: Rebrand + Chain Roster Rework

**Date:** 2026-07-26
**Status:** Approved design (ready for implementation plan)
**Repo:** `chains-tcg`

## Context

The existing game "Memetic Masters TCG" is a boardgame.io, MTG-style turn-based card
game where each of 5 blockchains is a mechanical "color" with a full card pool
(1 node + 8 memes + 4 machines + 3 moves + 1 aura). We are remaking it into
**On-Chain Virtual Arena**, reframed as a **Robinhood app running on Robinhood Chain**
(EVM L2, Arbitrum Orbit, chain ID 4663).

The full remake is decomposed into five specs:

- **Spec 1 (this doc):** Rebrand + chain roster rework.
- Spec 2: Masterquest campaign lore rewrite + boosters/NFT showcase content.
- Spec 3: Onchain migration (Solana → Robinhood Chain: EVM wallet, wager contract, NFT indexing). Gated on ethskills.

The new chain roster is **Ethereum / Solana / BNB / Robinhood / Base** (dropping AVAX + XRP).

## Goal

Ship a fully playable, renamed, rebalanced 5-chain game with cohesive, distinct
mechanical identities — **without touching the effect engine in `Game.ts`**. This is a
data + branding pass, not an engine change.

## Non-goals (deferred to later specs)

- Campaign/masterquest lore text rewrite (Spec 2).
- Booster pack + NFT showcase content changes (Spec 2).
- Any real onchain / wallet / wager migration to Robinhood Chain (Spec 3).
- New card art beyond remapping the existing pool + emoji/glyph fallbacks.
- New effect IDs or engine mechanics.

## Design

### 1. The 5-chain color pie

Each chain keeps the same shape (1 node + 8 memes + 4 machines + 3 moves + 1 aura)
but has a distinct mechanical role so the five are balanced against each other.

| Chain | Brand color | Role | Signature effects | Flavor |
|---|---|---|---|---|
| **BNB** | gold `#f3ba2f` | Aggro-ramp / go-wide | `extra_node_per_turn`, `pump_all_+1+1`, `pump_attackers_+1+0`, `meme_haste`, rug-pull `destroyMeme` | BSC memecoin casino, launchpads (kept) |
| **Solana** | purple `#9945ff` | Tempo / burn | `damage2/3`, `bounceMeme`, `gas_discount_color`, `on_meme_etb_draw` | MEV, snipers, high TPS (kept) |
| **Ethereum** | silver `#f5f5f5` | Control / finishers | `damage5`, `destroyMachine`, `gainLife4`, big top-end, ETB value | bluechip, L2s, smart contracts (kept) |
| **Robinhood** | RH green `#00C805` | Lifegain midrange | `lifelink_all`, `gainLife4`, `aura_+0+3`, sturdy big bodies, some draw | tokenized meme-stocks, dividends, diamond hands (NEW, replaces AVAX slot) |
| **Base** | Base blue `#0052FF` | Card-advantage aggro | `on_meme_etb_draw`, `drawTwo`, `meme_haste`, cheap swarm, `damageAll_1` | onchain summer, Coinbase L2, BRETT/DEGEN/TOSHI (NEW, replaces XRP) |

**Distinctness of the three aggressive chains:**
- BNB wins via mana + board width (extra nodes, wide pumps).
- Solana wins via reach (direct damage + bounce, low to the ground).
- Base wins via card advantage (draw engines + haste refilling the hand).
- Ethereum = slow removal-heavy control; Robinhood = grindy don't-die lifegain.

### 2. New card rosters (draft — final numbers tuned during implementation)

**Robinhood (lifegain midrange, green):**
- Memes: GME (diamond-hands wall, high toughness), AMC (apes together strong),
  HOOD, KITTY (Roaring Kitty), TENDIES, MOON, YOLO, APE.
- Machines: Dividend Reinvestment (`lifelink_all`), Options Chain (`pump_attackers_+1+0`),
  Fractional Shares (`on_meme_etb_draw`), Margin Account (`pump_all_+1+1`).
- Moves: Buy the Dip (`gainLife4`), Gamma Squeeze (`damage5`), Order Flow / PFOF (`drawTwo`).
- Aura: Diamond Hands (`aura_+0+3`).

**Base (card-advantage aggro, blue):**
- Memes: BRETT, DEGEN, TOSHI, MIGGLES, KEYCAT, NORMIE, DOGINME, BASED.
- Machines: Onchain Summer (`pump_all_+1+1`), Farcaster Frames (`on_meme_etb_draw`),
  Smart Wallet (`extra_node_per_turn`), Coinbase Onramp (`meme_haste`).
- Moves: Tip DEGEN (`drawTwo`), Base Bridge (`bounceMeme`), Airdrop Szn (`damageAll_1`).
- Aura: Based (`aura_+3+0`).

All effect IDs already exist in `src/cards.ts` `EffectId` and are implemented in
`Game.ts`. No engine work required.

### 3. Art remap

- Delete `avax_*` and `xrp_*` entries from the `IMAGES` map; add `robinhood_*` / `base_*`.
- Reassign `brett.png` from ETH → Base (BRETT is a Base token). ETH retains 8 art'd
  memes (andy/apu/wojak/turbo/mog/shib/pepe/sproto).
- Base reuses CMC logo art via the existing `cmc(id)` helper where a token has a logo,
  plus `brett.png`.
- Robinhood meme-stocks have no crypto logos → emoji glyphs via the existing `emo(cp)`
  helper (e.g. 💎🙌 🦍 🎮 🚀 🍗).
- `node_robinhood` / `node_base` fall back to the chain glyph unless a PNG is dropped
  into `public/nodes/`.
- Card templates: `template-avax.svg` / `template-xrp.png` references removed. Base and
  Robinhood reuse an existing per-color template or fall back to the glyph frame until
  bespoke art exists.

### 4. Code changes (data-only)

Primary file `src/cards.ts`:
- `Color` union + `COLORS` → `'bnb' | 'sol' | 'eth' | 'robinhood' | 'base'`.
- Rewrite `COLOR_META` (names, hex, ink, glyph, template) for the new roster.
- Delete the avax + xrp meme/machine/move/aura blocks; add robinhood + base blocks.
- Update `reg(N(...))` node registration, `STARTER_DECKS`, `DEFAULT_MATCHUP`
  (e.g. `['base', 'eth']`), and the `counts` object literal in `derivePrimaryColor`.

Secondary references (grep `avax`/`xrp` and fix): `Board.tsx` (per-color styling),
`bot.ts` (bot deck/color picks), ranked modules, and any masterquest color refs that
would break the build. Deep masterquest **lore text** is out of scope (Spec 2) — only
fix what is required for a clean typecheck/build.

`Game.ts` effect engine: untouched.

### 5. Rebrand surface (Spec 1)

Rename product shell + core game UI only (campaign lore text deferred to Spec 2):
- `index.html`: `<title>` + all meta/OG/twitter tags → **On-Chain Virtual Arena**;
  tagline reworked to a Robinhood-app framing.
- `public/manifest.webmanifest`: `name` / `short_name`.
- `README.md`: top section + chain table → new name + new roster.
- User-facing "Memetic Masters" / "Chains TCG" strings in `App.tsx`, `Board.tsx`,
  `Plaza.tsx`, `Voice.tsx`.
- **Flagged, not changed:** the hardcoded `masterstcg.com` OG/social domain — a
  deploy/DNS decision. Needs a new domain from the user before changing.

### 6. Error handling / edge cases

- `derivePrimaryColor` fallback color changes from `'sol'` default — keep a valid
  member of the new union.
- Any persisted decks / saved state referencing `avax_*` / `xrp_*` card ids will fail
  `validateDeck` (unknown card). Acceptable for this remake; no migration of old saves.
- Art fallback path (glyph render on image error) already exists and covers the emoji
  and missing-node cases.

## Testing

- `src/cards.test.ts`: assert exactly 5 chains; each chain has the full pool
  (8 memes + 4 machines + 3 moves + 1 aura + node); every `STARTER_DECKS[color]` passes
  `validateDeck` at 60 cards; cost-curve sanity (colored portion ≤ 3 via `splitCost`).
- Build/typecheck clean (no dangling `avax`/`xrp` references).
- Manual: `npm run dev`, play each new chain (Robinhood, Base) vs a kept chain; confirm
  art/glyph rendering, brand colors, and no old chain names leak into the UI.

## Open questions

- New production domain to replace `masterstcg.com` (or keep for now)?
- Exact final card stat numbers — tuned during implementation against the cost curve.
