// src/chain-logos.tsx
// Faction sigils + the <ChainLogo> renderer used as the faction / gas symbol
// across the UI (card cost pips, node art, deck tiles, filters).
//
// The game's five factions are the Sproto Gremlin types — Spirit (white),
// Rebel (red), Jester (black), Wealth (green), Knowledge (blue) — on the stable
// chain-era keys `bnb | sol | eth | robinhood | base` (see COLOR_META in
// src/cards.ts). The component keeps its old name so every call site works
// unchanged.
//
// ─── Why this lives here and NOT in COLOR_META (src/cards.ts) ────────────────
// src/cards.ts is vendored into new-backend/services/game/src/game/cards.ts and
// re-synced with a plain `cp`. Sigils are pure presentation and the game
// service has no business knowing about them, so they are keyed by `Color` in
// this client-only module.
//
// ─── These are PLACEHOLDER sigils ───────────────────────────────────────────
// Simple inline SVG marks so the factions read correctly today. Swap in real
// Sproto Gremlin art per faction by replacing the `mark` for that key (an
// <image href="…"> inside the same 24×24 viewBox works).

import React from 'react';
import { COLOR_META, type Color } from './cards';

type SigilSpec = {
  /** Plate painted behind the mark. */
  plate: string;
  /** Colour the mark is drawn in. */
  ink: string;
  /** The mark itself, drawn in a 24×24 viewBox using `currentColor`. */
  mark: React.ReactNode;
};

export const FACTION_SIGILS: Record<Color, SigilSpec> = {
  // Spirit — a rayed sun.
  bnb: {
    plate: '#f4ecd4', ink: '#8a6a16',
    mark: (
      <>
        <circle cx="12" cy="12" r="4.2" fill="currentColor" />
        {Array.from({ length: 8 }).map((_, i) => (
          <rect key={i} x="11.1" y="2" width="1.8" height="4.2" rx="0.9" fill="currentColor"
            transform={`rotate(${i * 45} 12 12)`} />
        ))}
      </>
    ),
  },
  // Rebel — a flame.
  sol: {
    plate: '#2a0d0b', ink: '#ff5a3c',
    mark: (
      <path fill="currentColor" d="M12 2.5c.6 3.1-1.2 4.9-2.6 6.6C8 10.8 7 12.4 7 14.6 7 18.1 9.3 21 12.4 21c3.2 0 5.6-2.6 5.6-6.1 0-2.5-1.2-4.2-2.4-5.5.1 1.4-.4 2.6-1.5 3.3.3-3.7-.9-7-2.1-10.2Zm.3 11.2c.9 1.1 1.8 2.1 1.8 3.6 0 1.4-.9 2.4-2 2.4s-2-1-2-2.3c0-1.5 1.2-2.5 2.2-3.7Z" />
    ),
  },
  // Jester — a three-pointed cap with bells.
  eth: {
    plate: '#141018', ink: '#c9b8e8',
    mark: (
      <>
        <path fill="currentColor" d="M3 17.5 6.2 7.2 9.6 13 12 5l2.4 8 3.4-5.8L21 17.5Z" />
        <rect x="3.5" y="17.6" width="17" height="2.6" rx="1.1" fill="currentColor" />
        <circle cx="6.2" cy="6" r="1.6" fill="currentColor" />
        <circle cx="12" cy="3.9" r="1.6" fill="currentColor" />
        <circle cx="17.8" cy="6" r="1.6" fill="currentColor" />
      </>
    ),
  },
  // Wealth — a coin with a sprout.
  robinhood: {
    plate: '#0c2414', ink: '#4fd36d',
    mark: (
      <>
        <circle cx="12" cy="15" r="6.2" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="12" cy="15" r="2.6" fill="currentColor" />
        <path fill="currentColor" d="M12 8.8V5.6c0-1.6 1.4-3 3.4-3.1-.1 2-1.5 3.4-3.4 3.4M12 6.2c0-1.5-1.3-2.8-3.1-2.9.1 1.8 1.4 3 3.1 3" />
        <rect x="11.2" y="5" width="1.6" height="4" rx="0.8" fill="currentColor" />
      </>
    ),
  },
  // Knowledge — an open eye.
  base: {
    plate: '#0b1730', ink: '#6aa2ff',
    mark: (
      <>
        <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
          d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
        <circle cx="12" cy="12" r="3.4" fill="currentColor" />
      </>
    ),
  },
};

/** Short text glyph for a faction (SPR / RBL / JST / WLT / KNW). */
export function chainGlyph(color: Color): string {
  const meta = COLOR_META[color];
  return meta.glyph ?? meta.name[0] ?? '?';
}

export function ChainLogo({
  color, size, alt = '', title, style,
}: {
  color: Color;
  /** Medallion edge length in CSS px. */
  size: number;
  /**
   * Accessible name. Leave empty (the default) wherever the faction name is
   * already present as text next to the sigil — otherwise a screen reader
   * announces it twice. Pass a real name only where the sigil is the sole
   * carrier of faction identity.
   */
  alt?: string;
  title?: string;
  style?: React.CSSProperties;
}) {
  const spec = FACTION_SIGILS[color];
  const inner = Math.max(1, Math.round(size * 0.74));

  const shell: React.CSSProperties = {
    width: size, height: size, flex: 'none',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: spec.plate, color: spec.ink,
    borderRadius: Math.max(3, Math.round(size * 0.24)),
    // Matches the gold-trimmed card chrome used across Board.tsx.
    boxShadow: 'inset 0 0 0 1px rgba(229,184,75,0.28), inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.55)',
    overflow: 'hidden',
    ...style,
  };

  return (
    <span style={shell} title={title}>
      <svg viewBox="0 0 24 24" width={inner} height={inner} role={alt ? 'img' : undefined}
        aria-label={alt || undefined} aria-hidden={alt ? undefined : true}
        style={{ display: 'block', pointerEvents: 'none' }}>
        {spec.mark}
      </svg>
    </span>
  );
}
