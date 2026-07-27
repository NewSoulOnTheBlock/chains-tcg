# On-Chain Virtual Arena — Spec 1 Implementation Plan (Rebrand + Chain Roster Rework)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the game to *On-Chain Virtual Arena* (Robinhood-app framing) and replace the AVAX + XRP chains with Robinhood + Base, giving all five chains distinct, balanced mechanical identities — data + branding only, no engine changes.

**Architecture:** Each blockchain is a "color" defined entirely as card *data* in `src/cards.ts` (a `Color` union + `COLOR_META` + card definitions + starter decks). The effect engine in `Game.ts` consumes existing `EffectId` values and is untouched. This plan rewrites `cards.ts`, fixes every file that hardcodes the old `avax`/`xrp` chain keys so the app still typechecks/builds, and updates the product-shell branding strings.

**Tech Stack:** TypeScript, React 18, Vite, boardgame.io, Vitest.

## Global Constraints

- New chain roster (the exact `Color` union): `'bnb' | 'sol' | 'eth' | 'robinhood' | 'base'`. AVAX and XRP are removed entirely.
- Product name everywhere user-facing: **On-Chain Virtual Arena** (replaces "Memetic Masters TCG" / "Chains TCG").
- Brand colors: BNB `#f3ba2f`, Solana `#9945ff`, Ethereum `#f5f5f5`, Robinhood `#00C805`, Base `#0052FF`.
- Do **not** modify `src/Game.ts` beyond the single `emptyGas()` key set (line ~97). No new `EffectId` values.
- Each chain must keep the full pool shape: 1 node + 8 memes + 4 machines + 3 moves + 1 aura.
- Masterquest **lore prose** rewrite is OUT OF SCOPE (Spec 2). In lore files, only mechanically remap the old chain keys (`avax`→`robinhood`, `xrp`→`base`) so the project compiles; leave narrative text as-is.
- The hardcoded `masterstcg.com` OG/social domain is OUT OF SCOPE — leave it unchanged.
- Test command: `npm test` (`vitest run`). Build/typecheck: `npm run build` (`tsc -b && vite build`). Dev: `npm run dev`.
- Commit author identity in this repo: `Copilot <copilot@local>` (pass inline via `git -c user.name='Copilot' -c user.email='copilot@local' commit ...`; do NOT edit git config).

---

### Task 1: Rework the card catalogue (`src/cards.ts`) + its unit test

The whole file must be internally consistent to compile (the `Color` union change breaks every avax/xrp reference at once), so this is one atomic task gated by `src/cards.test.ts`.

**Files:**
- Modify: `src/cards.ts`
- Test: `src/cards.test.ts` (full rewrite of the registry describe block)

**Interfaces:**
- Produces (relied on by Task 2): `Color = 'bnb' | 'sol' | 'eth' | 'robinhood' | 'base'`; `COLORS` array in that order; `COLOR_META` with keys for all five; new card ids prefixed `robinhood_*` and `base_*`; `STARTER_DECKS` keyed by the new union; `DEFAULT_MATCHUP = ['base', 'eth']`.
- Consumes: existing helpers `M`, `ME`, `A`, `X`, `U`, `N`, `reg`, `emo`, `cmc`, `makeCost`, `splitCost` (unchanged).

- [ ] **Step 1: Rewrite the failing test** in `src/cards.test.ts` — replace the entire file with:

```typescript
import { describe, expect, it } from 'vitest';
import { CARDS, COLORS, COLOR_META, STARTER_DECKS, validateDeck } from './cards';

describe('On-Chain Virtual Arena chain registry', () => {
  it('has exactly the five-chain roster (no avax/xrp leftovers)', () => {
    expect(COLORS).toEqual(['bnb', 'sol', 'eth', 'robinhood', 'base']);

    const serialized = JSON.stringify(CARDS);
    expect(serialized).not.toMatch(/avax|xrp|Avalanche|Hyperliquid/i);
    expect(Object.keys(CARDS).some(id => id.startsWith('avax_') || id.startsWith('xrp_'))).toBe(false);
    expect(CARDS.node_avax).toBeUndefined();
    expect(CARDS.node_xrp).toBeUndefined();
  });

  it('defines Robinhood and Base color metadata', () => {
    expect(COLOR_META.robinhood).toMatchObject({ name: 'Robinhood', hex: '#00C805', glyph: 'HOOD' });
    expect(COLOR_META.base).toMatchObject({ name: 'Base', hex: '#0052FF', glyph: 'BASE' });
    expect(CARDS.node_robinhood).toMatchObject({ name: 'Robinhood Node', type: 'node', color: 'robinhood' });
    expect(CARDS.node_base).toMatchObject({ name: 'Base Node', type: 'node', color: 'base' });
  });

  it('gives every chain the full pool shape (8 memes + 4 machines + 3 moves + 1 aura)', () => {
    for (const color of COLORS) {
      const pool = Object.values(CARDS).filter(c => c.color === color && c.type !== 'node');
      const count = (t: string) => pool.filter(c => c.type === t).length;
      expect(count('meme'), `${color} memes`).toBe(8);
      expect(count('machine'), `${color} machines`).toBe(4);
      expect(count('move'), `${color} moves`).toBe(3);
      expect(count('aura'), `${color} auras`).toBe(1);
    }
  });

  it('builds a valid 60-card starter deck for every chain', () => {
    for (const color of COLORS) {
      const deck = STARTER_DECKS[color];
      expect(deck, `${color} deck length`).toHaveLength(60);
      expect(deck.every(id => CARDS[id]), `${color} known ids`).toBe(true);
      expect(validateDeck(deck).ok, `${color} validateDeck`).toBe(true);
    }
  });

  it('moves BRETT from Ethereum to Base', () => {
    expect(CARDS.eth_brett).toBeUndefined();
    expect(CARDS.base_brett).toMatchObject({ color: 'base', image: '/cards/brett.png?v=1' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- cards`
Expected: FAIL (COLORS still equals the old roster; `robinhood`/`base` metadata undefined).

- [ ] **Step 3: Update the type + color metadata + nodes** in `src/cards.ts`.

Replace lines 4–14 (the `Color`/`COLORS`/`COLOR_META` block) with:

```typescript
export type Color = 'bnb' | 'sol' | 'eth' | 'robinhood' | 'base';

export const COLORS: Color[] = ['bnb', 'sol', 'eth', 'robinhood', 'base'];

export const COLOR_META: Record<Color, { name: string; hex: string; ink: string; template?: string; glyph?: string }> = {
  bnb:       { name: 'BnB',       hex: '#f3ba2f', ink: '#000', template: '/template-bnb.jpg', glyph: 'BNB' },
  sol:       { name: 'Solana',    hex: '#9945ff', ink: '#fff', template: '/template-sol.png', glyph: 'SOL' },
  eth:       { name: 'Ethereum',  hex: '#f5f5f5', ink: '#222', template: '/template-eth.png', glyph: 'ETH' },
  robinhood: { name: 'Robinhood', hex: '#00C805', ink: '#000', glyph: 'HOOD' },
  base:      { name: 'Base',      hex: '#0052FF', ink: '#fff', glyph: 'BASE' },
};
```

(Robinhood and Base intentionally have no `template` — `templateFor()` returns undefined and the UI renders the glyph frame, per spec.)

- [ ] **Step 4: Update the `IMAGES` map** in `src/cards.ts`.

  - Delete the `node_avax` and `node_xrp` lines.
  - Delete the entire "Avalanche memes", "XRP memes", "Avalanche machines/moves", and "XRP machines/moves" comment blocks and the avax/xrp aura entries (`avax_icebound`, `xrp_edge`).
  - Delete the `eth_brett` line.
  - Add, in the memes area:

```typescript
  // Robinhood memes (meme-stocks — emoji glyph art)
  robinhood_hood:    emo('1f3f9'), // 🏹 bow and arrow (Robinhood)
  robinhood_gme:     emo('1f3ae'), // 🎮 game controller (GameStop)
  robinhood_amc:     emo('1f3ac'), // 🎬 clapper board (AMC)
  robinhood_kitty:   emo('1f981'), // 🦁 lion (Roaring Kitty)
  robinhood_tendies: emo('1f357'), // 🍗 poultry leg (tendies)
  robinhood_moon:    emo('1f680'), // 🚀 rocket (to the moon)
  robinhood_yolo:    emo('1f3b0'), // 🎰 slot machine (YOLO)
  robinhood_ape:     emo('1f98d'), // 🦍 gorilla (apes)

  // Base memes (BRETT keeps its painted art, rest emoji glyph)
  base_brett:   '/cards/brett.png?v=1',
  base_degen:   emo('1f3a9'), // 🎩 top hat (DEGEN)
  base_toshi:   emo('1f431'), // 🐱 cat face (TOSHI)
  base_miggles: emo('1f408'), // 🐈 cat (MIGGLES)
  base_keycat:  emo('1f511'), // 🔑 key (KEYCAT)
  base_normie:  emo('1f9d1'), // 🧑 person (NORMIE)
  base_doginme: emo('1f415'), // 🐕 dog (DOGINME)
  base_based:   emo('1f535'), // 🔵 blue circle (BASED)
```

  - Add, in the machines/moves/auras area:

```typescript
  // ── Robinhood machines/moves/aura ──
  robinhood_dividend:  emo('1f4b5'), // 💵 dollar banknote
  robinhood_options:   emo('1f4c8'), // 📈 chart up
  robinhood_fractional:emo('1f967'), // 🥧 pie (fractional slice)
  robinhood_margin:    emo('1f4b3'), // 💳 credit card
  robinhood_buydip:    emo('1f4c9'), // 📉 chart down (buy the dip)
  robinhood_gamma:     emo('26a1'),  // ⚡ high voltage (gamma squeeze)
  robinhood_pfof:      emo('1f9fe'), // 🧾 receipt (order flow)
  robinhood_diamond:   emo('1f48e'), // 💎 gem (diamond hands)

  // ── Base machines/moves/aura ──
  base_summer:  emo('2600'),  // ☀ sun (Onchain Summer)
  base_frames:  emo('1f5bc'), // 🖼 framed picture (Farcaster Frames)
  base_wallet:  emo('1f45b'), // 👛 purse (Smart Wallet)
  base_onramp:  emo('1f6e3'), // 🛣 motorway (Coinbase Onramp)
  base_tip:     emo('1fa99'), // 🪙 coin (Tip DEGEN)
  base_bridge:  emo('1f309'), // 🌉 bridge at night (Base Bridge)
  base_airdrop: emo('1fa82'), // 🪂 parachute (Airdrop Szn)
  base_staybased: emo('1f4aa'), // 💪 flexed biceps (Stay Based)
```

- [ ] **Step 5: Update node registration.** Replace the `reg(N('bnb'), N('sol'), N('avax'), N('eth'), N('xrp'));` line with:

```typescript
reg(N('bnb'), N('sol'), N('eth'), N('robinhood'), N('base'));
```

- [ ] **Step 6: Remove the `eth_brett` meme line** from the Ethereum `reg(...)` block (the `M('eth_brett','eth', 'BRETT', ...)` line). Ethereum now has 7 `M` memes + the `eth_sproto_gremlin` ME = 8 memes.

- [ ] **Step 7: Delete the Avalanche and XRP `reg(...)` blocks** entirely (the two `// Avalanche — ...` and `// XRP — ...` sections).

- [ ] **Step 8: Add the Robinhood `reg(...)` block** after the Ethereum block:

```typescript
// Robinhood — lifegain midrange, sturdy bodies, dividends
reg(
  M('robinhood_hood',    'robinhood', 'HOOD',     1, 1, 2, 'Payment for order flow IPO\'d the casino.'),
  M('robinhood_gme',     'robinhood', 'GME',      2, 1, 4, 'Diamond hands. The floor is the ceiling.'),
  M('robinhood_amc',     'robinhood', 'AMC',      2, 2, 3, 'Apes together strong.'),
  M('robinhood_kitty',   'robinhood', 'KITTY',    3, 3, 4, 'Roaring Kitty posts a single frame.'),
  M('robinhood_tendies', 'robinhood', 'TENDIES',  3, 4, 3, 'Chicken tendies, secured.'),
  M('robinhood_moon',    'robinhood', 'MOON',     4, 4, 5, 'To the moon, no brakes.'),
  M('robinhood_yolo',    'robinhood', 'YOLO',     5, 6, 4, 'One life, all in on 0DTE calls.'),
  M('robinhood_ape',     'robinhood', 'APE',      6, 6, 7, 'The whole ape army marches on the shorts.'),
  // Machines
  A('robinhood_dividend',  'robinhood', 'Dividend Reinvestment', 2, 'lifelink_all',        'Reinvested dividends heal you when your Memes deal damage.'),
  A('robinhood_options',   'robinhood', 'Options Chain',         3, 'pump_attackers_+1+0', 'Leverage: your attacking Memes get +1/+0.'),
  A('robinhood_fractional','robinhood', 'Fractional Shares',     3, 'on_meme_etb_draw',    'When a Meme enters under you, draw a card (once per turn).'),
  A('robinhood_margin',    'robinhood', 'Margin Account',        3, 'pump_all_+1+1',       'Leverage the whole book: your Memes get +1/+1.'),
  // Moves
  X('robinhood_buydip', 'robinhood', 'Buy the Dip',    2, 'gainLife4', 'Stack the discount. Gain 4 life.'),
  X('robinhood_gamma',  'robinhood', 'Gamma Squeeze',  3, 'damage5',   'Dealers scramble to hedge. Deal 5 damage to any target.'),
  X('robinhood_pfof',   'robinhood', 'Order Flow',     3, 'drawTwo',   'Sell the flow, read the tape. Draw two cards.'),
  // Aura
  U('robinhood_diamond','robinhood', 'Diamond Hands',  2, 'aura_+0+3', 'Enchant Meme. Attached Meme gets +0/+3.'),
);
```

- [ ] **Step 9: Add the Base `reg(...)` block:**

```typescript
// Base — card-advantage aggro, cheap swarm, onchain summer
reg(
  M('base_degen',   'base', 'DEGEN',    1, 2, 1, 'Tip your way to the top.'),
  M('base_toshi',   'base', 'TOSHI',    1, 1, 2, 'Coinbase\'s cat mascot, onchain native.'),
  M('base_brett',   'base', 'BRETT',    2, 3, 2, 'Pepe\'s blue friend, all in on Base.'),
  M('base_miggles', 'base', 'MIGGLES',  2, 2, 2, 'The Base cat that would not sit down.'),
  M('base_keycat',  'base', 'KEYCAT',   3, 3, 3, 'Cat on a keyboard, typing the bull case.'),
  M('base_normie',  'base', 'NORMIE',   3, 4, 2, 'Onboarded from the Coinbase app.'),
  M('base_doginme', 'base', 'DOGINME',  4, 4, 4, 'Based dog energy.'),
  M('base_based',   'base', 'BASED',    5, 5, 5, 'Stay based, stay onchain.'),
  // Machines
  A('base_summer', 'base', 'Onchain Summer',   3, 'pump_all_+1+1',       'The whole ecosystem pumps: your Memes get +1/+1.'),
  A('base_frames', 'base', 'Farcaster Frames', 3, 'on_meme_etb_draw',    'When a Meme enters under you, draw a card (once per turn).'),
  A('base_wallet', 'base', 'Smart Wallet',     2, 'extra_node_per_turn', 'Gasless onboarding: play one extra Node each turn.'),
  A('base_onramp', 'base', 'Coinbase Onramp',  4, 'meme_haste',          'Instant fiat rails: your Memes have no summoning sickness.'),
  // Moves
  X('base_tip',     'base', 'Tip DEGEN',   3, 'drawTwo',      'Allowance drops in the channel. Draw two cards.'),
  X('base_bridge',  'base', 'Base Bridge', 2, 'bounceMeme',   'Bridge it back. Return target Meme to its owner\'s hand.'),
  X('base_airdrop', 'base', 'Airdrop Szn', 3, 'damageAll_1',  'Points go live. Every Meme on the field takes 1 damage.'),
  // Aura
  U('base_staybased','base', 'Stay Based', 2, 'aura_+3+0',    'Enchant Meme. Attached Meme gets +3/+0.'),
);
```

- [ ] **Step 10: Update `STARTER_DECKS`, `DEFAULT_MATCHUP`, and `derivePrimaryColor`.**

Replace the `STARTER_DECKS` object with:

```typescript
export const STARTER_DECKS: Record<Color, string[]> = {
  bnb: starterDeck('bnb'),
  sol: starterDeck('sol'),
  eth: starterDeck('eth'),
  robinhood: starterDeck('robinhood'),
  base: starterDeck('base'),
};

export const DEFAULT_MATCHUP: [Color, Color] = ['base', 'eth'];
```

In `derivePrimaryColor`, replace the counts initializer and the default:

```typescript
  const counts: Record<Color, number> = { bnb: 0, sol: 0, eth: 0, robinhood: 0, base: 0 };
```
and change the fallback `let best: Color = 'sol';` to `let best: Color = 'eth';`.

- [ ] **Step 11: Run the test to verify it passes**

Run: `npm test -- cards`
Expected: PASS (all five describe assertions green).

- [ ] **Step 12: Commit**

```bash
git add src/cards.ts src/cards.test.ts
git -c user.name='Copilot' -c user.email='copilot@local' commit -m "feat(cards): replace AVAX/XRP with Robinhood/Base and rebalance the 5-chain roster"
```

---

### Task 2: Fix all remaining `avax`/`xrp` references so the app typechecks and builds

`tsc -b` compiles the whole project, so every hardcoded old-chain reference must be fixed before the build passes. This is the task's gate.

**Files:**
- Modify: `src/Game.ts:97`, `src/App.tsx`, `src/Boosters.tsx:31`, `src/Plaza.tsx`, `src/BorderGlow.tsx`, `src/CardPreview.tsx` (comment), `src/masterquest/MasterquestPage.tsx`, `src/masterquest/lore.ts`, `src/masterquest/lore.test.ts`

**Interfaces:**
- Consumes: `Color`, `COLORS`, `COLOR_META` from Task 1.
- Produces: a project that passes `npm run build` and `npm test` with zero `avax`/`xrp` identifiers remaining in `src/`.

- [ ] **Step 1: `src/Game.ts`** — update `emptyGas()` (line ~97):

```typescript
function emptyGas(): Record<Color, number> {
  return { bnb: 0, sol: 0, eth: 0, robinhood: 0, base: 0 };
}
```

- [ ] **Step 2: `src/App.tsx`** — four edits:
  - Line ~46: `const COLOR_ORDER: Color[] = ['bnb', 'sol', 'eth', 'robinhood', 'base'];`
  - Line ~774 voice-setup string: replace the chain list `bnb solana avalanche avax ethereum xrp` with `bnb solana ethereum robinhood base`.
  - Line ~5167: `{(['bnb', 'sol', 'eth', 'robinhood', 'base'] as Color[]).map(c => {`
  - Lines ~6202–6203 styling conditionals: the special-casing of `c === 'xrp'` (white text/border) no longer applies. Replace with logic keyed on the chain's own contrast — use the per-color `ink`:
    ```typescript
    color: sel ? (COLOR_META[c].ink === '#fff' ? '#fff' : '#000') : COLOR_META[c].hex,
    border: `2px solid ${COLOR_META[c].hex}`,
    ```

- [ ] **Step 3: `src/Boosters.tsx:31`** — replace `COLOR_META.avax.hex` with `COLOR_META.robinhood.hex` (and if `COLOR_META.xrp.hex` appears nearby, `COLOR_META.base.hex`). The array should list all five current colors' hexes.

- [ ] **Step 4: `src/Plaza.tsx`** — six edits:
  - Line ~8: `type Color = 'bnb' | 'sol' | 'eth' | 'robinhood' | 'base';`
  - Line ~35 palette: `bnb: '#f0b90b', sol: '#9945ff', eth: '#e6e6e6', robinhood: '#00C805', base: '#0052FF',`
  - Lines ~41 & ~43 node map: replace the `avax` "Avalanche Camp" entry with a `robinhood` "Robinhood Floor" entry and the `xrp` "XRP Vault" entry with a `base` "Base Camp" entry (keep the same `x`/`y` coords; update `name` and `blurb` to match the new chains' identities — Robinhood = lifegain/dividends grind, Base = onchain-summer card-advantage aggro).
  - Line ~47 short-name map: `bnb: 'BNB', sol: 'Sol', eth: 'Eth', robinhood: 'HOOD', base: 'Base',`
  - Lines ~150 & ~153 canvas labels: `'AVAX CAMP'` → `'ROBINHOOD'`, `'XRP VAULT'` → `'BASE CAMP'`.
  - Line ~160 text-color condition `n.color === 'xrp' || n.color === 'sol'` → `n.color === 'sol' || n.color === 'base'` (dark-on-light chains use `#000`; drive off `COLOR_META[n.color].ink` if preferred).

- [ ] **Step 5: `src/BorderGlow.tsx`** — line ~210 mesh palette `['#9945ff', '#f3ba2f', '#e84142']` → `['#9945ff', '#f3ba2f', '#0052FF']` (sol / bnb / base); update the `/* sol / bnb / avax */` comment (line ~8 and ~210) to `sol / bnb / base`.

- [ ] **Step 6: `src/CardPreview.tsx`** — line ~83 comment mentions "Avalanche and BnB"; change to "Base and BnB" (cosmetic, keep the sentence accurate).

- [ ] **Step 7: `src/masterquest/MasterquestPage.tsx`** — the color map (line ~34–36) and name map (line ~42–44) are keyed by chain. Replace the `avax` entries with `robinhood` (`hex '#00C805'`, name keep the existing campaign label for now or set `'Robinhood Floor'`) and the `xrp` entries with `base` (`hex '#0052FF'`, name `'Base Camp'`). Narrative labels can stay minimal — full lore is Spec 2.

- [ ] **Step 8: `src/masterquest/lore.ts`** — mechanical key remap only (no prose rewrite): every `chain: 'avax'` and `botColor: 'avax'` → `'robinhood'`; every `chain: 'xrp'` and `botColor: 'xrp'` → `'base'`. Leave surrounding comments/story text unchanged (flagged for Spec 2). This keeps the 3-sites-per-chain distribution intact across the new roster.

- [ ] **Step 9: `src/masterquest/lore.test.ts:37`** — update the roster array: `for (const c of ['bnb', 'sol', 'eth', 'robinhood', 'base'] as const) {`.

- [ ] **Step 10: Verify no old references remain**

Run: search for `avax` / `xrp` across `src/` (Grep). Expected: zero matches in `src/**/*.{ts,tsx}`.

- [ ] **Step 11: Run typecheck/build + full test suite**

Run: `npm run build`
Expected: `tsc -b` and `vite build` both succeed, no type errors.
Run: `npm test`
Expected: all suites PASS (cards + masterquest lore).

- [ ] **Step 12: Commit**

```bash
git add src/Game.ts src/App.tsx src/Boosters.tsx src/Plaza.tsx src/BorderGlow.tsx src/CardPreview.tsx src/masterquest/MasterquestPage.tsx src/masterquest/lore.ts src/masterquest/lore.test.ts
git -c user.name='Copilot' -c user.email='copilot@local' commit -m "refactor: repoint all avax/xrp chain references to robinhood/base"
```

---

### Task 3: Rebrand the product shell + user-facing name strings

**Files:**
- Modify: `index.html`, `public/manifest.webmanifest`, `README.md`, and any user-facing "Memetic Masters" / "Chains TCG" strings in `src/App.tsx`, `src/Board.tsx`, `src/Plaza.tsx`, `src/Voice.tsx`

**Interfaces:**
- Consumes: nothing from prior tasks (branding text only).
- Produces: no code identifiers; a shell that displays "On-Chain Virtual Arena".

- [ ] **Step 1: `index.html`** — set `<title>` to `On-Chain Virtual Arena`; update `meta[name=description]`, `meta[name=application-name]`, `meta[name=apple-mobile-web-app-title]`, `og:title`, `og:site_name`, `twitter:title`, `twitter:description` to the new name. New description text: `On-Chain Virtual Arena — a Robinhood app: the 5-chain, MTG-style onchain card game on Robinhood Chain.` Do NOT change the `masterstcg.com` `twitter:image`/`og:url` domain (out of scope).

- [ ] **Step 2: `public/manifest.webmanifest`** — `"name": "On-Chain Virtual Arena"`, `"short_name": "OCVA"`.

- [ ] **Step 3: `README.md`** — replace the title `# Memetic Masters TCG` and intro line with the new name + Robinhood-app framing; update "The Five Chains" table to the new roster (BnB, Solana, Ethereum, Robinhood, Base) with the roles from the design doc.

- [ ] **Step 4: In-app strings** — Grep `src/` for `Memetic Masters` and `Chains TCG`; replace each *user-facing* occurrence (headings, titles, About/help copy in `App.tsx`, `Board.tsx`, `Plaza.tsx`, `Voice.tsx`) with `On-Chain Virtual Arena`. Do not rename code identifiers, package name, or the repo directory.

- [ ] **Step 5: Verify branding + build**

Run: Grep `src/ index.html public/manifest.webmanifest` for `Memetic Masters`. Expected: zero user-facing matches (comments/lore prose excepted, which are Spec 2).
Run: `npm run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add index.html public/manifest.webmanifest README.md src/App.tsx src/Board.tsx src/Plaza.tsx src/Voice.tsx
git -c user.name='Copilot' -c user.email='copilot@local' commit -m "feat: rebrand product shell to On-Chain Virtual Arena (Robinhood app)"
```

---

### Task 4: Manual playtest verification

**Files:** none (verification only).

- [ ] **Step 1: Start the dev environment**

Run: `npm run dev` (and `npm run dev:server` in a second terminal if a match requires the server).

- [ ] **Step 2: Play the new chains.** Start a VS-Bot match choosing **Base** vs a kept chain, then **Robinhood** vs a kept chain. Confirm:
  - Both new chains appear in the chain/deck picker with correct brand colors (Base blue, Robinhood green).
  - Cards render (BRETT shows its painted art on Base; meme-stock and emoji cards show their glyph/emoji; nodes show the chain glyph).
  - A full turn cycle works (play node → play meme → attack), and at least one signature effect resolves per new chain (e.g. Base `Farcaster Frames` draw-on-ETB; Robinhood `Dividend Reinvestment` lifelink).
  - No `avax`/`xrp`/"Memetic Masters" text leaks into the UI (deck picker, plaza map labels, page title).

- [ ] **Step 3: Record the result.** If a UI-testable check cannot be run in this environment, state that explicitly rather than claiming success. Note any balance oddities for a later tuning pass (stats are intentionally first-draft).

- [ ] **Step 4: Final commit (only if verification prompted small fixes).** Otherwise no commit.

---

## Self-Review

**Spec coverage:**
- Color pie / new mechanical identities → Task 1 (card data) + tests.
- New Robinhood + Base rosters → Task 1 steps 8–9 (full card lists, no placeholders).
- Art remap (brett ETH→Base, emoji fallbacks, node glyph fallback) → Task 1 steps 4–6.
- Data-only code changes + no engine change → Task 1 + Task 2 (Game.ts limited to `emptyGas` keys).
- Rename surface (index.html, manifest, README, UI strings; domain flagged not changed) → Task 3.
- Testing (cards.test.ts, build clean, manual playtest) → Tasks 1, 2, 4.
- Deferred lore prose / boosters content / onchain migration → explicitly out of scope in Global Constraints and Task 2 step 8.

**Placeholder scan:** No "TBD/TODO"; all card data and test code are concrete. First-draft stat tuning is called out as intentional, not a missing step.

**Type consistency:** `Color` union, `COLORS` order, `COLOR_META` keys, `STARTER_DECKS` keys, `DEFAULT_MATCHUP`, `emptyGas` keys, and every hardcoded array in Task 2 all use the identical five members `bnb | sol | eth | robinhood | base`. New card ids are consistently `robinhood_*` / `base_*` across catalogue, IMAGES map, and tests.
