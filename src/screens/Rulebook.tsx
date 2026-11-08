// src/screens/Rulebook.tsx
// The interactive Rulebook screen, extracted verbatim from App.tsx as part of
// the screen split (frontend-01). App loads it via React.lazy, so this whole
// cluster — the RB_* chapter data and its rendering helpers — now lives in its
// own async chunk instead of the entry bundle.
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { COLOR_META, COLORS } from '../cards';
import {
  ArrowLeft, ArrowRight, Book, ChevronDown, DiamondOutline, EnterKey, Play, Search,
  ShieldCheck, SoundOn, SoundOff, Icon, type IconKey,
} from '../icons';
import { edge as EDGE } from '../theme';
import { goldPlate, obsidianPlate } from '../ui';
import { ArtBackdrop, WIZARD_BATTLE_BG } from '../WizardBattleBackdrop';
import { PREFS_EVENT } from '../Settings';
import { useIsMobile } from '../hooks';

// Shared "ghost" button style (mirrors the one in App.tsx).
const ghostBtn: React.CSSProperties = { ...obsidianPlate(false), minHeight: 40, padding: '10px 15px', fontSize: 12 };

const RULES_TOKENS = {
  bg: '#050514',
  panel: 'rgba(20,20,40,0.85)',
  panelHi: 'rgba(28,22,58,0.92)',
  border: 'rgba(212,175,55,0.32)',
  borderSoft: 'rgba(255,255,255,0.08)',
  gold: '#D4AF37',
  goldGlow: 'rgba(212,175,55,0.55)',
  purple: '#8A2BE2',
  purpleSoft: 'rgba(138,43,226,0.55)',
  blue: '#4A90E2',
  red: '#D94B4B',
  green: '#4ad58e',
  text: '#ece1c7',
  mute: '#9e9382',
};
const RULES_FONT = "'Inter', 'Geist', 'Satoshi', system-ui, -apple-system, sans-serif";
const RULES_HEAD = '"Cinzel", "Times New Roman", serif';


/**
 * Rules/rulebook copy stores directional arrows as the ASCII markers `->` and
 * `<-` so no pictograph ever lives in a string literal. This renders them as
 * the shared SVG arrows, keeping the on-screen wording identical.
 */
function arrowize(text: string, keyPrefix = 'a'): React.ReactNode {
  const parts = String(text).split(/(->|<-)/);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part === '->' ? <ArrowRight key={`${keyPrefix}${i}`} size={13} style={{ margin: '0 4px' }} />
      : part === '<-' ? <ArrowLeft key={`${keyPrefix}${i}`} size={13} style={{ margin: '0 4px' }} />
      : <React.Fragment key={`${keyPrefix}${i}`}>{part}</React.Fragment>);
}

function LifeOrb({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        width: 92, height: 92, borderRadius: '50%',
        background: `radial-gradient(circle at 35% 30%, ${color}, ${color}33 65%, transparent 80%)`,
        border: `2px solid ${color}aa`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: RULES_HEAD, fontSize: 36, fontWeight: 900, color: '#fff',
        textShadow: '0 2px 8px rgba(0,0,0,0.8)',
        boxShadow: `0 0 28px ${color}66, inset 0 0 18px rgba(0,0,0,0.4)`,
      }}>{value}</div>
      <div style={{ fontSize: 12, color: RULES_TOKENS.mute, marginTop: 6, letterSpacing: 2 }}>{label.toUpperCase()}</div>
    </div>
  );
}

function CardTypesGrid({ highlight }: { highlight: (s: string) => React.ReactNode }) {
  const types = [
    { name: 'NODE',    icon: 'chain' as IconKey, color: RULES_TOKENS.gold,   short: 'Produces Gas',        details: 'Your "land". Free to play, but only 1 per turn. Tap on a later turn to add 1 Gas of its color to your pool.' },
    { name: 'MEME',    icon: 'frog' as IconKey, color: RULES_TOKENS.purple, short: 'Creature Card',       details: 'Your fighters. Each has Power / Toughness. Attack to deal damage to the opponent. Summoning sick the turn they enter.' },
    { name: 'MACHINE', icon: 'settings' as IconKey, color: RULES_TOKENS.blue,   short: 'Permanent Effect',    details: 'Artifact / enchantment. Stays in play with an ongoing effect until destroyed.' },
    { name: 'AURA',    icon: 'orb' as IconKey, color: RULES_TOKENS.purple, short: 'Enchant a Meme',      details: 'A spell that attaches to a single Meme. Buffs its stats or grants a keyword (haste, lifelink, etc). If the enchanted Meme dies or is bounced, the Aura is destroyed too.' },
    { name: 'MOVE',    icon: 'bolt' as IconKey, color: RULES_TOKENS.red,    short: 'Instant Action',      details: 'A one-shot spell. Resolves immediately, then goes to the graveyard.' },
  ];
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginTop: 10,
    }}>
      {types.map(t => {
        const isOpen = expanded === t.name;
        return (
          <button key={t.name} onClick={() => setExpanded(isOpen ? null : t.name)} style={{
            background: `linear-gradient(160deg, ${t.color}22 0%, rgba(0,0,0,0.55) 70%)`,
            border: `1px solid ${t.color}66`, borderRadius: 12,
            padding: '18px 16px', cursor: 'pointer', color: RULES_TOKENS.text,
            textAlign: 'left', fontFamily: RULES_FONT,
            transition: 'transform 220ms ease, box-shadow 220ms ease',
            boxShadow: isOpen ? `0 0 28px ${t.color}66` : '0 4px 14px rgba(0,0,0,0.4)',
            transform: isOpen ? 'translateY(-3px) scale(1.02)' : 'none',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-3px) scale(1.02)'; }}
          onMouseLeave={(e) => { if (!isOpen) (e.currentTarget as HTMLButtonElement).style.transform = 'none'; }}
          >
            <div style={{
              lineHeight: 1, marginBottom: 8, color: t.color, display: 'flex',
              filter: `drop-shadow(0 0 10px ${t.color})`,
            }}><Icon name={t.icon} size={38} /></div>
            <div style={{
              fontFamily: RULES_HEAD, fontWeight: 800, letterSpacing: 4,
              color: t.color, fontSize: 16, marginBottom: 4,
            }}>{t.name}</div>
            <div style={{ fontSize: 12, color: RULES_TOKENS.mute, marginBottom: 6 }}>{t.short}</div>
            {isOpen && (
              <div style={{
                marginTop: 8, paddingTop: 10, fontSize: 13,
                borderTop: `1px solid ${t.color}44`, lineHeight: 1.55,
                animation: 'rulesFade 220ms ease both',
              }}>{highlight(t.details)}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}

function GasFlowViz() {
  return (
    <div style={{
      margin: '14px 0', padding: '18px 12px',
      background: 'rgba(138,43,226,0.08)', border: `1px solid ${RULES_TOKENS.purple}33`,
      borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: 18, flexWrap: 'wrap',
    }}>
      <FlowNode icon="chain" label="NODE" color={RULES_TOKENS.gold} />
      <FlowArrow />
      <div style={{
        position: 'relative', padding: '10px 16px',
        border: `1px solid ${RULES_TOKENS.purple}88`, borderRadius: 8,
        background: 'rgba(138,43,226,0.18)',
        fontFamily: RULES_HEAD, letterSpacing: 2, fontWeight: 800,
        color: RULES_TOKENS.purple, fontSize: 14,
        boxShadow: `0 0 18px ${RULES_TOKENS.purpleSoft}`,
        overflow: 'hidden',
      }}>
        +1 GAS
        <div style={{
          position: 'absolute', inset: 0,
          background: `linear-gradient(180deg, transparent, ${RULES_TOKENS.purple}55, transparent)`,
          animation: 'rulesEnergy 1.8s ease-in-out infinite', pointerEvents: 'none',
        }} />
      </div>
      <FlowArrow />
      <FlowNode icon="frog" label="CAST MEME" color={RULES_TOKENS.purple} />
    </div>
  );
}

function FlowNode({ icon, label, color }: { icon: IconKey; label: string; color: string }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 80 }}>
      <div style={{
        width: 60, height: 60, borderRadius: 12, margin: '0 auto 6px',
        background: `radial-gradient(circle, ${color}33, transparent 75%)`,
        border: `1px solid ${color}77`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', color,
        boxShadow: `0 0 20px ${color}55`,
      }}><Icon name={icon} size={28} /></div>
      <div style={{
        fontFamily: RULES_HEAD, fontSize: 11, letterSpacing: 2, fontWeight: 700, color,
      }}>{label}</div>
    </div>
  );
}

function FlowArrow() {
  return (
    <span style={{
      color: RULES_TOKENS.gold, display: 'inline-flex',
      animation: 'rulesArrow 1.6s ease-in-out infinite',
    }}><ArrowRight size={24} /></span>
  );
}

function TurnTimeline({ highlight }: { highlight: (s: string) => React.ReactNode }) {
  const phases = [
    { id: 'untap',  name: 'UNTAP',  icon: 'refresh' as IconKey, color: RULES_TOKENS.blue,   desc: 'Untap your Nodes, Memes, and Machines. Summoning sickness wears off.' },
    { id: 'draw',   name: 'DRAW',   icon: 'cards' as IconKey,   color: RULES_TOKENS.green,  desc: 'Draw 1 card (skipped on the very first turn of the game).' },
    { id: 'main',   name: 'MAIN',   icon: 'settings' as IconKey, color: RULES_TOKENS.gold,  desc: 'Play 1 Node, tap for Gas, cast Memes, Machines, and Moves in any order.' },
    { id: 'combat', name: 'COMBAT', icon: 'swords' as IconKey,  color: RULES_TOKENS.red,    desc: 'Click Memes to attack. Opponent blocks. Damage resolves simultaneously.' },
    { id: 'end',    name: 'END',    icon: 'moon' as IconKey,    color: RULES_TOKENS.purple, desc: 'Unspent Gas evaporates. Discard down to 7 cards.' },
  ];
  const [active, setActive] = useState<string>('untap');
  const cur = phases.find(p => p.id === active)!;
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 6, margin: '10px 0 16px', flexWrap: 'wrap',
      }}>
        {phases.map((p, i) => (
          <React.Fragment key={p.id}>
            <button onClick={() => setActive(p.id)} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
              padding: '6px 4px', background: 'transparent', border: 'none', cursor: 'pointer',
              fontFamily: RULES_FONT,
            }} title={p.desc}>
              <span style={{
                width: 48, height: 48, borderRadius: '50%',
                background: active === p.id
                  ? `radial-gradient(circle, ${p.color}, ${p.color}55 65%, transparent 80%)`
                  : `radial-gradient(circle, ${p.color}55, ${p.color}11 65%, transparent 80%)`,
                border: `2px solid ${active === p.id ? p.color : `${p.color}66`}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: active === p.id ? '#fff' : p.color,
                boxShadow: active === p.id ? `0 0 20px ${p.color}aa` : 'none',
                animation: active === p.id ? 'rulesPulse 2s ease-out infinite' : 'none',
                transition: 'all 250ms ease',
              }}><Icon name={p.icon} size={21} /></span>
              <span style={{
                fontFamily: RULES_HEAD, fontSize: 10, letterSpacing: 2, fontWeight: 800,
                color: active === p.id ? p.color : RULES_TOKENS.mute,
              }}>{p.name}</span>
            </button>
            {i < phases.length - 1 && (
              <span style={{
                color: RULES_TOKENS.gold, opacity: 0.55, display: 'inline-flex',
              }}><ArrowRight size={18} /></span>
            )}
          </React.Fragment>
        ))}
      </div>
      <div style={{
        background: `linear-gradient(135deg, ${cur.color}22, transparent)`,
        border: `1px solid ${cur.color}55`, borderRadius: 10,
        padding: '14px 16px', animation: 'rulesFade 240ms ease both',
      }}>
        <div style={{
          fontFamily: RULES_HEAD, letterSpacing: 3, fontWeight: 800, color: cur.color, marginBottom: 4,
        }}>{cur.name} PHASE</div>
        <div style={{ fontSize: 13.5, color: RULES_TOKENS.text }}>{highlight(cur.desc)}</div>
      </div>
    </div>
  );
}

function ExampleTurn({ highlight }: { highlight: (s: string) => React.ReactNode }) {
  const steps = [
    { t: 'Play Red Node',            d: 'You start your turn. You spend your free Node drop and play a Rebel Node onto the battlefield.' },
    { t: 'Tap Node for 1 Purple Gas',d: 'Click your untapped Node. It rotates and adds 1 Purple Gas to your pool.' },
    { t: 'Cast a Meme',              d: 'You spend 1 Rebel Gas to cast a cheap Meme like Spark Gremlin. It enters summoning sick — it can\'t attack this turn.' },
    { t: 'End Turn',                 d: 'No combat this turn. Unspent Gas evaporates, and you pass to the opponent.' },
  ];
  const [i, setI] = useState(0);
  const s = steps[i];
  return (
    <div>
      <div style={{
        background: 'rgba(0,0,0,0.4)', border: `1px solid ${RULES_TOKENS.borderSoft}`,
        borderRadius: 10, padding: '16px 18px',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8,
        }}>
          <div style={{
            fontFamily: RULES_HEAD, letterSpacing: 3, fontSize: 12, fontWeight: 800, color: RULES_TOKENS.gold,
          }}>TURN 1 — STEP {i + 1} / {steps.length}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {steps.map((_, idx) => (
              <span key={idx} style={{
                width: 8, height: 8, borderRadius: '50%',
                background: idx === i ? RULES_TOKENS.gold : 'rgba(255,255,255,0.18)',
                boxShadow: idx === i ? `0 0 8px ${RULES_TOKENS.goldGlow}` : 'none',
                transition: 'all 200ms ease',
              }} />
            ))}
          </div>
        </div>
        <div style={{
          fontFamily: RULES_HEAD, fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 6,
        }}>{s.t}</div>
        <div style={{ fontSize: 13.5, color: RULES_TOKENS.text, lineHeight: 1.6, animation: 'rulesFade 220ms ease both' }}>
          {highlight(s.d)}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 12 }}>
        <button onClick={() => setI(v => Math.max(0, v - 1))} disabled={i === 0} style={{
          ...ghostBtn, opacity: i === 0 ? 0.4 : 1, cursor: i === 0 ? 'not-allowed' : 'pointer',
        }}><ArrowLeft size={14} /> Previous</button>
        <button onClick={() => setI(v => Math.min(steps.length - 1, v + 1))} disabled={i === steps.length - 1} style={{
          padding: '8px 18px', background: `linear-gradient(180deg, ${RULES_TOKENS.gold}, #8a6a16)`,
          color: '#1a1408', border: 'none', borderRadius: 6,
          fontWeight: 800, fontSize: 13, letterSpacing: 1,
          cursor: i === steps.length - 1 ? 'not-allowed' : 'pointer',
          opacity: i === steps.length - 1 ? 0.4 : 1,
          boxShadow: `0 0 14px ${RULES_TOKENS.goldGlow}`,
        }}>Next <ArrowRight size={14} /></button>
      </div>
    </div>
  );
}

// ── Rulebook (redesigned, data-driven) ─────────────────────────────────────
const RB = {
  bg: '#09081A', bgEl: '#0E0D21', panel: '#17142D', panelActive: '#211744', panelHover: '#262047',
  border: 'rgba(230,196,92,0.22)', borderStrong: 'rgba(230,196,92,0.55)',
  gold: '#E6C45C', goldBright: '#FFD875', violet: '#8B5CF6',
  text: '#F4F1E8', text2: '#AAA4BC', success: '#55E58B', danger: '#FF616F', blue: '#57A8FF',
};

type RBId = 'goal' | 'setup' | 'card-types' | 'gas-system' | 'turn-order' | 'combat' | 'advanced-rules' | 'example-turn' | 'ui-cheat-sheet';
type HL = (s: string) => React.ReactNode;

function rbHighlight(q: string): HL {
  return (text) => {
    const query = q.trim();
    if (!query) return arrowize(text);
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return String(text).split(re).map((part, i) =>
      part.toLowerCase() === query.toLowerCase()
        ? <mark key={i} style={{ background: 'rgba(230,196,92,0.4)', color: '#fff', borderRadius: 2, padding: '0 2px' }}>{part}</mark>
        : <React.Fragment key={i}>{arrowize(part, `r${i}`)}</React.Fragment>);
  };
}

interface RBChapter { id: RBId; num: string; title: string; icon: IconKey; accent: string; summary: string; keywords: string[]; search: string; content: (h: HL) => React.ReactNode; }

const RB_CHAPTERS: RBChapter[] = [
  { id: 'goal', num: '01', title: 'Goal', icon: 'trophy', accent: RB.gold,
    summary: 'Reduce your opponent’s life from 20 -> 0. Last player standing wins.',
    keywords: ['life', 'win', 'victory', '20'], search: 'goal life 20 reduce opponent zero win last player standing victory check',
    content: (h) => (
      <div>
        <p style={{ fontSize: 18, fontWeight: 600, color: RB.text, margin: '0 0 8px' }}>
          {h('Reduce your opponent’s life from 20 to 0.')}<br />{h('Last player standing wins.')}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 26, flexWrap: 'wrap', margin: '18px 0 6px' }}>
          <LifeOrb label="Start" value={20} color={RB.success} />
          <div aria-hidden style={{ color: RB.goldBright, display: 'flex' }}><ArrowRight size={30} /></div>
          <LifeOrb label="Win" value={0} color={RB.danger} />
        </div>
        <RuleCallout title="Victory Check" text="If every opponent is at 0 life, the match ends immediately." />
      </div>
    ) },
  { id: 'setup', num: '02', title: 'Setup', icon: 'swords', accent: RB.violet,
    summary: 'Choose a 60-card deck, draw 7 cards, and begin at 20 life.',
    keywords: ['deck', '60', 'draw', 'hand', 'mulligan', 'faction'], search: 'setup faction sproto spirit rebel jester wealth knowledge 60 card deck draw 7 hand 20 life first player no draw',
    content: (h) => (
      <div>
        <p>{h('Each player picks one of 5 Sproto factions, shuffles their 60-card deck, draws 7 cards, and starts at 20 life.')}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '14px 0' }}>
          {COLORS.map((c) => (
            <span key={c} style={{ padding: '7px 14px', borderRadius: 999, background: `${COLOR_META[c].hex}22`, color: COLOR_META[c].hex, border: `1px solid ${COLOR_META[c].hex}66`, fontWeight: 700, fontSize: 13 }}>{COLOR_META[c].name}</span>
          ))}
        </div>
        <ul style={{ marginLeft: 18, lineHeight: 1.8 }}>
          <li>{h('60-card deck in your faction color.')}</li>
          <li>{h('Draw 7 cards. Start at 20 life.')}</li>
          <li>{h('Max hand size 7 — discard down at end of turn.')}</li>
          <li>{h('The first player skips their turn-1 draw.')}</li>
        </ul>
      </div>
    ) },
  { id: 'card-types', num: '03', title: 'Card Types', icon: 'cards', accent: RB.blue,
    summary: 'Nodes, Memes, Machines, and Moves make up your toolkit.',
    keywords: ['node', 'meme', 'machine', 'aura', 'move'], search: 'card types node meme machine aura move creature power toughness permanent one-shot instant enchant',
    content: (h) => <CardTypesGrid highlight={h} /> },
  { id: 'gas-system', num: '04', title: 'Gas System', icon: 'fuel', accent: RB.violet,
    summary: 'Tap Nodes to fuel your cards. Unspent Gas drains every turn.',
    keywords: ['gas', 'mana', 'cost', 'tap', 'node'], search: 'gas mana cost tap node color pool drain end of turn empty mixed fuel',
    content: (h) => (
      <div>
        <p>{h('Nodes generate Gas. Cards cost Gas. Gas drains at end of your turn — spend it or lose it.')}</p>
        <GasFlowViz />
        <ul style={{ marginLeft: 18, marginTop: 10, lineHeight: 1.8 }}>
          <li>{h('Tap a Node -> +1 Gas of its color.')}</li>
          <li>{h('A cost can be one color or mixed.')}</li>
          <li>{h('Unspent Gas evaporates when your turn ends.')}</li>
        </ul>
      </div>
    ) },
  { id: 'turn-order', num: '05', title: 'Turn Order', icon: 'refresh', accent: RB.gold,
    summary: 'Untap -> Draw -> Main -> Combat -> End.',
    keywords: ['turn', 'phase', 'untap', 'draw', 'main', 'combat', 'end'], search: 'turn phase untap draw main combat attack block damage end discard summoning sick haste',
    content: (h) => (
      <div>
        <p style={{ marginTop: 0 }}>{h('Every turn moves through five phases in order.')}</p>
        <TurnTimeline highlight={h} />
      </div>
    ) },
  { id: 'combat', num: '06', title: 'Combat', icon: 'swords', accent: RB.danger,
    summary: 'Declare attackers, let the defender block, then resolve damage.',
    keywords: ['combat', 'attack', 'block', 'damage', 'blocker'], search: 'combat attack declare attackers blockers unblocked hits life simultaneous damage power toughness destroy',
    content: (h) => (
      <div>
        <ul style={{ marginLeft: 18, lineHeight: 1.85 }}>
          <li><b style={{ color: RB.gold }}>Declare attackers</b> — {h('Tap your untapped, non-summoning-sick Memes to attack.')}</li>
          <li><b style={{ color: RB.gold }}>Blocking</b> — {h('The defender assigns blockers from untapped Memes. Unblocked attackers hit life directly.')}</li>
          <li><b style={{ color: RB.gold }}>Simultaneous damage</b> — {h('Attacker and blocker deal their Power to each other at the same time. Damage ≥ toughness destroys a Meme.')}</li>
          <li><b style={{ color: RB.gold }}>To the graveyard</b> — {h('Destroyed Memes go to the graveyard.')}</li>
        </ul>
      </div>
    ) },
  { id: 'advanced-rules', num: '07', title: 'Advanced Rules', icon: 'book', accent: RB.violet,
    summary: 'Summoning sickness, blockers, simultaneous damage, hand size.',
    keywords: ['summoning', 'sickness', 'haste', 'graveyard', 'hand'], search: 'advanced summoning sickness haste blockers simultaneous damage graveyard discard max hand 7 discard down',
    content: (h) => (
      <div>
        <ul style={{ marginLeft: 18, lineHeight: 1.85 }}>
          <li><b style={{ color: RB.gold }}>Summoning sickness</b> — {h('Memes can’t attack the turn they enter (unless they have haste).')}</li>
          <li><b style={{ color: RB.gold }}>Blocking</b> — {h('Defender chooses blockers from untapped Memes. Unblocked attackers hit life directly.')}</li>
          <li><b style={{ color: RB.gold }}>Simultaneous damage</b> — {h('Attacker and blocker deal Power to each other. Damage ≥ toughness destroys it.')}</li>
          <li><b style={{ color: RB.gold }}>Graveyard</b> — {h('Destroyed Memes, used Moves go here. Some cards interact with the graveyard.')}</li>
          <li><b style={{ color: RB.gold }}>Max hand 7</b> — {h('Discard down at end of turn.')}</li>
        </ul>
      </div>
    ) },
  { id: 'example-turn', num: '08', title: 'Example Turn', icon: 'gamepad', accent: RB.blue,
    summary: 'Walk through Turn 1 step-by-step.',
    keywords: ['example', 'walkthrough', 'turn 1'], search: 'example turn 1 play red rebel node tap gain gas cast spark gremlin end walkthrough',
    content: (h) => <ExampleTurn highlight={h} /> },
  { id: 'ui-cheat-sheet', num: '09', title: 'UI Cheat Sheet', icon: 'keyboard', accent: RB.gold,
    summary: 'Quick clicks for the in-match UI.',
    keywords: ['ui', 'click', 'controls', 'buttons'], search: 'ui click node tap card hand play meme attack blocker end turn button cheat sheet controls',
    content: (h) => (
      <div>
        <ul style={{ marginLeft: 18, lineHeight: 1.85 }}>
          <li>{h('Click an untapped Node -> tap for Gas.')}</li>
          <li>{h('Click a card in hand -> play it (Moves then ask for a target).')}</li>
          <li>{h('Click your own untapped Meme -> mark attacker. Press "Attack with N".')}</li>
          <li>{h('During declare blockers -> click your Meme, then click the attacker to block.')}</li>
          <li>{h('Press End Turn to pass.')}</li>
        </ul>
      </div>
    ) },
];

const RB_KEY_TERMS: { term: string; to: RBId; color: string }[] = [
  { term: 'Node', to: 'card-types', color: RB.gold },
  { term: 'Gas', to: 'gas-system', color: RB.violet },
  { term: 'Meme', to: 'card-types', color: RB.blue },
  { term: 'Machine', to: 'card-types', color: RB.danger },
  { term: 'Move', to: 'card-types', color: RB.success },
];

const RB_QUICKSTART: { n: number; title: string; sub: string; color: string; to: RBId }[] = [
  { n: 1, title: 'Play Nodes', sub: 'Build your board', color: RB.gold, to: 'card-types' },
  { n: 2, title: 'Generate Gas', sub: 'Fuel your cards', color: RB.violet, to: 'gas-system' },
  { n: 3, title: 'Cast Memes', sub: 'Deploy your units', color: RB.blue, to: 'card-types' },
  { n: 4, title: 'Attack', sub: 'Pressure your rival', color: RB.danger, to: 'combat' },
  { n: 5, title: 'Reduce 20 -> 0', sub: 'Last player standing', color: RB.success, to: 'goal' },
];

function readRbHash(): RBId {
  const h = (typeof window !== 'undefined' ? window.location.hash : '').replace('#', '');
  return RB_CHAPTERS.some((c) => c.id === h) ? (h as RBId) : 'goal';
}

export function RulebookPage({ onBack }: { onBack: () => void }) {
  const narrow = useIsMobile(1279);
  const phone = useIsMobile(767);
  const [activeId, setActiveId] = useState<RBId>(readRbHash);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hlQuery, setHlQuery] = useState('');
  const [muted, setMuted] = useState<boolean>(() => { try { return localStorage.getItem('ocva.muted') === '1'; } catch { return false; } });
  const mainRef = useRef<HTMLDivElement | null>(null);
  const activeIdx = RB_CHAPTERS.findIndex((c) => c.id === activeId);
  const active = RB_CHAPTERS[activeIdx];
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  const go = useCallback((id: RBId, opts?: { hl?: string; scroll?: boolean }) => {
    setActiveId(id);
    setHlQuery(opts?.hl ?? '');
    try { window.history.replaceState(null, '', `#${id}`); } catch {}
    if (opts?.scroll !== false) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setTimeout(() => mainRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }), 40);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(true); }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const onHash = () => setActiveId(readRbHash());
    window.addEventListener('hashchange', onHash);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('hashchange', onHash); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem('ocva.muted', muted ? '1' : '0'); } catch {}
    document.querySelectorAll('audio,video').forEach((a) => { (a as HTMLMediaElement).muted = muted; });
    // Let <BgMusic> re-assert its own per-track mute after this blanket set.
    try { window.dispatchEvent(new CustomEvent(PREFS_EVENT)); } catch {}
  }, [muted]);

  const h = rbHighlight(hlQuery);
  const below = RB_CHAPTERS.filter((_, i) => i > activeIdx);

  return (
    <div style={{ minHeight: '100dvh', background: RB.bg, color: RB.text, fontFamily: RULES_FONT, position: 'relative' }}>
      <style>{`
        @media (prefers-reduced-motion: reduce){ .rb-anim{ transition:none !important; animation:none !important; } }
        .rb-scroll::-webkit-scrollbar{ width:8px; } .rb-scroll::-webkit-scrollbar-thumb{ background:${RB.panelHover}; border-radius:4px; }
        .rb-snap{ scroll-snap-type:x mandatory; } .rb-snap > *{ scroll-snap-align:start; }
      `}</style>
      <RBParticles />

      <RulebookHeader onBack={onBack} onOpenSearch={() => setSearchOpen(true)} isMac={isMac} narrow={narrow} />

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1520, margin: '0 auto', padding: phone ? '14px 14px 60px' : '20px 24px 60px' }}>
        {/* Hero */}
        <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : '1.15fr 0.85fr', gap: 22, alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.22em', color: RB.gold }}>EGREGORE</div>
            <h1 style={{ fontFamily: RULES_HEAD, fontWeight: 800, fontSize: phone ? 40 : 'clamp(44px, 5vw, 68px)', lineHeight: 1.02, margin: '6px 0 10px',
              background: `linear-gradient(180deg, #ffe9a8, ${RB.gold} 55%, #a6802f)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>
              Master the Arena
            </h1>
            <p style={{ fontSize: 17, color: RB.text2, margin: '0 0 14px' }}>Everything you need to play, build, and win.</p>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 999, background: RB.panel, border: `1px solid ${RB.border}`, fontSize: 13, fontWeight: 600 }}>
              <Book size={15} /> {RB_CHAPTERS.length} chapters · 8 min read
            </span>
          </div>
          <TutorialPreview muted={muted} />
        </div>

        {/* Quick start */}
        <QuickStartPath onGo={(id) => go(id)} phone={phone} />

        {/* Workspace */}
        <div style={{ display: 'grid', gap: 18, marginTop: 20,
          gridTemplateColumns: narrow ? '1fr' : '230px minmax(0, 1fr) 288px', alignItems: 'start' }}>
          {!narrow ? (
            <ChapterNavigation chapters={RB_CHAPTERS} activeId={activeId} activeIdx={activeIdx} onGo={(id) => go(id)} />
          ) : (
            <ChapterDropdown chapters={RB_CHAPTERS} activeId={activeId} onGo={(id) => go(id)} />
          )}

          <div ref={mainRef}>
            <RuleChapter chapter={active} idx={activeIdx} total={RB_CHAPTERS.length} h={h}
              onPrev={() => go(RB_CHAPTERS[Math.max(0, activeIdx - 1)].id)}
              onNext={() => go(RB_CHAPTERS[Math.min(RB_CHAPTERS.length - 1, activeIdx + 1)].id)} />
            {below.map((c) => <RuleAccordion key={c.id} chapter={c} onOpen={() => go(c.id)} />)}
            <div style={{ textAlign: 'center', fontSize: 13, color: RB.text2, fontStyle: 'italic', marginTop: 16 }}>That’s the whole game. Have fun.</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <AtAGlance />
            <KeywordGlossary onGo={(id) => go(id)} />
            <StillStuck onGo={() => go('example-turn')} />
          </div>
        </div>
      </div>

      {/* Floating mute */}
      <button onClick={() => setMuted((m) => !m)} aria-label={muted ? 'Unmute' : 'Mute'} className="rb-anim"
        style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 20, width: 48, height: 48, borderRadius: '50%', display: 'grid', placeItems: 'center',
          background: RB.panel, border: `1px solid ${RB.borderStrong}`, color: RB.goldBright, cursor: 'pointer', fontSize: 18, boxShadow: '0 6px 20px rgba(0,0,0,0.5)' }}>
        {muted ? <SoundOff size={19} /> : <SoundOn size={19} />}
      </button>

      {searchOpen && <RuleSearch onClose={() => setSearchOpen(false)} onSelect={(id, q) => { go(id, { hl: q }); setSearchOpen(false); }} />}
    </div>
  );
}

function RBParticles() {
  return (
    <div aria-hidden style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, background:
        `radial-gradient(60% 40% at 50% 0%, rgba(139,92,246,0.10), transparent 70%), radial-gradient(120% 90% at 50% 0%, ${RB.bgEl} 0%, ${RB.bg} 60%)` }} />
      <ArtBackdrop src={WIZARD_BATTLE_BG} />
      {Array.from({ length: 12 }).map((_, i) => (
        <span key={i} className="rb-anim" style={{ position: 'absolute', left: `${(i * 61) % 100}%`, top: `${(i * 37) % 100}%`,
          width: 2 + (i % 3), height: 2 + (i % 3), borderRadius: '50%', background: i % 3 === 0 ? RB.violet : RB.gold, opacity: 0.35,
          boxShadow: `0 0 6px ${i % 3 === 0 ? RB.violet : RB.gold}` }} />
      ))}
    </div>
  );
}

function RulebookHeader({ onBack, onOpenSearch, isMac, narrow }: { onBack: () => void; onOpenSearch: () => void; isMac: boolean; narrow: boolean }) {
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 12, height: 62, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      padding: '0 20px', background: 'rgba(9,8,26,0.82)', backdropFilter: 'blur(10px)', borderBottom: `1px solid ${RB.border}` }}>
      <button onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderRadius: 9,
        background: RB.panel, border: `1px solid ${RB.border}`, color: RB.text, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}><ArrowLeft size={14} /> Back</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden style={{ color: RB.gold, opacity: 0.6, display: 'inline-flex' }}><DiamondOutline size={10} /></span>
        <span style={{ fontFamily: RULES_HEAD, fontWeight: 800, letterSpacing: '0.28em', fontSize: 15, color: RB.gold }}>RULEBOOK</span>
        <span aria-hidden style={{ color: RB.gold, opacity: 0.6, display: 'inline-flex' }}><DiamondOutline size={10} /></span>
      </div>
      <button onClick={onOpenSearch} aria-label="Search rules" style={{ display: 'flex', alignItems: 'center', gap: 8, width: narrow ? 'auto' : 300,
        padding: '9px 12px', borderRadius: 9, background: RB.panel, border: `1px solid ${RB.border}`, color: RB.text2, cursor: 'pointer', fontSize: 13 }}>
        <Search size={15} />
        {!narrow && <span style={{ flex: 1, textAlign: 'left' }}>Search rules…</span>}
        <kbd style={{ padding: '2px 7px', fontSize: 11, background: 'rgba(0,0,0,0.4)', borderRadius: 5, color: RB.text2, border: `1px solid ${RB.border}` }}>{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
      </button>
    </div>
  );
}

function TutorialPreview({ muted }: { muted: boolean }) {
  const vidRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState('');
  const play = () => { const v = vidRef.current; if (!v) return; v.play().then(() => setPlaying(true)).catch(() => {}); };
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return (
    <div style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', borderRadius: 14, overflow: 'hidden',
      border: `1px solid ${RB.border}`, boxShadow: '0 14px 40px rgba(0,0,0,0.5), 0 0 30px rgba(139,92,246,0.12)', background: '#000' }}>
      <video ref={vidRef} src="/rules-intro.mp4" poster="/intro.png" preload="metadata" playsInline controls={playing} muted={muted}
        aria-label="EGREGORE tutorial video" onLoadedMetadata={(e) => setDuration(fmt((e.currentTarget as HTMLVideoElement).duration || 0))}
        onPause={() => setPlaying(false)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      {!playing && (
        <button onClick={play} aria-label="Play tutorial" className="rb-anim" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          background: 'linear-gradient(180deg, rgba(9,8,26,0.15), rgba(9,8,26,0.55))', border: 'none', cursor: 'pointer' }}>
          <span style={{ width: 74, height: 74, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'rgba(9,8,26,0.5)',
            border: `2px solid ${RB.goldBright}`, boxShadow: `0 0 26px ${RB.gold}88`, color: RB.goldBright, paddingLeft: 6 }}><Play size={26} /></span>
          <div style={{ position: 'absolute', left: 14, bottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: RB.gold }}>60-SECOND OVERVIEW</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Watch tutorial</div>
          </div>
          {duration && <div style={{ position: 'absolute', right: 12, bottom: 12, padding: '3px 9px', borderRadius: 6, background: 'rgba(0,0,0,0.6)', border: `1px solid ${RB.border}`, fontSize: 12, color: RB.text }}>{duration}</div>}
        </button>
      )}
    </div>
  );
}

function QuickStartPath({ onGo, phone }: { onGo: (id: RBId) => void; phone: boolean }) {
  return (
    <div style={{ marginTop: 20, padding: phone ? '16px 12px' : '18px 22px', borderRadius: 16, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <div style={{ textAlign: 'center', fontFamily: RULES_HEAD, fontWeight: 700, letterSpacing: '0.26em', fontSize: 14, color: RB.gold, marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}><DiamondOutline size={10} /> LEARN IN 30 SECONDS <DiamondOutline size={10} /></div>
      <div className={phone ? 'rb-snap rb-scroll' : ''} style={{ display: 'flex', alignItems: 'stretch', gap: phone ? 10 : 8, overflowX: phone ? 'auto' : 'visible' }}>
        {RB_QUICKSTART.map((s, i) => (
          <React.Fragment key={s.n}>
            <button onClick={() => onGo(s.to)} className="rb-anim" style={{ flex: phone ? '0 0 78%' : '1 1 0', minWidth: phone ? 220 : 0,
              display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12, cursor: 'pointer', textAlign: 'left',
              background: RB.bgEl, border: `1px solid ${s.color}44`, color: RB.text, transition: 'transform .18s ease, box-shadow .18s ease' }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = `0 8px 20px -8px ${s.color}`; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}>
              <span style={{ width: 42, height: 42, flex: 'none', borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 900, fontSize: 17,
                color: '#0a0a14', background: `radial-gradient(circle at 35% 30%, ${s.color}, ${s.color}99)`, boxShadow: `0 0 16px ${s.color}66` }}>{s.n}</span>
              <span>
                <div style={{ fontSize: 14, fontWeight: 800, color: s.color }}>{arrowize(s.title, `rq${s.n}`)}</div>
                <div style={{ fontSize: 12, color: RB.text2 }}>{s.sub}</div>
              </span>
            </button>
            {i < RB_QUICKSTART.length - 1 && !phone && <span aria-hidden style={{ alignSelf: 'center', color: RB.gold, opacity: 0.5, flex: 'none', display: 'inline-flex' }}><ArrowRight size={16} /></span>}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function ChapterNavigation({ chapters, activeId, activeIdx, onGo }: { chapters: RBChapter[]; activeId: RBId; activeIdx: number; onGo: (id: RBId) => void }) {
  return (
    <nav aria-label="Chapters" style={{ position: 'sticky', top: 78, alignSelf: 'start', padding: 12, borderRadius: 14, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px 10px', borderBottom: `1px solid ${RB.border}`, marginBottom: 8 }}>
        <span style={{ fontFamily: RULES_HEAD, fontSize: 12, letterSpacing: '0.2em', fontWeight: 700, color: RB.gold }}>CHAPTERS</span>
        <span style={{ fontSize: 11, color: RB.text2 }}>{activeIdx + 1} of {chapters.length}</span>
      </div>
      <div style={{ position: 'relative' }}>
        <div aria-hidden style={{ position: 'absolute', left: 15, top: 8, bottom: 8, width: 2, background: RB.border }} />
        {chapters.map((c, i) => {
          const active = c.id === activeId;
          return (
            <button key={c.id} onClick={() => onGo(c.id)} aria-current={active ? 'true' : undefined} className="rb-anim"
              style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 10px', marginBottom: 2,
                borderRadius: 8, cursor: 'pointer', textAlign: 'left', fontFamily: RULES_FONT, fontSize: 13.5, fontWeight: active ? 700 : 500,
                color: active ? RB.goldBright : RB.text, background: active ? RB.panelActive : 'transparent',
                border: `1px solid ${active ? RB.borderStrong : 'transparent'}`, boxShadow: active ? `0 0 14px rgba(230,196,92,0.18)` : 'none', transition: 'all .18s ease' }}>
              <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', flex: 'none', zIndex: 1,
                background: active ? RB.gold : (i < activeIdx ? RB.gold : RB.bgEl), border: `2px solid ${active || i < activeIdx ? RB.gold : RB.border}`,
                boxShadow: active ? `0 0 10px ${RB.gold}` : 'none' }} />
              <Icon name={c.icon} size={16} />
              <span>{c.title}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function ChapterDropdown({ chapters, activeId, onGo }: { chapters: RBChapter[]; activeId: RBId; onGo: (id: RBId) => void }) {
  return (
    <div style={{ padding: 12, borderRadius: 14, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <label htmlFor="rb-chapter-select" style={{ display: 'block', fontFamily: RULES_HEAD, fontSize: 12, letterSpacing: '0.2em', fontWeight: 700, color: RB.gold, marginBottom: 8 }}>CHAPTERS</label>
      <select id="rb-chapter-select" value={activeId} onChange={(e) => onGo(e.target.value as RBId)}
        style={{ width: '100%', padding: '12px 12px', borderRadius: 9, background: RB.bgEl, border: `1px solid ${RB.border}`, color: RB.text, fontSize: 15, minHeight: 44 }}>
        {chapters.map((c) => <option key={c.id} value={c.id}>{c.num} · {c.title}</option>)}
      </select>
    </div>
  );
}

function RuleChapter({ chapter, idx, total, h, onPrev, onNext }: { chapter: RBChapter; idx: number; total: number; h: HL; onPrev: () => void; onNext: () => void }) {
  return (
    <section aria-labelledby={`rb-${chapter.id}-title`} className="ova-panel-orn ova-panel-orn--hi"
      style={{ padding: 'clamp(18px, 3vw, 26px)', background: RB.panelActive, borderColor: RB.borderStrong }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
        <span aria-hidden style={{ width: 46, height: 46, flex: 'none', borderRadius: 11, display: 'grid', placeItems: 'center', color: RB.goldBright,
          background: 'linear-gradient(135deg, rgba(230,196,92,0.2), rgba(139,92,246,0.2))', border: `1px solid ${RB.border}` }}><Icon name={chapter.icon} size={23} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.16em', color: RB.gold }}>CHAPTER {chapter.num}</div>
          <h2 id={`rb-${chapter.id}-title`} style={{ margin: 0, fontFamily: RULES_HEAD, fontWeight: 700, fontSize: 'clamp(22px, 5vw, 28px)', color: RB.text }}>{chapter.title}</h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onPrev} disabled={idx === 0} className="rb-anim" style={navBtn(idx === 0)}><ArrowLeft size={13} /> Previous</button>
          <button onClick={onNext} disabled={idx === total - 1} className="rb-anim" style={navBtn(idx === total - 1, true)}>Next <ArrowRight size={13} /></button>
        </div>
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.7, color: RB.text }}>{chapter.content(h)}</div>
    </section>
  );
}
function navBtn(disabled: boolean, primary?: boolean): React.CSSProperties {
  if (primary && !disabled) return { ...goldPlate(false), padding: '10px 16px', fontSize: 12, letterSpacing: '0.1em' };
  return { ...obsidianPlate(disabled), padding: '10px 15px', fontSize: 12.5, whiteSpace: 'nowrap',
    cursor: disabled ? 'not-allowed' : 'pointer' };
}

function RuleAccordion({ chapter, onOpen }: { chapter: RBChapter; onOpen: () => void }) {
  return (
    <button onClick={onOpen} aria-expanded={false} aria-controls={`rb-${chapter.id}-title`} className="rb-anim"
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 16, padding: '18px 20px', marginTop: 12, borderRadius: 12, cursor: 'pointer',
        background: RB.panel, border: `1px solid ${RB.border}`, color: RB.text, textAlign: 'left', minHeight: 44,
        boxShadow: `${EDGE.topHighlight}, 0 8px 22px -16px rgba(3,2,10,0.9)`,
        transition: 'background 170ms cubic-bezier(0.2,0.8,0.2,1), border-color 170ms ease, transform 170ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 190ms ease' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = RB.panelHover; e.currentTarget.style.borderColor = RB.borderStrong; e.currentTarget.style.transform = 'translateY(-2px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = RB.panel; e.currentTarget.style.borderColor = RB.border; e.currentTarget.style.transform = 'none'; }}>
      <span style={{ fontFamily: RULES_HEAD, fontWeight: 800, fontSize: 22, color: RB.gold, flex: 'none' }}>{chapter.num}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontFamily: RULES_HEAD, fontWeight: 700, fontSize: 18, color: RB.text }}>{chapter.title}</span>
        <span style={{ display: 'block', fontSize: 13, color: RB.text2, marginTop: 2 }}>{arrowize(chapter.summary, `cs-${chapter.id}`)}</span>
      </span>
      <span aria-hidden style={{ color: RB.gold, flex: 'none', display: 'inline-flex' }}><ChevronDown size={17} /></span>
    </button>
  );
}

function RuleCallout({ title, text }: { title: string; text: string }) {
  return (
    <div style={{ marginTop: 16, display: 'flex', gap: 12, padding: '14px 16px', borderRadius: 12, background: 'rgba(230,196,92,0.06)', border: `1px solid ${RB.borderStrong}` }}>
      <span aria-hidden style={{ color: RB.gold, display: 'inline-flex', flex: 'none' }}><ShieldCheck size={20} /></span>
      <div>
        <div style={{ fontWeight: 800, color: RB.goldBright, fontSize: 14 }}>{title}</div>
        <div style={{ fontSize: 13.5, color: RB.text2, marginTop: 3 }}>{text}</div>
      </div>
    </div>
  );
}

function AtAGlance() {
  const rows = [
    { icon: 'heart' as IconKey, label: 'Starting Life', value: '20', color: RB.success },
    { icon: 'cards' as IconKey, label: 'Opening Hand', value: '7', color: RB.violet },
    { icon: 'books' as IconKey, label: 'Deck Size', value: '60', color: RB.blue },
  ];
  return (
    <div style={{ padding: 16, borderRadius: 14, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <div style={{ fontFamily: RULES_HEAD, fontSize: 12, letterSpacing: '0.18em', fontWeight: 700, color: RB.gold, marginBottom: 12 }}>AT A GLANCE</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 8, borderBottom: `1px solid ${RB.border}` }}>
            <span aria-hidden style={{ color: r.color, display: 'inline-flex' }}><Icon name={r.icon} size={17} /></span>
            <span style={{ flex: 1, fontSize: 13.5, color: RB.text2 }}>{r.label}</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: r.color }}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function KeywordGlossary({ onGo }: { onGo: (id: RBId) => void }) {
  return (
    <div style={{ padding: 16, borderRadius: 14, background: RB.panel, border: `1px solid ${RB.border}` }}>
      <div style={{ fontFamily: RULES_HEAD, fontSize: 12, letterSpacing: '0.18em', fontWeight: 700, color: RB.gold, marginBottom: 12 }}>KEY TERMS</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {RB_KEY_TERMS.map((t) => (
          <button key={t.term} onClick={() => onGo(t.to)} className="rb-anim" style={{ padding: '7px 12px', borderRadius: 8, cursor: 'pointer',
            background: `${t.color}18`, border: `1px solid ${t.color}66`, color: t.color, fontWeight: 700, fontSize: 13 }}>{t.term}</button>
        ))}
      </div>
    </div>
  );
}

function StillStuck({ onGo }: { onGo: () => void }) {
  return (
    <div style={{ padding: 16, borderRadius: 14, background: 'linear-gradient(160deg, rgba(139,92,246,0.14), rgba(23,20,45,0.6))', border: `1px solid ${RB.border}` }}>
      <div style={{ fontFamily: RULES_HEAD, fontSize: 18, fontWeight: 700, color: RB.goldBright }}>Still stuck?</div>
      <div style={{ fontSize: 13.5, color: RB.text2, margin: '6px 0 14px' }}>See a full turn walkthrough.</div>
      <button onClick={onGo} className="rb-anim" style={{ width: '100%', padding: '12px', borderRadius: 10, cursor: 'pointer', minHeight: 44,
        background: 'transparent', border: `1px solid ${RB.borderStrong}`, color: RB.goldBright, fontWeight: 800, letterSpacing: '0.04em', fontSize: 13,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>View Example Turn <ArrowRight size={14} /></button>
    </div>
  );
}

function RuleSearch({ onClose, onSelect }: { onClose: () => void; onSelect: (id: RBId, q: string) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return RB_CHAPTERS.map((c) => ({ c, snippet: c.summary }));
    return RB_CHAPTERS.map((c) => {
      const hay = `${c.title} ${c.summary} ${c.search} ${c.keywords.join(' ')}`.toLowerCase();
      if (!hay.includes(query)) return null;
      const src = `${c.summary} ${c.search}`;
      const at = src.toLowerCase().indexOf(query);
      const snippet = at >= 0 ? '…' + src.slice(Math.max(0, at - 24), at + query.length + 30).trim() + '…' : c.summary;
      return { c, snippet };
    }).filter(Boolean) as { c: RBChapter; snippet: string }[];
  }, [q]);

  useEffect(() => { setSel(0); }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[sel]) onSelect(results[sel].c.id, q); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  const hl = rbHighlight(q);

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label="Search rules"
      style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(4,4,12,0.72)', backdropFilter: 'blur(4px)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '10vh 16px 16px' }}>
      <div onClick={(e) => e.stopPropagation()} onKeyDown={onKey} style={{ width: 'min(640px, 100%)', maxHeight: '76vh', display: 'flex', flexDirection: 'column',
        borderRadius: 14, background: RB.bgEl, border: `1px solid ${RB.borderStrong}`, boxShadow: '0 30px 80px rgba(0,0,0,0.6)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: `1px solid ${RB.border}` }}>
          <span aria-hidden style={{ color: RB.gold, display: 'inline-flex' }}><Search size={17} /></span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules… (combat, gas, summoning sickness)" aria-label="Search rules"
            style={{ flex: 1, background: 'none', border: 'none', outline: 'none', color: RB.text, fontSize: 16, fontFamily: RULES_FONT }} />
          <kbd style={{ padding: '2px 7px', fontSize: 11, background: 'rgba(0,0,0,0.4)', borderRadius: 5, color: RB.text2 }}>Esc</kbd>
        </div>
        <div className="rb-scroll" role="listbox" style={{ overflowY: 'auto', padding: 8 }}>
          {results.length === 0 ? (
            <div style={{ padding: 26, textAlign: 'center', color: RB.text2 }}>
              <div style={{ marginBottom: 6, color: RB.text2 }} aria-hidden><Search size={26} /></div>
              No rules found for “{q}”. Try “combat”, “gas”, or “setup”.
            </div>
          ) : results.map((r, i) => (
            <button key={r.c.id} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => onSelect(r.c.id, q)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'left',
                background: i === sel ? RB.panelActive : 'transparent', border: `1px solid ${i === sel ? RB.borderStrong : 'transparent'}`, color: RB.text, marginBottom: 2 }}>
              <span aria-hidden style={{ flex: 'none', color: RB.gold, display: 'inline-flex' }}><Icon name={r.c.icon} size={18} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{hl(r.c.title)}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: RB.gold }}>CH {r.c.num}</span>
                </span>
                <span style={{ display: 'block', fontSize: 12.5, color: RB.text2, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hl(r.snippet)}</span>
              </span>
              <span aria-hidden style={{ color: RB.text2, flex: 'none', display: 'inline-flex' }}><EnterKey size={13} /></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
