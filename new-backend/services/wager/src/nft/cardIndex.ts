/**
 * The on-chain card-index space of the CardPack ERC-721
 * (0x57200fb533b33823f8bd2ac8f3649e3b643830b3, Robinhood Chain / 4663).
 *
 * GENERATED — DO NOT EDIT BY HAND. Array position IS the on-chain card index:
 * `CardPack.cardOf(tokenId)` returns a number that indexes directly into this
 * array, and `tokenURI` serves `<baseURI><index>.json`.
 *
 * Provenance, in one hop: `<repo>/scripts/gen-nft-metadata.mts` computes
 * `Object.values(CARDS).filter(c => c.type !== 'node')` and writes both the
 * per-index metadata files and `<repo>/public/nft/index.json`. This file is the
 * id column of that manifest, so the backend and the token metadata the contract
 * points at are the SAME derivation rather than two independent re-derivations.
 *
 * Re-sync with:
 *   node -e 'const s=require("./public/nft/index.json");console.log(s.cards.map(c=>c.id).join("\n"))'
 * (then re-apply this header), or re-run `scripts/gen-nft-metadata.mts` first.
 *
 * WHY NOT VENDOR `src/cards.ts` the way `services/game` does: this service never
 * evaluates a card. It needs one mapping, and vendoring the catalogue would mean
 * also vendoring the derivation (`Object.values` insertion order + the node
 * filter) and hoping it stays identical to the generator's. A flat list cannot
 * drift in derivation logic — only in content, which `__tests__/cardIndex.test.ts`
 * pins against the root catalogue and against the contract's `cardCount()`.
 *
 * THE DANGEROUS FAILURE MODE: inserting a card into `src/cards.ts` shifts every
 * later index, and every ownership row derived from an old index silently becomes
 * a different card. Nothing about that is visible at runtime. It is guarded in
 * two places — the test below, and `assertMatchesChain()`, which refuses to write
 * ownership when the contract disagrees about `cardCount`.
 */

/** Card id at each on-chain card index. Length MUST equal `CardPack.cardCount()`. */
export const CARD_INDEX: readonly string[] = [
  "bnb_babydoge",          // 0  BABYDOGE
  "bnb_broccoli",          // 1  BROCCOLI
  "bnb_tut",               // 2  TUT
  "bnb_tst",               // 3  TST
  "bnb_banana",            // 4  BANANA
  "bnb_mubarak",           // 5  MUBARAK
  "bnb_cheems",            // 6  CHEEMS
  "bnb_floki",             // 7  FLOKI
  "bnb_farm",              // 8  Volume Bot
  "bnb_bridge",            // 9  Token Launchpad
  "bnb_sniper",            // 10  Sniper Bot
  "bnb_mmalgo",            // 11  Market Maker Algo
  "bnb_rugpull",           // 12  Rug Pull
  "bnb_airdrop",           // 13  Airdrop Farm
  "bnb_honeypot",          // 14  Honeypot
  "bnb_liquidity",         // 15  Liquidity Injection
  "sol_pnut",              // 16  PNUT
  "sol_bonk",              // 17  BONK
  "sol_popcat",            // 18  POPCAT
  "sol_mew",               // 19  MEW
  "sol_bome",              // 20  BOME
  "sol_wif",               // 21  dogwifhat
  "sol_fartcoin",          // 22  FARTCOIN
  "sol_goat",              // 23  GOAT
  "sol_priority",          // 24  MEV Bundler
  "sol_oracle",            // 25  AI Trading Agent
  "sol_amm",               // 26  AMM Router
  "sol_tgbot",             // 27  Telegram Bot Suite
  "sol_zap",               // 28  Snipe
  "sol_bounce",            // 29  Frontrun
  "sol_tgpump",            // 30  Telegram Pump
  "sol_validator",         // 31  Validator Boost
  "robinhood_hood",        // 32  HOOD
  "robinhood_ozzy",        // 33  Ozzy
  "robinhood_cashcat",     // 34  Cashcat
  "robinhood_kitty",       // 35  KITTY
  "robinhood_tendies",     // 36  TENDIES
  "robinhood_moon",        // 37  MOON
  "robinhood_yolo",        // 38  YOLO
  "robinhood_ape",         // 39  APE
  "robinhood_dividend",    // 40  Dividend Reinvestment
  "robinhood_options",     // 41  Options Chain
  "robinhood_fractional",  // 42  Fractional Shares
  "robinhood_margin",      // 43  Margin Account
  "robinhood_buydip",      // 44  Buy the Dip
  "robinhood_gamma",       // 45  Gamma Squeeze
  "robinhood_pfof",        // 46  Order Flow
  "robinhood_diamond",     // 47  Diamond Hands
  "eth_andy",              // 48  ANDY
  "eth_apu",               // 49  APU
  "eth_wojak",             // 50  WOJAK
  "eth_turbo",             // 51  TURBO
  "eth_mog",               // 52  MOG
  "eth_shib",              // 53  SHIB
  "eth_pepe",              // 54  PEPE
  "eth_sproto_gremlin",    // 55  Sproto Gremlin
  "eth_eip1559",           // 56  Smart Contract Suite
  "eth_temple",            // 57  Dapp Ecosystem
  "eth_l2",                // 58  Layer 2 Rollup
  "eth_yield",             // 59  Yield Aggregator
  "eth_smite",             // 60  FUD Tweet
  "eth_heal",              // 61  DCA In
  "eth_exploit",           // 62  Exploit Disclosure
  "eth_shield",            // 63  Smart Contract Shield
  "base_degen",            // 64  DEGEN
  "base_toshi",            // 65  TOSHI
  "base_brett",            // 66  BRETT
  "base_miggles",          // 67  MIGGLES
  "base_keycat",           // 68  KEYCAT
  "base_normie",           // 69  NORMIE
  "base_doginme",          // 70  DOGINME
  "base_based",            // 71  BASED
  "base_summer",           // 72  Onchain Summer
  "base_frames",           // 73  Farcaster Frames
  "base_wallet",           // 74  Smart Wallet
  "base_onramp",           // 75  Coinbase Onramp
  "base_tip",              // 76  Tip DEGEN
  "base_bridge",           // 77  Base Bridge
  "base_airdrop",          // 78  Airdrop Szn
  "base_staybased",        // 79  Stay Based
];

/** How many distinct cards the contract was deployed with. */
export const CARD_COUNT = CARD_INDEX.length;
