// src/privy/runtime.tsx
//
// The HEAVY half of the Privy integration — the ONLY module in `src/` that may
// import `@privy-io/react-auth`. Reached exclusively through `React.lazy` /
// dynamic `import()`, so a player who signs in with a browser wallet never
// downloads the SDK. If you add an eager import of this file anywhere, you
// have just put several hundred kilobytes back into everyone's first paint —
// check `dist/assets/index-*.js` before and after touching imports here.
//
// ─── WHAT PRIVY IS TO US ────────────────────────────────────────────────────
//
// A way to reach a signing key. Privy authenticates the player (email /
// Google / Apple / X / passkey) and gives them an EMBEDDED WALLET — a standard
// secp256k1 EOA whose `personal_sign` is a plain ECDSA signature. Our backend
// verifies it with an ordinary ecrecover, exactly like a MetaMask signature,
// so from `/auth/nonce` onwards a Privy player is indistinguishable from a
// wallet player (`signedInWith.kind === 'eoa'`). There is NO second auth path:
// everything funnels through `auth.signInWithSigner()` — only the middle
// (signing) step differs.
//
// The same person logging in with the same social account on another device
// gets the same embedded EOA, hence the same profile. That is Privy's job —
// do not build any extra identity mapping on top.
//
// ─── SESSION SEMANTICS ──────────────────────────────────────────────────────
//
// OUR backend session is the source of truth; Privy's session is only the
// means to reach the key. Concretely:
//
//   • Sign-in stores our JWT pair via `verifySignature()`, same as a wallet.
//   • Logout must clear BOTH (`signOutOfPrivy()` below, called from App).
//   • Privy alive + our session expired → re-run the nonce flow silently
//     (`resume` prop on `PrivyLoginPanel`), never bounce the player to a
//     login prompt they should not need.
//
// `showWalletUIs: false` matters for that last point: the embedded wallet
// signs headlessly, so the silent resume is actually silent, and a first
// sign-in does not show a confusing second modal for the challenge. The
// message being signed is still the server's own "Sign in to Chains TCG"
// challenge, minted by `/auth/nonce` and signed VERBATIM.

import React, { useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  PrivyProvider,
  getEmbeddedConnectedWallet,
  useLogin,
  usePrivy,
  useWallets,
  type ConnectedWallet,
  type PrivyClientConfig,
} from '@privy-io/react-auth';

import {
  PRIVY_APP_ID,
  PRIVY_ENABLED,
  PRIVY_LOGIN_METHODS,
  setPrivyHint,
  type PrivyLoginMethod,
} from './env.js';
import {
  IDLE_FLOW,
  flowBusy,
  flowErrorText,
  flowStatusText,
  privyFlowReduce,
} from './auth-flow.js';
import * as auth from '../api/auth.js';
import { ApiError } from '../api/errors.js';
import { linkWithSigner, type LinkedAddress } from '../api/addresses.js';
import { linkedWalletErrorText } from '../linked-wallets.js';
import { errorText } from '../error-text.js';
import { font as F } from '../theme.js';
import { AppleMark, GoogleG, Mail, Passkey, Warning, XBrand } from '../icons.js';

// ── Provider config ─────────────────────────────────────────────────────────

/**
 * One config for every surface. Notable choices:
 *
 * - `loginMethods`: email, google, apple, twitter, passkey. NO `wallet` —
 *   external-wallet sign-in stays on our own `connectRobinhoodChain()` path,
 *   untouched, and offering it twice with different plumbing would mint
 *   different sessions for the same click.
 * - `createOnLogin: 'users-without-wallets'`: every social user gets an
 *   embedded EOA on first login; `useLogin`'s `onComplete` fires only after
 *   that creation has happened.
 * - `showWalletUIs: false`: headless signing. The challenge the player would
 *   otherwise see in Privy's modal is our server's own message; there is
 *   nothing to review and a second modal reads as phishing.
 */
const PRIVY_CONFIG: PrivyClientConfig = {
  loginMethods: ['email', 'google', 'apple', 'twitter', 'passkey'],
  appearance: {
    theme: 'dark',
    accentColor: '#d9b45a',
    landingHeader: 'Sign in to Chains TCG',
  },
  embeddedWallets: {
    ethereum: { createOnLogin: 'users-without-wallets' },
    showWalletUIs: false,
  },
};

// ── Signing with the embedded wallet ────────────────────────────────────────

/** UTF-8 → `0x…` hex for `personal_sign`. Mirrors the helper in api/auth.ts. */
function utf8ToHex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * A raw EIP-191 `personal_sign` over the server's EXACT string, via the
 * embedded wallet's EIP-1193 provider. Do not wrap, hash or reformat the
 * message — the server re-derives it from its own nonce record and refuses
 * anything it did not mint.
 */
async function signWithEmbeddedWallet(wallet: ConnectedWallet, message: string): Promise<string> {
  const provider = await wallet.getEthereumProvider();
  const signature = await provider.request({
    method: 'personal_sign',
    params: [utf8ToHex(message), wallet.address],
  });
  if (typeof signature !== 'string') throw new Error('The embedded wallet returned no signature.');
  return signature;
}

// ── Error copy ──────────────────────────────────────────────────────────────

function privyFailureCopy(code: string): string {
  switch (code) {
    case 'client_request_timeout':
      return 'Sign-in is unreachable right now. Check your connection and try again.';
    // The app id was refused for THIS origin. Privy protects its (public) app
    // id with a dashboard origin allowlist, so this is what a dev server on a
    // port that was never allowlisted — or a new deployment domain — looks
    // like. Say so: the player can do nothing, but the developer reading the
    // same screen can.
    case 'missing_or_invalid_privy_app_id':
      return 'Sign-in is not configured for this site address. (This origin is not on the Privy app’s allowlist.)';
    case 'allowlist_rejected':
      return 'This account is not allowed to sign in to this app.';
    case 'oauth_user_denied':
      return 'You declined the sign-in request. Try again when you are ready.';
    case 'too_many_requests':
      return 'Too many attempts. Wait a moment and try again.';
    case 'max_accounts_reached':
      return 'Sign-ups are temporarily full. Please try again later.';
    default:
      return 'Sign-in did not complete. Please try again.';
  }
}

/**
 * The player-facing copy above deliberately hides raw codes — but the person
 * debugging a misconfigured origin needs the real one. One warn per failure,
 * console only, never in the UI.
 */
function logPrivyFailure(where: string, code: string): void {
  try {
    console.warn(`[privy] ${where} failed: ${code}`, {
      origin: globalThis.location?.origin,
      hint:
        code === 'missing_or_invalid_privy_app_id'
          ? 'Add this origin to the Privy dashboard allowlist (Settings → Domains). The app id is read from VITE_PRIVY_APP_ID.'
          : undefined,
    });
  } catch {
    /* console may be unavailable */
  }
}

function backendFailureCopy(e: unknown): string {
  if (e instanceof ApiError && e.status === 401) {
    return 'That signature was not accepted. Try again — the challenge may have expired.';
  }
  return errorText(e);
}

// ── Never let the SDK take the login screen down ────────────────────────────

class PrivyBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(): void {
    /* Wallet sign-in above is untouched; nothing to do. */
  }
  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div style={{ fontSize: 11.5, color: '#8f89a3', textAlign: 'center', lineHeight: 1.5 }}>
          Email &amp; social sign-in is unavailable right now. Wallet sign-in above still works.
        </div>
      );
    }
    return this.props.children;
  }
}

// ── The button row (used by the Settings link dialog only — the LOGIN screen
//    renders its own eager copy in App.tsx so the chunk is not needed to paint
//    buttons) ───────────────────────────────────────────────────────────────

const METHOD_ICONS: Record<PrivyLoginMethod, (p: { size?: number | string }) => React.JSX.Element> = {
  email: Mail,
  google: GoogleG,
  apple: AppleMark,
  twitter: XBrand,
  passkey: Passkey,
};

function MethodButtons({ disabled, onPick }: { disabled: boolean; onPick: (m: PrivyLoginMethod) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8 }}>
      {PRIVY_LOGIN_METHODS.map(({ key, label }) => { const Glyph = METHOD_ICONS[key]; return (
        <button
          key={key} type="button" disabled={disabled}
          onClick={() => onPick(key)}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            minHeight: 44, padding: '10px 8px', borderRadius: 10, cursor: disabled ? 'default' : 'pointer',
            fontFamily: F.body, fontWeight: 700, fontSize: 12.5, letterSpacing: '0.04em',
            background: 'rgba(18,14,34,0.85)', color: '#e8e2f2',
            border: '1px solid rgba(212,175,55,0.35)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
            opacity: disabled ? 0.55 : 1,
          }}
        >
          <Glyph size={15} /> {label}
        </button>
      ); })}
    </div>
  );
}

// ── Login-screen surface ────────────────────────────────────────────────────

export interface PrivyLoginResult {
  /** Privy created this account just now → the backend profile is brand new. */
  isNewUser: boolean;
  /** The run was a silent resume of a still-live Privy session. */
  resumed: boolean;
}

function LoginPanelInner({
  resume,
  oauthReturn,
  initialMethod,
  onBusyChange,
  onSignedIn,
}: {
  resume: boolean;
  /** The page just reloaded from a social-OAuth redirect; finish that login. */
  oauthReturn: boolean;
  /** Launch this method's Privy modal as soon as the SDK is ready. */
  initialMethod: PrivyLoginMethod | null;
  onBusyChange?: (busy: boolean) => void;
  onSignedIn: (result: PrivyLoginResult) => void;
}) {
  const [flow, dispatch] = useReducer(privyFlowReduce, IDLE_FLOW);
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();

  // `onComplete` serves two shapes of login. Same-page (modal / passkey /
  // email OTP): the flow is in `privy_login`, so PRIVY_OK advances it. OAuth
  // REDIRECT return: the page reloaded, the flow object is fresh (`idle`),
  // and the SDK completes authentication unprompted — OAUTH_RETURN_OK is the
  // idle-legal event that still carries `isNewUser`. The ref exists because
  // this callback must read the CURRENT step, not the one it closed over.
  const flowRef = useRef(flow);
  flowRef.current = flow;

  const { login } = useLogin({
    onComplete: ({ isNewUser, wasAlreadyAuthenticated }) => {
      const fresh = isNewUser && !wasAlreadyAuthenticated;
      if (flowRef.current.step === 'privy_login') {
        dispatch({ type: 'PRIVY_OK', isNewUser: fresh });
      } else if (oauthReturn) {
        dispatch({ type: 'OAUTH_RETURN_OK', isNewUser: fresh });
      }
      // Otherwise: a hint-resume mount — the resume effect below owns it.
    },
    onError: (code) => {
      if (code === 'exited_auth_flow') {
        dispatch({ type: 'PRIVY_CANCELLED' });
        return;
      }
      logPrivyFailure('login', code);
      dispatch({ type: 'PRIVY_ERROR', message: privyFailureCopy(code) });
    },
  });

  // Belt and braces for the redirect return: if the SDK restored the session
  // but `onComplete` never fired (event timing differs across SDK versions),
  // advance anyway once authentication is visible. `isNewUser` is unknowable
  // on this path, so it stays false — the only cost is no wallet-link prompt.
  useEffect(() => {
    if (!oauthReturn || !ready || !authenticated) return;
    const t = setTimeout(() => dispatch({ type: 'OAUTH_RETURN_OK', isNewUser: false }), 400);
    return () => clearTimeout(t);
  }, [oauthReturn, ready, authenticated]);

  // The BUTTONS live eagerly in App.tsx (this chunk must not be needed to
  // paint them); this panel is mounted per attempt with the chosen method and
  // opens Privy's modal once the SDK is up. One launch per mount — a retry is
  // a remount (the parent bumps a key), which also resets the flow cleanly.
  const launched = useRef(false);
  useEffect(() => {
    if (!ready || launched.current || initialMethod === null) return;
    launched.current = true;
    dispatch({ type: 'START' });
    login({ loginMethods: [initialMethod] });
  }, [ready, initialMethod, login]);

  // Silent resume: our session expired but Privy's survived. Skip the modal
  // and go straight to the wallet → nonce → sign → verify pipeline. If the
  // Privy session is gone too, the marker was stale — clear it and fall back
  // to the untouched buttons like any other visit.
  const resumeTried = useRef(false);
  useEffect(() => {
    if (!resume || resumeTried.current || !ready) return;
    resumeTried.current = true;
    if (authenticated) dispatch({ type: 'RESUME' });
    else setPrivyHint(false);
  }, [resume, ready, authenticated]);

  // Tell the parent when to grey out its buttons (both its eager social row
  // and the wallet button — two sign-in flows at once ends badly).
  const busyNow = flowBusy(flow);
  useEffect(() => {
    onBusyChange?.(busyNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busyNow]);

  // Wait for the embedded wallet (created on first login, restored on later
  // ones). `onComplete` only fires after creation, so this is normally
  // instant — the timeout is for the pathological case, not the normal one.
  const embedded = getEmbeddedConnectedWallet(wallets);
  const embeddedAddress = embedded?.address ?? null;
  useEffect(() => {
    if (flow.step !== 'waiting_wallet') return;
    if (embeddedAddress) {
      dispatch({ type: 'WALLET_READY' });
      return;
    }
    const timer = setTimeout(() => dispatch({ type: 'WALLET_TIMEOUT' }), 20_000);
    return () => clearTimeout(timer);
  }, [flow.step, embeddedAddress]);

  // The backend handshake. Identical to a MetaMask sign-in from here on:
  // nonce for the EMBEDDED ADDRESS on `robinhood`, headless personal_sign of
  // the exact server message, verify, store OUR session.
  const signingRun = useRef(0);
  useEffect(() => {
    if (flow.step !== 'signing' || !embedded) return;
    const run = ++signingRun.current;
    void (async () => {
      try {
        await auth.signInWithSigner({
          address: embedded.address,
          chain: auth.APP_AUTH_CHAIN,
          signMessage: (message) => signWithEmbeddedWallet(embedded, message),
        });
        if (run !== signingRun.current) return;
        setPrivyHint(true);
        dispatch({ type: 'BACKEND_OK' });
        onSignedIn({ isNewUser: flow.isNewUser, resumed: flow.resumed });
      } catch (e) {
        if (run !== signingRun.current) return;
        dispatch({ type: 'BACKEND_ERROR', message: backendFailureCopy(e) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.step]);

  const status = flowStatusText(flow);
  const error = flowErrorText(flow);

  if (!status && !error) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {status && (
        <div role="status" style={{ textAlign: 'center', fontSize: 12, color: '#c8c2d8' }}>
          {status}
        </div>
      )}
      {error && (
        <div role="alert" style={{ textAlign: 'center', fontSize: 12.5, color: '#ffb8b8', lineHeight: 1.5 }}>
          {error}
        </div>
      )}
    </div>
  );
}

/**
 * The WORKING half of the login screen's email / social / passkey block. The
 * five buttons themselves are eager in App.tsx (they are just styled buttons);
 * this lazy component is mounted only when one is pressed (`initialMethod`) or
 * when a silent resume should be attempted (`resume`) — so a wallet-only
 * player never downloads the SDK. Renders only its status / error line.
 *
 * A retry is a REMOUNT: the parent bumps a `key` per attempt.
 */
export function PrivyLoginPanel(props: {
  resume: boolean;
  oauthReturn: boolean;
  initialMethod: PrivyLoginMethod | null;
  onBusyChange?: (busy: boolean) => void;
  onSignedIn: (result: PrivyLoginResult) => void;
}) {
  if (!PRIVY_ENABLED || !PRIVY_APP_ID) return null;
  return (
    <PrivyBoundary>
      <PrivyProvider appId={PRIVY_APP_ID} config={PRIVY_CONFIG}>
        <LoginPanelInner {...props} />
      </PrivyProvider>
    </PrivyBoundary>
  );
}

// ── Settings-side link surface ──────────────────────────────────────────────

type LinkStep =
  | { step: 'auth' }
  | { step: 'waiting_wallet' }
  | { step: 'linking'; address: string }
  | { step: 'done'; linked: LinkedAddress }
  | { step: 'error'; message: string };

function LinkPanelInner({
  onLinked,
  onClose,
}: {
  onLinked: (linked: LinkedAddress) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<LinkStep>({ step: 'auth' });
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();

  const { login } = useLogin({
    onComplete: () => setState((s) => (s.step === 'auth' ? { step: 'waiting_wallet' } : s)),
    onError: (code) => {
      if (code === 'exited_auth_flow') return; // stayed on 'auth'; buttons still there
      logPrivyFailure('link', code);
      setState({ step: 'error', message: privyFailureCopy(code) });
    },
  });

  // Already signed into Privy from an earlier visit? Skip straight to linking.
  useEffect(() => {
    if (ready && authenticated) {
      setState((s) => (s.step === 'auth' ? { step: 'waiting_wallet' } : s));
    }
  }, [ready, authenticated]);

  const embedded = getEmbeddedConnectedWallet(wallets);
  const embeddedAddress = embedded?.address ?? null;
  useEffect(() => {
    if (state.step !== 'waiting_wallet') return;
    if (embeddedAddress) {
      setState({ step: 'linking', address: embeddedAddress });
      return;
    }
    const timer = setTimeout(
      () => setState({ step: 'error', message: 'Your sign-in worked, but the account wallet did not come up in time. Close this and try again.' }),
      20_000,
    );
    return () => clearTimeout(timer);
  }, [state.step, embeddedAddress]);

  // LINK nonce, not sign-in nonce: `linkWithSigner` mints the "Link this
  // wallet…" challenge (purpose `link`), the EMBEDDED wallet signs it
  // headlessly, and the server attaches the address to the CALLER's profile.
  // The two nonce kinds are deliberately non-interchangeable (anti-phishing).
  const linkRun = useRef(0);
  useEffect(() => {
    if (state.step !== 'linking' || !embedded) return;
    const run = ++linkRun.current;
    void (async () => {
      try {
        const linked = await linkWithSigner({
          address: embedded.address,
          chain: auth.APP_AUTH_CHAIN,
          signMessage: (message) => signWithEmbeddedWallet(embedded, message),
        });
        if (run !== linkRun.current) return;
        // Future logins through Privy now reach THIS profile — make the login
        // screen resume them silently.
        setPrivyHint(true);
        setState({ step: 'done', linked });
        onLinked(linked);
      } catch (e) {
        if (run !== linkRun.current) return;
        setState({ step: 'error', message: linkedWalletErrorText(e, 'link') });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step]);

  const body = (() => {
    switch (state.step) {
      case 'auth':
        return (
          <>
            <p style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.55, color: '#bab4c9' }}>
              Sign in with the email, social account or passkey you want to attach.
              Its wallet will sign a <b style={{ color: '#e8e2f2' }}>“Link this wallet”</b> message —
              free, moves no funds — and from then on that sign-in opens <i>this</i> profile.
            </p>
            <MethodButtons disabled={!ready} onPick={(method) => login({ loginMethods: [method] })} />
          </>
        );
      case 'waiting_wallet':
        return <p role="status" style={{ margin: 0, fontSize: 13, color: '#c8c2d8' }}>Preparing the account wallet…</p>;
      case 'linking':
        return <p role="status" style={{ margin: 0, fontSize: 13, color: '#c8c2d8' }}>Linking to your profile…</p>;
      case 'done':
        return (
          <p role="status" style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: '#8fe3b0' }}>
            Linked. This sign-in now opens this profile on any device.
          </p>
        );
      case 'error':
        return (
          <>
            <p role="alert" style={{ margin: '0 0 12px', fontSize: 13, lineHeight: 1.55, color: '#ffb8b8' }}>
              {state.message}
            </p>
            <MethodButtons disabled={!ready} onPick={(method) => { setState({ step: 'auth' }); login({ loginMethods: [method] }); }} />
          </>
        );
    }
  })();

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 120, padding: 18,
        background: 'rgba(4,4,12,0.72)', backdropFilter: 'blur(5px)',
        display: 'grid', placeItems: 'center', overflowY: 'auto',
      }}
    >
      <div
        role="dialog" aria-modal="true" aria-labelledby="ocva-privylink-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(440px, 100%)', padding: 20, borderRadius: 14,
          background: 'rgba(12,10,26,0.97)', border: '1px solid rgba(212,175,55,0.35)',
          boxShadow: '0 24px 70px rgba(0,0,0,0.6)', color: '#F8F8F8', fontFamily: F.body,
        }}
      >
        <h2 id="ocva-privylink-title" style={{
          margin: '0 0 10px', fontFamily: '"Cinzel", "Times New Roman", serif',
          fontWeight: 800, fontSize: 17, letterSpacing: '0.08em', color: '#f0d489',
        }}>Link a sign-in</h2>
        {body}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            type="button" onClick={onClose}
            style={{
              minHeight: 44, padding: '10px 18px', borderRadius: 10, cursor: 'pointer',
              fontFamily: F.body, fontWeight: 800, fontSize: 12.5, letterSpacing: '0.08em',
              background: 'rgba(18,14,34,0.85)', color: '#e8e2f2',
              border: '1px solid rgba(212,175,55,0.35)',
            }}
          >{state.step === 'done' ? 'DONE' : 'CANCEL'}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Settings dialog that links the caller's Privy embedded wallet to the
 * CURRENT (already-authenticated) profile. This is the path for a wallet-first
 * player who wants email/social sign-in to reach their existing profile.
 */
export function PrivyLinkPanel(props: {
  onLinked: (linked: LinkedAddress) => void;
  onClose: () => void;
}) {
  if (!PRIVY_ENABLED || !PRIVY_APP_ID) {
    // Should never be mounted in this state; degrade to a quiet note.
    return (
      <div role="alert" style={{ padding: 12, fontSize: 12.5, color: '#8f89a3' }}>
        <Warning size={14} /> Email &amp; social sign-in is not available in this build.
      </div>
    );
  }
  return (
    <PrivyBoundary>
      <PrivyProvider appId={PRIVY_APP_ID} config={PRIVY_CONFIG}>
        <LinkPanelInner {...props} />
      </PrivyProvider>
    </PrivyBoundary>
  );
}

// ── Logout ──────────────────────────────────────────────────────────────────

function LogoutOnce({ onDone }: { onDone: () => void }) {
  const { ready, authenticated, logout } = usePrivy();
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    if (!authenticated) {
      onDone();
      return;
    }
    logout().catch(() => { /* best effort — our own session is already gone */ }).then(onDone);
  }, [ready, authenticated, logout, onDone]);
  return null;
}

/**
 * End the PRIVY session (our own session is handled by `auth.logout()`).
 *
 * There is no imperative logout in `@privy-io/react-auth`, so this mounts a
 * throwaway hidden `PrivyProvider` just long enough to call `logout()`, then
 * tears it down. Bounded by a timeout — a hung SDK must not wedge the app's
 * sign-out. Call sites gate on the eager `getPrivyHint()` marker so wallet
 * players never load this chunk at all.
 */
export async function signOutOfPrivy(): Promise<void> {
  if (!PRIVY_ENABLED || !PRIVY_APP_ID || typeof document === 'undefined') return;
  // Captured so the guard's narrowing survives into the closures below.
  const appId: string = PRIVY_APP_ID;

  const host = document.createElement('div');
  host.style.display = 'none';
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 8_000);
      root.render(
        <PrivyProvider appId={appId} config={PRIVY_CONFIG}>
          <LogoutOnce onDone={finish} />
        </PrivyProvider>,
      );
    });
  } finally {
    // Unmount on the next tick — never synchronously from inside a render.
    setTimeout(() => {
      try {
        root.unmount();
      } catch {
        /* already gone */
      }
      host.remove();
    }, 0);
  }
}
