// src/privy/auth-flow.ts
//
// The Privy sign-in flow as a PURE state machine, so the interesting decisions
// are testable without React, without the SDK and without a network.
//
// The flow it models (see `runtime.tsx` for the effectful half):
//
//   idle ──START (button)──────▶ privy_login ──PRIVY_OK──▶ waiting_wallet
//   idle ──RESUME (silent)─────────────────────────────────▶ waiting_wallet
//   waiting_wallet ──WALLET_READY──▶ signing ──BACKEND_OK──▶ done
//
// with `error` reachable from every in-flight step, and RESET back to `idle`.
//
// Two facts ride along in the state instead of living in component refs:
//
//   • `resumed` — this run was started silently from a still-live Privy
//     session, not by a click. A resumed failure must NOT shout at a player
//     who pressed nothing; the UI falls back to showing the normal options.
//   • `isNewUser` — Privy created this social account just now. That is the
//     signal for the "already played with a wallet? Link it in Settings"
//     prompt: a brand-new Privy user gets a brand-new (empty) backend profile,
//     and if they have played before, their cards live on their old wallet's
//     profile.

/** Where the flow currently is. */
export type PrivyFlowStep =
  | 'idle'
  | 'privy_login'
  | 'waiting_wallet'
  | 'signing'
  | 'done'
  | 'error';

export interface PrivyFlow {
  step: PrivyFlowStep;
  /** This run was a silent resume, not a user click. */
  resumed: boolean;
  /** Privy reported the account was created by this very login. */
  isNewUser: boolean;
  /** Player-facing copy when `step === 'error'`; `null` otherwise. */
  message: string | null;
}

export const IDLE_FLOW: PrivyFlow = {
  step: 'idle',
  resumed: false,
  isNewUser: false,
  message: null,
};

export type PrivyFlowEvent =
  /** A social/email/passkey button was pressed; the Privy modal is opening. */
  | { type: 'START' }
  /** A live Privy session was found at mount; skip the modal entirely. */
  | { type: 'RESUME' }
  /** Privy authentication finished. */
  | { type: 'PRIVY_OK'; isNewUser: boolean }
  /** The player closed Privy's modal. Not an error — back to idle. */
  | { type: 'PRIVY_CANCELLED' }
  | { type: 'PRIVY_ERROR'; message: string }
  /** The embedded wallet exists (created or restored) and can sign. */
  | { type: 'WALLET_READY' }
  | { type: 'WALLET_TIMEOUT' }
  /** Our backend accepted the signature; the app session is stored. */
  | { type: 'BACKEND_OK' }
  | { type: 'BACKEND_ERROR'; message: string }
  | { type: 'RESET' };

/**
 * One transition. Unknown (state, event) pairs return the state unchanged —
 * late async results (a timeout firing after success, a second PRIVY_OK) must
 * be inert rather than corrupting the flow.
 */
export function privyFlowReduce(state: PrivyFlow, event: PrivyFlowEvent): PrivyFlow {
  switch (event.type) {
    case 'START':
      if (state.step !== 'idle' && state.step !== 'error') return state;
      return { step: 'privy_login', resumed: false, isNewUser: false, message: null };

    case 'RESUME':
      if (state.step !== 'idle') return state;
      // A resumed session is by definition not a new user.
      return { step: 'waiting_wallet', resumed: true, isNewUser: false, message: null };

    case 'PRIVY_OK':
      if (state.step !== 'privy_login') return state;
      return { ...state, step: 'waiting_wallet', isNewUser: event.isNewUser };

    case 'PRIVY_CANCELLED':
      if (state.step !== 'privy_login') return state;
      return IDLE_FLOW;

    case 'PRIVY_ERROR':
      if (state.step !== 'privy_login') return state;
      return { ...state, step: 'error', message: event.message };

    case 'WALLET_READY':
      if (state.step !== 'waiting_wallet') return state;
      return { ...state, step: 'signing', message: null };

    case 'WALLET_TIMEOUT':
      if (state.step !== 'waiting_wallet') return state;
      return {
        ...state,
        step: 'error',
        message:
          'Your sign-in worked, but your account wallet did not come up in time. ' +
          'Try again in a moment — nothing was lost.',
      };

    case 'BACKEND_OK':
      if (state.step !== 'signing') return state;
      return { ...state, step: 'done', message: null };

    case 'BACKEND_ERROR':
      if (state.step !== 'signing') return state;
      return { ...state, step: 'error', message: event.message };

    case 'RESET':
      return IDLE_FLOW;

    default:
      return state;
  }
}

/** Is the flow somewhere the UI should treat as busy? */
export function flowBusy(flow: PrivyFlow): boolean {
  return flow.step === 'privy_login' || flow.step === 'waiting_wallet' || flow.step === 'signing';
}

/**
 * The one-line status shown while busy, `null` when there is nothing to say.
 * A resumed run reads differently: the player pressed nothing, so the copy
 * must explain why anything is happening at all.
 */
export function flowStatusText(flow: PrivyFlow): string | null {
  switch (flow.step) {
    case 'privy_login':
      return 'Waiting for sign-in…';
    case 'waiting_wallet':
      return flow.resumed ? 'Signing you back in…' : 'Preparing your account…';
    case 'signing':
      return flow.resumed ? 'Signing you back in…' : 'Signing you in…';
    default:
      return null;
  }
}

/**
 * Should this error be shown to the player?
 *
 * A SILENT resume that fails must not put a red alert in front of someone who
 * pressed nothing — the login options are still right there and still work.
 * An error in a run the player started is theirs to see.
 */
export function flowErrorText(flow: PrivyFlow): string | null {
  if (flow.step !== 'error') return null;
  if (flow.resumed) return null;
  return flow.message;
}

/**
 * After this flow completed, should the app offer "already played with a
 * wallet? Link it in Settings"?
 *
 * Only for a genuinely NEW Privy account: that login just created a fresh,
 * empty backend profile. A returning Privy user has whatever profile they
 * already had, and a silent resume is by definition a returning user.
 */
export function shouldOfferWalletLink(flow: PrivyFlow): boolean {
  return flow.step === 'done' && flow.isNewUser && !flow.resumed;
}
