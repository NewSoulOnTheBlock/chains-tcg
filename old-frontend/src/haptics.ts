// Lightweight haptic feedback. No-op anywhere the Vibration API is missing
// (Safari iOS in a regular tab, Firefox desktop, etc.). When wrapped in a PWA
// or a Telegram WebApp later we'll be able to forward to those richer APIs.

type Pattern = number | number[];

function vibrate(pattern: Pattern): void {
  try {
    if (typeof navigator !== 'undefined' && typeof (navigator as any).vibrate === 'function') {
      (navigator as any).vibrate(pattern);
    }
  } catch { /* swallow */ }
}

export const Haptics = {
  /** Light confirmation — UI toggle, card pick. */
  tap:     () => vibrate(12),
  /** Card lands on the battlefield, gas spent, node tapped. */
  play:    () => vibrate(28),
  /** Attackers declared / strike confirmed. */
  attack:  () => vibrate([18, 40, 18]),
  /** Damage dealt to player / removal resolved. */
  damage:  () => vibrate([10, 30, 10, 30]),
  /** Phase change handed back to you. */
  turn:    () => vibrate([14, 22, 14]),
  /** Player tried something illegal. */
  invalid: () => vibrate([30, 30]),
  /** Match ended in your favor. */
  win:     () => vibrate([90, 50, 90, 50, 180]),
  /** Match ended against you. */
  loss:    () => vibrate(260),
};
