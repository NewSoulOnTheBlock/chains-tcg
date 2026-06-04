// src/CardPreview.tsx
// Large card preview + hover/long-press wrapper. Used both in-game and in the
// deckbuilder so any card can be reviewed at full size.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { CARDS, COLOR_META, COLORS, templateFor, type Color, type CardDef } from './cards';

const PREVIEW_W = 280;
const PREVIEW_H = 400;

export function CardPreview({ def }: { def: CardDef }) {
  const meta = COLOR_META[def.color];
  const tpl = templateFor(def);
  if (tpl) return <TemplatedPreview def={def} tpl={tpl} />;
  return (
    <div style={{
      width: PREVIEW_W, height: PREVIEW_H,
      background: meta.hex, color: meta.ink,
      border: '2px solid #000', borderRadius: 12,
      padding: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.75)',
      fontFamily: 'system-ui, sans-serif',
      display: 'flex', flexDirection: 'column', gap: 8,
      pointerEvents: 'none',
    }}>
      {/* Title bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontWeight: 800, fontSize: 18, lineHeight: 1.1 }}>{def.name}</div>
        {def.cost && (
          <div style={{ display: 'flex', gap: 4 }}>
            {(['any', ...COLORS] as const).map(c => {
              const n = def.cost?.[c] ?? 0; if (!n) return null;
              const cm = c === 'any' ? { hex: '#c8c8d0', ink: '#1a1a1a' } : COLOR_META[c];
              return (
                <span key={c} style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 22, height: 22, borderRadius: 11,
                  background: cm.hex, color: cm.ink,
                  border: '1px solid #0007', fontWeight: 800, fontSize: 12,
                }}>{n}</span>
              );
            })}
          </div>
        )}
      </div>

      {/* Type line */}
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: 1,
        textTransform: 'uppercase', opacity: 0.85,
        borderBottom: '1px solid #0003', paddingBottom: 4,
      }}>
        {def.type} · {meta.name}
      </div>

      {/* Effect text */}
      <div style={{
        flex: 1,
        background: 'rgba(255,255,255,0.18)',
        border: '1px solid #0002',
        borderRadius: 6, padding: 10,
        fontSize: 13, lineHeight: 1.4,
        overflowY: 'auto', whiteSpace: 'pre-wrap',
      }}>
        {def.text || (def.type === 'meme' ? `A ${def.power}/${def.toughness} ${meta.name} meme.` : '—')}
      </div>

      {/* Footer: P/T for memes */}
      {def.type === 'meme' && (
        <div style={{
          alignSelf: 'flex-end', fontWeight: 800, fontSize: 22, lineHeight: 1,
          padding: '4px 10px', background: 'rgba(0,0,0,0.25)', borderRadius: 6,
          color: '#fff', textShadow: '0 1px 2px #000',
        }}>
          {def.power}/{def.toughness}
        </div>
      )}
    </div>
  );
}

/**
 * Templated frame preview — renders content into the slots of a MTG-style
 * frame image (currently used by Hyperliquid and BnB). Selected via
 * COLOR_META[color].template.
 */
export function TemplatedPreview({ def, tpl }: { def: CardDef; tpl: { url: string; glyph?: string } }) {
  const meta = COLOR_META[def.color];
  return (
    <div style={{
      position: 'relative', width: PREVIEW_W, height: PREVIEW_H,
      backgroundImage: `url(${tpl.url})`,
      backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
      borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.75)',
      fontFamily: 'system-ui, sans-serif', color: '#1a1a1a',
      pointerEvents: 'none',
    }}>
      {/* Title bar */}
      <div style={{
        position: 'absolute', top: '5.6%', left: '9%', right: '9%', height: '5%',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 8px', gap: 6,
      }}>
        <div style={{ fontWeight: 800, fontSize: 14, color: '#1a1a1a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {def.name}
        </div>
        {def.cost && (
          <div style={{ display: 'flex', gap: 3 }}>
            {(['any', ...COLORS] as const).map(c => {
              const n = def.cost?.[c] ?? 0; if (!n) return null;
              const cm = c === 'any' ? { hex: '#c8c8d0', ink: '#1a1a1a' } : COLOR_META[c];
              return (
                <span key={c} style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 18, height: 18, borderRadius: 9,
                  background: cm.hex, color: cm.ink,
                  border: '1px solid #0007', fontWeight: 800, fontSize: 11,
                }}>{n}</span>
              );
            })}
          </div>
        )}
      </div>

      {/* Art area — image sits inside the template's black window (no overlay backdrop) */}
      <div style={{
        position: 'absolute', top: '13%', left: '8.5%', right: '8.5%', height: '44%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {def.image ? (
          <img src={def.image} alt={def.name} loading="lazy" draggable={false}
            onDragStart={e => e.preventDefault()}
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            style={{ width: '100%', height: '100%', objectFit: 'cover', WebkitUserDrag: 'none', userSelect: 'none', pointerEvents: 'none' } as React.CSSProperties} />
        ) : (
          <div style={{
            fontWeight: 900, color: meta.ink,
            fontSize: (tpl.glyph ?? meta.glyph ?? meta.name).length > 4 ? 32 : 56,
            letterSpacing: (tpl.glyph ?? meta.glyph ?? meta.name).length > 4 ? 2 : 4,
            textShadow: '0 3px 10px #000',
          }}>
            {tpl.glyph ?? meta.glyph ?? meta.name}
          </div>
        )}
      </div>

      {/* Type bar */}
      <div style={{
        position: 'absolute', top: '58.5%', left: '9%', right: '9%', height: '4.5%',
        display: 'flex', alignItems: 'center', padding: '0 8px',
        fontSize: 11, fontWeight: 700, color: '#1a1a1a', letterSpacing: 1, textTransform: 'uppercase',
      }}>
        {def.type} · {meta.name}
      </div>

      {/* Text box */}
      <div style={{
        position: 'absolute', top: '67%', left: '9%', right: '9%', bottom: '7%',
        padding: '8px 10px',
        fontSize: 12, lineHeight: 1.35, color: '#1a1a1a',
        overflow: 'hidden',
      }}>
        {def.text || (def.type === 'meme' ? `A ${def.power}/${def.toughness} ${meta.name} meme.` : '—')}
        {def.type === 'meme' && (
          <div style={{
            position: 'absolute', right: 12, bottom: 6,
            fontWeight: 800, fontSize: 20, color: '#1a1a1a',
            padding: '2px 8px', background: '#e8e6c8',
            border: '1px solid #4a5a3a', borderRadius: 4,
          }}>
            {def.power}/{def.toughness}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Wrapper that shows a CardPreview on hover (desktop) or tap-to-pin (touch).
 *
 * Touch behaviour: a short tap pins a centered lightbox preview instead of
 * firing the child's onClick. The lightbox offers an explicit "Play" button
 * which calls `onActivate` — eliminating the "I tapped a card and accidentally
 * cast it" misclick. A long-press still shows the floating preview at the
 * touch point for parity with the old behaviour.
 *
 * Desktop behaviour is unchanged (hover preview, child onClick fires normally).
 */
export function CardHover({
  defId, children, openDelay = 220, onActivate, activateLabel = 'Play', pinOnTap = false,
}: {
  defId: string | null | undefined;
  children: React.ReactNode;
  openDelay?: number;
  onActivate?: () => void;
  activateLabel?: string;
  /** When true, a short touch tap pins a centered lightbox instead of firing the child's onClick. */
  pinOnTap?: boolean;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState(false);
  const openT = useRef<number | null>(null);
  const longT = useRef<number | null>(null);

  const def = defId ? CARDS[defId] : null;

  const clear = useCallback(() => {
    if (openT.current) { window.clearTimeout(openT.current); openT.current = null; }
    if (longT.current) { window.clearTimeout(longT.current); longT.current = null; }
  }, []);

  const onMouseEnter = (e: React.MouseEvent) => {
    if (!def) return;
    const { clientX, clientY } = e;
    clear();
    openT.current = window.setTimeout(() => setPos({ x: clientX, y: clientY }), openDelay);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (pos) setPos({ x: e.clientX, y: e.clientY });
  };
  const onMouseLeave = () => { clear(); setPos(null); };

  // Touch: tap-to-pin (short tap → lightbox), long-press → floating preview.
  const startPt = useRef<{ x: number; y: number; t: number } | null>(null);
  const longFired = useRef(false);
  const onTouchStart = (e: React.TouchEvent) => {
    if (!def) return;
    const t = e.touches[0];
    startPt.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    longFired.current = false;
    clear();
    longT.current = window.setTimeout(() => {
      longFired.current = true;
      setPos({ x: t.clientX, y: t.clientY });
    }, 350);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!longT.current || !startPt.current) return;
    const t = e.touches[0];
    const dx = t.clientX - startPt.current.x;
    const dy = t.clientY - startPt.current.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clear();
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = startPt.current;
    clear();
    if (!start || !def) return;
    const elapsed = Date.now() - start.t;
    // Short, deliberate tap that didn't trigger long-press → pin lightbox and
    // suppress the synthetic click that would have played the card.
    if (!longFired.current && elapsed < 350 && pinOnTap) {
      e.preventDefault();
      e.stopPropagation();
      setPinned(true);
      setPos(null);
    }
  };

  useEffect(() => {
    if (!pos) return;
    const onDocTouch = (e: TouchEvent) => {
      if ((e.target as HTMLElement)?.dataset?.cardpreview !== '1') setPos(null);
    };
    document.addEventListener('touchstart', onDocTouch, { passive: true });
    return () => document.removeEventListener('touchstart', onDocTouch);
  }, [pos]);

  useEffect(() => () => clear(), [clear]);

  return (
    <span
      onMouseEnter={onMouseEnter}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ display: 'inline-block', verticalAlign: 'top' }}
    >
      {children}
      {pos && def && (
        <FloatingPreview x={pos.x} y={pos.y}>
          <CardPreview def={def} />
        </FloatingPreview>
      )}
      {pinned && def && (
        <PinnedPreview
          def={def}
          onClose={() => setPinned(false)}
          onActivate={onActivate ? () => { setPinned(false); onActivate(); } : undefined}
          activateLabel={activateLabel}
        />
      )}
    </span>
  );
}

function PinnedPreview({
  def, onClose, onActivate, activateLabel,
}: {
  def: any;
  onClose: () => void;
  onActivate?: () => void;
  activateLabel: string;
}) {
  // Centered lightbox over a dim backdrop. Tapping the backdrop dismisses.
  return createPortal(
    <div
      data-cardpreview="1"
      onClick={onClose}
      onTouchStart={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.72)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 14, padding: 16,
      }}
    >
      <div data-cardpreview="1" onClick={(e) => e.stopPropagation()}>
        <CardPreview def={def} />
      </div>
      <div data-cardpreview="1" style={{ display: 'flex', gap: 10 }} onClick={(e) => e.stopPropagation()}>
        {onActivate && (
          <button
            onClick={onActivate}
            style={{
              background: '#6c4bd8', color: '#fff', border: 'none',
              borderRadius: 8, padding: '12px 22px', fontWeight: 700,
              fontSize: 16, cursor: 'pointer',
            }}
          >{activateLabel}</button>
        )}
        <button
          onClick={onClose}
          style={{
            background: '#2a2a3e', color: '#fff', border: '1px solid #555',
            borderRadius: 8, padding: '12px 22px', fontWeight: 600,
            fontSize: 16, cursor: 'pointer',
          }}
        >Close</button>
      </div>
    </div>,
    document.body
  );
}

function FloatingPreview({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  // Clamp to viewport so the preview is always fully visible.
  const margin = 8;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  let left = x + 18;
  let top = y + 18;
  if (left + PREVIEW_W + margin > vw) left = x - PREVIEW_W - 18;
  if (left < margin) left = margin;
  if (top + PREVIEW_H + margin > vh) top = vh - PREVIEW_H - margin;
  if (top < margin) top = margin;
  if (typeof document === 'undefined') return null;
  // Portal to <body> so we escape any ancestor `transform` (e.g. the opponent's
  // 180°-rotated zone), which would otherwise reparent `position: fixed` and
  // display the preview upside-down.
  return createPortal(
    <div
      data-cardpreview="1"
      style={{ position: 'fixed', left, top, zIndex: 9999, pointerEvents: 'none' }}
    >
      {children}
    </div>,
    document.body,
  );
}
