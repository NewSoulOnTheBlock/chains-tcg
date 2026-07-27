// src/theme.ts
// Shared design tokens for On-Chain Virtual Arena. One source of truth for the
// modern-refresh look: tinted-dark surfaces, a disciplined violet accent with a
// restrained gold brand highlight, a real type scale, spacing, radii, tinted
// shadows, and motion. Consumed directly in inline styles and via the CSS
// variables + utility classes injected by src/ui.tsx.

export const color = {
  // Surfaces — cool-tinted dark, never pure black.
  bg0: '#0a0a14', // page
  bg1: '#12121f', // panel
  bg2: '#1b1b2e', // raised / card
  bg3: '#24243a', // hover / input
  // Hairlines.
  border: 'rgba(150,140,190,0.14)',
  borderStrong: 'rgba(150,140,190,0.30)',
  // Text.
  textHi: '#f3f1fb',
  textMid: '#a9a4c2',
  textLo: '#6f6a8a',
  // Primary interactive accent (violet) + restrained gold brand highlight.
  accent: '#7c5cff',
  accentHi: '#9d86ff',
  accentDim: 'rgba(124,92,255,0.16)',
  gold: '#d9b45a',
  goldHi: '#f0d489',
  // Semantic.
  success: '#37d399',
  danger: '#ff6b6b',
  // Chain identity (matches COLOR_META in cards.ts).
  chain: {
    bnb: '#f3ba2f',
    sol: '#9945ff',
    eth: '#c8ccd8',
    robinhood: '#00C805',
    base: '#0052FF',
  },
} as const;

export const font = {
  display: '"Space Grotesk", "Inter", system-ui, sans-serif',
  body: '"Inter", system-ui, -apple-system, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  /** Medieval display face — used for headings, CTA labels and section rules. */
  serif: '"Cinzel", "EB Garamond", "Times New Roman", Georgia, serif',
} as const;

// Type scale: [fontSize, lineHeight, fontWeight, letterSpacing].
export const type = {
  display: { fontFamily: font.display, fontSize: 'clamp(34px, 5vw, 60px)', lineHeight: 1.02, fontWeight: 700, letterSpacing: '-0.02em' },
  h1:      { fontFamily: font.display, fontSize: 28, lineHeight: 1.1,  fontWeight: 700, letterSpacing: '-0.01em' },
  h2:      { fontFamily: font.display, fontSize: 20, lineHeight: 1.15, fontWeight: 600, letterSpacing: '-0.01em' },
  h3:      { fontFamily: font.display, fontSize: 16, lineHeight: 1.2,  fontWeight: 600, letterSpacing: '0' },
  body:    { fontFamily: font.body, fontSize: 14, lineHeight: 1.55, fontWeight: 400, letterSpacing: '0' },
  small:   { fontFamily: font.body, fontSize: 12, lineHeight: 1.5,  fontWeight: 400, letterSpacing: '0' },
  label:   { fontFamily: font.body, fontSize: 11, lineHeight: 1.2,  fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase' as const },
  mono:    { fontFamily: font.mono, fontSize: 12, lineHeight: 1.4,  fontWeight: 500, letterSpacing: '0' },
} as const;

// 4px base spacing scale.
export const space = (n: number) => n * 4;

export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;

// Tinted shadows (carry the page hue, not pure black) + accent glow.
export const shadow = {
  sm: '0 2px 8px rgba(8,6,20,0.5)',
  md: '0 10px 30px rgba(8,6,20,0.55)',
  lg: '0 24px 70px rgba(6,4,18,0.6)',
  glow: '0 0 28px rgba(124,92,255,0.35)',
  glowGold: '0 0 24px rgba(217,180,90,0.30)',
} as const;

export const motion = {
  fast: '120ms cubic-bezier(0.2,0.8,0.2,1)',
  base: '200ms cubic-bezier(0.2,0.8,0.2,1)',
  slow: '320ms cubic-bezier(0.2,0.8,0.2,1)',
} as const;

// Single source of truth for keyboard-focus rings: gold, 2px, offset 2.
// Consumed by the global stylesheet injected from src/ui.tsx.
export const focusRing = {
  outline: `2px solid ${color.goldHi}`,
  offset: '2px',
} as const;

// ── Medieval surface language ───────────────────────────────────────────────
// The arena reads as forged metal on obsidian, not as flat SaaS panels. These
// tokens carry the "beveled plate" and "engraved hairline" treatment so every
// screen can opt in without re-deriving gradients by hand.
export const surface = {
  /** Deep obsidian page/panel field with a faint top light. */
  obsidian: 'linear-gradient(180deg, #16142a 0%, #100e20 55%, #0b0a17 100%)',
  /** Raised panel / card. */
  obsidianRaised: 'linear-gradient(180deg, #201c38 0%, #16142a 70%, #121026 100%)',
  /** Inset well (inputs, sunken areas). */
  obsidianWell: 'linear-gradient(180deg, #0a0914 0%, #100e1e 100%)',
  /** Forged gold CTA plate: deep amber -> bright gold -> deep amber. */
  goldPlate: 'linear-gradient(180deg, #f8e7b4 0%, #e6c473 30%, #cfa441 58%, #a97f2b 100%)',
  goldPlateHot: 'linear-gradient(180deg, #fdf1cd 0%, #f0d489 30%, #dcb452 58%, #b98f34 100%)',
  goldPlateDead: 'linear-gradient(180deg, #4a4230 0%, #3a3324 60%, #2c2719 100%)',
  /** Amethyst plate for the violet-identity CTAs. */
  violetPlate: 'linear-gradient(180deg, #b9a4ff 0%, #8a6bff 34%, #6a46e8 62%, #4b30ab 100%)',
  violetPlateHot: 'linear-gradient(180deg, #cdbcff 0%, #9d86ff 34%, #7c5cff 62%, #5a3ec6 100%)',
  /** Atmospheric wash placed behind hero areas so foreground panels pop. */
  vignette:
    'radial-gradient(120% 80% at 50% -10%, rgba(124,92,255,0.14), transparent 62%),' +
    'radial-gradient(90% 60% at 50% 108%, rgba(217,180,90,0.09), transparent 64%),' +
    'radial-gradient(140% 130% at 50% 50%, transparent 42%, rgba(4,3,12,0.62) 100%)',
} as const;

/** Edge / bevel treatment: engraved gold hairlines and forged-metal reliefs. */
export const edge = {
  bronze: '#8a6d24',
  hair: 'rgba(217,180,90,0.20)',
  hairStrong: 'rgba(217,180,90,0.42)',
  /** Faint 1px top-edge highlight that makes a flat panel read as a plate. */
  topHighlight: 'inset 0 1px 0 rgba(255,255,255,0.06)',
  /** Full bevel for pressed-metal buttons. */
  bevel: 'inset 0 1px 0 rgba(255,255,255,0.5), inset 0 -1px 0 rgba(0,0,0,0.42)',
  /** Same bevel inverted — used for the :active "sunk" state. */
  bevelSunk: 'inset 0 2px 5px rgba(0,0,0,0.5), inset 0 -1px 0 rgba(255,255,255,0.12)',
} as const;

/** Layered depth shadows tuned for the obsidian field. */
export const depth = {
  panel: '0 1px 0 rgba(255,255,255,0.04) inset, 0 18px 44px -18px rgba(3,2,10,0.9), 0 2px 10px rgba(3,2,10,0.55)',
  panelHi: '0 1px 0 rgba(255,255,255,0.06) inset, 0 30px 80px -24px rgba(3,2,10,0.95), 0 3px 14px rgba(3,2,10,0.6)',
  goldGlow: '0 0 0 1px rgba(217,180,90,0.25), 0 10px 26px -10px rgba(217,180,90,0.55)',
  goldGlowHot: '0 0 0 1px rgba(240,212,137,0.45), 0 14px 34px -10px rgba(217,180,90,0.75)',
  violetGlow: '0 0 0 1px rgba(124,92,255,0.30), 0 10px 28px -10px rgba(124,92,255,0.6)',
} as const;

export const theme = { color, font, type, space, radius, shadow, motion, focusRing, surface, edge, depth };
export default theme;
