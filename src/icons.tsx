// src/icons.tsx
// Shared inline-SVG icon set. The UI must not render emoji — every pictograph
// goes through this module so weight, alignment and colour stay consistent
// across platforms (emoji render differently per OS and cannot be themed).
//
// All icons inherit the surrounding text colour via `currentColor` and default
// to 1em so they line up with adjacent text without extra styling. Pass `size`
// for a fixed pixel box, `color` to override, and any other SVG prop as needed.

import React from 'react';

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'color'> {
  /** Pixel box. Defaults to '1em' so icons scale with surrounding text. */
  size?: number | string;
  /** Stroke/fill colour. Defaults to `currentColor`. */
  color?: string;
  /** Stroke width for line icons. */
  strokeWidth?: number;
}

/** Shared wrapper: 24-unit viewBox, round caps, inherits colour. */
function Svg({
  size = '1em', color = 'currentColor', strokeWidth = 1.8, children, style, ...rest
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'inline-block', verticalAlign: '-0.125em', flexShrink: 0, ...style }}
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Solid-fill variant (for glyphs that read better filled: stars, orbs, suits). */
function SvgFilled({
  size = '1em', color = 'currentColor', children, style, ...rest
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={color}
      stroke="none"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'inline-block', verticalAlign: '-0.125em', flexShrink: 0, ...style }}
      {...rest}
    >
      {children}
    </svg>
  );
}

// ── Navigation / chrome ──────────────────────────────────────────────────────

export const ArrowRight = (p: IconProps) => (
  <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>
);
export const ArrowLeft = (p: IconProps) => (
  <Svg {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></Svg>
);
export const ArrowDown = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>
);
export const ArrowUp = (p: IconProps) => (
  <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
);
export const ArrowUpRight = (p: IconProps) => (
  <Svg {...p}><path d="M7 17 17 7M9 7h8v8" /></Svg>
);
export const ChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>
);
export const ChevronLeft = (p: IconProps) => (
  <Svg {...p}><path d="m15 6-6 6 6 6" /></Svg>
);
export const ChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);
export const Menu = (p: IconProps) => (
  <Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>
);
export const Close = (p: IconProps) => (
  <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
);
export const Check = (p: IconProps) => (
  <Svg {...p}><path d="m4 12.5 5 5L20 6.5" /></Svg>
);
export const Plus = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);
export const Minus = (p: IconProps) => (
  <Svg {...p}><path d="M5 12h14" /></Svg>
);
export const Refresh = (p: IconProps) => (
  <Svg {...p}><path d="M20 11a8 8 0 1 0-2.3 6M20 5v6h-6" /></Svg>
);
export const Play = (p: IconProps) => (
  <SvgFilled {...p}><path d="M8 5.5v13l11-6.5z" /></SvgFilled>
);
export const External = (p: IconProps) => (
  <Svg {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>
);
export const Search = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></Svg>
);
export const Copy = (p: IconProps) => (
  <Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></Svg>
);
export const Edit = (p: IconProps) => (
  <Svg {...p}><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" /><path d="M15 6l3 3" /></Svg>
);
export const Trash = (p: IconProps) => (
  <Svg {...p}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6" /></Svg>
);
export const Save = (p: IconProps) => (
  <Svg {...p}><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v6h7V4M8 20v-5h8v5" /></Svg>
);
export const Folder = (p: IconProps) => (
  <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></Svg>
);
export const Download = (p: IconProps) => (
  <Svg {...p}><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></Svg>
);

// ── Game / combat ────────────────────────────────────────────────────────────

export const Swords = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 3.5h3l9.5 9.5-3 3L3.5 6.5z" />
    <path d="M20.5 3.5h-3L8 13l3 3 9.5-9.5z" />
    <path d="m5 19 3-3M19 19l-3-3" />
  </Svg>
);
export const Shield = (p: IconProps) => (
  <Svg {...p}><path d="M12 3.5 20 6v6c0 4.4-3.2 7.6-8 9-4.8-1.4-8-4.6-8-9V6z" /></Svg>
);
export const ShieldCheck = (p: IconProps) => (
  <Svg {...p}><path d="M12 3.5 20 6v6c0 4.4-3.2 7.6-8 9-4.8-1.4-8-4.6-8-9V6z" /><path d="m8.5 12 2.5 2.5 4.5-4.5" /></Svg>
);
export const Hand = (p: IconProps) => (
  <Svg {...p}><path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-.5V4.5a1.5 1.5 0 0 1 3 0V11m0-.5V6a1.5 1.5 0 0 1 3 0v6m0-3.5a1.5 1.5 0 0 1 3 0v6a7 7 0 0 1-7 7h-1a6 6 0 0 1-6-6v-4.5a1.5 1.5 0 0 1 2.6-1L8 15" /></Svg>
);
export const Skull = (p: IconProps) => (
  <Svg {...p}><path d="M12 3a8 8 0 0 0-8 8c0 2.6 1.3 4.3 2.6 5.3.5.4.9.9.9 1.5V19a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-1.2c0-.6.4-1.1.9-1.5C19.7 15.3 21 13.6 21 11a8 8 0 0 0-9-8z" /><circle cx="9" cy="11.5" r="1.6" /><circle cx="15" cy="11.5" r="1.6" /><path d="M11 17v2M13 17v2" /></Svg>
);
export const Heart = (p: IconProps) => (
  <SvgFilled {...p}><path d="M12 20.5S3.5 15 3.5 9.4A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8.5 2.4C20.5 15 12 20.5 12 20.5z" /></SvgFilled>
);
export const Bolt = (p: IconProps) => (
  <SvgFilled {...p}><path d="M13.5 2 4 13.5h6L9.5 22 20 10.5h-6.5z" /></SvgFilled>
);
export const Fire = (p: IconProps) => (
  <Svg {...p}><path d="M12 2.5c3 3.4 5.5 6 5.5 9.5a5.5 5.5 0 0 1-11 0c0-1.7.7-3 1.7-4.3.4 1 1 1.8 1.8 2.2 0-2.6.7-5 2-7.4z" /></Svg>
);
export const Robot = (p: IconProps) => (
  <Svg {...p}><rect x="4" y="8" width="16" height="11" rx="2.5" /><path d="M12 4.5v3.5M9 3.5h6" /><circle cx="9.2" cy="13" r="1.4" /><circle cx="14.8" cy="13" r="1.4" /><path d="M2.5 12v3M21.5 12v3" /></Svg>
);
export const Wizard = (p: IconProps) => (
  <Svg {...p}><path d="M12 2.5 7 12h10z" /><path d="M5.5 12h13l1.5 3.5a2 2 0 0 1-1.9 2.8H5.9A2 2 0 0 1 4 15.5z" /><path d="M12 6.5v2" /></Svg>
);
export const Ghost = (p: IconProps) => (
  <Svg {...p}><path d="M4.5 20V10a7.5 7.5 0 0 1 15 0v10l-2.5-2-2.5 2-2.5-2-2.5 2z" /><circle cx="9.5" cy="10.5" r="1.2" /><circle cx="14.5" cy="10.5" r="1.2" /></Svg>
);
export const Frog = (p: IconProps) => (
  <Svg {...p}><path d="M4 16.5c0-4 3.6-7 8-7s8 3 8 7a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" /><circle cx="8.5" cy="7" r="2.7" /><circle cx="15.5" cy="7" r="2.7" /><path d="M8.5 7v.01M15.5 7v.01" strokeWidth={2.6} /></Svg>
);
export const Cards = (p: IconProps) => (
  <Svg {...p}><rect x="8.5" y="4" width="11" height="15" rx="2" /><path d="M15.5 21H6a2 2 0 0 1-2-2V7.5" /></Svg>
);
export const Deck = (p: IconProps) => (
  <Svg {...p}><rect x="4" y="6" width="12" height="15" rx="2" /><path d="M8 3h9a2 2 0 0 1 2 2v12" /></Svg>
);
export const Dice = (p: IconProps) => (
  <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1.3" /><circle cx="15" cy="15" r="1.3" /><circle cx="12" cy="12" r="1.3" /></Svg>
);
export const Target = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></Svg>
);
export const Gamepad = (p: IconProps) => (
  <Svg {...p}><path d="M7.5 8h9a5.5 5.5 0 0 1 5.4 6.5l-.5 2.6A2.6 2.6 0 0 1 16.9 18l-1.7-2H8.8l-1.7 2a2.6 2.6 0 0 1-4.5-.9l-.5-2.6A5.5 5.5 0 0 1 7.5 8z" /><path d="M7 11.5v2.5M5.75 12.75h2.5M15.5 12h.01M17.5 14h.01" /></Svg>
);

// ── Ranking / rewards ────────────────────────────────────────────────────────

export const Trophy = (p: IconProps) => (
  <Svg {...p}><path d="M7 4h10v5a5 5 0 0 1-10 0z" /><path d="M7 5.5H4.5A2.5 2.5 0 0 0 7 10M17 5.5h2.5A2.5 2.5 0 0 1 17 10" /><path d="M12 14v3M8.5 20h7M9.5 20l.5-3h4l.5 3" /></Svg>
);
export const Medal = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="15" r="5.5" /><path d="M8.5 10 6 3h4l2 4.5L14 3h4l-2.5 7" /><path d="m12 13 .8 1.6 1.7.2-1.3 1.2.4 1.7-1.6-.9-1.6.9.4-1.7-1.3-1.2 1.7-.2z" /></Svg>
);
export const Star = (p: IconProps) => (
  <SvgFilled {...p}><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.2 6.1L12 16.8 6.5 19.7l1.2-6.1L3.2 9.4l6.1-.8z" /></SvgFilled>
);
export const StarOutline = (p: IconProps) => (
  <Svg {...p}><path d="m12 3.5 2.6 5.3 5.8.8-4.2 4 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4 5.8-.8z" /></Svg>
);
export const Crown = (p: IconProps) => (
  <Svg {...p}><path d="M4 18h16l1-11-5 3.5L12 4 8 10.5 3 7z" /><path d="M4 20.5h16" /></Svg>
);
export const Gem = (p: IconProps) => (
  <Svg {...p}><path d="M7 4h10l4 5-9 11L3 9z" /><path d="M3 9h18M9.5 4 7 9l5 11M14.5 4 17 9l-5 11" /></Svg>
);
export const Coins = (p: IconProps) => (
  <Svg {...p}><ellipse cx="12" cy="6.5" rx="7" ry="3" /><path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" /><path d="M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" /></Svg>
);
export const Chart = (p: IconProps) => (
  <Svg {...p}><path d="M4 20V4M4 20h16" /><path d="m7 15 3.5-4 3 2.5L20 7" /></Svg>
);

// ── Places / lore ────────────────────────────────────────────────────────────

export const Castle = (p: IconProps) => (
  <Svg {...p}><path d="M4 20V8l2.5 1.5V6L9 7.5V5l3 1.5L15 5v2.5L17.5 6v3.5L20 8v12z" /><path d="M10 20v-4.5h4V20" /></Svg>
);
export const Temple = (p: IconProps) => (
  <Svg {...p}><path d="M3 9 12 4l9 5" /><path d="M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 20.5h18" /></Svg>
);
export const Map = (p: IconProps) => (
  <Svg {...p}><path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5z" /><path d="M9 4v13M15 6.5v13" /></Svg>
);
export const Scroll = (p: IconProps) => (
  <Svg {...p}><path d="M6 4h10a2 2 0 0 1 2 2v12a2 2 0 0 0 2 2H8a2 2 0 0 1-2-2z" /><path d="M6 4a2 2 0 0 0-2 2v2h2M9.5 9h5M9.5 13h5" /></Svg>
);
export const Book = (p: IconProps) => (
  <Svg {...p}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M19 18v3H6.5A2.5 2.5 0 0 1 4 18.5" /></Svg>
);
export const Books = (p: IconProps) => (
  <Svg {...p}><rect x="4" y="4" width="4" height="16" rx="1" /><rect x="9.5" y="4" width="4" height="16" rx="1" /><path d="m15.5 5.5 3.6-.9 2.4 14.4-3.6 1z" /></Svg>
);
export const Globe = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.3 2.5 3.4 5.4 3.4 8.5S14.3 18 12 20.5c-2.3-2.5-3.4-5.4-3.4-8.5S9.7 6 12 3.5z" /></Svg>
);
export const Moon = (p: IconProps) => (
  <Svg {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" /></Svg>
);
export const Orb = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="10.5" r="6.5" /><path d="M9.2 8.2a3.8 3.8 0 0 1 3-2M6.5 19.5h11l-1 2h-9z" /></Svg>
);
export const Link = (p: IconProps) => (
  <Svg {...p}><path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7l-1.4 1.4" /><path d="M14 10.5a4 4 0 0 0-5.7 0L5.5 13.3a4 4 0 1 0 5.7 5.7l1.4-1.4" /></Svg>
);
export const Chain = Link;

// ── Status / system ──────────────────────────────────────────────────────────

export const Warning = (p: IconProps) => (
  <Svg {...p}><path d="M12 4 2.5 20h19z" /><path d="M12 10v4.5M12 17.5v.01" strokeWidth={2.2} /></Svg>
);
export const Info = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 8v.01" strokeWidth={2.2} /></Svg>
);
export const Lock = (p: IconProps) => (
  <Svg {...p}><rect x="4.5" y="10" width="15" height="10" rx="2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></Svg>
);
export const User = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="8" r="3.8" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></Svg>
);
export const Users = (p: IconProps) => (
  <Svg {...p}><circle cx="9.5" cy="8" r="3.5" /><path d="M2.5 20a7 7 0 0 1 14 0" /><path d="M16 5a3.5 3.5 0 0 1 0 6.5M17 14.5a6 6 0 0 1 4.5 5.5" /></Svg>
);
export const Chat = (p: IconProps) => (
  <Svg {...p}><path d="M20.5 12c0 4.1-3.8 7.5-8.5 7.5a10 10 0 0 1-2.7-.4L4 21l1.3-3.6A7 7 0 0 1 3.5 12c0-4.1 3.8-7.5 8.5-7.5s8.5 3.4 8.5 7.5z" /></Svg>
);
export const Mic = (p: IconProps) => (
  <Svg {...p}><rect x="9" y="3" width="6" height="10.5" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" /></Svg>
);
export const SoundOn = (p: IconProps) => (
  <Svg {...p}><path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" /><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></Svg>
);
export const SoundOff = (p: IconProps) => (
  <Svg {...p}><path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></Svg>
);
export const Music = (p: IconProps) => (
  <Svg {...p}><path d="M9 18V5.5l11-2V16" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></Svg>
);
export const Settings = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.9 1.9M7.2 16.8l-1.9 1.9M18.7 18.7l-1.9-1.9M7.2 7.2 5.3 5.3" /></Svg>
);
export const Tools = (p: IconProps) => (
  <Svg {...p}><path d="M14.5 6.5a4 4 0 0 0 5 5l-8 8a2.5 2.5 0 0 1-3.5-3.5z" /><path d="m6.5 4 3 3-2 2-3-3a2 2 0 0 1 2-2z" /></Svg>
);
export const Monitor = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8.5 20.5h7M12 16.5v4" /></Svg>
);
export const Mobile = (p: IconProps) => (
  <Svg {...p}><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 5.5h3M12 18.5v.01" strokeWidth={2.2} /></Svg>
);
export const Fox = (p: IconProps) => (
  <Svg {...p}><path d="M3.5 4 6 10.5 12 14l6-3.5L20.5 4l-4.5 3h-8z" /><path d="M6 10.5c0 4 2.7 7 6 9.5 3.3-2.5 6-5.5 6-9.5" /><path d="M9.5 12.5v.01M14.5 12.5v.01" strokeWidth={2.4} /></Svg>
);
export const Backpack = (p: IconProps) => (
  <Svg {...p}><path d="M5 10a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z" /><path d="M9.5 5V3.5h5V5M8.5 12.5h7v3h-7z" /></Svg>
);

export const Hourglass = (p: IconProps) => (
  <Svg {...p}><path d="M7 3h10M7 21h10" /><path d="M8 3v3.5c0 2 4 3.7 4 5.5s-4 3.5-4 5.5V21M16 3v3.5c0 2-4 3.7-4 5.5s4 3.5 4 5.5V21" /></Svg>
);
export const EnterKey = (p: IconProps) => (
  <Svg {...p}><path d="M20 5v7a2 2 0 0 1-2 2H5" /><path d="m9 10-4 4 4 4" /></Svg>
);
export const Handshake = (p: IconProps) => (
  <Svg {...p}><path d="m2.5 12 4-4 3.5 3 2-1.5 2 1.5 3.5-3 4 4-4 5-3-2.5-2 1.5-2-1.5-3 2.5z" /><path d="m10 11 2.5 2.5" /></Svg>
);
export const Lizard = (p: IconProps) => (
  <Svg {...p}><path d="M20.5 6.5c-2 0-3.5 1.2-4.5 2.5-1.6 2-3.4 3-5.5 3S7 10.5 5 10.5a2.5 2.5 0 0 0 0 5c2.5 0 3.5 1 3.5 2.5S7 21 5 21" /><path d="M20.5 6.5a2.2 2.2 0 1 0-3-2" /><path d="M16 9.5c1 1.6 1 3.4 0 5" /></Svg>
);
export const Keyboard = (p: IconProps) => (
  <Svg {...p}><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 9.5v.01M9.5 9.5v.01M13 9.5v.01M16.5 9.5v.01M6 12.5v.01M9.5 12.5v.01M13 12.5v.01M16.5 12.5v.01M8 15.5h8" strokeWidth={2} /></Svg>
);
export const Fuel = (p: IconProps) => (
  <Svg {...p}><path d="M4 20V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15" /><path d="M3 20.5h11M6.5 8.5h4" /><path d="M13 8h3.5a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 0 3 0V11l-2.5-2.5" /></Svg>
);
export const GridView = (p: IconProps) => (
  <Svg {...p}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></Svg>
);
export const ListView = (p: IconProps) => (
  <Svg {...p}><path d="M4 6.5h16M4 12h16M4 17.5h16" /></Svg>
);
/** First place — laurel-wreathed medal, distinct from the generic Medal. */
export const MedalFirst = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="14" r="6" /><path d="M11 11.5 12.5 11v6" strokeWidth={2} /><path d="M6 5c-1.5 2.5-1 5 1 6.8M18 5c1.5 2.5 1 5-1 6.8" /></Svg>
);

// ── Ornaments (previously ◇ ◆ ◈ • ★) ─────────────────────────────────────────

/** Small diamond ornament used as a section flourish. */
export const Diamond = (p: IconProps) => (
  <SvgFilled {...p}><path d="M12 3 20 12l-8 9-8-9z" /></SvgFilled>
);
export const DiamondOutline = (p: IconProps) => (
  <Svg {...p}><path d="M12 3.5 19.5 12 12 20.5 4.5 12z" /></Svg>
);
/** Divider flourish: line — diamond — line. Scales with font-size. */
export function Flourish({ width = 120, color = 'currentColor', style, ...rest }:
  Omit<IconProps, 'size'> & { width?: number | string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 12" width={width} height="12"
      fill="none" aria-hidden="true" focusable="false"
      style={{ display: 'inline-block', verticalAlign: 'middle', ...style }} {...rest}
    >
      <path d="M2 6h44M74 6h44" stroke={color} strokeWidth="1" opacity="0.55" strokeLinecap="round" />
      <path d="M60 1.5 65 6l-5 4.5L55 6z" fill={color} />
    </svg>
  );
}
export const Dot = (p: IconProps) => (
  <SvgFilled {...p}><circle cx="12" cy="12" r="4.5" /></SvgFilled>
);

/**
 * Registry for places that pick an icon by string key (e.g. data-driven lists
 * that previously stored an emoji character).
 */
export const ICONS = {
  arrowRight: ArrowRight, arrowLeft: ArrowLeft, arrowDown: ArrowDown, arrowUp: ArrowUp,
  arrowUpRight: ArrowUpRight, chevronRight: ChevronRight, chevronLeft: ChevronLeft,
  chevronDown: ChevronDown, menu: Menu, close: Close, check: Check, plus: Plus, minus: Minus,
  refresh: Refresh, play: Play, external: External, search: Search, copy: Copy, edit: Edit,
  trash: Trash, save: Save, folder: Folder, download: Download,
  swords: Swords, shield: Shield, shieldCheck: ShieldCheck, hand: Hand, skull: Skull,
  heart: Heart, bolt: Bolt, fire: Fire, robot: Robot, wizard: Wizard, ghost: Ghost, frog: Frog,
  cards: Cards, deck: Deck, dice: Dice, target: Target, gamepad: Gamepad,
  trophy: Trophy, medal: Medal, star: Star, starOutline: StarOutline, crown: Crown, gem: Gem,
  coins: Coins, chart: Chart,
  castle: Castle, temple: Temple, map: Map, scroll: Scroll, book: Book, books: Books,
  globe: Globe, moon: Moon, orb: Orb, link: Link, chain: Chain,
  warning: Warning, info: Info, lock: Lock, user: User, users: Users, chat: Chat, mic: Mic,
  soundOn: SoundOn, soundOff: SoundOff, music: Music, settings: Settings, tools: Tools,
  monitor: Monitor, mobile: Mobile, fox: Fox, backpack: Backpack,
  hourglass: Hourglass, enterKey: EnterKey, handshake: Handshake, lizard: Lizard,
  keyboard: Keyboard, fuel: Fuel, gridView: GridView, listView: ListView, medalFirst: MedalFirst,
  diamond: Diamond, diamondOutline: DiamondOutline, dot: Dot,
} as const;

export type IconKey = keyof typeof ICONS;

/** Render an icon by key: <Icon name="trophy" size={18} /> */
export function Icon({ name, ...rest }: IconProps & { name: IconKey }) {
  const C = ICONS[name];
  return <C {...rest} />;
}
