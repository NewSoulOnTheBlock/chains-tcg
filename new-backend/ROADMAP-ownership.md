# Card ownership — status and what remains

Status: **built and enforced.** Ownership is now server-side, derived from
on-chain NFT holdings, and ranked/wager seating is gated on it.

This file previously described a plan built on the wrong foundation. That is
corrected below, and the correction is kept visible on purpose — the mistake is
instructive and repeating it would be easy.

## The correction: where cards actually come from

The original plan assumed the backend's own booster flow
(`POST /wager/boosters/intents` → `confirm` → `redeem/digital`) was how players
obtain cards, and proposed recording ownership inside `redeemTicket()`.

That is not the live path, and it never was. Verified against chain 4663:

- `CardPack`, an ERC-721, is **deployed and in use** at
  `0x57200fb533b33823f8bd2ac8f3649e3b643830b3`.
  `cardCount() = 80`, `packPrice() = 0.0035 ETH`, `cardsPerPack() = 5` (+1 foil).
- The client calls `mintPack()` **directly, through the player's own wallet**,
  and decodes the `PackMinted(buyer, tokenIds, cardIndexes, foilTokenId)` event
  from the confirmed receipt. See `src/pack-evm.ts`, which states outright that
  the backend's booster tickets are "two different products".
- The backend's booster product reports `mintingEnabled: false` and has never
  issued anything.

So ownership recorded at `redeemTicket()` would have contained no card any
player actually holds. The lesson worth keeping: **the acquisition path was
verified on-chain, not inferred from the backend's own code.** The backend
described a product that was not the one running.

## How ownership works now

Cards a player holds are the ERC-721 tokens their authenticated wallet owns.
The wager service reads them and reconciles `core.card_ownership`; the game
service reads that table when seating.

**Card index → card id.** The on-chain `cardIndex` space is the non-Node
catalogue in catalogue order: `Object.values(CARDS).filter(c => c.type !== 'node')`,
array position = index, 80 entries. This is generated into
`public/nft/index.json` by `scripts/gen-nft-metadata.mts`, and that same
derivation is what the contract's `baseURI` serves as token metadata.
`services/wager/src/nft/cardIndex.ts` is a flat 80-entry list taken from it.

This mapping is the most fragile thing in the whole feature. **Inserting a card
into `src/cards.ts` shifts every index after it, and every stored ownership row
silently becomes a different card.** It is guarded in three places: a test that
re-derives the list from `src/cards.ts` and compares element by element, an
opt-in live check against `cardCount()`, and `assertMatchesChain()` which runs
on every sync before any write. `cardCount` is `immutable` in the contract, so a
mismatch always means the manifest moved, never the chain.

**Enumeration.** `eth_getLogs` on `Transfer` filtered to the holder gives
candidate token ids; each is confirmed with `ownerOf` so tokens the player has
**sold or transferred away** are dropped; `cardOf(tokenId)` gives the index.
These are tradeable NFTs, so a stale snapshot is an exploit rather than a
cosmetic lag.

**Reconcile, not increment.** A sync sets the profile's chain-sourced holdings
to exactly what the chain says and removes what is no longer held. An
additive-only sync would let a player mint, sync, sell, and keep playing the
cards forever. A partial enumeration therefore **throws rather than returning a
short list** — under a full reconcile, a truncated read deletes holdings.

**Reading it back:** `GET /wager/collection` (own collection only, address comes
from the authenticated context, never from a request field — audit H-2),
`POST /wager/collection/sync` to refresh, rate-limited because each call is a
chain scan.

## Enforcement

`services/game/src/lib/seating.ts` gates seating on `core.card_ownership`:

- **By quantity.** A deck running 3 copies requires `qty >= 3`. Checking mere
  presence would let one pull unlock a full playset.
- **Basic Nodes are exempt** — granted to everyone, and not part of the 80-card
  index space.
- **Denylist, not allowlist.** `casual` is the only exempt mode. `wager` is
  gated too: its value at risk is higher than ranked's, so exempting it would
  leave the one mode where cheating pays cash as the one mode unchecked. A mode
  added later is gated until someone excuses it on purpose.
- **Both seats, and the host again at join time.** `seat0_deck_id` pins *which*
  deck, not its contents, and `core.decks.cards` stays editable while a match
  sits open — so a host could open a ranked match with a legal deck, swap in the
  full catalogue, and wait. The re-check closes that. Its failures return
  `409 { reason: 'host_deck_unowned' }` with no card names, because a decklist
  must never cross the table (H-7).
- The join path reads its mode from the `FOR UPDATE`-locked `game.matches` row,
  never from the request body.
- Failure is `400` with `reason: 'unowned_cards'` and one `issues` entry per
  card (`cardId`, `need`, `owned`). The client already branches on
  `err.reason` and renders `err.issues` individually — this needed no client
  change.

Ownership is `qty > 0`, never `EXISTS(...)`. A zero row records history, not
possession.

## Deliberately not done

**`BOOSTER_CARD_POOL` stays empty.** Populating it switches on a second,
server-side card source that rolls different cards from the NFTs players
actually hold, into the same key space, with a prize attached. Two competing
ownership truths is a worse failure than one dormant product. Digital redemption
answering 503 is the correct state.

`redeemTicket()` does write ownership (`source = 'booster'`) for the day that
product ships. It is unreachable while the pool is empty.

## What still blocks a prize

1. **Nobody can field a deck yet.** Decks are 60 cards, max 4 copies of any
   non-basic. With 6 cards per pack and duplicates possible, a legal ranked deck
   needs roughly 7-10 packs per player. Chain state as of this writing:
   `nextId = 6` — **one pack has ever been minted.** Ranked is correctly gated
   but will stay empty until packs actually sell.

2. **No ladder exists.** Rating store, seasons, queue and pairer, placements, a
   standings read model — none of it is built server-side.
   `src/ranked-client.ts` documents the endpoints the client expects.

3. **The money path points at the wrong network.** The production RPC proxy
   answers `eth_chainId` with `0xaa36a7` (Sepolia, 11155111) while the game,
   the contracts and the sign-in chain are all 4663. Compose defaults are
   Sepolia too (`EVM_CHAIN_ID: 11155111`). Escrow deposit verification and
   settlement therefore watch a network no player transacts on. The ownership
   sync sidesteps this with its own 4663-pinned reader, which verifies
   `eth_chainId` once per process and refuses to run otherwise; the wager money
   path does not.

4. **Escrow custody.** `escrows.deposit_address` is a hot-wallet EOA whose key
   is an environment variable — separate from the `WagerEscrow` contract that
   *is* deployed at `0xdbc49ff2cf44d2ba1a844d80d1f82d472440cc3d` on 4663 and
   goes unused. No payout has ever executed on a real chain.

5. **A live Alchemy API key is committed** in `contracts/deployment.json`.
   Rotate it. Nothing in the backend uses it — the ownership reader uses
   Robinhood's public keyless endpoint — but it is readable by anyone with the
   repo.

6. **Pack randomness is grindable.** `CardPack._rand` derives from
   `block.prevrandao`, `block.timestamp` and `msg.sender`. `mintPack` is
   callable from a contract, so a caller can simulate the roll and revert on a
   bad one, paying only gas. Acceptable for a low-stakes game, as the contract's
   own comment says; worth reconsidering before real value rides on pulls.
