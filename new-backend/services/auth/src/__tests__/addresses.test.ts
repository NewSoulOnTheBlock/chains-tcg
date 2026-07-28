/**
 * Multi-address identity, against a real PostgreSQL.
 *
 * NON-DESTRUCTIVE, like the game service's `ownership.repo.test.ts` and unlike
 * the wager harness: this file never drops a schema. It creates profiles under
 * a fixed address prefix, works inside them, and deletes them at the end
 * (ON DELETE CASCADE takes the address links with them), so it is safe to point
 * at the same compose Postgres the services are running against.
 *
 *     TEST_DATABASE_URL=postgres://chains:<pw>@127.0.0.1:5432/chains npm test
 *
 * Without TEST_DATABASE_URL the whole file skips.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testEnv = vi.hoisted(() => {
  const db = process.env.TEST_DATABASE_URL ?? null;
  process.env.DATABASE_URL = db ?? 'postgres://chains:unused@127.0.0.1:5432/chains';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long';
  process.env.LOG_LEVEL ??= 'error';
  return { db };
});

const suite = testEnv.db ? describe : describe.skip;
if (!testEnv.db) {
  // eslint-disable-next-line no-console
  console.warn('[auth] TEST_DATABASE_URL not set — profile_addresses tests SKIPPED');
}

const { closeDb, initDb, query } = await import('@chains/shared');
const { findProfileIdByAddress, linkAddress, listAddresses, setPrimaryAddress, unlinkAddress } =
  await import('../addresses.js');
const { findOrCreateProfile } = await import('../profiles.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0013 = path.resolve(HERE, '../../../../db/migrations/0013_profile_addresses.sql');

const CHAIN = 'robinhood';
/** Every address this file creates starts here, so cleanup is exact. */
const PREFIX = '0xa17e57';

let addressSeq = 0;
function addr(): string {
  addressSeq += 1;
  return (PREFIX + addressSeq.toString(16).padStart(34, '0')).toLowerCase();
}

async function cleanup(): Promise<void> {
  await query(`DELETE FROM core.profiles WHERE address LIKE $1 || '%'`, [PREFIX]);
  await query(`DELETE FROM core.profile_addresses WHERE address LIKE $1 || '%'`, [PREFIX]);
  await query(`DELETE FROM core.profile_address_unlinks WHERE address LIKE $1 || '%'`, [PREFIX]);
}

/** A profile with one primary address, created the way sign-in creates one. */
async function newProfile(): Promise<{ id: string; address: string }> {
  const address = addr();
  const { profile } = await findOrCreateProfile(address, CHAIN);
  return { id: profile.id, address };
}

suite('core.profile_addresses', () => {
  beforeAll(async () => {
    initDb({ connectionString: testEnv.db!, max: 4, statementTimeoutMs: 15_000 });

    // Assert the migration is present rather than applying it: pointing this
    // suite at a database that has not been migrated should say so, not
    // silently mutate it.
    const present = await query<{ exists: boolean }>(
      `SELECT to_regclass('core.profile_addresses') IS NOT NULL AS exists`,
    );
    if (!present.rows[0]?.exists) {
      throw new Error(
        'core.profile_addresses is missing. Apply db/migrations/0013_profile_addresses.sql.',
      );
    }
    await cleanup();
  });

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  /* ------------------------------------------------------------------ */
  describe('backfill', () => {
    it('gives every pre-0013 profile exactly one primary eoa row', async () => {
      // Recreate the pre-migration world: profiles with NO address link. The
      // trigger 0013 installs is what normally prevents that, so it is disabled
      // for the duration — this is the only way to test the backfill against
      // rows that genuinely predate the table.
      await query(`ALTER TABLE core.profiles DISABLE TRIGGER profiles_link_primary_address`);
      const seeded: string[] = [];
      try {
        for (let i = 0; i < 26; i += 1) {
          const address = addr();
          seeded.push(address);
          await query(
            `INSERT INTO core.profiles (address, chain, display_name, created_at)
             VALUES ($1, $2, $3, now() - ($4 || ' days')::interval)`,
            [address, CHAIN, `backfill-${i}-${address.slice(-6)}`, String(i + 1)],
          );
        }

        const unlinked = await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM core.profiles p
            WHERE p.address LIKE $1 || '%'
              AND NOT EXISTS (SELECT 1 FROM core.profile_addresses a WHERE a.profile_id = p.id)`,
          [PREFIX],
        );
        expect(unlinked.rows[0]!.n).toBe('26');

        // Run 0013 verbatim. It is idempotent and re-runnable by house rule, so
        // this both backfills the 26 rows above and re-asserts its own
        // invariants across every other profile in the database.
        await query(await readFile(MIGRATION_0013, 'utf8'));
      } finally {
        // The migration's own DROP/CREATE TRIGGER restores it; belt and braces
        // in case the run above failed partway.
        await query(
          `ALTER TABLE core.profiles ENABLE TRIGGER profiles_link_primary_address`,
        ).catch(() => undefined);
      }

      const rows = await query<{
        address: string;
        chain: string;
        kind: string;
        is_primary: boolean;
        linked_at: string;
        created_at: string;
      }>(
        `SELECT a.address, a.chain, a.kind, a.is_primary, a.linked_at, p.created_at
           FROM core.profile_addresses a
           JOIN core.profiles p ON p.id = a.profile_id
          WHERE a.address LIKE $1 || '%'
          ORDER BY a.address`,
        [PREFIX],
      );

      expect(rows.rowCount).toBe(26);
      for (const row of rows.rows) {
        expect(row.chain).toBe(CHAIN);
        expect(row.kind).toBe('eoa');
        expect(row.is_primary).toBe(true);
        // linked_at is the profile's created_at, not the migration's clock.
        expect(new Date(row.linked_at).getTime()).toBe(new Date(row.created_at).getTime());
      }
      expect(new Set(rows.rows.map((r) => r.address))).toEqual(new Set(seeded));

      // Global invariant, over every profile in the database and not just ours.
      const orphans = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM core.profiles p
          WHERE NOT EXISTS (SELECT 1 FROM core.profile_addresses a
                             WHERE a.profile_id = p.id AND a.is_primary)`,
      );
      expect(orphans.rows[0]!.n).toBe('0');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('linking', () => {
    it('links a second wallet and lists both, primary first', async () => {
      const profile = await newProfile();
      const second = addr();

      const linked = await linkAddress({
        profileId: profile.id,
        address: second,
        chain: CHAIN,
        kind: 'smart',
      });
      expect(linked).toMatchObject({ address: second, kind: 'smart', isPrimary: false });

      const list = await listAddresses(profile.id);
      expect(list.map((a) => a.address)).toEqual([profile.address, second]);
      expect(list[0]!.isPrimary).toBe(true);
    });

    it('refuses an address already linked to ANOTHER profile', async () => {
      const alice = await newProfile();
      const bob = await newProfile();

      await expect(
        linkAddress({ profileId: bob.id, address: alice.address, chain: CHAIN, kind: 'eoa' }),
      ).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'address_linked_elsewhere' },
      });

      // …and says nothing about whose it is.
      expect(await findProfileIdByAddress(alice.address, CHAIN)).toBe(alice.id);
    });

    it('refuses an address already linked to the CALLER, distinctly', async () => {
      const alice = await newProfile();
      const second = addr();
      await linkAddress({ profileId: alice.id, address: second, chain: CHAIN, kind: 'eoa' });

      await expect(
        linkAddress({ profileId: alice.id, address: second, chain: CHAIN, kind: 'eoa' }),
      ).rejects.toMatchObject({
        code: 'conflict',
        details: { reason: 'address_already_linked' },
      });
    });

    it('does not let a new profile be created for a linked address', async () => {
      // The "sign in fresh with someone else's linked wallet" path. It cannot
      // reach profile creation, because findOrCreateProfile resolves through
      // core.profile_addresses first.
      const alice = await newProfile();
      const second = addr();
      await linkAddress({ profileId: alice.id, address: second, chain: CHAIN, kind: 'eoa' });

      const { profile, created } = await findOrCreateProfile(second, CHAIN);
      expect(created).toBe(false);
      expect(profile.id).toBe(alice.id);
    });

    it('never links as primary — core.profiles.address is unmoved', async () => {
      const profile = await newProfile();
      const second = addr();
      await linkAddress({ profileId: profile.id, address: second, chain: CHAIN, kind: 'eoa' });

      const row = await query<{ address: string }>(
        `SELECT address FROM core.profiles WHERE id = $1::bigint`,
        [profile.id],
      );
      expect(row.rows[0]!.address).toBe(profile.address);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('sign-in through a secondary address', () => {
    it('reaches the SAME profile as the primary', async () => {
      const profile = await newProfile();
      const second = addr();
      await linkAddress({ profileId: profile.id, address: second, chain: CHAIN, kind: 'smart' });

      const viaPrimary = await findOrCreateProfile(profile.address, CHAIN);
      const viaSecondary = await findOrCreateProfile(second, CHAIN);

      expect(viaSecondary.created).toBe(false);
      expect(viaSecondary.profile.id).toBe(viaPrimary.profile.id);
      expect(viaSecondary.profile.id).toBe(profile.id);
      // The profile it returns still reports the PRIMARY wallet, which is what
      // the JWT `addr` claim and /auth/me are built from.
      expect(viaSecondary.profile.address).toBe(profile.address);

      // And exactly one profile exists for the pair.
      const count = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM core.profiles WHERE address LIKE $1 || '%'`,
        [PREFIX],
      );
      expect(count.rows[0]!.n).toBe('1');
    });

    it('an unlinked address still creates a new profile, exactly as before', async () => {
      const fresh = addr();
      const { profile, created } = await findOrCreateProfile(fresh, CHAIN);
      expect(created).toBe(true);
      expect(profile.address).toBe(fresh);
      expect(await listAddresses(profile.id)).toEqual([
        expect.objectContaining({ address: fresh, isPrimary: true, kind: 'eoa' }),
      ]);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('unlinking', () => {
    it('refuses to unlink the only address', async () => {
      const profile = await newProfile();
      await expect(
        unlinkAddress({ profileId: profile.id, address: profile.address, chain: CHAIN }),
      ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'last_address' } });

      // Still there, and still primary.
      expect(await listAddresses(profile.id)).toHaveLength(1);
    });

    it('refuses to unlink the primary while another address remains', async () => {
      const profile = await newProfile();
      const second = addr();
      await linkAddress({ profileId: profile.id, address: second, chain: CHAIN, kind: 'eoa' });

      await expect(
        unlinkAddress({ profileId: profile.id, address: profile.address, chain: CHAIN }),
      ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'primary_address' } });
    });

    it('unlinks a secondary and records the history row', async () => {
      const profile = await newProfile();
      const second = addr();
      await linkAddress({ profileId: profile.id, address: second, chain: CHAIN, kind: 'smart' });
      await unlinkAddress({ profileId: profile.id, address: second, chain: CHAIN });

      expect(await listAddresses(profile.id)).toHaveLength(1);
      const history = await query<{ address: string; profile_id: string; kind: string }>(
        `SELECT address, profile_id::text AS profile_id, kind
           FROM core.profile_address_unlinks WHERE address = $1`,
        [second],
      );
      expect(history.rows).toEqual([
        { address: second, profile_id: profile.id, kind: 'smart' },
      ]);
    });

    it('promotes another address first, then unlinks the old primary', async () => {
      const profile = await newProfile();
      const second = addr();
      await linkAddress({ profileId: profile.id, address: second, chain: CHAIN, kind: 'eoa' });

      const promoted = await setPrimaryAddress({
        profileId: profile.id,
        address: second,
        chain: CHAIN,
      });
      expect(promoted.isPrimary).toBe(true);

      // core.profiles.address followed the promotion (0013 § 4c).
      const mirrored = await query<{ address: string }>(
        `SELECT address FROM core.profiles WHERE id = $1::bigint`,
        [profile.id],
      );
      expect(mirrored.rows[0]!.address).toBe(second);

      await unlinkAddress({ profileId: profile.id, address: profile.address, chain: CHAIN });
      expect(await listAddresses(profile.id)).toEqual([
        expect.objectContaining({ address: second, isPrimary: true }),
      ]);
    });

    it('cannot unlink another profile address — 404, not 403', async () => {
      const alice = await newProfile();
      const bob = await newProfile();
      const bobSecond = addr();
      await linkAddress({ profileId: bob.id, address: bobSecond, chain: CHAIN, kind: 'eoa' });

      await expect(
        unlinkAddress({ profileId: alice.id, address: bobSecond, chain: CHAIN }),
      ).rejects.toMatchObject({ code: 'not_found', details: { reason: 'address_not_linked' } });

      // A never-linked address is indistinguishable from someone else's.
      await expect(
        unlinkAddress({ profileId: alice.id, address: addr(), chain: CHAIN }),
      ).rejects.toMatchObject({ code: 'not_found', details: { reason: 'address_not_linked' } });

      expect(await listAddresses(bob.id)).toHaveLength(2);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('relink cooldown', () => {
    async function unlinkedAddress(): Promise<{ owner: string; address: string }> {
      const owner = await newProfile();
      const second = addr();
      await linkAddress({ profileId: owner.id, address: second, chain: CHAIN, kind: 'eoa' });
      await unlinkAddress({ profileId: owner.id, address: second, chain: CHAIN });
      return { owner: owner.id, address: second };
    }

    it('refuses linking to a different profile within 30 days', async () => {
      const { address } = await unlinkedAddress();
      const other = await newProfile();

      await expect(
        linkAddress({ profileId: other.id, address, chain: CHAIN, kind: 'eoa' }),
      ).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'address_relink_cooldown', eligibleAt: expect.any(String) },
      });
    });

    it('refuses the sign-in bypass — a brand-new profile for that wallet', async () => {
      const { address } = await unlinkedAddress();
      await expect(findOrCreateProfile(address, CHAIN)).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'address_relink_cooldown' },
      });
    });

    it('allows relinking to the profile it came from', async () => {
      const { owner, address } = await unlinkedAddress();
      const relinked = await linkAddress({ profileId: owner, address, chain: CHAIN, kind: 'eoa' });
      expect(relinked.address).toBe(address);
    });

    it('allows a different profile once the cooldown has elapsed', async () => {
      const { address } = await unlinkedAddress();
      await query(
        `UPDATE core.profile_address_unlinks
            SET unlinked_at = now() - interval '31 days'
          WHERE address = $1`,
        [address],
      );
      const other = await newProfile();
      const linked = await linkAddress({
        profileId: other.id,
        address,
        chain: CHAIN,
        kind: 'eoa',
      });
      expect(linked.address).toBe(address);
    });

    it('is not started by deleting a profile (cascade is exempt)', async () => {
      // Fixture teardown across the game and wager suites deletes profiles by
      // address and reuses those addresses on the next run. If a cascade wrote
      // history, every one of those suites would poison itself.
      const profile = await newProfile();
      await query(`DELETE FROM core.profiles WHERE id = $1::bigint`, [profile.id]);

      const history = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM core.profile_address_unlinks WHERE address = $1`,
        [profile.address],
      );
      expect(history.rows[0]!.n).toBe('0');

      const { created } = await findOrCreateProfile(profile.address, CHAIN);
      expect(created).toBe(true);
    });
  });
});
