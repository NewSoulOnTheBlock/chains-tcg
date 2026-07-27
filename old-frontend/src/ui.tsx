// src/ui.tsx
// Reusable UI primitives for the modern-refresh look, built on src/theme.ts.
// A single injected stylesheet gives real :hover / :active / :focus-visible
// states (impossible with inline styles alone). Components accept `style`
// overrides so they drop into the existing inline-styled screens.

import React from 'react';
import { color, font, radius, shadow, motion } from './theme';

const CSS = `
.ocva-btn {
  --sh: ${shadow.sm};
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  font-family: ${font.body}; font-weight: 700; font-size: 14px; letter-spacing: 0.01em;
  padding: 11px 18px; border-radius: ${radius.md}px; border: 1px solid transparent;
  cursor: pointer; user-select: none; white-space: nowrap;
  transition: transform ${motion.fast}, background ${motion.base}, border-color ${motion.base}, box-shadow ${motion.base}, filter ${motion.base};
  box-shadow: var(--sh);
}
.ocva-btn:active { transform: translateY(1px) scale(0.99); }
.ocva-btn:focus-visible { outline: 2px solid ${color.accentHi}; outline-offset: 2px; }
.ocva-btn[disabled] { opacity: 0.45; cursor: not-allowed; box-shadow: none; }

.ocva-btn--primary { background: linear-gradient(135deg, ${color.accent}, ${color.accentHi}); color: #fff; --sh: ${shadow.glow}; }
.ocva-btn--primary:hover:not([disabled]) { filter: brightness(1.08); box-shadow: 0 0 34px rgba(124,92,255,0.5); }

.ocva-btn--gold { background: linear-gradient(135deg, ${color.gold}, ${color.goldHi}); color: #1a1408; --sh: ${shadow.glowGold}; }
.ocva-btn--gold:hover:not([disabled]) { filter: brightness(1.06); }

.ocva-btn--secondary { background: ${color.bg2}; color: ${color.textHi}; border-color: ${color.borderStrong}; }
.ocva-btn--secondary:hover:not([disabled]) { background: ${color.bg3}; border-color: ${color.accent}; }

.ocva-btn--ghost { background: transparent; color: ${color.textMid}; box-shadow: none; }
.ocva-btn--ghost:hover:not([disabled]) { background: rgba(255,255,255,0.06); color: ${color.textHi}; }

.ocva-card {
  background: ${color.bg2}; border: 1px solid ${color.border}; border-radius: ${radius.lg}px;
  box-shadow: ${shadow.md};
  transition: transform ${motion.base}, border-color ${motion.base}, box-shadow ${motion.base};
}
.ocva-card--hover:hover { transform: translateY(-3px); border-color: ${color.borderStrong}; box-shadow: ${shadow.lg}; }

.ocva-panel {
  background: ${color.bg1}; border: 1px solid ${color.border}; border-radius: ${radius.xl}px;
  box-shadow: ${shadow.lg};
}
.ocva-input {
  width: 100%; font-family: ${font.body}; font-size: 14px; color: ${color.textHi};
  background: ${color.bg0}; border: 1px solid ${color.borderStrong}; border-radius: ${radius.md}px;
  padding: 11px 14px; outline: none; transition: border-color ${motion.base}, box-shadow ${motion.base};
}
.ocva-input::placeholder { color: ${color.textLo}; }
.ocva-input:focus { border-color: ${color.accent}; box-shadow: 0 0 0 3px ${color.accentDim}; }

/* Transparent clickable hotspot overlaid on splash artwork (login + hub). */
.ova-hot { position:absolute; z-index:3; background:transparent; border:2px solid transparent; border-radius:14px;
  cursor:pointer; padding:0; transition: background ${motion.fast}, border-color ${motion.fast}, box-shadow ${motion.fast}; }
.ova-hot:hover:not([disabled]) { background: rgba(160,120,255,0.14); border-color: rgba(160,120,255,0.6); box-shadow: 0 0 26px rgba(124,92,255,0.45); }
.ova-hot:focus-visible { outline:2px solid ${color.accentHi}; outline-offset:2px; }
.ova-hot[disabled] { cursor: wait; }

/* Real overlaid menu item (used over a clean splash background). */
.ova-menu-item { display:flex; align-items:center; gap:12px; width:100%; text-align:left; cursor:pointer;
  padding:11px 14px; border-radius:10px; font-family:${font.body}; font-weight:700; font-size:13.5px;
  letter-spacing:0.04em; color:${color.textHi}; background:rgba(12,10,26,0.72); border:1px solid ${color.border};
  backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
  transition: background ${motion.fast}, border-color ${motion.fast}, transform ${motion.fast}, box-shadow ${motion.fast}; }
.ova-menu-item:hover { background:rgba(30,24,60,0.82); border-color:${color.borderStrong}; transform:translateX(3px); }
.ova-menu-item:active { transform:translateX(1px) scale(0.99); }
.ova-menu-item:focus-visible { outline:2px solid ${color.accentHi}; outline-offset:2px; }
.ova-menu-item .ova-menu-ico { flex:0 0 auto; color:${color.textMid}; display:flex; }
.ova-menu-item--primary { background:linear-gradient(135deg, rgba(124,92,255,0.9), rgba(124,92,255,0.55));
  border-color:${color.accent}; box-shadow:0 0 24px rgba(124,92,255,0.5); color:#fff; }
.ova-menu-item--primary:hover { filter:brightness(1.08); }
.ova-menu-item--primary .ova-menu-ico { color:#fff; }
`;

if (typeof document !== 'undefined' && !document.getElementById('ocva-theme')) {
  const el = document.createElement('style');
  el.id = 'ocva-theme';
  el.textContent = CSS;
  document.head.appendChild(el);
}

// Global menu click SFX: play a short sound whenever a menu / UI button is pressed.
// Scoped to our UI-primitive classes so in-game board controls stay silent.
if (typeof document !== 'undefined' && !(window as any).__ocvaClickSfx) {
  (window as any).__ocvaClickSfx = true;
  document.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.('.ova-menu-item, .ova-hot, .ocva-btn');
    if (!el || (el as HTMLButtonElement).disabled) return;
    try {
      const a = new Audio('/click.mp3');
      a.volume = 0.45;
      a.play().catch(() => {});
    } catch { /* noop */ }
  }, true);
}

type BtnVariant = 'primary' | 'gold' | 'secondary' | 'ghost';

export function Button(
  { variant = 'primary', className = '', style, ...rest }:
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant },
) {
  return <button className={`ocva-btn ocva-btn--${variant} ${className}`} style={style} {...rest} />;
}

export function Card(
  { hover, className = '', style, ...rest }:
  React.HTMLAttributes<HTMLDivElement> & { hover?: boolean },
) {
  return <div className={`ocva-card ${hover ? 'ocva-card--hover' : ''} ${className}`} style={{ padding: 20, ...style }} {...rest} />;
}

export function Panel(
  { className = '', style, ...rest }: React.HTMLAttributes<HTMLDivElement>,
) {
  return <div className={`ocva-panel ${className}`} style={{ padding: 24, ...style }} {...rest} />;
}

export function Input(
  { className = '', ...rest }: React.InputHTMLAttributes<HTMLInputElement>,
) {
  return <input className={`ocva-input ${className}`} {...rest} />;
}

/** Small uppercase, letter-spaced eyebrow label. */
export function SectionLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontFamily: font.body, fontSize: 11, fontWeight: 700, letterSpacing: '0.16em',
      textTransform: 'uppercase', color: color.textLo, ...style,
    }}>{children}</div>
  );
}
