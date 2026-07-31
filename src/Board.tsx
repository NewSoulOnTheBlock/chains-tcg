// src/Board.tsx
// React board for Chains TCG.
import React, { useState, useEffect, useRef } from 'react';
import type { BoardProps } from 'boardgame.io/react';
import {
  CARDS, COLOR_META, COLORS, templateFor,
  type Color, type CardDef,
} from './cards';
import { ChainLogo } from './chain-logos';
import type { GState, Instance } from './Game';
import { mulliganDrawCount, MULLIGAN_FLOOR, MULLIGAN_INITIAL_HAND } from './Game';
import { getProfileApi, formatRecord, type Profile } from './profiles';
import { CardHover, CardPreview } from './CardPreview';
import { createPortal } from 'react-dom';
import { VoiceChat } from './Voice';
import { Haptics } from './haptics';

/** Voice chat is off until inbound callers are authenticated — see the mount site. */
const VOICE_CHAT_ENABLED = false;
import {
  ArrowDown, ArrowRight, Bolt, Cards, Chain, Chat as ChatIcon, Check, ChevronLeft, ChevronRight,
  Close, Diamond, Dot, Hand as HandIcon, Minus, Moon, Orb, Plus, Refresh, Robot, Scroll as ScrollIcon,
  Settings as SettingsIcon, Shield, Skull, Swords, Target, Warning,
} from './icons';
import './Board.css';

type Props = BoardProps<GState>;

/** Board palette — mirrors the obsidian/gold concept used across Board.css. */
const GOLD    = '#E5B84B';
const GOLD_HI = '#FFD86A';

/** Inline CSS custom properties (React types don't model `--x` keys). */
type Vars = React.CSSProperties & Record<string, string | number>;

/**
 * ── Board stacking order ────────────────────────────────────────────────────
 * ONE explicit ladder for everything the board paints. Read it before adding a
 * z-index anywhere in this file or in Board.css.
 *
 * Two rules make it work:
 *   1. The playmat root sets `isolation: isolate`, so MAT_* values only ever
 *      compete with each other — nothing inside the mat can escape it and
 *      nothing outside it needs to out-number a mat layer.
 *   2. Anything that creates a *new* stacking context (transform, filter,
 *      backdrop-filter, opacity < 1, perspective, will-change, contain,
 *      isolation) traps its children's z-index inside itself. Cards legitimately
 *      need `transform` (tapped cards rotate) and `filter`, so a card can never
 *      out-stack a *neighbouring* zone on its own — the ZONE is raised instead,
 *      via `.brd-zone:hover { z-index: 4 }` in Board.css.
 *
 * Values 0–9 are inside the mat; 10+ are page-level chrome.
 */
const LAYER = {
  /** Playmat photo. */
  MAT_ART: 0,
  /** Scrims, vignette, lane light, centre rule, watermark. */
  MAT_SCRIM: 1,
  /** Wrapper holding every zone / card / HUD element. */
  MAT_CONTENT: 2,
  /** Resting zone frame. */
  ZONE: 2,
  /** Zone containing the hovered card — lifts the whole zone, cards can't. */
  ZONE_RAISED: 4,
  /** Life orbs + count chips, above every zone. */
  HUD: 6,
  /** Drag ghost following the cursor. */
  DRAG_GHOST: 9998,
} as const;

/**
 * Combat pairing badge rendered over card art: SVG glyph + count in a flex row,
 * on an obsidian pill with a coloured hairline ring and a hard drop shadow so
 * it stays legible over any artwork.
 */
function CombatBadge({
  icon, count, tone, title,
}: { icon: React.ReactNode; count?: number; tone: string; title: string }) {
  return (
    <span
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 2,
        padding: count == null ? '1px 3px' : '1px 4px 1px 3px',
        borderRadius: 999,
        background: 'rgba(8,9,18,0.88)',
        boxShadow: `0 0 0 1px ${tone}aa, 0 1px 3px rgba(0,0,0,0.85)`,
        color: tone,
        lineHeight: 1,
        filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.9))',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center' }}>{icon}</span>
      {count != null && (
        <span style={{
          fontSize: 9, fontWeight: 900, fontFamily: 'system-ui, sans-serif',
          letterSpacing: 0, lineHeight: 1, position: 'relative', top: '0.5px',
        }}>{count}</span>
      )}
    </span>
  );
}

/** Attacker / blocked-by / aura badges shown in a mini-card's footer slot. */
function CombatBadges({
  attacking, blockedCount, auraCount,
}: { attacking?: boolean; blockedCount?: number; auraCount?: number }) {
  if (!attacking && !blockedCount && !auraCount) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {attacking && (
        <CombatBadge icon={<Swords size={11} />} tone={GOLD_HI} title="Attacking" />
      )}
      {!!blockedCount && (
        <CombatBadge icon={<Shield size={11} />} count={blockedCount} tone="#8FD3FF"
          title={`Blocked by ${blockedCount}`} />
      )}
      {!!auraCount && (
        <CombatBadge icon={<Orb size={11} />} count={auraCount} tone="#C45CFF"
          title={`${auraCount} aura(s) attached`} />
      )}
    </span>
  );
}

function useIsMobile(breakpoint = 720) {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.innerWidth <= breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = () => setM(mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [breakpoint]);
  return m;
}

/** Landscape-phone check — viewport too short for the full desktop chrome. */
function useIsShort(maxHeight = 450) {
  const [s, setS] = useState(() => typeof window !== 'undefined' && window.innerHeight <= maxHeight);
  useEffect(() => {
    const mq = window.matchMedia(`(max-height: ${maxHeight}px)`);
    const onChange = () => setS(mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, [maxHeight]);
  return s;
}

/**
 * Mobile-only zoom wrapper for the playmat. Renders zoom-out / reset / zoom-in.
 * When zoom > 1, the inner element scales up via width%; the outer container
 * gets overflow: auto so the user can flick around with native momentum.
 * Single-finger taps go straight through to cards underneath.
 */
function MobilePlaymatScaler({
  enabled, children,
}: { enabled: boolean; children: React.ReactNode }) {
  const [zoom, setZoom] = useState(1);
  if (!enabled) return <>{children}</>;
  const ZOOMS = [1, 1.5, 2, 2.5];
  const idx = ZOOMS.indexOf(zoom);
  const zoomIn  = () => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, idx) + 1)]);
  const zoomOut = () => setZoom(ZOOMS[Math.max(0, (idx >= 0 ? idx : 1) - 1)]);
  const reset   = () => setZoom(1);
  const scrolling = zoom > 1;
  return (
    <div style={{ position: 'relative' }}>
      <div className="brd-scroll" style={{
        overflow: scrolling ? 'auto' : 'visible',
        maxHeight: scrolling ? '70dvh' : 'none',
        WebkitOverflowScrolling: 'touch',
        overscrollBehavior: 'contain',
        borderRadius: 12,
        // Subtle frame so the zoomable region reads as a viewport.
        outline: scrolling ? '1px solid rgba(229,184,75,0.35)' : 'none',
      }}>
        <div style={{
          width: `${zoom * 100}%`,
          margin: scrolling ? 0 : '0 auto',
          transition: 'width 0.2s cubic-bezier(0.2,0.8,0.2,1)',
        }}>
          {children}
        </div>
      </div>
      {/* Zoom controls sit BELOW the mat, in normal flow: floating them over the
          top-right corner used to bury the opponent's deck / hand / graveyard
          zones on a 390px phone, making those cards untappable. */}
      <div style={{
        margin: '4px auto 0', width: 'fit-content', zIndex: 5,
        display: 'flex', gap: 8,
        background: 'linear-gradient(180deg, rgba(22,17,32,0.85), rgba(8,7,14,0.9))',
        padding: 5, borderRadius: 999,
        border: '1px solid rgba(229,184,75,0.4)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)',
        boxShadow: 'inset 0 1px 0 rgba(255,226,160,0.14), 0 4px 14px rgba(0,0,0,0.5)',
      }}>
        <button onClick={zoomOut} disabled={zoom <= ZOOMS[0]} className="brd-stud"
          aria-label="Zoom out" title="Zoom out"
          style={zoomBtnStyle()}><Minus size={19} /></button>
        <button onClick={reset} className="brd-stud"
          aria-label="Reset zoom" title="Reset zoom"
          style={{ ...zoomBtnStyle(), width: 'auto', minWidth: 56, padding: '0 12px', borderRadius: 999, fontSize: 12, fontFamily: '"Cinzel", "Times New Roman", serif' }}>
          {Math.round(zoom * 100)}%
        </button>
        <button onClick={zoomIn} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} className="brd-stud"
          aria-label="Zoom in" title="Zoom in"
          style={zoomBtnStyle()}><Plus size={19} /></button>
      </div>
    </div>
  );
}
function zoomBtnStyle(): React.CSSProperties {
  // Visual treatment lives in `.brd-stud` (bezelled metal stud); this only sizes it.
  // 44px keeps it at the minimum comfortable touch target.
  return { width: 44, height: 44, fontWeight: 800, fontSize: 18, lineHeight: 1 };
}

const COLOR_BAR: React.CSSProperties = { display: 'flex', gap: 6, fontSize: 12, marginTop: 4 };

function Pip({ c, n }: { c: Color | 'any'; n: number }) {
  if (!n) return null;
  const meta = c === 'any'
    ? { hex: '#c8c8d0', ink: '#1a1a1a' }
    : COLOR_META[c];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: 18, height: 18, borderRadius: 9,
      background: meta.hex, color: meta.ink,
      fontWeight: 700, fontSize: 11, border: '1px solid #0003',
    }}>{n}</span>
  );
}

function CostPips({ def }: { def: CardDef }) {
  if (!def.cost) return null;
  return (
    <div style={COLOR_BAR}>
      <Pip c="any" n={def.cost.any ?? 0} />
      {COLORS.map(c => <Pip key={c} c={c} n={def.cost?.[c] ?? 0} />)}
    </div>
  );
}

/**
 * Pointer-Events-based drag wrapper. The user grabs a card, drags it onto the
 * battlefield (any element with `data-dropzone="battlefield"`), and releases
 * to play it. Short taps that never cross the 10px threshold pass through to
 * the child's normal click handling (which on mobile means the tap-to-pin
 * lightbox in CardHover).
 *
 * Works for both touch and mouse via Pointer Events. `touch-action: none` on
 * the source stops the page from scrolling while the user drags.
 */
function DraggableCard({
  defId, onDrop, onCancel, onDragStateChange, children,
}: {
  defId: string;
  onDrop: () => void;
  onCancel?: () => void;
  onDragStateChange?: (dragging: boolean) => void;
  children: React.ReactNode;
}) {
  const [drag, setDrag] = useState<{ x: number; y: number; ok: boolean } | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const idRef = useRef<number | null>(null);

  function findDrop(x: number, y: number): Element | null {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('[data-dropzone="battlefield"]') : null;
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button && e.button !== 0) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    movedRef.current = false;
    idRef.current = e.pointerId;
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch {}
  }
  function onPointerMove(e: React.PointerEvent) {
    if (idRef.current !== e.pointerId || !startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    if (!movedRef.current && Math.hypot(dx, dy) > 10) {
      movedRef.current = true;
      Haptics.tap();
      onDragStateChange?.(true);
    }
    if (movedRef.current) {
      setDrag({ x: e.clientX, y: e.clientY, ok: !!findDrop(e.clientX, e.clientY) });
    }
  }
  function onPointerUp(e: React.PointerEvent) {
    if (idRef.current !== e.pointerId) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {}
    const moved = movedRef.current;
    setDrag(null);
    startRef.current = null; movedRef.current = false; idRef.current = null;
    if (!moved) return; // short tap: let normal click flow run
    onDragStateChange?.(false);
    const drop = findDrop(e.clientX, e.clientY);
    if (drop) { Haptics.play(); onDrop(); }
    else { Haptics.invalid(); onCancel?.(); }
  }
  function onPointerCancel(e: React.PointerEvent) {
    if (idRef.current !== e.pointerId) return;
    const wasMoved = movedRef.current;
    setDrag(null);
    startRef.current = null; movedRef.current = false; idRef.current = null;
    if (wasMoved) onDragStateChange?.(false);
    onCancel?.();
  }

  const def = CARDS[defId];

  return (
    <span
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onDragStart={(e) => e.preventDefault()}
      draggable={false}
      style={{
        touchAction: 'none',
        display: 'inline-block',
        opacity: drag ? 0.35 : 1,
        transition: drag ? 'none' : 'opacity 0.12s',
        WebkitTouchCallout: 'none',
        userSelect: 'none',
        ...({ WebkitUserDrag: 'none' } as React.CSSProperties),
      }}
    >
      {children}
      {drag && def && createPortal(
        <div style={{
          position: 'fixed', left: drag.x, top: drag.y,
          transform: 'translate(-50%, -50%) scale(0.55) rotate(-3deg)',
          pointerEvents: 'none', zIndex: 9998,
          filter: drag.ok
            ? 'drop-shadow(0 12px 24px rgba(108, 75, 216, 0.85))'
            : 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.6))',
        }}>
          <CardPreview def={def} />
        </div>,
        document.body
      )}
    </span>
  );
}

function CardFace({
  defId, instance, footer, onClick, selected, faceDown, pinOnTap, size,
}: {
  defId: string;
  instance?: Instance;
  footer?: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  faceDown?: boolean;
  pinOnTap?: boolean;
  /** Explicit box, in px. Used by the mobile hand strip, which has more room
   *  than the compact default and is the player's primary read of their hand. */
  size?: { w: number; h: number };
}) {
  const mobile = useIsMobile();
  const short = useIsShort();
  const compact = mobile || short; // phones portrait OR landscape
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
  // Layered rest shadow: contact shadow + cast shadow, so the card lifts off
  // the mat instead of sitting flat on it. `--shadow` is consumed by .brd-cardface.
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
        width: W, height: H, margin: 2, padding: tpl ? 0 : 5, borderRadius: 8,
        background: tpl ? undefined : meta.hex,
        backgroundImage: tpl ? `url(${tpl.url})` : undefined,
        backgroundSize: tpl ? '100% 100%' : undefined,
        backgroundRepeat: 'no-repeat',
        color: meta.ink,
        // Hairline frame: 1px ink edge; attacker/selected swaps in a gold ring.
        border: selected ? '2px solid #FFD86A' : '1px solid rgba(0,0,0,0.85)',
        cursor: onClick ? 'pointer' : 'default',
        opacity: dimmed && def.type === 'meme' ? 0.62 : 1,
        fontFamily: 'system-ui, sans-serif',
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        position: 'relative', flex: '0 0 auto',
      }}>
      {tpl ? <TemplatedCardFaceContent def={def} instance={instance} footer={footer} tpl={tpl} /> : <>
      <div style={{ fontWeight: 700, fontSize: 10, lineHeight: 1.05, position: 'relative', zIndex: 1 }}>{def.name}</div>
      <div style={{ fontSize: 8, opacity: 0.85, marginTop: 1, lineHeight: 1.1, position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: 3 }}>
        {def.type.toUpperCase()}
        {instance?.summoningSick && (
          <span title="Summoning sick — cannot attack this turn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: '#2a1f00', background: '#ffd76a', padding: '0 3px', borderRadius: 3, fontSize: 7, fontWeight: 800 }}>
            <Moon size={8} />SICK
          </span>
        )}
        {tapped && !instance?.summoningSick && (
          <span title="Tapped" style={{ display: 'inline-flex', alignItems: 'center', gap: 2, color: '#111', background: '#b9bcc8', padding: '0 3px', borderRadius: 3, fontSize: 7, fontWeight: 800 }}>
            <Refresh size={8} />TAPPED
          </span>
        )}
      </div>
      <div style={{ fontSize: 8, marginTop: 3, flex: 1, overflow: 'hidden', lineHeight: 1.15, position: 'relative', zIndex: 1 }}>{def.text}</div>
      {def.type === 'meme' && (
        <div style={{
          alignSelf: 'flex-end', fontWeight: 800, fontSize: 11, position: 'relative', zIndex: 1,
          padding: '0 5px', borderRadius: 4, color: '#F4F2EA',
          background: 'linear-gradient(180deg, rgba(20,16,10,0.85), rgba(8,6,4,0.9))',
          boxShadow: 'inset 0 0 0 1px rgba(229,184,75,0.45), 0 1px 2px rgba(0,0,0,0.6)',
        }}>
          {def.power}/{(def.toughness ?? 1) - (instance?.damage ?? 0)}
        </div>
      )}
      <div style={{ position: 'relative', zIndex: 1 }}><CostPips def={def} /></div>
      {footer && <div style={{ fontSize: 8, lineHeight: 1.1, position: 'relative', zIndex: 1 }}>{footer}</div>}
      </>}
      {damaged && <span aria-hidden className="brd-damaged" />}
      <span aria-hidden className="brd-gloss" />
    </div>
    </CardHover>
  );
}

/** Content placed inside a templated MTG-style frame (per-color via COLOR_META.template). */
function TemplatedCardFaceContent({ def, instance, footer, tpl }: { def: CardDef; instance?: Instance; footer?: React.ReactNode; tpl: { url: string; glyph?: string } }) {
  const meta = COLOR_META[def.color];
  return (
    <>
      {/* Name on the top grey bar */}
      <div style={{
        position: 'absolute', top: '5.6%', left: '9%', right: '9%', height: '5%',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 4, padding: '0 4px',
        fontSize: 8, fontWeight: 800, color: '#1a1a1a',
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{def.name}</span>
        {def.cost && (
          <span style={{ display: 'flex', gap: 1 }}>
            {(['any', ...COLORS] as const).map(c => {
              const n = def.cost?.[c] ?? 0; if (!n) return null;
              const cm = c === 'any' ? { hex: '#c8c8d0', ink: '#1a1a1a' } : COLOR_META[c];
              return (
                <span key={c} style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 10, height: 10, borderRadius: 5,
                  background: cm.hex, color: cm.ink,
                  fontWeight: 800, fontSize: 7,
                }}>{n}</span>
              );
            })}
          </span>
        )}
      </div>
      {/* Art zone — image sits inside the template's black window */}
      <div style={{
        position: 'absolute', top: '13%', left: '8.5%', right: '8.5%', height: '44%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {tpl.glyph && tpl.glyph !== meta.glyph ? (
          // Card-specific glyph override (MACHINE / AURA) — unchanged.
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
        {/* Status badges overlay on top-right of art */}
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
      {/* Type bar */}
      <div style={{
        position: 'absolute', top: '58.5%', left: '9%', right: '9%', height: '4.5%',
        display: 'flex', alignItems: 'center', padding: '0 4px',
        fontSize: 7, fontWeight: 700, color: '#1a1a1a',
        letterSpacing: 0.5, textTransform: 'uppercase',
      }}>
        {def.type}
      </div>
      {/* Rules text box */}
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

function GasBar({ gas }: { gas: Record<Color, number> }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <span style={{ fontSize: 12, opacity: 0.7 }}>Gas:</span>
      {COLORS.map(c => <Pip key={c} c={c} n={gas[c]} />)}
    </div>
  );
}

/**
 * Small secondary desktop action button — an obsidian forged plate.
 * Spread onto a <button> together with `className={DESK_BTN_CLASS} style={deskBtn()}` for sizing.
 */
const DESK_BTN_CLASS = 'brd-plate brd-plate--obsidian brd-plate--sm';
function deskBtn(): React.CSSProperties {
  return { padding: '8px 14px' };
}

export function ChainsBoard(props: Props) {
  const { G, ctx, moves, playerID, isActive, chatMessages, sendChatMessage, matchID, matchData } = props as Props & {
    matchID?: string;
    matchData?: Array<{ id: number; name?: string; isConnected?: boolean }>;
  };
  const mobile = useIsMobile();
  const short = useIsShort();
  const myId  = playerID ?? '0';
  const oppId = myId === '0' ? '1' : '0';
  const me   = G.players[myId];
  const opp  = G.players[oppId];

  const [selectedHand, setSelectedHand] = useState<number | null>(null);
  const [targetMode, setTargetMode] = useState<null | { kind: 'meme' | 'any' | 'machine' }>(null);
  // Mobile hand sheet. The hand itself is always visible as a strip under the
  // mat; this is the expanded grid view for browsing a large hand.
  const [handOpen, setHandOpen] = useState(false);
  // ACTION LOG + CHAT panel. Owned here (not inside MatchRail) because on
  // phones the trigger lives in MobileActionBar — a floating one covered the
  // hand strip. Starts closed on phones and landscape so it never hides the mat.
  const [railOpen, setRailOpen] = useState(() =>
    !(typeof window !== 'undefined' && (window.innerWidth <= 720 || window.innerHeight <= 450)));
  const chatCount = chatMessages?.length ?? 0;
  const [chatSeen, setChatSeen] = useState(0);
  useEffect(() => { if (railOpen) setChatSeen(chatCount); }, [railOpen, chatCount]);
  const chatUnread = Math.max(0, chatCount - chatSeen);

  const myTurn = ctx.currentPlayer === myId;
  const inBlockers = ctx.activePlayers?.[myId] === 'blockers';
  const pickPhase = !!me?.needsColorPick || !!opp?.needsColorPick;
  const iMustPick = !!me?.needsColorPick;
  const mulliganPhase = ctx.phase === 'mulligan';
  const myMulliganDone = !!G.mulligan?.done?.[myId];
  const oppMulliganDone = !!G.mulligan?.done?.[oppId];
  const myMulliganCount = G.mulligan?.counts?.[myId] ?? 0;

  // The colour-pick phase is dead in online play. `POST /games/create` and
  // `/join` seat both players with their validated ACTIVE decks and set
  // `colors: [null, null]`, so `needsColorPick` is never true in a server
  // match — and no deck can arrive from the client as a `chooseColor` argument
  // any more. The lobby used to stash `pendingCustomDeck` / `pendingPickColor`
  // in sessionStorage and replay it here; both are gone with the deck picker.
  //
  // The pick UI below still runs for LOCAL play (SoloClient, Masterquest),
  // where `setup` is baked client-side and a colour genuinely is chosen.

  // Auto-pass: after combat resolves on my turn, if I have no playable cards
  // in hand AND no untapped, non-sick memes that could still attack, end the
  // turn automatically. Honors target-selection mode so we never interrupt it.
  const wasBlockersRef = useRef(false);
  const autoPassedTurnRef = useRef<number | null>(null);
  useEffect(() => {
    if (pickPhase || !myTurn || ctx.gameover) return;
    const oppInBlockers = ctx.activePlayers?.[oppId] === 'blockers';
    if (oppInBlockers) { wasBlockersRef.current = true; return; }
    if (!wasBlockersRef.current) return;
    // Combat just resolved on my main phase.
    wasBlockersRef.current = false;
    if (autoPassedTurnRef.current === ctx.turn) return;
    if (selectedHand != null || targetMode != null) return;

    // Untapped, non-sick meme that could attack again?
    const hasReadyAttacker = me.memes.some(m => !m.tapped && !m.summoningSick);

    // Potential gas this turn = current pool + 1 of each untapped node's color.
    const avail: Record<Color, number> = { ...me.gas } as Record<Color, number>;
    for (const n of me.nodes) {
      if (!n.tapped) {
        const ndef = CARDS[n.defId];
        if (ndef) avail[ndef.color] = (avail[ndef.color] ?? 0) + 1;
      }
    }
    const extraNodes = me.machines.filter(mm => CARDS[mm.defId]?.effect === 'extra_node_per_turn').length;
    const nodesLeft = (1 + extraNodes) - me.nodesPlayedThisTurn;

    const canPlayAnything = me.hand.some(defId => {
      const def = CARDS[defId];
      if (!def) return false;
      if (def.type === 'node') return nodesLeft > 0;
      const cost = def.cost ?? {};
      // Colored requirement
      let leftover = 0;
      let okColored = true;
      for (const c of COLORS) {
        const need = cost[c] ?? 0;
        if (need > (avail[c] ?? 0)) { okColored = false; break; }
        leftover += (avail[c] ?? 0) - need;
      }
      if (!okColored) return false;
      return (cost.any ?? 0) <= leftover;
    });

    if (!canPlayAnything && !hasReadyAttacker) {
      autoPassedTurnRef.current = ctx.turn;
      const t = window.setTimeout(() => {
        // Re-check the latest state-derived predicates via closure-fresh values.
        moves.passTurn();
      }, 500);
      return () => window.clearTimeout(t);
    }
  }, [ctx.activePlayers, ctx.turn, ctx.gameover, myTurn, oppId, pickPhase, selectedHand, targetMode, me, moves]);

  // Auto-skip block phase: if I'm the defender in the blockers stage and I have
  // no untapped memes available to block, confirm-blocks immediately.
  const autoSkippedBlockTurnRef = useRef<number | null>(null);
  useEffect(() => {
    if (pickPhase || ctx.gameover) return;
    if (ctx.activePlayers?.[myId] !== 'blockers') return;
    if (autoSkippedBlockTurnRef.current === ctx.turn) return;
    const hasBlocker = me.memes.some(m => !m.tapped);
    if (hasBlocker) return;
    autoSkippedBlockTurnRef.current = ctx.turn;
    const t = window.setTimeout(() => moves.confirmBlocks(), 500);
    return () => window.clearTimeout(t);
  }, [ctx.activePlayers, ctx.turn, ctx.gameover, myId, pickPhase, me, moves]);

  function tryPlay(idx: number) {
    const defId = me.hand[idx];
    const def = CARDS[defId];
    if (!def) return;
    if (def.type === 'aura') {
      // Auras always target a meme.
      Haptics.tap();
      setSelectedHand(idx);
      setTargetMode({ kind: 'meme' });
      return;
    }
    if (def.type === 'move') {
      const needsTarget =
        def.effect === 'destroyMeme' || def.effect === 'bounceMeme' ||
        def.effect === 'destroyMachine' ||
        def.effect === 'damage2' || def.effect === 'damage3' || def.effect === 'damage5';
      if (needsTarget) {
        Haptics.tap();
        setSelectedHand(idx);
        const kind: 'meme' | 'any' | 'machine' =
          def.effect === 'destroyMachine' ? 'machine' :
          (def.effect === 'damage2' || def.effect === 'damage3' || def.effect === 'damage5') ? 'any' :
          'meme';
        setTargetMode({ kind });
        return;
      }
    }
    Haptics.play();
    moves.playCard(idx);
  }

  function pickTarget(uid: string) {
    if (selectedHand == null) return;
    Haptics.play();
    moves.playCard(selectedHand, uid);
    setSelectedHand(null);
    setTargetMode(null);
  }

  const [blockSel, setBlockSel] = useState<{ blockerUid?: string }>({});
  const [notice, setNotice] = useState<string>('');
  function flash(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice(n => (n === msg ? '' : n)), 2200);
  }

  // ── Profile names from lobby + W/L tracking via API ────────────────────────
  // Prefer lobby-supplied player names (online play). Fall back to in-game profileName (local play).
  const myName  = matchData?.find(p => String(p.id) === myId )?.name  || me.profileName  || `Player ${myId}`;
  const oppName = matchData?.find(p => String(p.id) === oppId)?.name  || opp.profileName || `Player ${oppId}`;

  const [myProfile,  setMyProfile]  = useState<Profile | null>(null);
  const [oppProfile, setOppProfile] = useState<Profile | null>(null);

  // Both records come from the PUBLIC profile route, which works signed out and
  // exposes no wallet address for either player.
  const refreshProfiles = React.useCallback(() => {
    getProfileApi(myName).then(setMyProfile).catch(() => {});
    getProfileApi(oppName).then(setOppProfile).catch(() => {});
  }, [myName, oppName]);
  useEffect(() => { refreshProfiles(); }, [refreshProfiles]);

  // ── On gameover ───────────────────────────────────────────────────────────
  //
  // THE CLIENT DOES NOT REPORT THE RESULT, and cannot.
  //
  // This used to `POST /api/result` with a winner, a loser, ranked metadata and
  // a wager payout instruction — from the browser, from BOTH clients, deduped
  // by match id. That is the hole this migration exists to close: whoever holds
  // the page can name themselves the winner of a staked match.
  //
  // There is now no endpoint anywhere that accepts a match result and no
  // request shape that can name a winner. The game service derives the outcome
  // from its own boardgame.io state, signs it with an HMAC shared only with the
  // wager service, and writes it itself; the settlement worker pays out from
  // those verified rows and from nothing else.
  //
  // What is left here is purely local: haptics, the daily-quest flag, and the
  // solo-mode event. After a short delay we re-read both profiles, because by
  // then the server has written the result and the W/L shown on the board
  // should reflect it.
  const isSolo = !!matchID && matchID.startsWith('solo-');
  const recordedRef = useRef(false);
  useEffect(() => {
    if (!ctx.gameover || recordedRef.current || !matchID) return;
    recordedRef.current = true;
    const draw = !!ctx.gameover.draw;
    const winnerId = ctx.gameover.winner as string | undefined;
    // Buzz for the result.
    if (draw) Haptics.turn();
    else if (winnerId === myId) Haptics.win();
    else Haptics.loss();
    // Real daily-quest tracker ("Win 1 match" on the main menu). Any win counts.
    if (!draw && winnerId === myId) {
      try { localStorage.setItem(`ocva.daily.${new Date().toISOString().slice(0, 10)}.win`, '1'); } catch { /* ignore */ }
    }
    if (isSolo) {
      // SoloClient handles solo result recording; broadcast a window event so
      // it can save the daily-best without us importing it (decouples Board).
      try {
        window.dispatchEvent(new CustomEvent('mmtcg:solo-end', {
          detail: { matchID, draw, winnerSeat: winnerId, turns: ctx.turn },
        }));
      } catch { /* swallow */ }
      return;
    }
    // Give the game service a moment to write the row, then re-read the W/L.
    const t = setTimeout(refreshProfiles, 2000);
    return () => clearTimeout(t);
  }, [ctx.gameover, matchID, myId, oppId, myName, oppName, isSolo, ctx.turn, refreshProfiles]);

  // ── Render ────────────────────────────────────────────────────────────────
  const [showRules, setShowRules] = useState(false);

  // Esc cancels a card/target selection; right-click cancels an active target pick.
  useEffect(() => {
    if (!targetMode && selectedHand == null) return;
    const cancel = () => { setSelectedHand(null); setTargetMode(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    const onCtx = (e: MouseEvent) => { if (targetMode) { e.preventDefault(); cancel(); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('contextmenu', onCtx);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('contextmenu', onCtx); };
  }, [targetMode, selectedHand]);

  return (
    <div className="brd" style={{
      fontFamily: 'system-ui, sans-serif', padding: mobile ? 6 : 8, color: '#eee', background: '#0a0a10',
      // One flex column, exactly one viewport tall, on BOTH form factors.
      // Mobile used to be `height: auto` + `minHeight: 100vh` with every child
      // at its natural size, so the leftover height piled up as a dead region
      // between the mat and the fixed action bar. Now the column is 100dvh and
      // exactly one child grows into the slack: the mat on desktop, the hand
      // strip on mobile.
      minHeight: '100dvh', height: '100dvh',
      display: 'flex', flexDirection: 'column',
      // Desktop used to be `overflow: hidden`, which silently amputated whatever
      // did not fit in 100dvh (see the Playmat comment below). The growing child
      // now absorbs the slack, and `auto` is the safety valve for the cases it
      // can't — content scrolls into reach instead of vanishing.
      overflowY: 'auto',
      // Never allow horizontal page scroll; on mobile also leave room for the
      // fixed bottom action bar (+ notch safe area) via paddingBottom below.
      overflowX: 'hidden',
      // No bottom reserve on mobile any more: MobileActionBar is sticky and
      // takes its own height at the end of the column.
      paddingBottom: mobile ? 0 : 8,
    }}>
      {/* Compact top status bar */}
      <TurnBanner
        myTurn={myTurn} turn={ctx.turn}
        phase={inBlockers ? 'block' : myTurn ? 'main' : 'wait'}
        myName={myName} oppName={oppName}
        myProfile={myProfile} oppProfile={oppProfile}
        onOpenRules={() => setShowRules(true)}
        onEndTurn={() => { Haptics.turn(); moves.passTurn(); }}
        canEndTurn={myTurn && !inBlockers && !ctx.gameover && !mulliganPhase}
        attackerCount={G.combat.attackers.length}
        onConfirmAttackers={() => { Haptics.attack(); moves.confirmAttackers(); }}
        canAttack={myTurn && !inBlockers && !ctx.gameover && !mulliganPhase}
        inBlockers={inBlockers}
        onConfirmBlocks={() => { Haptics.attack(); moves.confirmBlocks(); }}
        turnDeadline={G.turnDeadline ?? 0}
        canForceEnd={!myTurn && !ctx.gameover && ctx.phase === 'play'}
        onForceEnd={() => moves.forceEndTurn()}
      />

      {/* Selected-card targeting instruction. Desktop pins it under the banner;
          phones float it just above the action bar so it never covers the mat
          (legal targets pulse gold there) nor the action bar's CANCEL. */}
      {targetMode && (
        <div style={{
          position: 'fixed', zIndex: 120,
          ...(mobile
            ? { left: 10, right: 10, bottom: 'calc(78px + env(safe-area-inset-bottom))', justifyContent: 'center' }
            : { top: 64, left: '50%', transform: 'translateX(-50%)' }),
          display: 'flex', alignItems: 'center', gap: 12, padding: '8px 18px', borderRadius: 10,
          background: 'linear-gradient(180deg, rgba(22,16,44,0.94), rgba(10,10,22,0.94))',
          border: '1px solid #C45CFF', color: '#F4F2EA', fontWeight: 700, fontSize: 14,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), 0 0 26px rgba(196,92,255,0.45), 0 10px 26px rgba(0,0,0,0.6)',
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        }} role="status">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontFamily: '"Cinzel", "Times New Roman", serif', letterSpacing: 1.2 }}>
            <Target size={16} color="#C45CFF" />Choose a target
          </span>
          <button onClick={() => { setSelectedHand(null); setTargetMode(null); }}
            className="brd-glyph-btn"
            style={{ color: '#C45CFF', borderColor: 'rgba(196,92,255,0.5)', padding: '4px 10px', fontSize: 12, fontWeight: 700 }}>
            Cancel · Esc
          </button>
        </div>
      )}

      {/* Opponent connection status. */}
      {!isSolo && matchData && matchData.find(p => String(p.id) === oppId)?.isConnected === false && (
        <div role="status" style={{
          position: 'fixed', top: targetMode && !mobile ? 108 : 64, left: '50%', transform: 'translateX(-50%)', zIndex: 110,
          padding: '7px 16px', borderRadius: 10, background: 'rgba(228,95,118,0.14)', border: '1px solid #E45F76',
          color: '#ffc9d3', fontSize: 13, fontWeight: 700, boxShadow: '0 0 18px rgba(228,95,118,0.35)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: '#E45F76', animation: 'pulse-dot 1.2s ease-in-out infinite' }} />
          {oppName} disconnected — waiting to reconnect…
        </div>
      )}

      {/* Floating Rules drawer */}
      {showRules && <RulesDrawer onClose={() => setShowRules(false)} />}

      {/* Floating END TURN button — bottom-right of the viewport for fast
          thumb-reach on desktop. Mobile uses the dedicated MobileActionBar
          along the bottom instead. */}
      {!mobile && myTurn && !inBlockers && !ctx.gameover && !mulliganPhase && (
        <button
          onClick={() => { Haptics.turn(); moves.passTurn(); }}
          title="End your turn (Space)"
          className={`brd-plate brd-plate--gold ${short ? '' : 'brd-plate--lg'}`}
          style={{
            // Offset from the corner so the host app's bottom-right floating
            // control (sound toggle) never sits on top of the primary action.
            position: 'fixed', right: 'calc(72px + env(safe-area-inset-right))',
            bottom: 'max(18px, env(safe-area-inset-bottom))', zIndex: 90,
            padding: short ? '10px 18px' : undefined,
          }}
        >END TURN <ArrowRight size={15} /></button>
      )}

      {/* Pre-game mulligan overlay */}
      {mulliganPhase && !iMustPick && (
        <MulliganModal
          hand={me.hand}
          mulliganCount={myMulliganCount}
          done={myMulliganDone}
          oppDone={oppMulliganDone}
          deadline={G.mulligan?.deadline ?? 0}
          onKeep={() => moves.keepHand()}
          onMulligan={() => moves.mulligan()}
          onForceEnd={() => moves.forceKeepOpponent()}
        />
      )}

      {/* Solo: clear indicator when the bot is taking its turn so the
          user doesn't think the UI is frozen. */}
      {isSolo && !myTurn && !mulliganPhase && !ctx.gameover && (
        <div style={{
          position: 'fixed', left: '50%', transform: 'translateX(-50%)',
          // Phones: sit above the action bar. At top:70 it covered the turn
          // banner's second row (and the help button) on a 390px screen.
          ...(mobile
            ? { top: 'calc(98px + env(safe-area-inset-top))', whiteSpace: 'nowrap' as const }
            : { top: 70 }),
          zIndex: 150, padding: '8px 16px',
          background: 'rgba(76, 29, 149, 0.92)', color: '#fff',
          border: '1px solid #a78bfa', borderRadius: 999,
          fontFamily: '"Cinzel", "Times New Roman", serif', fontWeight: 700,
          fontSize: 13, letterSpacing: 1, textTransform: 'uppercase',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 0 18px rgba(167,139,250,0.55), 0 8px 20px rgba(0,0,0,0.5)',
          pointerEvents: 'none',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Robot size={15} /> Bot is thinking…
        </div>
      )}

      {/* Deck-pick overlay — second player picks here if they arrived without a stashed color */}
      {iMustPick && (
        <div style={{
          padding: 16, marginBottom: 10,
          background: 'linear-gradient(180deg, rgba(26,18,64,0.92), rgba(10,10,30,0.92))',
          border: '1px solid #4c1d95', borderRadius: 10,
          boxShadow: '0 0 14px rgba(139,92,246,0.25)',
          fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
          color: '#ece1c7',
        }}>
          <div style={{
            fontFamily: '"Cinzel", "Times New Roman", serif',
            fontWeight: 800, fontSize: 14, letterSpacing: 2,
            color: '#f0b32a', textTransform: 'uppercase',
            textShadow: '0 0 8px rgba(240,179,42,0.35)',
            marginBottom: 6,
          }}>Choose your deck</div>
          <div style={{ fontSize: 12, color: '#cdbf99', marginBottom: 10 }}>
            The match has begun. Pick a chain to play with — your deck will be shuffled and dealt.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {COLORS.map(c => {
              const meta = COLOR_META[c];
              return (
                <button key={c} onClick={() => moves.chooseColor(c)} className="brd-plate" style={{
                  ...({
                    '--plate-bg': `linear-gradient(180deg, ${meta.hex} 0%, ${meta.hex} 42%, rgba(0,0,0,0.42) 100%)`,
                    '--plate-ink': meta.ink,
                    '--plate-hairline': 'rgba(229,184,75,0.45)',
                    '--plate-glow': 'rgba(255,216,106,0.55)',
                    '--plate-textshadow': '0 1px 1px rgba(0,0,0,0.35)',
                  } as Vars),
                  padding: '11px 18px', fontSize: 13,
                }}>
                  {/* Decorative — the chain name is the button's own label. */}
                  <ChainLogo color={c} size={18} />
                  {meta.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Waiting banner — opponent hasn't picked yet */}
      {!iMustPick && opp?.needsColorPick && (
        <div style={{
          padding: '8px 14px', marginBottom: 10, fontSize: 13,
          fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
          background: 'linear-gradient(180deg, rgba(26,18,64,0.92), rgba(10,10,30,0.92))',
          border: '1px solid #4c1d95', borderRadius: 10, color: '#ece1c7',
          boxShadow: '0 0 14px rgba(139,92,246,0.25)',
        }}>
          Waiting for opponent to choose their deck…
        </div>
      )}

      {/* Step instructions. Phones get a single short line: the full prose ran
          to two or three lines at 390px and that is premium vertical space the
          hand needs. The long form stays on desktop and in the `title`. */}
      {!ctx.gameover && !pickPhase && (
        <div style={{
          flex: '0 0 auto',
          padding: mobile ? '5px 10px' : '8px 14px', marginBottom: mobile ? 4 : 6,
          fontSize: mobile ? 12 : 13,
          lineHeight: mobile ? 1.25 : undefined,
          whiteSpace: mobile ? 'nowrap' : undefined,
          overflow: mobile ? 'hidden' : undefined,
          textOverflow: mobile ? 'ellipsis' : undefined,
          fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
          background: inBlockers
            ? 'linear-gradient(180deg, rgba(64,40,8,0.92), rgba(28,16,4,0.92))'
            : (myTurn
                ? 'linear-gradient(180deg, rgba(26,18,64,0.92), rgba(10,10,30,0.92))'
                : 'linear-gradient(180deg, rgba(20,20,28,0.92), rgba(10,10,16,0.92))'),
          border: `1px solid ${inBlockers ? '#a8740f' : (myTurn ? '#4c1d95' : '#2a2a36')}`,
          borderRadius: 10,
          color: '#ece1c7',
          transition: 'border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease',
          boxShadow: inBlockers
            ? '0 0 14px rgba(240,179,42,0.25)'
            : (myTurn ? '0 0 14px rgba(139,92,246,0.25)' : 'none'),
        }}>
          {inBlockers
            ? (mobile
                ? <><CTA color="#f0b32a">Blockers:</CTA> tap yours, then an attacker.</>
                : <><CTA color="#f0b32a">Declare blockers:</CTA> click an untapped meme below to select it, then click an attacking opponent meme above. Press <i>Confirm Blocks</i> when done (or with no blockers to take damage).</>)
            : myTurn
              ? (G.combat.attackers.length > 0
                  ? (mobile
                      ? <><CTA color="#f0b32a">{G.combat.attackers.length} attacker(s).</CTA> Tap more, or press Attack.</>
                      : <><CTA color="#f0b32a">{G.combat.attackers.length} attacker(s) selected.</CTA> Click another untapped meme to add, or press <i>Attack with {G.combat.attackers.length} meme(s)</i> to swing.</>)
                  : (mobile
                      ? <><CTA color="#b896ff">Your main phase.</CTA> Play nodes, tap for gas, cast.</>
                      : <><CTA color="#b896ff">Your main phase.</CTA> Play nodes, tap them for gas, cast cards. Click an untapped, non-sick meme to mark it as an attacker, then press <i>Attack</i>.</>))
              : <>Waiting for opponent…</>}
        </div>
      )}

      {notice && (
        <div role="status" style={{ padding: '7px 12px', marginBottom: 6, fontSize: 12, background: 'rgba(228,95,118,0.14)', border: '1px solid rgba(228,95,118,0.55)', borderRadius: 8, color: '#ffc9d3' }}>
          {notice}
        </div>
      )}

      {ctx.gameover && (
        <div style={{
          padding: 12, marginBottom: 8, borderRadius: 10,
          background: 'linear-gradient(180deg, rgba(26,18,64,0.92), rgba(10,10,30,0.92))',
          border: '1px solid rgba(229,184,75,0.45)',
          boxShadow: '0 0 18px rgba(229,184,75,0.2)',
        }}>
          {ctx.gameover.draw
            ? <b>Draw! Both records +1 D.</b>
            : <b>Winner: {ctx.gameover.winner === myId ? myName : oppName} — {ctx.gameover.winner === myId ? 'you got +1 W' : 'you got +1 L'}</b>}
        </div>
      )}

      <WagerPayoutModal
        gameover={ctx.gameover}
        wager={G.wager}
        myId={myId}
        myName={myName} oppName={oppName}
      />

      <WinnerShareModal
        gameover={ctx.gameover}
        myId={myId}
        myName={myName}
      />

      {/* Combat zone display */}
      <CombatStrip G={G} ctx={ctx} myId={myId} />

      {/* Playmat.
          Desktop: the board root is a 100dvh flex column with `overflow: hidden`,
          so the mat MUST NOT be sized by a guessed constant — the old
          `calc(100dvh - 280px)` under-reserved the chrome by ~200px and the
          bottom of the page (most of the hand fan, the whole action row and the
          log) was silently clipped away. Cards genuinely disappeared "behind the
          board". Now the mat is the flex-grow item: it takes exactly the height
          left over by the banner, hand and action row, and derives its width
          from that (it is square), so the stack can never overflow again.
          Mobile keeps the width-driven mat inside MobilePlaymatScaler. */}
      <div style={{
        margin: short ? '4px auto' : '6px auto',
        width: '100%',
        ...(mobile ? { flex: '0 0 auto' } : {
          flex: '1 1 auto',
          // Floor: on a very short viewport the mat stops shrinking and `.brd`
          // scrolls instead, rather than collapsing the arena to nothing.
          minHeight: short ? 240 : 320,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'stretch',
          maxWidth: 'min(1280px, 100%)',
        }),
      }}>
        <div data-dropzone="battlefield" style={mobile ? undefined : { height: '100%', aspectRatio: '1 / 1', maxWidth: '100%' }}>
        <MobilePlaymatScaler enabled={mobile}>
        <Playmat
        me={me} opp={opp} myId={myId} oppId={oppId}
        myName={myName} oppName={oppName}
        myDeckCount={(G as any).deckCounts?.[myId]  ?? 0}
        oppDeckCount={(G as any).deckCounts?.[oppId] ?? 0}
        attackers={G.combat.attackers.map(a => a.memeUid)}
        attackerSide={ctx.currentPlayer === myId ? 'me' : 'opp'}
        blocks={G.combat.blocks}
        selectedBlocker={blockSel.blockerUid}
        memeTargetable={targetMode?.kind === 'meme' || targetMode?.kind === 'any'}
        machineTargetable={targetMode?.kind === 'machine'}
        playerTargetable={targetMode?.kind === 'any'}
        onOppPlayerClick={() => pickTarget(oppId === '0' ? '__p0__' : '__p1__')}
        onMyPlayerClick={()  => pickTarget(myId  === '0' ? '__p0__' : '__p1__')}
        onNodeClick={uid => isActive && myTurn && !inBlockers && moves.tapNode(uid)}
        onMyMemeClick={uid => {
          if (targetMode?.kind === 'meme' || targetMode?.kind === 'any') pickTarget(uid);
          else if (inBlockers) {
            const m = me.memes.find(x => x.uid === uid); if (!m) return;
            if (m.tapped) { flash(`That meme is tapped — can't block.`); return; }
            setBlockSel({ blockerUid: uid });
          } else if (myTurn) {
            const m = me.memes.find(x => x.uid === uid); if (!m) return;
            if (m.summoningSick) { flash(`${CARDS[m.defId].name} is summoning sick — can't attack until your next turn.`); return; }
            if (m.tapped)        { flash(`${CARDS[m.defId].name} is tapped — can't attack.`); return; }
            moves.declareAttacker(uid);
          }
        }}
        onOppMemeClick={uid => {
          if (targetMode?.kind === 'meme' || targetMode?.kind === 'any') { pickTarget(uid); return; }
          if (inBlockers) {
            // Assigning a block: must have a blocker selected and the clicked
            // opponent meme must actually be an attacker.
            if (!blockSel.blockerUid) { flash('Click one of your untapped memes first to select a blocker.'); return; }
            if (!G.combat.attackers.some(a => a.memeUid === uid)) { flash('That opponent meme is not attacking — pick one of the attackers above.'); return; }
            moves.declareBlocker(blockSel.blockerUid, uid);
            setBlockSel({});
          }
        }}
        onMachineClick={uid => { if (targetMode?.kind === 'machine') pickTarget(uid); }}
      />
      </MobilePlaymatScaler>
      </div>
      </div>

      {/* Hand on phones — a real, always-visible strip directly under the mat.
          It used to be reachable only through the HAND button in the bottom bar,
          which meant the player's own cards were invisible while the space under
          the mat sat empty. The strip is the flex-GROW item on mobile, so it also
          absorbs whatever height is left over: no dead region can reappear below
          it. The bottom sheet is still there as the expanded/grid view. */}
      {mobile && (
        <div style={{
          flex: '1 1 auto', minHeight: 216,
          display: 'flex', flexDirection: 'column', marginTop: 4,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 8, padding: '0 2px 3px',
          }}>
            <span className="brd-zone-label" style={{
              fontSize: 11, color: 'rgba(229,184,75,0.82)',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              textShadow: '0 1px 3px rgba(0,0,0,0.85)',
            }}>
              <HandIcon size={12} /> Hand · {me.hand.length}
            </span>
            <button
              onClick={() => setHandOpen(true)}
              className="brd-glyph-btn"
              aria-label="Expand hand"
              title="Expand hand — full grid view"
              style={{ minHeight: 44, minWidth: 44, padding: '4px 12px', fontSize: 10, letterSpacing: 1.4, fontWeight: 800 }}
            >EXPAND</button>
          </div>
          <div className="brd-scroll" style={{
            flex: '1 1 auto', minHeight: 0,
            display: 'flex', flexWrap: 'nowrap', gap: 4,
            alignItems: 'center',
            justifyContent: me.hand.length > 3 ? 'flex-start' : 'center',
            overflowX: 'auto', overflowY: 'hidden',
            WebkitOverflowScrolling: 'touch',
            overscrollBehavior: 'contain',
            padding: '4px 4px 6px',
            // A sunken tray, so any slack around the cards reads as the hand's
            // housing rather than as an empty gap in the page.
            borderRadius: 10,
            border: '1px solid rgba(229,184,75,0.20)',
            background: 'linear-gradient(180deg, rgba(8,7,16,0.75), rgba(4,4,10,0.85))',
            boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.8), inset 0 -1px 0 rgba(255,226,160,0.07)',
          }}>
            {me.hand.length === 0
              ? <span style={{ fontSize: 12, color: '#7b7f95', margin: '0 auto' }}>No cards in hand.</span>
              : me.hand.map((id, i) => (
                <div key={i} style={{ flex: '0 0 auto' }}>
                  <DraggableCard
                    defId={id}
                    onDrop={() => isActive && myTurn && !inBlockers && tryPlay(i)}
                  >
                    <CardFace
                      defId={id}
                      selected={selectedHand === i}
                      pinOnTap
                      size={{ w: 110, h: 160 }}
                      onClick={() => isActive && myTurn && !inBlockers && tryPlay(i)}
                    />
                  </DraggableCard>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Hand — curved fan layout on desktop */}
      {!mobile && (
        <div style={{ marginTop: short ? 4 : 6, flex: '0 0 auto' }}>
          <div className="brd-zone-label" style={{
            fontSize: 11, color: 'rgba(229,184,75,0.78)', marginBottom: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            textShadow: '0 1px 3px rgba(0,0,0,0.8)',
          }}>
            <Diamond size={7} color="rgba(229,184,75,0.55)" />
            <HandIcon size={12} />
            <span>Hand · {me.hand.length}</span>
            <Diamond size={7} color="rgba(229,184,75,0.55)" />
          </div>
          <div className="brd-scroll" style={{
            display: 'flex', flexWrap: 'nowrap',
            overflowX: 'auto', overflowY: 'visible',
            WebkitOverflowScrolling: 'touch',
            paddingBottom: 4,
            justifyContent: 'center', alignItems: 'flex-end',
            minHeight: short ? 120 : 176,
            perspective: 1400,
          }}>
            {me.hand.map((id, i) => {
              const n = me.hand.length;
              const mid = (n - 1) / 2;
              const t = n === 1 ? 0 : (i - mid) / Math.max(1, mid); // -1 (left) .. 1 (right)
              const rot = t * 10;                                   // fan spread
              // Arc: the centre card RISES, the edges sit on the baseline. The
              // curve used to be `t*t*24` (edges pushed *down*), which is the
              // same shape but overflowed the row's box and hung the outer
              // cards over the action bar below. Rising is free — the fan
              // paints above the mat, and there is nothing to collide with.
              const arc = -(24 - t * t * 24);                       // -24 at centre, 0 at the edges
              const overlap = n > 7 ? -34 : n > 5 ? -26 : -18;      // tighten for larger hands
              const rest = `translateY(${arc}px) rotate(${rot}deg)`;
              return (
                <div key={i} className="brd-fan" style={{
                  ...({ '--rest': rest, '--z': selectedHand === i ? 20 : i } as Vars),
                  transformOrigin: '50% 130%',
                  marginLeft: i === 0 ? 0 : overlap,
                  flex: '0 0 auto',
                }}>
                  <DraggableCard
                    defId={id}
                    onDrop={() => isActive && myTurn && !inBlockers && tryPlay(i)}
                  >
                    <CardFace
                      defId={id}
                      selected={selectedHand === i}
                      pinOnTap
                      onClick={() => isActive && myTurn && !inBlockers && tryPlay(i)}
                    />
                  </DraggableCard>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Mobile bottom action bar + hand drawer trigger */}
      {mobile && (
        <MobileActionBar
          gas={me.gas}
          handCount={me.hand.length}
          onOpenHand={() => setHandOpen(true)}
          attackerCount={G.combat.attackers.length}
          canAttack={myTurn && !inBlockers && !ctx.gameover && !mulliganPhase && G.combat.attackers.length > 0}
          onAttack={() => { Haptics.attack(); moves.confirmAttackers(); }}
          canEndTurn={myTurn && !inBlockers && !ctx.gameover && !mulliganPhase}
          onEndTurn={() => { Haptics.turn(); moves.passTurn(); }}
          inBlockers={inBlockers}
          onConfirmBlocks={() => { Haptics.attack(); moves.confirmBlocks(); }}
          targetMode={!!targetMode}
          onCancelTarget={() => { setSelectedHand(null); setTargetMode(null); }}
          onOpenRules={() => setShowRules(true)}
          onOpenLog={() => setRailOpen(true)}
          logUnread={chatUnread}
        />
      )}
      {mobile && handOpen && (
        <MobileHandSheet
          hand={me.hand}
          selectedIdx={selectedHand}
          canPlay={isActive && myTurn && !inBlockers && !mulliganPhase}
          onClose={() => setHandOpen(false)}
          onPlay={(i) => { tryPlay(i); setHandOpen(false); }}
        />
      )}

      {/* Action bar (desktop) — mobile uses the sticky bottom bar above */}
      {!mobile && (
      <div style={{ marginTop: 6, flex: '0 0 auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <GasBar gas={me.gas} />
        {myTurn && !inBlockers && (
          <>
            <button onClick={() => moves.confirmAttackers()} disabled={G.combat.attackers.length === 0}
              className={`brd-plate brd-plate--sm ${G.combat.attackers.length > 0 ? 'brd-plate--crimson' : 'brd-plate--obsidian'}`}
              style={deskBtn()}>
              <Swords size={13} /> Attack with {G.combat.attackers.length} meme(s)
            </button>
            <button onClick={() => moves.passTurn()} className="brd-plate brd-plate--gold brd-plate--sm" style={deskBtn()}>End Turn</button>
          </>
        )}
        {inBlockers && (
          <>
            <button onClick={() => moves.confirmBlocks()} className="brd-plate brd-plate--steel brd-plate--sm" style={deskBtn()}>
              <Shield size={13} /> Confirm Blocks
            </button>
            <span style={{ fontSize: 12 }}>
              {blockSel.blockerUid
                ? `Blocker selected (${blockSel.blockerUid}). Click an attacking opponent meme above to assign it.`
                : 'Click one of your untapped memes to block.'}
            </span>
          </>
        )}
        {targetMode && (
          <button onClick={() => { setSelectedHand(null); setTargetMode(null); }} className={DESK_BTN_CLASS} style={deskBtn()}>Cancel target</button>
        )}
      </div>
      )}

      {/* Block assignment row */}
      {inBlockers && blockSel.blockerUid && (
        <div style={{
          marginTop: 8, padding: 10, borderRadius: 10,
          border: '1px dashed rgba(229,184,75,0.5)', background: 'rgba(18,18,31,0.75)',
        }}>
          <div style={{ fontSize: 12, marginBottom: 6 }}>Assign blocker {blockSel.blockerUid} to attacker:</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {G.combat.attackers.map(a => (
              <button key={a.memeUid} className={DESK_BTN_CLASS} style={deskBtn()} onClick={() => {
                moves.declareBlocker(blockSel.blockerUid!, a.memeUid);
                setBlockSel({});
              }}>{a.memeUid}</button>
            ))}
          </div>
        </div>
      )}

      {/* ACTION LOG + CHAT. One component on both form factors: a collapsible
          right rail on desktop, a drawer above the action bar on phones. The
          bare `<details>Log (n)</details>` that used to sit in the mobile flow
          is gone — it was default-styled, took a full row of the board, and
          duplicated this panel. */}
      <MatchRail entries={G.log} myId={myId} messages={chatMessages ?? []} sendChatMessage={sendChatMessage}
        open={railOpen} onOpenChange={setRailOpen} />

      {/* Proximity voice with your opponent (PeerJS WebRTC). Skipped in solo.
          DISABLED (security audit H-6): peer ids are derived from the public
          matchID and the inbound handler answers ANY caller with a live mic
          stream on the public PeerJS broker, so anyone who can read a match id
          off the lobby can open a player's microphone. Do not re-enable until
          inbound callers are authenticated against the match roster. */}
      {VOICE_CHAT_ENABLED && matchID && playerID && !isSolo && (
        <VoiceChat matchID={matchID} playerID={playerID} displayName={myName} />
      )}
    </div>
  );
}

/**
 * Unified ACTION LOG + CHAT surface.
 *  · desktop — a collapsible right rail with its own edge tab.
 *  · phones  — the same panel as a drawer above the action bar. Its trigger
 *    lives IN the action bar (see MobileActionBar): a floating stud sat on top
 *    of the hand strip. This is also where the action log lives on phones now;
 *    it used to be a bare, default-styled `<details>Log (n)</details>` loose in
 *    the board's flow, which is what the owner saw in their screenshot.
 *
 * `open` is owned by ChainsBoard so the action bar can drive it.
 */
function MatchRail({ entries, myId, messages, sendChatMessage, open, onOpenChange }: {
  entries: string[]; myId: string;
  messages: Array<{ id: string; sender: string; payload: any }>;
  sendChatMessage?: (msg: any) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const short = useIsShort();
  const mobile = useIsMobile();
  const [tab, setTab] = useState<'log' | 'chat'>('log');
  const collapsed = !open;
  const setCollapsed = (c: boolean) => onOpenChange(!c);
  const [draft, setDraft] = useState('');
  const [lastSeen, setLastSeen] = useState(0);
  const logRef = React.useRef<HTMLDivElement>(null);
  const chatRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => { if (tab === 'log' && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [entries.length, tab]);
  useEffect(() => {
    if (tab === 'chat' && !collapsed) {
      if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
      setLastSeen(messages.length);
    }
  }, [messages.length, tab, collapsed]);
  const unread = Math.max(0, messages.length - lastSeen);

  function colorFor(line: string): string {
    if (line.startsWith('— Turn')) return '#C45CFF';
    if (/attack|damage|destroyed|kills/i.test(line)) return '#E45F76';
    if (/draws|gains|heals/i.test(line)) return '#39E879';
    if (/mulligan|keeps/i.test(line)) return '#FFD86A';
    return '#cdd2e2';
  }
  function send() { const t = draft.trim(); if (!t || !sendChatMessage) return; sendChatMessage({ text: t }); setDraft(''); }

  if (collapsed) {
    // Phones: no floating trigger — MobileActionBar owns it.
    if (mobile) return null;
    return (
      <button onClick={() => setCollapsed(false)} aria-label="Expand match rail" title="Expand rail" className="brd-tab" style={{
        position: 'fixed', top: short ? 56 : 80, right: 0, zIndex: 60, width: 34, height: 84, borderRadius: '10px 0 0 10px',
        background: 'linear-gradient(180deg, rgba(24,19,36,0.94), rgba(10,9,18,0.94))',
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        border: `1px solid ${GOLD}55`, borderRight: 'none', color: GOLD, cursor: 'pointer',
        boxShadow: 'inset 1px 0 0 rgba(255,226,160,0.12), -6px 0 18px rgba(0,0,0,0.5)',
        display: 'grid', placeItems: 'center',
      }}>
        <ChevronLeft size={16} />
        {unread > 0 && <span style={{ position: 'absolute', top: 6, right: 6, background: '#E45F76', color: '#fff', fontSize: 9, fontWeight: 800, borderRadius: 8, minWidth: 16, height: 16, display: 'grid', placeItems: 'center', padding: '0 4px' }}>{unread > 9 ? '9+' : unread}</span>}
      </button>
    );
  }
  const tabBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '11px 8px', cursor: 'pointer', border: 'none',
    background: active
      ? 'linear-gradient(180deg, rgba(229,184,75,0.13), rgba(229,184,75,0))'
      : 'none',
    fontFamily: '"Cinzel", "Times New Roman", serif', fontWeight: 800, fontSize: 11.5, letterSpacing: 1.8,
    color: active ? GOLD_HI : '#989BB0',
    textShadow: active ? '0 0 10px rgba(229,184,75,0.45)' : 'none',
    borderBottom: `2px solid ${active ? GOLD : 'transparent'}`,
  });
  return (
    <div className="brd-panel" style={{
      position: 'fixed', zIndex: mobile ? 90 : 60,
      // Phones: a drawer that sits above the fixed action bar. Desktop: right rail.
      ...(mobile
        ? {
            left: 8, right: 8,
            bottom: 'calc(76px + env(safe-area-inset-bottom))',
            height: 'min(44dvh, 340px)',
            maxWidth: 'none',
          }
        : {
            top: short ? 56 : 80, right: short ? 8 : 16, bottom: short ? 64 : 100,
            width: short ? 240 : 300, maxWidth: 'calc(100vw - 24px)',
          }),
      // Dark parchment: warm-black gradient under an engraved gold hairline.
      background: 'linear-gradient(180deg, rgba(24,19,34,0.93) 0%, rgba(13,11,21,0.94) 45%, rgba(8,7,14,0.95) 100%)',
      border: `1px solid ${GOLD}44`, borderRadius: 12,
      backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: `1px solid ${GOLD}2e`, background: 'rgba(0,0,0,0.28)' }}>
        <button onClick={() => setTab('log')} className="brd-tab" style={tabBtn(tab === 'log')}>ACTION LOG</button>
        <button onClick={() => { setTab('chat'); setLastSeen(messages.length); }} className="brd-tab" style={tabBtn(tab === 'chat')}>
          CHAT{unread > 0 && tab !== 'chat' && <span style={{ marginLeft: 6, background: '#E45F76', color: '#fff', fontSize: 9, borderRadius: 8, padding: '1px 5px' }}>{unread > 9 ? '9+' : unread}</span>}
        </button>
        <button onClick={() => setCollapsed(true)} aria-label={mobile ? 'Close panel' : 'Collapse rail'} title={mobile ? 'Close' : 'Collapse'} className="brd-glyph-btn"
          style={{ border: 'none', padding: mobile ? '0 14px' : '0 12px', height: mobile ? 44 : 34, minWidth: mobile ? 44 : undefined }}>
          {mobile ? <Close size={18} /> : <ChevronRight size={16} />}
        </button>
      </div>
      {tab === 'log' ? (
        <div ref={logRef} className="brd-scroll" style={{ flex: 1, overflow: 'auto', padding: '10px 12px', fontSize: 12, lineHeight: 1.55, fontFamily: 'system-ui' }}>
          {entries.length === 0
            ? <div style={{ opacity: 0.4 }}>(No actions yet)</div>
            : entries.slice(-200).map((line, i) => {
                const isTurn = line.startsWith('— Turn');
                return (
                  <div key={i} style={{
                    color: colorFor(line), wordBreak: 'break-word',
                    marginBottom: isTurn ? 6 : 3, marginTop: isTurn ? 8 : 0,
                    paddingLeft: isTurn ? 0 : 8,
                    borderLeft: isTurn ? 'none' : '1px solid rgba(229,184,75,0.14)',
                    fontFamily: isTurn ? '"Cinzel", "Times New Roman", serif' : undefined,
                    fontWeight: isTurn ? 800 : 400,
                    letterSpacing: isTurn ? 1.1 : 0,
                    fontSize: isTurn ? 11 : 12,
                    textTransform: isTurn ? 'uppercase' : undefined,
                  }}>{line}</div>
                );
              })}
        </div>
      ) : (
        <>
          <div ref={chatRef} className="brd-scroll" style={{ flex: 1, overflow: 'auto', padding: '10px 12px', fontSize: 12, fontFamily: 'system-ui' }}>
            {messages.length === 0 && <div style={{ color: '#6b7387', fontStyle: 'italic' }}>No messages yet.</div>}
            {messages.map(m => {
              const mine = m.sender === myId;
              const text = typeof m.payload === 'string' ? m.payload : (m.payload && typeof m.payload.text === 'string' ? m.payload.text : JSON.stringify(m.payload));
              return (
                <div key={m.id} style={{ marginBottom: 8, lineHeight: 1.5 }}>
                  <div style={{
                    fontSize: 9.5, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
                    color: mine ? '#39E879' : '#7fb3ff', marginBottom: 1,
                  }}>P{m.sender}{mine ? ' (you)' : ''}</div>
                  <div style={{ color: '#F4F2EA' }}>{text}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: `1px solid ${GOLD}2e`, background: 'rgba(0,0,0,0.25)' }}>
            <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(); }}
              placeholder={sendChatMessage ? 'Message…' : 'Chat unavailable'} disabled={!sendChatMessage} aria-label="Chat message"
              style={{
                flex: 1, minWidth: 0, padding: '8px 10px', color: '#F4F2EA',
                background: 'linear-gradient(180deg, #070A14, #0C1120)',
                border: `1px solid ${GOLD}33`, borderRadius: 8, fontSize: 12,
                boxShadow: 'inset 0 2px 5px rgba(0,0,0,0.6)',
              }} />
            <button onClick={send} disabled={!sendChatMessage || !draft.trim()}
              className="brd-plate brd-plate--gold brd-plate--sm" style={{ padding: '8px 14px' }}>Send</button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Shown when a STAKED match ends.
 *
 * This used to render the winner's wallet address with a "Copy" button and
 * tell the loser to send them the money — a hand-settled wager dressed up as a
 * payout screen. Two things killed it:
 *
 *   • No profile route returns another player's wallet address any more. Only
 *     `GET /api/profiles/me` carries one, and only to its owner. There is
 *     deliberately no address-to-profile lookup either.
 *   • Settlement is not the players' job. The game service writes the verified
 *     result and a background worker decides the payout from it. There is no
 *     settlement endpoint for anyone to call — client or otherwise.
 *
 * So this is now an outcome notice, not an instruction. Note the client cannot
 * currently create a staked match at all (see `WagerControls` in App.tsx); this
 * survives for matches created elsewhere.
 */
function WagerPayoutModal({
  gameover, wager, myId, myName, oppName,
}: {
  gameover: any;
  wager: GState['wager'];
  myId: string;
  myName: string; oppName: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(false); }, [gameover?.winner, gameover?.draw]);
  if (!gameover || !wager || wager.kind !== 'master' || !wager.amount) return null;
  if (gameover.draw) return null;
  if (dismissed) return null;

  const iWon = gameover.winner === myId;
  const winnerName = iWon ? myName : oppName;
  const amount = wager.amount;

  return (
    <div onClick={() => setDismissed(true)} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200,
      fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'linear-gradient(180deg, #1a1240 0%, #0a0a1e 100%)',
        border: '2px solid #4c1d95', borderRadius: 10,
        padding: 24, width: 'min(520px, calc(100vw - 24px))',
        boxShadow: '0 0 40px rgba(139,92,246,0.45)',
        color: '#ece1c7',
      }}>
        <div style={{
          fontFamily: '"Cinzel", "Times New Roman", serif',
          fontSize: 20, fontWeight: 800, letterSpacing: 2,
          color: '#f0b32a', textTransform: 'uppercase',
          textShadow: '0 0 14px rgba(240,179,42,0.45)',
          textAlign: 'center', marginBottom: 4,
        }}>
          {iWon ? 'Victory' : 'Defeat'}
        </div>
        <div style={{ textAlign: 'center', color: '#b896ff', fontSize: 13, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 16 }}>
          Staked Match{amount ? ` · ${amount}` : ''}
        </div>

        <div style={{
          fontSize: 14.5, textAlign: 'center', color: '#ece1c7',
          padding: '10px 6px', lineHeight: 1.55,
        }}>
          <b style={{ color: '#ffd66e' }}>{winnerName}</b> won this match.
          <div style={{ marginTop: 10, fontSize: 13.5, color: '#c9bda0' }}>
            Settlement is handled by the server. Nothing is owed between players
            directly, and there is nothing to send by hand.
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={() => setDismissed(true)} className="brd-plate brd-plate--gold"
            style={{ padding: '9px 20px', fontSize: 13 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

function WinnerShareModal({ gameover, myId, myName }: { gameover: any; myId: string; myName: string }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(false); }, [gameover?.winner, gameover?.draw]);
  if (!gameover || gameover.draw) return null;
  if (gameover.winner !== myId) return null;
  if (dismissed) return null;

  const siteUrl = (typeof window !== 'undefined' ? window.location.origin : 'https://ocva.online');
  const imgUrl = `${siteUrl}/share-win.jpg`;
  // Plain text only — the tweet body is a string, so no emoji/pictographs here.
  const tweetText = `I just won in On-Chain Virtual Arena!\n\nPlay the 5-chain onchain card game at ${siteUrl}`;
  const intentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;

  async function downloadImage() {
    try {
      const r = await fetch('/share-win.jpg');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'memetic-masters-win.jpg';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      window.open('/share-win.jpg', '_blank');
    }
  }

  return (
    <div onClick={() => setDismissed(true)} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.78)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 199,
      fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
      padding: 12,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'linear-gradient(180deg, #1a1240 0%, #0a0a1e 100%)',
        border: '2px solid #4c1d95', borderRadius: 10,
        padding: 20, width: 'min(560px, calc(100vw - 24px))',
        maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
        boxShadow: '0 0 40px rgba(139,92,246,0.45)',
        color: '#ece1c7',
      }}>
        <div style={{
          fontFamily: '"Cinzel", "Times New Roman", serif',
          fontSize: 22, fontWeight: 800, letterSpacing: 2,
          color: '#f0b32a', textTransform: 'uppercase',
          textShadow: '0 0 14px rgba(240,179,42,0.45)',
          textAlign: 'center', marginBottom: 4,
        }}>Victory, {myName}</div>
        <div style={{
          textAlign: 'center', color: '#b896ff',
          fontSize: 12, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 14,
        }}>Share your win</div>

        <img src={imgUrl} alt="I just won in On-Chain Virtual Arena"
          style={{
            display: 'block', width: '100%', height: 'auto',
            borderRadius: 6, border: '1px solid rgba(240,179,42,0.4)',
            marginBottom: 12,
          }}
        />

        <div style={{
          fontSize: 13, color: '#cdbf99', lineHeight: 1.45,
          padding: '0 4px 12px', textAlign: 'center',
        }}>
          Click <b style={{ color: '#ffd66e' }}>Share on X</b> to open a pre-filled post,
          then attach the downloaded image.
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <a href={intentUrl} target="_blank" rel="noopener noreferrer"
            className="brd-plate brd-plate--obsidian"
            style={{ padding: '10px 18px', fontSize: 13, textDecoration: 'none' }}>Share on X</a>
          <button onClick={downloadImage} className="brd-plate brd-plate--violet"
            style={{ padding: '10px 18px', fontSize: 13 }}>Download Image</button>
          <button onClick={() => setDismissed(true)} className="brd-plate brd-plate--gold"
            style={{ padding: '10px 18px', fontSize: 13 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

function CTA({ color, children }: { color: string; children: React.ReactNode }) {
  return <b style={{
    fontFamily: '"Cinzel", "Times New Roman", serif',
    color, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: 700,
    textShadow: `0 0 6px ${color}55`,
  }}>{children}</b>;
}

function PlayerHeaderTargetable({ label, clickable, onClick }: { label: string; clickable: boolean; onClick: () => void }) {
  return (
    <div onClick={clickable ? onClick : undefined}
      style={{
        padding: '4px 8px', margin: '4px 0',
        background: clickable ? '#553' : '#222',
        cursor: clickable ? 'pointer' : 'default',
        border: '1px solid #555', fontWeight: 700,
      }}>
      {label} {clickable && <span style={{fontSize:11, opacity:0.7}}>(click to target)</span>}
    </div>
  );
}

// ── Playmat — positions zones over the splash mat image ─────────────────────
/**
 * Beginner rules columns shown either side of the playmat on desktop.
 * Two halves so each side fits a roughly 1100px-tall playmat without scrolling.
 */
function RulesPanel({ side }: { side: 'left' | 'right' }) {
  const sections: Array<{ heading: string; body: React.ReactNode }> = side === 'left'
    ? [
        {
          heading: 'Goal',
          body: 'Reduce your opponent\u2019s life from 20 to 0. You win when they hit zero (or run out of cards in their deck and can\u2019t draw).',
        },
        {
          heading: 'Gas (mana)',
          body: 'Every non-Node card has a cost shown by colored pips: Orange\u00A0BnB, Purple\u00A0Solana, Red\u00A0AVAX, White\u00A0Ethereum, Black\u00A0XRP. You pay that cost by tapping your Nodes.',
        },
        {
          heading: 'Nodes',
          body: 'Nodes are your land. Once per turn you may play one Node from hand — it enters untapped. Click it any time on your turn to tap it for 1 gas of its color. Nodes untap at the start of your next turn.',
        },
        {
          heading: 'The 4 card types',
          body: (
            <>
              <div><b style={{ color: '#ffd66e' }}>Node</b> — land, generates 1 gas of its color when tapped.</div>
              <div><b style={{ color: '#ffd66e' }}>Meme</b> — creature with Power/Toughness. Attacks and blocks.</div>
              <div><b style={{ color: '#ffd66e' }}>Machine</b> — artifact. Stays in play and gives a constant effect.</div>
              <div><b style={{ color: '#ffd66e' }}>Move</b> — single-use spell. Resolves once then goes to graveyard.</div>
            </>
          ),
        },
        {
          heading: 'Summoning sickness',
          body: 'Memes you just played CAN\u2019T attack the turn they enter. They can block right away though. A small SICK badge marks them.',
        },
        {
          heading: 'Turn order',
          body: (
            <>
              <div>1. <b style={{ color: '#ffd66e' }}>Untap</b> — your Nodes and Memes untap.</div>
              <div>2. <b style={{ color: '#ffd66e' }}>Draw</b> — draw 1 card.</div>
              <div>3. <b style={{ color: '#ffd66e' }}>Main</b> — play 1 Node, summon Memes, deploy Machines, cast Moves, tap Nodes for gas.</div>
              <div>4. <b style={{ color: '#ffd66e' }}>Combat</b> — pick attackers, opponent picks blockers, damage resolves.</div>
              <div>5. <b style={{ color: '#ffd66e' }}>End</b> — press <i>Pass Turn</i>.</div>
            </>
          ),
        },
      ]
    : [
        {
          heading: 'Attacking',
          body: 'During your turn click an untapped, non-sick meme to add it to the attack. Press the Attack button to swing — attackers tap.',
        },
        {
          heading: 'Blocking',
          body: 'When opponent attacks, click ONE of your untapped memes to select it as a blocker, then click the attacker you want it to block. Repeat for each block. Press Confirm Blocks when done.',
        },
        {
          heading: 'Damage',
          body: 'In a fight, both memes deal their Power to each other. If a meme takes damage ≥ its Toughness it dies and goes to the graveyard. Unblocked attackers hit the defender\u2019s life total directly.',
        },
        {
          heading: 'Hand limit',
          body: 'No hand size limit during your turn. Drawing from an empty deck means you lose. Start with 7 cards.',
        },
        {
          heading: 'Machines',
          body: 'Machines are permanent. As long as one is on the battlefield, its effect is active — e.g. "your memes get +1/+1." Stack multiple for stronger effects.',
        },
        {
          heading: 'Moves',
          body: 'Casting a Move resolves its effect right away, then sends it to the graveyard. Targeted Moves will ask you to click a target (meme, machine, or player).',
        },
        {
          heading: 'First-game tips',
          body: (
            <>
              <div>• Play a Node every turn if you can — gas is everything.</div>
              <div>• Don\u2019t over-extend into removal Moves; keep one defender back.</div>
              <div>• Hover any card to see a big preview with its full text.</div>
              <div>• Tap multiple nodes BEFORE casting so you can afford the spell.</div>
            </>
          ),
        },
      ];

  return (
    <aside style={{
      flex: '0 0 210px',
      maxWidth: 230,
      alignSelf: 'stretch',
      padding: 12,
      background: 'linear-gradient(180deg, rgba(26,18,64,0.92) 0%, rgba(10,10,30,0.92) 100%)',
      border: '1px solid #4c1d95',
      borderRadius: 8,
      boxShadow: '0 0 22px rgba(139,92,246,0.25), inset 0 0 24px rgba(0,0,0,0.45)',
      color: '#ece1c7',
      fontSize: 12,
      lineHeight: 1.45,
      fontFamily: '"EB Garamond", Garamond, "Times New Roman", serif',
      maxHeight: '1100px',
      overflowY: 'auto',
    }}>
      <div style={{
        fontFamily: '"Cinzel", "Times New Roman", serif',
        fontWeight: 800, fontSize: 13, letterSpacing: 2,
        color: '#f0b32a', textTransform: 'uppercase',
        textShadow: '0 0 8px rgba(240,179,42,0.4)',
        borderBottom: '1px solid rgba(240,179,42,0.35)', paddingBottom: 6, marginBottom: 10,
        textAlign: 'center',
      }}>
        {side === 'left' ? 'How to Play · I' : 'How to Play · II'}
      </div>
      {sections.map((s, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{
            fontFamily: '"Cinzel", "Times New Roman", serif',
            fontWeight: 700, fontSize: 11.5, letterSpacing: 1.5,
            color: '#b896ff', textTransform: 'uppercase',
            marginBottom: 4,
          }}>{s.heading}</div>
          <div style={{ color: '#ece1c7' }}>{s.body}</div>
        </div>
      ))}
    </aside>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cascade-stack rendering for Nodes. When a player controls 3+ copies of the
// same Node def, we collapse them visually into one tile with ghost layers
// behind it. Clicking the stack taps the next available untapped node.
// ─────────────────────────────────────────────────────────────────────────────
function NodeStack({
  group, onClick,
}: {
  group: Instance[];
  onClick?: (uid: string) => void;
}) {
  // Untapped nodes float to the front so the click target is always live.
  const sorted = [...group].sort((a, b) => Number(a.tapped) - Number(b.tapped));
  const top = sorted[0];
  const tappedCount = group.filter(g => g.tapped).length;
  const allTapped = tappedCount === group.length;
  const ghostLayers = Math.min(3, group.length - 1);
  const total = group.length;

  const handleClick = () => {
    if (allTapped || !onClick) return;
    const target = sorted.find(g => !g.tapped);
    if (target) onClick(target.uid);
  };

  return (
    <div style={{
      position: 'relative',
      width: MINI_W, aspectRatio: '68 / 96', flex: '0 0 auto',
      // Reserve room for the offset ghost layers so adjacent stacks don't
      // overlap. Horizontal only: a vertical reserve made the wrapper taller
      // than a card and pushed the live card off-centre in its zone, which is
      // how stacked nodes ended up clipped by the zone's `overflow: hidden`.
      marginRight: 4 * ghostLayers,
    }}
    title={allTapped
      ? `All ${total} tapped — wait for next turn.`
      : `×${total} stacked (${tappedCount} tapped). Click to tap the next available.`}
    >
      {/* Ghost copies of the stack — purely cosmetic, slight rotation + offset. */}
      {Array.from({ length: ghostLayers }).map((_, i) => {
        const depth = ghostLayers - i;       // 1..ghostLayers, deepest first
        const def = CARDS[top.defId];
        if (!def) return null;
        const meta = COLOR_META[def.color];
        const rot  = (i % 2 === 0 ? 1 : -1) * 1.5 * (depth);
        return (
          <div key={i} aria-hidden style={{
            position: 'absolute',
            // Fan sideways, not down — see the wrapper's margin note above.
            left: 4 * depth, top: 0,
            width: '100%', height: '100%', borderRadius: 6,
            background: meta.hex, opacity: 0.55,
            border: '1px solid #000',
            boxShadow: '0 2px 6px #000a',
            transform: `rotate(${rot}deg)`,
            pointerEvents: 'none',
            zIndex: 0,
          }} />
        );
      })}
      {/* Top live card */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <MiniCard
          defId={top.defId}
          instance={top}
          faceUp
          onClick={onClick && !allTapped ? handleClick : undefined}
        />
      </div>
      {/* Count badge */}
      <div style={{
        position: 'absolute',
        right: -6, top: -6,
        background: allTapped
          ? 'linear-gradient(180deg,#a04b4b,#5d2222)'
          : 'linear-gradient(180deg,#3fa564,#155c2b)',
        color: '#fff',
        border: '1px solid rgba(0,0,0,0.8)',
        borderRadius: 10,
        padding: '1px 6px',
        fontSize: 10, fontWeight: 800,
        letterSpacing: 0.5,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.3), 0 1px 4px rgba(0,0,0,0.7)',
        zIndex: 2,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        display: 'inline-flex', alignItems: 'center', gap: 2,
      }}>
        ×{total}
        {tappedCount > 0 && (
          <span style={{ opacity: 0.9, marginLeft: 2, display: 'inline-flex', alignItems: 'center', gap: 1 }}>
            ({tappedCount}<ArrowDown size={9} />)
          </span>
        )}
      </div>
    </div>
  );
}

/** Group nodes by defId; collapse same-def groups of 3+ into a NodeStack tile. */
function renderNodes(
  nodes: Instance[],
  onNodeClick?: (uid: string) => void,
): React.ReactNode {
  const groups = new Map<string, Instance[]>();
  // Preserve original visual order: each defId's first appearance fixes its slot.
  for (const inst of nodes) {
    if (!groups.has(inst.defId)) groups.set(inst.defId, []);
    groups.get(inst.defId)!.push(inst);
  }
  const out: React.ReactNode[] = [];
  for (const [defId, group] of groups) {
    if (group.length >= 3) {
      out.push(<NodeStack key={`stack-${defId}`} group={group} onClick={onNodeClick} />);
    } else {
      for (const inst of group) {
        out.push(
          <MiniCard
            key={inst.uid}
            defId={inst.defId}
            instance={inst}
            faceUp
            onClick={onNodeClick ? () => onNodeClick(inst.uid) : undefined}
          />
        );
      }
    }
  }
  return out;
}

function collectAurasOn(
  me: GState['players'][string],
  opp: GState['players'][string],
  memeUid: string,
): Array<{ defId: string; effect?: string }> {
  const out: Array<{ defId: string; effect?: string }> = [];
  for (const m of me.machines) {
    if (m.attachedTo === memeUid) out.push({ defId: m.defId, effect: CARDS[m.defId]?.effect });
  }
  for (const m of opp.machines) {
    if (m.attachedTo === memeUid) out.push({ defId: m.defId, effect: CARDS[m.defId]?.effect });
  }
  return out;
}
/**
 * UI-side pump bonus from auras (cosmetic; the server is the source of truth).
 * Only the symmetric +2/+2 aura tweaks the displayed P/T — asymmetric sword /
 * shield auras still apply on the backend, but are signaled in the UI via the
 * aura-orb badge count rather than tweaking one stat.
 */
function auraPowerForUI(auras: Array<{ effect?: string }>): number {
  let n = 0;
  for (const a of auras) {
    if (a.effect === 'aura_+2+2') n += 2;
  }
  return n;
}

function Playmat(props: {
  me: GState['players'][string];
  opp: GState['players'][string];
  myId: string; oppId: string;
  myDeckCount: number; oppDeckCount: number;
  attackers: string[]; attackerSide: 'me' | 'opp';
  blocks: Record<string, string[]>;
  selectedBlocker?: string;
  memeTargetable: boolean; machineTargetable: boolean; playerTargetable: boolean;
  onOppPlayerClick: () => void; onMyPlayerClick: () => void;
  onNodeClick: (uid: string) => void;
  onMyMemeClick: (uid: string) => void;
  onOppMemeClick: (uid: string) => void;
  onMachineClick: (uid: string) => void;
  myName?: string; oppName?: string;
}) {
  const {
    me, opp, myId, oppId, myDeckCount, oppDeckCount,
    attackers, attackerSide, blocks, selectedBlocker,
    memeTargetable, machineTargetable, playerTargetable,
    onOppPlayerClick, onMyPlayerClick,
    onNodeClick, onMyMemeClick, onOppMemeClick, onMachineClick,
    myName, oppName,
  } = props;

  const mePump  = me.machines.filter(m => CARDS[m.defId]?.effect === 'pump_all_+1+1' && !m.attachedTo).length;
  const oppPump = opp.machines.filter(m => CARDS[m.defId]?.effect === 'pump_all_+1+1' && !m.attachedTo).length;

  // Zone rectangles in percentage of the mat (left, top, width, height).
  // Tuned to match the labels on /playmat.png.
  const Z = {
    // Opponent (top half; `rotated` mirrors the zone's internal layout only —
    // labels hug the outer edge, cards hug the centre line. No glyph is flipped.)
    oppGrave:    { left: 1,  top: 1,  w: 13, h: 18 },
    oppNodes:    { left: 15, top: 1,  w: 70, h: 18 },
    oppDeck:     { left: 86, top: 1,  w: 13, h: 18 }, // draw deck
    oppMachines: { left: 1,  top: 20, w: 13, h: 17 },
    oppBattle:   { left: 15, top: 20, w: 70, h: 25 }, // memes / battlefield
    oppMaindeck: { left: 86, top: 20, w: 13, h: 17 }, // decorative
    oppLife:     { left: 86, top: 38, w: 13, h: 7  },
    // Me (bottom half)
    myLife:      { left: 1,  top: 55, w: 13, h: 7  },
    myBattle:    { left: 15, top: 55, w: 70, h: 25 }, // memes / battlefield
    myMachines:  { left: 86, top: 62, w: 13, h: 17 },
    myMaindeck:  { left: 1,  top: 62, w: 13, h: 17 }, // decorative
    myDeck:      { left: 1,  top: 80, w: 13, h: 18 }, // draw deck
    myNodes:     { left: 15, top: 80, w: 70, h: 18 },
    myGrave:     { left: 86, top: 80, w: 13, h: 18 },
  };

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      // Parent wrapper (in ChainsBoard) owns the responsive sizing: on desktop
      // it hands us a square box sized by the leftover height, on mobile a
      // full-width one. Either way we just fill it and stay square.
      maxWidth: '100%', maxHeight: '100%',
      aspectRatio: '1 / 1',
      margin: '0 auto', borderRadius: 16, overflow: 'hidden',
      // Gilded outer bezel: bronze edge outside, gold hairline inside.
      border: '1px solid rgba(122,84,18,0.9)',
      boxShadow:
        'inset 0 0 0 1px rgba(229,184,75,0.34),' +
        'inset 0 1px 0 rgba(255,236,178,0.20),' +
        'inset 0 0 90px rgba(0,0,0,0.85),' +
        '0 0 40px rgba(142,77,255,0.15), 0 14px 46px rgba(0,0,0,0.8)',
      isolation: 'isolate',
      // Container-query units (cqw) size the mini-cards relative to the mat,
      // so they step down on phones AND grow back when MobileZoom zooms in.
      containerType: 'inline-size',
    }}>
      {/* ── Mat decoration. Every layer here is LAYER.MAT_ART / LAYER.MAT_SCRIM and is
             pointer-transparent; nothing below LAYER.MAT_CONTENT may hold a card. ── */}
      {/* Obsidian mat surface — the arena scene, heavily darkened + navy-tinted so cards pop. */}
      <div aria-hidden style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundImage: 'url(/playmat.png?v=2)', backgroundSize: 'cover', backgroundPosition: 'center',
        filter: 'blur(2.5px) brightness(0.24) saturate(0.55) contrast(1.05)',
        zIndex: LAYER.MAT_ART,
      }} />
      {/* Scrim + vignette: pushes the art back so card frames read as the top layer. */}
      <div aria-hidden style={{
        position: 'absolute', inset: 0, zIndex: LAYER.MAT_SCRIM, pointerEvents: 'none',
        background:
          'radial-gradient(120% 92% at 50% 50%, rgba(8,13,24,0.30) 0%, rgba(5,7,17,0.86) 72%, rgba(2,3,8,0.95) 100%)',
      }} />
      <div aria-hidden style={{
        position: 'absolute', inset: 0, zIndex: LAYER.MAT_SCRIM, pointerEvents: 'none',
        background:
          'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(0,0,0,0.55) 100%),' +
          'linear-gradient(90deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0) 12%, rgba(0,0,0,0) 88%, rgba(0,0,0,0.45) 100%)',
      }} />
      {/* Violet lane light */}
      <div aria-hidden style={{ position: 'absolute', inset: 0, zIndex: LAYER.MAT_SCRIM, pointerEvents: 'none',
        background: 'radial-gradient(50% 30% at 50% 50%, rgba(142,77,255,0.13), transparent 70%)' }} />
      {/* Luminous center divider between the two halves */}
      <div aria-hidden style={{
        position: 'absolute', left: '2%', right: '2%', top: '50%', height: 2, transform: 'translateY(-1px)',
        zIndex: LAYER.MAT_SCRIM, pointerEvents: 'none',
        background: 'linear-gradient(90deg, transparent, rgba(196,92,255,0.85), rgba(255,216,106,0.55), rgba(196,92,255,0.85), transparent)',
        boxShadow: '0 0 14px rgba(196,92,255,0.55)',
      }} />
      {/* Heraldic diamond set on the centre rule. */}
      <div aria-hidden style={{
        position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
        zIndex: LAYER.MAT_SCRIM, pointerEvents: 'none',
        display: 'grid', placeItems: 'center', color: GOLD_HI,
        filter: 'drop-shadow(0 0 6px rgba(255,216,106,0.75))',
      }}>
        <Diamond size={9} />
      </div>
      {/* Built on Solana watermark — low-contrast, behind all cards/zones. */}
      <div aria-hidden style={{
        position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)',
        width: 160, textAlign: 'center', opacity: 0.1, zIndex: LAYER.MAT_SCRIM, pointerEvents: 'none',
        fontWeight: 800, fontSize: 15, letterSpacing: '0.16em', color: '#fff', whiteSpace: 'nowrap',
      }}>BUILT ON SOLANA</div>
      {/* ── Playable content. Sits above every decoration layer. ── */}
      <div style={{ position: 'absolute', inset: 0, zIndex: LAYER.MAT_CONTENT }}>
      {/* ─── OPPONENT SIDE (mirrored layout, upright text) ─── */}
      <ZoneSlot rect={Z.oppGrave} icon={<Skull size={11} />} label={`Graveyard (${opp.graveyard.length})`} compactLabel={`${opp.graveyard.length}`} rotated>
        {opp.graveyard.slice(-1).map((id, i) => <MiniCard key={i} defId={id} faceUp />)}
      </ZoneSlot>
      <ZoneSlot rect={Z.oppNodes} icon={<Chain size={11} />} label={`Opp Nodes (${opp.nodes.length})`} compactLabel={`Nodes · ${opp.nodes.length}`} rotated>
        {renderNodes(opp.nodes)}
      </ZoneSlot>
      <ZoneSlot rect={Z.oppDeck} icon={<Cards size={11} />} label={`Deck (${oppDeckCount})`} compactLabel={`${oppDeckCount}`} rotated>
        {oppDeckCount > 0 && <MiniCard faceDown />}
      </ZoneSlot>
      <ZoneSlot rect={Z.oppMaindeck} icon={<HandIcon size={11} />} label={`Hand (${opp.hand.length})`} compactLabel={`${opp.hand.length}`} rotated>
        {opp.hand.length > 0 && (
          <div style={{ color: '#fff', fontSize: 14, fontWeight: 700, textShadow: '0 1px 4px #000', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Cards size={16} color={GOLD} /> × {opp.hand.length}
          </div>
        )}
      </ZoneSlot>
      <ZoneSlot rect={Z.oppMachines} icon={<SettingsIcon size={11} />} label={`Machines (${opp.machines.filter(m => !m.attachedTo).length})`} compactLabel={`${opp.machines.filter(m => !m.attachedTo).length}`} rotated>
        {opp.machines.filter(m => !m.attachedTo).map(inst => (
          <MiniCard key={inst.uid} defId={inst.defId} instance={inst} faceUp
            onClick={machineTargetable ? () => onMachineClick(inst.uid) : undefined}
            targetable={machineTargetable} />
        ))}
      </ZoneSlot>
      <ZoneSlot rect={Z.oppBattle} icon={<Swords size={11} />} label={`Battlefield — ${COLOR_META[opp.color].name}`} compactLabel={COLOR_META[opp.color].name} rotated>
        {opp.memes.map(inst => {
          const attacking = attackerSide === 'opp' && attackers.includes(inst.uid);
          const blockedBy = blocks[inst.uid] ?? [];
          const blockerSelected = !!selectedBlocker;
          const isAttacker = attackerSide === 'opp' && attackers.includes(inst.uid);
          const blockable = blockerSelected && isAttacker;
          const auras = collectAurasOn(me, opp, inst.uid);
          return (
            <MiniCard key={inst.uid} defId={inst.defId} instance={inst} faceUp
              pumpBonus={oppPump + auraPowerForUI(auras)}
              onClick={(memeTargetable || blockable) ? () => onOppMemeClick(inst.uid) : undefined}
              targetable={memeTargetable || blockable}
              selected={attacking}
              blocked={blockedBy.length > 0}
              footer={
                <CombatBadges attacking={attacking} blockedCount={blockedBy.length} auraCount={auras.length} />
              } />
          );
        })}
      </ZoneSlot>
      {/* Large opponent life badge — corner, MTG-Arena style */}
      <LifeBadge
        life={opp.life} name={oppName ?? 'Opponent'} color={opp.color}
        position="topRight" targetable={playerTargetable}
        onClick={playerTargetable ? onOppPlayerClick : undefined}
        side="opp" deckCount={oppDeckCount} handCount={opp.hand.length}
      />

      {/* ─── ME ─── */}
      <LifeBadge
        life={me.life} name={myName ?? 'You'} color={me.color}
        position="bottomLeft" targetable={playerTargetable}
        onClick={playerTargetable ? onMyPlayerClick : undefined}
        side="me" deckCount={myDeckCount} handCount={me.hand.length}
      />
      <ZoneSlot rect={Z.myBattle} icon={<Swords size={11} />} label={`Your Battlefield — ${COLOR_META[me.color].name}`} compactLabel={COLOR_META[me.color].name}>
        {me.memes.map(inst => {
          const attacking = attackerSide === 'me' && attackers.includes(inst.uid);
          const blockedBy = blocks[inst.uid] ?? [];
          const auras = collectAurasOn(me, opp, inst.uid);
          return (
            <MiniCard key={inst.uid} defId={inst.defId} instance={inst} faceUp
              pumpBonus={mePump + auraPowerForUI(auras)}
              onClick={() => onMyMemeClick(inst.uid)}
              targetable={memeTargetable}
              selected={inst.uid === selectedBlocker || attacking}
              blocked={blockedBy.length > 0}
              footer={
                <CombatBadges attacking={attacking} blockedCount={blockedBy.length} auraCount={auras.length} />
              } />
          );
        })}
      </ZoneSlot>
      <ZoneSlot rect={Z.myMachines} icon={<SettingsIcon size={11} />} label={`Machines (${me.machines.filter(m => !m.attachedTo).length})`} compactLabel={`${me.machines.filter(m => !m.attachedTo).length}`}>
        {me.machines.filter(m => !m.attachedTo).map(inst => (
          <MiniCard key={inst.uid} defId={inst.defId} instance={inst} faceUp
            onClick={machineTargetable ? () => onMachineClick(inst.uid) : undefined}
            targetable={machineTargetable} />
        ))}
      </ZoneSlot>
      <ZoneSlot rect={Z.myMaindeck} icon={<ScrollIcon size={11} />} label="Main Deck" compactLabel="">
        <div style={{ color: '#888', fontSize: 10 }}>—</div>
      </ZoneSlot>
      <ZoneSlot rect={Z.myDeck} icon={<Cards size={11} />} label={`Deck (${myDeckCount})`} compactLabel={`${myDeckCount}`}>
        {myDeckCount > 0 && <MiniCard faceDown />}
      </ZoneSlot>
      <ZoneSlot rect={Z.myNodes} icon={<Chain size={11} />} label={`Your Nodes (${me.nodes.length}) — click to tap`} compactLabel={`Nodes · ${me.nodes.length}`}>
        {renderNodes(me.nodes, onNodeClick)}
      </ZoneSlot>
      <ZoneSlot rect={Z.myGrave} icon={<Skull size={11} />} label={`Graveyard (${me.graveyard.length})`} compactLabel={`${me.graveyard.length}`}>
        {me.graveyard.slice(-1).map((id, i) => <MiniCard key={i} defId={id} faceUp />)}
      </ZoneSlot>
      </div>
    </div>
  );
}

function ZoneSlot({
  rect, label, compactLabel, icon, children, rotated, onClick, targetable,
}: {
  rect: { left: number; top: number; w: number; h: number };
  label: string; compactLabel?: string; icon?: React.ReactNode;
  children: React.ReactNode; rotated?: boolean;
  onClick?: () => void; targetable?: boolean;
}) {
  const mobile = useIsMobile();
  return (
    <div
      onClick={onClick}
      title={label}
      className={`brd-zone${targetable ? ' brd-targetable' : ''}`}
      style={{
        position: 'absolute',
        left: `${rect.left}%`, top: `${rect.top}%`,
        width: `${rect.w}%`, height: `${rect.h}%`,
        // Explicit rung on the ladder (see `Z` at the top of this file). The
        // zone — not the card — is what gets raised on hover, because the
        // rotated half needs `transform` and that traps child z-indexes.
        zIndex: LAYER.ZONE,
        // Engraved stone inset: dark well, hairline gold rim, cut-in shadow.
        border: targetable ? '2px dashed #FFD86A' : '1px solid rgba(229,184,75,0.20)',
        borderRadius: 8,
        // NOTE: no backdrop-filter here. It used to blur the mat art behind the
        // well, but it also created a stacking context *and* a containing block,
        // which is what stopped hovered cards from lifting clear of the zone.
        // The well is already opaque enough without it.
        background: 'linear-gradient(180deg, rgba(6,8,16,0.62) 0%, rgba(3,4,10,0.72) 100%)',
        boxShadow: targetable
          ? '0 0 14px rgba(255,216,106,0.5), inset 0 0 12px rgba(0,0,0,0.4)'
          : 'inset 0 2px 6px rgba(0,0,0,0.75), inset 0 -1px 0 rgba(255,226,160,0.09), inset 0 0 22px rgba(0,0,0,0.55)',
        padding: 3,
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        // NOTE: the opponent's half used to be `rotate(180deg)` "so cards face
        // them". That also turned every glyph on their half upside down — zone
        // labels, deck/graveyard counts, card names and power/toughness were all
        // mirrored and unreadable. A digital client has to let you read your
        // opponent's board, so the rotation is gone. `rotated` now only mirrors
        // the *layout*: the label sits on the outer edge of the mat and the card
        // row hugs the centre line, so the two halves still read as facing.
      }}
    >
      {/* Engraved rule alongside the zone label. */}
      <span aria-hidden style={{
        position: 'absolute',
        ...(rotated ? { bottom: 'clamp(9px, 2.6cqw, 13px)' } : { top: 'clamp(9px, 2.6cqw, 13px)' }),
        left: 6, right: 6, height: 1, pointerEvents: 'none',
        background: 'linear-gradient(90deg, transparent, rgba(229,184,75,0.30), transparent)',
      }} />
      <div className="brd-zone-label" style={{
        position: 'absolute', ...(rotated ? { bottom: 1 } : { top: 1 }), left: 6, right: 6,
        fontSize: 'clamp(9px, 1.4cqw, 11px)', color: 'rgba(229,184,75,0.82)',
        textShadow: '0 1px 3px #000, 0 0 5px #000',
        pointerEvents: 'none',
        display: 'flex', alignItems: 'center', gap: 4,
        overflow: 'hidden', whiteSpace: 'nowrap',
      }}>
        {icon}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{compactLabel ?? label}</span>
      </div>
      <div className="brd-scroll" style={{
        position: 'absolute',
        // The label row is sized in cqw (a % of the square mat) so it shrinks
        // with the mat instead of eating a fixed 18px out of a 64px-tall zone
        // on a 390px phone — which is what made cards taller than their zone.
        ...(rotated
          ? { top: 1, bottom: 'clamp(11px, 3cqw, 15px)' }
          : { top: 'clamp(11px, 3cqw, 15px)', bottom: 1 }),
        left: 2, right: 2,
        // Headroom so the hover lift (see `.brd-mini[role=button]:hover`) plays
        // out *inside* the scrollport instead of being sliced off by it.
        padding: '4px 3px',
        display: 'flex', gap: 3,
        // Phones: keep every card on ONE horizontally-scrolling row. Wrapping
        // pushed later cards into a second row that the short zone clipped —
        // they ended up sitting behind their neighbours and untappable.
        flexWrap: mobile ? 'nowrap' : 'wrap',
        // `center`, not `flex-start`: packing the line to the top left a card
        // with 2px of headroom above and 15px below, so the hover lift clipped
        // against the top edge while there was room going spare underneath.
        alignContent: 'center', justifyContent: 'center', alignItems: 'center',
        // Crowded zones scroll internally instead of clipping cards out of reach.
        overflowX: 'auto', overflowY: mobile ? 'hidden' : 'auto',
        WebkitOverflowScrolling: 'touch',
        overscrollBehavior: 'contain',
      }}>{children}</div>
    </div>
  );
}

/** Large MTG-Arena style circular life badge anchored to a playmat corner. */
function LifeBadge({
  life, name, color, position, onClick, targetable,
  side, deckCount, handCount,
}: {
  life: number; name: string; color: Color;
  position: 'topRight' | 'bottomLeft';
  onClick?: () => void; targetable?: boolean;
  side: 'me' | 'opp'; deckCount: number; handCount: number;
}) {
  void color;
  const mobile = useIsMobile();
  const A = side === 'me' ? '#298BFF' : '#E45F76';   // player blue / opponent red-violet
  const A2 = side === 'me' ? '#8E4DFF' : '#C45CFF';  // violet highlight
  const isRight = position === 'topRight';
  // Phones: park the orb in the free band that flanks the centre rule.
  //
  // Every zone rectangle in `Z` (see Playmat) is accounted for here. In the two
  // 13%-wide outer columns the zones are: 1–19%, 20–37%, then nothing until
  // 62–79% and 80–98%. So 37%–62% is genuinely empty on BOTH sides, and an orb
  // is `clamp(46px, 10cqw, 72px)` ≈ 12% of the mat. The previous offsets put the
  // player's orb at 52% + 12% = 64%, which ran into the 62–79% Main Deck slot —
  // that is the bottom-left overlap in the owner's screenshot. These offsets
  // keep both orbs strictly inside 37%–62%, on opposite sides of the divider.
  // Name + chips are dropped on phones (names live in the turn banner).
  const pos: React.CSSProperties = mobile
    ? (isRight ? { top: '40%', right: '1%' } : { top: '48%', left: '1%' })
    : (isRight ? { top: '37%', right: '1%' } : { top: '37%', left: '1%' });
  // Seating shadow: the orb sits *in* the mat, so the drop shadow is tight and
  // the identity glow is a halo around the bezel — not a rim-light on a ball.
  const orbGlow = targetable
    ? '0 0 0 1px rgba(255,216,106,0.9), 0 0 26px rgba(255,216,106,0.75), 0 5px 14px rgba(0,0,0,0.8)'
    : `0 0 20px ${A}55, 0 5px 14px rgba(0,0,0,0.78)`;

  // Damage / heal flash: re-key the animation class whenever the total moves.
  const prevLife = useRef(life);
  const [flash, setFlash] = useState<{ dir: 'hit' | 'heal'; n: number } | null>(null);
  useEffect(() => {
    if (prevLife.current === life) return;
    const dir = life < prevLife.current ? 'hit' : 'heal';
    prevLife.current = life;
    setFlash(f => ({ dir, n: (f?.n ?? 0) + 1 }));
  }, [life]);

  return (
    <div
      onClick={onClick}
      title={`${name} — ${life} life · Deck ${deckCount} · Hand ${handCount}`}
      aria-label={`${name}, ${life} life, ${deckCount} in deck, ${handCount} in hand`}
      className={targetable ? 'brd-targetable' : undefined}
      style={{
        position: 'absolute', ...pos, zIndex: LAYER.HUD,
        // A COLUMN, not a row. The old desktop layout put the orb in a mat
        // corner with the name + chips reaching sideways across the Deck and
        // Nodes zones, covering the deck card and its count. Stacked, the whole
        // HUD stays inside the 13%-wide outer column that the mat leaves free
        // between 37% and 62% — the mat's own life slot.
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', gap: 'clamp(3px, 0.8cqw, 6px)',
        cursor: onClick ? 'pointer' : 'default', pointerEvents: 'auto',
        width: '12cqw', minWidth: 0,
      }}>
      {/* Life gem, seated in a forged bezel (see `.brd-orb` in Board.css).
          Not a sphere: facet fan + light welling up from below + rivets. */}
      <div
        key={flash?.n ?? 0}
        className={`brd-orb${flash ? (flash.dir === 'hit' ? ' brd-orb-hit' : ' brd-orb-heal') : ''}`}
        style={{
          ...({ '--orb-a': A, '--orb-a2': A2 } as Vars),
          width: 'min(100%, clamp(44px, 10cqw, 72px))',
          fontSize: 'clamp(18px, 4.2cqw, 31px)',
          boxShadow: orbGlow,
          // Targetable swaps the hammered bezel for a bright forged-gold one.
          ...(targetable ? { borderColor: GOLD_HI, borderStyle: 'solid' } : null),
        }}>
        <span className="brd-orb__num">{life}</span>
        <span aria-hidden className="brd-orb__glint" />
      </div>
      {/* Count tallies — icon + numeral first, small-caps label only when the
          mat is wide enough for it (a container query in Board.css). Phones drop
          them entirely: the same counts are already in the Deck / Hand zone
          labels, and the outer column is only ~46px wide there.
          The player NAME is deliberately not repeated here — the turn banner
          already carries both names, and the name chip was the widest element,
          which is what pushed the old HUD across the neighbouring zones. */}
      {!mobile && (
        <>
          <CountChip icon={<Cards size={11} />} n={deckCount} label="Deck" title={`${name} — ${deckCount} cards left in deck`} />
          <CountChip icon={<HandIcon size={11} />} n={handCount} label="Hand" title={`${name} — ${handCount} cards in hand`} />
        </>
      )}
    </div>
  );
}

/**
 * Engraved metal tally: icon + numeral + small-caps Cinzel label.
 * Styling lives in `.brd-count` (Board.css) so it shares the chamfered plate
 * and engraved gold hairline with `.brd-plate` / `.brd-stud`. Pass
 * `label={null}` where there is no room for the caption.
 */
function CountChip({
  icon, n, label, title,
}: { icon: React.ReactNode; n: number; label?: string | null; title?: string }) {
  return (
    <span className="brd-count" title={title} aria-label={title ?? `${label ?? ''} ${n}`}>
      <span aria-hidden className="brd-count__icon">{icon}</span>
      <span className="brd-count__n">{n}</span>
      {label ? <span className="brd-count__label">{label}</span> : null}
    </span>
  );
}

/** Top-of-screen turn banner with chain-color glow + pulse. */
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Mobile sticky bottom action bar. Holds the game-critical buttons + a
 * compact GasBar + the Hand toggle. Sits above the iOS safe-area inset.
 */
function MobileActionBar({
  gas, handCount, onOpenHand,
  attackerCount, canAttack, onAttack,
  canEndTurn, onEndTurn,
  inBlockers, onConfirmBlocks,
  targetMode, onCancelTarget,
  onOpenRules, onOpenLog, logUnread,
}: {
  gas: Record<Color, number>;
  handCount: number;
  onOpenHand: () => void;
  attackerCount: number;
  canAttack: boolean;
  onAttack: () => void;
  canEndTurn: boolean;
  onEndTurn: () => void;
  inBlockers: boolean;
  onConfirmBlocks: () => void;
  targetMode: boolean;
  onCancelTarget: () => void;
  onOpenRules: () => void;
  onOpenLog: () => void;
  logUnread: number;
}) {
  return (
    <div style={{
      // Sticky, not fixed. A fixed bar has to be paid for with a padding-bottom
      // reserve on the board, and that reserve has to assume the worst case
      // (the row wraps when CANCEL + ATTACK + END TURN + HAND are all live) —
      // which left a permanent black gap under the hand whenever it did not.
      // Sticky means the bar occupies exactly its own height, always.
      position: 'sticky', bottom: 0, zIndex: 90,
      flex: '0 0 auto',
      // Bleed through the board's 6px padding to the screen edges.
      marginLeft: -6, marginRight: -6, marginTop: 4,
      paddingBottom: 'env(safe-area-inset-bottom)',
      background: 'linear-gradient(180deg, rgba(22,17,32,0.90), rgba(4,4,9,0.97))',
      borderTop: '1px solid rgba(229,184,75,0.45)',
      boxShadow: 'inset 0 1px 0 rgba(255,226,160,0.16), 0 -10px 28px rgba(0,0,0,0.65)',
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    }}>
      {/* Wraps instead of scrolling: with CANCEL + END TURN + HAND all live at
          once the row is wider than a 390px phone, and a horizontally-scrolled
          bar hid the right-hand buttons off-screen. */}
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap',
        columnGap: 6, rowGap: 6,
        // Right padding clears the host app's bottom-right floating control
        // (sound toggle) so ATTACK / END TURN / HAND are never underneath it.
        paddingTop: 7, paddingBottom: 7,
        paddingLeft: 'max(8px, env(safe-area-inset-left))',
        paddingRight: 'calc(58px + env(safe-area-inset-right))',
        justifyContent: 'flex-end',
      }}>
        {/* Help + gas keep the left edge; actions right-align and wrap below. */}
        <button onClick={onOpenRules} title="How to play" aria-label="How to play"
          className="brd-stud"
          style={{ width: 44, height: 44, flex: '0 0 auto', fontFamily: '"Cinzel", "Times New Roman", serif', fontWeight: 800, fontSize: 15 }}
        >?</button>
        {/* Action log + chat. Docked here rather than floating: a floating
            bubble sat on top of the hand strip. */}
        <button onClick={onOpenLog} title="Action log & chat" aria-label="Open action log and chat"
          className="brd-stud"
          style={{ width: 44, height: 44, flex: '0 0 auto', position: 'relative' }}
        >
          <ChatIcon size={19} />
          {logUnread > 0 && (
            <span style={{
              position: 'absolute', top: -3, right: -3, background: '#E45F76', color: '#fff',
              fontSize: 9, fontWeight: 800, borderRadius: 9, minWidth: 17, height: 17,
              display: 'grid', placeItems: 'center', padding: '0 4px', border: '1px solid #000',
            }}>{logUnread > 9 ? '9+' : logUnread}</span>
          )}
        </button>
        {/* Compact gas pool — labelled so it is readable without zooming. */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0, marginRight: 'auto' }}>
          <span className="brd-zone-label" style={{ fontSize: 10, color: 'rgba(229,184,75,0.8)' }}>Gas</span>
          {COLORS.some(c => gas[c] > 0)
            ? COLORS.map(c => gas[c] > 0 && <Pip key={c} c={c} n={gas[c]} />)
            : <span style={{ fontSize: 12, fontWeight: 800, color: '#6f7488' }}>0</span>}
        </div>
        {targetMode && (
          <button onClick={onCancelTarget} className="brd-plate brd-plate--obsidian" style={mobBtn()}
            aria-label="Cancel targeting"><Close size={14} /> CANCEL</button>
        )}
        {canAttack && (
          <button onClick={onAttack} className="brd-plate brd-plate--crimson" style={mobBtn()}
            aria-label={`Attack with ${attackerCount}`}><Swords size={14} /> ATTACK ({attackerCount})</button>
        )}
        {inBlockers && (
          <button onClick={onConfirmBlocks} className="brd-plate brd-plate--steel" style={mobBtn()}
            aria-label="Confirm blocks"><Shield size={14} /> BLOCKS</button>
        )}
        {canEndTurn && (
          <button onClick={onEndTurn} className="brd-plate brd-plate--gold" style={mobBtn()}>END TURN</button>
        )}
        <button onClick={onOpenHand} className="brd-plate brd-plate--violet"
          style={{ ...mobBtn(), position: 'relative' }} aria-label={`Open hand (${handCount} cards)`}>
          <HandIcon size={14} /> HAND
          <span style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
            background: 'linear-gradient(180deg,#f7dc93,#c08f2c)', color: '#241703',
            boxShadow: 'inset 0 1px 0 rgba(255,250,220,0.7), 0 1px 2px rgba(0,0,0,0.6)',
            fontFamily: 'system-ui, sans-serif', fontWeight: 900, fontSize: 11, letterSpacing: 0,
          }}>{handCount}</span>
        </button>
      </div>
    </div>
  );
}
/** Sizing only — the forged-plate look comes from `.brd-plate--*` in Board.css. */
function mobBtn(): React.CSSProperties {
  return { padding: '10px 11px', fontSize: 12, letterSpacing: '0.08em', minHeight: 44, flexShrink: 0 };
}

/**
 * Full-screen bottom sheet listing the player's hand on mobile.
 * Tapping a card plays it (closing the sheet).
 */
function MobileHandSheet({
  hand, selectedIdx, canPlay, onClose, onPlay,
}: {
  hand: string[];
  selectedIdx: number | null;
  canPlay: boolean;
  onClose: () => void;
  onPlay: (i: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 140,
      background: dragging ? 'rgba(4,6,12,0.10)' : 'rgba(4,6,12,0.78)',
      backdropFilter: dragging ? 'none' : 'blur(6px)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      transition: 'background 0.15s ease',
      pointerEvents: dragging ? 'none' : 'auto',
    }}>
      <div onClick={e => e.stopPropagation()} className="brd-scroll" style={{
        width: '100%', maxHeight: '85dvh', overflowY: 'auto',
        background: 'linear-gradient(180deg, rgba(28,18,52,0.98), rgba(10,8,22,0.99))',
        borderTop: '1px solid rgba(143,92,255,0.55)',
        boxShadow: '0 -8px 32px rgba(0,0,0,0.7)',
        borderTopLeftRadius: 14, borderTopRightRadius: 14,
        padding: 14, paddingBottom: 'calc(14px + env(safe-area-inset-bottom))',
        display: 'flex', flexDirection: 'column', gap: 12,
        opacity: dragging ? 0 : 1,
        transition: 'opacity 0.15s ease',
        pointerEvents: dragging ? 'none' : 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="brd-zone-label" style={{
            fontSize: 14, letterSpacing: 2, color: GOLD_HI,
            display: 'flex', alignItems: 'center', gap: 8,
            textShadow: '0 0 12px rgba(255,216,106,0.35)',
          }}>
            <HandIcon size={15} /> Your Hand ({hand.length})
          </div>
          <button onClick={onClose} className="brd-glyph-btn" aria-label="Close hand" title="Close hand"
            style={{ padding: '8px 14px', minHeight: 44, minWidth: 44 }}><Close size={18} /></button>
        </div>
        {hand.length === 0 ? (
          <div style={{ padding: 20, color: '#aab', textAlign: 'center' }}>
            No cards in hand.
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))',
            gap: 10,
          }}>
            {hand.map((id, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'center',
                opacity: canPlay ? 1 : 0.7,
                outline: selectedIdx === i ? '2px solid #ffd76a' : 'none',
                borderRadius: 8,
              }}>
                <DraggableCard
                  defId={id}
                  onDrop={() => { if (canPlay) { onPlay(i); } }}
                  onDragStateChange={setDragging}
                >
                  <CardFace
                    defId={id}
                    selected={selectedIdx === i}
                    pinOnTap
                    onClick={() => canPlay && onPlay(i)}
                  />
                </DraggableCard>
              </div>
            ))}
          </div>
        )}
        {!canPlay && (
          <div style={{ textAlign: 'center', fontSize: 12, color: '#aab' }}>
            Wait for your turn to play a card.
          </div>
        )}
      </div>
    </div>
  );
}


function MulliganModal({
  hand, mulliganCount, done, oppDone, deadline, onKeep, onMulligan, onForceEnd,
}: {
  hand: string[];
  mulliganCount: number;
  done: boolean;
  oppDone: boolean;
  deadline: number;
  onKeep: () => void;
  onMulligan: () => void;
  onForceEnd: () => void;
}) {
  const mobile = useIsMobile();
  const nextSize = mulliganDrawCount(mulliganCount + 1);
  const atFloor = hand.length <= MULLIGAN_FLOOR;
  // Live countdown tick.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  const remainingMs = deadline > 0 ? Math.max(0, deadline - now) : 0;
  const remainingS  = Math.ceil(remainingMs / 1000);
  const waitingOnOpp = done && !oppDone;
  const expired = deadline > 0 && now >= deadline;
  // Auto-fire the escape hatch once the deadline lapses while we're waiting
  // on the opponent. Only fires once thanks to the guard.
  const firedRef = useRef(false);
  useEffect(() => {
    if (waitingOnOpp && expired && !firedRef.current) {
      firedRef.current = true;
      try { onForceEnd(); } catch { /* INVALID_MOVE is fine */ }
    }
  }, [waitingOnOpp, expired, onForceEnd]);
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 150,
      background: 'rgba(4,6,12,0.86)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      // Phones: hug the safe area so the modal is never under the notch/home bar.
      padding: mobile
        ? 'max(10px, env(safe-area-inset-top)) 10px calc(10px + env(safe-area-inset-bottom))'
        : 20,
    }}>
      <div className="brd-scroll brd-panel" style={{
        width: 'min(960px, 100%)', maxHeight: mobile ? '100%' : '92dvh', overflow: 'auto',
        background: 'linear-gradient(180deg, rgba(30,22,54,0.97), rgba(9,7,18,0.97))',
        border: '1px solid rgba(229,184,75,0.42)',
        borderRadius: 12, padding: mobile ? 14 : 24,
        display: 'flex', flexDirection: 'column', gap: mobile ? 12 : 16,
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{
            fontFamily: '"Cinzel", serif', fontSize: 22, fontWeight: 800, letterSpacing: 3, color: GOLD_HI,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
            textShadow: '0 0 18px rgba(255,216,106,0.4)',
          }}>
            <Diamond size={9} color="rgba(229,184,75,0.7)" />
            <Cards size={19} /> MULLIGAN
            <Diamond size={9} color="rgba(229,184,75,0.7)" />
          </div>
          <div style={{ fontSize: 12, color: '#aab', marginTop: 4 }}>
            {done
              ? oppDone
                ? 'Both players ready — starting…'
                : 'Waiting for opponent to keep or mulligan…'
              : `Your opening hand (${hand.length} cards). Keep it, or mulligan to redraw ${nextSize} card${nextSize === 1 ? '' : 's'}.`}
          </div>
          <div style={{ fontSize: 11, color: '#7a8', marginTop: 6, fontStyle: 'italic' }}>
            London mulligan · 1st free · −1 each redraw · floor {MULLIGAN_FLOOR}
            {mulliganCount > 0 && ` · mull #${mulliganCount}`}
          </div>
        </div>

        {/* Phones: one horizontally-scrolling row keeps KEEP / MULLIGAN on
            screen. Wrapping the 7 cards into a grid pushed both buttons below
            the fold, which read as "there is no way to continue". */}
        <div className="brd-scroll" style={{
          display: 'flex', flexWrap: mobile ? 'nowrap' : 'wrap', gap: 8,
          justifyContent: mobile ? 'flex-start' : 'center',
          overflowX: mobile ? 'auto' : 'visible',
          WebkitOverflowScrolling: 'touch',
          padding: mobile ? 8 : 14,
          background: 'linear-gradient(180deg, rgba(0,0,0,0.45), rgba(0,0,0,0.3))',
          border: '1px solid rgba(229,184,75,0.18)', borderRadius: 8,
          boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.7)',
        }}>
          {hand.map((defId, i) => (
            <CardFace key={i} defId={defId} />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={onKeep}
            disabled={done}
            className="brd-plate brd-plate--gold"
            style={{ padding: '11px 24px', fontSize: 13, minHeight: 44 }}
          ><Check size={15} /> KEEP HAND</button>
          <button
            onClick={onMulligan}
            disabled={done || atFloor}
            title={atFloor ? `Already at floor (${MULLIGAN_FLOOR} cards).` : `Redraw to ${nextSize} cards.`}
            className="brd-plate brd-plate--obsidian"
            style={{ padding: '11px 24px', fontSize: 13, minHeight: 44 }}
          ><Refresh size={15} /> MULLIGAN ({nextSize})</button>
          {waitingOnOpp && expired && (
            <button
              onClick={onForceEnd}
              title="Opponent ran out of time — start the match anyway."
              className="brd-plate brd-plate--crimson"
              style={{ padding: '11px 24px', fontSize: 13, minHeight: 44 }}
            ><Bolt size={15} /> START MATCH</button>
          )}
        </div>

        {waitingOnOpp && deadline > 0 && (
          <div style={{
            textAlign: 'center', fontSize: 11, color: expired ? '#ef4444' : '#aab', letterSpacing: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}>
            {expired
              ? <><Warning size={12} /> Opponent timed out — click Start Match to begin.</>
              : `Auto-starting in ${remainingS}s if opponent doesn't respond…`}
          </div>
        )}

        <div style={{
          display: 'flex', justifyContent: 'center', gap: 18,
          fontSize: 11, color: '#9aa', letterSpacing: 1,
        }}>
          <span style={{ color: done ? '#56d97a' : '#aab', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Dot size={8} /> You {done ? 'ready' : 'choosing…'}
          </span>
          <span style={{ color: oppDone ? '#56d97a' : '#aab', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Dot size={8} /> Opponent {oppDone ? 'ready' : 'choosing…'}
          </span>
        </div>
      </div>
    </div>
  );
}

// Suppress unused-warning for the constant on initial scaffolding.
void MULLIGAN_INITIAL_HAND;

// ─────────────────────────────────────────────────────────────────────────────
function TurnBanner({
  myTurn, turn, phase, myName, oppName, myProfile, oppProfile, onOpenRules,
  onEndTurn, canEndTurn,
  attackerCount, onConfirmAttackers, canAttack,
  inBlockers, onConfirmBlocks,
  turnDeadline, canForceEnd, onForceEnd,
}: {
  myTurn: boolean; turn: number; phase: string;
  myName: string; oppName: string;
  myProfile?: any; oppProfile?: any;
  onOpenRules: () => void;
  onEndTurn: () => void;
  canEndTurn: boolean;
  attackerCount: number;
  onConfirmAttackers: () => void;
  canAttack: boolean;
  inBlockers: boolean;
  onConfirmBlocks: () => void;
  turnDeadline: number;
  canForceEnd: boolean;
  onForceEnd: () => void;
}) {
  const mobile = useIsMobile();
  const short = useIsShort();
  const dotColor = myTurn ? '#298BFF' : '#E45F76';       // player blue / opponent red-violet
  const bannerAccent = myTurn ? '#FFD86A' : '#C45CFF';   // gold / violet illumination
  const headline = myTurn ? 'YOUR TURN' : "OPPONENT'S TURN";

  // 60-second auto-end-turn timer. Resets whenever turn/phase ownership changes.
  const TURN_LIMIT = 60;
  const [secondsLeft, setSecondsLeft] = useState(TURN_LIMIT);
  const firedRef = useRef(false);
  useEffect(() => {
    setSecondsLeft(TURN_LIMIT);
    firedRef.current = false;
  }, [turn, myTurn, canEndTurn]);
  useEffect(() => {
    if (!canEndTurn) return;
    const id = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          if (!firedRef.current) { firedRef.current = true; onEndTurn(); }
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [canEndTurn, onEndTurn]);

  const lowTime = canEndTurn && secondsLeft <= 10;
  const timerColor = lowTime ? '#ff5d73' : '#ffd76a';

  // AFK escape hatch — if it's the opponent's turn and the server deadline has
  // passed (plus a small grace window), any client may force-end their turn.
  // This prevents the game from soft-locking when the opponent disconnects.
  const [nowMs, setNowMs] = useState(Date.now());
  useEffect(() => {
    if (!canForceEnd || !turnDeadline) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [canForceEnd, turnDeadline]);
  const forceGraceMs = 5000;
  const oppMsLeft = canForceEnd && turnDeadline ? (turnDeadline + forceGraceMs) - nowMs : Infinity;
  const showForceBtn = canForceEnd && turnDeadline > 0 && oppMsLeft <= 0;
  const showForceCountdown = canForceEnd && turnDeadline > 0 && oppMsLeft > 0 && oppMsLeft <= 30_000;

  return (
    <div style={{
      position: 'relative',
      display: 'flex', alignItems: 'center', justifyContent: mobile ? 'center' : 'space-between',
      gap: mobile ? 8 : 12, borderRadius: 10,
      padding: mobile ? '8px 10px' : '9px 16px',
      // The host app pins its own control (Exit / close) to the top-right corner,
      // which used to sit on top of the banner's END TURN / help stud (desktop)
      // and the TURN chip (phones). Reserve that corner on both, and let the
      // right cluster wrap rather than squash on a narrow screen.
      paddingRight: mobile ? 110 : 118,
      flexWrap: mobile ? 'wrap' : 'nowrap',
      // Heraldic bar: stone ground, thin gold rules top and bottom.
      background:
        `linear-gradient(180deg, rgba(28,24,40,0.92) 0%, rgba(14,12,22,0.92) 48%, rgba(8,7,13,0.94) 100%)`,
      backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      border: `1px solid ${dotColor}44`,
      boxShadow: `inset 0 1px 0 rgba(255,226,160,0.10), inset 0 0 40px rgba(0,0,0,0.55), 0 0 20px ${dotColor}2e, 0 6px 20px rgba(0,0,0,0.55)`,
      transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
    }}>
      <span aria-hidden className="brd-rule" style={{ top: 3 }} />
      <span aria-hidden className="brd-rule" style={{ bottom: 3 }} />
      {!mobile && (
      <div style={{ fontSize: 11, color: '#9aa', fontWeight: 600, minWidth: short ? 0 : 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        VS <b style={{ color: '#fff' }}>{oppName}</b> <span style={{ opacity: 0.6 }}>({formatRecord(oppProfile)})</span>
      </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, textAlign: 'center', minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: mobile ? 8 : 12, flexWrap: 'wrap', justifyContent: 'center',
          fontFamily: '"Cinzel", "Times New Roman", serif', fontWeight: 800,
          fontSize: mobile ? 14 : short ? 16 : 20, letterSpacing: mobile ? 1.5 : 3,
          color: '#F4F2EA', textShadow: `0 0 16px ${bannerAccent}`,
        }}>
          <span aria-hidden style={{
            display: 'inline-block', width: 12, height: 12, borderRadius: '50%',
            background: dotColor, boxShadow: `0 0 12px ${dotColor}`,
            animation: 'pulse-dot 1.6s ease-in-out infinite',
          }} />
          {headline}
          <span style={{
            fontFamily: '"Cinzel", "Times New Roman", serif', fontWeight: 800, fontSize: 12,
            color: bannerAccent, letterSpacing: 1.6,
            padding: '2px 9px', borderRadius: 4,
            background: 'linear-gradient(180deg, rgba(0,0,0,0.5), rgba(0,0,0,0.28))',
            boxShadow: `inset 0 0 0 1px ${bannerAccent}44`,
          }}>TURN {turn}</span>
          {canEndTurn && (
            <span style={{
              fontFamily: 'system-ui', fontWeight: 800, fontSize: 13, letterSpacing: 1,
              color: timerColor, padding: '3px 9px', borderRadius: 5,
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: `linear-gradient(180deg, ${timerColor}26, ${timerColor}12)`,
              boxShadow: `inset 0 0 0 1px ${timerColor}66, inset 0 1px 0 rgba(255,255,255,0.12)`,
              animation: lowTime ? 'pulse-dot 0.8s ease-in-out infinite' : 'none',
            }} title="Auto-end-turn in"><Refresh size={12} /> {secondsLeft}s</span>
          )}
          {showForceCountdown && (
            <span style={{
              fontFamily: 'system-ui', fontWeight: 700, fontSize: 11, letterSpacing: 1,
              color: '#ffb84a', padding: '3px 9px', borderRadius: 5,
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: 'linear-gradient(180deg, #ffb84a26, #ffb84a12)',
              boxShadow: 'inset 0 0 0 1px #ffb84a55',
            }} title="Opponent has been thinking a long time — you'll be able to force-end their turn soon.">
              <Warning size={12} /> {Math.ceil(oppMsLeft / 1000)}s
            </span>
          )}
        </div>
        {/* Phase line — flanked by heraldic diamonds, current phase in gold. */}
        <div aria-live="polite" style={{
          fontFamily: '"Cinzel", "Times New Roman", serif', fontWeight: 700, fontSize: 10.5,
          color: '#989BB0', letterSpacing: 2, textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          <Diamond size={6} color={myTurn ? 'rgba(229,184,75,0.65)' : 'rgba(152,155,176,0.45)'} />
          {myTurn
            ? <>Your move · <b style={{ color: bannerAccent, textShadow: `0 0 10px ${bannerAccent}66`, letterSpacing: 2.4 }}>{phase.toUpperCase()}</b></>
            : 'Opponent is deciding…'}
          <Diamond size={6} color={myTurn ? 'rgba(229,184,75,0.65)' : 'rgba(152,155,176,0.45)'} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: mobile || short ? 0 : 160, justifyContent: 'flex-end' }}>
        {!mobile && (
        <span style={{ fontSize: 11, color: '#9aa', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <b style={{ color: '#fff' }}>{myName}</b> <span style={{ opacity: 0.6 }}>({formatRecord(myProfile)})</span>
        </span>
        )}
        {/* Phase buttons live in the MobileActionBar on phones — keep the banner compact there. */}
        {!mobile && canAttack && attackerCount > 0 && (
          <button onClick={onConfirmAttackers} title="Swing with selected attackers"
            className="brd-plate brd-plate--crimson brd-plate--sm"
            style={{ padding: '7px 13px' }}
          ><Swords size={13} /> ATTACK ({attackerCount})</button>
        )}
        {!mobile && inBlockers && (
          <button onClick={onConfirmBlocks} title="Lock in blockers and resolve combat"
            className="brd-plate brd-plate--steel brd-plate--sm"
            style={{ padding: '7px 13px' }}
          ><Shield size={13} /> CONFIRM BLOCKS</button>
        )}
        {!mobile && canEndTurn && (
          <button onClick={onEndTurn} title="End your turn (auto-ends at 0s)"
            className="brd-plate brd-plate--gold brd-plate--sm"
            style={{ padding: '7px 13px' }}
          >END TURN</button>
        )}
        {showForceBtn && (
          <button onClick={onForceEnd} title="Opponent appears stuck or disconnected — force-end their turn."
            className="brd-plate brd-plate--crimson brd-plate--sm"
            style={{ padding: mobile ? '10px 14px' : '7px 13px', minHeight: mobile ? 44 : undefined }}
          ><Bolt size={13} /> FORCE END</button>
        )}
        {/* Phones get the help stud in the MobileActionBar instead — keeping it
            here made the banner wrap under the host app's top-right control. */}
        {!mobile && (
          <button onClick={onOpenRules} title="How to play" aria-label="How to play"
            className="brd-stud"
            style={{
              width: 30, height: 30, flex: '0 0 auto',
              fontFamily: '"Cinzel", "Times New Roman", serif',
              fontWeight: 800, fontSize: 14, lineHeight: 1,
            }}>?</button>
        )}
      </div>
    </div>
  );
}

/** Slide-in rules drawer launched by the floating ? button. */
function RulesDrawer({ onClose }: { onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
    }}>
      <div onClick={e => e.stopPropagation()} className="brd-scroll" style={{
        width: 'min(720px, 100%)', height: '100%',
        background: 'linear-gradient(180deg, #15101e, #0a0710)',
        borderLeft: '1px solid #ffd76a55',
        boxShadow: '-12px 0 32px #000c',
        overflowY: 'auto',
        padding: 20,
        paddingBottom: 'calc(20px + env(safe-area-inset-bottom))',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{
            fontFamily: '"Cinzel", "Times New Roman", serif',
            fontSize: 22, fontWeight: 800, color: '#ffd76a', letterSpacing: 2,
          }}>HOW TO PLAY</div>
          <button onClick={onClose} className="brd-glyph-btn" aria-label="Close rules" title="Close rules"
            style={{ padding: '7px 12px', minHeight: 36, minWidth: 40 }}><Close size={17} /></button>
        </div>
        <div style={{
          borderRadius: 10, overflow: 'hidden',
          border: '1px solid #ffd76a55',
          boxShadow: '0 0 24px rgba(212,175,55,0.18)',
          background: '#000',
        }}>
          <video
            src="/rules-intro.mp4"
            controls
            playsInline
            preload="metadata"
            style={{ display: 'block', width: '100%', height: 'auto' }}
          />
        </div>
        <RulesPanel side="left" />
        <RulesPanel side="right" />
      </div>
    </div>
  );
}

// Mini-card width relative to the playmat container (cqw): steps down on a
// phone mat and back up again when the MobileZoom wrapper widens it. Height
// follows via aspect-ratio.
//
// The second term is a HEIGHT budget expressed in cqw. The mat is square, so
// 1cqw == 1% of the mat's height too; the shortest zones (Machines at 17% of
// the mat, Nodes/Deck/Graveyard at 18%) leave `0.17 * mat - 22px` of usable
// room once the label row and padding are removed. A card is 96/68 ≈ 1.41×
// its width, so `10.8cqw - 13px` keeps it inside that budget (with room
// left for the tapped tilt and the hover lift). Without it a
// full-width card was ~2px taller than the Nodes zone at rest and ~9px taller
// on hover — it got sliced off by the zone's `overflow: hidden` and read as
// "the card is behind the board".
const MINI_W = 'clamp(26px, min(9.5cqw, 10.8cqw - 13px), 66px)';
const MINI_BACK_W = 'clamp(34px, 6.7cqw, 48px)';

function MiniCard({
  defId, instance, faceUp, faceDown, onClick, selected, targetable, footer, pumpBonus, blocked,
}: {
  defId?: string; instance?: Instance;
  faceUp?: boolean; faceDown?: boolean;
  onClick?: () => void; selected?: boolean; targetable?: boolean;
  footer?: React.ReactNode;
  pumpBonus?: number;
  /** This attacker has at least one blocker assigned — tinted steel-blue. */
  blocked?: boolean;
}) {
  if (faceDown || !defId) {
    return (
      <div style={{
        width: MINI_BACK_W, aspectRatio: '48 / 68', borderRadius: 5,
        background:
          'repeating-linear-gradient(45deg, rgba(255,255,255,0.05) 0 4px, rgba(255,255,255,0) 4px 8px), ' +
          'linear-gradient(180deg, #2a2440 0%, #171326 58%, #0d0b16 100%)',
        border: '1px solid rgba(0,0,0,0.85)',
        boxShadow:
          'inset 0 0 0 1px rgba(229,184,75,0.22), inset 0 1px 0 rgba(255,255,255,0.12), ' +
          '0 1px 2px rgba(0,0,0,0.65), 0 5px 12px rgba(0,0,0,0.45)',
        flex: '0 0 auto',
      }} />
    );
  }
  const def = CARDS[defId];
  if (!def) return null;
  const meta = COLOR_META[def.color];
  const tapped = !!instance?.tapped;
  const sick = !!instance?.summoningSick && def.type === 'meme';
  const damaged = (instance?.damage ?? 0) > 0;
  // Layered rest shadow so cards visibly sit *above* the mat rather than on it.
  const restShadow = selected
    ? 'inset 0 0 0 1px rgba(255,246,214,0.5), 0 0 20px rgba(255,216,106,0.85), 0 3px 8px rgba(0,0,0,0.7)'
    : blocked
      ? 'inset 0 0 0 1px rgba(143,211,255,0.45), 0 0 12px rgba(143,211,255,0.45), 0 3px 8px rgba(0,0,0,0.65)'
      : tapped
        ? 'inset 0 0 10px rgba(0,0,0,0.65), 0 1px 3px rgba(0,0,0,0.7)'
        : '0 1px 2px rgba(0,0,0,0.7), 0 4px 9px rgba(0,0,0,0.5), 0 9px 20px rgba(0,0,0,0.3)';
  const vars: Vars = {
    '--rot': tapped ? '6deg' : '0deg',
    '--shadow': restShadow,
    '--glow': `${meta.hex}bb`,
    '--filter': tapped ? 'saturate(0.5) brightness(0.78)' : 'none',
  };
  const title = sick
    ? `${def.name} — summoning sick, cannot attack this turn`
    : tapped ? `${def.name} — tapped` : def.name;
  return (
    <CardHover defId={defId}>
    <div onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={title}
      onKeyDown={onClick ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }) : undefined}
      className={`brd-mini${targetable ? ' brd-targetable' : ''}`}
      style={{
        ...vars,
        width: MINI_W, aspectRatio: '68 / 96', padding: 3, borderRadius: 6,
        background: meta.hex, color: meta.ink,
        // Attacker/selected: solid gold ring. Targetable: dashed gold + pulse.
        border: selected ? '2px solid #FFD86A' : targetable ? '2px dashed #FFD86A' : '1px solid rgba(0,0,0,0.85)',
        cursor: onClick ? 'pointer' : 'default',
        opacity: sick ? 0.66 : 1,
        display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
        fontFamily: 'system-ui',
        position: 'relative',
        flex: '0 0 auto',
      }}>
      <div style={{
        fontSize: 8, fontWeight: 800, lineHeight: 1.0, overflow: 'hidden',
        position: 'relative', zIndex: 2, textShadow: '0 1px 0 rgba(255,255,255,0.22)',
      }}>{def.name}</div>
      {def.power != null && def.toughness != null && (() => {
        const bonus = pumpBonus ?? 0;
        const pow = (def.power ?? 0) + bonus;
        const tou = (def.toughness ?? 1) + bonus - (instance?.damage ?? 0);
        return (
          <div style={{
            fontSize: 10, fontWeight: 800, alignSelf: 'flex-end',
            position: 'relative', zIndex: 2,
            background: 'linear-gradient(180deg, rgba(18,14,8,0.86), rgba(6,5,3,0.92))',
            padding: '0 4px', borderRadius: 3,
            boxShadow: 'inset 0 0 0 1px rgba(229,184,75,0.4)',
            color: bonus > 0 ? '#7CFC7C' : '#F4F2EA',
            textShadow: bonus > 0 ? '0 0 5px rgba(0,255,0,0.7)' : '0 1px 2px rgba(0,0,0,0.8)',
          }}>
            {pow}/{tou}
          </div>
        );
      })()}
      {footer && <div style={{ fontSize: 7, lineHeight: 1.0, position: 'relative', zIndex: 2 }}>{footer}</div>}
      {sick && (
        <span aria-hidden style={{
          position: 'absolute', top: 2, left: 2, zIndex: 2,
          display: 'grid', placeItems: 'center', color: '#FFD86A',
          filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.95))',
        }}><Moon size={10} /></span>
      )}
      {damaged && <span aria-hidden className="brd-damaged" />}
      <span aria-hidden className="brd-gloss" />
    </div>
    </CardHover>
  );
}

function Side({
  title, side, deckCount, face,
  onNodeClick, onMemeClick, onMachineClick,
  memeTargetable, machineTargetable,
  attackingUids, blocks, selectedBlocker,
}: {
  title: string;
  side: GState['players'][string];
  deckCount: number;
  face: 'up' | 'down';
  onNodeClick?: (uid: string) => void;
  onMemeClick?: (uid: string) => void;
  onMachineClick?: (uid: string) => void;
  memeTargetable?: boolean;
  machineTargetable?: boolean;
  attackingUids?: string[];
  blocks?: Record<string, string[]>;
  selectedBlocker?: string;
}) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{title} — Hand: {side.hand.length} · Deck: {deckCount} · Graveyard: {side.graveyard.length}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        <Zone label="Nodes"    instances={side.nodes}    onClick={onNodeClick} />
        <Zone label="Memes"    instances={side.memes}
          onClick={onMemeClick}
          highlightUids={attackingUids}
          selectedUid={selectedBlocker}
          targetable={memeTargetable}
          blocks={blocks}
        />
        <Zone label="Machines" instances={side.machines}
          onClick={onMachineClick}
          targetable={machineTargetable}
        />
      </div>
    </div>
  );
}

function Zone({
  label, instances, onClick,
  highlightUids = [], selectedUid, targetable, blocks,
}: {
  label: string;
  instances: Instance[];
  onClick?: (uid: string) => void;
  highlightUids?: string[];
  selectedUid?: string;
  targetable?: boolean;
  blocks?: Record<string, string[]>;
}) {
  return (
    <div style={{ flex: 1, minWidth: 240, padding: 4, border: '1px solid #333' }}>
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 2 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        {instances.length === 0 && <div style={{ fontSize: 11, opacity: 0.4 }}>—</div>}
        {instances.map(inst => {
          const attacking = highlightUids.includes(inst.uid);
          const blockedBy = blocks?.[inst.uid] ?? [];
          return (
            <div key={inst.uid} style={{ position: 'relative' }}>
              <CardFace
                defId={inst.defId}
                instance={inst}
                selected={inst.uid === selectedUid || attacking}
                onClick={onClick ? () => onClick(inst.uid) : undefined}
                footer={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ opacity: 0.6 }}>{inst.uid}</span>
                    <CombatBadges attacking={attacking} blockedCount={blockedBy.length} />
                  </span>
                }
              />
              {targetable && <div style={{
                position: 'absolute', inset: 0, border: '2px dashed #ff0', pointerEvents: 'none',
              }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CombatStrip({ G, ctx, myId }: { G: GState; ctx: any; myId: string }) {
  const mobile = useIsMobile();
  // Phones: "No combat in progress." is a whole line of chrome that says
  // nothing. Render it only where there is room for it.
  if (G.combat.attackers.length === 0) {
    return mobile ? null : <div style={{ fontSize: 12, opacity: 0.5, flex: '0 0 auto' }}>No combat in progress.</div>;
  }
  return (
    <div style={{ flex: '0 0 auto', padding: '6px 10px', background: 'rgba(18,18,31,0.8)', border: '1px solid rgba(228,95,118,0.4)', borderRadius: 8 }}>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
        Combat — attacker: P{ctx.currentPlayer}
      </div>
      {G.combat.attackers.map(a => (
        <div key={a.memeUid} style={{ fontSize: 12 }}>
          Attacker <b>{a.memeUid}</b> blocked by: {G.combat.blocks[a.memeUid]?.join(', ') || '(none)'}
        </div>
      ))}
    </div>
  );
}
