"use client";

// CardInspect — MTG Arena-style card preview.
//
// Desktop (mouse/pen): hovering any wrapped card for ~250ms shows a large
// floating GameCard (size "lg") with a caption panel (type line, cost in
// words, rules text, plain-English effect explanation). The preview is
// positioned beside the hovered card, flipped/clamped to stay inside the
// viewport, and is pointer-events-none so it never blocks clicks.
//
// Mobile (touch): long-press (~350ms) opens the same preview as a centered
// overlay; releasing or tapping outside dismisses it. A fired long-press
// swallows the subsequent click so tap-to-play/select is not triggered.
//
// One provider = one preview at a time. `suppressed` (targeting / attack /
// blocking modes) hides the preview and ignores new show requests so combat
// clicks are never obstructed.

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { CardDef } from "@chains/game-core";
import { cn } from "@/lib/utils";
import { GameCard } from "./GameCard";
import { costWords, explainCard, typeLine } from "./effect-text";

const GARAMOND = "var(--font-garamond), Georgia, serif";

type InspectState =
  | { def: CardDef; mode: "float"; anchor: DOMRect }
  | { def: CardDef; mode: "overlay" };

interface InspectApi {
  show: (state: InspectState) => void;
  hide: () => void;
  suppressed: boolean;
}

/** Default: no provider mounted → inert (Inspectable degrades gracefully). */
const InspectContext = createContext<InspectApi>({
  show: () => {},
  hide: () => {},
  suppressed: true,
});

/** Caption panel: type line, cost in words, rules text + explanation. */
export function CardInspectCaption({
  def,
  className,
}: {
  def: CardDef;
  className?: string;
}) {
  const explanation = explainCard(def);
  return (
    <div
      className={cn(
        "w-64 max-w-full rounded-md border border-border bg-popover/95 px-3 py-2 text-popover-foreground shadow-lg space-y-1",
        className
      )}
    >
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {typeLine(def)}
      </p>
      <p className="text-[11px] font-medium">{costWords(def)}</p>
      {def.text && (
        <p className="text-xs leading-snug whitespace-pre-wrap">{def.text}</p>
      )}
      {explanation && (
        <p
          className="text-xs leading-snug italic text-muted-foreground"
          style={{ fontFamily: GARAMOND }}
        >
          {explanation}
        </p>
      )}
    </div>
  );
}

const EDGE = 8; // viewport margin
const GAP = 12; // gap between anchor card and preview

function FloatPreview({ def, anchor }: { def: CardDef; anchor: DOMRect }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer beside the card (never covering it): right, then left.
    let left: number;
    if (anchor.right + GAP + w <= vw - EDGE) {
      left = anchor.right + GAP;
    } else if (anchor.left - GAP - w >= EDGE) {
      left = anchor.left - GAP - w;
    } else {
      left = Math.max(EDGE, vw - w - EDGE);
    }
    let top = Math.min(
      Math.max(EDGE, anchor.top + anchor.height / 2 - h / 2),
      vh - h - EDGE
    );

    // If we still overlap the anchor horizontally, flip above/below instead.
    const overlapsX = left < anchor.right && left + w > anchor.left;
    if (overlapsX) {
      left = Math.min(
        Math.max(EDGE, anchor.left + anchor.width / 2 - w / 2),
        vw - w - EDGE
      );
      if (anchor.top - GAP - h >= EDGE) top = anchor.top - GAP - h;
      else if (anchor.bottom + GAP + h <= vh - EDGE) top = anchor.bottom + GAP;
    }
    setPos({ left, top });
  }, [def, anchor]);

  return (
    <div
      ref={ref}
      className="fixed z-[90] pointer-events-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-100"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <GameCard def={def} size="lg" className="shadow-2xl shadow-black/70" />
      <CardInspectCaption def={def} className="mt-1.5" />
    </div>
  );
}

function OverlayPreview({
  def,
  onDismiss,
}: {
  def: CardDef;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[90] flex flex-col items-center justify-center gap-1.5 p-4 bg-black/70 backdrop-blur-[2px] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-100"
      onPointerDown={onDismiss}
      onClick={onDismiss}
      role="presentation"
    >
      <div className="motion-safe:animate-in motion-safe:zoom-in-95 motion-safe:duration-100 max-h-full overflow-y-auto flex flex-col items-center gap-1.5">
        <GameCard def={def} size="lg" className="shadow-2xl shadow-black/80" />
        <CardInspectCaption def={def} />
      </div>
    </div>
  );
}

/**
 * Mount once (e.g. around the Board or a page). All <Inspectable> descendants
 * share the single preview so only one shows at a time.
 */
export function CardInspectProvider({
  suppressed = false,
  children,
}: {
  /** While true (targeting / attack / blocking), previews are hidden and new ones ignored. */
  suppressed?: boolean;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<InspectState | null>(null);

  // Render-time adjustment: entering a suppressed mode closes any open preview.
  const [prevSuppressed, setPrevSuppressed] = useState(suppressed);
  if (suppressed !== prevSuppressed) {
    setPrevSuppressed(suppressed);
    if (suppressed) setState(null);
  }

  const api = useMemo<InspectApi>(
    () => ({
      show: (s) => {
        if (!suppressed) setState(s);
      },
      hide: () => setState(null),
      suppressed,
    }),
    [suppressed]
  );

  return (
    <InspectContext.Provider value={api}>
      {children}
      {state &&
        createPortal(
          state.mode === "float" ? (
            <FloatPreview def={state.def} anchor={state.anchor} />
          ) : (
            <OverlayPreview def={state.def} onDismiss={() => setState(null)} />
          ),
          document.body
        )}
    </InspectContext.Provider>
  );
}

const HOVER_DELAY_MS = 250;
const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE_PX = 10;

/**
 * Wrap any card (GameCard or otherwise) to give it hover / long-press
 * inspection. Purely additive: existing onClick behavior on the child is
 * preserved (a fired long-press swallows the following click).
 */
export function Inspectable({
  def,
  children,
  className,
  longPress = true,
}: {
  def: CardDef;
  children: React.ReactNode;
  className?: string;
  /** Disable the touch long-press path (e.g. where tap already opens a dialog). */
  longPress?: boolean;
}) {
  const { show, hide, suppressed } = useContext(InspectContext);
  const ref = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const longPressed = useRef(false);

  const clearTimers = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  useEffect(() => clearTimers, []);

  return (
    <div
      ref={ref}
      className={cn("shrink-0", className)}
      style={{ WebkitTouchCallout: "none" }}
      onPointerEnter={(e) => {
        if (e.pointerType === "touch" || suppressed) return;
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => {
          const rect = ref.current?.getBoundingClientRect();
          if (rect) show({ def, mode: "float", anchor: rect });
        }, HOVER_DELAY_MS);
      }}
      onPointerLeave={() => {
        clearTimers();
        pressStart.current = null;
        hide();
      }}
      onPointerDown={(e) => {
        longPressed.current = false;
        if (e.pointerType !== "touch" || !longPress || suppressed) return;
        pressStart.current = { x: e.clientX, y: e.clientY };
        pressTimer.current = setTimeout(() => {
          pressTimer.current = null;
          longPressed.current = true;
          show({ def, mode: "overlay" });
        }, LONG_PRESS_MS);
      }}
      onPointerMove={(e) => {
        // A drag/scroll cancels the pending long-press.
        if (!pressTimer.current || !pressStart.current) return;
        if (
          Math.abs(e.clientX - pressStart.current.x) > MOVE_TOLERANCE_PX ||
          Math.abs(e.clientY - pressStart.current.y) > MOVE_TOLERANCE_PX
        ) {
          clearTimeout(pressTimer.current);
          pressTimer.current = null;
          pressStart.current = null;
        }
      }}
      onPointerUp={() => {
        if (pressTimer.current) clearTimeout(pressTimer.current);
        pressTimer.current = null;
        pressStart.current = null;
        if (longPressed.current) hide();
      }}
      onPointerCancel={() => {
        if (pressTimer.current) clearTimeout(pressTimer.current);
        pressTimer.current = null;
        pressStart.current = null;
        if (longPressed.current) {
          longPressed.current = false;
          hide();
        }
      }}
      onClickCapture={(e) => {
        // Long-press consumed this gesture — don't let it play/select the card.
        if (longPressed.current) {
          e.preventDefault();
          e.stopPropagation();
          longPressed.current = false;
        }
      }}
      onContextMenu={(e) => {
        // Suppress the OS context menu during a touch long-press.
        if (longPressed.current || pressTimer.current) e.preventDefault();
      }}
    >
      {children}
    </div>
  );
}
