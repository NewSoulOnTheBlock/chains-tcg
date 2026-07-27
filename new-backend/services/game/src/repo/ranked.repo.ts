/**
 * Every SQL statement the ladder issues, in one file.
 *
 * The legacy `src/ranked/db.ts` did the same job in 390 lines, but half of it
 * was an in-memory `Map` fallback for "dev without DATABASE_URL". That fallback
 * is audit finding H-3 in miniature — the idempotency guard on match results
 * became `mem.outcomes.has(id)`, which is per-process, so two containers would
 * both record the same match and rate it twice. There is no fallback here. If
 * Postgres is unreachable the service fails `/readyz` and is replaced.
 *
 * Every id crossing this boundary is a STRING. `profile_id` and `deck_id` are
 * bigserials; `pg` hands bigints back as strings to avoid silently rounding past
 * 2^53, and nothing here narrows them to `number`.
 */
import { query, queryOne, type PoolClient } from '@chains/shared';
import type { Division } from '../ranked/ranks.js';
import type { Standing } from '../ranked/rating.js';

/* -------------------------------------------------------------------------- */
/* Seasons                                                                    */
/* -------------------------------------------------------------------------- */

export interface SeasonRow {
  id: string;
  name: string;
  startedAt: Date;
  endsAt: Date;
  active: boolean;
  softResetFactor: number;
  rewardDefinitions: unknown;
  balancePatch: string | null;
}

interface RawSeason {
  id: string;
  name: string;
  started_at: Date;
  ends_at: Date;
  active: boolean;
  soft_reset_factor: number;
  reward_definitions: unknown;
  balance_patch: string | null;
}

const SEASON_COLS = `id, name, started_at, ends_at, active, soft_reset_factor,
                     reward_definitions, balance_patch`;

function toSeason(r: RawSeason): SeasonRow {
  return {
    id: r.id,
    name: r.name,
    startedAt: r.started_at,
    endsAt: r.ends_at,
    active: r.active,
    softResetFactor: Number(r.soft_reset_factor),
    rewardDefinitions: r.reward_definitions ?? null,
    balancePatch: r.balance_patch,
  };
}

export async function getActiveSeason(c?: PoolClient): Promise<SeasonRow | null> {
  const text = `SELECT ${SEASON_COLS} FROM game.ranked_seasons WHERE active LIMIT 1`;
  const rows = c ? (await c.query<RawSeason>(text)).rows : (await query<RawSeason>(text)).rows;
  return rows[0] ? toSeason(rows[0]) : null;
}

/**
 * The season that CONTAINED an instant.
 *
 * Result recording resolves the season this way rather than reading whichever
 * season is active when the sweeper happens to run. The last matches of a season
 * are, by definition, recorded around the moment it rolls over; pinning them to
 * the season they were played in is both correct and deterministic, and it means
 * a rollover racing a result cannot move somebody's final game into next season.
 */
export async function getSeasonAt(at: Date, c?: PoolClient): Promise<SeasonRow | null> {
  const text = `SELECT ${SEASON_COLS} FROM game.ranked_seasons
                 WHERE started_at <= $1 AND ends_at > $1
                 ORDER BY started_at DESC LIMIT 1`;
  const params = [at];
  const rows = c
    ? (await c.query<RawSeason>(text, params)).rows
    : (await query<RawSeason>(text, params)).rows;
  return rows[0] ? toSeason(rows[0]) : null;
}

export async function getSeason(id: string, c?: PoolClient): Promise<SeasonRow | null> {
  const text = `SELECT ${SEASON_COLS} FROM game.ranked_seasons WHERE id = $1`;
  const rows = c
    ? (await c.query<RawSeason>(text, [id])).rows
    : (await query<RawSeason>(text, [id])).rows;
  return rows[0] ? toSeason(rows[0]) : null;
}

export interface NewSeason {
  id: string;
  name: string;
  startedAt: Date;
  endsAt: Date;
  softResetFactor: number;
  rewardDefinitions: unknown;
}

/**
 * Insert a season and make it the active one, in one statement pair.
 *
 * The caller runs this inside a transaction that has already deactivated the
 * previous season. `ranked_seasons_one_active` then does the rest: a second
 * container attempting the same rollover gets a 23505 instead of a second
 * active season, and retries by re-reading.
 */
export async function insertActiveSeason(c: PoolClient, s: NewSeason): Promise<SeasonRow | null> {
  const { rows } = await c.query<RawSeason>(
    `INSERT INTO game.ranked_seasons
       (id, name, started_at, ends_at, active, soft_reset_factor, reward_definitions)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING ${SEASON_COLS}`,
    [s.id, s.name, s.startedAt, s.endsAt, s.softResetFactor, JSON.stringify(s.rewardDefinitions)],
  );
  return rows[0] ? toSeason(rows[0]) : null;
}

/** Lock the active season row so exactly one container performs a rollover. */
export async function lockActiveSeason(c: PoolClient): Promise<SeasonRow | null> {
  const { rows } = await c.query<RawSeason>(
    `SELECT ${SEASON_COLS} FROM game.ranked_seasons WHERE active FOR UPDATE`,
  );
  return rows[0] ? toSeason(rows[0]) : null;
}

export async function deactivateSeason(c: PoolClient, id: string): Promise<void> {
  await c.query(`UPDATE game.ranked_seasons SET active = FALSE WHERE id = $1`, [id]);
}

/* -------------------------------------------------------------------------- */
/* Ladder standings                                                           */
/* -------------------------------------------------------------------------- */

export interface StandingRow extends Standing {
  seasonId: string;
  profileId: string;
  ladderOrdinal: number;
  smurfFlagged: boolean;
  smurfReasons: string[];
  updatedAt: Date;
}

interface RawStanding {
  season_id: string;
  profile_id: string;
  rating: number;
  rating_deviation: number;
  volatility: number;
  tier: number;
  division: number;
  lp: number;
  wins: number;
  losses: number;
  draws: number;
  placements_remaining: number;
  smurf_flagged: boolean;
  smurf_reasons: unknown;
  ladder_ordinal: number;
  updated_at: Date;
}

const STANDING_COLS = `season_id, profile_id::text, rating, rating_deviation, volatility,
                       tier, division, lp, wins, losses, draws, placements_remaining,
                       smurf_flagged, smurf_reasons, ladder_ordinal, updated_at`;

function toStanding(r: RawStanding): StandingRow {
  return {
    seasonId: r.season_id,
    profileId: r.profile_id,
    rating: Number(r.rating),
    ratingDeviation: Number(r.rating_deviation),
    volatility: Number(r.volatility),
    tier: Number(r.tier),
    division: Number(r.division) as Division,
    lp: Number(r.lp),
    wins: Number(r.wins),
    losses: Number(r.losses),
    draws: Number(r.draws),
    placementsRemaining: Number(r.placements_remaining),
    smurfFlagged: r.smurf_flagged,
    smurfReasons: Array.isArray(r.smurf_reasons) ? (r.smurf_reasons as unknown[]).map(String) : [],
    ladderOrdinal: Number(r.ladder_ordinal),
    updatedAt: r.updated_at,
  };
}

/**
 * Create this season's standing for a profile if it does not exist yet, seeded
 * by the SOFT RESET of their most recent previous season.
 *
 * The seeding expression is the migration's documented formula and mirrors
 * `softReset()` in ranked/rating.ts; a test asserts the two agree. Doing it as
 * the INSERT's SELECT rather than as read-modify-write means two concurrent
 * result transactions for the same player cannot both decide they are the one
 * creating the row — `ON CONFLICT DO NOTHING` makes the loser a no-op and the
 * `FOR UPDATE` in `lockStanding` serialises what follows.
 */
export async function ensureStanding(
  c: PoolClient,
  seasonId: string,
  profileId: string,
  placementMatches: number,
): Promise<void> {
  await c.query(
    `INSERT INTO game.ranked_profiles
       (season_id, profile_id, rating, rating_deviation, volatility, placements_remaining)
     SELECT s.id,
            $2::bigint,
            COALESCE(1500 + (prev.rating - 1500) * prev.soft_reset_factor, 1500),
            COALESCE(LEAST(350, prev.rating_deviation + 50), 350),
            COALESCE(prev.volatility, 0.06),
            $3::smallint
       FROM game.ranked_seasons s
       LEFT JOIN LATERAL (
            SELECT rp.rating, rp.rating_deviation, rp.volatility, ps.soft_reset_factor
              FROM game.ranked_profiles rp
              JOIN game.ranked_seasons  ps ON ps.id = rp.season_id
             WHERE rp.profile_id = $2::bigint
               AND ps.started_at < s.started_at
             ORDER BY ps.started_at DESC
             LIMIT 1
       ) prev ON TRUE
      WHERE s.id = $1
     ON CONFLICT (season_id, profile_id) DO NOTHING`,
    [seasonId, profileId, placementMatches],
  );
}

/**
 * Read a standing with a row lock.
 *
 * Callers rating a match MUST lock both seats, in ascending profile id order.
 * Two matches sharing a player can finish at the same instant — nothing stops a
 * profile holding two live ranked matches created through `POST /games/create`
 * — and without the lock both transactions read the same "before" and the
 * second write silently discards the first result's rating change. Ascending
 * order is what makes it a wait rather than a deadlock.
 */
export async function lockStanding(
  c: PoolClient,
  seasonId: string,
  profileId: string,
): Promise<StandingRow | null> {
  const { rows } = await c.query<RawStanding>(
    `SELECT ${STANDING_COLS} FROM game.ranked_profiles
      WHERE season_id = $1 AND profile_id = $2::bigint
      FOR UPDATE`,
    [seasonId, profileId],
  );
  return rows[0] ? toStanding(rows[0]) : null;
}

export async function getStanding(
  seasonId: string,
  profileId: string,
  c?: PoolClient,
): Promise<StandingRow | null> {
  const text = `SELECT ${STANDING_COLS} FROM game.ranked_profiles
                 WHERE season_id = $1 AND profile_id = $2::bigint`;
  const params = [seasonId, profileId];
  const rows = c
    ? (await c.query<RawStanding>(text, params)).rows
    : (await query<RawStanding>(text, params)).rows;
  return rows[0] ? toStanding(rows[0]) : null;
}

export interface StandingWrite extends Standing {
  smurfFlagged: boolean;
  smurfReasons: string[];
}

export async function writeStanding(
  c: PoolClient,
  seasonId: string,
  profileId: string,
  s: StandingWrite,
): Promise<void> {
  await c.query(
    `UPDATE game.ranked_profiles
        SET rating = $3, rating_deviation = $4, volatility = $5,
            tier = $6, division = $7, lp = $8,
            wins = $9, losses = $10, draws = $11,
            placements_remaining = $12,
            smurf_flagged = $13, smurf_reasons = $14::jsonb,
            updated_at = now()
      WHERE season_id = $1 AND profile_id = $2::bigint`,
    [
      seasonId,
      profileId,
      s.rating,
      s.ratingDeviation,
      s.volatility,
      s.tier,
      s.division,
      s.lp,
      s.wins,
      s.losses,
      s.draws,
      s.placementsRemaining,
      s.smurfFlagged,
      JSON.stringify(s.smurfReasons),
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* Leaderboard                                                                */
/* -------------------------------------------------------------------------- */

export interface StandingsEntry {
  rank: number;
  profileId: string;
  displayName: string;
  tier: number;
  division: Division;
  lp: number;
  wins: number;
  losses: number;
  draws: number;
  placementsRemaining: number;
}

/**
 * Season standings, ordered by the VISIBLE ladder.
 *
 * `ladder_ordinal` first, hidden rating only as a tiebreak between two
 * identical visible positions, profile id last so the order is total. Players
 * still in placements are excluded: they have no rank yet, so listing them would
 * mean either publishing a rank the player themselves is not shown, or filling
 * the top of the board with Bronze IV 0 LP rows.
 *
 * `core.profiles.address` is not joined in and never will be (H-2).
 */
export async function topStandings(
  seasonId: string,
  limit: number,
  offset = 0,
): Promise<StandingsEntry[]> {
  const { rows } = await query<{
    profile_id: string;
    display_name: string;
    tier: number;
    division: number;
    lp: number;
    wins: number;
    losses: number;
    draws: number;
    placements_remaining: number;
    rank: string;
  }>(
    `SELECT rp.profile_id::text, p.display_name,
            rp.tier, rp.division, rp.lp, rp.wins, rp.losses, rp.draws,
            rp.placements_remaining,
            (row_number() OVER (ORDER BY rp.ladder_ordinal DESC, rp.rating DESC, rp.profile_id) + $3)::text AS rank
       FROM game.ranked_profiles rp
       JOIN core.profiles p ON p.id = rp.profile_id
      WHERE rp.season_id = $1 AND rp.placements_remaining = 0
      ORDER BY rp.ladder_ordinal DESC, rp.rating DESC, rp.profile_id
      OFFSET $3 LIMIT $2`,
    [seasonId, limit, offset],
  );
  return rows.map((r) => ({
    rank: Number(r.rank),
    profileId: r.profile_id,
    displayName: r.display_name,
    tier: Number(r.tier),
    division: Number(r.division) as Division,
    lp: Number(r.lp),
    wins: Number(r.wins),
    losses: Number(r.losses),
    draws: Number(r.draws),
    placementsRemaining: Number(r.placements_remaining),
  }));
}

/** One player's position on the season board, or null if unranked. */
export async function standingRank(seasonId: string, profileId: string): Promise<number | null> {
  const r = await queryOne<{ rank: string }>(
    `SELECT rank::text FROM (
        SELECT profile_id,
               row_number() OVER (ORDER BY ladder_ordinal DESC, rating DESC, profile_id) AS rank
          FROM game.ranked_profiles
         WHERE season_id = $1 AND placements_remaining = 0
     ) ranked
      WHERE profile_id = $2::bigint`,
    [seasonId, profileId],
  );
  return r ? Number(r.rank) : null;
}

/* -------------------------------------------------------------------------- */
/* Per-match rating audit                                                     */
/* -------------------------------------------------------------------------- */

export interface MatchRatingWrite {
  matchId: string;
  seasonId: string;
  seat0Profile: string;
  seat1Profile: string;
  winnerSeat: 0 | 1 | null;
  reason: string;
  seat0RatingBefore: number;
  seat0RatingAfter: number;
  seat1RatingBefore: number;
  seat1RatingAfter: number;
  seat0LpDelta: number;
  seat1LpDelta: number;
  seat0OrdinalAfter: number;
  seat1OrdinalAfter: number;
}

export async function insertMatchRating(c: PoolClient, w: MatchRatingWrite): Promise<void> {
  await c.query(
    `INSERT INTO game.ranked_match_ratings
       (match_id, season_id, seat0_profile, seat1_profile, winner_seat, reason,
        seat0_rating_before, seat0_rating_after, seat1_rating_before, seat1_rating_after,
        seat0_lp_delta, seat1_lp_delta, seat0_ordinal_after, seat1_ordinal_after)
     VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (match_id) DO NOTHING`,
    [
      w.matchId,
      w.seasonId,
      w.seat0Profile,
      w.seat1Profile,
      w.winnerSeat,
      w.reason,
      w.seat0RatingBefore,
      w.seat0RatingAfter,
      w.seat1RatingBefore,
      w.seat1RatingAfter,
      w.seat0LpDelta,
      w.seat1LpDelta,
      w.seat0OrdinalAfter,
      w.seat1OrdinalAfter,
    ],
  );
}

/**
 * Recent outcomes for one profile, newest first, resolved to win/loss/draw
 * against their PROFILE ID.
 *
 * The legacy equivalent compared a display name against the stored winner
 * string, which is the identity bug this port exists to remove. Here the seat a
 * profile occupied is a bigint column and the comparison is arithmetic.
 */
export async function recentOutcomes(
  seasonId: string,
  profileId: string,
  limit: number,
  c?: PoolClient,
): Promise<Array<'win' | 'loss' | 'draw'>> {
  const text = `SELECT winner_seat,
                       (seat0_profile = $2::bigint) AS is_seat0
                  FROM game.ranked_match_ratings
                 WHERE season_id = $1
                   AND (seat0_profile = $2::bigint OR seat1_profile = $2::bigint)
                 ORDER BY created_at DESC
                 LIMIT $3`;
  const params = [seasonId, profileId, limit];
  const rows = c
    ? (await c.query<{ winner_seat: number | null; is_seat0: boolean }>(text, params)).rows
    : (await query<{ winner_seat: number | null; is_seat0: boolean }>(text, params)).rows;
  return rows.map((r) => {
    if (r.winner_seat === null) return 'draw' as const;
    const mySeat = r.is_seat0 ? 0 : 1;
    return Number(r.winner_seat) === mySeat ? ('win' as const) : ('loss' as const);
  });
}

export interface RankedMatchSummary {
  matchID: string;
  seasonId: string;
  seat: 0 | 1;
  outcome: 'win' | 'loss' | 'draw';
  reason: string;
  lpDelta: number;
  opponentDisplayName: string | null;
  finishedAt: string;
}

/** The caller's ranked match history, with the LP each game moved. */
export async function recentRankedMatches(
  profileId: string,
  limit: number,
): Promise<RankedMatchSummary[]> {
  const { rows } = await query<{
    match_id: string;
    season_id: string;
    is_seat0: boolean;
    winner_seat: number | null;
    reason: string;
    seat0_lp_delta: number;
    seat1_lp_delta: number;
    opponent_name: string | null;
    finished_at: Date;
  }>(
    // `finished_at` comes from game.match_results — the instant that was
    // HMAC-signed when the match ended. `ranked_match_ratings.created_at` is
    // when the sweeper got to it, which is close but is not the same fact, and
    // a client rendering "played at" wants the former.
    `SELECT r.match_id, r.season_id,
            (r.seat0_profile = $1::bigint) AS is_seat0,
            r.winner_seat, r.reason, r.seat0_lp_delta, r.seat1_lp_delta,
            opp.display_name AS opponent_name,
            COALESCE(mr.finished_at, r.created_at) AS finished_at
       FROM game.ranked_match_ratings r
       LEFT JOIN game.match_results mr ON mr.match_id = r.match_id
       LEFT JOIN core.profiles opp
              ON opp.id = CASE WHEN r.seat0_profile = $1::bigint
                               THEN r.seat1_profile ELSE r.seat0_profile END
      WHERE r.seat0_profile = $1::bigint OR r.seat1_profile = $1::bigint
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [profileId, limit],
  );
  return rows.map((r) => {
    const seat: 0 | 1 = r.is_seat0 ? 0 : 1;
    const outcome =
      r.winner_seat === null ? 'draw' : Number(r.winner_seat) === seat ? 'win' : 'loss';
    return {
      matchID: r.match_id,
      seasonId: r.season_id,
      seat,
      outcome: outcome as 'win' | 'loss' | 'draw',
      reason: r.reason,
      lpDelta: Number(seat === 0 ? r.seat0_lp_delta : r.seat1_lp_delta),
      opponentDisplayName: r.opponent_name,
      finishedAt: r.finished_at.toISOString(),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Queue                                                                      */
/* -------------------------------------------------------------------------- */

export interface QueueRow {
  profileId: string;
  seasonId: string;
  deckId: string;
  rating: number;
  region: string;
  queuedAt: Date;
}

interface RawQueue {
  profile_id: string;
  season_id: string;
  deck_id: string;
  rating: number;
  region: string;
  queued_at: Date;
}

const QUEUE_COLS = `profile_id::text, season_id, deck_id::text, rating, region, queued_at`;

function toQueue(r: RawQueue): QueueRow {
  return {
    profileId: r.profile_id,
    seasonId: r.season_id,
    deckId: r.deck_id,
    rating: Number(r.rating),
    region: r.region,
    queuedAt: r.queued_at,
  };
}

/**
 * Join the queue, or refresh an existing entry.
 *
 * `queued_at` is deliberately NOT reset on conflict. The matchmaking window
 * widens with time waited, so resetting it on every re-enqueue would mean a
 * client that re-joins on a timer never becomes eligible for a wider bracket and
 * waits forever at a bracket that has no opponents in it.
 */
export async function enqueue(e: {
  profileId: string;
  seasonId: string;
  deckId: string;
  rating: number;
  region: string;
}): Promise<QueueRow> {
  const r = await queryOne<RawQueue>(
    `INSERT INTO game.ranked_queue (profile_id, season_id, deck_id, rating, region)
     VALUES ($1::bigint, $2, $3::bigint, $4, $5)
     ON CONFLICT (profile_id) DO UPDATE
       SET season_id = EXCLUDED.season_id,
           deck_id   = EXCLUDED.deck_id,
           rating    = EXCLUDED.rating,
           region    = EXCLUDED.region
     RETURNING ${QUEUE_COLS}`,
    [e.profileId, e.seasonId, e.deckId, e.rating, e.region],
  );
  if (!r) throw new Error('ranked queue insert returned no row');
  return toQueue(r);
}

/** Restore a claimed entry, keeping its original wait. Used when a pairing aborts. */
export async function requeue(c: PoolClient, e: QueueRow): Promise<void> {
  await c.query(
    `INSERT INTO game.ranked_queue (profile_id, season_id, deck_id, rating, region, queued_at)
     VALUES ($1::bigint, $2, $3::bigint, $4, $5, $6)
     ON CONFLICT (profile_id) DO NOTHING`,
    [e.profileId, e.seasonId, e.deckId, e.rating, e.region, e.queuedAt],
  );
}

export async function dequeue(profileId: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM game.ranked_queue WHERE profile_id = $1::bigint`, [
    profileId,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function getQueueEntry(profileId: string): Promise<QueueRow | null> {
  const r = await queryOne<RawQueue>(
    `SELECT ${QUEUE_COLS} FROM game.ranked_queue WHERE profile_id = $1::bigint`,
    [profileId],
  );
  return r ? toQueue(r) : null;
}

export async function queueDepth(region: string): Promise<number> {
  const r = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM game.ranked_queue WHERE region = $1`,
    [region],
  );
  return Number(r?.n ?? '0');
}

export async function listQueueRegions(): Promise<string[]> {
  const { rows } = await query<{ region: string }>(
    `SELECT DISTINCT region FROM game.ranked_queue`,
  );
  return rows.map((r) => r.region);
}

/**
 * The longest-waiting entry in a region, locked and skipped-if-locked.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets N game containers pair simultaneously:
 * a row another container is already working on is invisible to this one, so two
 * pairers never hand the same player to two matches. That is the same mechanism
 * the legacy matchmaker used, and it is the one part of it that was right.
 */
export async function claimSeed(c: PoolClient, region: string): Promise<QueueRow | null> {
  const { rows } = await c.query<RawQueue>(
    `SELECT ${QUEUE_COLS} FROM game.ranked_queue
      WHERE region = $1
      ORDER BY queued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    [region],
  );
  return rows[0] ? toQueue(rows[0]) : null;
}

/** The nearest-rated opponent to `seed` inside `window`, locked. */
export async function claimOpponent(
  c: PoolClient,
  region: string,
  excludeProfileId: string,
  rating: number,
  window: number,
): Promise<QueueRow | null> {
  const { rows } = await c.query<RawQueue>(
    `SELECT ${QUEUE_COLS} FROM game.ranked_queue
      WHERE region = $1
        AND profile_id <> $2::bigint
        AND abs(rating - $3) <= $4
      ORDER BY abs(rating - $3) ASC, queued_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    [region, excludeProfileId, rating, window],
  );
  return rows[0] ? toQueue(rows[0]) : null;
}

export async function deleteQueued(c: PoolClient, profileIds: string[]): Promise<void> {
  await c.query(`DELETE FROM game.ranked_queue WHERE profile_id = ANY($1::bigint[])`, [profileIds]);
}

/** Drop entries whose client has plainly gone away. */
export async function reapStaleQueue(olderThanMs: number): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM game.ranked_queue WHERE queued_at < now() - ($1::bigint * interval '1 millisecond')`,
    [Math.floor(olderThanMs)],
  );
  return rowCount ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Seating support                                                            */
/* -------------------------------------------------------------------------- */

export interface QueuedSeat {
  profileId: string;
  displayName: string;
  deckId: string;
  cards: string[];
}

/**
 * Everything the pairer needs to seat one queued player, read INSIDE the
 * pairing transaction.
 *
 * `cards` comes from `core.decks` as it stands NOW, not from anything captured
 * at enqueue time. A deck row stays editable while its owner sits in the queue —
 * the same hole the lobby closes for seat 0 on the join path — so a player could
 * otherwise queue with a legal deck, edit it to the full catalogue, and be
 * seated with the edit.
 */
export async function loadQueuedSeat(
  c: PoolClient,
  profileId: string,
  deckId: string,
): Promise<QueuedSeat | null> {
  const { rows } = await c.query<{ display_name: string; cards: unknown }>(
    `SELECT p.display_name, d.cards
       FROM core.profiles p
       JOIN core.decks   d ON d.id = $2::bigint AND d.profile_id = p.id
      WHERE p.id = $1::bigint`,
    [profileId, deckId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    profileId,
    displayName: r.display_name,
    deckId,
    cards: Array.isArray(r.cards) ? (r.cards as unknown[]).map(String) : [],
  };
}

/**
 * Insert a queue-paired match, already `live` with both seats filled.
 *
 * Unlike `insertOpenMatch`, this never passes through an `open` state: a paired
 * match has no join step to wait for, and leaving it `open` for even a moment
 * would put it in the public lobby for someone else to take a seat in.
 *
 * `unlisted = TRUE` for the same reason — a ranked queue match is not something
 * a third party can enter, so it has no business in `GET /games/lobby`.
 */
export async function insertLiveRankedMatch(
  c: PoolClient,
  m: {
    id: string;
    seat0Profile: string;
    seat1Profile: string;
    seat0DeckId: string;
    seat1DeckId: string;
  },
): Promise<void> {
  await c.query(
    `INSERT INTO game.matches
       (id, mode, status, unlisted, seat0_profile, seat1_profile,
        seat0_deck_id, seat1_deck_id, started_at, updated_at)
     VALUES ($1, 'ranked', 'live', TRUE, $2::bigint, $3::bigint, $4::bigint, $5::bigint,
             now(), now())`,
    [m.id, m.seat0Profile, m.seat1Profile, m.seat0DeckId, m.seat1DeckId],
  );
}

/** The caller's current live ranked match, if they are seated in one. */
export async function liveRankedMatchFor(profileId: string): Promise<{
  matchID: string;
  seat: 0 | 1;
  opponentDisplayName: string | null;
} | null> {
  const r = await queryOne<{
    id: string;
    is_seat0: boolean;
    opponent_name: string | null;
  }>(
    `SELECT m.id,
            (m.seat0_profile = $1::bigint) AS is_seat0,
            opp.display_name AS opponent_name
       FROM game.matches m
       LEFT JOIN core.profiles opp
              ON opp.id = CASE WHEN m.seat0_profile = $1::bigint
                               THEN m.seat1_profile ELSE m.seat0_profile END
      WHERE m.mode = 'ranked'
        AND m.status = 'live'
        AND (m.seat0_profile = $1::bigint OR m.seat1_profile = $1::bigint)
      ORDER BY m.started_at DESC NULLS LAST
      LIMIT 1`,
    [profileId],
  );
  if (!r) return null;
  return {
    matchID: r.id,
    seat: r.is_seat0 ? 0 : 1,
    opponentDisplayName: r.opponent_name,
  };
}

/** `core.profiles.created_at` — the ACCOUNT's age, for anti-smurf. */
export async function profileCreatedAt(
  profileId: string,
  c?: PoolClient,
): Promise<Date | null> {
  const text = `SELECT created_at FROM core.profiles WHERE id = $1::bigint`;
  const rows = c
    ? (await c.query<{ created_at: Date }>(text, [profileId])).rows
    : (await query<{ created_at: Date }>(text, [profileId])).rows;
  return rows[0]?.created_at ?? null;
}
