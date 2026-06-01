// src/CardPreview.tsx
// Large card preview + hover/long-press wrapper. Used both in-game and in the
// deckbuilder so any card can be reviewed at full size.
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CARDS, COLOR_META, COLORS, type Color, type CardDef } from './cards';

const PREVIEW_W = 280;
const PREVIEW_H = 400;

export function CardPreview({ def }: { def: CardDef }) {
  const meta = COLOR_META[def.color];
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
            {COLORS.map(c => {
              const n = def.cost?.[c] ?? 0; if (!n) return null;
              const cm = COLOR_META[c];
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
 * Wrapper that shows a CardPreview on hover (desktop) or long-press (touch).
 * Renders the child inline; the preview is a fixed-position floating element.
 */
export function CardHover({
  defId, children, openDelay = 220,
}: {
  defId: string | null | undefined;
  children: React.ReactNode;
  openDelay?: number;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
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

  // Long-press for touch
  const onTouchStart = (e: React.TouchEvent) => {
    if (!def) return;
    const t = e.touches[0];
    clear();
    longT.current = window.setTimeout(() => {
      setPos({ x: t.clientX, y: t.clientY });
    }, 350);
  };
  const onTouchEnd = () => { clear(); /* keep preview until tap outside */ };

  useEffect(() => {
    if (!pos) return;
    const onDocTouch = (e: TouchEvent) => {
      // Dismiss touch preview when user taps elsewhere
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
      onTouchEnd={onTouchEnd}
      style={{ display: 'contents' }}
    >
      {children}
      {pos && def && (
        <FloatingPreview x={pos.x} y={pos.y}>
          <CardPreview def={def} />
        </FloatingPreview>
      )}
    </span>
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
  return (
    <div
      data-cardpreview="1"
      style={{ position: 'fixed', left, top, zIndex: 9999, pointerEvents: 'none' }}
    >
      {children}
    </div>
  );
}
