// src/Tutorial.tsx
// First-run tutorial. Shown once per account the first time a player lands on
// the hub after signing in, and replayable from Settings. Every number and rule
// here mirrors src/Game.ts and src/cards.ts, and every card shown is a real
// CARDS entry, so the tutorial can't drift into describing a different game
// than the one the engine plays.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CARDS, COLOR_META, COLORS, DECK_SIZE, MAX_COPIES_NONBASIC, type Color } from './cards';
import { MULLIGAN_INITIAL_HAND, MULLIGAN_FLOOR } from './Game';
import { ChainLogo } from './chain-logos';
import { cardText } from './components/CardFace';

// Same palette as the rulebook so the two read as one system.
const T = {
  scrim: 'rgba(5,4,14,0.86)', panel: '#17142D', panelHi: '#211744', well: 'rgba(0,0,0,0.32)',
  border: 'rgba(230,196,92,0.22)', borderStrong: 'rgba(230,196,92,0.55)',
  gold: '#E6C45C', goldBright: '#FFD875', violet: '#8B5CF6',
  text: '#F4F1E8', text2: '#AAA4BC', success: '#55E58B', danger: '#FF616F', blue: '#57A8FF',
};
const FONT = "'Inter', 'Geist', 'Satoshi', system-ui, -apple-system, sans-serif";
const HEAD = '"Cinzel", "Times New Roman", serif';

// ── Persistence ─────────────────────────────────────────────────────────────
// Keyed per account (wallet address, falling back to display name) so a second
// account on the same device still gets its own first run.

const KEY_PREFIX = 'egregore.tutorial.v1:';

export function tutorialKey(account: string | null | undefined): string {
  return KEY_PREFIX + (account || 'anon').toLowerCase();
}
export function hasSeenTutorial(account: string | null | undefined): boolean {
  try { return localStorage.getItem(tutorialKey(account)) === '1'; } catch { return true; }
}
export function markTutorialSeen(account: string | null | undefined) {
  try { localStorage.setItem(tutorialKey(account), '1'); } catch { /* storage blocked: shows again next time */ }
}

// ── Small pieces ────────────────────────────────────────────────────────────

/**
 * Compact card face. CardPreview only draws art inside the Machine/Aura frame,
 * so Memes and Moves would show as blank colour blocks; this always shows the
 * art, and spells out the cost pips the gas step teaches.
 * `scale` is relative to CardPreview's 280px width so call sites read the same.
 */
function MiniCard({ id, scale = 0.62, dim = false }: { id: string; scale?: number; dim?: boolean }) {
  const def = CARDS[id];
  if (!def) return null;
  const meta = COLOR_META[def.color];
  const w = Math.round(280 * scale);
  const fs = Math.max(9, Math.round(w / 15)); // body text scales with the card
  const pips = def.cost ? ([...COLORS, 'any'] as const).flatMap((c) =>
    Array.from({ length: def.cost?.[c] ?? 0 }, () => c)) : [];
  if (def.fullCard && def.image) {
    // Complete rendered card: show it whole, same footprint and dim treatment.
    return (
      <div style={{ width: w, flex: 'none', aspectRatio: '5 / 7', borderRadius: 10, overflow: 'hidden', background: '#0d0b1c',
        boxShadow: `0 10px 26px rgba(0,0,0,0.55), 0 0 14px ${meta.hex}33`,
        opacity: dim ? 0.35 : 1, filter: dim ? 'grayscale(1)' : 'none', transition: 'opacity 200ms, filter 200ms' }}>
        <img src={def.image} alt={def.name} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </div>
    );
  }
  return (
    <div style={{ width: w, flex: 'none', aspectRatio: '5 / 7', display: 'flex', flexDirection: 'column', borderRadius: 10, overflow: 'hidden',
      background: '#0d0b1c', border: `2px solid ${meta.hex}`, boxShadow: `0 10px 26px rgba(0,0,0,0.55), 0 0 14px ${meta.hex}33`,
      opacity: dim ? 0.35 : 1, filter: dim ? 'grayscale(1)' : 'none', transition: 'opacity 200ms, filter 200ms' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, padding: '4px 6px',
        background: meta.hex, color: meta.ink }}>
        <span style={{ fontWeight: 800, fontSize: fs + 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{def.name}</span>
        <span style={{ display: 'flex', gap: 2, flex: 'none' }}>
          {pips.map((c, k) => (
            <span key={k} title={c === 'any' ? 'any gas' : `${COLOR_META[c].name} gas`} style={{ width: fs + 3, height: fs + 3, borderRadius: '50%',
              background: c === 'any' ? '#c8c8d0' : COLOR_META[c].hex, border: '1.5px solid #000c', boxShadow: '0 0 0 1px #fff6' }} />
          ))}
        </span>
      </div>
      <div style={{ position: 'relative', flex: '1 1 0', minHeight: 0, display: 'grid', placeItems: 'center',
        background: `linear-gradient(160deg, ${meta.hex}, #0a1020)` }}>
        {def.image
          ? <img src={def.image} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }} />
          : <ChainLogo color={def.color} size={Math.round(w / 2.6)} />}
      </div>
      <div style={{ padding: '3px 6px', fontSize: fs - 1, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: meta.hex, borderTop: `1px solid ${meta.hex}55`, borderBottom: `1px solid ${meta.hex}33` }}>
        {def.type} · {meta.name}
      </div>
      <div style={{ position: 'relative', padding: def.type === 'meme' ? `5px 6px ${fs + 10}px` : '5px 6px', minHeight: '24%',
        fontSize: fs, lineHeight: 1.3, color: '#e9e5f5' }}>
        {/* Shared card-text helper; `~` expands to the card's own name. */}
        {cardText(def, { expandName: true })}
        {def.type === 'meme' && (
          <span style={{ position: 'absolute', right: 4, bottom: 4, padding: '1px 6px', borderRadius: 5, fontWeight: 900, fontSize: fs + 2,
            background: meta.hex, color: meta.ink }}>{def.power}/{def.toughness}</span>
        )}
      </div>
    </div>
  );
}

function Pill({ children, color = T.gold }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999,
      border: `1px solid ${color}55`, background: `${color}18`, color, fontSize: 12, fontWeight: 700, letterSpacing: '0.04em' }}>
      {children}
    </span>
  );
}

function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul style={{ margin: '10px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
      {items.map((it, i) => (
        <li key={i} style={{ display: 'flex', gap: 10, fontSize: 14.5, lineHeight: 1.5, color: T.text }}>
          <span aria-hidden style={{ color: T.gold, flex: 'none', marginTop: 1 }}>◆</span>
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}

function Callout({ children, tone = T.violet }: { children: React.ReactNode; tone?: string }) {
  return (
    <div style={{ marginTop: 14, padding: '10px 14px', borderRadius: 10, background: `${tone}14`,
      border: `1px solid ${tone}44`, fontSize: 13.5, lineHeight: 1.5, color: T.text }}>
      {children}
    </div>
  );
}

function CardRow({ ids, scale }: { ids: string[]; scale?: number }) {
  return (
    <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
      {ids.map((id) => <MiniCard key={id} id={id} scale={scale} />)}
    </div>
  );
}

const B = ({ children }: { children: React.ReactNode }) => <b style={{ color: T.goldBright }}>{children}</b>;

// ── Interactive: nodes → gas → cast ─────────────────────────────────────────

const GAS_CARD = 'sol_bome'; // Molotov Mixer: 2 Rebel + 1 any
const GAS_NODES: Color[] = ['sol', 'base', 'sol'];

function GasDemo() {
  const [tapped, setTapped] = useState<boolean[]>(GAS_NODES.map(() => false));
  const [cast, setCast] = useState(false);
  const def = CARDS[GAS_CARD];
  const pool = useMemo(() => {
    const p: Record<Color, number> = { bnb: 0, sol: 0, eth: 0, robinhood: 0, base: 0 };
    GAS_NODES.forEach((c, i) => { if (tapped[i]) p[c] += 1; });
    return p;
  }, [tapped]);

  // Same check as canPay() in Game.ts: colored first, then 'any' from what's left.
  const colouredOk = COLORS.every((c) => (def.cost?.[c] ?? 0) <= pool[c]);
  const leftover = COLORS.reduce((s, c) => s + pool[c] - (def.cost?.[c] ?? 0), 0);
  const canCast = colouredOk && leftover >= (def.cost?.any ?? 0);
  const anyTapped = tapped.some(Boolean);

  let hint: React.ReactNode = <>Click the nodes to tap them. Each one adds <B>1 gas</B> of its faction.</>;
  if (cast) hint = <>Cast. The gas is spent, and <B>Molotov Mixer</B> enters the field.</>;
  else if (canCast) hint = <>That's enough. <B>2 Rebel</B> for the colored part, and the Knowledge gas pays the <B>1 any</B>.</>;
  else if (anyTapped && !colouredOk) hint = <>Not yet. The colored pips need <B>Rebel</B> gas exactly. Knowledge gas can only pay the grey "any" pip.</>;
  else if (anyTapped) hint = <>Getting there. You still need gas for the grey <B>any</B> pip.</>;

  return (
    <div style={{ display: 'grid', gap: 14, justifyItems: 'center' }}>
      <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
        <div style={{ display: 'flex', gap: 10 }}>
          {GAS_NODES.map((c, i) => (
            <button key={i} disabled={tapped[i] || cast}
              onClick={() => setTapped((t) => t.map((v, j) => (j === i ? true : v)))}
              aria-label={`Tap ${COLOR_META[c].name} Node`}
              style={{ width: 86, height: 112, borderRadius: 10, cursor: tapped[i] || cast ? 'default' : 'pointer',
                background: COLOR_META[c].hex, color: COLOR_META[c].ink, border: `2px solid ${tapped[i] ? '#0006' : T.goldBright}`,
                transform: tapped[i] ? 'rotate(90deg) scale(0.86)' : 'none', transition: 'transform 220ms, border-color 220ms',
                display: 'grid', placeItems: 'center', padding: 6, boxShadow: tapped[i] ? 'none' : `0 0 14px ${T.gold}55` }}>
              <span style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
                <ChainLogo color={c} size={30} />
                <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.04em' }}>{COLOR_META[c].name.toUpperCase()}</span>
              </span>
            </button>
          ))}
        </div>
        <MiniCard id={GAS_CARD} scale={0.62} dim={cast} />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
        <span style={{ fontSize: 12, color: T.text2, fontWeight: 700, letterSpacing: '0.08em' }}>GAS POOL</span>
        {COLORS.filter((c) => pool[c] > 0).length === 0 && <span style={{ fontSize: 13, color: T.text2 }}>empty</span>}
        {COLORS.filter((c) => pool[c] > 0).map((c) => (
          <Pill key={c} color={COLOR_META[c].hex}>{pool[c]} {COLOR_META[c].name}</Pill>
        ))}
        <button disabled={!canCast || cast} onClick={() => setCast(true)}
          style={{ marginLeft: 6, padding: '7px 16px', borderRadius: 8, fontWeight: 800, fontSize: 13, letterSpacing: '0.06em',
            cursor: canCast && !cast ? 'pointer' : 'not-allowed', border: 'none',
            background: canCast && !cast ? T.gold : 'rgba(255,255,255,0.08)', color: canCast && !cast ? '#1a1406' : T.text2 }}>
          CAST
        </button>
        {(anyTapped || cast) && (
          <button onClick={() => { setTapped(GAS_NODES.map(() => false)); setCast(false); }}
            style={{ padding: '7px 12px', borderRadius: 8, fontSize: 12, cursor: 'pointer', background: 'transparent',
              border: `1px solid ${T.border}`, color: T.text2 }}>Reset</button>
        )}
      </div>
      <div role="status" style={{ fontSize: 14, color: T.text, textAlign: 'center', minHeight: 42, maxWidth: 520 }}>{hint}</div>
    </div>
  );
}

// ── Interactive: combat ─────────────────────────────────────────────────────

const ATTACKER = 'sol_wif';            // Shadow 4/2
const BLOCKERS = ['robinhood_ozzy', 'sol_popcat']; // Vault Toad 1/4, Riot Drummer 2/3

/** resolveCombat() from Game.ts, for one attacker and no machines/auras. */
function simulateBlock(blockerIds: string[]) {
  const a = CARDS[ATTACKER];
  let remaining = a.power ?? 0;
  let attackerDamage = 0;
  const lines: string[] = [];
  const dead: string[] = [];
  if (blockerIds.length === 0) {
    return { lines: [`Unblocked. ${a.name} hits you for ${remaining}. Life 20 → ${20 - remaining}.`], dead, attackerDies: false };
  }
  for (const id of blockerIds) {
    const b = CARDS[id];
    const assigned = Math.min(remaining, b.toughness ?? 1);
    remaining -= assigned;
    attackerDamage += b.power ?? 0;
    const dies = assigned >= (b.toughness ?? 1);
    if (dies) dead.push(id);
    lines.push(`${b.name} takes ${assigned} of ${b.toughness} → ${dies ? 'destroyed' : 'survives'}. Hits back for ${b.power}.`);
  }
  const attackerDies = attackerDamage >= (a.toughness ?? 1);
  if (attackerDies) dead.push(ATTACKER);
  lines.push(`${a.name} takes ${attackerDamage} of ${a.toughness} → ${attackerDies ? 'destroyed' : 'survives'}. You take no damage.`);
  return { lines, dead, attackerDies };
}

function CombatDemo() {
  const [blocks, setBlocks] = useState<string[]>([]);
  const [resolved, setResolved] = useState(false);
  const result = useMemo(() => simulateBlock(blocks), [blocks]);
  const toggle = (id: string) => {
    setResolved(false);
    setBlocks((b) => (b.includes(id) ? b.filter((x) => x !== id) : [...b, id]));
  };

  return (
    <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
      <div style={{ fontSize: 13, color: T.text2, textAlign: 'center' }}>
        Your opponent attacks with <B>Shadow</B>. Pick your blockers (or none), then resolve.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', justifyContent: 'center' }}>
        <div style={{ display: 'grid', justifyItems: 'center', gap: 6 }}>
          <Pill color={T.danger}>ATTACKING</Pill>
          <MiniCard id={ATTACKER} scale={0.5} dim={resolved && result.dead.includes(ATTACKER)} />
        </div>
        <span aria-hidden style={{ fontSize: 26, color: T.goldBright }}>⚔</span>
        <div style={{ display: 'flex', gap: 10 }}>
          {BLOCKERS.map((id) => {
            const on = blocks.includes(id);
            return (
              <button key={id} onClick={() => toggle(id)} aria-pressed={on}
                style={{ display: 'grid', justifyItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                <Pill color={on ? T.success : T.text2}>{on ? `BLOCKING #${blocks.indexOf(id) + 1}` : 'CLICK TO BLOCK'}</Pill>
                <div style={{ borderRadius: 10, outline: on ? `2px solid ${T.success}` : '2px solid transparent', outlineOffset: 3 }}>
                  <MiniCard id={id} scale={0.5} dim={resolved && result.dead.includes(id)} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <button onClick={() => setResolved(true)}
        style={{ padding: '8px 18px', borderRadius: 8, border: 'none', fontWeight: 800, fontSize: 13, letterSpacing: '0.06em',
          background: T.gold, color: '#1a1406', cursor: 'pointer' }}>
        {blocks.length ? `RESOLVE (${blocks.length} BLOCKER${blocks.length > 1 ? 'S' : ''})` : 'RESOLVE (NO BLOCK)'}
      </button>
      <div role="status" style={{ minHeight: 66, display: 'grid', gap: 4, fontSize: 13.5, color: T.text, textAlign: 'center' }}>
        {resolved ? result.lines.map((l, i) => <div key={i}>{l}</div>) : <span style={{ color: T.text2 }}>Try every option. Each one ends differently.</span>}
      </div>
    </div>
  );
}

// ── Steps ───────────────────────────────────────────────────────────────────

interface Step { id: string; kicker: string; title: string; body: React.ReactNode; visual?: React.ReactNode }

const FACTION_STYLE: Record<Color, string> = {
  bnb: 'Go wide and lift the whole team. Pump machines and clean-up moves.',
  sol: 'Burn and haste. Cheap damage moves, hit first and fast.',
  eth: 'Removal and control. Destroy machines, finish with big hits.',
  robinhood: 'Lifegain midrange. Sturdy bodies and compounding value.',
  base: 'Card draw and tricks. Bounce threats and outthink the opponent.',
};

function buildSteps(guest: boolean): Step[] {
  return [
    {
      id: 'welcome', kicker: 'WELCOME TO EGREGORE', title: 'Bring their life from 20 to 0',
      body: (
        <>
          <p style={{ margin: 0, fontSize: 16, lineHeight: 1.55, color: T.text }}>
            EGREGORE is a one-on-one card duel. Both players start at <B>20 life</B>. Hit your opponent with Memes and Moves until they reach <B>0</B>.
          </p>
          <Bullets items={[
            <>You also lose if you have to draw from an <B>empty deck</B>.</>,
            <>This tour takes about two minutes. It covers <B>every card type</B> and every rule you need for your first match.</>,
            guest
              ? <>No account needed to read this. Sign in when you are ready to play.</>
              : <>You can skip it and replay it any time from <B>Settings</B>.</>,
          ]} />
        </>
      ),
      visual: (
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, justifyContent: 'center' }}>
          {[{ v: 20, c: T.success, l: 'START' }, { v: 0, c: T.danger, l: 'WIN' }].map((o, i) => (
            <React.Fragment key={o.l}>
              {i === 1 && <span aria-hidden style={{ fontSize: 30, color: T.goldBright }}>→</span>}
              <div style={{ display: 'grid', justifyItems: 'center', gap: 6 }}>
                <div style={{ width: 96, height: 96, borderRadius: '50%', display: 'grid', placeItems: 'center', fontFamily: HEAD,
                  fontSize: 38, fontWeight: 800, color: o.c, border: `2px solid ${o.c}`, boxShadow: `0 0 26px ${o.c}55`, background: T.well }}>{o.v}</div>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.16em', color: T.text2 }}>{o.l}</span>
              </div>
            </React.Fragment>
          ))}
        </div>
      ),
    },
    {
      id: 'factions', kicker: 'THE FIVE FACTIONS', title: 'Every card belongs to a Sproto faction',
      body: (
        <>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: T.text }}>
            A card's faction sets its color and the gas it costs. Start with one faction, then splash a second once you know the game.
          </p>
          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            {COLORS.map((c) => (
              <div key={c} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 10px', borderRadius: 10, background: T.well, border: `1px solid ${COLOR_META[c].hex}33` }}>
                <span style={{ width: 34, height: 34, flex: 'none', borderRadius: 8, display: 'grid', placeItems: 'center', background: COLOR_META[c].hex, color: COLOR_META[c].ink }}>
                  <ChainLogo color={c} size={20} />
                </span>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: COLOR_META[c].hex }}>{COLOR_META[c].name}</div>
                  <div style={{ fontSize: 13, color: T.text2 }}>{FACTION_STYLE[c]}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      ),
    },
    {
      id: 'types', kicker: 'CARD TYPES', title: 'Five kinds of card',
      body: (
        <>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: T.text }}>The next steps cover each type. Here they are side by side:</p>
          <Bullets items={[
            <><B>Node</B>: your gas supply. Free to play, one per turn.</>,
            <><B>Meme</B>: a creature that attacks and blocks.</>,
            <><B>Machine</B>: a permanent with a passive effect for your side.</>,
            <><B>Aura</B>: attaches to one Meme and changes it.</>,
            <><B>Move</B>: a one-shot effect, then it goes to the graveyard.</>,
          ]} />
        </>
      ),
      visual: <CardRow ids={['node_sol', 'sol_wif', 'bnb_farm', 'bnb_liquidity', 'sol_zap']} scale={0.4} />,
    },
    {
      id: 'nodes', kicker: 'CARD TYPE 1 · NODES', title: 'Nodes make gas. Gas pays for everything.',
      body: (
        <>
          <Bullets items={[
            <>Play <B>one Node per turn</B>. It costs nothing.</>,
            <><B>Tap</B> a Node to add <B>1 gas</B> of its faction to your pool. It untaps at the start of your next turn.</>,
            <>Costs have two parts. <B>Colored pips</B> must be paid with gas of that faction. The <B>grey pip</B> ("any") takes gas of any faction.</>,
            <>Unspent gas <B>drains at the end of your turn</B>. Tap only what you need.</>,
          ]} />
          <Callout>Try it. Tap the nodes until you can cast Molotov Mixer.</Callout>
        </>
      ),
      visual: <GasDemo />,
    },
    {
      id: 'memes', kicker: 'CARD TYPE 2 · MEMES', title: 'Memes fight for you',
      body: (
        <>
          <Bullets items={[
            <>The numbers in the corner are <B>Power / Toughness</B>. Power is the damage it deals. Toughness is the damage it can take before it's destroyed.</>,
            <><B>Summoning sickness</B>: a Meme can't attack on the turn it enters. It can still block.</>,
            <>Attacking <B>taps</B> the Meme, so it can't block on your opponent's next turn.</>,
            <>Damage that doesn't destroy a Meme <B>heals after combat</B>.</>,
            <>Some Memes do something on arrival. <B>Sproto Gremlin</B> deals 2 to your opponent and draws you a card.</>,
          ]} />
        </>
      ),
      visual: <CardRow ids={['bnb_broccoli', 'robinhood_ozzy', 'eth_sproto_gremlin']} scale={0.5} />,
    },
    {
      id: 'machines', kicker: 'CARD TYPE 3 · MACHINES', title: 'Machines work every turn',
      body: (
        <>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: T.text }}>
            A Machine stays in play and its effect is always on. Two copies stack: two <B>Shrine of Many</B> give +2/+2.
          </p>
          <Bullets items={[
            <><B>+1/+1</B> to all your Memes, or <B>+1/+0</B> to your attackers</>,
            <><B>No summoning sickness</B>, so your Memes attack the turn they land</>,
            <><B>One extra Node</B> per turn</>,
            <>Your Moves cost <B>1 less</B> gas of that faction</>,
            <><B>Lifelink</B>: you gain life equal to the damage your Memes deal</>,
            <><B>Draw a card</B> when a Meme enters under you (once per turn)</>,
          ]} />
          <Callout tone={T.danger}>Machines can be destroyed. Jester's <B>Sabotage</B> removes one.</Callout>
        </>
      ),
      visual: <CardRow ids={['bnb_farm', 'sol_amm', 'robinhood_dividend']} scale={0.5} />,
    },
    {
      id: 'auras', kicker: 'CARD TYPE 4 · AURAS', title: 'Auras attach to a single Meme',
      body: (
        <>
          <Bullets items={[
            <>Cast an Aura <B>on a Meme</B>: yours to power it up, or your opponent's.</>,
            <>Effects: <B>+2/+2</B>, <B>+3/+0</B>, <B>+0/+3</B>, <B>no summoning sickness</B>, or <B>lifelink</B>.</>,
            <>If the Meme is destroyed or returned to hand, the Aura <B>falls off</B> and goes to the graveyard.</>,
          ]} />
          <Callout>An Aura is strong but risky. One removal Move costs you both cards.</Callout>
        </>
      ),
      visual: <CardRow ids={['bnb_liquidity', 'base_staybased', 'sol_validator']} scale={0.5} />,
    },
    {
      id: 'moves', kicker: 'CARD TYPE 5 · MOVES', title: 'Moves happen once, then they are gone',
      body: (
        <>
          <Bullets items={[
            <><B>Damage</B> 2, 3 or 5 to <B>any target</B>: a Meme or a player.</>,
            <><B>Destroy</B> a Meme, or destroy a Machine.</>,
            <><B>Bounce</B> a Meme back to its owner's hand. Its Auras fall off.</>,
            <><B>Draw two</B> cards, or <B>gain 4 life</B>.</>,
            <><B>Sweep</B>: every Meme on the field takes 1 damage, including yours.</>,
          ]} />
          <Callout>Moves are played on your own turn. To play one, select it in your hand, then click its target.</Callout>
        </>
      ),
      visual: <CardRow ids={['sol_zap', 'bnb_rugpull', 'base_bridge']} scale={0.5} />,
    },
    {
      id: 'turn', kicker: 'YOUR TURN', title: 'How a turn plays out',
      body: (
        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
          {[
            ['Untap & draw', 'Your cards untap and you draw 1. The player who goes first skips that first draw.'],
            ['Main', 'Play a Node, tap Nodes for gas, cast Memes, Machines, Auras and Moves in any order.'],
            ['Attack', 'Click ready Memes to mark them as attackers, then press Attack. You can keep casting after combat.'],
            ['End turn', 'Press END TURN. Unspent gas drains, and you discard down to 7 cards.'],
          ].map(([t, d], i) => (
            <li key={t} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <span style={{ width: 28, height: 28, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center',
                background: T.panelHi, border: `1px solid ${T.borderStrong}`, color: T.goldBright, fontWeight: 800, fontSize: 13 }}>{i + 1}</span>
              <div>
                <div style={{ fontWeight: 800, fontSize: 14.5, color: T.text }}>{t}</div>
                <div style={{ fontSize: 13.5, color: T.text2, lineHeight: 1.5 }}>{d}</div>
              </div>
            </li>
          ))}
        </ol>
      ),
      visual: (
        <Callout tone={T.gold}>
          Each turn has a <B>timer</B>. If a player goes idle, their opponent can end the turn for them, so nobody gets stuck waiting.
          When you have nothing left to play or attack with, the game ends your turn for you.
        </Callout>
      ),
    },
    {
      id: 'combat', kicker: 'COMBAT', title: 'Attack, block, trade',
      body: (
        <>
          <Bullets items={[
            <>Attackers always swing at the <B>opposing player</B>. The defender chooses blocks.</>,
            <>Each untapped Meme can block <B>one</B> attacker. Several Memes can team up on the same attacker.</>,
            <>Unblocked attackers deal their full power to the player.</>,
            <>A blocked attacker deals damage to its blockers <B>in block order</B>, filling each one's toughness before moving on. Every blocker hits back.</>,
          ]} />
          <Callout>Try the combat simulator. It uses the same math as the real game.</Callout>
        </>
      ),
      visual: <CombatDemo />,
    },
    {
      id: 'setup', kicker: 'BEFORE THE FIRST TURN', title: 'Opening hand and decks',
      body: (
        <>
          <Bullets items={[
            <>You draw <B>{MULLIGAN_INITIAL_HAND} cards</B>. Too few Nodes, or too many? <B>Mulligan</B> to shuffle and draw again.</>,
            <>The first mulligan is free. Each extra one draws one fewer card, down to <B>{MULLIGAN_FLOOR}</B>. Decide quickly: the choice is on a short timer.</>,
            <>Decks are exactly <B>{DECK_SIZE} cards</B>. Up to <B>{MAX_COPIES_NONBASIC} copies</B> of any card, except Nodes, which are unlimited.</>,
            <>New players have <B>starter decks</B> for every faction. Build your own in <B>Profile → Decks</B>, and open booster packs to grow your collection.</>,
          ]} />
          <Callout tone={T.gold}>Rule of thumb: about <B>22 Nodes</B> in 60 cards. That's what the starter decks run.</Callout>
        </>
      ),
    },
    {
      id: 'ready', kicker: 'YOU ARE READY', title: guest ? 'Sign in and play' : 'Try it against the bot',
      body: (
        <>
          <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.6, color: T.text }}>
            {guest
              ? <>That's every card type and every rule. Sign in with email, Google or X (a wallet is made for you), then start with a <B>practice match against the bot</B>: nothing is at stake, and you can quit any time.</>
              : <>That's every card type and every rule. A practice match against the bot is the fastest way to make it stick: nothing is at stake, and you can quit any time.</>}
          </p>
          <Bullets items={[
            <>Hover or long-press any card in a match to see it full size.</>,
            <>The <B>Rulebook</B> has every rule in detail, plus a video walkthrough.</>,
            guest ? <>Once you're in, press <B>Practice vs Bot</B> on the main screen. No deck needed.</> : <>Replay this tutorial from <B>Settings</B>.</>,
          ]} />
        </>
      ),
    },
  ];
}

// ── Overlay ─────────────────────────────────────────────────────────────────

export function FirstRunTutorial({ onClose, onPractice, onRulebook, onSignIn }: {
  /** Fired for skip, finish and Escape. The caller marks the tutorial seen. */
  onClose: () => void;
  onPractice?: () => void;
  onRulebook?: () => void;
  /** Guest mode (sign-in screen): the last step offers sign-in instead of practice. */
  onSignIn?: () => void;
}) {
  const guest = !!onSignIn;
  const steps = useMemo(() => buildSteps(guest), [guest]);
  const [i, setI] = useState(0);
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 900);
  const step = steps[i];
  const last = i === steps.length - 1;

  const next = useCallback(() => setI((n) => Math.min(steps.length - 1, n + 1)), [steps.length]);
  const prev = useCallback(() => setI((n) => Math.max(0, n - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return; // a held arrow key would otherwise race through the steps
      if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'Escape') onClose();
    };
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  }, [next, prev, onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="tut-title"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: T.scrim, backdropFilter: 'blur(6px)',
        display: 'grid', placeItems: 'center', padding: narrow ? 10 : 24, fontFamily: FONT, color: T.text }}>
      <style>{`@media (prefers-reduced-motion: reduce){ .tut-anim{ animation:none !important; transition:none !important; } }
        @keyframes tutIn{ from{ opacity:0; transform:translateY(8px); } to{ opacity:1; transform:none; } }`}</style>
      <div style={{ width: '100%', maxWidth: 1080, maxHeight: '100%', display: 'flex', flexDirection: 'column', borderRadius: 18,
        background: `linear-gradient(180deg, ${T.panelHi}, ${T.panel})`, border: `1px solid ${T.borderStrong}`,
        boxShadow: '0 30px 80px rgba(0,0,0,0.6), 0 0 40px rgba(139,92,246,0.15)', overflow: 'hidden' }}>

        {/* Header: progress + skip */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderBottom: `1px solid ${T.border}` }}>
          <span style={{ fontFamily: HEAD, fontWeight: 800, letterSpacing: '0.24em', fontSize: 13, color: T.gold }}>TUTORIAL</span>
          <div style={{ flex: 1, display: 'flex', gap: 4 }} aria-hidden>
            {steps.map((s, k) => (
              <button key={s.id} onClick={() => setI(k)} tabIndex={-1} title={s.kicker}
                style={{ flex: 1, height: 5, borderRadius: 3, border: 'none', padding: 0, cursor: 'pointer',
                  background: k <= i ? T.gold : 'rgba(255,255,255,0.1)', transition: 'background 200ms' }} />
            ))}
          </div>
          <span style={{ fontSize: 12, color: T.text2, fontVariantNumeric: 'tabular-nums' }}>{i + 1} / {steps.length}</span>
          {!last && (
            <button onClick={onClose} style={{ padding: '6px 12px', borderRadius: 8, background: 'transparent',
              border: `1px solid ${T.border}`, color: T.text2, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}>Skip tutorial</button>
          )}
        </div>

        {/* Body */}
        <div key={step.id} className="tut-anim" style={{ flex: 1, minHeight: 0, overflowY: 'auto', animation: 'tutIn 260ms ease-out',
          display: 'grid', gap: 22, padding: narrow ? '18px 16px' : '26px 28px', alignItems: 'center',
          gridTemplateColumns: step.visual && !narrow ? 'minmax(0, 0.9fr) minmax(0, 1.1fr)' : '1fr' }}>
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '0.2em', color: T.violet }}>{step.kicker}</div>
            <h2 id="tut-title" style={{ fontFamily: HEAD, fontWeight: 800, fontSize: narrow ? 24 : 30, lineHeight: 1.15, margin: '6px 0 14px',
              color: T.goldBright }}>{step.title}</h2>
            {step.body}
          </div>
          {step.visual && <div style={{ minWidth: 0 }}>{step.visual}</div>}
        </div>

        {/* Footer: nav */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap',
          padding: '12px 18px', borderTop: `1px solid ${T.border}` }}>
          <button onClick={prev} disabled={i === 0}
            style={{ padding: '9px 16px', borderRadius: 9, background: T.panel, border: `1px solid ${T.border}`,
              color: i === 0 ? T.text2 : T.text, cursor: i === 0 ? 'default' : 'pointer', fontWeight: 600, fontSize: 13, opacity: i === 0 ? 0.5 : 1 }}>
            ← Back
          </button>
          {last ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {guest ? (
                <>
                  <button onClick={onClose} style={{ padding: '9px 16px', borderRadius: 9, background: T.panel,
                    border: `1px solid ${T.border}`, color: T.text, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Close</button>
                  <button onClick={onSignIn} style={{ padding: '9px 18px', borderRadius: 9, border: 'none', cursor: 'pointer',
                    background: T.gold, color: '#1a1406', fontWeight: 800, fontSize: 13, letterSpacing: '0.04em', boxShadow: `0 0 16px ${T.gold}66` }}>
                    Sign in to play →
                  </button>
                </>
              ) : <>
              <button onClick={onRulebook} style={{ padding: '9px 16px', borderRadius: 9, background: T.panel,
                border: `1px solid ${T.border}`, color: T.text, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Open Rulebook</button>
              <button onClick={onClose} style={{ padding: '9px 16px', borderRadius: 9, background: T.panel,
                border: `1px solid ${T.border}`, color: T.text, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>Go to the hub</button>
              <button onClick={onPractice} style={{ padding: '9px 18px', borderRadius: 9, border: 'none', cursor: 'pointer',
                background: T.gold, color: '#1a1406', fontWeight: 800, fontSize: 13, letterSpacing: '0.04em', boxShadow: `0 0 16px ${T.gold}66` }}>
                Practice vs bot →
              </button>
              </>}
            </div>
          ) : (
            <button onClick={next} style={{ padding: '9px 20px', borderRadius: 9, border: 'none', cursor: 'pointer',
              background: T.gold, color: '#1a1406', fontWeight: 800, fontSize: 13, letterSpacing: '0.04em' }}>
              Next →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
