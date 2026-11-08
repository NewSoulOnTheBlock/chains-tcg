/**
 * server-28: a sign-in challenge must not be burnable by an unauthenticated
 * caller with a bad signature. `peekNonce` reads without consuming; only
 * `finalizeNonce`, called after the signature is proved, deletes it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// env.ts loads eagerly and exits the process on a bad schema, so the variables
// it needs must exist before the first import of a module that pulls it in.
process.env.DATABASE_URL ??= 'postgres://chains:unused@127.0.0.1:5432/chains';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long';
process.env.LOG_LEVEL ??= 'error';

const h = vi.hoisted(() => ({
  get: vi.fn<(k: string) => Promise<string | null>>(),
  getDel: vi.fn<(k: string) => Promise<string | null>>(),
  query: vi.fn<(...a: unknown[]) => Promise<{ rowCount: number }>>(),
}));

vi.mock('@chains/shared', async (orig) => {
  const actual = await orig<typeof import('@chains/shared')>();
  return {
    ...actual,
    getRedis: () => ({ get: h.get, set: vi.fn() }),
    getDel: h.getDel,
    query: h.query,
  };
});

const { peekNonce, finalizeNonce } = await import('../nonce.js');
const { AppError } = await import('@chains/shared');

function record(overrides: Record<string, unknown> = {}) {
  return {
    domain: 'localhost:8080',
    uri: 'http://localhost:8080',
    statement: 'Sign in to Chains TCG.',
    address: '0xabc',
    chain: 'robinhood',
    nonce: 'deadbeefcafebabe',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    message: 'MSG',
    purpose: 'signin',
    ...overrides,
  };
}

beforeEach(() => {
  h.get.mockReset();
  h.getDel.mockReset();
  h.query.mockReset();
});

describe('peekNonce (server-28: read, never consume)', () => {
  it('returns the stored challenge WITHOUT deleting it', async () => {
    const rec = record();
    h.get.mockResolvedValue(JSON.stringify(rec));

    const got = await peekNonce('robinhood', '0xabc', 'deadbeefcafebabe', 'signin');

    expect(got.nonce).toBe('deadbeefcafebabe');
    // The whole point: a peek (e.g. a verify with a bad signature that throws
    // later) must not have burned the challenge.
    expect(h.getDel).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('rejects when there is no challenge', async () => {
    h.get.mockResolvedValue(null);
    await expect(peekNonce('robinhood', '0xabc', undefined, 'signin')).rejects.toBeInstanceOf(AppError);
    expect(h.getDel).not.toHaveBeenCalled();
  });

  it('rejects a named nonce that is not the one held', async () => {
    h.get.mockResolvedValue(JSON.stringify(record()));
    await expect(peekNonce('robinhood', '0xabc', 'not-the-nonce', 'signin')).rejects.toBeInstanceOf(AppError);
    expect(h.getDel).not.toHaveBeenCalled();
  });

  it('rejects a purpose mismatch (a signin proof cannot authorise a link)', async () => {
    h.get.mockResolvedValue(JSON.stringify(record({ purpose: 'signin' })));
    await expect(peekNonce('robinhood', '0xabc', undefined, 'link')).rejects.toBeInstanceOf(AppError);
  });

  it('rejects an expired challenge', async () => {
    h.get.mockResolvedValue(JSON.stringify(record({ expiresAt: new Date(Date.now() - 1).toISOString() })));
    await expect(peekNonce('robinhood', '0xabc', undefined, 'signin')).rejects.toBeInstanceOf(AppError);
  });
});

describe('finalizeNonce (consume exactly once, after proof)', () => {
  it('burns the challenge via GETDEL and the Postgres guard', async () => {
    const rec = record();
    h.getDel.mockResolvedValue(JSON.stringify(rec));
    h.query.mockResolvedValue({ rowCount: 1 });

    await expect(finalizeNonce('robinhood', '0xabc', rec as never)).resolves.toBeUndefined();
    expect(h.getDel).toHaveBeenCalledTimes(1);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('rejects a second (concurrent) finalize once the key is gone', async () => {
    const rec = record();
    h.getDel.mockResolvedValue(null);
    await expect(finalizeNonce('robinhood', '0xabc', rec as never)).rejects.toBeInstanceOf(AppError);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('rejects when the Postgres guard says the row was already consumed', async () => {
    const rec = record();
    h.getDel.mockResolvedValue(JSON.stringify(rec));
    h.query.mockResolvedValue({ rowCount: 0 });
    await expect(finalizeNonce('robinhood', '0xabc', rec as never)).rejects.toBeInstanceOf(AppError);
  });

  it('refuses to apply the proof if issueNonce replaced the record in the window', async () => {
    const rec = record({ nonce: 'original' });
    h.getDel.mockResolvedValue(JSON.stringify(record({ nonce: 'a-newer-one' })));
    await expect(finalizeNonce('robinhood', '0xabc', rec as never)).rejects.toBeInstanceOf(AppError);
    expect(h.query).not.toHaveBeenCalled();
  });
});
