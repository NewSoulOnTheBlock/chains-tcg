// src/cards.ts
// Card catalogue + starter decks for Chains TCG.

export type Color = 'bnb' | 'sol' | 'avax' | 'eth' | 'xrp';

export const COLORS: Color[] = ['bnb', 'sol', 'avax', 'eth', 'xrp'];

export const COLOR_META: Record<Color, { name: string; hex: string; ink: string; template?: string; glyph?: string }> = {
  bnb: { name: 'BnB',         hex: '#f3ba2f', ink: '#000', template: '/template-bnb.jpg', glyph: 'BNB' },
  sol: { name: 'Solana',      hex: '#9945ff', ink: '#fff', template: '/template-sol.png', glyph: 'SOL' },
  avax: { name: 'Avalanche',   hex: '#e84142', ink: '#fff', template: '/template-avax.svg', glyph: 'AVAX' },
  eth: { name: 'Ethereum',    hex: '#f5f5f5', ink: '#222', template: '/template-eth.png', glyph: 'ETH' },
  xrp: { name: 'XRP',         hex: '#1a1a1a', ink: '#fff', template: '/template-xrp.png', glyph: 'XRP' },
};

export type CardType = 'node' | 'meme' | 'machine' | 'aura' | 'move';

export type GasCost = Partial<Record<Color | 'any', number>>;

/** Mechanical effect identifiers — Game.ts implements them. */
export type EffectId =
  // moves
  | 'damage2'              // deal 2 damage to any target
  | 'damage3'              // deal 3 damage to any target
  | 'damage5'              // deal 5 damage to any target
  | 'destroyMeme'          // destroy target meme
  | 'destroyMachine'       // destroy target machine
  | 'bounceMeme'           // return target meme to its owner's hand
  | 'drawTwo'              // draw two cards
  | 'gainLife4'            // gain 4 life
  | 'mill3'                // opponent puts top 3 cards of their deck into graveyard
  | 'damageAll_1'          // deal 1 damage to every meme on the battlefield
  | 'discardRandom'        // opponent discards a random card from hand
  // machines (passive auras)
  | 'pump_all_+1+1'        // your memes get +1/+1
  | 'pump_attackers_+1+0'  // your attacking memes get +1/+0
  | 'meme_haste'           // your memes have no summoning sickness
  | 'extra_node_per_turn'  // you may play one extra Node per turn
  | 'gas_discount_color'   // your moves cost 1 less of own color (min 0)
  | 'lifelink_all'         // damage your memes deal heals you for the same amount
  | 'on_meme_etb_draw'     // when a meme enters under you, draw a card (cooldown 1/turn)
  // auras (attach to a single Meme)
  | 'aura_+2+2'            // attached meme: +2/+2
  | 'aura_+3+0'            // attached meme: +3/+0 (sword)
  | 'aura_+0+3'            // attached meme: +0/+3 (shield)
  | 'aura_haste'           // attached meme: clear summoning sickness on attach
  | 'aura_lifelink'        // attached meme: damage it deals heals its controller
  // meme ETB triggers
  | 'etb_zap_2_and_draw'   // when this meme enters play, opponent loses 2 life and you draw 1 card
  ;

export interface CardDef {
  id: string;
  name: string;
  type: CardType;
  color: Color;
  cost?: GasCost;          // non-nodes
  power?: number;          // memes
  toughness?: number;      // memes
  text: string;
  effect?: EffectId;       // for moves + machines
  /** Optional art URL (e.g. CMC logo for meme coins). Falls back to chain glyph on error. */
  image?: string;
}

/** CoinMarketCap static logo CDN; the trailing id is the CMC coin id. */
const cmc = (id: number) => `https://s2.coinmarketcap.com/static/img/coins/128x128/${id}.png`;

/**
 * Twemoji CDN (Twitter's open-source emoji set, MIT/CC-BY licensed).
 * Used as art for Machines/Moves since these aren't tokens with logos.
 * Pass the unicode codepoint(s) in lowercase hex, joined with '-' for ZWJ sequences.
 */
const emo = (cp: string) =>
  `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${cp}.png`;

/** Image overrides keyed by card id. Cards without an entry render the chain glyph. */
const IMAGES: Record<string, string> = {
  // Chain nodes — larger, more artistic official logos hosted locally.
  node_bnb: '/nodes/bnb.png',
  node_sol: '/nodes/sol.png',
  node_avax: '/nodes/avax.svg',
  node_eth: '/nodes/eth.png',
  node_xrp: '/nodes/xrp.png',

  // BnB memes
  bnb_babydoge: '/cards/babydoge.png?v=1',
  bnb_broccoli: '/cards/broccoli.png?v=1',
  bnb_tut:      cmc(33687),
  bnb_tst:      '/cards/tst.png?v=1',
  bnb_banana:   '/cards/banana.jpg?v=1',
  bnb_mubarak:  '/cards/mubarak.png?v=1',
  bnb_cheems:   '/cards/cheems.png?v=1',
  bnb_floki:    cmc(10804),

  // Solana memes
  sol_pnut:     '/cards/pnut.webp?v=2',
  sol_bonk:     '/cards/bonk.png?v=1',
  sol_popcat:   '/cards/popcat.png?v=1',
  sol_mew:      '/cards/mew.png?v=1',
  sol_bome:     '/cards/bome.png?v=3',
  sol_wif:      cmc(28752),
  sol_fartcoin: '/cards/fartcoin.png?v=1',
  sol_goat:     cmc(33440),

  // Avalanche memes
  avax_coq:     '/cards/coq.png?v=1', // armored warrior rooster (COQ Inu)
  avax_kimbo:   emo('1f415'), // dog (KIMBO)
  avax_nochill: emo('1f976'), // cold face (NOCHILL)
  avax_husky:   emo('1f43a'), // wolf face (HUSKY)
  avax_tech:    emo('1f4bb'), // laptop (TECH)
  avax_gec:     emo('1f98e'), // lizard (Gecko)
  avax_meat:    emo('1f969'), // cut of meat (MEAT)
  avax_ket:     emo('1f408'), // cat (Yellow Ket)

  // Ethereum memes
  eth_andy:     '/cards/andy.png?v=1',
  eth_apu:      '/cards/apu.webp?v=1',
  eth_wojak:    '/cards/wojak.png?v=2',
  eth_turbo:    '/cards/turbo.png?v=1',
  eth_mog:      '/cards/mog.png?v=2',
  eth_shib:     '/cards/shib.png?v=1',
  eth_brett:    '/cards/brett.png?v=1',
  eth_pepe:     '/cards/pepe.png?v=1',

  // XRP memes
  xrp_phnix:    '/cards/phnix.png?v=1',
  xrp_fuzzy:    '/cards/fuzzy.png?v=1',
  xrp_bert:     cmc(34121),
  xrp_xpm:      cmc(34030),
  xrp_xpunks:   '/cards/xpunks.png?v=1',
  xrp_oze:      cmc(34221),
  xrp_army:     cmc(33966),
  xrp_xmen:     '/cards/xmen.png?v=1',

  // ── BnB machines/moves ──
  bnb_farm:     '/cards/volume_bot.png?v=1',
  bnb_bridge:   '/cards/token_launchpad.png?v=1',
  bnb_sniper:   '/cards/sniper_bot.png?v=1',
  bnb_mmalgo:   '/cards/market_maker_algo.png?v=1',
  bnb_rugpull:  '/cards/rug_pull.png?v=1',
  bnb_airdrop:  '/cards/airdrop_farm.png?v=1',
  bnb_honeypot: '/cards/honeypot.png?v=1',

  // ── Solana machines/moves ──
  sol_priority: '/cards/mev-bundler.png?v=1',
  sol_oracle:   '/cards/ai-trading-agent.png?v=1',
  sol_amm:      '/cards/amm-router.png?v=1',
  sol_tgbot:    '/cards/telegram-bot-suite.png?v=1',
  sol_zap:      '/cards/snipe.png?v=1',
  sol_bounce:   emo('1f3c3'), // 🏃 runner (Frontrun)
  sol_tgpump:   emo('1f4e2'), // 📢 loudspeaker (Telegram Pump)

  // ── Avalanche machines/moves ──
  avax_subnet:   emo('1f3d4'), // mountain (Subnet Factory)
  avax_staking:  emo('2744'),  // snowflake (Validator Set)
  avax_teleport: emo('1f309'), // bridge (Teleporter Bridge)
  avax_router:   emo('1f9ed'), // compass (Trader Joe Router)
  avax_snowball: emo('26c4'),  // snowman (Snowball)
  avax_rush:     emo('1f3c2'), // snowboarder (Avalanche Rush)
  avax_finality: emo('2705'),  // check mark (Finality)

  // ── Ethereum machines/moves ──
  eth_eip1559:  '/cards/smart_contract_suite.png?v=1',
  eth_temple:   emo('1f310'), // 🌐 globe with meridians (Dapp Ecosystem)
  eth_l2:       '/cards/layer2_rollup.png?v=1',
  eth_yield:    emo('1fa99'), // 🪙 coin (Yield Aggregator)
  eth_smite:    emo('1f426'), // 🐦 bird (FUD Tweet)
  eth_heal:     '/cards/dca_in.png?v=1',
  eth_exploit:  '/cards/exploit_disclosure.png?v=1',

  // ── XRP machines/moves ──
  xrp_ledger:   emo('1f4d2'), // 📒 ledger (Indexer Daemon)
  xrp_lifelink: emo('1f30a'), // 🌊 wave (AMM Pool)
  xrp_arb:      emo('26a1'),  // ⚡ high voltage (Arbitrage Bot)
  xrp_algo:     emo('1f9ee'), // 🧮 abacus (Trading Algorithm)
  xrp_assassin: emo('1f50d'), // 🔍 magnifying glass (Doxx)
  xrp_strike:   emo('1f40b'), // 🐋 whale (Whale Dump)
  // ── Auras (Genesis set) — emoji-art for now ──
  bnb_liquidity:  emo('1f4a7'),   // 💧 droplet (Liquidity Injection)
  sol_validator:  emo('26a1'),    // ⚡ high voltage (Validator Boost)
  avax_icebound:  emo('1f512'),   // 🔒 lock (Icebound Stake)
  eth_shield:     emo('1f6e1'),   // 🛡 shield (Smart Contract Shield)
  xrp_edge:       emo('2694'),    // ⚔ swords (Validator Edge)
  // ── NFT-linked meme art ──
  eth_sproto_gremlin: '/sproto-gremlin.png',
};

/**
 * Resolves the framed-template (MTG-style) to use for a card.
 * Per-type overrides take precedence over per-color templates so e.g.
 * all `machine` cards share one steel/silver frame regardless of color.
 */
export function templateFor(def: CardDef): { url: string; glyph?: string } | undefined {
  if (def.type === 'machine') {
    return { url: '/template-machine.jpg', glyph: 'MACHINE' };
  }
  if (def.type === 'aura') {
    // Reuse the machine frame for now — auras share the steel/silver look
    // with a unique badge in the UI marking them as "attached".
    return { url: '/template-machine.jpg', glyph: 'AURA' };
  }
  const meta = COLOR_META[def.color];
  if (meta.template) return { url: meta.template, glyph: meta.glyph };
  return undefined;
}

const N = (color: Color): CardDef => ({
  id: `node_${color}`,
  name: `${COLOR_META[color].name} Node`,
  type: 'node',
  color,
  text: `Tap: add 1 ${COLOR_META[color].name} gas.`,
});

/**
 * Multicolor-friendly cost split.
 * Every non-Node card costs N total gas, of which a "colored" portion must be paid
 * in its own chain's gas, and the rest is "any" (payable from any chain's pool).
 *
 * Ramp: 1 → 1C, 2 → 1C+1, 3 → 2C+1, 4 → 2C+2, 5 → 3C+2, 6 → 3C+3, 7+ → 3C+(N-3).
 * Result: every card needs at most 3 of its own color, but heavy bombs still
 * demand bigger boards. Splash-friendly across decks.
 */
function splitCost(total: number): { colored: number; any: number } {
  const t = Math.max(0, Math.floor(total));
  if (t <= 1) return { colored: t, any: 0 };
  if (t === 2) return { colored: 1, any: 1 };
  if (t === 3) return { colored: 2, any: 1 };
  if (t === 4) return { colored: 2, any: 2 };
  if (t === 5) return { colored: 3, any: 2 };
  return { colored: 3, any: t - 3 };
}

function makeCost(color: Color, total: number): GasCost {
  const { colored, any } = splitCost(total);
  const out: GasCost = {};
  if (colored > 0) out[color] = colored;
  if (any > 0)     out.any   = any;
  return out;
}

/** Total mana value of a cost (sum of colored + any). Used for display/sorting. */
export function costTotal(cost?: GasCost): number {
  if (!cost) return 0;
  let n = 0;
  for (const k of Object.keys(cost) as Array<Color | 'any'>) n += cost[k] ?? 0;
  return n;
}

const M = (
  id: string, color: Color, name: string, cost: number, power: number, toughness: number, text = ''
): CardDef => ({
  id, name, type: 'meme', color,
  cost: makeCost(color, cost),
  power, toughness,
  text: text || `${power}/${toughness}`,
});

/** Meme with an ETB-triggered effect. */
const ME = (
  id: string, color: Color, name: string, cost: number, power: number, toughness: number,
  effect: EffectId, text: string,
): CardDef => ({
  id, name, type: 'meme', color,
  cost: makeCost(color, cost),
  power, toughness,
  effect, text,
});

const A = (
  id: string, color: Color, name: string, cost: number, effect: EffectId, text: string
): CardDef => ({
  id, name, type: 'machine', color,
  cost: makeCost(color, cost),
  text, effect,
});

const X = (
  id: string, color: Color, name: string, cost: number, effect: EffectId, text: string
): CardDef => ({
  id, name, type: 'move', color,
  cost: makeCost(color, cost),
  text, effect,
});

/** Aura: enchantment that attaches to a single Meme. */
const U = (
  id: string, color: Color, name: string, cost: number, effect: EffectId, text: string
): CardDef => ({
  id, name, type: 'aura', color,
  cost: makeCost(color, cost),
  text, effect,
});

// ── Catalogue ────────────────────────────────────────────────────────────────

export const CARDS: Record<string, CardDef> = {};
function reg(...cs: CardDef[]) {
  for (const c of cs) {
    const img = IMAGES[c.id];
    CARDS[c.id] = img ? { ...c, image: img } : c;
  }
}

// Nodes
reg(N('bnb'), N('sol'), N('avax'), N('eth'), N('xrp'));

// BnB — fast, cheap, aggressive memes
reg(
  M('bnb_babydoge','bnb', 'BABYDOGE',         1, 1, 1, 'A million-zero token, a million holders.'),
  M('bnb_broccoli','bnb', 'BROCCOLI',         1, 2, 1, "CZ's dog. Greens are bullish."),
  M('bnb_tut',     'bnb', 'TUT',              2, 2, 2, 'Mubarak\'s turtle. Slow and steady.'),
  M('bnb_tst',     'bnb', 'TST',              2, 3, 2, 'A test that pumped 1000x.'),
  M('bnb_banana',  'bnb', 'BANANA',           3, 3, 3, 'Slipped past every sell wall.'),
  M('bnb_mubarak', 'bnb', 'MUBARAK',          3, 4, 3, 'Bismillah, send it.'),
  M('bnb_cheems',  'bnb', 'CHEEMS',           4, 4, 4, 'Bonk\'s older brother. Frens forever.'),
  M('bnb_floki',   'bnb', 'FLOKI',            5, 6, 5, 'Viking energy, BSC liquidity.'),
  // Machines
  A('bnb_farm',     'bnb', 'Volume Bot',        3, 'pump_all_+1+1',         'Wash trades pump every Meme +1/+1.'),
  A('bnb_bridge',   'bnb', 'Token Launchpad',   2, 'extra_node_per_turn',   'You may play one extra Node each turn.'),
  A('bnb_sniper',   'bnb', 'Sniper Bot',        4, 'meme_haste',            'Your Memes have no summoning sickness.'),
  A('bnb_mmalgo',   'bnb', 'Market Maker Algo', 3, 'pump_attackers_+1+0',   'Your attacking Memes get +1/+0.'),
  // Moves
  X('bnb_rugpull',  'bnb', 'Rug Pull',          2, 'destroyMeme',           'Dev pulls the liquidity. Destroy target Meme.'),
  X('bnb_airdrop',  'bnb', 'Airdrop Farm',      3, 'drawTwo',               'Farm wallets for the snapshot. Draw two cards.'),
  X('bnb_honeypot', 'bnb', 'Honeypot',          3, 'damageAll_1',           'Every Meme on the field takes 1 damage.'),
  // Aura
  U('bnb_liquidity','bnb', 'Liquidity Injection', 2, 'aura_+2+2',           'Enchant Meme. Attached Meme gets +2/+2.'),
);

// Solana — burst, draw, fast turns
reg(
  M('sol_pnut',    'sol', 'PNUT',              1, 2, 1, 'Peanut the Squirrel. RIP.'),
  M('sol_bonk',    'sol', 'BONK',              1, 1, 2, 'The OG Solana shiba.'),
  M('sol_popcat',  'sol', 'POPCAT',            2, 2, 3, 'Pop. Pop. Pop.'),
  M('sol_mew',     'sol', 'MEW',               2, 3, 2, 'Cat in a dogs world.'),
  M('sol_bome',    'sol', 'BOME',              3, 3, 3, 'Book of Meme. Required reading.'),
  M('sol_wif',     'sol', 'dogwifhat',         3, 4, 2, 'It is just a dog wif a hat.'),
  M('sol_fartcoin','sol', 'FARTCOIN',          4, 5, 4, 'Silent but deadly.'),
  M('sol_goat',    'sol', 'GOAT',              5, 6, 5, 'Goatseus Maximus, the AI prophet.'),
  // Machines
  A('sol_priority','sol', 'MEV Bundler',       2, 'gas_discount_color',    'Your Moves cost 1 less Solana gas (min 0).'),
  A('sol_oracle',  'sol', 'AI Trading Agent',  3, 'on_meme_etb_draw',      'When a Meme enters under you, draw a card (once per turn).'),
  A('sol_amm',     'sol', 'AMM Router',        4, 'meme_haste',            'Your Memes have no summoning sickness.'),
  A('sol_tgbot',   'sol', 'Telegram Bot Suite',3, 'pump_attackers_+1+0',   'Your attacking Memes get +1/+0.'),
  // Moves
  X('sol_zap',     'sol', 'Snipe',             1, 'damage3',               'Bot snipes the mint. Deal 3 damage to any target.'),
  X('sol_bounce',  'sol', 'Frontrun',          2, 'bounceMeme',            'MEV reorder. Return target Meme to its owner\'s hand.'),
  X('sol_tgpump',  'sol', 'Telegram Pump',     1, 'damage2',               'KOL signal in the group chat. Deal 2 damage anywhere.'),
  // Aura
  U('sol_validator','sol', 'Validator Boost',  2, 'aura_haste',            'Enchant Meme. Attached Meme has no summoning sickness.'),
);

// Avalanche — big bodies, lifelink
reg(
  M('avax_coq',     'avax', 'COQ',              1, 1, 2, 'Coq Inu crows across the C-Chain.'),
  M('avax_kimbo',   'avax', 'KIMBO',            2, 2, 2, 'A snow dog with a community bite.'),
  M('avax_nochill', 'avax', 'NOCHILL',          2, 1, 4, 'AVAX has no chill, and neither does this Meme.'),
  M('avax_husky',   'avax', 'HUSKY',            3, 4, 3, 'The old Avalanche sled dog still pulls.'),
  M('avax_tech',    'avax', 'TECH',             3, 3, 3, 'Pure tech, pure meme, pure red-chain banter.'),
  M('avax_gec',     'avax', 'GEC',              4, 4, 5, 'Gecko sticks to the wall through every dip.'),
  M('avax_meat',    'avax', 'MEAT',             5, 5, 5, 'The grill is hot and liquidity is sizzling.'),
  M('avax_ket',     'avax', 'KET',              6, 7, 7, 'Yellow Ket prowls the snowfields for the final pump.'),
  // Machines
  A('avax_subnet',  'avax', 'Subnet Factory',  3, 'pump_all_+1+1',         'Custom chains compound your Memes +1/+1.'),
  A('avax_staking', 'avax', 'Validator Set',   2, 'lifelink_all',          'Staked security heals you when your Memes deal damage.'),
  A('avax_teleport','avax', 'Teleporter Bridge',4, 'meme_haste',           'Cross-chain messages arrive fast; your Memes have no summoning sickness.'),
  A('avax_router',  'avax', 'Trader Joe Router',3, 'pump_attackers_+1+0',  'Route through the deepest pools: attacking Memes get +1/+0.'),
  // Moves
  X('avax_snowball','avax', 'Snowball',         3, 'destroyMeme',           'A red-chain avalanche buries target Meme.'),
  X('avax_rush',    'avax', 'Avalanche Rush',   2, 'gainLife4',             'Incentives hit the ecosystem. Gain 4 life.'),
  X('avax_finality','avax', 'One-Block Finality',2, 'discardRandom',        'Their transaction is finalized out; they discard a random card.'),
  // Aura
  U('avax_icebound','avax', 'Icebound Stake',   2, 'aura_lifelink',         'Enchant Meme. Damage attached Meme deals heals its controller.'),
);

// Ethereum — control, removal, big finishers
reg(
  M('eth_andy',    'eth', 'ANDY',              1, 2, 2, 'Andy is happy. Andy is bullish.'),
  M('eth_apu',     'eth', 'APU',               1, 1, 3, 'Apu Apustaja, helper frog.'),
  M('eth_wojak',   'eth', 'WOJAK',             2, 2, 3, 'Feels permabullish, man.'),
  M('eth_turbo',   'eth', 'TURBO',             2, 3, 1, 'Painted by a chatbot, listed on Binance.'),
  M('eth_mog',     'eth', 'MOG',               3, 3, 4, 'Mog the lessers.'),
  M('eth_shib',    'eth', 'SHIB',              3, 4, 3, 'The Dogecoin killer that became a brand.'),
  M('eth_brett',   'eth', 'BRETT',             4, 4, 4, 'Pepe\'s blue friend.'),
  M('eth_pepe',    'eth', 'PEPE',              5, 5, 6, 'The king of ERC-20 memes.'),
  // NFT-linked meme — ETB zaps opp + draws a card (Sproto Gremlin NFT mint)
  ME('eth_sproto_gremlin', 'eth', 'Sproto Gremlin', 2, 2, 2, 'etb_zap_2_and_draw',
     'When ~ enters the field, deal 2 damage to your opponent and draw a card.'),
  // Machines
  A('eth_eip1559', 'eth', 'Smart Contract Suite', 3, 'gas_discount_color', 'Optimized calldata — your Moves cost 1 less Ethereum gas (min 0).'),
  A('eth_temple',  'eth', 'Dapp Ecosystem',    4, 'pump_all_+1+1',         'Network effects: your Memes get +1/+1.'),
  A('eth_l2',      'eth', 'Layer 2 Rollup',    4, 'meme_haste',            'Sequencer ships fast — your Memes have no summoning sickness.'),
  A('eth_yield',   'eth', 'Yield Aggregator',  3, 'pump_attackers_+1+0',   'Your attacking Memes get +1/+0.'),
  // Moves
  X('eth_smite',   'eth', 'FUD Tweet',         3, 'damage5',               'KOL drops a thread. Deal 5 damage to any target.'),
  X('eth_heal',    'eth', 'DCA In',            2, 'gainLife4',             'Stack the dip. Gain 4 life.'),
  X('eth_exploit', 'eth', 'Exploit Disclosure',2, 'destroyMachine',        'White-hat dev kills the contract. Destroy target Machine.'),
  // Aura
  U('eth_shield',  'eth', 'Smart Contract Shield', 2, 'aura_+0+3',         'Enchant Meme. Attached Meme gets +0/+3.'),
);

// XRP — discard, sneak, finishers
reg(
  M('xrp_phnix',   'xrp', 'PHNIX',             1, 1, 2, 'Rises from the ledger ashes.'),
  M('xrp_fuzzy',   'xrp', 'FUZZY',             1, 2, 1, 'Looks cuddly. Bites hard.'),
  M('xrp_bert',    'xrp', 'BERT',              2, 3, 2, 'Bert never blinks.'),
  M('xrp_xpm',     'xrp', 'XPM',               2, 2, 2, 'XRP Punks Mafia.'),
  M('xrp_xpunks',  'xrp', 'XPUNKS',            3, 3, 4, 'XRPL punk energy.'),
  M('xrp_oze',     'xrp', 'OZE',               3, 4, 2, 'Ozempic season. Cutting fat.'),
  M('xrp_army',    'xrp', 'ARMY',              4, 5, 3, 'The XRP Army marches.'),
  M('xrp_xmen',    'xrp', 'XRP-MEN',           5, 5, 5, 'Mutant ledger heroes assemble.'),
  // Machines
  A('xrp_ledger',  'xrp', 'Indexer Daemon',    3, 'on_meme_etb_draw',      'When a Meme enters under you, draw a card (once per turn).'),
  A('xrp_lifelink','xrp', 'AMM Pool',          2, 'lifelink_all',          'Damage your Memes deal also heals you.'),
  A('xrp_arb',     'xrp', 'Arbitrage Bot',     4, 'meme_haste',            'Your Memes have no summoning sickness.'),
  A('xrp_algo',    'xrp', 'Trading Algorithm', 3, 'pump_attackers_+1+0',   'Your attacking Memes get +1/+0.'),
  // Moves
  X('xrp_assassin','xrp', 'Doxx',              2, 'destroyMeme',           'KOL outs the founder. Destroy target Meme.'),
  X('xrp_strike',  'xrp', 'Whale Dump',        3, 'damage5',               'Whale unloads at market. Deal 5 damage to any target.'),
  X('xrp_subpoena','xrp', 'SEC Subpoena',      1, 'mill3',                 'Regulator subpoenas the dev. Opponent mills 3 cards.'),
  // Aura
  U('xrp_edge',    'xrp', 'Validator Edge',    2, 'aura_+3+0',             'Enchant Meme. Attached Meme gets +3/+0.'),
);

// ── Starter decks ────────────────────────────────────────────────────────────

/** 60-card mono-color starter deck: ~22 nodes + 3 of each Meme + 2 of each Machine/Move. */
export function starterDeck(color: Color): string[] {
  const nodes = Array(22).fill(`node_${color}`);
  const others = Object.values(CARDS)
    .filter(c => c.color === color && c.type !== 'node')
    .flatMap(c => Array(c.type === 'meme' ? 3 : 2).fill(c.id));
  const deck = [...nodes, ...others];
  // Pad/truncate to exactly 60
  while (deck.length < 60) deck.push(`node_${color}`);
  return deck.slice(0, 60);
}

export const STARTER_DECKS: Record<Color, string[]> = {
  bnb: starterDeck('bnb'),
  sol: starterDeck('sol'),
  avax: starterDeck('avax'),
  eth: starterDeck('eth'),
  xrp: starterDeck('xrp'),
};

export const DEFAULT_MATCHUP: [Color, Color] = ['sol', 'eth'];

// ── Deckbuilding ────────────────────────────────────────────────────────────

/** Every card a player can put in a custom deck (the standard pool). */
export const BUILDABLE_CARDS: CardDef[] = Object.values(CARDS);

/** Deck rule constants. */
export const DECK_SIZE = 60;
export const MAX_COPIES_NONBASIC = 4; // basic chain nodes are unlimited; everything else capped at 4

export function isBasicNode(defId: string): boolean {
  return defId.startsWith('node_');
}

export type DeckIssue = { code: string; message: string };
export type DeckValidation = { ok: boolean; size: number; issues: DeckIssue[] };

/** Validate a custom deck. Returns ok + total size + every issue (so the UI can list them all). */
export function validateDeck(cards: string[], opts?: { requireSize?: boolean }): DeckValidation {
  const requireSize = opts?.requireSize ?? true;
  const issues: DeckIssue[] = [];
  const size = cards.length;
  if (requireSize && size !== DECK_SIZE) {
    issues.push({
      code: 'size',
      message: `Deck must be exactly ${DECK_SIZE} cards (currently ${size}).`,
    });
  }
  const counts: Record<string, number> = {};
  for (const id of cards) {
    if (!CARDS[id]) {
      issues.push({ code: 'unknown', message: `Unknown card id: ${id}` });
      continue;
    }
    counts[id] = (counts[id] ?? 0) + 1;
  }
  for (const [id, n] of Object.entries(counts)) {
    if (!isBasicNode(id) && n > MAX_COPIES_NONBASIC) {
      issues.push({
        code: 'copies',
        message: `Too many copies of ${CARDS[id].name} (${n}/${MAX_COPIES_NONBASIC}).`,
      });
    }
  }
  return { ok: issues.length === 0, size, issues };
}

/**
 * Derive a primary color from a deck — used to set `player.color` and the deck's
 * theme when a custom deck is selected. Counts non-node cards by color (since
 * nodes generate, they shouldn't tilt the theme); falls back to majority node
 * color, then 'sol'.
 */
export function derivePrimaryColor(cards: string[]): Color {
  const counts: Record<Color, number> = { bnb: 0, sol: 0, avax: 0, eth: 0, xrp: 0 };
  let any = false;
  for (const id of cards) {
    const def = CARDS[id]; if (!def) continue;
    if (def.type === 'node') continue;
    counts[def.color]++;
    any = true;
  }
  if (!any) {
    for (const id of cards) {
      const def = CARDS[id]; if (!def) continue;
      counts[def.color]++;
    }
  }
  let best: Color = 'sol'; let bestN = -1;
  for (const c of COLORS) {
    if (counts[c] > bestN) { best = c; bestN = counts[c]; }
  }
  return best;
}
