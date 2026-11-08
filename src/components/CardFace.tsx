// src/components/CardFace.tsx
// THE canonical card-face renderer. The board, deckbuilder, boosters, tutorial
// and previews used to render a card seven different ways with copy-pasted
// cost-pip, P/T and fullCard-vs-template branching that had already drifted
// (frontend-12). This is the one tile face: it draws the FULL_CARDS render edge
// to edge when a card has one, a templated MTG-style frame when COLOR_META
// supplies one, and the composited frame with the faction sigil as the art
// fallback otherwise. The shared `CostPips` / `cardText` / `totalCost` helpers
// below are what every other surface (previews included) composes so a cost or
// text format change happens in one place.
import React from 'react';
import { CARDS, COLOR_META, COLORS, templateFor, type Color, type CardDef } from '../cards';
import type { Instance } from '../Game';
import { ChainLogo } from '../chain-logos';
import { CardHover } from '../CardPreview';
import { Moon, Refresh } from '../icons';
import { useIsMobile, useIsShort } from './responsive';

type Vars = React.CSSProperties & Record<string, string | number>;

/** Sum of every pip in a cost (colored + generic). */
export function totalCost(def: CardDef): number {
  return def.cost ? Object.values(def.cost).reduce((s, n) => s + (n ?? 0), 0) : 0;
}

/** Rules text, with the `~` self-reference optionally expanded to the name. */
export function cardText(def: CardDef, opts?: { expandName?: boolean }): string {
  const t = def.text || (def.type === 'meme' ? `A ${def.power}/${def.toughness} ${COLOR_META[def.color].name} meme.` : '—');
  return opts?.expandName ? t.replace(/~/g, def.name) : t;
}

/** The `[any, ...COLORS]` cost pip row. One grey "any" pip (#c8c8d0) + one per
 *  colour. `size` is the pip diameter in px; the digit scales with it. */
export function CostPips({ def, size = 15 }: { def: CardDef; size?: number }) {
  if (!def.cost) return null;
  return (
    <span style={{ display: 'inline-flex', gap: size <= 11 ? 1 : 2 }}>
      {(['any', ...COLORS] as const).map((c) => {
        const n = def.cost?.[c] ?? 0;
        if (!n) return null;
        const cm = c === 'any' ? { hex: '#c8c8d0', ink: '#1a1a1a', name: 'any' } : COLOR_META[c];
        return (
          <span key={c}
            title={c === 'any' ? `${n} any gas` : `${n} ${COLOR_META[c].name} gas`}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: size, height: size, borderRadius: size / 2,
              background: cm.hex, color: cm.ink,
              fontWeight: 900, fontSize: Math.max(7, Math.round(size * 0.62)),
              border: '1px solid #000', boxShadow: '0 1px 3px rgba(0,0,0,0.8)',
            }}>{n}</span>
        );
      })}
    </span>
  );
}

export function CardFace({
  defId, instance, footer, onClick, selected, faceDown, pinOnTap, size, compact: compactProp,
}: {
  defId: string;
  instance?: Instance;
  footer?: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  faceDown?: boolean;
  pinOnTap?: boolean;
  /** Explicit box, in px. Used by the mobile hand strip. */
  size?: { w: number; h: number };
  /** Override the responsive "compact" detection. Pass this from a parent that
   *  already knows the layout so CardFace does not subscribe to matchMedia per
   *  card (frontend-11). */
  compact?: boolean;
}) {
  const mobile = useIsMobile();
  const short = useIsShort();
  const compact = compactProp ?? (mobile || short); // phones portrait OR landscape
  const W = size ? size.w : compact ? 92 : 138;
  const H = size ? size.h : compact ? 134 : 200;
  if (faceDown) {
    return (
      <div style={{
        width: W, height: H, margin: 2, borderRadius: 8,
        background:
          'repeating-linear-gradient(45deg, rgba(255,255,255,0.045) 0 7px, rgba(255,255,255,0) 7px 14px), ' +
          'linear-gradient(180deg, #2b2440 0%, #171327 55%, #0e0b18 100%)',
        border: '1px solid #000',
        boxShadow:
          'inset 0 0 0 1px rgba(229,184,75,0.22), inset 0 1px 0 rgba(255,255,255,0.14), ' +
          '0 2px 5px rgba(0,0,0,0.55), 0 10px 22px rgba(0,0,0,0.45)',
        flex: '0 0 auto',
      }} />
    );
  }
  const def = CARDS[defId];
  if (!def) return null;
  const meta = COLOR_META[def.color];
  const dimmed = instance?.summoningSick || instance?.tapped;
  const tapped = !!instance?.tapped;
  const damaged = (instance?.damage ?? 0) > 0;
  const tpl = templateFor(def);
  // Full-card renders carry their own frame and text; see CardDef.fullCard.
  const full = !!(def.fullCard && def.image);
  const restShadow = selected
    ? `inset 0 0 0 1px rgba(255,246,214,0.55), 0 0 0 1px rgba(120,86,12,0.9), 0 0 20px rgba(255,216,106,0.7), 0 10px 24px rgba(0,0,0,0.55)`
    : tapped
      ? 'inset 0 0 14px rgba(0,0,0,0.6), 0 1px 3px rgba(0,0,0,0.6), 0 5px 12px rgba(0,0,0,0.4)'
      : '0 1px 2px rgba(0,0,0,0.65), 0 4px 10px rgba(0,0,0,0.45), 0 12px 26px rgba(0,0,0,0.32)';
  const vars: Vars = {
    '--rot': tapped ? '9deg' : '0deg',
    '--shadow': restShadow,
    '--glow': `${meta.hex}99`,
    '--filter': tapped ? 'saturate(0.55) brightness(0.82)' : 'none',
  };
  return (
    <CardHover defId={defId} pinOnTap={pinOnTap} onActivate={pinOnTap ? onClick : undefined}>
    <div onClick={onClick}
      className="brd-cardface"
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }) : undefined}
      style={{
        ...vars,
        width: W, height: H, margin: 2, padding: full || tpl ? 0 : 5, borderRadius: 8,
        background: full || tpl ? undefined : meta.hex,
        backgroundImage: full ? `url(${def.image})` : tpl ? `url(${tpl.url})` : undefined,
        backgroundSize: full || tpl ? '100% 100%' : undefined,
        backgroundRepeat: 'no-repeat',
        color: meta.ink,
        border: selected ? '2px solid #FFD86A' : '1px solid rgba(0,0,0,0.85)',
        cursor: onClick ? 'pointer' : 'default',
        opacity: dimmed && def.type === 'meme' ? 0.62 : 1,
        fontFamily: 'system-ui, sans-serif',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        position: 'relative', flex: '0 0 auto',
      }}>
      {full ? <FullCardFaceContent def={def} instance={instance} footer={footer} />
        : tpl ? <TemplatedCardFaceContent def={def} instance={instance} footer={footer} tpl={tpl} /> : <>
      <div style={{ fontWeight: 800, fontSize: compact ? 9.5 : 11, lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        position: 'relative', zIndex: 1 }}>{def.name}</div>
      <div style={{ position: 'relative', zIndex: 1, flex: 1, minHeight: 0, margin: '3px 0', borderRadius: 4, overflow: 'hidden',
        background: 'rgba(0,0,0,0.35)', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.6)', display: 'grid', placeItems: 'center' }}>
        {def.image
          ? <img src={def.image} alt="" loading="lazy" draggable={false}
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          : <ChainLogo color={def.color} size={compact ? 34 : 52} />}
        {def.cost && (
          <span style={{ position: 'absolute', top: 2, left: 2 }}>
            <CostPips def={def} size={15} />
          </span>
        )}
        {instance?.summoningSick && (
          <span title="Summoning sick — cannot attack this turn"
            style={{ position: 'absolute', top: 2, right: 2, display: 'inline-flex', alignItems: 'center', gap: 2, color: '#2a1f00', background: '#ffd76a', padding: '0 3px', borderRadius: 3, fontSize: 7, fontWeight: 800, boxShadow: '0 1px 3px rgba(0,0,0,0.7)' }}>
            <Moon size={8} />SICK
          </span>
        )}
        {tapped && !instance?.summoningSick && (
          <span title="Tapped" style={{ position: 'absolute', top: 2, right: 2, display: 'inline-flex', alignItems: 'center', gap: 2, color: '#111', background: '#b9bcc8', padding: '0 3px', borderRadius: 3, fontSize: 7, fontWeight: 800, boxShadow: '0 1px 3px rgba(0,0,0,0.7)' }}>
            <Refresh size={8} />TAPPED
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 3, position: 'relative', zIndex: 1 }}>
        <span style={{ fontSize: compact ? 8 : 9, fontWeight: 900, letterSpacing: '0.08em', padding: '1px 4px', borderRadius: 3,
          background: 'rgba(0,0,0,0.55)', color: '#fff' }}>{def.type.toUpperCase()}</span>
        {def.type === 'meme' && (
          <span style={{
            fontWeight: 800, fontSize: compact ? 10 : 12, padding: '0 5px', borderRadius: 4, color: '#F4F2EA',
            background: 'linear-gradient(180deg, rgba(20,16,10,0.85), rgba(8,6,4,0.9))',
            boxShadow: 'inset 0 0 0 1px rgba(229,184,75,0.45), 0 1px 2px rgba(0,0,0,0.6)',
          }}>
            {def.power}/{(def.toughness ?? 1) - (instance?.damage ?? 0)}
          </span>
        )}
      </div>
      {!compact && def.type !== 'meme' && def.type !== 'node' && (
        <div style={{ fontSize: 8, marginTop: 2, maxHeight: 28, overflow: 'hidden', lineHeight: 1.15, position: 'relative', zIndex: 1 }}>{def.text}</div>
      )}
      {footer && <div style={{ fontSize: 8, lineHeight: 1.1, position: 'relative', zIndex: 1 }}>{footer}</div>}
      </>}
      {damaged && <span aria-hidden className="brd-damaged" />}
      <span aria-hidden className="brd-gloss" />
    </div>
    </CardHover>
  );
}

/** Overlays for a full-card render (CardDef.fullCard): only live state. */
function FullCardFaceContent({ def, instance, footer }: { def: CardDef; instance?: Instance; footer?: React.ReactNode }) {
  const damage = instance?.damage ?? 0;
  return (
    <>
      {instance?.summoningSick && (
        <span title="Summoning sick — cannot attack this turn"
          style={{ position: 'absolute', top: '13.5%', right: '9%', zIndex: 1, display: 'inline-flex', alignItems: 'center', gap: 1, color: '#2a1f00', background: '#ffd76a', padding: '0 3px', borderRadius: 3, fontSize: 6, fontWeight: 800, boxShadow: '0 1px 3px rgba(0,0,0,0.7)' }}>
          <Moon size={7} />SICK
        </span>
      )}
      {instance?.tapped && !instance?.summoningSick && (
        <span title="Tapped"
          style={{ position: 'absolute', top: '13.5%', right: '9%', zIndex: 1, display: 'inline-flex', alignItems: 'center', gap: 1, color: '#111', background: '#b9bcc8', padding: '0 3px', borderRadius: 3, fontSize: 6, fontWeight: 800, boxShadow: '0 1px 3px rgba(0,0,0,0.7)' }}>
          <Refresh size={7} />TAP
        </span>
      )}
      {def.type === 'meme' && damage > 0 && (
        <span title={`${damage} damage marked`} style={{
          position: 'absolute', right: '6%', bottom: '4.5%', zIndex: 1,
          fontWeight: 800, fontSize: 10, color: '#ffb3a7',
          padding: '0 5px', borderRadius: 4,
          background: 'linear-gradient(180deg, rgba(60,10,6,0.95), rgba(20,4,2,0.97))',
          boxShadow: 'inset 0 0 0 1px rgba(255,120,100,0.6), 0 1px 3px rgba(0,0,0,0.8)',
        }}>
          {def.power}/{(def.toughness ?? 1) - damage}
        </span>
      )}
      {footer && (
        <div style={{ position: 'absolute', left: '9%', right: '9%', bottom: '1.5%', zIndex: 1, fontSize: 6, lineHeight: 1.05,
          color: '#fff', padding: '1px 3px', borderRadius: 2, background: 'rgba(0,0,0,0.7)' }}>{footer}</div>
      )}
    </>
  );
}

/** Content placed inside a templated MTG-style frame. */
function TemplatedCardFaceContent({ def, instance, footer, tpl }: { def: CardDef; instance?: Instance; footer?: React.ReactNode; tpl: { url: string; glyph?: string } }) {
  const meta = COLOR_META[def.color];
  return (
    <>
      <div style={{
        position: 'absolute', top: '5.6%', left: '9%', right: '9%', height: '5%',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 4, padding: '0 4px',
        fontSize: 8, fontWeight: 800, color: '#1a1a1a',
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{def.name}</span>
        {def.cost && <CostPips def={def} size={10} />}
      </div>
      <div style={{
        position: 'absolute', top: '13%', left: '8.5%', right: '8.5%', height: '44%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {tpl.glyph && tpl.glyph !== meta.glyph ? (
          <span style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: meta.ink, fontWeight: 900,
            fontSize: tpl.glyph.length > 4 ? 11 : 18,
            letterSpacing: tpl.glyph.length > 4 ? 1 : 2,
            textShadow: '0 2px 6px #000',
          }}>{tpl.glyph}</span>
        ) : (
          <span style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><ChainLogo color={def.color} size={40} /></span>
        )}
        {def.image && (
          <img src={def.image} alt="" loading="lazy"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            style={{ position: 'relative', width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
        {instance?.summoningSick && (
          <span title="Summoning sick — cannot attack this turn"
            style={{ position: 'absolute', top: 2, right: 2, display: 'inline-flex', alignItems: 'center', gap: 1, color: '#2a1f00', background: '#ffd76a', padding: '0 3px', borderRadius: 3, fontSize: 6, fontWeight: 800, boxShadow: '0 1px 3px rgba(0,0,0,0.7)' }}>
            <Moon size={7} />SICK
          </span>
        )}
        {instance?.tapped && !instance?.summoningSick && (
          <span title="Tapped"
            style={{ position: 'absolute', top: 2, right: 2, display: 'inline-flex', alignItems: 'center', gap: 1, color: '#111', background: '#b9bcc8', padding: '0 3px', borderRadius: 3, fontSize: 6, fontWeight: 800, boxShadow: '0 1px 3px rgba(0,0,0,0.7)' }}>
            <Refresh size={7} />TAP
          </span>
        )}
      </div>
      <div style={{
        position: 'absolute', top: '58.5%', left: '9%', right: '9%', height: '4.5%',
        display: 'flex', alignItems: 'center', padding: '0 4px',
        fontSize: 7, fontWeight: 700, color: '#1a1a1a',
        letterSpacing: 0.5, textTransform: 'uppercase',
      }}>
        {def.type}
      </div>
      <div style={{
        position: 'absolute', top: '67%', left: '9%', right: '9%', bottom: '7%',
        padding: '3px 5px',
        fontSize: 7, lineHeight: 1.15, color: '#1a1a1a',
        overflow: 'hidden',
      }}>
        {def.text}
        {def.type === 'meme' && (
          <div style={{
            position: 'absolute', right: 4, bottom: 2,
            fontWeight: 800, fontSize: 10, color: '#1a1a1a',
            padding: '0 4px', background: '#e8e6c8',
            border: '1px solid #4a5a3a', borderRadius: 2,
          }}>
            {def.power}/{(def.toughness ?? 1) - (instance?.damage ?? 0)}
          </div>
        )}
        {footer && <div style={{ fontSize: 6, lineHeight: 1.05, marginTop: 2 }}>{footer}</div>}
      </div>
    </>
  );
}
