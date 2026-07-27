/**
 * Settlement exactly-once (C-1 + M-2), against a real Postgres and a fake chain.
 *
 * The fake sender counts broadcasts, so "the worker ran twice / concurrently /
 * after a crash, and the escrow paid once" is an assertion rather than a claim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query } from '../platform/shared.js';
import {
  closeTestDatabase,
  makeDeposit,
  makeEscrow,
  makeMatch,
  makeMatchResult,
  makeProfile,
  setupTestDatabase,
  testDatabaseUrl,
  truncateAll,
} from '../testing/db.js';
import { FakeReader, FakeSender } from '../testing/fakeChain.js';
import { signMatchResult } from '../domain/matchResult.js';
import { getPayout, listLegs } from '../db/payouts.js';
import { getEscrowById } from '../db/escrows.js';
import { runSettlementPass, settleCandidate, type SettlementWorkerDeps } from '../worker/settlementWorker.js';
import { listSettlementCandidates } from '../db/matchResults.js';

const HAS_DB = testDatabaseUrl() !== null;
const suite = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn('[wager] TEST_DATABASE_URL not set — settlement idempotency tests SKIPPED');
}

const SECRET = 's'.repeat(48);
const AMOUNT = 1_000_000n;
const ADDR_A = '0xaaaa000000000000000000000000000000000001';
const ADDR_B = '0xbbbb000000000000000000000000000000000002';
const FINISHED = new Date('2026-07-27T10:00:00.000Z');

const BURN = '0x000000000000000000000000000000000000dead';

function deps(sender: FakeSender): SettlementWorkerDeps {
  return {
    payout: {
      reader: new FakeReader(),
      sender,
      leaseSeconds: 60,
      confirmTimeoutMs: 1_000,
      confirmPollMs: 10,
    },
    hmacSecret: SECRET,
    burnBps: 1_000,
    burnAddress: BURN,
    batchSize: 10,
    pollMs: 1_000,
  };
}

suite('settlement worker exactly-once', () => {
  let p0 = '';
  let p1 = '';

  beforeAll(async () => {
    await setupTestDatabase();
  });
  afterAll(async () => {
    await closeTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll();
    p0 = await makeProfile('seat-zero', ADDR_A);
    p1 = await makeProfile('seat-one', ADDR_B);
    await makeMatch('m1', p0, p1);
    await makeEscrow({ id: 'e1', matchId: 'm1', amountBase: AMOUNT, status: 'funded' });
    await makeDeposit({
      signature: 'tx-dep-0',
      escrowId: 'e1',
      seat: 0,
      profileId: p0,
      fromAddress: ADDR_A,
      amountBase: AMOUNT,
    });
    await makeDeposit({
      signature: 'tx-dep-1',
      escrowId: 'e1',
      seat: 1,
      profileId: p1,
      fromAddress: ADDR_B,
      amountBase: AMOUNT,
    });
  });

  async function writeResult(winnerSeat: number | null, matchId = 'm1'): Promise<void> {
    const payload = {
      matchId,
      winnerSeat: winnerSeat as 0 | 1 | null,
      reason: 'life',
      finishedAt: FINISHED,
    };
    await makeMatchResult({
      matchId,
      winnerSeat,
      reason: 'life',
      finishedAt: FINISHED,
      serverSig: signMatchResult(payload, SECRET),
    });
  }

  it('pays the winner once and marks the escrow settled', async () => {
    await writeResult(1);
    const sender = new FakeSender();
    const summary = await runSettlementPass(deps(sender));

    expect(summary).toMatchObject({ examined: 1, paid: 1 });
    // Two legs: the winner's payout and the burn.
    expect(sender.broadcasts).toHaveLength(2);
    expect(sender.transfers.map((t) => ({ to: t.to, amountBase: t.amountBase }))).toEqual([
      { to: ADDR_B, amountBase: 1_800_000n },
      { to: BURN, amountBase: 200_000n },
    ]);
    // Each leg gets its own nonce, allocated in order.
    expect(sender.transfers.map((t) => t.nonce)).toEqual([0, 1]);

    const escrow = await getEscrowById(getPool(), 'e1');
    expect(escrow?.status).toBe('settled');
    const payout = await getPayout(getPool(), 'e1');
    expect(payout).toMatchObject({ status: 'paid', kind: 'winner' });
  });

  it('re-running the worker does not pay a second time', async () => {
    await writeResult(0);
    const sender = new FakeSender();
    await runSettlementPass(deps(sender));
    await runSettlementPass(deps(sender));
    await runSettlementPass(deps(sender));

    // Two legs, signed and broadcast exactly once each.
    expect(sender.broadcasts).toHaveLength(2);
    expect(sender.prepared).toHaveLength(2);
    expect(sender.distinctBroadcasts).toBe(2);
  });

  it('a settled escrow is not even a candidate any more', async () => {
    await writeResult(0);
    const sender = new FakeSender();
    await runSettlementPass(deps(sender));
    expect(await listSettlementCandidates(getPool(), 10)).toHaveLength(0);
  });

  it('two workers racing the same match produce exactly one payment (M-2)', async () => {
    await writeResult(1);
    const sender = new FakeSender();
    const d = deps(sender);
    // Both workers picked up the SAME candidate before either had claimed it.
    const candidate = (await listSettlementCandidates(getPool(), 1))[0]!;
    const [a, b] = await Promise.all([
      settleCandidate(d, candidate),
      settleCandidate(d, candidate),
    ]);
    expect(sender.broadcasts).toHaveLength(2);
    const states = [a.state, b.state].sort();
    expect(states).toContain('paid');
    const payout = await getPayout(getPool(), 'e1');
    expect(payout?.status).toBe('paid');
  });

  it('refuses to settle a result whose HMAC does not verify (C-1)', async () => {
    await makeMatchResult({
      matchId: 'm1',
      winnerSeat: 0,
      reason: 'life',
      finishedAt: FINISHED,
      // What an attacker who reached the database — but not the secret — could write.
      serverSig: 'deadbeef'.repeat(8),
    });
    const sender = new FakeSender();
    const summary = await runSettlementPass(deps(sender));

    expect(summary.rejected).toBe(1);
    expect(sender.broadcasts).toHaveLength(0);
    expect((await getEscrowById(getPool(), 'e1'))?.status).toBe('funded');
    expect(await getPayout(getPool(), 'e1')).toBeNull();
  });

  it('refuses a result whose winner was flipped after signing', async () => {
    await writeResult(0);
    await query(`UPDATE game.match_results SET winner_seat = 1 WHERE match_id = 'm1'`);
    const sender = new FakeSender();
    const summary = await runSettlementPass(deps(sender));
    expect(summary.rejected).toBe(1);
    expect(sender.broadcasts).toHaveLength(0);
  });

  it('refunds both payers on a draw, and never more than came in', async () => {
    await writeResult(null);
    const sender = new FakeSender();
    await runSettlementPass(deps(sender));

    expect(sender.transfers.map((t) => ({ to: t.to, amountBase: t.amountBase }))).toEqual([
      { to: ADDR_A, amountBase: AMOUNT },
      { to: ADDR_B, amountBase: AMOUNT },
    ]);
    // Conservation: exactly what came in goes back out. No burn on a draw.
    const total = sender.transfers.reduce((acc, t) => acc + t.amountBase, 0n);
    expect(total).toBe(AMOUNT * 2n);
    expect((await getEscrowById(getPool(), 'e1'))?.status).toBe('refunded');
  });

  it('CRASH AFTER BROADCAST: the next run reconciles instead of paying again', async () => {
    await writeResult(1);
    // First run: broadcast lands, but the process dies before the DB is updated,
    // so `awaitOutcome` never resolves to 'confirmed' for this attempt.
    const crashy = new FakeSender({ outcome: 'pending' });
    const first = await settleCandidate(deps(crashy), (await listSettlementCandidates(getPool(), 1))[0]!);
    expect(first.state).toBe('pending');
    expect(crashy.broadcasts).toEqual(['0xhash_n0_a1']);

    // The hash was recorded BEFORE the broadcast — that is what makes the
    // in-flight payment identifiable rather than anonymous.
    const legsMid = await listLegs(getPool(), 'e1');
    expect(legsMid[0]).toMatchObject({ status: 'sending', txHash: '0xhash_n0_a1', nonce: 0 });

    // Second run, fresh sender (fresh process). The chain reports the ORIGINAL
    // signature as confirmed.
    const recovered = new FakeSender();
    recovered.markLanded('0xhash_n0_a1');
    // Expire the previous lease so this "process" may take over.
    await query(`UPDATE wager.payouts SET lease_until = now() - interval '1 hour'`);

    const second = await settleCandidate(
      deps(recovered),
      (await listSettlementCandidates(getPool(), 1))[0]!,
    );
    // Leg 0 was reconciled without a new transaction; only leg 1 (the burn) was
    // built and sent.
    expect(recovered.prepared).toHaveLength(1);
    expect(recovered.broadcasts).toEqual(['0xhash_n1_a1']);
    expect((await listLegs(getPool(), 'e1'))[0]).toMatchObject({
      status: 'paid',
      txHash: '0xhash_n0_a1',
    });
    expect(second.state).toBe('paid');
  });

  it('REVERTED: a replacement is built at the SAME nonce', async () => {
    await writeResult(1);
    const reverting = new FakeSender({ outcome: 'reverted' });
    await settleCandidate(deps(reverting), (await listSettlementCandidates(getPool(), 1))[0]!);
    // The attempt was recorded, then cleared, because a reverted transaction
    // moved nothing. The nonce is deliberately kept.
    const legs = await listLegs(getPool(), 'e1');
    expect(legs[0]).toMatchObject({ status: 'preparing', txHash: null, nonce: 0 });

    const retry = new FakeSender();
    await query(`UPDATE wager.payouts SET lease_until = now() - interval '1 hour'`);
    await settleCandidate(deps(retry), (await listSettlementCandidates(getPool(), 1))[0]!);
    // The replacement reuses nonce 0, so it and the reverted original are
    // mutually exclusive on-chain.
    expect(retry.transfers[0]!.nonce).toBe(0);
  });

  it('a broadcast that throws still leaves the signature recorded for reconciliation', async () => {
    await writeResult(0);
    const flaky = new FakeSender({ broadcastThrows: true });
    const outcome = await settleCandidate(
      deps(flaky),
      (await listSettlementCandidates(getPool(), 1))[0]!,
    );
    expect(outcome.state).toBe('pending');
    expect((await listLegs(getPool(), 'e1'))[0]).toMatchObject({
      status: 'sending',
      txHash: '0xhash_n0_a1',
    });
  });

  it('refunds the funded seat when only one player paid', async () => {
    await query(`DELETE FROM wager.deposits WHERE seat = 1`);
    await writeResult(1);
    const sender = new FakeSender();
    await runSettlementPass(deps(sender));
    expect(sender.transfers.map((t) => t.to)).toEqual([ADDR_A]);
    expect((await getEscrowById(getPool(), 'e1'))?.status).toBe('refunded');
  });

  it('sends no transaction at all when nothing was deposited', async () => {
    await query(`DELETE FROM wager.deposits`);
    await writeResult(0);
    const sender = new FakeSender();
    await runSettlementPass(deps(sender));
    expect(sender.prepared).toHaveLength(0);
    expect((await getEscrowById(getPool(), 'e1'))?.status).toBe('settled');
  });

  it('a match with no escrow is never a candidate', async () => {
    await makeMatch('m2', p0, p1);
    await writeResult(0, 'm2');
    const candidates = await listSettlementCandidates(getPool(), 10);
    expect(candidates.map((c) => c.matchId)).not.toContain('m2');
  });

  it('a leg tx_hash is globally unique, so one transaction cannot cover two legs', async () => {
    await writeResult(1);
    const sender = new FakeSender();
    await runSettlementPass(deps(sender));
    await expect(
      query(
        `INSERT INTO wager.payout_legs
           (escrow_id, leg_index, to_address, amount_base, purpose, status, tx_hash)
         VALUES ('e1', 99, $1, 1, 'payout', 'paid', '0xhash_n0_a1')`,
        [ADDR_A],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
