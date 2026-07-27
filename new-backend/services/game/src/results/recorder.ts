import { withTransaction, isForeignKeyViolation, createLogger } from '@chains/shared';
import { config } from '../config.js';
import { store } from '../bgio/store.js';
import { ChainsTCG } from '../game/Game.js';
import { invalidateLeaderboard } from '../lib/cache.js';
import { applyRankedResult } from '../ranked/apply-result.js';
import { isResultReason, signResult, type ResultReason, type SignedResult } from './sign.js';

const log = createLogger({ service: 'game' }).child({ component: 'result-recorder' });

/** boardgame.io's key for our rules module. */
const GAME_NAME = ChainsTCG.name ?? 'chains-tcg';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * AUTHORITATIVE MATCH RESULTS (audit C-1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There is NO HTTP route in this service — or in the profile service — that
 * accepts a winner. Match outcomes are produced here and only here, by reading
 * boardgame.io's own stored state.
 *
 * WHY A SWEEPER AND NOT `Game.onEnd`
 * ----------------------------------
 * boardgame.io's `onEnd` is part of the *game object*, i.e. part of the
 * reducer. The reducer runs in the browser too (that is how optimistic updates
 * work), so it is not a server trust boundary and it cannot be given a database
 * handle. It is also synchronous, and its return value replaces `G`.
 *
 * A sweeper over finished matches is the robust choice:
 *   • it is server-only by construction;
 *   • it survives a crash mid-write — the next pass re-reads the same finished
 *     match and finishes the job;
 *   • it catches matches that ended while this process was down (the first
 *     pass after boot has no cursor and scans everything);
 *   • it is naturally idempotent against `game.match_results`' primary key.
 *
 * WHY THE ROW CANNOT BE FORGED
 * ----------------------------
 *   1. `ctx.gameover` is written by the boardgame.io Master, in this process,
 *      by re-running the reducer over server-held state. A client can only emit
 *      `update(action, stateID, matchID, playerID)` on the socket; the master
 *      authenticates the seat's credentials, re-executes the move against its
 *      own copy of `G`, and discards anything illegal. No client message can
 *      set `ctx.gameover` directly.
 *   2. The reason likewise comes from server-executed reducer code
 *      (`G.endReason`); `concede` can only concede your own seat and
 *      `claimTimeout` is gated on server-held `G.turnDeadline`.
 *   3. Every row carries `server_sig` = HMAC-SHA256 over
 *      `(match_id, winner_seat, reason, finished_at)` under
 *      `MATCH_RESULT_HMAC_SECRET`. The wager service settles only from rows
 *      whose HMAC verifies, so even an actor who obtained a database
 *      connection cannot mint a payable result without the secret.
 *   4. `match_id` is the primary key, so a replayed write is a no-op.
 */

interface Gameover {
  winner?: unknown;
  draw?: unknown;
  reason?: unknown;
}

function parseGameover(raw: unknown): { winnerSeat: 0 | 1 | null; reason: ResultReason } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const g = raw as Gameover;
  const reason: ResultReason = isResultReason(g.reason) ? g.reason : 'life';

  if (g.draw === true) return { winnerSeat: null, reason };

  const winner = typeof g.winner === 'string' ? Number(g.winner) : Number(g.winner);
  if (winner === 0 || winner === 1) return { winnerSeat: winner, reason };

  // Gameover with neither a draw flag nor a seat we recognise: refuse to
  // invent an outcome. Logged and retried; an operator can void the match.
  return null;
}

export interface RecordOutcome {
  status: 'recorded' | 'duplicate' | 'skipped';
  matchId: string;
}

/** Write one finished match's result, exactly once. */
export async function recordFinishedMatch(matchId: string): Promise<RecordOutcome> {
  const fetched = await store.fetch(matchId, { state: true, metadata: true });
  const state = fetched.state;
  const metadata = fetched.metadata;
  if (!state || !metadata) return { status: 'skipped', matchId };

  // Prefer the live state's ctx (the master's own reducer output); fall back to
  // the copy the master mirrors into metadata.
  const parsed = parseGameover(state.ctx?.gameover ?? metadata.gameover);
  if (!parsed) {
    log.warn('finished match has an unusable gameover — not recording', { matchId });
    return { status: 'skipped', matchId };
  }

  const finishedAt = new Date(metadata.updatedAt ?? Date.now());
  const signed: SignedResult = {
    matchId,
    winnerSeat: parsed.winnerSeat,
    reason: parsed.reason,
    finishedAt,
  };
  const serverSig = signResult(signed);

  let recorded = false;
  try {
    recorded = await withTransaction(async (c) => {
      // Lock the lobby row so the win/loss increments, the status flip and the
      // ranked rating update are serialised against any concurrent sweeper or
      // join.
      //
      // `mode` is selected here for the ranked gate below. It is read from the
      // row this statement holds a lock on, so between the check and the rating
      // write it cannot change — the same reasoning that makes `match.mode`
      // trustworthy on the join path in routes/lobby.ts, and the reason no
      // request body anywhere is allowed to name a mode for an existing match.
      const { rows } = await c.query<{
        mode: string;
        seat0_profile: string | null;
        seat1_profile: string | null;
        status: string;
      }>(
        `SELECT mode, seat0_profile::text, seat1_profile::text, status
           FROM game.matches WHERE id = $1 FOR UPDATE`,
        [matchId],
      );
      const match = rows[0];
      if (!match) {
        // A boardgame.io match with no lobby row: not ours. (Cannot happen via
        // our own create/join path — the FK below would reject it anyway.)
        log.warn('finished boardgame.io match has no game.matches row', { matchId });
        return false;
      }

      const insert = await c.query(
        `INSERT INTO game.match_results (match_id, winner_seat, reason, finished_at, server_sig)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (match_id) DO NOTHING`,
        [matchId, parsed.winnerSeat, parsed.reason, finishedAt.toISOString(), serverSig],
      );
      if ((insert.rowCount ?? 0) === 0) return false; // already recorded — no-op

      await c.query(
        `UPDATE game.matches SET status = 'finished', updated_at = now() WHERE id = $1`,
        [matchId],
      );

      // Win/loss counters move in the SAME transaction as the result row, so
      // the leaderboard can never disagree with match history.
      if (parsed.winnerSeat !== null) {
        const winnerId = parsed.winnerSeat === 0 ? match.seat0_profile : match.seat1_profile;
        const loserId = parsed.winnerSeat === 0 ? match.seat1_profile : match.seat0_profile;
        if (winnerId !== null) {
          await c.query(`UPDATE core.profiles SET wins = wins + 1 WHERE id = $1`, [winnerId]);
        }
        if (loserId !== null) {
          await c.query(`UPDATE core.profiles SET losses = losses + 1 WHERE id = $1`, [loserId]);
        }
      }
      // Draws touch neither counter: `core.profiles` has no `draws` column
      // (see ARCHITECTURE.md). Draws are still visible in match history.

      // ── The ranked ladder ─────────────────────────────────────────────
      // Same transaction, same client, immediately after the INSERT above
      // reported a row. That `rowCount > 0` is exactly "this result is being
      // recorded for the first time", so the rating update inherits the
      // exactly-once property from the primary key rather than implementing a
      // second, weaker version of it — which is what the legacy service did,
      // across three separate transactions, with a window in which a crash lost
      // a rated match permanently.
      //
      // `mode` decides. A casual or wager match reaches this line and returns
      // without touching a rating table. Nothing here is reachable from an HTTP
      // route: there is no request shape in this backend that names a winner.
      await applyRankedResult(c, {
        matchId,
        mode: match.mode,
        seat0Profile: match.seat0_profile,
        seat1Profile: match.seat1_profile,
        winnerSeat: parsed.winnerSeat,
        reason: parsed.reason,
        // The instant that was HMAC-signed into server_sig, not `now()` — so
        // the season this match is rated into is decided by when the match
        // ACTUALLY ended, not by when the sweeper happened to notice.
        finishedAt,
      });

      return true;
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      log.warn('result FK violation — boardgame.io match not in game.matches', { matchId });
      return { status: 'skipped', matchId };
    }
    throw err;
  }

  if (!recorded) return { status: 'duplicate', matchId };

  await invalidateLeaderboard();
  log.info('match result recorded', {
    matchId,
    winnerSeat: parsed.winnerSeat,
    reason: parsed.reason,
    finishedAt: finishedAt.toISOString(),
  });
  return { status: 'recorded', matchId };
}

/**
 * Background sweeper. One pass lists boardgame.io matches whose `gameover` is
 * set and hands each to `recordFinishedMatch`.
 */
export class ResultRecorder {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** ms since epoch; 0 means "scan everything" (first pass after boot). */
  private cursor = 0;

  start(): void {
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped || this.running) return;
      this.running = true;
      try {
        await this.sweep();
      } catch (err) {
        log.error('result sweep failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), config.RESULT_POLL_INTERVAL_MS);
    this.timer.unref();
    void tick();
    log.info('result recorder started', { intervalMs: config.RESULT_POLL_INTERVAL_MS });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Let an in-flight pass finish so we never abandon a half-written sweep.
    for (let i = 0; i < 100 && this.running; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async sweep(): Promise<{ scanned: number; recorded: number }> {
    const passStartedAt = Date.now();
    const opts: {
      gameName: string;
      where: { isGameover: true; updatedAfter?: number };
    } = { gameName: GAME_NAME, where: { isGameover: true } };
    if (this.cursor > 0) {
      opts.where.updatedAfter = this.cursor - config.RESULT_POLL_OVERLAP_MS;
    }

    const matchIds = await store.listMatches(opts);
    let recorded = 0;
    for (const id of matchIds) {
      const outcome = await recordFinishedMatch(id);
      if (outcome.status === 'recorded') recorded += 1;
    }
    // Only advance once the pass completed; a throw above leaves the cursor
    // where it was and the next pass re-covers the same window.
    this.cursor = passStartedAt;
    if (recorded > 0) log.info('result sweep', { scanned: matchIds.length, recorded });
    return { scanned: matchIds.length, recorded };
  }
}

export const resultRecorder = new ResultRecorder();
