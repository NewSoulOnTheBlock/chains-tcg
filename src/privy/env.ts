// src/privy/env.ts
//
// The EAGER half of the Privy integration: "may we offer social sign-in at
// all?", plus the tiny persisted marker that remembers a player signed in
// through Privy on this device.
//
// ─── WHY THIS FILE IS TINY, AND WHY IT MUST STAY THAT WAY ───────────────────
//
// Everything else under `src/privy/**` imports `@privy-io/react-auth`, which
// is several hundred kilobytes of SDK. Players who sign in with a browser
// wallet must never download any of it, so the heavy module (`runtime.tsx`) is
// only ever reached through a dynamic `import()` / `React.lazy`.
//
// This module is the exception: it is imported EAGERLY, from the login screen,
// from settings and from the App-level logout handler, to decide whether to
// render the social options at all and whether a Privy session might exist.
// So it may not import anything from `@privy-io/*`, directly or transitively.
// Keep it to environment reads, the marker, and pure helpers.
//
// ─── THE APP ID ─────────────────────────────────────────────────────────────
//
// `VITE_PRIVY_APP_ID`, read from env via the one sanctioned reader
// (`readEnv` in `src/api/config.ts`). It is PUBLIC BY DESIGN — like any Privy
// app id it ships in the bundle, and the dashboard's origin allowlist is what
// protects it. It is still read from env rather than written down here so a
// deployment can rotate it without a code change and so it is never committed.
//
// There is also a `privy_…` app SECRET, which lives server-side only. It must
// NEVER appear in this repo's frontend, in any `VITE_` variable, or in the
// bundle. Nothing in `src/` needs it for anything. If you find yourself
// reaching for it, you are building the wrong thing.
//
// A build without the app id is a SUPPORTED configuration: `PRIVY_ENABLED`
// goes false, the social sign-in options disappear (with a quiet note), and
// wallet sign-in — how every current player gets in — is untouched.

import { readEnv } from '../api/config.js';

/** Is this string a usable Privy app id? Pure, so the tests can hit it. */
export function isPrivyConfigured(appId: string | undefined): appId is string {
  return typeof appId === 'string' && appId.trim().length > 0;
}

/** The public Privy app id, or `undefined` when this build has none. */
export const PRIVY_APP_ID: string | undefined = readEnv('VITE_PRIVY_APP_ID');

/**
 * May the UI offer email / social / passkey sign-in?
 *
 * When `false`, every Privy surface must degrade to hidden (or a quiet
 * "unavailable" note) — never a blank screen, never a crash, and never a
 * broken wallet login.
 */
export const PRIVY_ENABLED: boolean = isPrivyConfigured(PRIVY_APP_ID);

// ── The "signed in with Privy" marker ───────────────────────────────────────
//
// Why it exists: our BACKEND session is the source of truth, and Privy's own
// session is only the means to reach the signing key. Two moments need to know
// "this device's player came in through Privy" WITHOUT downloading the SDK:
//
//   • Login-screen mount: if the marker is set, the Privy session probably
//     still exists even though our session expired — so we load the runtime
//     and re-run the nonce flow silently instead of making the player click.
//   • Logout: signing out of the app must also sign out of Privy, but only a
//     Privy user should ever pay for that chunk.
//
// localStorage (not sessionStorage) on purpose: the whole point is surviving
// the tab. The marker holds no credential — knowing that a browser once used
// Privy is not a secret worth anything.

// ── The offered methods, SDK-free ───────────────────────────────────────────
//
// Lives here (eager) because the login screen renders its own buttons for
// these BEFORE the SDK chunk exists — downloading half a megabyte of SDK to
// paint five buttons would defeat the lazy split. The values are Privy's
// `LoginMethod` names; `runtime.tsx` narrows them back into the SDK's type.

export type PrivyLoginMethod = 'email' | 'google' | 'apple' | 'twitter' | 'passkey';

export const PRIVY_LOGIN_METHODS: readonly { key: PrivyLoginMethod; label: string }[] = [
  { key: 'email', label: 'Email' },
  { key: 'google', label: 'Google' },
  { key: 'apple', label: 'Apple' },
  { key: 'twitter', label: 'X' },
  { key: 'passkey', label: 'Passkey' },
] as const;

const HINT_KEY = 'chains.privy.hint.v1';

/** Did a Privy-backed sign-in happen on this device (and no logout since)? */
export function getPrivyHint(): boolean {
  try {
    return globalThis.localStorage?.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Record / clear the marker. Best-effort — storage may be blocked. */
export function setPrivyHint(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(HINT_KEY, '1');
    else globalThis.localStorage?.removeItem(HINT_KEY);
  } catch {
    /* Safari private mode etc. — resume just won't be offered. */
  }
}
