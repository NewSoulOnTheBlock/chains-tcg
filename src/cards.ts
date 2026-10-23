// src/cards.ts
// Card catalogue + starter decks. Five Sproto Gremlin factions (see COLOR_META).

export type Color = 'bnb' | 'sol' | 'eth' | 'robinhood' | 'base';

export const COLORS: Color[] = ['bnb', 'sol', 'eth', 'robinhood', 'base'];

// The five Sproto Gremlin factions. The KEYS (nb, sol, …) are the
// original chain-era ids and are deliberately unchanged: card ids, saved decks,
// NFT metadata and the backend all key on them. Only what players see changed.
//   bnb → Spirit (white)   sol → Rebel (red)   eth → Jester (black)
//   robinhood → Wealth (green)   base → Knowledge (blue)
export const COLOR_META: Record<Color, { name: string; hex: string; ink: string; template?: string; glyph?: string }> = {
  bnb:       { name: 'Spirit',    hex: '#efe6cc', ink: '#1d1a12', glyph: 'SPR' },
  sol:       { name: 'Rebel',     hex: '#e0362c', ink: '#fff',    glyph: 'RBL' },
  eth:       { name: 'Jester',    hex: '#7a6d8f', ink: '#fff',    glyph: 'JST' },
  robinhood: { name: 'Wealth',    hex: '#2fae4e', ink: '#08130b', glyph: 'WLT' },
  base:      { name: 'Knowledge', hex: '#2f6fe0', ink: '#fff',    glyph: 'KNW' },
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

/**
 * Token logo sourced from CoinMarketCap, vendored into `public/cards/` at
 * build-authoring time rather than hotlinked from s2.coinmarketcap.com — the
 * production gateway's `default-src 'self'` CSP blocks third-party img hosts.
 * The argument is still the CMC coin id so the provenance stays greppable.
 *
 * Adding a new one: `curl -o public/cards/cmc-<id>.png
 * https://s2.coinmarketcap.com/static/img/coins/128x128/<id>.png`.
 */
const cmc = (id: number) => `/cards/cmc-${id}.png`;

/** Image overrides keyed by card id. Cards without an entry render the chain glyph. */
const IMAGES: Record<string, string> = {
  // Nodes have no art entry: they render their faction sigil (src/chain-logos.tsx).

  // BnB memes
  bnb_babydoge: '/cards/babydoge.png?v=1',
  bnb_broccoli: '/cards/broccoli.png?v=1',
  bnb_tut:      cmc(33687),
  bnb_tst:      '/cards/tst.png?v=1',
  bnb_banana:   '/cards/banana.jpg?v=1',
  bnb_mubarak:  '/cards/bocca.jpg?v=1',
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

  // Robinhood memes (meme-stocks — emoji glyph art)
  robinhood_hood:    '/cards/robinhood_hood.png?v=1',
  robinhood_ozzy:    '/cards/robinhood_ozzy.png?v=1',
  robinhood_cashcat: '/cards/robinhood_cashcat.png?v=1',
  robinhood_kitty:   '/cards/robinhood_kitty.png?v=1',
  robinhood_tendies: '/cards/robinhood_tendies.png?v=1',
  robinhood_moon:    '/cards/robinhood_moon.png?v=1',
  robinhood_yolo:    '/cards/robinhood_yolo.png?v=1',
  robinhood_ape:     '/cards/robinhood_ape.png?v=1',

  // Ethereum memes
  eth_andy:     '/cards/andy.png?v=1',
  eth_apu:      '/cards/apu.webp?v=1',
  eth_wojak:    '/cards/wojak.png?v=2',
  eth_turbo:    '/cards/turbo.png?v=1',
  eth_mog:      '/cards/mog.png?v=2',
  eth_shib:     '/cards/shib.png?v=1',
  eth_pepe:     '/cards/pepe.png?v=1',

  // Base memes (BRETT keeps its painted art, rest emoji glyph)
  base_brett:   '/cards/brett.png?v=1',
  base_degen:   '/cards/base_degen.png?v=1',
  base_toshi:   '/cards/base_toshi.png?v=1',
  base_miggles: '/cards/base_miggles.png?v=1',
  base_keycat:  '/cards/base_keycat.png?v=1',
  base_normie:  '/cards/base_normie.png?v=1',
  base_doginme: '/cards/base_doginme.png?v=1',
  base_based:   '/cards/base_based.png?v=1',

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
  sol_bounce:   '/cards/sol_bounce.png?v=1',
  sol_tgpump:   '/cards/sol_tgpump.png?v=1',

  // ── Robinhood machines/moves/aura ──
  robinhood_dividend:   '/cards/robinhood_dividend.png?v=1',
  robinhood_options:    '/cards/robinhood_options.png?v=1',
  robinhood_fractional: '/cards/robinhood_fractional.png?v=1',
  robinhood_margin:     '/cards/robinhood_margin.png?v=1',
  robinhood_buydip:     '/cards/robinhood_buydip.png?v=1',
  robinhood_gamma:      '/cards/robinhood_gamma.png?v=1',
  robinhood_pfof:       '/cards/robinhood_pfof.png?v=1',
  robinhood_diamond:    '/cards/robinhood_diamond.png?v=1',

  // ── Ethereum machines/moves ──
  eth_eip1559:  '/cards/smart_contract_suite.png?v=1',
  eth_temple:   '/cards/eth_temple.png?v=1',
  eth_l2:       '/cards/layer2_rollup.png?v=1',
  eth_yield:    '/cards/eth_yield.png?v=1',
  eth_smite:    '/cards/eth_smite.png?v=1',
  eth_heal:     '/cards/dca_in.png?v=1',
  eth_exploit:  '/cards/exploit_disclosure.png?v=1',

  // ── Base machines/moves/aura ──
  base_summer:    '/cards/base_summer.png?v=1',
  base_frames:    '/cards/base_frames.png?v=1',
  base_wallet:    '/cards/base_wallet.png?v=1',
  base_onramp:    '/cards/base_onramp.png?v=1',
  base_tip:       '/cards/base_tip.png?v=1',
  base_bridge:    '/cards/base_bridge.png?v=1',
  base_airdrop:   '/cards/base_airdrop.png?v=1',
  base_staybased: '/cards/base_staybased.png?v=1',
  // ── Auras (Genesis set) — emoji-art for now ──
  bnb_liquidity:  '/cards/bnb_liquidity.png?v=1',
  sol_validator:  '/cards/sol_validator.png?v=1',
  eth_shield:     '/cards/eth_shield.png?v=1',
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
reg(N('bnb'), N('sol'), N('eth'), N('robinhood'), N('base'));

// Spirit Sprotos (white) — go wide, lift the whole host, cleanse the field.
// (Internal key `bnb`: ids are stable storage keys, see COLOR_META.)
reg(
  M('bnb_babydoge','bnb', 'Candle Acolyte',   1, 1, 1, 'Lights one wick every sunrise. Never misses.'),
  M('bnb_broccoli','bnb', 'Halo Hatchling',   1, 2, 1, 'Born glowing. Never learned how to stop.'),
  M('bnb_tut',     'bnb', 'Choir Sproto',     2, 2, 2, 'Sings off-key, but always in unison.'),
  M('bnb_tst',     'bnb', 'Pilgrim Sproto',   2, 3, 2, 'Walked here from the genesis block. Barefoot.'),
  M('bnb_banana',  'bnb', 'Lantern Warden',   3, 3, 3, 'Keeps the shrine lit through the longest night.'),
  M('bnb_mubarak', 'bnb', 'Bocca De Verita',  3, 4, 3, 'Put your hand in. Tell the truth.'),
  M('bnb_cheems',  'bnb', 'Seraph Sproto',    4, 4, 4, 'Six wings. Zero sell orders.'),
  M('bnb_floki',   'bnb', 'More Light',       5, 6, 5, 'Leader of the gremlins. Asks only for more.'),
  // Machines
  A('bnb_farm',     'bnb', 'Shrine of Many',     3, 'pump_all_+1+1',         'Every Sproto in the light grows: your Memes get +1/+1.'),
  A('bnb_bridge',   'bnb', 'Pilgrim Road',       2, 'extra_node_per_turn',   'You may play one extra Node each turn.'),
  A('bnb_sniper',   'bnb', 'Dawn Bell',          4, 'meme_haste',            'Your Memes have no summoning sickness.'),
  A('bnb_mmalgo',   'bnb', 'Banner of the Host', 3, 'pump_attackers_+1+0',   'Your attacking Memes get +1/+0.'),
  // Moves
  X('bnb_rugpull',  'bnb', 'Exorcism',          2, 'destroyMeme',           'Cast it out. Destroy target Meme.'),
  X('bnb_airdrop',  'bnb', 'Revelation',        3, 'drawTwo',               'The light shows two paths. Draw two cards.'),
  X('bnb_honeypot', 'bnb', 'Blinding Dawn',     3, 'damageAll_1',           'Every Meme on the field takes 1 damage.'),
  // Aura
  U('bnb_liquidity','bnb', 'Blessing',          2, 'aura_+2+2',             'Enchant Meme. Attached Meme gets +2/+2.'),
);

// Rebel Sprotos (red) — burn, snipe, hit first and fast.
// (Internal key `sol`.)
reg(
  M('sol_pnut',    'sol', 'Spark Gremlin',     1, 2, 1, 'Small, loud, and already on fire.'),
  M('sol_bonk',    'sol', 'Brick Tosser',      1, 1, 2, 'Aims for the windows. Hits the windows.'),
  M('sol_popcat',  'sol', 'Riot Drummer',      2, 2, 3, 'Keeps the beat while everything burns.'),
  M('sol_mew',     'sol', 'Graffiti Sproto',   2, 3, 2, 'Tags every wall it can reach, and some it cannot.'),
  M('sol_bome',    'sol', 'Molotov Mixer',     3, 3, 3, 'Required ingredients: one bottle, no plan.'),
  M('sol_wif',     'sol', 'Barricade Breaker', 3, 4, 2, 'The wall was only ever a suggestion.'),
  M('sol_fartcoin','sol', 'Firestarter Sproto',4, 5, 4, 'Did not start the fire. Is the fire.'),
  M('sol_goat',    'sol', 'Rebel Warlord',     5, 6, 5, 'Overthrew the last warlord. Kept the hat.'),
  // Machines
  A('sol_priority','sol', 'Black Market Forge', 2, 'gas_discount_color',    'Your Moves cost 1 less Rebel gas (min 0).'),
  A('sol_oracle',  'sol', 'Pirate Radio',       3, 'on_meme_etb_draw',      'When a Meme enters under you, draw a card (once per turn).'),
  A('sol_amm',     'sol', 'War Drums',          4, 'meme_haste',            'Your Memes have no summoning sickness.'),
  A('sol_tgbot',   'sol', 'Burning Banner',     3, 'pump_attackers_+1+0',   'Your attacking Memes get +1/+0.'),
  // Moves
  X('sol_zap',     'sol', 'Firebomb',          1, 'damage3',               'Lit and thrown. Deal 3 damage to any target.'),
  X('sol_bounce',  'sol', 'Scatter',           2, 'bounceMeme',            'Everybody run. Return target Meme to its owner\'s hand.'),
  X('sol_tgpump',  'sol', 'Cheap Shot',        1, 'damage2',               'Nobody said fair. Deal 2 damage to any target.'),
  // Aura
  U('sol_validator','sol', 'Adrenaline',       2, 'aura_haste',            'Enchant Meme. Attached Meme has no summoning sickness.'),
);

// Wealth Sprotos (green) — lifegain midrange, sturdy bodies, compounding.
// (Internal key `robinhood`.)
reg(
  M('robinhood_hood',    'robinhood', 'Coin Sprout',     1, 1, 2, 'Plant a penny. Wait.'),
  M('robinhood_ozzy',    'robinhood', 'Vault Toad',      2, 1, 4, 'Sits on the gold. Never moves. Never needs to.'),
  M('robinhood_cashcat', 'robinhood', 'Golden Grub',     2, 2, 3, 'Eats copper. Sheds gold.'),
  M('robinhood_kitty',   'robinhood', 'Orchard Keeper',  3, 3, 4, 'Every tree in the grove pays rent.'),
  M('robinhood_tendies', 'robinhood', 'Harvest Sproto',  3, 4, 3, 'Reaps what it sowed, and a little of yours.'),
  M('robinhood_moon',    'robinhood', 'Treasure Golem',  4, 4, 5, 'Built from interest. Still compounding.'),
  M('robinhood_yolo',    'robinhood', 'Gilded Boar',     5, 6, 4, 'Charges through the fence and the price tag.'),
  M('robinhood_ape',     'robinhood', 'Old Money',       6, 6, 7, 'Was rich before rich had a name.'),
  // Machines
  A('robinhood_dividend',  'robinhood', 'Treasury',          2, 'lifelink_all',        'The vault pays you back: you heal when your Memes deal damage.'),
  A('robinhood_options',   'robinhood', 'Golden Spurs',      3, 'pump_attackers_+1+0', 'Your attacking Memes get +1/+0.'),
  A('robinhood_fractional','robinhood', 'Ledger of Plenty',  3, 'on_meme_etb_draw',    'When a Meme enters under you, draw a card (once per turn).'),
  A('robinhood_margin',    'robinhood', 'Fertile Grove',     3, 'pump_all_+1+1',       'Everything here grows: your Memes get +1/+1.'),
  // Moves
  X('robinhood_buydip', 'robinhood', 'Bountiful Harvest', 2, 'gainLife4', 'The granary overflows. Gain 4 life.'),
  X('robinhood_gamma',  'robinhood', 'Stampede',          3, 'damage5',   'The herd runs one way. Deal 5 damage to any target.'),
  X('robinhood_pfof',   'robinhood', 'Count the Coins',   3, 'drawTwo',   'Twice, to be sure. Draw two cards.'),
  // Aura
  U('robinhood_diamond','robinhood', 'Gold Plating',      2, 'aura_+0+3', 'Enchant Meme. Attached Meme gets +0/+3.'),
);

// Jester Sprotos (black) — removal, control, the last laugh.
// (Internal key `eth`.)
reg(
  M('eth_andy',    'eth', 'Pocket Jester',     1, 2, 2, 'Fits in your pocket. Leaves with your wallet.'),
  M('eth_apu',     'eth', 'Mask Collector',    1, 1, 3, 'Already has your face. Wants the rest.'),
  M('eth_wojak',   'eth', 'Weeping Clown',     2, 2, 3, 'Laughs at funerals. Cries at weddings.'),
  M('eth_turbo',   'eth', 'Knife Juggler',     2, 3, 1, 'Drops one every show. On purpose.'),
  M('eth_mog',     'eth', 'Grinning Sproto',   3, 3, 4, 'The smile goes all the way around.'),
  M('eth_shib',    'eth', 'Court Fool',        3, 4, 3, 'Tells the king the truth. Then poisons him.'),
  M('eth_pepe',    'eth', 'The Last Laugh',    5, 5, 6, 'It was always going to be him.'),
  // NFT-linked meme — ETB zaps opp + draws a card (Sproto Gremlin NFT mint)
  ME('eth_sproto_gremlin', 'eth', 'Sproto Gremlin', 2, 2, 2, 'etb_zap_2_and_draw',
     'When ~ enters the field, deal 2 damage to your opponent and draw a card.'),
  // Machines
  A('eth_eip1559', 'eth', 'Trick Deck',        3, 'gas_discount_color',    'Every card a trick: your Moves cost 1 less Jester gas (min 0).'),
  A('eth_temple',  'eth', 'Carnival of Masks', 4, 'pump_all_+1+1',         'The show goes on: your Memes get +1/+1.'),
  A('eth_l2',      'eth', 'Trapdoor Stage',    4, 'meme_haste',            'Enter laughing: your Memes have no summoning sickness.'),
  A('eth_yield',   'eth', 'Jack-in-the-Box',   3, 'pump_attackers_+1+0',   'Your attacking Memes get +1/+0.'),
  // Moves
  X('eth_smite',   'eth', 'Punchline',         3, 'damage5',               'Timing is everything. Deal 5 damage to any target.'),
  X('eth_heal',    'eth', 'Fake Death',        2, 'gainLife4',             'Get up once the crowd leaves. Gain 4 life.'),
  X('eth_exploit', 'eth', 'Sabotage',          2, 'destroyMachine',        'Loosen one bolt. Destroy target Machine.'),
  // Aura
  U('eth_shield',  'eth', 'Mirror Mask',       2, 'aura_+0+3',             'Enchant Meme. Attached Meme gets +0/+3.'),
);

// Knowledge Sprotos (blue) — card advantage, tricks, cheap swarm.
// (Internal key `base`.)
reg(
  M('base_degen',   'base', 'Ink Imp',           1, 2, 1, 'Writes faster than it reads.'),
  M('base_toshi',   'base', 'Page Turner',       1, 1, 2, 'Lost in the same book since the first block.'),
  M('base_brett',   'base', 'Scroll Runner',     2, 3, 2, 'Delivers the message before you send it.'),
  M('base_miggles', 'base', 'Apprentice Sproto', 2, 2, 2, 'Knows one spell. Uses it constantly.'),
  M('base_keycat',  'base', 'Rune Scribe',       3, 3, 3, 'Every mark means something. Most mean "mine".'),
  M('base_normie',  'base', 'Owl Familiar',      3, 4, 2, 'Knows what you are thinking. Disapproves.'),
  M('base_doginme', 'base', 'Tower Sage',        4, 4, 4, 'Read every book in the tower. Wrote half of them.'),
  M('base_based',   'base', 'The Archivist',     5, 5, 5, 'Remembers everything. Forgives nothing overdue.'),
  // Machines
  A('base_summer', 'base', 'Great Library',  3, 'pump_all_+1+1',       'Everyone studies: your Memes get +1/+1.'),
  A('base_frames', 'base', 'Crystal Ball',   3, 'on_meme_etb_draw',    'When a Meme enters under you, draw a card (once per turn).'),
  A('base_wallet', 'base', 'Star Chart',     2, 'extra_node_per_turn', 'Plot the course: play one extra Node each turn.'),
  A('base_onramp', 'base', 'Portal Circle',  4, 'meme_haste',          'Step through ready: your Memes have no summoning sickness.'),
  // Moves
  X('base_tip',     'base', 'Study Session', 3, 'drawTwo',      'One more chapter. Draw two cards.'),
  X('base_bridge',  'base', 'Banish',        2, 'bounceMeme',   'Not gone, just elsewhere. Return target Meme to its owner\'s hand.'),
  X('base_airdrop', 'base', 'Arcane Storm',  3, 'damageAll_1',  'Every Meme on the field takes 1 damage.'),
  // Aura
  U('base_staybased','base', 'Spellblade',   2, 'aura_+3+0',    'Enchant Meme. Attached Meme gets +3/+0.'),
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
  eth: starterDeck('eth'),
  robinhood: starterDeck('robinhood'),
  base: starterDeck('base'),
};

export const DEFAULT_MATCHUP: [Color, Color] = ['base', 'eth'];

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
  const counts: Record<Color, number> = { bnb: 0, sol: 0, eth: 0, robinhood: 0, base: 0 };
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
  let best: Color = 'eth'; let bestN = -1;
  for (const c of COLORS) {
    if (counts[c] > bestN) { best = c; bestN = counts[c]; }
  }
  return best;
}
