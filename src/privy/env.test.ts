// src/privy/env.test.ts
//
// The degraded mode and the device marker. The interesting property is
// graceful absence: no app id → social sign-in hidden, wallet sign-in
// untouched; no localStorage → no resume offered, nothing thrown.

import { afterEach, describe, expect, it } from 'vitest';
import { getPrivyHint, isPrivyConfigured, isPrivyOAuthReturn, setPrivyHint } from './env';

describe('isPrivyConfigured — the PRIVY_ENABLED predicate', () => {
  it('accepts a real-looking app id', () => {
    expect(isPrivyConfigured('cm0000000000000000000000x')).toBe(true);
  });

  it('rejects the configurations that mean "no Privy in this build"', () => {
    expect(isPrivyConfigured(undefined)).toBe(false);
    expect(isPrivyConfigured('')).toBe(false);
    // An env var set to whitespace is a config accident, not an app id.
    expect(isPrivyConfigured('   ')).toBe(false);
  });
});

describe('isPrivyOAuthReturn — noticing a social-OAuth redirect return', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else delete (globalThis as Record<string, unknown>).location;
  });

  function stubSearch(search: string): void {
    Object.defineProperty(globalThis, 'location', { value: { search }, configurable: true });
  }

  it('recognises each of the params Privy appends', () => {
    for (const key of ['privy_oauth_state', 'privy_oauth_code', 'privy_oauth_provider']) {
      stubSearch(`?${key}=abc`);
      expect(isPrivyOAuthReturn()).toBe(true);
    }
  });

  it('ignores ordinary visits — empty, unrelated, or lookalike params', () => {
    stubSearch('');
    expect(isPrivyOAuthReturn()).toBe(false);
    stubSearch('?ref=twitter&privy=1&oauth_code=zzz');
    expect(isPrivyOAuthReturn()).toBe(false);
  });

  it('is false with no location at all (tests, SSR)', () => {
    delete (globalThis as Record<string, unknown>).location;
    expect(isPrivyOAuthReturn()).toBe(false);
  });
});

describe('the "signed in with Privy on this device" marker', () => {
  const g = globalThis as { localStorage?: Storage };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (g as Record<string, unknown>).localStorage;
  });

  function stubStorage(): Map<string, string> {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    } as unknown as Storage;
    Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
    return store;
  }

  it('round-trips: set → read → clear → read', () => {
    stubStorage();
    expect(getPrivyHint()).toBe(false);
    setPrivyHint(true);
    expect(getPrivyHint()).toBe(true);
    setPrivyHint(false);
    expect(getPrivyHint()).toBe(false);
  });

  it('clearing removes the key entirely rather than writing "0"', () => {
    const store = stubStorage();
    setPrivyHint(true);
    setPrivyHint(false);
    expect(store.size).toBe(0);
  });

  it('with no storage at all, reads are false and writes are no-ops', () => {
    delete (g as Record<string, unknown>).localStorage;
    expect(getPrivyHint()).toBe(false);
    expect(() => setPrivyHint(true)).not.toThrow();
    expect(getPrivyHint()).toBe(false);
  });

  it('with storage that THROWS (Safari private mode), nothing escapes', () => {
    const hostile = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    } as unknown as Storage;
    Object.defineProperty(globalThis, 'localStorage', { value: hostile, configurable: true });
    expect(getPrivyHint()).toBe(false);
    expect(() => setPrivyHint(true)).not.toThrow();
    expect(() => setPrivyHint(false)).not.toThrow();
  });
});
