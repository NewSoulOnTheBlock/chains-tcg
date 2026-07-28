/**
 * A player may pay from ANY wallet linked to their profile.
 *
 * `POST /auth/verify` puts the profile's PRIMARY address in the token's `addr`
 * claim, not the wallet that signed. The money paths compared `tx.from` against
 * that single address, so a player signing in with one wallet and paying from
 * another had a genuine payment rejected as "not sent by the authenticated
 * wallet". The two values were always equal before account linking, which is why
 * nothing caught it.
 *
 * Neither path is reachable by a player today — wager is not offered in the
 * client and its payout worker is off, and the booster ticket product answers
 * 503 because BOOSTER_CARD_POOL is empty — so these tests are the only thing
 * standing between the trap and the day one of those products is switched on.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgres://chains:<pw>@127.0.0.1:5432/chains_test npx vitest run
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query, withTransaction } from '../platform/shared.js';
import type { AuthContext } from '../platform/shared.js';
import {
  closeTestDatabase,
  linkAddress,
  makeEscrow,
  makeMatch,
  makeProfile,
  setupTestDatabase,
  testDatabaseUrl,
  truncateAll,
} from '../testing/db.js';
import { FakeReader } from '../testing/fakeChain.js';
import { setLoggerForTest } from '../platform/logger.js';
import type { Logger } from '../platform/shared.js';
import { resolveTransactingAddresses } from '../services/transactingAddresses.js';
import { submitDeposit, type EscrowServiceDeps } from '../services/escrowService.js';
import { listDeposits } from '../db/escrows.js';
import type { ParsedTx } from '../chain/types.js';

const HAS_DB = testDatabaseUrl() !== null;
const suite = HAS_DB ? describe : describe.skip;

if (!HAS_DB) {
  // eslint-disable-next-line no-console
  console.warn('[wager] TEST_DATABASE_URL not set — transacting address tests SKIPPED');
}

/** Matches `makeEscrow`'s hardcoded token and deposit address. */
const TOKEN = '0x1111111111111111111111111111111111111111';
const ESCROW_ADDRESS = '0x2222222222222222222222222222222222222222';

const PRIMARY = '0xaaaa000000000000000000000000000000000011';
const SECONDARY = '0xcccc000000000000000000000000000000000033';
const OPPONENT = '0xbbbb000000000000000000000000000000000022';
const STRANGER = '0xeeee000000000000000000000000000000000055';
const SOLANA = 'So11111111111111111111111111111111111111112';

const AMOUNT = 1_000_000n;

function authFor(profileId: string, address: string, chain = 'robinhood'): AuthContext {
  return { profileId, address, chain, roles: [] } as unknown as AuthContext;
}

function captureErrors(): { events: Array<{ msg: string; fields?: Record<string, unknown> }> } {
  const events: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const capture = {
    level: 'debug' as const,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields?: Record<string, unknown>) => events.push({ msg, fields }),
    child: () => capture,
  };
  setLoggerForTest(capture as unknown as Logger);
  return { events };
}

suite('which wallets a profile may pay from', () => {
  let player = '';
  let opponent = '';

  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await closeTestDatabase();
  });

  beforeEach(async () => {
    await truncateAll();
    player = await makeProfile('player', PRIMARY);
    opponent = await makeProfile('opponent', OPPONENT);
  });

  /* ── resolveTransactingAddresses ──────────────────────────────────── */

  describe('resolveTransactingAddresses', () => {
    it('returns every linked wallet, sorted and lower-cased', async () => {
      await linkAddress({ profileId: player, address: SECONDARY, kind: 'smart' });

      const plan = await resolveTransactingAddresses(getPool(), authFor(player, PRIMARY));
      expect(plan.source).toBe('linked');
      expect(plan.addresses).toEqual([PRIMARY, SECONDARY].sort());
    });

    it('spans EVM chains — a wallet proved on one chain is the same keypair', async () => {
      // core.profile_addresses.chain records where control was PROVED, not where
      // the wallet may spend. Pinning the set to the money path's chain id would
      // also collide with ROADMAP-ownership.md § 3, where that chain id is still
      // Sepolia while every player signed in on 4663.
      await linkAddress({ profileId: player, address: SECONDARY, chain: 'ethereum' });

      const plan = await resolveTransactingAddresses(getPool(), authFor(player, PRIMARY));
      expect(plan.addresses).toEqual([PRIMARY, SECONDARY].sort());
    });

    it('drops non-EVM wallets, which can never be a tx.from', async () => {
      await linkAddress({ profileId: player, address: SOLANA, chain: 'solana' });

      const plan = await resolveTransactingAddresses(getPool(), authFor(player, PRIMARY));
      expect(plan.addresses).toEqual([PRIMARY]);
    });

    it('never includes another profile’s wallet', async () => {
      await linkAddress({ profileId: opponent, address: SECONDARY });

      const plan = await resolveTransactingAddresses(getPool(), authFor(player, PRIMARY));
      expect(plan.addresses).toEqual([PRIMARY]);
      expect(plan.addresses).not.toContain(SECONDARY);
    });

    it('drops a wallet the moment it is unlinked', async () => {
      await linkAddress({ profileId: player, address: SECONDARY });
      expect((await resolveTransactingAddresses(getPool(), authFor(player, PRIMARY))).addresses)
        .toHaveLength(2);

      await query(`DELETE FROM core.profile_addresses WHERE address = $1`, [SECONDARY]);

      const plan = await resolveTransactingAddresses(getPool(), authFor(player, PRIMARY));
      expect(plan.addresses).toEqual([PRIMARY]);
    });

    it('does NOT merge a session wallet the database does not name', async () => {
      // A token minted before an unlink. The database is the authority, so the
      // stale wallet stops being able to fund anything — otherwise an unlinked
      // wallet could keep spending as its old profile until the token expired.
      const plan = await resolveTransactingAddresses(getPool(), authFor(player, STRANGER));
      expect(plan.addresses).toEqual([PRIMARY]);
      expect(plan.addresses).not.toContain(STRANGER);
    });

    it('degrades to the session wallet alone, loudly, when the profile has no rows', async () => {
      await query(
        `ALTER TABLE core.profile_addresses DISABLE TRIGGER profile_addresses_guard_unlink`,
      );
      await query(`DELETE FROM core.profile_addresses WHERE profile_id = $1::bigint`, [player]);
      await query(
        `ALTER TABLE core.profile_addresses ENABLE TRIGGER profile_addresses_guard_unlink`,
      );

      const { events } = captureErrors();
      let plan;
      try {
        plan = await resolveTransactingAddresses(getPool(), authFor(player, PRIMARY));
      } finally {
        setLoggerForTest(null);
      }

      // Exactly the pre-linking behaviour: correct, just narrower. Refusing
      // instead would take payments down on a deploy-ordering accident.
      expect(plan.source).toBe('session_fallback');
      expect(plan.addresses).toEqual([PRIMARY]);
      expect(events.filter((e) => e.msg === 'profile_addresses_missing')[0]?.fields).toMatchObject({
        reason: 'no_rows_for_profile',
        fallback: 'session_address_only',
      });
    });
  });

  /* ── submitDeposit, end to end ────────────────────────────────────── */

  describe('submitDeposit accepts a linked secondary wallet', () => {
    let reader: FakeReader;
    let deps: EscrowServiceDeps;

    beforeEach(async () => {
      await makeMatch('match-1', player, opponent);
      await makeEscrow({ id: 'escrow-1', matchId: 'match-1', amountBase: AMOUNT, status: 'open' });
      reader = new FakeReader();
      deps = {
        reader,
        // Unused by submitDeposit; the payout runner and the stake policy are
        // only reached by createEscrow and voidEscrow.
        payout: {} as EscrowServiceDeps['payout'],
        stakes: {} as EscrowServiceDeps['stakes'],
        token: TOKEN,
        decimals: 6,
        depositAddress: ESCROW_ADDRESS,
        minConfirmations: 1,
        depositTxTimeoutSeconds: 10,
      };
    });

    /** A well-formed funding transaction sent by `payer`. */
    function fundingTx(hash: string, payer: string): ParsedTx {
      return {
        hash,
        blockNumber: 500,
        blockTimestamp: Math.floor(Date.now() / 1000) + 60,
        status: 'success',
        from: payer,
        to: TOKEN,
        value: 0n,
        input: '0x',
        confirmations: 3,
        erc20Transfers: [
          { token: TOKEN, from: payer, to: ESCROW_ADDRESS, value: AMOUNT, logIndex: 7 },
        ],
      };
    }

    it('THE TRAP: a payment from a linked secondary is accepted', async () => {
      await linkAddress({ profileId: player, address: SECONDARY, kind: 'smart' });
      reader.transactions.set('0xpay1', fundingTx('0xpay1', SECONDARY));

      // The session names the PRIMARY, because that is what /auth/verify puts in
      // the token. The money came from the secondary. Before this fix that was
      // a 400 deposit_not_sent_by_depositor.
      const result = await submitDeposit(deps, authFor(player, PRIMARY), {
        escrowId: 'escrow-1',
        txHash: '0xpay1',
      });
      expect(result).toMatchObject({ accepted: true, seat: 0 });
    });

    it('records the PAYING wallet, not the primary — refunds go back where the money came from', async () => {
      await linkAddress({ profileId: player, address: SECONDARY });
      reader.transactions.set('0xpay2', fundingTx('0xpay2', SECONDARY));

      await submitDeposit(deps, authFor(player, PRIMARY), {
        escrowId: 'escrow-1',
        txHash: '0xpay2',
      });

      // `wager.deposits.from_address` is the payout destination used by
      // planVoidRefund and planSettlement. Recording the primary here would
      // silently move a player's stake between their own wallets on every
      // refund, and lose it outright if the primary is later unlinked.
      const [row] = await listDeposits(getPool(), 'escrow-1');
      expect(row!.fromAddress).toBe(SECONDARY);
    });

    it('still accepts a payment from the primary', async () => {
      await linkAddress({ profileId: player, address: SECONDARY });
      reader.transactions.set('0xpay3', fundingTx('0xpay3', PRIMARY));

      await submitDeposit(deps, authFor(player, PRIMARY), {
        escrowId: 'escrow-1',
        txHash: '0xpay3',
      });
      const [row] = await listDeposits(getPool(), 'escrow-1');
      expect(row!.fromAddress).toBe(PRIMARY);
    });

    it('rejects a wallet linked to somebody ELSE', async () => {
      // The set is not "any address at all". It is read from the database for
      // the authenticated profile id, so another player's wallet is no more
      // usable than a random one (H-2).
      await linkAddress({ profileId: opponent, address: SECONDARY });
      reader.transactions.set('0xpay4', fundingTx('0xpay4', SECONDARY));

      await expect(
        submitDeposit(deps, authFor(player, PRIMARY), {
          escrowId: 'escrow-1',
          txHash: '0xpay4',
        }),
      ).rejects.toMatchObject({ details: { reason: 'deposit_not_sent_by_depositor' } });

      // And the reservation was rolled back, so an honest retry is still possible.
      expect(await listDeposits(getPool(), 'escrow-1')).toEqual([]);
    });

    it('rejects a wallet linked to nobody', async () => {
      reader.transactions.set('0xpay5', fundingTx('0xpay5', STRANGER));

      await expect(
        submitDeposit(deps, authFor(player, PRIMARY), {
          escrowId: 'escrow-1',
          txHash: '0xpay5',
        }),
      ).rejects.toMatchObject({ details: { reason: 'deposit_not_sent_by_depositor' } });
    });

    it('rejects a wallet that WAS linked and has since been unlinked', async () => {
      await linkAddress({ profileId: player, address: SECONDARY });
      await query(`DELETE FROM core.profile_addresses WHERE address = $1`, [SECONDARY]);
      reader.transactions.set('0xpay6', fundingTx('0xpay6', SECONDARY));

      await expect(
        submitDeposit(deps, authFor(player, PRIMARY), {
          escrowId: 'escrow-1',
          txHash: '0xpay6',
        }),
      ).rejects.toMatchObject({ details: { reason: 'deposit_not_sent_by_depositor' } });
    });

    it('C-2 still holds: one transaction cannot fund the other seat', async () => {
      await linkAddress({ profileId: player, address: SECONDARY });
      await linkAddress({ profileId: opponent, address: STRANGER });
      reader.transactions.set('0xpay7', fundingTx('0xpay7', SECONDARY));

      await submitDeposit(deps, authFor(player, PRIMARY), {
        escrowId: 'escrow-1',
        txHash: '0xpay7',
      });

      // Widening WHO may pay must not widen how many seats one payment funds.
      await expect(
        submitDeposit(deps, authFor(opponent, OPPONENT), {
          escrowId: 'escrow-1',
          txHash: '0xpay7',
        }),
      ).rejects.toMatchObject({ details: { reason: 'signature_already_used' } });
    });

    it('reads the linked set inside the deposit transaction', async () => {
      // Not a behavioural claim about concurrency — a structural one. If the
      // resolver ran on the pool it would see a snapshot outside the
      // transaction that writes the row, and an unlink could land between them.
      await linkAddress({ profileId: player, address: SECONDARY });
      reader.transactions.set('0xpay8', fundingTx('0xpay8', SECONDARY));

      await withTransaction(async (client) => {
        const plan = await resolveTransactingAddresses(client, authFor(player, PRIMARY));
        expect(plan.addresses).toContain(SECONDARY);
      });
    });
  });
});
