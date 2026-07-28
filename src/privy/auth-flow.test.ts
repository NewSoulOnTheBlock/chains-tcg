// src/privy/auth-flow.test.ts
//
// The Privy sign-in state machine. The reducer is the part of the integration
// that decides WHAT the player sees (busy label, error, nothing) and WHEN the
// app offers the "link your old wallet" prompt — all of which is invisible in
// a type check and painful to reproduce manually (it needs a brand-new social
// account per attempt).

import { describe, expect, it } from 'vitest';
import {
  IDLE_FLOW,
  flowBusy,
  flowErrorText,
  flowStatusText,
  privyFlowReduce,
  shouldOfferWalletLink,
  type PrivyFlow,
  type PrivyFlowEvent,
} from './auth-flow';

/** Run a sequence of events from idle. */
function run(...events: PrivyFlowEvent[]): PrivyFlow {
  return events.reduce(privyFlowReduce, IDLE_FLOW);
}

describe('the happy paths', () => {
  it('click → privy → wallet → backend → done', () => {
    const flow = run(
      { type: 'START' },
      { type: 'PRIVY_OK', isNewUser: false },
      { type: 'WALLET_READY' },
      { type: 'BACKEND_OK' },
    );
    expect(flow.step).toBe('done');
    expect(flow.resumed).toBe(false);
    expect(flowBusy(flow)).toBe(false);
  });

  it('a silent resume skips the modal entirely', () => {
    const flow = run({ type: 'RESUME' });
    expect(flow.step).toBe('waiting_wallet');
    expect(flow.resumed).toBe(true);
  });

  it('every in-flight step reports busy with a status line', () => {
    let flow = run({ type: 'START' });
    expect(flowBusy(flow)).toBe(true);
    expect(flowStatusText(flow)).toMatch(/waiting/i);

    flow = privyFlowReduce(flow, { type: 'PRIVY_OK', isNewUser: false });
    expect(flowStatusText(flow)).toMatch(/preparing/i);

    flow = privyFlowReduce(flow, { type: 'WALLET_READY' });
    expect(flowStatusText(flow)).toMatch(/signing you in/i);
  });

  it('a resumed run says "signing you back in", not "signing you in"', () => {
    const flow = run({ type: 'RESUME' }, { type: 'WALLET_READY' });
    expect(flowStatusText(flow)).toMatch(/back in/i);
  });
});

describe('the "link your old wallet" prompt trigger', () => {
  const complete = (start: PrivyFlowEvent, isNewUser: boolean) =>
    run(start,
      ...(start.type === 'START' ? [{ type: 'PRIVY_OK', isNewUser } as const] : []),
      { type: 'WALLET_READY' },
      { type: 'BACKEND_OK' });

  it('fires only for a brand-new Privy account', () => {
    expect(shouldOfferWalletLink(complete({ type: 'START' }, true))).toBe(true);
  });

  it('does not fire for a returning Privy user', () => {
    expect(shouldOfferWalletLink(complete({ type: 'START' }, false))).toBe(false);
  });

  it('never fires for a silent resume — a resumed user is a returning user', () => {
    expect(shouldOfferWalletLink(complete({ type: 'RESUME' }, true))).toBe(false);
  });

  it('never fires before the backend accepted the signature', () => {
    const flow = run({ type: 'START' }, { type: 'PRIVY_OK', isNewUser: true }, { type: 'WALLET_READY' });
    expect(shouldOfferWalletLink(flow)).toBe(false);
  });
});

describe('failures', () => {
  it('closing the Privy modal is a cancel, not an error', () => {
    const flow = run({ type: 'START' }, { type: 'PRIVY_CANCELLED' });
    expect(flow).toEqual(IDLE_FLOW);
    expect(flowErrorText(flow)).toBeNull();
  });

  it('a privy failure in a clicked run is shown', () => {
    const flow = run({ type: 'START' }, { type: 'PRIVY_ERROR', message: 'Sign-in did not complete.' });
    expect(flow.step).toBe('error');
    expect(flowErrorText(flow)).toBe('Sign-in did not complete.');
  });

  it('a backend failure in a clicked run is shown', () => {
    const flow = run(
      { type: 'START' },
      { type: 'PRIVY_OK', isNewUser: false },
      { type: 'WALLET_READY' },
      { type: 'BACKEND_ERROR', message: 'That signature was not accepted.' },
    );
    expect(flowErrorText(flow)).toBe('That signature was not accepted.');
  });

  it('a SILENT resume failure is silent — no red alert for a click that never happened', () => {
    const flow = run(
      { type: 'RESUME' },
      { type: 'WALLET_READY' },
      { type: 'BACKEND_ERROR', message: 'network down' },
    );
    expect(flow.step).toBe('error');
    expect(flowErrorText(flow)).toBeNull();
  });

  it('the wallet timeout carries reassuring copy', () => {
    const flow = run({ type: 'START' }, { type: 'PRIVY_OK', isNewUser: true }, { type: 'WALLET_TIMEOUT' });
    expect(flow.step).toBe('error');
    expect(flow.message).toMatch(/nothing was lost/i);
  });

  it('START retries from an error state', () => {
    const failed = run({ type: 'START' }, { type: 'PRIVY_ERROR', message: 'boom' });
    const retried = privyFlowReduce(failed, { type: 'START' });
    expect(retried.step).toBe('privy_login');
    expect(retried.message).toBeNull();
  });

  it('RESET always returns to idle', () => {
    const flow = run({ type: 'START' }, { type: 'PRIVY_OK', isNewUser: true });
    expect(privyFlowReduce(flow, { type: 'RESET' })).toEqual(IDLE_FLOW);
  });
});

describe('late or duplicate async results are inert', () => {
  it('a timeout firing after the wallet arrived changes nothing', () => {
    const signing = run({ type: 'START' }, { type: 'PRIVY_OK', isNewUser: false }, { type: 'WALLET_READY' });
    expect(privyFlowReduce(signing, { type: 'WALLET_TIMEOUT' })).toBe(signing);
  });

  it('a second PRIVY_OK cannot rewrite isNewUser after the fact', () => {
    const flow = run({ type: 'START' }, { type: 'PRIVY_OK', isNewUser: false });
    expect(privyFlowReduce(flow, { type: 'PRIVY_OK', isNewUser: true })).toBe(flow);
  });

  it('BACKEND_OK out of nowhere does not fabricate a session state', () => {
    expect(privyFlowReduce(IDLE_FLOW, { type: 'BACKEND_OK' })).toBe(IDLE_FLOW);
  });

  it('RESUME cannot interrupt a run the user started', () => {
    const flow = run({ type: 'START' });
    expect(privyFlowReduce(flow, { type: 'RESUME' })).toBe(flow);
  });
});
