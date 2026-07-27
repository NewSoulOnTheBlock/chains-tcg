/**
 * C-2 against a REAL Postgres.
 *
 * The fix is a pair of constraints, so it has to be tested where the
 * constraints live. Mocking `insertDeposit` would only prove the mock.
 *
 * Run with:
 *   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=pw --name pg postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:pw@127.0.0.1:55433/postgres npx vitest run
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, isUniqueViolation, query, withTransaction } from '../platform/shared.js';
import {
  closeTestDatabase,
  makeEscrow,
  makeMatch,
  makeProfile,
  setupTestDatabase,
  testDatabaseUrl,
  truncateAll,
} from '../testing/db.js';
import { insertDeposit, listDeposits, lockEscrow, seatForProfile, getMatchSeats } from '../db/escrows.js';
import { violatedConstraint } from '../db/errors.js';

const HAS_DB = testDatabaseUrl() !== null;
const suite = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn('[wager] TEST_DATABASE_URL not set — deposit idempotency tests SKIPPED');
}

const AMOUNT = 1_000_000n;

suite('wager.deposits constraints (C-2)', () => {
  let seat0 = '';
  let seat1 = '';

  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll();
    seat0 = await makeProfile('player-zero', '0xaaaa000000000000000000000000000000000001');
    seat1 = await makeProfile('player-one', '0xbbbb000000000000000000000000000000000002');
    await makeMatch('match-1', seat0, seat1);
    await makeMatch('match-2', seat0, seat1);
    await makeEscrow({ id: 'escrow-1', matchId: 'match-1', amountBase: AMOUNT, status: 'open' });
    await makeEscrow({ id: 'escrow-2', matchId: 'match-2', amountBase: AMOUNT, status: 'open' });
  });

  async function deposit(input: {
    signature: string;
    escrowId: string;
    seat: 0 | 1;
    profileId: string;
    fromAddress: string;
  }): Promise<void> {
    await withTransaction(async (client) => {
      await insertDeposit(client, { ...input, amountBase: AMOUNT, blockNumber: null });
    });
  }

  it('accepts one deposit per seat', async () => {
    await deposit({ signature: 'tx-a', escrowId: 'escrow-1', seat: 0, profileId: seat0, fromAddress: 'A' });
    await deposit({ signature: 'tx-b', escrowId: 'escrow-1', seat: 1, profileId: seat1, fromAddress: 'B' });
    const rows = await listDeposits(getPool(), 'escrow-1');
    expect(rows.map((r) => r.seat)).toEqual([0, 1]);
  });

  it('THE C-2 CASE: one signature cannot fund the second seat of the same escrow', async () => {
    await deposit({ signature: 'tx-a', escrowId: 'escrow-1', seat: 0, profileId: seat0, fromAddress: 'A' });

    // The exact attack: replay seat 0's payment as seat 1, so a draw refunds
    // two stakes out of one deposit.
    await expect(
      deposit({ signature: 'tx-a', escrowId: 'escrow-1', seat: 1, profileId: seat1, fromAddress: 'B' }),
    ).rejects.toSatisfy((err: unknown) => isUniqueViolation(err));

    const rows = await listDeposits(getPool(), 'escrow-1');
    expect(rows).toHaveLength(1);
  });

  it('one signature cannot fund a seat in a DIFFERENT escrow either', async () => {
    await deposit({ signature: 'tx-a', escrowId: 'escrow-1', seat: 0, profileId: seat0, fromAddress: 'A' });
    await expect(
      deposit({ signature: 'tx-a', escrowId: 'escrow-2', seat: 0, profileId: seat0, fromAddress: 'A' }),
    ).rejects.toSatisfy((err: unknown) => isUniqueViolation(err));
    expect(await listDeposits(getPool(), 'escrow-2')).toHaveLength(0);
  });

  it('a seat cannot be funded twice, even with two different signatures', async () => {
    await deposit({ signature: 'tx-a', escrowId: 'escrow-1', seat: 0, profileId: seat0, fromAddress: 'A' });
    const err = await deposit({
      signature: 'tx-c',
      escrowId: 'escrow-1',
      seat: 0,
      profileId: seat0,
      fromAddress: 'A',
    }).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
    // The constraint name is what the route uses to tell the two 409s apart.
    expect(violatedConstraint(err)).toContain('seat');
  });

  it('a failed verification rolls the reservation back, so an honest retry works', async () => {
    // Mirrors submitDeposit: insert, then "verify", then throw.
    await expect(
      withTransaction(async (client) => {
        await insertDeposit(client, {
          signature: 'tx-retry',
          escrowId: 'escrow-1',
          seat: 0,
          profileId: seat0,
          fromAddress: 'A',
          amountBase: AMOUNT,
          blockNumber: null,
        });
        throw new Error('chain says: not confirmed yet');
      }),
    ).rejects.toThrow('not confirmed yet');

    expect(await listDeposits(getPool(), 'escrow-1')).toHaveLength(0);

    await deposit({ signature: 'tx-retry', escrowId: 'escrow-1', seat: 0, profileId: seat0, fromAddress: 'A' });
    expect(await listDeposits(getPool(), 'escrow-1')).toHaveLength(1);
  });

  it('two concurrent deposits of the same signature: exactly one commits', async () => {
    const attempts = [0, 1].map((seat) =>
      deposit({
        signature: 'tx-race',
        escrowId: 'escrow-1',
        seat: seat as 0 | 1,
        profileId: seat === 0 ? seat0 : seat1,
        fromAddress: 'A',
      }).then(
        () => 'ok' as const,
        () => 'rejected' as const,
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(await listDeposits(getPool(), 'escrow-1')).toHaveLength(1);
  });

  it('the seat comes from the match mapping, not from anything the caller sends', async () => {
    const seats = await getMatchSeats(getPool(), 'match-1');
    expect(seats).not.toBeNull();
    expect(seatForProfile(seats!, seat0)).toBe(0);
    expect(seatForProfile(seats!, seat1)).toBe(1);
    // A profile that is not in the match has no seat at all — there is no way
    // to name one.
    const stranger = await makeProfile('stranger', '0xcccc000000000000000000000000000000000003');
    expect(seatForProfile(seats!, stranger)).toBeNull();
  });

  it('an escrow row lock serialises concurrent work on the same escrow (M-2)', async () => {
    const order: string[] = [];
    const first = withTransaction(async (client) => {
      await lockEscrow(client, 'escrow-1');
      order.push('first-locked');
      await new Promise((r) => setTimeout(r, 150));
      order.push('first-done');
    });
    // Give the first transaction time to take the lock.
    await new Promise((r) => setTimeout(r, 30));
    const second = withTransaction(async (client) => {
      await lockEscrow(client, 'escrow-1');
      order.push('second-locked');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-locked', 'first-done', 'second-locked']);
  });

  it('a deposit cannot reference an escrow that does not exist', async () => {
    await expect(
      deposit({ signature: 'tx-x', escrowId: 'nope', seat: 0, profileId: seat0, fromAddress: 'A' }),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('escrows are one-per-match', async () => {
    await expect(
      query(
        `INSERT INTO wager.escrows (id, match_id, amount_base, token, deposit_address, status)
         VALUES ('escrow-dup', 'match-1', $1, '0xtoken', '0xescrow', 'open')`,
        [AMOUNT.toString()],
      ),
    ).rejects.toSatisfy((err: unknown) => isUniqueViolation(err));
  });
});
