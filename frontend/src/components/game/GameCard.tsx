"use client";

// Card renderer. Until real art exists it draws a handsome placeholder frame:
// chain-colored border + header, glyph watermark, cost pips, P/T badge.
// Real art drops in later by adding files at frontend/public/cards/<id>.png.

import { useState } from "react";
import {
  COLOR_META,
  COLORS,
  type CardDef,
  type Color,
} from "@chains/game-core";
import { cn } from "@/lib/utils";

export type CardSize = "xs" | "sm" | "md" | "lg";

const SIZE_CLASSES: Record<CardSize, string> = {
  xs: "w-14 h-[4.9rem] rounded-md text-[7px]",
  sm: "w-20 h-28 rounded-lg text-[8px]",
  md: "w-24 h-[8.4rem] rounded-lg text-[9px]",
  lg: "w-64 h-[22.4rem] rounded-2xl text-sm",
};

const TYPE_LABEL: Record<CardDef["type"], string> = {
  node: "Node",
  meme: "Meme",
  machine: "Machine",
  aura: "Aura",
  move: "Move",
};

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
  const [artFailed, setArtFailed] = useState(false);
  const meta = COLOR_META[def.color];
  const isMeme = def.type === "meme";
  const showText = size === "lg";
  const compact = size === "xs" || size === "sm";
  const p = power ?? def.power;
  const t = toughness ?? def.toughness;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      aria-label={def.name}
      className={cn(
        "relative flex flex-col overflow-hidden text-left shrink-0 select-none",
        "border transition-all duration-150",
        SIZE_CLASSES[size],
        tapped && "rotate-[8deg] opacity-60",
        selected && "ring-2 ring-primary -translate-y-1",
        highlighted && "ring-2 ring-ring animate-pulse",
        dimmed && "opacity-40 saturate-50",
        onClick && "cursor-pointer active:scale-95",
        className
      )}
      style={{
        borderColor: meta.hex,
        background: `linear-gradient(160deg, ${meta.hex}26 0%, #0d0d16 45%, #0a0a12 100%)`,
      }}
    >
      {/* Header: name + cost */}
      <div
        className="flex items-center justify-between gap-1 px-1 py-0.5"
        style={{ backgroundColor: `${meta.hex}33` }}
      >
        <span className="font-semibold truncate leading-tight text-foreground">
          {def.name}
        </span>
        {!compact || def.type !== "node" ? (
          <CostPips cost={def.cost} size={size} />
        ) : null}
      </div>

      {/* Art / glyph watermark */}
      <div className="relative flex-1 flex items-center justify-center overflow-hidden">
        {!artFailed && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/cards/${def.id}.png`}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => setArtFailed(true)}
          />
        )}
        {artFailed && (
          <span
            className={cn(
              "font-black tracking-widest opacity-25",
              size === "lg" ? "text-5xl" : compact ? "text-sm" : "text-lg"
            )}
            style={{ color: meta.hex }}
          >
            {meta.glyph ?? def.color.toUpperCase()}
          </span>
        )}
      </div>

      {/* Type line */}
      <div
        className="px-1 py-px uppercase tracking-wider text-muted-foreground border-t"
        style={{ borderColor: `${meta.hex}55` }}
      >
        {TYPE_LABEL[def.type]} · {meta.name}
      </div>

      {/* Effect text (large only) */}
      {showText && (
        <div className="px-2 py-1.5 h-24 overflow-y-auto text-xs leading-snug text-foreground/85 bg-black/30">
          {def.text}
        </div>
      )}

      {/* P/T badge */}
      {isMeme && (
        <span
          className={cn(
            "absolute bottom-0.5 right-0.5 rounded font-bold px-1 leading-tight ring-1 ring-black/50",
            size === "lg" ? "text-base px-2 py-0.5" : "text-[9px]"
          )}
          style={{ backgroundColor: meta.hex, color: meta.ink }}
        >
          {p}/{t}
          {damage ? <span className="text-red-700"> -{damage}</span> : null}
        </span>
      )}

      {/* Aura count */}
      {auraCount ? (
        <span className="absolute bottom-0.5 left-0.5 rounded bg-violet-500 text-white font-bold px-1 text-[9px] ring-1 ring-black/50">
          +{auraCount}
        </span>
      ) : null}

      {/* Corner badge */}
      {badge && (
        <span className="absolute top-0.5 right-0.5 z-10 rounded-full bg-primary text-primary-foreground font-bold min-w-4 h-4 px-1 inline-flex items-center justify-center text-[9px] ring-1 ring-black/50">
          {badge}
        </span>
      )}
    </button>
  );
}

/** Face-down card (opponent hand / deck). */
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
        "shrink-0 border border-violet-900/70 bg-gradient-to-br from-violet-950 via-[#12101f] to-black",
        "flex items-center justify-center",
        SIZE_CLASSES[size],
        className
      )}
    >
      <span className="text-violet-500/50 font-black text-[8px] tracking-widest rotate-45">
        CHAINS
      </span>
    </div>
  );
}
