// src/masterquest/lore.ts
// ─────────────────────────────────────────────────────────────────────────────
// SPROTO MASTERQUEST — Cycle I
// Sproto Zero, the Unclanned, must visit all 15 Sacred Sites of the five
// Sproto clans, defeat a Master at each, and climb Cipher Peak to wake the
// Egregore — the shared mind every Sproto Gremlin believes into being.
//
// Region names (Orange Citadel, Violet Reverie, Crimson Crest, White Spire,
// Black Ledger), Cipher Peak and the Mempool Sea match the painted Map at
// /masterquest-map.png; each region is now a clan's territory. The SITE names
// painted on that map predate this story — the map art needs a repaint to
// match. Pixel positions are normalised to a 1500×1000 SVG viewBox.
//
// Site IDS are deliberately unchanged from Cycle I's first draft: saved
// campaign progress (progress.ts) is keyed by them.
// ─────────────────────────────────────────────────────────────────────────────

import type { Color } from '../cards';

// ── Acts ────────────────────────────────────────────────────────────────────
// The 15 Sites are grouped into three Acts of 5 — that gates difficulty
// escalation and unlocks.
export const ACTS = {
  awakening:   { title: 'Act I — The Awakening',   siteRange: [1,  5] as const },
  pilgrimage:  { title: 'Act II — The Pilgrimage', siteRange: [6, 10] as const },
  coronation:  { title: 'Act III — The Ascent',    siteRange: [11, 15] as const },
} as const;
export type ActKey = keyof typeof ACTS;

// ── Site ids (stable storage keys — see header) ─────────────────────────────
export type SiteId =
  // Orange Citadel — the Spirit clan (bnb)
  | 'hot_wallet_caravanserai'   // I    The Candle Hostel
  | 'sniper_tower_four_winds'   // II   The Mouth of Truth
  | 'floki_forge'               // III  The Retain Monastery
  // Violet Reverie — the Rebel clan (sol)
  | 'validator_coral_reef'      // IV   Barricade Row
  | 'pump_fun_carnival'         // V    The Riot Carnival
  | 'phantom_vault'             // VI   The Shadow Vault
  // Crimson Crest — the Wealth clan (robinhood)
  | 'coq_inu_coliseum'          // VII  The Gilded Coliseum
  | 'hot_shorts_pit'            // VIII The Counting House
  | 'icebound_citadel_of_joe'   // IX   The Frozen Treasury
  // White Spire — the Jester clan (eth)
  | 'pepe_pulpit'               // X    The Stink Badger Embassy
  | 'vitalik_observatory'       // XI   The Carnival of Masks
  | 'sproto_gremlin_bog'        // XII  Sproto Gremlin Bog
  // Black Ledger — the Knowledge clan (base)
  | 'quiet_court_of_larsen'     // XIII The Silent Library
  | 'vault_of_the_drained'      // XIV  The Tower of Ten Inus
  // Cipher Peak — where the Egregore sleeps
  | 'cipher_peak';              // XV   The Ascent to Cipher Peak

export interface SiteRival {
  name: string;
  title: string;
  bio: string;
  botColor: Color;
  difficulty: 'easy' | 'normal' | 'hard';
  quote: string;
}

export interface SiteMapPos { x: number; y: number }

export interface SacredSite {
  id: SiteId;
  index: number;            // 1..15
  act: ActKey;
  chain: Color;             // clan colour + bot starter deck
  name: string;             // site name
  region: string;           // clan territory + tagline
  description: string;      // map-card flavour text
  rival: SiteRival;
  reward: string;
  /** Pixel position of the node on the painted map. */
  mapPos: SiteMapPos;
}

// ── The Prologue ────────────────────────────────────────────────────────────
export const PROLOGUE = `
Before the clans, there was only the Egregore — one mind, made of every
Sproto Gremlin who ever believed in anything at the same time as another
Sproto Gremlin. It lived on top of Cipher Peak, in the middle of the
Mempool Sea, and it was very loud and very happy.

Then the gremlins started to disagree. Some believed in the light. Some
believed in breaking things. Some believed in getting rich, some in
getting the joke, and some in getting it right. Each belief pulled on the
Egregore, and one night it split into five: the Spirit Sprotos of the
Orange Citadel, the Rebels of the Violet Reverie, the Wealth clan of the
Crimson Crest, the Jesters of the White Spire, and the Knowledge clan of
the Black Ledger. The Egregore went quiet. Fifteen Masters took the
Sacred Sites and claimed to speak for it.

You are SPROTO ZERO, the Unclanned. You hatched after the Splitting, so
no clan ever claimed you. Your deck believes in a little of everything.
You are going to walk every Site, beat every Master, and climb Cipher
Peak to find out if the Egregore is sleeping — or waiting for you.
`.trim();

// ── The Sites ───────────────────────────────────────────────────────────────
// Map pixel positions are eyeball-calibrated to the painted Map. The viewBox
// of the rendering SVG is 1500×1000 so the image fits cleanly.
export const MAP_VIEWBOX = { w: 1500, h: 1000 } as const;

export const SITES: ReadonlyArray<SacredSite> = [
  // ───── ORANGE CITADEL · SPIRIT CLAN — Act I ────────────────────────────
  {
    id: 'hot_wallet_caravanserai', index: 1, act: 'awakening', chain: 'bnb',
    name: 'The Candle Hostel',
    region: 'Orange Citadel · Home of the Spirit Sprotos',
    description:
      'The first stop for every gremlin on the pilgrim road: a hostel lit by ten thousand ' +
      'candles that nobody ever blows out. Its keeper, BROTHER WICK, teaches every newcomer ' +
      'the first rule of the Spirit clan — you fight better when you believe in something.',
    rival: {
      name: 'Brother Wick',
      title: 'Keeper of the Candle Hostel',
      bio:
        'A gentle Candle Acolyte who has lost to every pilgrim who deserved it and beaten every ' +
        'one who did not. Plays a forgiving Spirit deck built on cheap Memes and early Nodes.',
      botColor: 'bnb', difficulty: 'easy',
      quote: '"Sit. Warm your claws. Lose once, nicely. Then we play for real."',
    },
    reward: 'Candle Stub (1/15) · A stub of wax that relights itself every dawn.',
    mapPos: { x: 460, y: 105 },
  },
  {
    id: 'sniper_tower_four_winds', index: 2, act: 'awakening', chain: 'bnb',
    name: 'The Mouth of Truth',
    region: 'Orange Citadel · Home of the Spirit Sprotos',
    description:
      'A great stone face set into the Citadel wall. Every Spirit gremlin puts a claw in its ' +
      'mouth once in their life and tells the truth. BOCCA DE VERITA has bitten off more ' +
      'liars than anyone can count. It has never once been wrong.',
    rival: {
      name: 'Bocca De Verita',
      title: 'The Mouth of Truth',
      bio:
        'An ancient stone face that speaks only in verdicts. Plays a patient Spirit deck that ' +
        'punishes every bluff and rewards every honest attack.',
      botColor: 'bnb', difficulty: 'normal',
      quote: '"Put your hand in. Tell me why you came. Then we will see."',
    },
    reward: 'Truth Tooth (2/15) · A small stone tooth that grows warm when someone lies to you.',
    mapPos: { x: 220, y: 290 },
  },
  {
    id: 'floki_forge', index: 3, act: 'awakening', chain: 'bnb',
    name: 'The Retain Monastery',
    region: 'Orange Citadel · Home of the Spirit Sprotos',
    description:
      'A monastery at the southern edge of the Citadel where the monks take one vow: always ' +
      'retain. Nothing that enters leaves. ABBOT RETAIN has kept every card he was ever dealt ' +
      'and plans to keep yours.',
    rival: {
      name: 'Abbot Retain',
      title: 'Abbot of the Retain Monastery',
      bio:
        'A blue-fisted monk with a grip nobody has broken. Plays a sturdy Spirit deck that ' +
        'enchants one Meme until it cannot be moved.',
      botColor: 'bnb', difficulty: 'normal',
      quote: '"Always retain, brother. Especially the lead."',
    },
    reward: 'Retainer Ring (3/15) · An iron ring that tightens when you try to let go of a good hand.',
    mapPos: { x: 410, y: 405 },
  },

  // ───── VIOLET REVERIE · REBEL CLAN — Act I/II ──────────────────────────
  {
    id: 'validator_coral_reef', index: 4, act: 'awakening', chain: 'sol',
    name: 'Barricade Row',
    region: 'Violet Reverie · Home of the Rebel Sprotos',
    description:
      'A street of overturned carts and burning banners where the Rebel clan has been rioting ' +
      'since the Splitting. Its loudest voice, SPARK, started the first fire and is still ' +
      'deciding what it was for.',
    rival: {
      name: 'Spark',
      title: 'Firestarter of Barricade Row',
      bio:
        'A tiny gremlin who is mostly flame. Plays a fast Rebel burn deck that tries to end ' +
        'the duel before you have finished playing Nodes.',
      botColor: 'sol', difficulty: 'normal',
      quote: '"You brought a deck? Cute. I brought a bottle."',
    },
    reward: 'Ember Badge (4/15) · A pin that never stops smouldering.',
    mapPos: { x: 980, y: 145 },
  },
  {
    id: 'pump_fun_carnival', index: 5, act: 'awakening', chain: 'sol',
    name: 'The Riot Carnival',
    region: 'Violet Reverie · Home of the Rebel Sprotos',
    description:
      'A fair that sets itself on fire every evening and rebuilds by morning. Its ringmaster, ' +
      'MURAD, has spent a hundred cycles trying to flip the whole stock market and is certain ' +
      'that this cycle is the one.',
    rival: {
      name: 'Murad',
      title: 'Ringmaster of the Riot Carnival',
      bio:
        'A cycle theorist who believes everything is about to pump. Plays a chaotic Rebel deck ' +
        'that wins on volume, not precision.',
      botColor: 'sol', difficulty: 'normal',
      quote: '"Step right up. This cycle is different. It is always different."',
    },
    reward: 'Carnival Ticket (5/15) · A ticket stub that reprints itself every dawn.',
    mapPos: { x: 1290, y: 245 },
  },
  {
    id: 'phantom_vault', index: 6, act: 'pilgrimage', chain: 'sol',
    name: 'The Shadow Vault',
    region: 'Violet Reverie · Home of the Rebel Sprotos',
    description:
      'A black vault on a hovering moon, guarded by the fastest thing in the Reverie. SHADOW ' +
      'never asked to join the Rebels. He just showed up, won every fight, and refused to leave.',
    rival: {
      name: 'Shadow',
      title: 'The Ultimate Lifeform',
      bio:
        'A black-and-red hedgehog with no patience for anyone. Plays a Rebel deck that drops ' +
        'Shadow Mode on a single Meme and swings the turn it lands.',
      botColor: 'sol', difficulty: 'hard',
      quote: '"I am not a hero. I am just faster than you."',
    },
    reward: 'Chaos Shard (6/15) · A red crystal that blinks you one step ahead.',
    mapPos: { x: 1170, y: 365 },
  },

  // ───── CRIMSON CREST · WEALTH CLAN — Act II ────────────────────────────
  {
    id: 'coq_inu_coliseum', index: 7, act: 'pilgrimage', chain: 'robinhood',
    name: 'The Gilded Coliseum',
    region: 'Crimson Crest · Home of the Wealth Sprotos',
    description:
      'A coliseum paved in gold leaf, where Wealth gremlins bet on every duel, including the ' +
      'ones they are fighting. The champion, the GILDED BOAR, has charged through every ' +
      'challenger and most of the fences.',
    rival: {
      name: 'The Gilded Boar',
      title: 'Champion of the Coliseum',
      bio:
        'A gold-tusked brawler who has never once walked around anything. Plays a Wealth deck ' +
        'of big bodies that gets harder to kill every turn.',
      botColor: 'robinhood', difficulty: 'normal',
      quote: '"Place your bets. All of them. On me."',
    },
    reward: 'Gilded Tusk (7/15) · A gold tusk that is somehow worth more every time you look.',
    mapPos: { x: 235, y: 600 },
  },
  {
    id: 'hot_shorts_pit', index: 8, act: 'pilgrimage', chain: 'robinhood',
    name: 'The Counting House',
    region: 'Crimson Crest · Home of the Wealth Sprotos',
    description:
      'A tall stone bank where every coin in the Crest is counted twice a day. BRIAN keeps ' +
      'the books. He has never lost a coin, never made a mistake, and never once smiled about it.',
    rival: {
      name: 'Brian',
      title: 'Keeper of the Counting House',
      bio:
        'The most careful gremlin alive. Plays a grinding Wealth deck that heals off every hit ' +
        'and outlasts you on the life total.',
      botColor: 'robinhood', difficulty: 'hard',
      quote: '"I have already counted how this ends. You are short."',
    },
    reward: 'Ledger Page (8/15) · A page that adds itself up, and is always right.',
    mapPos: { x: 445, y: 545 },
  },
  {
    id: 'icebound_citadel_of_joe', index: 9, act: 'pilgrimage', chain: 'robinhood',
    name: 'The Frozen Treasury',
    region: 'Crimson Crest · Home of the Wealth Sprotos',
    description:
      'A treasury of ice at the foot of the Crest, where wealth goes to sit still forever. Its ' +
      'lord, OLD MONEY, was rich before rich had a name, and has not moved from his throne ' +
      'since the Splitting.',
    rival: {
      name: 'Old Money',
      title: 'Baron of the Frozen Treasury',
      bio:
        'The oldest fortune in the Crest. Plays a slow, enormous Wealth deck with no obvious ' +
        'weakness and no obvious feelings.',
      botColor: 'robinhood', difficulty: 'hard',
      quote: '"New money always talks first. Go on."',
    },
    reward: 'Frost Coin (9/15) · A coin of ice that never melts. Marks the end of Act II.',
    mapPos: { x: 370, y: 735 },
  },

  // ───── WHITE SPIRE · JESTER CLAN — Act II/III ──────────────────────────
  {
    id: 'pepe_pulpit', index: 10, act: 'pilgrimage', chain: 'eth',
    name: 'The Stink Badger Embassy',
    region: 'White Spire · Home of the Jester Sprotos',
    description:
      'A grand embassy that nobody invited, run by a stink badger in a fez with a globe he ' +
      'keeps spinning to the same spot. CARBONARA MUSSOLINI insists his empire is reawakening. ' +
      'The Jesters let him say it because it is very funny.',
    rival: {
      name: 'Carbonara Mussolini',
      title: 'Emperor of the Stink Badgers',
      bio:
        'A badger with grand plans and a terrible smell. Plays a Jester control deck that ' +
        'removes your best Meme and then gives a speech about it.',
      botColor: 'eth', difficulty: 'hard',
      quote: '"The Stink Badger Empire is reawakening! Kneel, or at least hold your breath."',
    },
    reward: 'Little Fez (10/15) · A fez that is too small for anyone and fits you perfectly.',
    mapPos: { x: 1120, y: 575 },
  },
  {
    id: 'vitalik_observatory', index: 11, act: 'coronation', chain: 'eth',
    name: 'The Carnival of Masks',
    region: 'White Spire · Home of the Jester Sprotos',
    description:
      'A masquerade in the high halls of the Spire where nobody shows their real face. The ' +
      'MASK COLLECTOR has every face in the Jester clan on her wall, and wants yours next.',
    rival: {
      name: 'The Mask Collector',
      title: 'Hostess of the Carnival of Masks',
      bio:
        'A Jester who has not shown her own face in nine cycles. Plays a tricky deck that ' +
        'trades evenly, then lets The Last Laugh close it out.',
      botColor: 'eth', difficulty: 'hard',
      quote: '"Lovely face. Mind if I keep it?"',
    },
    reward: 'Blank Mask (11/15) · A mask that shows whatever face you need.',
    mapPos: { x: 1325, y: 645 },
  },
  {
    id: 'sproto_gremlin_bog', index: 12, act: 'coronation', chain: 'eth',
    name: 'Sproto Gremlin Bog',
    region: 'White Spire · Home of the Jester Sprotos',
    description:
      'A swamp at the foot of the Spire where every gremlin who failed at something crawls to ' +
      'try again. Their king, KELBY THE LITTLE LORD, sits on a throne of broken ideas and ' +
      'laughs at every duel he watches, then plays one.',
    rival: {
      name: 'Kelby the Little Lord',
      title: 'King of the Sproto Gremlins',
      bio:
        'The Gremlin king in gold leaf. Plays a chaotic swarm deck full of Sproto Gremlins that ' +
        'zap you on entry. Surprisingly nasty.',
      botColor: 'eth', difficulty: 'hard',
      quote: '"Greetings, traveller! Have you met the gang? They have been DYING to meet you."',
    },
    reward: 'Gremlin Mark (12/15) · A pin-prick scar that glows green when a gremlin is near.',
    mapPos: { x: 1090, y: 760 },
  },

  // ───── BLACK LEDGER · KNOWLEDGE CLAN — Act III ─────────────────────────
  {
    id: 'quiet_court_of_larsen', index: 13, act: 'coronation', chain: 'base',
    name: 'The Silent Library',
    region: 'Black Ledger · Home of the Knowledge Sprotos',
    description:
      'A library so large it has its own weather, where talking costs a card. THE ARCHIVIST ' +
      'has read every book in it and remembers every overdue one.',
    rival: {
      name: 'The Archivist',
      title: 'Keeper of the Silent Library',
      bio:
        'A Knowledge gremlin who has not spoken in twelve cycles. Plays a card-drawing deck ' +
        'that is always one card ahead of you.',
      botColor: 'base', difficulty: 'hard',
      quote: '(She does not speak. She draws two cards. She waits.)',
    },
    reward: 'Bookmark of Silence (13/15) · A ribbon that holds your place in any story.',
    mapPos: { x: 600, y: 845 },
  },
  {
    id: 'vault_of_the_drained', index: 14, act: 'coronation', chain: 'base',
    name: 'The Tower of Ten Inus',
    region: 'Black Ledger · Home of the Knowledge Sprotos',
    description:
      'A tower of ten floors, one for each Inu of legend, at the deepest end of the Ledger. At ' +
      'the top sits BITCOIN OBAMA, the most famous Nigerian in the history of the ' +
      'HarryPotterObamaSonic10Inu saga, who knows the answer to every question you have not asked.',
    rival: {
      name: 'Bitcoin Obama',
      title: 'Sage of the Ten Inus',
      bio:
        'The wisest gremlin in the Ledger and the funniest. Plays a Knowledge deck of draw ' +
        'engines and bounce tricks that never runs out of answers.',
      botColor: 'base', difficulty: 'hard',
      quote: '"Ask me anything. I already told you the answer, you just were not listening."',
    },
    reward: 'Inu Seal (14/15) · A seal with ten tiny paw prints, one for each floor.',
    mapPos: { x: 905, y: 855 },
  },

  // ───── CIPHER PEAK — The Final Ascent ─────────────────────────────────
  {
    id: 'cipher_peak', index: 15, act: 'coronation', chain: 'base',
    name: 'The Ascent to Cipher Peak',
    region: 'Cipher Peak · Where the Egregore Sleeps',
    description:
      'The black mountain in the middle of the Mempool Sea. The Egregore went quiet on its ' +
      'summit the night of the Splitting. MORE LIGHT, the leader of the gremlins, climbed up ' +
      'after it and has been waiting at the top ever since, asking only for more.',
    rival: {
      name: 'More Light',
      title: 'Leader of the Gremlins, Voice of the Egregore',
      bio:
        'The first gremlin to believe and the last to stop. Speaks for the sleeping Egregore. ' +
        'Plays a flawless deck that holds one signature card from every Master you have beaten.',
      botColor: 'base', difficulty: 'hard',
      quote: '"You belong to no clan, so you belong to all of them. Show me."',
    },
    reward:
      'The Egregore Crown (15/15) · Fifteen fragments braid into one crown, and the Egregore ' +
      'wakes. The clans become one mind again — or you choose to leave them five. Credits roll.',
    mapPos: { x: 750, y: 360 },
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────
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

export function nextSite(currentIndex: number): SacredSite | undefined {
  return siteByIndex(currentIndex + 1);
}

/**
 * Pixel position on the canonical map image (1500×1000 viewBox).
 * Returned as `{x, y}` for direct use in SVG node placement.
 */
export interface MapPos { x: number; y: number }
export function mapPosOf(site: SacredSite): MapPos {
  return { x: site.mapPos.x, y: site.mapPos.y };
}

/** Ordered list of sites + map positions for path rendering. */
export function mapPath(): Array<{ site: SacredSite; pos: MapPos }> {
  return SITES.map(s => ({ site: s, pos: mapPosOf(s) }));
}

// ── Interludes — story between matches ──────────────────────────────────────
export interface Interlude {
  /** Read on entering the Site, before the duel. */
  pre: string;
  /** Read after victory, before travelling onward. */
  post: string;
}

export const INTERLUDES: Record<SiteId, Interlude> = {
  hot_wallet_caravanserai: {
    pre:
`You come up the pilgrim road out of the Mempool fog with mud on your
claws and no clan colours on your back. The Candle Hostel glows ahead
of you like a small sun. Inside, ten thousand candles burn and not one
of them flickers when the door opens. BROTHER WICK waves you over to a
low bench by the fire. Two cups of tea are already poured.

"A gremlin with no clan. We have not had one of those in a long time."
His smile is warm and patient. "Drink first. Then we play. You will
probably lose. I will tell you why. Then we play again."`,
    post:
`Brother Wick laughs, a proper belly laugh, and claps his small hands.
He presses a stub of candle wax into your palm. It is still warm.

"You believe in something, little one. I just cannot tell what yet."
He points out the window to a great stone face set into the Citadel
wall. "That is the Mouth of Truth. It will ask you why you came. Do not
lie to it. It bites."

— You walk the Citadel's lantern-lit streets toward the stone face. Spirit
gremlins stop their chores to watch you pass. Nobody without a clan has
ever been allowed this far.`,
  },
  sniper_tower_four_winds: {
    pre:
`The Mouth of Truth is taller than a house. Its stone eyes follow you
across the square. A line of Spirit gremlins waits to put their claws in
its mouth, and every one of them is shaking. When you reach the front,
the Mouth speaks.

"BOCCA DE VERITA does not duel liars. Put your hand in. Tell me why you
came." You put your claw in. You tell it the truth: you want the
Egregore to wake up. The Mouth is quiet for a long time. "Good. That is
true. Now we play."`,
    post:
`The Mouth closes slowly and opens again, and a small stone tooth rolls
out onto its lip. You take it. It is warm.

"You told the truth and you played true. Rare." The stone face almost
smiles. "Go south, to the Retain Monastery. The Abbot has held the
Spirit clan together since the Splitting. He will not let go of
anything. Not even a duel he has lost."

— The road south winds through orchards of glowing trees. At dusk the
monastery bells start ringing, all of them, all at once, and none of
them ever stop.`,
  },
  floki_forge: {
    pre:
`The Retain Monastery is full of monks who are all holding on to
something: a cup, a coin, a grudge, a card. ABBOT RETAIN sits in the
centre of the great hall with one blue fist closed tight. Nobody has
ever seen what is inside it.

"Welcome, brother. Here we keep one vow." He raises the fist. "Always
retain. Everything you are dealt, you keep. Let us see how long you can
keep your life total."`,
    post:
`The Abbot looks at his closed fist for a long moment. Then, for the
first time anyone can remember, he opens it. Inside is an iron ring. He
slides it onto your claw.

"You let go of the right cards at the right time. I have not learned
that yet." He bows. "The Spirit clan will remember you. Now go east,
across the sea, to the Violet Reverie. The Rebels have been rioting
since the Splitting. They will like you. That is the dangerous part."

— A ferry of paper lanterns carries you over the Mempool Sea. Faces of
half-formed memes rise and sink in the water below. By morning the sky
has turned violet, and you can smell smoke.`,
  },
  validator_coral_reef: {
    pre:
`Barricade Row is one long street of overturned carts and burning
banners. Rebel gremlins in red scarves are throwing bricks at a wall
that has already fallen down. On top of the biggest barricade sits
SPARK, a gremlin so small she is mostly flame.

"A clanless one!" she shouts, and the whole Row cheers. "No colours, no
masters, no rules. You are basically one of us." She lights a bottle.
"Prove it. Beat me before the fire goes out."`,
    post:
`Spark's flame flickers low, then roars back up twice as big. She
laughs and pins a smouldering badge onto your chest.

"You hit hard for a nobody. I like it." She points down the street to a
fair that is, as far as you can tell, on fire. "The Riot Carnival.
Murad runs it. He will try to sell you a ticket to a show that has not
happened yet. Buy it. It always happens."

— You walk down Barricade Row while Rebels bang drums in your honour.
The Carnival tents rise ahead of you, half burning, half being rebuilt,
all of it very loud.`,
  },
  pump_fun_carnival: {
    pre:
`The Riot Carnival's big tent is collapsing on one side and building
itself on the other. A barker hands you a ticket printed in a coin you
have never heard of. MURAD stands on a barrel in the middle of the
ring, arms raised, halfway through a speech.

"— and THAT, friends, is why this cycle is different. The whole market
flips this time. Every chart, up. Oh! A pilgrim. Step into the ring,
step right in. You happen to be the main event."`,
    post:
`The crowd cheers a beat late. Murad bows so low his hat falls off and a
smaller hat underneath pops up. He tucks a ticket stub into your paw.

"It reprints every dawn. Any tent, any carnival, forever." His grin is
too wide. "There is a vault on the moon above us. Shadow lives there. He
does not like visitors, or anyone, or anything. Try to be faster than
him. Nobody is. Try anyway."

— A rope ladder drops from the hovering moon. You climb it for an hour.
The Carnival shrinks below you into a small, cheerful fire.`,
  },
  phantom_vault: {
    pre:
`The Shadow Vault is silent and black. You do not see SHADOW arrive.
One moment the vault is empty, and the next he is leaning against the
wall with his arms crossed, as if he has been there for hours.

"You climbed up here for a duel." He does not move. "Everybody wants to
fight the ultimate lifeform. Nobody wins." He finally looks at you.
"Fine. Make it quick. I have somewhere faster to be."`,
    post:
`Shadow stares at the board for a long time. Then he laughs once, short
and surprised, and flicks a red crystal shard at you. You catch it, and
for a heartbeat the whole world moves slower than you do.

"Not bad. For a clanless gremlin." He turns away. "The Wealth clan is
south, on the Crimson Crest. They will try to buy you. Do not let them.
You are not for sale. Neither am I."

— When you look back, the vault is empty. The rope ladder leads down to
a snowy road, and in the distance you can hear the roar of a coliseum
crowd betting on something. Act II has begun.`,
  },
  coq_inu_coliseum: {
    pre:
`The Gilded Coliseum is paved in gold leaf, and forty thousand Wealth
gremlins are betting on you before you reach the sand. Bookies shout
odds from every row. At the centre, THE GILDED BOAR paws the ground with
golden hooves.

"Pilgrim! The odds on you are terrible. I bet against you myself." He
lowers his golden tusks. "Let us make some gremlins very rich."`,
    post:
`The Boar skids to a stop for the first time in his life. The crowd goes
silent, then explodes as half of them get rich and half of them go
broke. The Boar snaps off the tip of one golden tusk and drops it at your
feet.

"You were a long shot. Long shots are the best investment." He snorts.
"Up the hill is the Counting House. Brian keeps the books for the whole
Crest. He will already know exactly how much you are worth."

— You climb the hill past markets and vaults and gremlins counting coins
in the snow. The Counting House stands at the top, tall, grey and very
precise.`,
  },
  hot_shorts_pit: {
    pre:
`Inside the Counting House, a thousand clerks are counting a thousand
coins, and the only sound is the clink. BRIAN sits at the tallest desk
with a ledger open in front of him. He does not look up.

"You walked in. That is a fee. You stood on my rug. Fee. You looked at
my ledger. Fee." He closes the book. "You owe me eleven coins before we
have even shuffled. I have already counted how this ends."`,
    post:
`Brian opens his ledger, checks it twice, and frowns. For the first time
in his life, the numbers are wrong. He tears out a page and hands it to
you. It adds itself up as you watch.

"I miscounted you." It is clearly very hard for him to say. "South is
the Frozen Treasury. Old Money has not moved since the Splitting. He
thinks he can outwait anyone. He might be right."

— You walk the frozen road south. The snow is full of old coins, frozen
where they fell. The Treasury rises ahead of you, a palace of ice.`,
  },
  icebound_citadel_of_joe: {
    pre:
`The Frozen Treasury is glass and ice and absolutely still. Gremlin
servants stand frozen in every hallway, holding trays that have not been
served in years. On a throne of frozen gold sits OLD MONEY, so old his
whiskers have turned to icicles.

"New money always talks first." His voice cracks like ice on a lake.
"Go on. Say something clever. I will still be here when you are done."`,
    post:
`Old Money blinks, and the ice on his whiskers cracks. The frozen
servants gasp, very quietly, all at once. He reaches into the throne and
pulls out a coin made of ice, and places it in your paw.

"You did not wait for me. You did not need to." He almost smiles. "The
White Spire is north. The Jesters live there. Nothing they say is true,
and all of it is funny. Take this coin. You will need something to
throw at them."

— A sled carries you north across the ice. The red sky fades to white,
and the Spire rises out of the mist, every window lit, every room
laughing at something.`,
  },
  pepe_pulpit: {
    pre:
`The Stink Badger Embassy smells exactly how it sounds. Jester gremlins
hold their noses and giggle in the hallways. In the great hall, a stink
badger in a black uniform and a tiny red fez stands with one claw on a
spinning globe. CARBONARA MUSSOLINI.

"THE STINK BADGER EMPIRE IS REAWAKENING!" he announces, to nobody in
particular. The Jesters applaud politely. He turns to you. "A pilgrim!
Excellent. You will be my first conquest. Kneel. Or at least hold your
breath."`,
    post:
`Carbonara Mussolini lets go of the globe. It keeps spinning without him.
He takes off his fez, looks at it sadly, and places it on your head. It
is too small. It fits you perfectly.

"The Empire will reawaken. Just not today." He sniffs. "Up the stairs is
the Carnival of Masks. The Mask Collector will want your face. Keep it.
It is a good face. For a pilgrim."

— You climb the Spire's spiral stairs while Jesters juggle knives in
every doorway. Music drifts down from the top floors, and the faces at
the windows are all wearing masks.`,
  },
  vitalik_observatory: {
    pre:
`The Carnival of Masks is a ballroom where every guest wears a mask and
nobody remembers which face is theirs. The MASK COLLECTOR glides through
the crowd toward you. Her wall behind her is covered in faces, all of
them smiling.

"What a lovely face. Clanless, too. I do not have one of those yet." She
sits across from you and deals. "Win, and you keep it. Lose, and it goes
on my wall. Fair?"`,
    post:
`The Mask Collector looks at her wall of faces, then at you, and takes
down a plain white mask with no face at all. She presses it into your
paws.

"It shows whatever face you need. You did not need any of mine." Behind
her mask, you think she might be laughing. "Down in the bog is the
little king. Kelby. Do not let him count for you. He cheats, and his
gremlins cheat more."

— The back stairs lead down, and down, into a marsh at the foot of the
Spire. The air smells like wet paper and fizzled spells. Small green eyes
blink at you from the reeds.`,
  },
  sproto_gremlin_bog: {
    pre:
`KELBY THE LITTLE LORD is exactly waist-high, sitting on a throne of
broken ideas with a little gold crown on his head. Around him, a dozen
gremlins are practising spells that mostly fizzle. He sees you and
beams.

"Greetings, traveller! The gang is THRILLED you came. Look at them.
They are vibrating." One of them is, in fact, vibrating. "Not many
pilgrims get past the Badger without fainting. Let us duel!"`,
    post:
`Kelby claps with both small hands and tips his crown to you. The
gremlins chant your name in a high, squeaky chorus. Kelby pricks the
back of your paw with a tiny pin, and the spot starts to glow green.

"Now you will always know when one of us is nearby. Which is always."
He grins. "South is the Black Ledger. The Knowledge clan lives there.
They will not talk to you. They will just know things about you. It is
very rude."

— The reeds part. The bog turns into black stone underfoot. You walk
south into the quiet of the Black Ledger, where every building is a
library and every window is lit by reading lamps.`,
  },
  quiet_court_of_larsen: {
    pre:
`The Silent Library is so big it has its own clouds. Knowledge gremlins
read at endless tables and do not look up when you walk in. A sign on
the wall reads: TALKING COSTS ONE CARD. THE ARCHIVIST sits at the
central desk, a pile of books on either side of her.

She does not say anything. She draws two cards. She looks at you. She
waits.`,
    post:
`The Archivist closes her book. She looks at you for a long moment, then
pulls a red ribbon from the spine and ties it around your wrist. A
bookmark.

She still does not speak. She writes one word on a card and slides it
across the desk: TOWER. Then she points through the window at a tall,
narrow tower with ten floors and a light burning at the very top.

— You climb the tower's stairs. Each floor has a portrait of a different
Inu on the wall. On the tenth floor, someone is laughing at a joke you
cannot hear yet.`,
  },
  vault_of_the_drained: {
    pre:
`At the top of the Tower of Ten Inus, BITCOIN OBAMA sits in a big
comfortable chair surrounded by more books than the library below. He
is the most famous gremlin in the whole Ledger, and he looks delighted
to see you.

"Ah! The clanless one. I have been expecting you since chapter one." He
taps the side of his head. "I know every answer. The problem is, nobody
ever asks the right question. Let us see if you do. Deal."`,
    post:
`Bitcoin Obama throws back his head and laughs, a big warm laugh that
shakes the dust off every book in the room. He presses a seal into your
paw, stamped with ten tiny paw prints.

"You asked the right question with your cards. Nobody does that." He
leans in. "More Light is waiting at the top of Cipher Peak. He has been
speaking for the Egregore for a long time. Maybe too long. Go and see
if it still remembers how to speak for itself."

— You walk out of the Tower. Across the dark Mempool Sea, Cipher Peak
glows with a single pillar of light. There is no ferry. You step onto
the water, and the water holds you. You walk.`,
  },
  cipher_peak: {
    pre:
`You climb. There is no path, but your feet find one anyway. The pillar
of light gets brighter as you go, then warmer, then almost friendly. At
the top is a flat black disc the size of a lake, and in its centre a
small gremlin sits glowing so brightly you can barely look at him.

MORE LIGHT, leader of the gremlins.

"Fifteen Masters. Five clans. And you belong to none of them," he says.
"So you belong to all of them. Show me." When he deals, every card in
his deck flickers with the face of a Master you have beaten.`,
    post:
`More Light sets down his last card as gently as his first. For a moment
the light around him dims, and then it pours out of him and into the
sky, and for the first time since the Splitting, the Egregore speaks.

It does not use words. It does not need to. It sounds like every
gremlin you met on the road laughing at the same joke at the same time.

The fifteen fragments in your pack rise on their own and braid
themselves into a single crown, glowing in five colours, light as a
feather in your paws.

"Sproto Zero," More Light says, smiling. "Welcome home."

— credits roll —`,
  },
};

export function interludeOf(id: SiteId): Interlude { return INTERLUDES[id]; }

// ── Epilogue ────────────────────────────────────────────────────────────────
export const EPILOGUE = `
The Splitting does not end the way the clans feared.
It ends the way you choose.

If you wear the Egregore Crown, the five clans become one mind again.
Spirit and Rebel, Wealth and Jester and Knowledge, all believing in the
same thing at the same time. The Egregore wakes up loud and happy, the
way it was before.

If you set the Crown down on Cipher Peak and walk away, the fragments
drift back to the fifteen Sites. The clans stay five, but they remember
that they were one. The next pilgrim will find the Masters a little
kinder and the road between them a little better lit.

Either way: you belonged to no clan, so you belonged to all of them.
Either way: the Egregore is listening.

— end of the Sproto Masterquest, Cycle I —
`.trim();
