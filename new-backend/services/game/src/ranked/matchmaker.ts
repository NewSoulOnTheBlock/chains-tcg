/**
 * The pairer, ported from `src/ranked/matchmaker.ts`.
 *
 * ── What it does that the legacy one did not ───────────────────────────────
 * The legacy pairer called boardgame.io's LOBBY CLIENT over HTTP
 * (`new LobbyClient({ server }).createMatch(...)`) and, when that failed,
 * fabricated a synthetic match id and carried on — producing a "pairing" that
 * pointed at no match anywhere. It then handed the pair to an in-process Map for
 * the players to poll. Nothing was written to a database, so nothing survived a
 * restart, and nothing was visible to a second container.
 *
 * Here the pairer creates the match itself, the same way `POST /games/:id/join`
 * does:
 *
 *   1. claim two queue rows under `FOR UPDATE SKIP LOCKED`;
 *   2. re-read both decks from `core.decks` AS THEY STAND NOW and re-run the
 *      full legality + ownership gate on each;
 *   3. insert the `game.matches` row already `live`, with both seats and both
 *      deck ids;
 *   4. mint a separate credential per seat with `mintCredentials()` and write
 *      the boardgame.io match — all inside the one transaction.
 *
 * Neither player is told anything by this code. Each discovers their own match
 * through `GET /games/ranked/queue`, and collects their own seat and credentials
 * through the existing `GET /games/:id/seat`, which returns the CALLER'S seat
 * and nobody else's. The client never proposes a seat, a deck or a credential,
 * and never learns the opponent's.
 *
 * ── Concurrency ───────────────────────────────────────────────────────────
 * `SKIP LOCKED` is what makes N game containers safe to run: a queue row another
 * container is already pairing is invisible to this one. The queue's primary key
 * on `profile_id` is what makes the same player unable to appear twice.
 */
import { randomUUID } from 'node:crypto';
import { createLogger, withTransaction } from '@chains/shared';
import { config } from '../config.js';
import { store } from '../bgio/store.js';
import { createMatch } from '../bgio/vendor.js';
import { validateDeck } from '../game/cards.js';
import { ChainsTCG } from '../game/Game.js';
import { buildSetupData, findUnownedCards, mintCredentials } from '../lib/seating.js';
import * as repo from '../repo/ranked.repo.js';
import { mmrWindowFor } from './queue.js';
import { ensureActiveSeason } from './season.js';

const log = createLogger({ service: 'game' }).child({ component: 'ranked-matchmaker' });

/** Ceiling on pairs formed per region per tick, so one pass cannot run long. */
const MAX_PAIRS_PER_REGION_PER_TICK = 20;

type PairOutcome = 'paired' | 'none' | 'dropped';

/**
 * Try to form one match in `region`.
 *
 * Returns 'none' when there is nothing to do, 'dropped' when a claimed entry
 * turned out to be unseatable (it is removed and the other player is put back
 * with their original wait intact), and 'paired' on success.
 */
async function pairOnce(region: string): Promise<PairOutcome> {
  const matchId = randomUUID();
  const credentials = { seat0: mintCredentials(), seat1: mintCredentials() };
  // Set only once boardgame.io's own row exists, so the compensating wipe below
  // can never touch a match this pass did not create. Same shape as the join
  // path in routes/lobby.ts, and for the same reason: boardgame.io's storage is
  // a different connection and is not covered by the ROLLBACK.
  let vendorMatchWritten = false;

  try {
    return await withTransaction(async (c): Promise<PairOutcome> => {
      const seed = await repo.claimSeed(c, region);
      if (!seed) return 'none';

      const window = mmrWindowFor(seed.queuedAt);
      const opponent = await repo.claimOpponent(
        c,
        region,
        seed.profileId,
        seed.rating,
        window,
      );
      // Nobody in range yet. Committing releases the seed's lock so another
      // container — or the next tick, with a wider window — can try it.
      if (!opponent) return 'none';

      const seats = await Promise.all([
        repo.loadQueuedSeat(c, seed.profileId, seed.deckId),
        repo.loadQueuedSeat(c, opponent.profileId, opponent.deckId),
      ]);

      // Re-validate BOTH, against the deck rows as they stand right now. A deck
      // that was legal at enqueue can have been edited since — `core.decks.cards`
      // is writable from the profile service the whole time its owner sits in
      // the queue. Checking only at enqueue would make "queue with a legal deck,
      // then edit it to the full catalogue" a working exploit, which is the same
      // hole the lobby closes for seat 0 on the join path.
      const verdicts = await Promise.all(
        [seed, opponent].map(async (entry, i) => {
          const seat = seats[i];
          if (!seat) return { entry, ok: false, why: 'deck_missing' };
          const legality = validateDeck(seat.cards, { requireSize: true });
          if (!legality.ok) return { entry, ok: false, why: 'deck_illegal' };
          const unowned = await findUnownedCards(entry.profileId, seat.cards, c);
          if (unowned.length > 0) return { entry, ok: false, why: 'unowned_cards' };
          return { entry, ok: true, why: '' };
        }),
      );

      // Both rows leave the queue either way — an entry we have decided is
      // unseatable must not be picked up again on the next tick.
      await repo.deleteQueued(c, [seed.profileId, opponent.profileId]);

      const bad = verdicts.filter((v) => !v.ok);
      if (bad.length > 0) {
        for (const v of verdicts) {
          if (v.ok) {
            // The blameless player keeps their place, original wait and all.
            await repo.requeue(c, v.entry);
          } else {
            log.warn('dropped a queue entry that is no longer seatable', {
              profileId: v.entry.profileId,
              region,
              reason: v.why,
            });
          }
        }
        return 'dropped';
      }

      const seedSeat = seats[0];
      const oppSeat = seats[1];
      if (!seedSeat || !oppSeat) return 'dropped';

      // ── Seat assignment is a coin flip ────────────────────────────────
      // Seat 0 takes the first turn. The legacy pairer gave seat 0 to whoever
      // had waited longer, which turns queue position into a systematic
      // in-game advantage — on a ladder with a prize, a measurable one, and one
      // a player can farm by timing when they press queue.
      const flip = Math.random() < 0.5;
      const seat0 = flip ? seedSeat : oppSeat;
      const seat1 = flip ? oppSeat : seedSeat;

      const setupData = buildSetupData(
        {
          names: [seat0.displayName, seat1.displayName],
          decks: [seat0.cards, seat1.cards],
        },
        'ranked',
        { amountBase: null, wagerId: null },
      );

      const built = createMatch({
        game: ChainsTCG,
        numPlayers: 2,
        setupData,
        // Never surfaced by boardgame.io's own listing either — belt and braces
        // on top of its lobby API not being mounted at all.
        unlisted: true,
      });
      if ('setupDataError' in built) {
        log.error('ranked setupData rejected by the rules module', {
          error: built.setupDataError,
        });
        // Both entries have already been deleted; put them back so the players
        // are not silently dropped for a server-side fault.
        await repo.requeue(c, seed);
        await repo.requeue(c, opponent);
        return 'dropped';
      }

      built.metadata.players[0] = {
        id: 0,
        name: seat0.displayName,
        credentials: credentials.seat0,
      };
      built.metadata.players[1] = {
        id: 1,
        name: seat1.displayName,
        credentials: credentials.seat1,
      };

      await repo.insertLiveRankedMatch(c, {
        id: matchId,
        seat0Profile: seat0.profileId,
        seat1Profile: seat1.profileId,
        seat0DeckId: seat0.deckId,
        seat1DeckId: seat1.deckId,
      });

      await store.createMatch(matchId, {
        initialState: built.initialState,
        metadata: built.metadata,
      });
      vendorMatchWritten = true;

      log.info('ranked pairing', {
        matchID: matchId,
        region,
        seat0Profile: seat0.profileId,
        seat1Profile: seat1.profileId,
        ratingGap: Math.abs(seed.rating - opponent.rating),
        window,
        seat0WaitMs: Date.now() - (flip ? seed : opponent).queuedAt.getTime(),
        seat1WaitMs: Date.now() - (flip ? opponent : seed).queuedAt.getTime(),
      });
      return 'paired';
    });
  } catch (err) {
    if (vendorMatchWritten) {
      await store.wipe(matchId).catch((e: unknown) => {
        log.error('failed to wipe orphaned boardgame.io match', {
          matchID: matchId,
          err: String(e),
        });
      });
    }
    throw err;
  }
}

export class RankedMatchmaker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  start(): void {
    if (!config.RANKED_ENABLED) {
      log.info('ranked matchmaker not started (RANKED_ENABLED=false)');
      return;
    }
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped || this.running) return;
      this.running = true;
      try {
        await this.tick();
      } catch (err) {
        log.error('ranked matchmaker tick failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), config.RANKED_MATCHMAKER_INTERVAL_MS);
    this.timer.unref();
    void tick();
    log.info('ranked matchmaker started', {
      intervalMs: config.RANKED_MATCHMAKER_INTERVAL_MS,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Let an in-flight pass finish rather than abandoning a half-built pairing.
    for (let i = 0; i < 100 && this.running; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** One pass. Exposed so a test can drive it without a timer. */
  async tick(): Promise<{ paired: number; dropped: number; reaped: number }> {
    // A season must exist before anyone can be seated into one, and the first
    // tick after boot is the cheapest place to guarantee it.
    await ensureActiveSeason();

    const reaped = await repo.reapStaleQueue(config.RANKED_QUEUE_STALE_MS);
    if (reaped > 0) log.info('reaped stale ranked queue entries', { count: reaped });

    let paired = 0;
    let dropped = 0;
    // Regions come from the queue itself: no regions table, and an empty queue
    // means an empty loop rather than four pointless scans.
    for (const region of await repo.listQueueRegions()) {
      for (let i = 0; i < MAX_PAIRS_PER_REGION_PER_TICK; i += 1) {
        const outcome = await pairOnce(region);
        if (outcome === 'none') break;
        if (outcome === 'paired') paired += 1;
        else dropped += 1;
      }
    }
    return { paired, dropped, reaped };
  }
}

export const rankedMatchmaker = new RankedMatchmaker();
