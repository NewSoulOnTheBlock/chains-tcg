/// <reference types="vite/client" />

// Ambient global augmentations used across the client, so call sites drop their
// `as any` escape hatches (frontend-18, task 4).
//
// NOTE: `window.ethereum` is intentionally NOT declared here — `src/wallet.ts`
// already declares it (`interface Window { ethereum?: any }`) and a second,
// differently-typed declaration of the same member is a TS merge error. The
// canonical declaration stays in wallet.ts.

/** `detail` of the `mmtcg:solo-end` event the board fires when a solo match ends. */
interface SoloEndDetail {
  /** boardgame.io player id of the winner ('0' = the human). Absent on a draw. */
  winnerSeat?: '0' | '1' | string;
  turns?: number;
}

interface WindowEventMap {
  'mmtcg:solo-end': CustomEvent<SoloEndDetail>;
}

interface Navigator {
  /** Web Share API — present on most mobile browsers, absent on desktop. */
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
}
