/**
 * Full-viewport scene background (legacy Chains look): a fixed cover image
 * behind the page with a dark gradient overlay so foreground text stays
 * AA-readable. Optionally blurred (legacy hub used blur(2px)).
 *
 * Renders behind everything via -z-10; mount it anywhere inside the page.
 */
type SceneBackgroundProps = {
  /** Public path of the image, e.g. "/hub-bg.png". */
  src: string;
  /** Apply the legacy hub-style 2px blur. */
  blur?: boolean;
  /** Overlay darkness. "strong" for busy hub scenes, "soft" for splash art. */
  overlay?: "soft" | "strong";
};

const OVERLAYS: Record<NonNullable<SceneBackgroundProps["overlay"]>, string> = {
  soft: "linear-gradient(180deg, rgba(10,10,15,0.55) 0%, rgba(10,10,15,0.68) 55%, rgba(10,10,15,0.88) 100%)",
  strong:
    "linear-gradient(180deg, rgba(10,10,15,0.82) 0%, rgba(10,10,15,0.87) 55%, rgba(10,10,15,0.93) 100%)",
};

export function SceneBackground({
  src,
  blur = false,
  overlay = "soft",
}: SceneBackgroundProps) {
  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden select-none">
      <div
        className="absolute -inset-2 bg-cover bg-center"
        style={{
          backgroundImage: `url(${src})`,
          // -inset-2 + blur keeps the blurred edge halo off-screen.
          filter: blur ? "blur(2px)" : undefined,
        }}
      />
      <div className="absolute inset-0" style={{ background: OVERLAYS[overlay] }} />
    </div>
  );
}
