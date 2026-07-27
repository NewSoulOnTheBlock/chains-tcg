// src/chain-logos.tsx
// Chain logo artwork + the <ChainLogo> renderer that replaces the text glyphs
// ('BNB' / 'SOL' / 'ETH' / 'HOOD' / 'BASE') across the UI.
//
// ─── Why this lives here and NOT in COLOR_META (src/cards.ts) ────────────────
// src/cards.ts is vendored byte-for-byte into
//   new-backend/services/game/src/game/cards.ts
// and re-synced with a plain `cp` (see that file's header). Adding a `logo`
// field to COLOR_META would silently drift the backend copy on the next sync.
// Logos are pure presentation and the game service has no business knowing
// about them, so the mapping is keyed by `Color` in this client-only module and
// cards.ts is left untouched.
//
// ─── Artwork notes (measured from the supplied files, not guessed) ───────────
// The five client assets are 2000-3258px originals rendered at 16-84 CSS px, so
// public/chains/opt/ holds 64px and 192px WebP derivatives (see the header of
// this repo's public/chains/ originals, which are kept untouched).
//
// Four of the five are free-standing marks on transparent surrounds. The
// Robinhood file was the odd one out: a 400x400 7-entry palette PNG with NO
// alpha channel, a perfectly flat #CCFF00 lime plate (verified: all 1600 border
// pixels identical) and a near-black #1C180D feather. The lime keys out exactly,
// and the derivative here IS keyed — but a bare near-black feather would be
// invisible on every surface in this UI, which are all dark. So the medallion
// below carries Robinhood's lime as its plate colour: the asset is now
// structurally identical to the other four, and the brand's own black-on-lime
// lockup is preserved.
//
// The medallion also fixes a problem that affects all five: every glyph site
// paints `linear-gradient(160deg, meta.hex, #0a1020)` behind the mark, i.e. the
// chain's own colour. A gold BNB diamond on a gold plate washes out. Giving all
// five the same obsidian medallion (lime for Robinhood) means each mark has a
// controlled backdrop no matter what is painted behind it.

import React, { useState } from 'react';
import { COLOR_META, type Color } from './cards';

/** Neutral plate for the four marks that carry their own colour. */
const OBSIDIAN = '#0b0f1c';

type LogoSpec = {
  /** 64px derivative — used for medallions rendered at <= 32 CSS px. */
  sm: string;
  /** 192px derivative — used above that (covers 96 CSS px at 2x). */
  lg: string;
  /**
   * Optical padding, as a fraction of the medallion. Diamonds (BNB, ETH) touch
   * their bounding box corner-to-corner and read small, so they get less; the
   * Base disc fills its box and reads large, so it gets more.
   */
  inset: number;
  /** Plate painted behind the mark. */
  plate: string;
  /** Colour for the glyph-text fallback drawn on that plate. */
  ink: string;
};

export const CHAIN_LOGOS: Record<Color, LogoSpec> = {
  bnb:       { sm: '/chains/opt/bnb-64.webp',       lg: '/chains/opt/bnb-192.webp',       inset: 0.10, plate: OBSIDIAN,   ink: '#f3ba2f' },
  sol:       { sm: '/chains/opt/sol-64.webp',       lg: '/chains/opt/sol-192.webp',       inset: 0.14, plate: OBSIDIAN,   ink: '#b98bff' },
  eth:       { sm: '/chains/opt/eth-64.webp',       lg: '/chains/opt/eth-192.webp',       inset: 0.10, plate: OBSIDIAN,   ink: '#c8ccd8' },
  // Lime plate = the keyed-out background of the supplied asset, reinstated as
  // a CSS colour so the near-black feather stays legible. See header.
  robinhood: { sm: '/chains/opt/robinhood-64.webp', lg: '/chains/opt/robinhood-192.webp', inset: 0.04, plate: '#ccff00', ink: '#12100a' },
  base:      { sm: '/chains/opt/base-64.webp',      lg: '/chains/opt/base-192.webp',      inset: 0.12, plate: OBSIDIAN,   ink: '#5b8cff' },
};

/** The text that was rendered before logos existed — still the error fallback. */
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
   * Accessible name. Leave empty (the default) wherever the chain name is
   * already present as text next to the logo — otherwise a screen reader
   * announces it twice. Pass a real name only where the logo is the sole
   * carrier of chain identity.
   */
  alt?: string;
  title?: string;
  style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const spec = CHAIN_LOGOS[color];
  const pad = Math.round(size * spec.inset);
  const inner = Math.max(1, size - pad * 2);
  const glyph = chainGlyph(color);

  const shell: React.CSSProperties = {
    width: size, height: size, flex: 'none',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: spec.plate,
    borderRadius: Math.max(3, Math.round(size * 0.24)),
    // Matches the gold-trimmed card chrome used across Board.tsx.
    boxShadow: 'inset 0 0 0 1px rgba(229,184,75,0.28), inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.55)',
    overflow: 'hidden',
    ...style,
  };

  if (failed) {
    // Image unavailable — fall back to the original text glyph, in the same
    // box, so nothing reflows.
    return (
      <span aria-hidden={alt ? undefined : true} title={title} style={{
        ...shell,
        color: spec.ink, fontWeight: 900,
        fontSize: Math.max(6, Math.round(size * (glyph.length > 3 ? 0.26 : 0.30))),
        letterSpacing: 0.5, lineHeight: 1,
      }}>{glyph}</span>
    );
  }

  return (
    <span style={shell} title={title}>
      <img
        src={size <= 32 ? spec.sm : spec.lg}
        alt={alt}
        width={inner}
        height={inner}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(true)}
        style={{ width: inner, height: inner, objectFit: 'contain', display: 'block', pointerEvents: 'none' }}
      />
    </span>
  );
}
