"use client";

// Card renderer — real game visuals.
//
// Resolution order (mirrors the legacy CardPreview):
//  1. templateFor(def) → MTG-style frame image (/template-*.jpg|png) with
//     overlaid regions (name bar / art window / type line / rules box)
//     positioned in % of the card, so one implementation scales from hand
//     size (~w-14) to the large dialog view (w-64).
//  2. No template (robinhood / base) → styled chain-colored frame with the
//     same region structure.
// Art comes from def.image (merged into CARDS defs from the game-core IMAGES
// map — includes /cards/*, /nodes/* and remote CMC/twemoji URLs). On missing
// or failed art we fall back to a chain-colored panel with the big glyph.
//
// The card root is a CSS size container: all typography uses cqw units
// (1% of card width) with px floors, so any width — including className
// overrides — renders correctly.

import { useState } from "react";
import {
  COLOR_META,
  COLORS,
  templateFor,
  type CardDef,
  type Color,
} from "@chains/game-core";
import { cn } from "@/lib/utils";

export type CardSize = "xs" | "sm" | "md" | "lg";

/** Width per size; height always derives from the card aspect ratio. */
const SIZE_CLASSES: Record<CardSize, string> = {
  xs: "w-14 rounded",
  sm: "w-20 rounded-md",
  md: "w-24 rounded-md",
  lg: "w-64 rounded-lg",
};

/** Template scans are ~969x1352 / 1080x1457 — both ≈ the classic 5:7 card. */
const CARD_ASPECT = "aspect-[5/7]";

const TYPE_LABEL: Record<CardDef["type"], string> = {
  node: "Node",
  meme: "Meme",
  machine: "Machine",
  aura: "Aura",
  move: "Move",
};

const CINZEL = "var(--font-cinzel), Georgia, serif";
const GARAMOND = "var(--font-garamond), Georgia, serif";

/** Standalone cost pips (also used by the deckbuilder list rows). */
export function CostPips({
  cost,
  size = "md",
}: {
  cost?: CardDef["cost"];
  size?: CardSize;
}) {
  if (!cost) return null;
  const pip =
    size === "lg" ? "w-4 h-4 text-[10px]" : size === "xs" ? "w-2 h-2 text-[6px]" : "w-2.5 h-2.5 text-[7px]";
  const pips: React.ReactNode[] = [];
  for (const c of COLORS) {
    const n = cost[c] ?? 0;
    for (let i = 0; i < n; i++) {
      pips.push(
        <span
          key={`${c}${i}`}
          className={cn("rounded-full inline-block shrink-0 ring-1 ring-black/40", pip)}
          style={{ backgroundColor: COLOR_META[c as Color].hex }}
        />
      );
    }
  }
  if ((cost.any ?? 0) > 0) {
    pips.push(
      <span
        key="any"
        className={cn(
          "rounded-full inline-flex items-center justify-center shrink-0 bg-zinc-300 text-zinc-900 font-bold ring-1 ring-black/40",
          pip
        )}
      >
        {cost.any}
      </span>
    );
  }
  return <span className="flex items-center gap-0.5">{pips}</span>;
}

/** Card-width-scaled cost pips used inside the card face itself. */
function Pips({ cost }: { cost?: CardDef["cost"] }) {
  if (!cost) return null;
  const pipStyle = {
    width: "max(6cqw, 6px)",
    height: "max(6cqw, 6px)",
    fontSize: "max(4cqw, 5px)",
  } as const;
  const pips: React.ReactNode[] = [];
  for (const c of COLORS) {
    const n = cost[c] ?? 0;
    for (let i = 0; i < n; i++) {
      pips.push(
        <span
          key={`${c}${i}`}
          className="rounded-full inline-block shrink-0 ring-1 ring-black/50"
          style={{ ...pipStyle, backgroundColor: COLOR_META[c as Color].hex }}
        />
      );
    }
  }
  if ((cost.any ?? 0) > 0) {
    pips.push(
      <span
        key="any"
        className="rounded-full inline-flex items-center justify-center shrink-0 bg-zinc-300 text-zinc-900 font-bold ring-1 ring-black/50 leading-none"
        style={pipStyle}
      >
        {cost.any}
      </span>
    );
  }
  return <span className="flex items-center shrink-0 gap-[1.2cqw]">{pips}</span>;
}

/**
 * Art window content: def.image (cover) with a chain-colored glyph panel as
 * the fallback for missing/broken art.
 */
function CardArt({
  def,
  glyph,
  watermark,
}: {
  def: CardDef;
  glyph: string;
  /** Plain-frame style: dim glyph on the dark frame instead of a color panel. */
  watermark?: boolean;
}) {
  const [failedId, setFailedId] = useState<string | null>(null);
  const meta = COLOR_META[def.color];
  if (def.image && failedId !== def.id) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={def.id}
        src={def.image}
        alt=""
        draggable={false}
        loading="lazy"
        className="absolute inset-0 w-full h-full object-cover"
        onError={() => setFailedId(def.id)}
      />
    );
  }
  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={
        watermark
          ? undefined
          : {
              background: `radial-gradient(circle at 50% 35%, ${meta.hex} 0%, ${meta.hex}44 62%, #0c0a14 100%)`,
            }
      }
    >
      <span
        className={cn("font-black tracking-widest leading-none", watermark && "opacity-25")}
        style={{
          color: watermark ? meta.hex : meta.ink,
          fontSize: glyph.length > 4 ? "11cqw" : "18cqw",
          textShadow: watermark ? undefined : "0 2px 8px rgba(0,0,0,0.6)",
        }}
      >
        {glyph}
      </span>
    </div>
  );
}

/**
 * MTG-style frame: template scan as the background with content positioned
 * into its slots (regions tuned against the template images, same values as
 * the legacy CardPreview).
 */
function TemplatedFace({
  def,
  tpl,
  showText,
}: {
  def: CardDef;
  tpl: { url: string; glyph?: string };
  showText: boolean;
}) {
  const meta = COLOR_META[def.color];
  return (
    <div
      className="absolute inset-0"
      style={{
        backgroundImage: `url(${tpl.url})`,
        backgroundSize: "100% 100%",
        backgroundRepeat: "no-repeat",
      }}
    >
      {/* Name bar */}
      <div
        className="absolute flex items-center justify-between"
        style={{ top: "5.2%", left: "9%", right: "9%", height: "5.8%", gap: "2cqw" }}
      >
        <span
          className="truncate font-bold leading-none text-[#1a1208]"
          style={{ fontSize: "max(5cqw, 6px)", fontFamily: CINZEL }}
        >
          {def.name}
        </span>
        <Pips cost={def.cost} />
      </div>

      {/* Art window */}
      <div
        className="absolute overflow-hidden"
        style={{ top: "13%", left: "8.5%", right: "8.5%", height: "44%" }}
      >
        <CardArt def={def} glyph={tpl.glyph ?? meta.glyph ?? meta.name} />
      </div>

      {/* Type line */}
      <div
        className="absolute flex items-center"
        style={{ top: "58.4%", left: "9.5%", right: "9.5%", height: "4.6%" }}
      >
        <span
          className="truncate uppercase font-semibold text-[#1a1208]"
          style={{ fontSize: "max(3.4cqw, 4.5px)", letterSpacing: "0.06em" }}
        >
          {TYPE_LABEL[def.type]} · {meta.name}
        </span>
      </div>

      {/* Rules text (large size only — illegible below that) */}
      {showText && (
        <div
          className="absolute overflow-hidden text-[#241a10] whitespace-pre-wrap"
          style={{
            top: "66.5%",
            left: "10%",
            right: "10%",
            bottom: "8%",
            fontSize: "4.4cqw",
            lineHeight: 1.3,
            fontFamily: GARAMOND,
          }}
        >
          {def.text}
        </div>
      )}
    </div>
  );
}

/** Styled frame for chains without a template scan (robinhood / base). */
function PlainFace({ def, showText }: { def: CardDef; showText: boolean }) {
  const meta = COLOR_META[def.color];
  return (
    <div
      className="absolute inset-0 flex flex-col rounded-[inherit] border-2"
      style={{
        borderColor: meta.hex,
        background: `linear-gradient(160deg, ${meta.hex}26 0%, #0d0d16 45%, #0a0a12 100%)`,
      }}
    >
      {/* Name bar */}
      <div
        className="flex items-center justify-between shrink-0 px-[4%] py-[2.5%]"
        style={{ backgroundColor: `${meta.hex}33`, gap: "2cqw" }}
      >
        <span
          className="truncate font-bold leading-tight text-foreground"
          style={{ fontSize: "max(5cqw, 6px)", fontFamily: CINZEL }}
        >
          {def.name}
        </span>
        <Pips cost={def.cost} />
      </div>

      {/* Art window */}
      <div className="relative flex-1 overflow-hidden">
        <CardArt
          def={def}
          glyph={COLOR_META[def.color].glyph ?? def.color.toUpperCase()}
          watermark={!def.image}
        />
      </div>

      {/* Type line */}
      <div
        className="shrink-0 px-[4%] py-[1.5%] uppercase text-muted-foreground border-t truncate"
        style={{
          borderColor: `${meta.hex}55`,
          fontSize: "max(3.4cqw, 4.5px)",
          letterSpacing: "0.06em",
        }}
      >
        {TYPE_LABEL[def.type]} · {meta.name}
      </div>

      {/* Rules text (large size only) */}
      {showText && (
        <div
          className="shrink-0 px-[4%] py-[2.5%] h-[26%] overflow-y-auto bg-black/30 text-foreground/85 whitespace-pre-wrap"
          style={{ fontSize: "4.4cqw", lineHeight: 1.3, fontFamily: GARAMOND }}
        >
          {def.text}
        </div>
      )}
    </div>
  );
}

export interface GameCardProps {
  def: CardDef;
  size?: CardSize;
  tapped?: boolean;
  selected?: boolean;
  /** Legal target / actionable highlight. */
  highlighted?: boolean;
  /** Unaffordable / not actionable. */
  dimmed?: boolean;
  /** Small corner badge (e.g. attacker number, "SICK"). */
  badge?: string;
  /** Displayed P/T override (with pumps/auras applied). */
  power?: number;
  toughness?: number;
  damage?: number;
  auraCount?: number;
  onClick?: () => void;
  className?: string;
}

export function GameCard({
  def,
  size = "md",
  tapped,
  selected,
  highlighted,
  dimmed,
  badge,
  power,
  toughness,
  damage,
  auraCount,
  onClick,
  className,
}: GameCardProps) {
  const meta = COLOR_META[def.color];
  const tpl = templateFor(def);
  const isMeme = def.type === "meme";
  const p = power ?? def.power;
  const t = toughness ?? def.toughness;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={def.name}
      className={cn(
        "relative block overflow-hidden text-left shrink-0 select-none",
        "transition-all duration-150 [container-type:inline-size]",
        CARD_ASPECT,
        SIZE_CLASSES[size],
        tapped && "rotate-[8deg] opacity-70 saturate-50",
        selected &&
          "ring-2 ring-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.7)] -translate-y-1",
        highlighted && "ring-2 ring-cyan-300 animate-pulse",
        dimmed && "opacity-40 saturate-50",
        onClick && "cursor-pointer active:scale-95",
        className
      )}
    >
      {tpl ? (
        <TemplatedFace def={def} tpl={tpl} showText={size === "lg"} />
      ) : (
        <PlainFace def={def} showText={size === "lg"} />
      )}

      {/* P/T badge */}
      {isMeme && (
        <span
          className="absolute z-10 font-black leading-none whitespace-nowrap"
          style={{
            right: "5.5%",
            bottom: "4.5%",
            fontSize: "max(7cqw, 8px)",
            padding: "0.15em 0.4em",
            borderRadius: "0.3em",
            background: tpl ? "#e8e6c8" : meta.hex,
            color: tpl ? "#1a1208" : meta.ink,
            border: "1px solid rgba(0,0,0,0.55)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.6)",
          }}
        >
          {p}/{t}
          {damage ? <span className="text-red-600"> -{damage}</span> : null}
        </span>
      )}

      {/* Aura count */}
      {auraCount ? (
        <span
          className="absolute z-10 rounded bg-violet-600 text-white font-bold ring-1 ring-black/60 leading-none"
          style={{
            left: "5.5%",
            bottom: "4.5%",
            fontSize: "max(5.5cqw, 8px)",
            padding: "0.2em 0.35em",
          }}
        >
          +{auraCount}
        </span>
      ) : null}

      {/* Corner badge */}
      {badge && (
        <span className="absolute top-0.5 right-0.5 z-10 rounded-full bg-primary text-primary-foreground font-bold min-w-4 h-4 px-1 inline-flex items-center justify-center text-[9px] ring-1 ring-black/60 shadow-[0_1px_4px_rgba(0,0,0,0.7)]">
          {badge}
        </span>
      )}
    </button>
  );
}

/** Face-down card (opponent hand / deck): obsidian back, gold trim, RH mark. */
export function CardBack({
  size = "xs",
  className,
}: {
  size?: CardSize;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden select-none [container-type:inline-size]",
        "border border-amber-500/60",
        "bg-[radial-gradient(ellipse_at_50%_35%,#2a1f4d_0%,#161129_55%,#0a0714_100%)]",
        CARD_ASPECT,
        SIZE_CLASSES[size],
        className
      )}
    >
      {/* Inner gold trim */}
      <span className="absolute inset-[5%] rounded-[inherit] border border-amber-400/30" />
      {/* Diamond ornament */}
      <span className="absolute left-1/2 top-1/2 w-[46%] aspect-square -translate-x-1/2 -translate-y-1/2 rotate-45 border border-amber-400/40" />
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-[3%]">
        <span
          className="font-black leading-none text-amber-300/90"
          style={{
            fontFamily: CINZEL,
            fontSize: "24cqw",
            textShadow: "0 0 12px rgba(167,139,250,0.5)",
          }}
        >
          RH
        </span>
        <span
          className="uppercase font-semibold text-violet-300/60"
          style={{ fontSize: "6.5cqw", letterSpacing: "0.35em" }}
        >
          Chains
        </span>
      </span>
    </div>
  );
}
