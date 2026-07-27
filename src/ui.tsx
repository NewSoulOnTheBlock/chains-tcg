// src/ui.tsx
// Reusable UI primitives for the modern-medieval look, built on src/theme.ts.
// A single injected stylesheet gives real :hover / :active / :focus-visible
// states (impossible with inline styles alone). Components accept `style`
// overrides so they drop into the existing inline-styled screens.
//
// The visual language is "forged metal on obsidian": beveled gold/amethyst
// plates for calls to action, engraved gold hairlines on obsidian panels, and
// sparing diamond ornaments. Everything is expressed as classes here so the
// inline-styled screens can opt in by adding a className rather than being
// restructured.

import React from 'react';
import { color, font, radius, shadow, motion, focusRing, surface, edge, depth } from './theme';

const CSS = `
/* Consistent gold keyboard-focus ring on every interactive element.
   :where() keeps specificity at zero so component-specific focus styles win. */
:where(button, a, select, textarea, [role="button"], [tabindex]):focus-visible {
  outline: ${focusRing.outline};
  outline-offset: ${focusRing.offset};
}

/* Comfortable touch targets on touch devices for the shared primitives. */
@media (pointer: coarse) {
  .ocva-btn, .ova-menu-item, .ova-plate, .ova-chip { min-height: 44px; }
  .ocva-input { min-height: 44px; }
}

/* Small shared utilities (used across App.tsx screens). */
.ocva-truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ocva-scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; }

/* ── User-chosen "reduce motion" ──────────────────────────────────────────
   index.html already neutralises animation for OS-level
   \`prefers-reduced-motion: reduce\`. This mirrors that guard for the in-app
   preference (Settings -> Display), which stamps data-reduced-motion="1" on
   <html>. Same declarations, so both paths behave identically. */
:root[data-reduced-motion="1"] *,
:root[data-reduced-motion="1"] *::before,
:root[data-reduced-motion="1"] *::after {
  animation-duration: 0.01ms !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0.01ms !important;
  scroll-behavior: auto !important;
}
/* The named animation hooks each screen already guards on the media query. */
:root[data-reduced-motion="1"] .menu-anim,
:root[data-reduced-motion="1"] .hub-anim,
:root[data-reduced-motion="1"] .rb-anim,
:root[data-reduced-motion="1"] .ml-anim,
:root[data-reduced-motion="1"] .ovp-field,
:root[data-reduced-motion="1"] .ovp-primary {
  animation: none !important;
  transition: none !important;
}
`;

// ── Forged-plate button language ─────────────────────────────────────────────
// Every plate shares the same anatomy: a vertical metal gradient, a darker
// outer edge, a bright inset top highlight + dark inset bottom shadow (the
// bevel), a warm outer glow on hover, and an :active state that visually sinks.
const PLATES = `
.ova-plate {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  padding: 12px 22px; border-radius: 10px;
  font-family: ${font.serif}; font-weight: 700; font-size: 14px;
  letter-spacing: 0.14em; text-transform: uppercase;
  cursor: pointer; user-select: none; white-space: nowrap; isolation: isolate;
  border: 1px solid ${edge.bronze};
  transition:
    transform 160ms cubic-bezier(0.2,0.8,0.2,1),
    filter 160ms cubic-bezier(0.2,0.8,0.2,1),
    box-shadow 180ms cubic-bezier(0.2,0.8,0.2,1),
    border-color 180ms cubic-bezier(0.2,0.8,0.2,1),
    background 180ms cubic-bezier(0.2,0.8,0.2,1);
}
/* Chamfer: a hairline frame inset 3px reads as a bevelled, notched plate edge
   without clip-path (which would eat the outer glow). */
.ova-plate::after {
  content: ''; position: absolute; inset: 3px; border-radius: 7px; pointer-events: none;
  border: 1px solid rgba(255,255,255,0.10);
  mix-blend-mode: overlay; z-index: 1;
}
.ova-plate > * { position: relative; z-index: 2; }
.ova-plate:active:not([disabled]) { transform: translateY(1px); }

/* Primary — forged gold. */
.ova-plate--gold {
  background: ${surface.goldPlate}; color: #22190a;
  text-shadow: 0 1px 0 rgba(255,255,255,0.28);
  box-shadow: ${edge.bevel}, ${depth.goldGlow};
}
.ova-plate--gold:hover:not([disabled]) {
  background: ${surface.goldPlateHot};
  box-shadow: ${edge.bevel}, ${depth.goldGlowHot};
  transform: translateY(-1px);
}
.ova-plate--gold:active:not([disabled]) {
  background: ${surface.goldPlate};
  box-shadow: ${edge.bevelSunk}, 0 2px 8px -4px rgba(217,180,90,0.5);
}

/* Primary — amethyst (keeps the violet half of the brand identity). */
.ova-plate--violet {
  background: ${surface.violetPlate}; color: #fff; border-color: #4b30ab;
  text-shadow: 0 1px 0 rgba(0,0,0,0.35);
  box-shadow: ${edge.bevel}, ${depth.violetGlow};
}
.ova-plate--violet:hover:not([disabled]) {
  background: ${surface.violetPlateHot};
  box-shadow: ${edge.bevel}, 0 0 0 1px rgba(157,134,255,0.5), 0 14px 34px -10px rgba(124,92,255,0.8);
  transform: translateY(-1px);
}
.ova-plate--violet:active:not([disabled]) {
  background: ${surface.violetPlate};
  box-shadow: ${edge.bevelSunk}, 0 2px 8px -4px rgba(124,92,255,0.5);
}

/* Secondary — obsidian plate with an engraved gold hairline. */
.ova-plate--obsidian {
  background: ${surface.obsidianRaised}; color: ${color.goldHi};
  border-color: rgba(217,180,90,0.34);
  box-shadow: ${edge.topHighlight}, 0 6px 18px -10px rgba(3,2,10,0.9);
}
.ova-plate--obsidian::after { border-color: rgba(217,180,90,0.12); }
.ova-plate--obsidian:hover:not([disabled]) {
  border-color: rgba(240,212,137,0.7); color: #fff5d6;
  box-shadow: ${edge.topHighlight}, 0 0 22px -6px rgba(217,180,90,0.42), inset 0 0 18px -8px rgba(217,180,90,0.5);
  transform: translateY(-1px);
}
.ova-plate--obsidian:active:not([disabled]) { box-shadow: ${edge.bevelSunk}; }

/* Tertiary — no plate. Rule-underline + bracket marks on hover. */
.ova-plate--ghost {
  background: transparent; border-color: transparent; color: ${color.textMid};
  box-shadow: none; padding-left: 14px; padding-right: 14px;
}
.ova-plate--ghost::after { display: none; }
.ova-plate--ghost::before {
  content: ''; position: absolute; left: 14px; right: 14px; bottom: 7px; height: 1px;
  background: linear-gradient(90deg, transparent, currentColor, transparent);
  opacity: 0.28; transition: opacity 160ms ease;
}
.ova-plate--ghost:hover:not([disabled]) { color: ${color.goldHi}; }
.ova-plate--ghost:hover:not([disabled])::before { opacity: 0.85; }

.ova-plate[disabled] {
  cursor: not-allowed; transform: none;
  background: ${surface.goldPlateDead}; color: rgba(240,230,201,0.42);
  border-color: #4a4230; text-shadow: none;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
  filter: saturate(0.45);
}
.ova-plate--ghost[disabled] { background: transparent; border-color: transparent; filter: none; }

/* Ornament sizing helper for the diamond flanks on hero CTAs. */
.ova-plate .ova-orn { opacity: 0.55; }
.ova-plate:hover:not([disabled]) .ova-orn { opacity: 0.9; }

/* ── Edge-docked stud ────────────────────────────────────────────────────
   A half-rounded obsidian tab that sits flush against a screen edge (the
   same language as the board's collapsed rail tab). Compose it with
   \`.ova-plate .ova-plate--obsidian\` so it inherits the forged hairline,
   hover glow and sunk :active from the plate system — this class only
   changes geometry + docking. */
.ova-edge-stud {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  padding: 0;
  width: 38px; height: 58px;
  border-radius: 12px 0 0 12px;
  border-right: none;
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  box-shadow: ${edge.topHighlight}, inset 1px 0 0 rgba(255,226,160,0.14), -8px 0 22px -8px rgba(3,2,10,0.85);
}
/* Dock to the right edge, honouring the notch/rounded-corner inset. */
.ova-edge-stud--right { right: 0; margin-right: env(safe-area-inset-right, 0px); }
.ova-edge-stud--left {
  left: 0; margin-left: env(safe-area-inset-left, 0px);
  border-radius: 0 12px 12px 0; border-right: 1px solid rgba(217,180,90,0.34); border-left: none;
  box-shadow: ${edge.topHighlight}, inset -1px 0 0 rgba(255,226,160,0.14), 8px 0 22px -8px rgba(3,2,10,0.85);
}
/* Follow the tab's own rounding rather than the plate's square chamfer. */
.ova-edge-stud::after { inset: 3px; border-radius: 9px 0 0 9px; }
.ova-edge-stud--left::after { border-radius: 0 9px 9px 0; }
/* The plate hover lifts by 1px; on a docked tab it should ease outward, not up. */
.ova-edge-stud:hover:not([disabled]) { transform: translateY(-50%) translateX(-2px); }
.ova-edge-stud--left:hover:not([disabled]) { transform: translateY(-50%) translateX(2px); }
.ova-edge-stud:active:not([disabled]) { transform: translateY(-50%); }
/* Vertical grip notches — reads as a pull-tab rather than a bare circle. */
.ova-edge-stud > .ova-stud-grip {
  position: absolute; left: 5px; top: 50%; transform: translateY(-50%);
  width: 2px; height: 18px; border-radius: 2px; pointer-events: none;
  background: linear-gradient(180deg, transparent, rgba(217,180,90,0.55), transparent);
}
.ova-edge-stud--left > .ova-stud-grip { left: auto; right: 5px; }
@media (pointer: coarse) {
  .ova-edge-stud { width: 46px; height: 66px; }
}
`;

// ── Engraved panels ──────────────────────────────────────────────────────────
const PANELS = `
.ova-panel-orn {
  position: relative;
  background: ${surface.obsidianRaised};
  border: 1px solid rgba(217,180,90,0.18);
  border-radius: 16px;
  box-shadow: ${depth.panel};
}
/* Inner engraved hairline — the "illuminated manuscript" frame. */
.ova-panel-orn::before {
  content: ''; position: absolute; inset: 5px; border-radius: 12px; pointer-events: none;
  border: 1px solid rgba(217,180,90,0.10);
}
/* Faint centre-out sheen so large surfaces are not dead flat. */
.ova-panel-orn::after {
  content: ''; position: absolute; inset: 0; border-radius: 16px; pointer-events: none;
  background: radial-gradient(120% 70% at 50% 0%, rgba(255,255,255,0.05), transparent 58%);
}
.ova-panel-orn > * { position: relative; z-index: 1; }

.ova-panel-orn--hi {
  border-color: rgba(217,180,90,0.34);
  box-shadow: ${depth.panelHi}, 0 0 44px -22px rgba(217,180,90,0.55);
}

/* Hero atmosphere: drop behind a hero block so foreground panels separate from
   the background art. Purely decorative, does not affect layout. */
.ova-vignette { position: relative; }
.ova-vignette::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 0;
  background: ${surface.vignette};
}
.ova-vignette > * { position: relative; z-index: 1; }

/* Small-caps eyebrow rule used above section titles. */
.ova-eyebrow {
  font-family: ${font.body}; font-size: 11px; font-weight: 800;
  letter-spacing: 0.2em; text-transform: uppercase; color: ${color.textLo};
}

/* Lift on hover for clickable cards / tiles. */
.ova-lift { transition: transform 170ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 190ms cubic-bezier(0.2,0.8,0.2,1), border-color 190ms ease; }
.ova-lift:hover { transform: translateY(-3px); box-shadow: ${depth.panelHi}; border-color: rgba(217,180,90,0.4); }
.ova-lift:active { transform: translateY(-1px); }

/* Gold text used for hero numerals / display headings. */
.ova-gold-ink {
  background: linear-gradient(180deg, #fdf1cd 0%, #e6c473 46%, #a97f2b 100%);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
`;

const CSS2 = `
.ocva-btn {
  --sh: ${shadow.sm};
  display: inline-flex; align-items: center; justify-content: center; gap: 9px;
  font-family: ${font.body}; font-weight: 700; font-size: 14px; letter-spacing: 0.02em;
  padding: 12px 20px; border-radius: ${radius.md}px; border: 1px solid transparent;
  cursor: pointer; user-select: none; white-space: nowrap; position: relative;
  transition: transform 160ms cubic-bezier(0.2,0.8,0.2,1), background ${motion.base},
    border-color ${motion.base}, box-shadow ${motion.base}, filter ${motion.base};
  box-shadow: var(--sh);
}
.ocva-btn:active:not([disabled]) { transform: translateY(1px); }
.ocva-btn:focus-visible { outline: ${focusRing.outline}; outline-offset: ${focusRing.offset}; }
.ocva-btn[disabled] { opacity: 0.42; cursor: not-allowed; box-shadow: none; filter: saturate(0.4); }

.ocva-btn--primary {
  background: ${surface.violetPlate}; color: #fff; border-color: #4b30ab;
  text-shadow: 0 1px 0 rgba(0,0,0,0.35);
  --sh: ${edge.bevel}, ${depth.violetGlow};
}
.ocva-btn--primary:hover:not([disabled]) {
  background: ${surface.violetPlateHot}; transform: translateY(-1px);
  box-shadow: ${edge.bevel}, 0 0 0 1px rgba(157,134,255,0.5), 0 14px 34px -10px rgba(124,92,255,0.8);
}
.ocva-btn--primary:active:not([disabled]) { box-shadow: ${edge.bevelSunk}; }

.ocva-btn--gold {
  background: ${surface.goldPlate}; color: #22190a; border-color: ${edge.bronze};
  font-family: ${font.serif}; letter-spacing: 0.12em; text-transform: uppercase;
  text-shadow: 0 1px 0 rgba(255,255,255,0.28);
  --sh: ${edge.bevel}, ${depth.goldGlow};
}
.ocva-btn--gold:hover:not([disabled]) {
  background: ${surface.goldPlateHot}; transform: translateY(-1px);
  box-shadow: ${edge.bevel}, ${depth.goldGlowHot};
}
.ocva-btn--gold:active:not([disabled]) { box-shadow: ${edge.bevelSunk}; }

.ocva-btn--secondary {
  background: ${surface.obsidianRaised}; color: ${color.goldHi};
  border-color: rgba(217,180,90,0.32);
  --sh: ${edge.topHighlight}, 0 6px 18px -10px rgba(3,2,10,0.9);
}
.ocva-btn--secondary:hover:not([disabled]) {
  border-color: rgba(240,212,137,0.7); color: #fff5d6; transform: translateY(-1px);
  box-shadow: ${edge.topHighlight}, 0 0 22px -6px rgba(217,180,90,0.42), inset 0 0 18px -8px rgba(217,180,90,0.5);
}

.ocva-btn--ghost { background: transparent; color: ${color.textMid}; box-shadow: none; }
.ocva-btn--ghost:hover:not([disabled]) { background: rgba(255,255,255,0.05); color: ${color.goldHi}; }

.ocva-card {
  background: ${surface.obsidianRaised}; border: 1px solid rgba(217,180,90,0.16);
  border-radius: ${radius.lg}px;
  box-shadow: ${depth.panel};
  transition: transform 170ms cubic-bezier(0.2,0.8,0.2,1), border-color ${motion.base}, box-shadow ${motion.base};
}
.ocva-card--hover:hover { transform: translateY(-3px); border-color: rgba(217,180,90,0.42); box-shadow: ${depth.panelHi}; }

.ocva-panel {
  background: ${surface.obsidian}; border: 1px solid rgba(217,180,90,0.18);
  border-radius: ${radius.xl}px; box-shadow: ${depth.panelHi};
}
.ocva-input {
  width: 100%; font-family: ${font.body}; font-size: 14px; color: ${color.textHi};
  background: ${surface.obsidianWell}; border: 1px solid rgba(217,180,90,0.20);
  border-radius: ${radius.md}px;
  padding: 12px 14px; outline: none;
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);
  transition: border-color ${motion.base}, box-shadow ${motion.base};
}
.ocva-input::placeholder { color: ${color.textLo}; }
.ocva-input:focus { border-color: ${color.accent}; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5), 0 0 0 3px ${color.accentDim}; }

/* Transparent clickable hotspot overlaid on splash artwork (login + hub). */
.ova-hot { position:absolute; z-index:3; background:transparent; border:2px solid transparent; border-radius:14px;
  cursor:pointer; padding:0; transition: background ${motion.fast}, border-color ${motion.fast}, box-shadow ${motion.fast}; }
.ova-hot:hover:not([disabled]) { background: rgba(160,120,255,0.14); border-color: rgba(160,120,255,0.6); box-shadow: 0 0 26px rgba(124,92,255,0.45); }
.ova-hot:focus-visible { outline:${focusRing.outline}; outline-offset:${focusRing.offset}; }
.ova-hot[disabled] { cursor: wait; }

/* Real overlaid menu item (used over a clean splash background). */
.ova-menu-item { position:relative; display:flex; align-items:center; gap:12px; width:100%; text-align:left; cursor:pointer;
  padding:12px 16px; border-radius:10px; font-family:${font.body}; font-weight:700; font-size:13.5px;
  letter-spacing:0.06em; color:${color.textHi}; background:linear-gradient(180deg, rgba(24,20,44,0.80), rgba(12,10,26,0.80));
  border:1px solid rgba(217,180,90,0.20);
  box-shadow: ${edge.topHighlight}, 0 8px 22px -14px rgba(3,2,10,0.9);
  backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
  transition: background 170ms cubic-bezier(0.2,0.8,0.2,1), border-color 170ms ease, transform 170ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 190ms ease, color 170ms ease; }
.ova-menu-item::before {
  content:''; position:absolute; left:0; top:12%; bottom:12%; width:2px; border-radius:2px;
  background:linear-gradient(180deg, transparent, ${color.gold}, transparent);
  opacity:0; transition:opacity 170ms ease; }
.ova-menu-item:hover { background:linear-gradient(180deg, rgba(40,32,72,0.9), rgba(20,16,42,0.9));
  border-color:rgba(240,212,137,0.55); transform:translateX(3px); color:#fff5d6;
  box-shadow: ${edge.topHighlight}, 0 0 26px -10px rgba(217,180,90,0.5); }
.ova-menu-item:hover::before { opacity:1; }
.ova-menu-item:active { transform:translateX(1px) translateY(1px); }
.ova-menu-item:focus-visible { outline:${focusRing.outline}; outline-offset:${focusRing.offset}; }
.ova-menu-item .ova-menu-ico { flex:0 0 auto; color:${color.gold}; display:flex; transition:color 170ms ease; }
.ova-menu-item:hover .ova-menu-ico { color:${color.goldHi}; }
.ova-menu-item--primary { background:${surface.violetPlate};
  border-color:#4b30ab; box-shadow:${edge.bevel}, ${depth.violetGlow}; color:#fff; }
.ova-menu-item--primary:hover { background:${surface.violetPlateHot}; border-color:rgba(157,134,255,0.8); }
.ova-menu-item--primary .ova-menu-ico { color:#fff; }
`;

if (typeof document !== 'undefined' && !document.getElementById('ocva-theme')) {
  const el = document.createElement('style');
  el.id = 'ocva-theme';
  el.textContent = CSS + PLATES + PANELS + CSS2;
  document.head.appendChild(el);
}

// Global menu click SFX: play a short sound whenever a menu / UI button is pressed.
// Scoped to our UI-primitive classes so in-game board controls stay silent.
// Honours two prefs from the Settings page, re-read on every press so a toggle
// takes effect immediately without a reload: `ocva.clickSfx` (this sound) and
// `ocva.muted` (master mute).
if (typeof document !== 'undefined' && !(window as any).__ocvaClickSfx) {
  (window as any).__ocvaClickSfx = true;
  document.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.('.ova-menu-item, .ova-hot, .ocva-btn, .ova-plate');
    if (!el || (el as HTMLButtonElement).disabled) return;
    try {
      if (localStorage.getItem('ocva.clickSfx') === '0') return;
      if (localStorage.getItem('ocva.muted') === '1') return;
    } catch { /* storage blocked — fall through and play */ }
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
      fontFamily: font.body, fontSize: 11, fontWeight: 800, letterSpacing: '0.2em',
      textTransform: 'uppercase', color: color.textLo, ...style,
    }}>{children}</div>
  );
}

// ── Inline-style helpers ─────────────────────────────────────────────────────
// The existing screens are inline-styled. These return plain CSSProperties so a
// screen can adopt the forged-plate / engraved-panel look by spreading them
// into an existing style object, keeping structure and handlers untouched.

/** Forged gold CTA plate (inline-style form of `.ova-plate--gold`). */
export function goldPlate(disabled = false): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 10,
    fontFamily: font.serif, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
    padding: '13px 22px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
    background: disabled ? surface.goldPlateDead : surface.goldPlate,
    color: disabled ? 'rgba(240,230,201,0.42)' : '#22190a',
    border: `1px solid ${disabled ? '#4a4230' : edge.bronze}`,
    textShadow: disabled ? 'none' : '0 1px 0 rgba(255,255,255,0.28)',
    boxShadow: disabled ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : `${edge.bevel}, ${depth.goldGlow}`,
    transition: 'transform 160ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 180ms ease, background 180ms ease',
  };
}

/** Obsidian secondary plate with an engraved gold hairline. */
export function obsidianPlate(disabled = false): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    fontFamily: font.body, fontWeight: 700, fontSize: 12.5, letterSpacing: '0.1em',
    padding: '11px 16px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
    background: surface.obsidianRaised, color: disabled ? color.textLo : color.goldHi,
    border: `1px solid ${disabled ? color.border : 'rgba(217,180,90,0.32)'}`,
    boxShadow: `${edge.topHighlight}, 0 6px 18px -10px rgba(3,2,10,0.9)`,
    opacity: disabled ? 0.55 : 1,
    transition: 'transform 160ms cubic-bezier(0.2,0.8,0.2,1), box-shadow 180ms ease, border-color 180ms ease, color 180ms ease',
  };
}

/** Engraved obsidian panel surface. */
export function engravedPanel(hi = false): React.CSSProperties {
  return {
    background: surface.obsidianRaised,
    border: `1px solid ${hi ? 'rgba(217,180,90,0.34)' : 'rgba(217,180,90,0.18)'}`,
    borderRadius: 16,
    boxShadow: hi ? `${depth.panelHi}, 0 0 44px -22px rgba(217,180,90,0.55)` : depth.panel,
  };
}
