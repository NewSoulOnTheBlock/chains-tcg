"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { Music, VolumeX } from "lucide-react";

/** Legacy localStorage key: "true" = muted. Defaults to muted (autoplay-safe). */
const MUTE_KEY = "chains:musicMuted";
const VOLUME = 0.35;

/* Mute state lives in localStorage; expose it as an external store so
   same-tab toggles and cross-tab "storage" events both re-render us. */
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function isMuted() {
  return localStorage.getItem(MUTE_KEY) !== "false";
}
function setMuted(next: boolean) {
  localStorage.setItem(MUTE_KEY, String(next));
  listeners.forEach((l) => l());
}

/**
 * Looping menu music with a small floating mute toggle (bottom-right).
 * Inactive (fully unmounted) on in-game routes (/play/[matchID], /play/solo) —
 * the lobby at /play still counts as a menu screen.
 */
export function MenuMusic() {
  const pathname = usePathname();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Server snapshot is "muted" so SSR/CSR markup match before hydration.
  const muted = useSyncExternalStore(subscribe, isMuted, () => true);

  const inGame = pathname?.startsWith("/play/") ?? false;

  // Sync the <audio> element (external system) with the mute state.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (muted) {
      audio.pause();
    } else {
      audio.volume = VOLUME;
      audio.play().catch(() => {
        // Autoplay blocked — the toggle button (a real gesture) still works.
      });
    }
  }, [muted]);

  if (inGame) return null;

  function toggle() {
    const next = !muted;
    setMuted(next);
    // Also start playback inside the click gesture so browsers allow audio.
    const audio = audioRef.current;
    if (audio && !next) {
      audio.volume = VOLUME;
      audio.play().catch(() => {});
    }
  }

  return (
    <>
      <audio ref={audioRef} src="/menu-music.mp3" loop preload="none" />
      <button
        type="button"
        onClick={toggle}
        aria-label={muted ? "Play menu music" : "Mute menu music"}
        aria-pressed={!muted}
        title={muted ? "Play menu music" : "Mute menu music"}
        className="fixed bottom-4 right-4 z-40 flex size-9 items-center justify-center rounded-full border border-border bg-background/70 text-muted-foreground backdrop-blur-sm transition-colors hover:text-foreground hover:border-primary/50"
      >
        {muted ? <VolumeX className="size-4" /> : <Music className="size-4 text-primary" />}
      </button>
    </>
  );
}
