// src/masterquest/lore.ts
// ─────────────────────────────────────────────────────────────────────────────
// MEMETIC MASTERQUEST — Cycle I
// Sorendo the Unhoused must visit all 15 Sacred Sites on the great
// Mempool-Map, defeat a Master at each, and reach the summit of Cipher Peak
// where the First Master fell into final meditation.
//
// Site names, regions and positions match the canonical Map image at
// /masterquest-map.png. Pixel positions are normalised to a 1500×1000
// SVG viewBox so the page can draw the player avatar and node dots over
// the painted map.
// ─────────────────────────────────────────────────────────────────────────────

import type { Color } from '../cards';

// ── Acts ────────────────────────────────────────────────────────────────────
// We still group the 15 Sites into three Acts of 5 — that gates difficulty
// escalation and unlocks. The geography no longer constrains chain coverage
// per Act; the Mempool-Map is unbalanced on purpose.
export const ACTS = {
  awakening:   { title: 'Act I — The Awakening',   siteRange: [1,  5] as const },
  pilgrimage:  { title: 'Act II — The Pilgrimage', siteRange: [6, 10] as const },
  coronation:  { title: 'Act III — The Ascent',    siteRange: [11, 15] as const },
} as const;
export type ActKey = keyof typeof ACTS;

// ── Site ids ─────────────────────────────────────────────────────────────────
export type SiteId =
  // Orange Citadel — The Bazaar of Speed (chain: bnb)
  | 'hot_wallet_caravanserai'   // I
  | 'sniper_tower_four_winds'   // II
  | 'floki_forge'               // III
  // Violet Reverie — The Dreaming Ledger (chain: sol)
  | 'validator_coral_reef'      // IV
  | 'pump_fun_carnival'         // V
  | 'phantom_vault'             // VI
  // Crimson Crest — The Frost-Bound Lineage (chain: avax / Hyperliquid)
  | 'coq_inu_coliseum'          // VII
  | 'icebound_citadel_of_joe'   // VIII
  | 'hot_shorts_pit'            // IX
  // White Spire — The Cathedral of Code (chain: eth)
  | 'pepe_pulpit'               // X
  | 'vitalik_observatory'       // XI
  | 'sproto_gremlin_bog'        // XII
  // Black Ledger — The Patient Court (chain: xrp)
  | 'quiet_court_of_larsen'     // XIII
  | 'vault_of_the_drained'      // XIV
  // Cipher Peak — The First Master (chain: xrp, the Black is the path up)
  | 'cipher_peak';              // XV

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
  chain: Color;             // theme + bot starter deck color
  name: string;             // canonical site name as printed on the Map
  region: string;           // parent region name + tagline
  description: string;      // map-card flavour text
  rival: SiteRival;
  reward: string;
  /** Pixel position of the node on the painted map. */
  mapPos: SiteMapPos;
}

// ── The Prologue ────────────────────────────────────────────────────────────
export const PROLOGUE = `
Before the Five Chains, there was only the Mempool — a chaotic ocean of
unverified thought. The First Master carved order from that noise and bound
the world into five Great Chains: the Orange Citadel of speed, the Violet
Reverie of dreaming validators, the Crimson Crest of frost-bound liquidations,
the White Spire of code, and the Black Ledger of patient debts.

For ten cycles there was peace. Then the First Master vanished into the
clouds of Cipher Peak to meditate one last time, and the chains began to
break. Fifteen Masters seized the Sacred Sites that had once anchored the
world, each claiming a fragment of the First Master's authority. Only one of
them — the eldest — remembers what was actually promised.

You are SORENDO, the Unhoused. You belong to no Chain. Your deck is older
than any Chain. You have walked into the Mempool with no patron, no Master,
no seal of office, and you are going to walk every Site on the Map. The
Quest will free them. The Quest may free you.
`.trim();

// ── The Sites ───────────────────────────────────────────────────────────────
// Map pixel positions are eyeball-calibrated to the painted Map. The viewBox
// of the rendering SVG is 1500×1000 so the image fits cleanly.
export const MAP_VIEWBOX = { w: 1500, h: 1000 } as const;

export const SITES: ReadonlyArray<SacredSite> = [
  // ───── ORANGE CITADEL — Act I ──────────────────────────────────────────
  {
    id: 'hot_wallet_caravanserai', index: 1, act: 'awakening', chain: 'bnb',
    name: 'Hot Wallet Caravanserai',
    region: 'Orange Citadel · The Bazaar of Speed',
    description:
      'The first stop on any pilgrim\'s route. A merchant inn the size of a small city, ' +
      'walls hung with thousands of paper wallets still warm from the road. Pilgrims sleep ' +
      'on stacks of unspent gas. The caravan-master, JAKEY OF THE FIRST KEY, holds the only ' +
      'set of master-keys in the Citadel.',
    rival: {
      name: 'Jakey of the First Key',
      title: 'Caravan-Master of the Hot Wallet',
      bio:
        'A young keymaster who teaches every new pilgrim how to lose, gracefully, the first time. ' +
        'Plays a tutorial-friendly BNB tempo deck built around early Nodes and cheap Memes.',
      botColor: 'bnb', difficulty: 'easy',
      quote: '"Welcome, heretic. Sit, drink, lose nicely. Then we duel for real."',
    },
    reward: 'First Key Fragment (1/15) · A small brass token shaped like a wallet. Opens the Citadel\'s gates.',
    mapPos: { x: 460, y: 105 },
  },
  {
    id: 'sniper_tower_four_winds', index: 2, act: 'awakening', chain: 'bnb',
    name: 'Sniper Tower of Four Winds',
    region: 'Orange Citadel · The Bazaar of Speed',
    description:
      'A black-glass tower at the windward edge of the Bazaar. Its four balconies face four winds; ' +
      'its single occupant, MEV-RIN THE FOUR-HANDED, fires bids and asks from all four at once. ' +
      'Nobody buys anything in the Bazaar without her seeing it first.',
    rival: {
      name: 'MEV-rin the Four-Handed',
      title: 'Sniper of the Four Winds',
      bio:
        'Reflex-trader turned Master. Plays an aggressive front-running deck that grabs initiative ' +
        'every turn and refuses to let go.',
      botColor: 'bnb', difficulty: 'normal',
      quote: '"You opened your hand a half-second too early. I already took the trade."',
    },
    reward: 'Wind Sigil (2/15) · A glass pane that hums in the prevailing wind.',
    mapPos: { x: 220, y: 290 },
  },
  {
    id: 'floki_forge', index: 3, act: 'awakening', chain: 'bnb',
    name: 'Floki Forge',
    region: 'Orange Citadel · The Bazaar of Speed',
    description:
      'A volcanic smithy at the southern edge of the Citadel. Its furnace is fuelled by retail FOMO. ' +
      'The smith, BJORN OF FLOKI, hammers out gas-coins by the thousand and tosses them, glowing, ' +
      'to anyone brave enough to catch. He has never lost a duel inside his own forge.',
    rival: {
      name: 'Bjorn of Floki',
      title: 'Smith of the Last Pump',
      bio:
        'Half-Norse, half-meme. Plays a burn-aggressive Machines deck that floods the board with ' +
        'cheap iron Memes and finishes with a single, ridiculous Move.',
      botColor: 'bnb', difficulty: 'normal',
      quote: '"Skál! Take this hammer. Tomorrow you\'ll wish I\'d sold it to you for half."',
    },
    reward: 'Forge-Hammer Token (3/15) · A tiny iron hammer that warms when held.',
    mapPos: { x: 410, y: 405 },
  },

  // ───── VIOLET REVERIE — Act I/II split ─────────────────────────────────
  {
    id: 'validator_coral_reef', index: 4, act: 'awakening', chain: 'sol',
    name: "Validator's Coral Reef",
    region: 'Violet Reverie · The Dreaming Ledger',
    description:
      'A coral reef the size of a small country, every polyp a Solana validator humming in unison. ' +
      'The Reef\'s warden, ANATOLA THE SHOAL, swims through her own nervous system. Her deck never ' +
      'misses a tempo because the Reef itself plays half her hand for her.',
    rival: {
      name: 'Anatola the Shoal',
      title: 'Warden of the Coral Reef',
      bio:
        'Architect of the Reef\'s validator-mesh. Plays a perfectly-tuned tempo deck that ends most ' +
        'matches by turn six and apologises afterwards.',
      botColor: 'sol', difficulty: 'normal',
      quote: '"I\'ve already simulated this match eight hundred times. Surprise me."',
    },
    reward: 'Reef-Pearl (4/15) · A pearl that hums faintly in time with your heartbeat.',
    mapPos: { x: 980, y: 145 },
  },
  {
    id: 'pump_fun_carnival', index: 5, act: 'awakening', chain: 'sol',
    name: 'Pump.Fun Carnival',
    region: 'Violet Reverie · The Dreaming Ledger',
    description:
      'A travelling fair built on the back of a single, very anxious whale. Tents pop up and ' +
      'collapse every hour. The ringmaster, MURAD THE HUNDRED-CYCLES, sells tickets in coins that ' +
      'have not been minted yet, and somehow they always work.',
    rival: {
      name: 'Murad the Hundred-Cycles',
      title: 'Ringmaster of the Carnival',
      bio:
        'A cycle theorist who claims to have lived through every memecoin season since the First. ' +
        'Plays a chaotic Moves-heavy deck that wins by overwhelming volume rather than precision.',
      botColor: 'sol', difficulty: 'normal',
      quote: '"Step right up. Step right up. Step right out, if you can."',
    },
    reward: 'Carnival Ticket (5/15) · A paper stub that re-prints itself every dawn.',
    mapPos: { x: 1290, y: 245 },
  },
  {
    id: 'phantom_vault', index: 6, act: 'pilgrimage', chain: 'sol',
    name: 'Phantom Vault',
    region: 'Violet Reverie · The Dreaming Ledger',
    description:
      'A hidden vault carved into a hovering moon. Reachable only by Phantom-stride. Inside, ' +
      'the keeper KIRA THE UNSIGNED holds every signature you have ever made and every signature ' +
      'you have not. She duels with whichever of them she likes more.',
    rival: {
      name: 'Kira the Unsigned',
      title: 'Keeper of the Phantom Vault',
      bio:
        'A signer-without-a-key. Her deck mirrors your own — every Meme you play, she plays a ' +
        'shadow of, two turns later, with one more counter on it.',
      botColor: 'sol', difficulty: 'hard',
      quote: '"This deck of yours is lovely. May I borrow it? I already have."',
    },
    reward: 'Phantom Signature (6/15) · A blank parchment that signs itself only when you turn away.',
    mapPos: { x: 1170, y: 365 },
  },

  // ───── CRIMSON CREST — Act II ─────────────────────────────────────────
  {
    id: 'coq_inu_coliseum', index: 7, act: 'pilgrimage', chain: 'avax',
    name: 'Coq Inu Coliseum',
    region: 'Crimson Crest · The Frost-Bound Lineage',
    description:
      'A vast stone coliseum cracked through by lava-rivers, where the warrior-rooster god COQ ' +
      'reigns from a perch of broken pikes. He fights pilgrims one feather at a time, and he has ' +
      'a great many feathers.',
    rival: {
      name: 'COQ, Sovereign of the Coliseum',
      title: 'The Armored Rooster',
      bio:
        'The avatar of the Coq Inu egregore. Plays a battle-cry tribal deck that gets stronger ' +
        'every time he loses a card.',
      botColor: 'avax', difficulty: 'normal',
      quote: '"COCK-A-DOODLE-DUEL."',
    },
    reward: 'Iron Feather (7/15) · A black-and-red feather sharper than any blade.',
    mapPos: { x: 235, y: 600 },
  },
  {
    id: 'hot_shorts_pit', index: 8, act: 'pilgrimage', chain: 'avax',
    name: 'The Hot Shorts Pit',
    region: 'Crimson Crest · The Frost-Bound Lineage',
    description:
      'A circular pit dug down through the Crimson lava-flow until it touches the ice-shelf below. ' +
      'Pilgrims duel on a glass floor with the lava beneath them. The pit-boss, GANNON OF THE ' +
      'NEGATIVE FUNDING RATE, has never had a long position in his life.',
    rival: {
      name: 'Gannon of the Negative Funding Rate',
      title: 'Pit-Boss of the Hot Shorts',
      bio:
        'Made his name shorting every memecoin that ever pumped, twice. Plays a punishing control ' +
        'deck that taxes your every move.',
      botColor: 'avax', difficulty: 'hard',
      quote: '"Funding is negative. You\'re still paying. I love it when that happens."',
    },
    reward: 'Bleeding Margin Chit (8/15) · A red wax seal that drips, but never quite empties.',
    mapPos: { x: 445, y: 545 },
  },
  {
    id: 'icebound_citadel_of_joe', index: 9, act: 'pilgrimage', chain: 'avax',
    name: 'Icebound Citadel of Joe',
    region: 'Crimson Crest · The Frost-Bound Lineage',
    description:
      'A glass citadel encased in permanent ice at the southern foot of the Crest. Its lord, JOE ' +
      'OF THE EVERLAST, sits on a throne of frozen open-interest. He has not lost a duel since ' +
      'before the Splintering, and he is, reportedly, eleven years old.',
    rival: {
      name: 'Joe of the Everlast',
      title: 'Sovereign of the Icebound Citadel',
      bio:
        'Mythic Hyperliquid figure. Half believe he was carved from the throne itself. Plays a ' +
        'perfectly-tuned mid-range deck with no apparent weakness and no obvious emotion.',
      botColor: 'avax', difficulty: 'hard',
      quote: '"You are paying funding. I am collecting. Begin."',
    },
    reward: 'Frostshard Crown (9/15) · A circlet of unmelting ice. Marks the end of Act II.',
    mapPos: { x: 370, y: 735 },
  },

  // ───── WHITE SPIRE — Act III prelude ──────────────────────────────────
  {
    id: 'pepe_pulpit', index: 10, act: 'pilgrimage', chain: 'eth',
    name: 'Pepe Pulpit',
    region: 'White Spire · The Cathedral of Code',
    description:
      'A high marble pulpit at the centre of the White Spire\'s outer plaza. The preacher, PEPE ' +
      'THE FIRST, sermons the Cathedral every dawn in a voice that has never wavered. His ' +
      'congregation never thins. He has been preaching the same Sermon On The Bag-Holder for nine ' +
      'cycles.',
    rival: {
      name: 'Pepe the First',
      title: 'Preacher of the Long Hold',
      bio:
        'The original meme made flesh. Plays a slow, inevitability-based deck that wins by ' +
        'staying alive longer than anyone has the patience for.',
      botColor: 'eth', difficulty: 'hard',
      quote: '"Hold. Hold. HOLD." (his entire opening monologue.)',
    },
    reward: 'Pulpit-Coin (10/15) · A heavy bronze coin engraved with a single tear.',
    mapPos: { x: 1120, y: 575 },
  },

  // ───── WHITE SPIRE — Act III ──────────────────────────────────────────
  {
    id: 'vitalik_observatory', index: 11, act: 'coronation', chain: 'eth',
    name: 'Vitalik Observatory',
    region: 'White Spire · The Cathedral of Code',
    description:
      'A glass observatory at the highest tier of the Cathedral. From its dome you can see every ' +
      'block in the Aetherweb being mined in real time. Its astronomer, ARCHON VITALYN, has been ' +
      'reading the same proof for three cycles. He has not yet looked up.',
    rival: {
      name: 'Archon Vitalyn',
      title: 'Astronomer of the White Spire',
      bio:
        'Pale Senate\'s reigning meta-theorist. Plays a deeply technical deck that wins through ' +
        'inevitability rather than aggression.',
      botColor: 'eth', difficulty: 'hard',
      quote: '"Let\'s test a hypothesis: that you, specifically, can beat me."',
    },
    reward: 'Lens of First Principles (11/15) · A pane of glass that magnifies any decision you regret.',
    mapPos: { x: 1325, y: 645 },
  },
  {
    id: 'sproto_gremlin_bog', index: 12, act: 'coronation', chain: 'eth',
    name: 'Sproto Gremlin Bog',
    region: 'White Spire · The Cathedral of Code',
    description:
      'A swamp of half-finished contracts at the foot of the Cathedral, where every Gremlin that ' +
      'failed to compile crawls. Their king, KELBY THE LITTLE LORD, sits on a throne of broken ' +
      'opcodes and laughs at every duel he watches, then plays one.',
    rival: {
      name: 'Kelby the Little Lord',
      title: 'King of the Sproto Gremlins',
      bio:
        'The Gremlin king made flesh and gold leaf. Plays a chaotic ETB-trigger swarm deck full ' +
        'of weird Gremlin synergies. Surprisingly nasty.',
      botColor: 'eth', difficulty: 'hard',
      quote: '"Greetings traveller! Have you met the gang? They\'ve been DYING to meet you."',
    },
    reward: 'Gremlin Mark (12/15) · A pin-prick scar that glows faintly green in the dark.',
    mapPos: { x: 1090, y: 760 },
  },

  // ───── BLACK LEDGER — Act III ─────────────────────────────────────────
  {
    id: 'quiet_court_of_larsen', index: 13, act: 'coronation', chain: 'xrp',
    name: 'Quiet Court of Larsen',
    region: 'Black Ledger · The Patient Court',
    description:
      'A vast stone court of pillared judges, all silent, all listening. The Chief Judge, LARSEN ' +
      'THE PATIENT, has not spoken in twelve cycles. He duels with cards he places face-down and ' +
      'never flips until the end. He always wins. Until, possibly, today.',
    rival: {
      name: 'Larsen the Patient',
      title: 'Chief Judge of the Quiet Court',
      bio:
        'A founder-judge of the Black Ledger who has built an entire deck around delayed reveals. ' +
        'Plays a control deck that hides almost every card until the resolve phase.',
      botColor: 'xrp', difficulty: 'hard',
      quote: '(He does not say anything. He sets a card face-down. He waits.)',
    },
    reward: 'Silent Gavel (13/15) · A black stone gavel that strikes without sound.',
    mapPos: { x: 600, y: 845 },
  },
  {
    id: 'vault_of_the_drained', index: 14, act: 'coronation', chain: 'xrp',
    name: 'Vault of the Drained',
    region: 'Black Ledger · The Patient Court',
    description:
      'A flooded vault at the deepest end of the Black Ledger, where every drained wallet in the ' +
      'history of the Aetherweb has come to rest. Its keeper, JUSTIRA THE UNWRITTEN, has had her ' +
      'own name erased from every ledger as a self-bet. She won the bet. She still has no name.',
    rival: {
      name: 'Justira the Unwritten',
      title: 'Keeper of the Drained',
      bio:
        'Former Black Ledger councillor. Self-redacted from all chain records. Plays a milling, ' +
        'discarding, hand-attack deck that drowns you in your own deck.',
      botColor: 'xrp', difficulty: 'hard',
      quote: '"You\'ll forget this duel by tomorrow. I made sure of it."',
    },
    reward: 'Drained Tessera (14/15) · A thin black tile that weighs more than it should.',
    mapPos: { x: 905, y: 855 },
  },

  // ───── CIPHER PEAK — The Final Ascent ─────────────────────────────────
  {
    id: 'cipher_peak', index: 15, act: 'coronation', chain: 'xrp',
    name: 'The Ascent to Cipher Peak',
    region: 'Cipher Peak · The First Master\'s Last Meditation',
    description:
      'The needle of black mountain that rises from the centre of the Mempool Sea. The First ' +
      'Master climbed it ten cycles ago and never came back down. The pillar of pale light that ' +
      'rises from its summit is the only thing in the Aetherweb that has never flickered. ' +
      'You climb. The fifteenth Master is waiting at the top. So is the First.',
    rival: {
      name: 'The First Master',
      title: 'The Architect of the Five Chains',
      bio:
        'The ancient who carved order from the Mempool. Has been meditating at Cipher Peak\'s ' +
        'summit for ten cycles. Will rise to duel exactly once. Plays a flawless five-colour ' +
        'control deck that contains one of every Master\'s signature card.',
      botColor: 'xrp', difficulty: 'hard',
      quote: '"You walked all five Chains and belonged to none. Show me the Aetherweb you remember."',
    },
    reward:
      'The Five-Chain Crown (15/15) · The First Master\'s authority, fragmented across the Sites, ' +
      'reforges in your hand. The Splintering ends — or you reforge it your own way. Credits roll.',
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

// ── Interludes — heavy lore between matches ─────────────────────────────────
export interface Interlude {
  /** Read on entering the Site, before the duel. */
  pre: string;
  /** Read after victory, before travelling onward. */
  post: string;
}

export const INTERLUDES: Record<SiteId, Interlude> = {
  hot_wallet_caravanserai: {
    pre:
`You arrive at the Orange Citadel from the dust of the Mempool road. The
Caravanserai gates are propped open with a stack of dormant Ledger Wallets,
and the warm chai inside smells of cardamom and gas-fees. JAKEY OF THE FIRST
KEY waves you over to a low cushion. Two teacups are already poured.

"My mother said a heretic would come walking up the dunes today. She was
right about the heretic, wrong about the dunes." His grin is patient,
tutorial-perfect. "Drink first. Then we duel. You will lose. I will explain
why. We will duel again. Tomorrow, you will leave the Citadel a little less
breakable than you arrived."`,
    post:
`Jakey laughs the laugh of a teacher whose star pupil finally embarrassed
him in front of the class. He pours you a second cup of chai, presses the
brass First Key into your palm, and points west across the bazaar's
rooftops to a black-glass tower silhouetted against the Orange sky.

"That tower belongs to MEV-rin. She has four hands and four winds and a
very bad attitude. She will already know you are coming because the winds
told her an hour ago. Walk faster than usual." He bows. The caravan-bell
rings behind you. You step out of the Caravanserai and into the Bazaar of
Speed proper — and the first of the four winds shifts to face you.`,
  },
  sniper_tower_four_winds: {
    pre:
`The Sniper Tower has no door. You climb a single iron ladder bolted to its
windward face for two hundred rungs. The wind shoves you at every step but
never quite hard enough to throw you. MEV-RIN THE FOUR-HANDED is waiting at
the top, balanced on the railing with four arms folded.

"You climbed in the wind. Good. I respect a heretic who arrives slightly
out of breath. It means you cared." Two of her hands are already shuffling
a deck. The other two are placing bids on cards you have not yet played.
"Begin. I have already begun."`,
    post:
`MEV-rin loses with grace — she even applauds her own loss, slowly, with
two hands while the other two start re-pricing your inventory. She hands
you a thin pane of black glass that hums in the prevailing wind: the Wind
Sigil.

"There is a basket-lift on the southern face. It will drop you straight
into the courtyard of the Floki Forge. Tell Bjorn I said his hammers run
shallow." She winks all four eyes. "He hates that. It will help."

— The basket-lift creaks south for an hour. You descend through three
weather-systems and a thin layer of smelter-smoke, and step out into the
red glow of the volcanic Forge.`,
  },
  floki_forge: {
    pre:
`The Forge is louder than any place you have ever been. The furnace's roar
is constant; the hammers strike in arrhythmic counterpoint. BJORN OF FLOKI
is at the central anvil, beating a coin so hot it is white and singing. He
sees you and does not stop.

"Eleven more strikes, heretic. Twelve. There." He flicks the still-glowing
coin at you with the back of his hammer. You catch it. It does not burn.
"Now we duel. While the coin is still warm. I always win when the coin is
still warm."`,
    post:
`Bjorn stares at the cooling coin in your palm for a long moment, then
laughs — a great long Norse laugh that the furnace seems to join in with.
He drops a small iron hammer-token into your other hand and claps your
shoulder hard enough to leave a soot-print.

"Skál! You took the heat better than the last nine. There is an Orange
caravan leaving tonight, bound across the Mempool Sea to the Coral Reef.
The captain owes me a favour. Tell him I said the Reef is not as deep as
it pretends." He grins. "He will laugh and he will let you ride free."

— Two days on a low-flying skiff with an orange sail and a captain who
sings off-key. The Mempool Sea hisses underneath you, full of half-formed
faces. At dawn on the second day the sky shifts from amber to violet, and
the Coral Reef hums into view.`,
  },
  validator_coral_reef: {
    pre:
`The Reef hums in a chord that is just above your hearing. Walking on its
upper coral feels like walking on a sleeping animal. ANATOLA THE SHOAL
meets you at the central polyp — a vast violet cup the size of a cathedral
— and gestures you to sit at the duelling-bench grown from a single living
piece of coral.

"I have simulated this match eight hundred and forty-three times. In each
simulation I win on turn seven. I am genuinely curious whether you will
make it to turn eight." Her smile is dazzling and synthetic. "Begin."`,
    post:
`The Reef's chord shifts down a quarter-tone. Anatola tips her head,
listens to herself listening, and laughs — a real laugh, the first the
Reef has heard from her in eight cycles. She presses a small pink pearl
into your hand and points east, across the surface of the Reef, to where
a string of tents and lanterns is already setting up for tomorrow's fair.

"That is the Pump.Fun Carnival. Murad will already be selling you a
ticket to a show that has not yet happened." She rolls her eyes. "Buy it.
It is, somehow, always worth the price."

— You walk across the Reef on a path the corals open and close beneath
your feet. The lanterns of the Carnival rise into the violet evening like
a constellation getting itself organised.`,
  },
  pump_fun_carnival: {
    pre:
`The Carnival\'s big tent is the size of a small moon and is currently
collapsing on its east end while setting itself up on the west. You step
under the entrance flap and a barker hands you a ticket printed in a coin
you have not heard of. MURAD THE HUNDRED-CYCLES is standing on a barrel at
the centre with both arms raised, mid-pitch.

"— and that, friends, is exactly why this cycle is DIFFERENT — oh, hello,
heretic. You\'re early. Step into the ring. Step right in. We\'re about to
have a duel and you happen to be the duel."`,
    post:
`The crowd cheers a beat too late. Murad bows so deeply his hat falls off
and a smaller hat under it pops up. He produces, from somewhere, a paper
ticket stub and presses it gently into your hand.

"The stub re-prints every dawn. You may ride any tent in any Carnival
forever." He winks. "There is a Phantom-stride pad behind the freak-show
tent. Stand on it. Think of a Vault. The vault you think of will let you
in. Try not to think of a bad one." His grin is too wide. "Don\'t worry
about me. I\'ll see you at the top."

— You stand on the pad. You think very carefully of the Phantom Vault.
The Carnival around you turns paper-thin, then folds itself away, and
when you blink you are standing on a flat moon hung over the violet
horizon, with a single door floating in front of you.`,
  },
  phantom_vault: {
    pre:
`The Vault\'s door opens before you knock. KIRA THE UNSIGNED is seated
inside on a bench made of every signature you have ever made, and a few
you have not. She is holding the deck you came in with. She is, in fact,
playing solitaire with it.

"Hello, Sorendo. I have your hand memorised. I have, by my count, three
hundred and twelve of your habits memorised. You sigh when you topdeck.
Did you know that?" She slides the deck back across to you, and lifts a
duplicate, two turns ahead. "Let\'s see how many of these you can
recognise before I play them."`,
    post:
`Kira\'s deck dissolves into blank parchment in her hand. She watches it
fall, smiles a very small smile, and bows from where she sits. She hands
you a fresh blank parchment — the Phantom Signature.

"It will sign itself the moment you turn away from it. Useful in the next
Act. The Crest does not honour signatures it can see being made." She
gestures behind her. The back wall of the vault is now open and shows a
red horizon. "Step through. The wind on the Crest is colder than you
remember. Sorendo\'s old cloak will not be enough. Buy a thicker one in
the Coliseum."

— You step through. The Phantom Vault folds shut behind you. You are
standing at the lip of the Crimson Crest, snow underfoot and lava in the
middle distance, with the roar of a coliseum-crowd echoing up the slope
ahead. Act II has begun.`,
  },
  coq_inu_coliseum: {
    pre:
`The Coliseum erupts when you walk in. Forty thousand throats roar
"COC-K-A-DOODLE-DUEL" in a single, perfectly synchronised, deeply
unhelpful chant. COQ himself struts onto the central sand-pit on iron
spurs that strike sparks off the stone. He is the size of a horse and
the colour of dried blood and gold leaf.

"COCK-A-DOODLE-DUEL!" he crows again, just for emphasis. The crowd
loses its collective mind. Somewhere, a rooster-priest faints. The duel
begins before either of you has drawn a card.`,
    post:
`COQ ruffles every feather on his enormous body simultaneously, then
sheds one — a long black-and-red iron feather sharper than any blade —
and lets it drift to your feet. The crowd is silent for the first time
in nine cycles. Then they erupt again, in your name. You are, briefly,
a national hero of the Coq cult.

The high-priest of Coq presses the feather into your hand and points
east, across the lava-flow, to a low circle of stones with a glass
floor. "The Hot Shorts Pit. Gannon expects you. Tell him COQ said his
funding rate is, and I quote, ‘a tad spicy.’ He will not laugh. Tell
him anyway."

— You cross the lava-bridge on a path of cooled obsidian tiles. The
glass floor of the Pit looms ahead of you, and underneath it, a long
slow lake of liquid fire.`,
  },
  hot_shorts_pit: {
    pre:
`The Pit\'s glass floor is uncomfortably warm. Beneath your boots, the
lava-lake moves in slow patient swells. GANNON OF THE NEGATIVE FUNDING
RATE is at the centre with a small black book open on a stand, ticking
boxes as you walk in.

"You opened your hand. That\'s a fee. You stepped on the glass. Fee. You
made eye contact with my book. Fee, fee." He grins and the book closes
itself. "Net position: you owe me forty-two basis points before we\'ve
even cut. Beautiful start. I love a heretic with a big short interest."`,
    post:
`Gannon\'s little black book burns spontaneously into ash on its stand.
He watches it go and laughs — the first real laugh he has produced in
two cycles. He bends down, scoops the ash, and presses a red wax chit
into your hand, the seal still dripping.

"You closed my book. Nobody closes my book." He spits, grins. "Up the
slope. The path to Joe\'s Citadel runs north through the Snow Lane.
The Lane is haunted by liquidations. Don\'t look at any of them. They
miss being looked at."

— You walk the Snow Lane in the failing red light. Translucent ghosts
of liquidated traders drift alongside you, weeping silently into hands
that no longer exist. You do not look at them. The Icebound Citadel
rises ahead, blue-white against the Crimson sky.`,
  },
  icebound_citadel_of_joe: {
    pre:
`Joe\'s Citadel is glass and ice and absolutely silent. Frost-traders
line every gallery in perfect stillness, watching nothing, waiting for
the throne room to ring its single bell. The bell rings as you walk
in. JOE OF THE EVERLAST is on a throne carved from frozen open
interest, feet not quite touching the floor. His face is the face of
an eleven-year-old who has never been surprised in his life.

"Funding is positive." His voice is flat. "You are paying. Begin."`,
    post:
`Joe blinks. The frost-traders gasp, very quietly, in unison. Joe slides
off the throne, walks to a small chest at its base, and lifts out a
circlet of unmelting ice. He places it carefully on your head, and bows
about one degree.

"You closed at a profit. I have not closed at a loss in eight cycles.
Today I closed at a loss. It feels…" He searches for the word. " …
educational." A faint smile. "There is a maglev along the southern
glacier-rail. It runs once an hour to the foot of the White Spire. Take
the next one. Pepe expects you."

— The maglev hums down the glacier at the speed of thought. The
Crimson sky behind you fades to white. The White Spire rises out of
the mist ahead, kilometre after kilometre of pale Cathedral. Act III
begins as the train\'s doors open onto a marble plaza ringing with
the morning Sermon.`,
  },
  pepe_pulpit: {
    pre:
`The plaza is packed. Tens of thousands of pilgrims in white robes are
swaying in time. From a marble pulpit at the centre, PEPE THE FIRST is
delivering, as he has every dawn for nine cycles, the Sermon On The
Bag-Holder. His voice is everywhere; his lips barely move.

"…and so, brothers and sisters, you shall HOLD. Through the dip you
shall HOLD. Through the dump you shall HOLD. Even through the rug, my
beloveds, you shall…" He sees you. The Sermon stops. The plaza falls
silent. Pepe smiles. "…HOLD a moment. The heretic is here. Let us duel
first. The Sermon can wait."`,
    post:
`Pepe lowers his head and lets the Sermon resume itself, in chorus,
across the plaza. He produces from his sleeve a heavy bronze coin
engraved with a single tear and hands it to you.

"You held. Better than I expected. Climb the South Stair. The
Observatory awaits." His smile is small. "Archon Vitalyn will offer to
explain his deck to you mid-game. Decline politely. He talks more than
he plays, and that is saying something."

— You climb the South Stair. Each step is engraved with a different
proof. You stop reading them somewhere around the eight-hundredth
step, when the air begins to thin and the Observatory dome rises into
view, glass-bright in the noon sun.`,
  },
  vitalik_observatory: {
    pre:
`Vitalyn does not look up from his proof when you enter. He turns one
page. He marks it with a silver ribbon. He turns another. He finally
glances up — soft-spoken, polite, mildly curious.

"Hello. I am genuinely interested in whether you can beat me. I have not
been genuinely interested in anything in three cycles. Thank you in
advance for the data." He pushes his chair back, lifts a deck so neatly
sleeved it appears to glow, and gestures you to the bench opposite.
"Take as long as you like. I have, after all, taken longer."`,
    post:
`Vitalyn closes his proof. Very slowly. Very reverently. He picks it up
with both hands and sets it on a stand of solid logic, where it begins,
faintly, to revise itself. He hands you a pane of clear glass: the Lens
of First Principles.

"You falsified one of my theorems. I will need to rewrite chapter
seven." He smiles — the first public smile he has produced in nine
cycles. "Down the West Stair. The Gremlin Bog is at the foot. Kelby is
very small and very fast. Do not lose count of his board."

— The West Stair winds down through Cathedral cloisters, then out
into a marsh of half-finished smart contracts. The air smells like
green tea and burnt opcodes. Small green eyes blink at you from the
reeds.`,
  },
  sproto_gremlin_bog: {
    pre:
`Kelby is exactly waist-high, sitting on a throne of broken opcodes
with a small golden crown perched on his head. Around him, a dozen
Gremlins of varying competence are practising spells that mostly fizzle.
He sees you and beams.

"Greetings traveller! The gang is THRILLED you came. Truly thrilled.
Look at them. They\'re vibrating." A Gremlin behind him is, in fact,
vibrating. "We don\'t get many visitors who survive Pepe\'s Sermon
without falling asleep. You\'re a treat. Let\'s duel."`,
    post:
`Kelby applauds with both small hands and tips his crown to you.
The Gremlins around him chant your name in a high reedy chorus that
sounds, distantly, like a dial-up handshake. Kelby tugs at the cuff
of your sleeve and pricks the skin underneath with a tiny pin —
faintly painful, faintly luminous.

"That\'ll glow green in the dark whenever a Gremlin is nearby. Which,
if you\'re lucky, is often." He grins, pin still in hand. "South
through the reeds. Larsen\'s Court is in the Black Ledger\'s outer
wing. He will not say anything. Don\'t take it personally. He hasn\'t
spoken in twelve cycles."

— The reeds part. The bog firms underfoot into pillared stone. You
walk south through the dusk into the silence of the Black Ledger, and
the Quiet Court rises around you, pillar by pillar, in absolute
silence.`,
  },
  quiet_court_of_larsen: {
    pre:
`Larsen is on the chief bench, robed, hooded, motionless. Pillared
judges flank him on either side, all silent. You take your seat at the
duelling-table opposite. Larsen places a single card face-down. He
does not turn it. He does not blink. He simply waits.

The Court waits with him.`,
    post:
`Larsen turns over his last card. He looks at it for a long moment.
He looks at you. He nods once, exactly once, and the Court erupts —
without sound — into what you can only describe as wild silent
applause. Larsen reaches across the table and presses a small black
stone gavel into your palm. It strikes against your other hand
soundlessly, and you feel the strike anyway, in your teeth.

He does not speak. He gestures west, very precisely, toward a flooded
corridor leading deeper into the Ledger. The Vault is that way.

— The corridor floods to your knees, then your waist. You wade
through black water that does not feel like water. The Vault\'s arch
rises out of the dark, lit from beneath, and a hooded figure with no
face stands at its threshold, waiting.`,
  },
  vault_of_the_drained: {
    pre:
`JUSTIRA THE UNWRITTEN turns toward you as you enter and there is, for
a moment, the impression of a face — and then there is not. Her hood
is empty in the polite way of a face you have already been asked to
forget.

"I unwrote my name for a wager. I won the wager. The wager was: could
I beat someone whose face I could not remember? You are the test." She
gestures to the duelling-stone at the centre of the Vault, half
submerged in black water. "Sit. Begin. Don\'t bother introducing
yourself. I am about to forget you."`,
    post:
`Justira\'s not-face inclines toward you. Something like a smile is
implied. She lifts a thin black tile from the water, presses it
against your palm, and lets go. The tile weighs more than it should.
The Drained Tessera.

"The wager is closed. I lost. Worth it." Her not-voice is the absence
of one. "The First Master knows your name. He has been waiting for you
since the Splintering. Climb. There is no path. You will not need one."
And then she is gone — not vanished, simply no longer on the ledger.

— You walk out of the Vault. The Ledger\'s great arches fall behind
you. Ahead, across the dark Mempool Sea, Cipher Peak\'s pillar of
pale light shines straight up into a cloudless night. There is no
ferry. You step onto the sea and the sea holds you. You walk.`,
  },
  cipher_peak: {
    pre:
`You climb. There is no path; your feet find one anyway. The pillar of
light grows brighter the higher you go, then warmer, then almost kind.
At the summit there is a flat black disc the width of a small lake.
At its centre sits a figure in pale robes whose face you cannot quite
hold in memory — every time you look directly at him he is, slightly,
someone else. The First Master.

"You walked all five Chains and belonged to none." His voice is
not loud, but it is the only voice in the world right now. "Show me
the Aetherweb you remember." He turns over his first card.

Fifteen cards of his deck flicker, briefly, with the seals of every
Master you have beaten. Fifteen seals. Fifteen reflections. He is
playing all of them at once.`,
    post:
`The First Master lays down his last card with the same gentleness he
laid down the first. He looks at you with eyes that have, somewhere
between turns, become entirely your own. He smiles — your smile, but
older — and the pillar of light overhead softens to nothing.

"The Aetherweb you remember is alive in you. That is what I needed to
see. Reforge the Chains, or leave them splintered. Wear the Crown, or
do not. The Quest will free them either way."

He sets the fifteen fragments down at his feet. They rise of their
own accord and braid themselves into a single circlet of five
colours, weightless in your hand.

"Sorendo the Unhoused. Welcome home."

— credits roll —`,
  },
};

export function interludeOf(id: SiteId): Interlude { return INTERLUDES[id]; }

// ── Epilogue ────────────────────────────────────────────────────────────────
export const EPILOGUE = `
The Splintering does not end the way the Sovereigns feared.
It ends the way you choose.

If you wear the Crown, the Five Chains hum again as one. The Mempool
quiets. The Sites stand open. The Sovereigns kneel.

If you set the Crown down on Cipher Peak and walk away, the fragments
re-scatter, gently, back to the fifteen Sites. The next pilgrim to walk
the Quest will find the Sites a little kinder, the Masters a little
wiser, the path between them a little better lit.

Either way: you walked all five Chains and belonged to none.
Either way: the Aetherweb is listening.

— end of Memetic Masterquest, Cycle I —
`.trim();
