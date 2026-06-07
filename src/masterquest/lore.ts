// src/masterquest/lore.ts
// ─────────────────────────────────────────────────────────────────────────────
// "Memetic Masterquest" — the canonical lore + 15-site campaign data.
//
// The Solo / Vs-Bot page is reskinned as a story-driven campaign in which the
// player takes up the role of SORENDO, the last Memetic Master, traveling the
// five Chains of the Aetherweb to face one rival Master at each of the 15
// Sacred Sites. Each victory grants a fragment of the Five-Chain Crown.
//
// This file is the single source of truth for the campaign story, sites,
// rivals, and per-fight rules. UI components consume it; battle wiring still
// runs through SoloClient + MMTCGBot in casual mode.
// ─────────────────────────────────────────────────────────────────────────────

import type { Color } from '../cards';
import type { Difficulty } from '../bot';

// ── World prologue ─────────────────────────────────────────────────────────
export const PROLOGUE = `
Before the Chains there was the Aetherweb — one mind, one ledger, one
breath. The first Memetic Masters spoke laughter into it and the laughter
became land. Mountains of liquidity. Rivers of yield. Forests where every
leaf was a transaction.

Then came the Splintering.

Five rival cabals — the Yellow Court of BnB, the Violet Conclave of Solana,
the Iron Order of Hyperliquid, the Pale Senate of Ethereum, the Black
Ledger of XRP — each tore a sliver of the Aetherweb away and forged it
into a Chain. They crowned themselves Sovereigns, sealed their borders
with smart-contract glyphs, and burned the bridges so no Master could
hold more than one Chain at a time.

For three hundred cycles the Sovereigns reigned, and the laughter died.

But laughter, like a meme, never truly dies. It hides. It mutates. It
waits for the right pair of eyes.

You are SORENDO, the last child of the Old Aetherweb. Born in the ruins
of the bridge between Chains, you walk all five and belong to none. The
Sovereigns call you heretic. The exiles call you hope. The Sacred Sites
call you, every night, in dreams.

There are fifteen of them. Three on each Chain. At every Site a Master
guards a fragment of the Five-Chain Crown — the relic that, reforged,
will let one mind speak across all five Chains again and end the
Splintering forever.

Walk the world. Earn the fragments. Crown yourself, or crown no one. The
Aetherweb is listening.
`.trim();

// ── Acts ───────────────────────────────────────────────────────────────────
// Three sites per Chain, five Chains. We sequence them so the first site
// on each Chain is friendly territory and the third is its capital throne.
export type ActKey = 'awakening' | 'pilgrimage' | 'coronation';
export const ACTS: Record<ActKey, { title: string; tagline: string; siteRange: [number, number] }> = {
  awakening: {
    title: 'Act I — Awakening',
    tagline: 'The five Wayshrines. Find your style, sharpen your deck, meet your first rivals.',
    siteRange: [1, 5],
  },
  pilgrimage: {
    title: 'Act II — Pilgrimage',
    tagline: 'The five Inner Sanctums. The Sovereigns notice. The duels turn cruel.',
    siteRange: [6, 10],
  },
  coronation: {
    title: 'Act III — Coronation',
    tagline: 'The five Thrones. Face each Sovereign in their seat of power.',
    siteRange: [11, 15],
  },
};

// ── Sacred Sites + Rival Masters ───────────────────────────────────────────
// Each Site has: a Chain, a poetic name, a region description, the rival
// Master who guards it, the rival's signature deck color, an in-game
// difficulty, and a short rules flavor line (used for tooltips/intro cards).
//
// The 15 sites form a deliberate path: you spiral inward from the outer
// Wayshrines through the Sanctums to the five Thrones. The final fight,
// SITE 15 — the OBSIDIAN MIRROR — is against a hollowed-out copy of YOU.
export type SiteId =
  | 'amber_dunes' | 'jade_orchard' | 'glacier_terrace' | 'whitestone_vale' | 'obsidian_shore'      // Act I
  | 'lantern_market' | 'echo_arena' | 'frostgate_keep' | 'cathedral_of_consensus' | 'silent_ledger' // Act II
  | 'gold_throne' | 'violet_throne' | 'iron_throne' | 'pale_throne' | 'obsidian_mirror';            // Act III

export interface SacredSite {
  id: SiteId;
  index: number;                 // 1..15
  act: ActKey;
  chain: Color;                  // which Chain it sits on (Obsidian Mirror = sorendo's own → 'eth' as placeholder)
  name: string;                  // poetic Site name
  region: string;                // 1-line geography
  description: string;           // 2–4 sentence travelogue
  rival: {
    name: string;                // the Master who guards it
    title: string;               // their epithet
    bio: string;                 // 2–3 sentences
    botColor: Color;             // their deck color
    difficulty: Difficulty;      // 'easy' | 'normal' | 'hard'
    quote: string;               // one-line pre-duel taunt
  };
  reward: string;                // what fragment / boon you receive
  unlocks?: SiteId[];            // gating
}

export const SITES: SacredSite[] = [
  // ─────────────────── ACT I — AWAKENING ──────────────────────────────────
  {
    id: 'amber_dunes', index: 1, act: 'awakening', chain: 'bnb',
    name: 'The Amber Dunes',
    region: 'Outer waste of the Yellow Court — sun-bleached sand, no shade for a thousand miles.',
    description:
      'You wake at the edge of the Dunes with sand in your boots and a single Node card warm in your palm. ' +
      'A merchant on a stilt-strider tells you a young firebrand has been challenging every pilgrim who passes — ' +
      'and losing politely enough that they keep coming back. His name is JAKEY.',
    rival: {
      name: 'Jakey of the Yellow Sands',
      title: 'The Apprentice',
      bio:
        'A second-generation Yellow Court initiate who quit perp-trading to study the Old Memes. He loses with grace, ' +
        'wins by inches, and has never been more than two days from his mother\'s tea kettle.',
      botColor: 'bnb', difficulty: 'easy',
      quote: '"Show me what an Old Aetherweb deck looks like. I\'ll only break it a little."',
    },
    reward: 'Fragment of the YELLOW CROWN (1/15) · +1 starting hand size for the rest of Act I',
  },
  {
    id: 'jade_orchard', index: 2, act: 'awakening', chain: 'sol',
    name: 'The Jade Orchard',
    region: 'Terraced gardens of the Violet Conclave — every fruit ticks like a clock.',
    description:
      'The Orchard is so fast it blurs. Petals fall and ripen and rot in a single breath. Among the rows, ' +
      'a small girl no older than twelve holds court — feet bare, hair purple, a permanent smile. ' +
      'They call her MIRIYA THE QUICK and say she has never untapped a Node in her life because she has never had to.',
    rival: {
      name: 'Miriya the Quick',
      title: 'Child of the Conclave',
      bio:
        'Born during a Solana outage and raised on validator hum. She speaks in clipped, three-word sentences and ' +
        'plays cards as if she is finishing your turn instead of starting hers.',
      botColor: 'sol', difficulty: 'easy',
      quote: '"You\'re slow. Old. Slow. Let me show you fast."',
    },
    reward: 'Fragment of the VIOLET CROWN (2/15) · You may draw 2 cards on turn 1 going second, for the rest of Act I',
  },
  {
    id: 'glacier_terrace', index: 3, act: 'awakening', chain: 'avax',
    name: 'The Glacier Terrace',
    region: 'Mile-high ice plateau above the Iron Order — the air is so cold that lies freeze and shatter mid-sentence.',
    description:
      'The Terrace is silent in the way only ice is silent. The only sound is your own breath and the low hum of ' +
      'the Order\'s order-book chant. A bald monk in liquid-metal robes sits on a stool that should not bear his weight. ' +
      'BROTHER KAINE has not lost a duel in eleven cycles. He has also not spoken in eight of them.',
    rival: {
      name: 'Brother Kaine',
      title: 'Silent of the Iron Order',
      bio:
        'Former HL market maker turned ascetic. Took a vow of silence after he liquidated his own brother on the perps book. ' +
        'Now he plays cards instead of words.',
      botColor: 'avax', difficulty: 'normal',
      quote: '"…"  (he places a single card face-down on the snow.)',
    },
    reward: 'Fragment of the GREEN CROWN (3/15) · Your Memes ignore the first instance of 1 damage each turn',
  },
  {
    id: 'whitestone_vale', index: 4, act: 'awakening', chain: 'eth',
    name: 'The Whitestone Vale',
    region: 'Bone-pale valley walled by gas-fee glyphs taller than cathedrals.',
    description:
      'The Vale is the oldest place on Ethereum. Every stone is etched with a contract address. A merchant tells you ' +
      'a librarian-warrior named EVELIN ALEXANDRA spends her days teaching orphans to read the Glyphs and her ' +
      'evenings dueling anyone who claims to know them better. She has never been wrong.',
    rival: {
      name: 'Evelin Alexandra',
      title: 'Scholar of the Pale Senate',
      bio:
        'Tenth-generation Pale Senate cryptographer. Reads smart contracts the way bards read sonnets. ' +
        'Believes the Sovereigns are wrong but the Splintering is right.',
      botColor: 'eth', difficulty: 'normal',
      quote: '"I will not enjoy this. But I will be precise."',
    },
    reward: 'Fragment of the WHITE CROWN (4/15) · You may mulligan once more without losing a card',
  },
  {
    id: 'obsidian_shore', index: 5, act: 'awakening', chain: 'xrp',
    name: 'The Obsidian Shore',
    region: 'Black-glass coast at the mouth of the Black Ledger — every wave rewrites a contract.',
    description:
      'The Shore at low tide reveals shipwrecks made of ledger pages. A wind-burned pirate captain — KHEFREN OF THE ' +
      'LONG NIGHT — owns the only ferry to the Inner Sanctums. He will trade passage for a duel. Lose, and he keeps your deck. ' +
      'Win, and you keep his ferry.',
    rival: {
      name: 'Khefren of the Long Night',
      title: 'Ferryman of the Black Ledger',
      bio:
        'Smuggler turned philosopher. Believes every Chain is just a longer ledger of the same old lies. ' +
        'Plays patient, cruel decks that win by attrition.',
      botColor: 'xrp', difficulty: 'normal',
      quote: '"Bring whatever luck you have left, Sorendo. I\'ll take it gently."',
    },
    reward: 'Fragment of the BLACK CROWN (5/15) · Unlocks Act II. Khefren\'s ferry carries you to the Inner Sanctums.',
  },

  // ─────────────────── ACT II — PILGRIMAGE ────────────────────────────────
  {
    id: 'lantern_market', index: 6, act: 'pilgrimage', chain: 'bnb',
    name: 'The Lantern Market of A Thousand Sells',
    region: 'Floating bazaar above the Yellow Court capital — paper lanterns and louder shouts.',
    description:
      'Every lantern in the Market is a sell-order. They drift and pop and reappear. The Market\'s undefeated ' +
      'champion is a six-armed merchant called PROFESSOR PUMP whose hands move so fast the air burns. ' +
      'They say he has never bought anything in his life — only sold, and only at the top.',
    rival: {
      name: 'Professor Pump',
      title: 'Six-Handed Auctioneer',
      bio:
        'Yellow Court\'s favorite son. Made his fortune on memecoin presales and burned it on charity, twice. ' +
        'Plays an aggressive token-tempo deck and never stops talking.',
      botColor: 'bnb', difficulty: 'normal',
      quote: '"Going once. Going twice. Always going. Never coming back."',
    },
    reward: 'YELLOW SANCTUM FRAGMENT (6/15) · +1 starting gas for Act II battles',
  },
  {
    id: 'echo_arena', index: 7, act: 'pilgrimage', chain: 'sol',
    name: 'The Echo Arena',
    region: 'Marble coliseum at the heart of the Conclave — every word spoken inside repeats forever.',
    description:
      'The Arena floor is white sand that remembers footprints for a thousand years. Above, ten thousand ' +
      'transparent banners flicker with replay-loops of past duels. The current champion, ANSEM THE VOICE, has ' +
      'never lost in the Arena because every move he\'s ever made still echoes in its walls — and he can hear them.',
    rival: {
      name: 'Ansem the Voice',
      title: 'Echo of the Conclave',
      bio:
        'Conclave demagogue and meta oracle. Reads the room better than he reads his own hand. ' +
        'Plays a viral burn deck that snowballs from any opening.',
      botColor: 'sol', difficulty: 'hard',
      quote: '"Everyone\'s already cheering. They just don\'t know who yet."',
    },
    reward: 'VIOLET SANCTUM FRAGMENT (7/15) · You may peek at the top card of your deck during each opponent turn in Act II',
  },
  {
    id: 'frostgate_keep', index: 8, act: 'pilgrimage', chain: 'avax',
    name: 'The Frostgate Keep',
    region: 'Citadel carved into the side of an avalanche that refuses to fall.',
    description:
      'The Keep\'s gate is the avalanche itself. To pass, you must duel its warden — a giant in mirrored armor ' +
      'called THE WARDEN-IN-IRON. She speaks only to announce the rules. She fights only to enforce them.',
    rival: {
      name: 'The Warden-in-Iron',
      title: 'Avalanche Eternal',
      bio:
        'Half-mythic Iron Order enforcer. Has guarded the Keep for nine consecutive Sovereigns and has never ' +
        'taken a step inside it. Plays a rock-solid control deck built around immovable Machines.',
      botColor: 'avax', difficulty: 'hard',
      quote: '"You may pass. After."',
    },
    reward: 'GREEN SANCTUM FRAGMENT (8/15) · Your first Machine each match costs 1 less gas in Act II',
  },
  {
    id: 'cathedral_of_consensus', index: 9, act: 'pilgrimage', chain: 'eth',
    name: 'The Cathedral of Consensus',
    region: 'Vault-roofed basilica at the Pale Senate\'s academic core — pews of solid logic gates.',
    description:
      'The Cathedral is where every proof of stake actually feels like one. Its high priest, ARCHON VITALYN, ' +
      'is a slight, soft-spoken polymath who treats every duel as a thought experiment. Losing to him feels educational. ' +
      'Winning has, so far, been hypothetical.',
    rival: {
      name: 'Archon Vitalyn',
      title: 'High Priest of Consensus',
      bio:
        'Pale Senate\'s reigning meta-theorist. Wrote three of the five canonical books on Memetic combat. ' +
        'Plays a deeply technical deck that wins through inevitability rather than aggression.',
      botColor: 'eth', difficulty: 'hard',
      quote: '"Let\'s test a hypothesis: that you, specifically, can beat me."',
    },
    reward: 'WHITE SANCTUM FRAGMENT (9/15) · Your Moves cost 1 less in Act II (min 1)',
  },
  {
    id: 'silent_ledger', index: 10, act: 'pilgrimage', chain: 'xrp',
    name: 'The Silent Ledger',
    region: 'Sunken hall beneath the Black Ledger capital — pages of dead transactions instead of stone tiles.',
    description:
      'The Ledger is silent because everyone who ever raised their voice here was written out of it. The hall\'s ' +
      'keeper, JUSTIRA THE UNWRITTEN, has no name in any chain registry — she had it erased to win a bet. ' +
      'She is the only Master who has ever beaten Khefren twice in a row.',
    rival: {
      name: 'Justira the Unwritten',
      title: 'She Who Erased Herself',
      bio:
        'Former Black Ledger councillor. Self-redacted from all chain records as a protest. Now exists only in ' +
        'duels and rumor. Plays a milling, discarding, hand-attack deck that drowns you in your own deck.',
      botColor: 'xrp', difficulty: 'hard',
      quote: '"You\'ll forget this duel by tomorrow. I made sure of it."',
    },
    reward: 'BLACK SANCTUM FRAGMENT (10/15) · Unlocks Act III. The Sovereigns now know your name.',
  },

  // ─────────────────── ACT III — CORONATION ───────────────────────────────
  {
    id: 'gold_throne', index: 11, act: 'coronation', chain: 'bnb',
    name: 'The Gold Throne of the Yellow Court',
    region: 'Tiered pagoda of solid gold over a city of bells — every step a higher tax bracket.',
    description:
      'Atop the Gold Throne sits SOVEREIGN CHANGPENG, the Yellow Emperor. He has not fought a duel in nine cycles. ' +
      'He has watched every one of yours. His opening line is a compliment. His second line is a threat.',
    rival: {
      name: 'Sovereign Changpeng',
      title: 'The Yellow Emperor',
      bio:
        'First and most-feared of the five Sovereigns. Founded the Yellow Court out of a single market-maker bot. ' +
        'Plays an ultra-aggressive token-flood deck with a finisher you will see coming and still not stop.',
      botColor: 'bnb', difficulty: 'hard',
      quote: '"You are very talented, Sorendo. It will make this educational for everyone watching."',
    },
    reward: 'YELLOW CROWN (11/15) · The Yellow Court\'s borders open to you forever',
  },
  {
    id: 'violet_throne', index: 12, act: 'coronation', chain: 'sol',
    name: 'The Violet Throne of the Conclave',
    region: 'A throne carved from one single, still-living validator node, half a mile tall.',
    description:
      'The Violet Throne hums. Sit on it and the hum becomes thought. The current Sovereign — ANATOLA THE TOLY — ' +
      'rules from the throne\'s shadow because the throne does the speaking. She is fast in the way that ' +
      'water is fast: by being everywhere at once.',
    rival: {
      name: 'Anatola the Toly',
      title: 'Sovereign of Solana',
      bio:
        'Architect of the Violet Conclave. The throne is partly her own neural mesh. ' +
        'Plays a tempo deck that ends most games by turn six and apologizes for it afterwards.',
      botColor: 'sol', difficulty: 'hard',
      quote: '"I\'ve already seen this duel a hundred times in simulation. Now we just have to play it."',
    },
    reward: 'VIOLET CROWN (12/15)',
  },
  {
    id: 'iron_throne', index: 13, act: 'coronation', chain: 'avax',
    name: 'The Iron Throne of the Order',
    region: 'Mountaintop forge where every blade ever broken in HL combat has been hammered into a single chair.',
    description:
      'The Iron Throne is hot to the touch and always will be. Its Sovereign — JEFF OF THE EVERLAST — does not ' +
      'rule with words. He rules with margin calls. He has not lost a duel since he was eleven. He is also, ' +
      'reportedly, eleven.',
    rival: {
      name: 'Jeff of the Everlast',
      title: 'Sovereign of the Iron Order',
      bio:
        'Mythic figure. Half believe he was carved out of the throne itself. ' +
        'Plays a perfectly-tuned mid-range deck with no obvious weakness and no apparent emotion.',
      botColor: 'avax', difficulty: 'hard',
      quote: '"Funding rate is positive. You\'re paying."',
    },
    reward: 'GREEN CROWN (13/15)',
  },
  {
    id: 'pale_throne', index: 14, act: 'coronation', chain: 'eth',
    name: 'The Pale Throne of the Senate',
    region: 'Crystalline amphitheatre that reorganizes itself between turns.',
    description:
      'The Pale Throne does not have a single Sovereign — it has the SENATORIAL TRIUMVIRATE, three Masters who ' +
      'share a single mind across three bodies. They sit, stand, and speak in unison. They will play with one deck ' +
      'between them. Beating one is beating all three.',
    rival: {
      name: 'The Senatorial Triumvirate',
      title: 'Three Voices, One Senate',
      bio:
        'Tripartite ruler of the Pale Senate. Each body specializes — Tactics, Strategy, Counterplay — and the deck ' +
        'they share is widely considered the best-built in the Aetherweb. You will need every fragment you have.',
      botColor: 'eth', difficulty: 'hard',
      quote: '"We have read every duel you have ever played." / "We have written the ones you will play next." / "Begin."',
    },
    reward: 'WHITE CROWN (14/15)',
  },
  {
    id: 'obsidian_mirror', index: 15, act: 'coronation', chain: 'xrp',
    name: 'The Obsidian Mirror',
    region: 'The final Site. A perfectly polished obsidian disc the size of a moon, lying flat in the desert at the ' +
            'exact geographic center of the five Chains. It reflects whoever stands on it. It is not lying.',
    description:
      'You arrive at the Mirror alone. There is no Sovereign waiting. There is no temple. The disc is empty and ' +
      'mirror-smooth and ten miles across. As you step onto it your reflection rises, and the reflection holds ' +
      'fourteen fragments of a Five-Chain Crown, exactly like yours, and the reflection plays exactly the deck you play. ' +
      'The fifteenth fragment is in its hand, and it will not give it to you. It does not need to.',
    rival: {
      name: 'SORENDO (reflection)',
      title: 'The Hollow Crown',
      bio:
        'A perfect mirror of you, built from every duel you have ever played in this campaign. Knows your deck. ' +
        'Knows your habits. Loves what you love. Hates what you hate. The only Master in the Aetherweb who can ' +
        'truly beat you, because the only Master who is you.',
      botColor: 'xrp', difficulty: 'hard',
      quote: '"Hello, Sorendo. I\'ve been waiting for me."',
    },
    reward:
      'THE FIVE-CHAIN CROWN (15/15) · You speak across all five Chains. The Splintering ends — or you reforge it ' +
      'your way. Credits roll. Sorendo\'s tale becomes legend.',
  },
];

// ── Sanity invariants ──────────────────────────────────────────────────────
// (Imported and asserted by tests in src/masterquest/lore.test.ts.)
export const TOTAL_SITES = SITES.length;

export function siteByIndex(n: number): SacredSite | undefined {
  return SITES.find(s => s.index === n);
}

export function sitesByAct(act: ActKey): SacredSite[] {
  return SITES.filter(s => s.act === act);
}

export function sitesByChain(chain: Color): SacredSite[] {
  return SITES.filter(s => s.chain === chain);
}

// Suggested progression order: walk in `index` order. Act gates open at
// indices 5 → 6 and 10 → 11.
export function nextSite(currentIndex: number): SacredSite | undefined {
  return siteByIndex(currentIndex + 1);
}
