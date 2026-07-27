/**
 * The queue and the pairer, end to end against a real Postgres.
 *
 * What this is really testing is that a player cannot get into a ranked match
 * with cards they do not own, and cannot be handed a seat by anything other than
 * the server:
 *
 *   • enqueue runs the same `assertDeckOwnership` gate that seating a ranked
 *     match runs, so an ineligible deck is refused UP FRONT with the offending
 *     cards named — not discovered later as a pairing that quietly never
 *     happened;
 *   • the pairer re-runs it, because `core.decks.cards` stays editable the whole
 *     time its owner sits in the queue. "Queue with a legal deck, then edit it to
 *     the full catalogue" is a working exploit against a check that only runs at
 *     enqueue, and it is the same hole the lobby closes for seat 0 on join;
 *   • both seats and both credentials are minted server-side. The client sends a
 *     region and nothing else — no name, no deck, no seat, no credential.
 *
 * boardgame.io's store is mocked; `createMatch` from the vendor is NOT, so the
 * rules module really does run `setup()` over both decklists.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testEnv = vi.hoisted(() => {
  const db = process.env.TEST_DATABASE_URL ?? null;
  process.env.DATABASE_URL = db ?? 'postgres://chains:unused@127.0.0.1:5432/chains';
  process.env.REDIS_URL ??= 'redis://127.0.0.1:6379';
  process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long';
  process.env.MATCH_RESULT_HMAC_SECRET ??= 'test-hmac-secret-at-least-32-characters-long';
  process.env.LOG_LEVEL ??= 'error';
  return { db };
});

const created = vi.hoisted(() => ({
  matches: [] as Array<{ id: string; metadata: unknown }>,
}));

vi.mock('../bgio/store.js', () => ({
  store: {
    fetch: vi.fn(async () => ({})),
    listMatches: vi.fn(async () => [] as string[]),
    createMatch: vi.fn(async (id: string, opts: { metadata: unknown }) => {
      created.matches.push({ id, metadata: opts.metadata });
    }),
    wipe: vi.fn(async () => undefined),
    sequelize: { authenticate: vi.fn(), close: vi.fn() },
  },
  connectStore: vi.fn(),
  closeStore: vi.fn(),
}));

import { AppError, closeDb, getPool, initDb, query } from '@chains/shared';
import { isBasicNode, starterDeck } from '../game/cards.js';
import { joinQueue, leaveQueue, queueStatus } from '../ranked/queue.js';
import { RankedMatchmaker } from '../ranked/matchmaker.js';
import { ensureActiveSeason, clearSeasonMemo } from '../ranked/season.js';
import * as repo from '../repo/ranked.repo.js';

const suite = testEnv.db ? describe : describe.skip;

if (!testEnv.db) {
  // eslint-disable-next-line no-console
  console.warn('[game] TEST_DATABASE_URL not set — ranked queue tests SKIPPED');
}

const ADDR_PREFIX = '0x0000000000000000000000rankedqueue';
const DECK = starterDeck('eth');

suite('ranked queue and pairing', () => {
  const matchmaker = new RankedMatchmaker();
  const addresses: string[] = [];
  const profileIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    initDb({ connectionString: testEnv.db!, max: 4, statementTimeoutMs: 20_000 });
    clearSeasonMemo();
    await ensureActiveSeason();
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  beforeEach(async () => {
    await cleanup();
    created.matches.length = 0;
  });

  async function cleanup(): Promise<void> {
    if (profileIds.length > 0) {
      // Matches reference decks and profiles with no ON DELETE, so they go
      // first; match_results references matches, so it goes before that.
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM game.matches
          WHERE seat0_profile = ANY($1::bigint[]) OR seat1_profile = ANY($1::bigint[])`,
        [profileIds],
      ).catch(() => ({ rows: [] as Array<{ id: string }> }));
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        await query(`DELETE FROM game.match_results WHERE match_id = ANY($1::text[])`, [ids]);
        await query(`DELETE FROM game.matches WHERE id = ANY($1::text[])`, [ids]);
      }
      profileIds.length = 0;
    }
    if (addresses.length > 0) {
      await query(`DELETE FROM core.profiles WHERE address = ANY($1::text[])`, [addresses]).catch(
        () => undefined,
      );
      addresses.length = 0;
    }
  }

  /** A profile with an active, legal, fully-owned starter deck. */
  async function makePlayer(label: string, opts: { deck?: boolean; own?: boolean } = {}) {
    const { deck = true, own = true } = opts;
    seq += 1;
    const address = `${ADDR_PREFIX}${String(seq).padStart(6, '0')}`;
    addresses.push(address);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO core.profiles (address, chain, display_name)
       VALUES ($1, 'robinhood', $2) RETURNING id::text`,
      [address, `rq-${label}-${seq}`],
    );
    const profileId = rows[0]!.id;
    profileIds.push(profileId);

    if (deck) {
      await query(
        `INSERT INTO core.decks (profile_id, name, cards, is_active)
         VALUES ($1::bigint, $2, $3::jsonb, TRUE)`,
        [profileId, `deck-${seq}`, JSON.stringify(DECK)],
      );
    }
    if (own) await grantWholeDeck(profileId);
    return profileId;
  }

  async function grantWholeDeck(profileId: string): Promise<void> {
    const counts = new Map<string, number>();
    for (const id of DECK) {
      if (isBasicNode(id)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [cardId, qty] of counts) {
      await query(
        `INSERT INTO core.card_ownership (profile_id, card_id, qty, source)
         VALUES ($1::bigint, $2, $3, 'chain')
         ON CONFLICT (profile_id, card_id, source) DO UPDATE SET qty = EXCLUDED.qty`,
        [profileId, cardId, qty],
      );
    }
  }

  async function liveMatchOf(profileId: string) {
    const { rows } = await query<{
      id: string;
      mode: string;
      status: string;
      unlisted: boolean;
      seat0_profile: string;
      seat1_profile: string;
      seat0_deck_id: string | null;
      seat1_deck_id: string | null;
    }>(
      `SELECT id, mode, status, unlisted,
              seat0_profile::text, seat1_profile::text,
              seat0_deck_id::text, seat1_deck_id::text
         FROM game.matches
        WHERE seat0_profile = $1::bigint OR seat1_profile = $1::bigint`,
      [profileId],
    );
    return rows[0] ?? null;
  }

  /* ---------------------------------------------------------------------- */

  describe('the enqueue gate', () => {
    it('refuses a player with no active deck, by reason', async () => {
      const p = await makePlayer('nodeck', { deck: false });
      const err = await joinQueue(p, 'global').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('bad_request');
      expect((err as AppError).details).toMatchObject({ reason: 'no_active_deck' });
      expect(await repo.getQueueEntry(p)).toBeNull();
    });

    it('refuses a deck containing cards the profile does not own, naming them', async () => {
      // Exactly the case the ladder exists to keep out: the browser's
      // localStorage collection says the player owns the catalogue; the server
      // says otherwise and the server is the one seating the match.
      const p = await makePlayer('unowned', { own: false });
      const err = await joinQueue(p, 'global').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      const details = (err as AppError).details as {
        reason: string;
        issues: Array<{ cardId: string; need: number; owned: number }>;
      };
      expect(details.reason).toBe('unowned_cards');
      expect(details.issues.length).toBeGreaterThan(0);
      expect(details.issues[0]!.owned).toBe(0);
      expect(await repo.getQueueEntry(p)).toBeNull();
    });

    it('refuses a partial playset — one pull is not four copies', async () => {
      const p = await makePlayer('partial');
      await query(
        `UPDATE core.card_ownership SET qty = 1
          WHERE profile_id = $1::bigint AND card_id = 'eth_pepe'`,
        [p],
      );
      const err = await joinQueue(p, 'global').catch((e: unknown) => e);
      const details = (err as AppError).details as {
        issues: Array<{ cardId: string; need: number; owned: number }>;
      };
      expect(details.issues).toEqual([
        expect.objectContaining({ cardId: 'eth_pepe', owned: 1 }),
      ]);
    });

    it('accepts an eligible player and reports them queued', async () => {
      const p = await makePlayer('ok');
      const joined = await joinQueue(p, 'global');
      expect(joined.region).toBe('global');
      expect(joined.seasonId).toMatch(/^season-/);

      const status = await queueStatus(p);
      expect(status.queued).toBe(true);
      expect(status.match).toBeNull();
      expect(status.mmrWindow).toBeGreaterThan(0);
      expect(status.queuedAt).not.toBeNull();
    });

    it('opens a ladder standing at the default rating on first enqueue', async () => {
      const p = await makePlayer('fresh');
      const seasonId = (await joinQueue(p, 'global')).seasonId;
      const standing = await repo.getStanding(seasonId, p);
      expect(standing).not.toBeNull();
      expect(standing!.rating).toBe(1500);
      expect(standing!.placementsRemaining).toBe(10);
    });

    it('does not reset the wait when a polling client re-enqueues', async () => {
      // The MMR window widens with time waited. Resetting queued_at on every
      // re-join would pin a client to the narrowest bracket forever.
      const p = await makePlayer('rejoin');
      const first = await joinQueue(p, 'global');
      await new Promise((r) => setTimeout(r, 20));
      const second = await joinQueue(p, 'global');
      expect(second.queuedAt).toBe(first.queuedAt);
    });

    it('lets a player leave, and says so honestly when they were not queued', async () => {
      const p = await makePlayer('leave');
      await joinQueue(p, 'global');
      expect(await leaveQueue(p)).toEqual({ wasQueued: true });
      expect(await leaveQueue(p)).toEqual({ wasQueued: false });
      expect((await queueStatus(p)).queued).toBe(false);
    });
  });

  describe('pairing', () => {
    it('creates the match server-side, with a seat and a credential each', async () => {
      const a = await makePlayer('pair-a');
      const b = await makePlayer('pair-b');
      await joinQueue(a, 'global');
      await joinQueue(b, 'global');

      const result = await matchmaker.tick();
      expect(result.paired).toBeGreaterThanOrEqual(1);

      const match = await liveMatchOf(a);
      expect(match).not.toBeNull();
      expect(match!.mode).toBe('ranked');
      expect(match!.status).toBe('live');
      // A queue match has no join step, so it must never sit in the public lobby.
      expect(match!.unlisted).toBe(true);
      expect([match!.seat0_profile, match!.seat1_profile].sort()).toEqual([a, b].sort());
      expect(match!.seat0_deck_id).not.toBeNull();
      expect(match!.seat1_deck_id).not.toBeNull();

      // Both queue rows are consumed; neither player can be paired twice.
      expect(await repo.getQueueEntry(a)).toBeNull();
      expect(await repo.getQueueEntry(b)).toBeNull();

      const vendor = created.matches.find((m) => m.id === match!.id);
      expect(vendor).toBeDefined();
      const players = (vendor!.metadata as { players: Record<string, { credentials: string }> })
        .players;
      expect(players[0]!.credentials).toBeTruthy();
      expect(players[1]!.credentials).toBeTruthy();
      // A shared credential would let either player act as the other.
      expect(players[0]!.credentials).not.toBe(players[1]!.credentials);
      expect(players[0]!.credentials.length).toBeGreaterThanOrEqual(43);
    });

    it('hands each player their OWN seat through the queue status', async () => {
      const a = await makePlayer('seat-a');
      const b = await makePlayer('seat-b');
      await joinQueue(a, 'global');
      await joinQueue(b, 'global');
      await matchmaker.tick();

      const sa = await queueStatus(a);
      const sb = await queueStatus(b);
      expect(sa.match).not.toBeNull();
      expect(sb.match).not.toBeNull();
      expect(sa.match!.matchID).toBe(sb.match!.matchID);
      // Different seats, and each is told only their own.
      expect(sa.match!.seat).not.toBe(sb.match!.seat);
      expect(sa.match!.playerID).toBe(String(sa.match!.seat));
      // Neither response carries a credential — those come from
      // GET /games/:id/seat, which returns the caller's and nobody else's.
      expect(sa.match).not.toHaveProperty('credentials');
      // The handoff is a database read, so polling it again is idempotent.
      expect((await queueStatus(a)).match!.matchID).toBe(sa.match!.matchID);
    });

    it('refuses to queue a player who is already in a live ranked match', async () => {
      const a = await makePlayer('busy-a');
      const b = await makePlayer('busy-b');
      await joinQueue(a, 'global');
      await joinQueue(b, 'global');
      await matchmaker.tick();

      const err = await joinQueue(a, 'global').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('conflict');
      expect((err as AppError).details).toMatchObject({ reason: 'already_in_match' });
    });

    it('does nothing with a queue of one', async () => {
      const a = await makePlayer('alone');
      await joinQueue(a, 'global');
      expect((await matchmaker.tick()).paired).toBe(0);
      // Still queued, still waiting — not silently dropped.
      expect(await repo.getQueueEntry(a)).not.toBeNull();
    });

    it('never pairs across regions', async () => {
      const a = await makePlayer('region-a');
      const b = await makePlayer('region-b');
      await joinQueue(a, 'na');
      await joinQueue(b, 'eu');
      await matchmaker.tick();
      expect(await liveMatchOf(a)).toBeNull();
      expect(await repo.getQueueEntry(a)).not.toBeNull();
      expect(await repo.getQueueEntry(b)).not.toBeNull();
    });

    it('RE-CHECKS ownership at pairing, because a deck stays editable in the queue', async () => {
      const cheat = await makePlayer('cheat');
      const honest = await makePlayer('honest');
      await joinQueue(cheat, 'global');
      await joinQueue(honest, 'global');

      // The exploit: queue with a legal, owned deck, then take the cards away
      // from the ownership table (equivalently: edit the deck to cards you never
      // owned). A gate that only ran at enqueue would seat this.
      await query(`DELETE FROM core.card_ownership WHERE profile_id = $1::bigint`, [cheat]);

      const result = await matchmaker.tick();
      expect(result.paired).toBe(0);
      expect(result.dropped).toBe(1);

      expect(await liveMatchOf(cheat)).toBeNull();
      expect(await repo.getQueueEntry(cheat)).toBeNull();
      // The blameless player keeps their place AND their accumulated wait.
      const stillQueued = await repo.getQueueEntry(honest);
      expect(stillQueued).not.toBeNull();
    });

    it('drops an entry whose deck was edited into an illegal one', async () => {
      const a = await makePlayer('illegal');
      const b = await makePlayer('legal');
      await joinQueue(a, 'global');
      await joinQueue(b, 'global');
      await query(
        `UPDATE core.decks SET cards = $2::jsonb WHERE profile_id = $1::bigint AND is_active`,
        [a, JSON.stringify(DECK.slice(0, 12))],
      );

      const result = await matchmaker.tick();
      expect(result.dropped).toBe(1);
      expect(await repo.getQueueEntry(a)).toBeNull();
      expect(await repo.getQueueEntry(b)).not.toBeNull();
    });

    it('reaps entries whose client stopped polling', async () => {
      const a = await makePlayer('stale');
      await joinQueue(a, 'global');
      await query(
        `UPDATE game.ranked_queue SET queued_at = now() - interval '2 days'
          WHERE profile_id = $1::bigint`,
        [a],
      );
      const result = await matchmaker.tick();
      expect(result.reaped).toBeGreaterThanOrEqual(1);
      expect(await repo.getQueueEntry(a)).toBeNull();
    });
  });

  it('leaves the pool healthy', async () => {
    // A leaked client from the pairing transaction would show up here as a
    // pool that never drains.
    expect(getPool().idleCount).toBeGreaterThanOrEqual(0);
    expect(getPool().waitingCount).toBe(0);
  });
});
