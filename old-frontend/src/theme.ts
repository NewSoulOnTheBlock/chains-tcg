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

export const theme = { color, font, type, space, radius, shadow, motion };
export default theme;
