// src/ranked/db.ts
// Postgres-backed persistence for the ranked subsystem. Schema is created on
// boot via `initRankedSchema`. All ranked operations live here so the rest of
// the system has a clean async API and we can swap storage later (e.g. Redis
// for the queue) without touching callers.
import pg from 'pg';
import type {
  RankedProfile, Season, RankedQueueEntry, RankedMatchOutcome,
  ReplayEvent, TelemetryEvent,
} from './types';
import type { Tier, Division } from './ranks';

let pool: pg.Pool | null = null;
export function setRankedPool(p: pg.Pool | null) { pool = p; }

// ── In-memory fallback (dev without DATABASE_URL) ────────────────────────────
const mem = {
  profiles: new Map<string, RankedProfile>(),
  seasons:  new Map<string, Season>(),
  queue:    new Map<string, RankedQueueEntry>(),
  outcomes: new Map<string, RankedMatchOutcome>(),
  replay:   new Map<string, ReplayEvent[]>(),
  telemetry: [] as TelemetryEvent[],
};

// ── Schema ───────────────────────────────────────────────────────────────────
export async function initRankedSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ranked_seasons (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      started_at      BIGINT NOT NULL,
      ends_at         BIGINT NOT NULL,
      active          BOOLEAN NOT NULL DEFAULT FALSE,
      soft_reset_factor DOUBLE PRECISION NOT NULL DEFAULT 0.5,
      reward_definitions JSONB,
      balance_patch   TEXT
    );
    CREATE TABLE IF NOT EXISTS ranked_profile (
      player_id       TEXT PRIMARY KEY,
      hidden_mmr      DOUBLE PRECISION NOT NULL DEFAULT 1500,
      rating_deviation DOUBLE PRECISION NOT NULL DEFAULT 350,
      volatility      DOUBLE PRECISION NOT NULL DEFAULT 0.06,
      visible_rank    TEXT NOT NULL DEFAULT 'Bronze',
      division        INTEGER NOT NULL DEFAULT 4,
      ranked_points   INTEGER NOT NULL DEFAULT 0,
      wins            INTEGER NOT NULL DEFAULT 0,
      losses          INTEGER NOT NULL DEFAULT 0,
      placement_matches_remaining INTEGER NOT NULL DEFAULT 10,
      season_id       TEXT NOT NULL,
      smurf_flagged   BOOLEAN NOT NULL DEFAULT FALSE,
      mmr_multiplier  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
      created_at      BIGINT NOT NULL,
      updated_at      BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ranked_profile_mmr_idx ON ranked_profile (hidden_mmr DESC);
    CREATE INDEX IF NOT EXISTS ranked_profile_season_idx ON ranked_profile (season_id);

    CREATE TABLE IF NOT EXISTS ranked_queue (
      player_id       TEXT PRIMARY KEY,
      hidden_mmr      DOUBLE PRECISION NOT NULL,
      region          TEXT NOT NULL,
      queued_at       BIGINT NOT NULL,
      selected_deck_id TEXT NOT NULL,
      season_id       TEXT NOT NULL,
      claimed_by      TEXT
    );
    CREATE INDEX IF NOT EXISTS ranked_queue_region_mmr_idx ON ranked_queue (region, hidden_mmr);

    CREATE TABLE IF NOT EXISTS ranked_match (
      match_id        TEXT PRIMARY KEY,
      season_id       TEXT NOT NULL,
      player0         TEXT NOT NULL,
      player1         TEXT NOT NULL,
      winner          TEXT,
      draw            BOOLEAN NOT NULL DEFAULT FALSE,
      started_at      BIGINT NOT NULL,
      ended_at        BIGINT NOT NULL,
      replay_seed     TEXT NOT NULL,
      disconnected_player TEXT,
      p0_mmr_before   DOUBLE PRECISION,
      p1_mmr_before   DOUBLE PRECISION,
      p0_mmr_after    DOUBLE PRECISION,
      p1_mmr_after    DOUBLE PRECISION,
      p0_lp_change    INTEGER,
      p1_lp_change    INTEGER
    );
    CREATE INDEX IF NOT EXISTS ranked_match_season_idx ON ranked_match (season_id, ended_at DESC);

    CREATE TABLE IF NOT EXISTS ranked_replay (
      match_id        TEXT NOT NULL,
      seq             INTEGER NOT NULL,
      ts              BIGINT NOT NULL,
      type            TEXT NOT NULL,
      actor           TEXT,
      payload         JSONB,
      PRIMARY KEY (match_id, seq)
    );

    CREATE TABLE IF NOT EXISTS ranked_telemetry (
      id              BIGSERIAL PRIMARY KEY,
      ts              BIGINT NOT NULL,
      type            TEXT NOT NULL,
      player_id       TEXT,
      match_id        TEXT,
      payload         JSONB
    );
    CREATE INDEX IF NOT EXISTS ranked_telemetry_type_ts_idx ON ranked_telemetry (type, ts DESC);
  `);
}

// ── Seasons ──────────────────────────────────────────────────────────────────
function rowToSeason(r: any): Season {
  return {
    id: r.id, name: r.name,
    startedAt: Number(r.started_at), endsAt: Number(r.ends_at),
    active: !!r.active, softResetFactor: Number(r.soft_reset_factor),
    rewardDefinitions: r.reward_definitions ?? null,
    balancePatch: r.balance_patch ?? null,
  };
}
export async function upsertSeason(s: Season): Promise<Season> {
  if (!pool) { mem.seasons.set(s.id, s); return s; }
  const { rows } = await pool.query(
    `INSERT INTO ranked_seasons (id, name, started_at, ends_at, active, soft_reset_factor, reward_definitions, balance_patch)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET
       name=$2, started_at=$3, ends_at=$4, active=$5,
       soft_reset_factor=$6, reward_definitions=$7, balance_patch=$8
     RETURNING *`,
    [s.id, s.name, s.startedAt, s.endsAt, s.active, s.softResetFactor, s.rewardDefinitions, s.balancePatch],
  );
  return rowToSeason(rows[0]);
}
export async function getActiveSeason(): Promise<Season | null> {
  if (!pool) {
    for (const s of mem.seasons.values()) if (s.active) return s;
    return null;
  }
  const { rows } = await pool.query(`SELECT * FROM ranked_seasons WHERE active = TRUE LIMIT 1`);
  return rows[0] ? rowToSeason(rows[0]) : null;
}
export async function setActiveSeason(id: string) {
  if (!pool) {
    for (const s of mem.seasons.values()) s.active = (s.id === id);
    return;
  }
  await pool.query(`UPDATE ranked_seasons SET active = (id = $1)`, [id]);
}
export async function listAllProfilesForSeason(seasonId: string): Promise<RankedProfile[]> {
  if (!pool) return [...mem.profiles.values()].filter(p => p.seasonId === seasonId);
  const { rows } = await pool.query(`SELECT * FROM ranked_profile WHERE season_id = $1`, [seasonId]);
  return rows.map(rowToProfile);
}

// ── Profiles ─────────────────────────────────────────────────────────────────
function rowToProfile(r: any): RankedProfile {
  return {
    playerId: r.player_id,
    hiddenMmr: Number(r.hidden_mmr),
    ratingDeviation: Number(r.rating_deviation),
    volatility: Number(r.volatility),
    visibleRank: r.visible_rank as Tier,
    division: Number(r.division) as Division,
    rankedPoints: Number(r.ranked_points),
    wins: Number(r.wins),
    losses: Number(r.losses),
    placementMatchesRemaining: Number(r.placement_matches_remaining),
    seasonId: r.season_id,
    smurfFlagged: !!r.smurf_flagged,
    mmrMultiplier: Number(r.mmr_multiplier),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
export async function getRankedProfile(playerId: string): Promise<RankedProfile | null> {
  if (!pool) return mem.profiles.get(playerId) ?? null;
  const { rows } = await pool.query(`SELECT * FROM ranked_profile WHERE player_id = $1`, [playerId]);
  return rows[0] ? rowToProfile(rows[0]) : null;
}
export async function upsertRankedProfile(p: RankedProfile): Promise<RankedProfile> {
  if (!pool) { mem.profiles.set(p.playerId, { ...p, updatedAt: Date.now() }); return mem.profiles.get(p.playerId)!; }
  const { rows } = await pool.query(
    `INSERT INTO ranked_profile (
       player_id, hidden_mmr, rating_deviation, volatility, visible_rank, division,
       ranked_points, wins, losses, placement_matches_remaining, season_id,
       smurf_flagged, mmr_multiplier, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (player_id) DO UPDATE SET
       hidden_mmr=$2, rating_deviation=$3, volatility=$4,
       visible_rank=$5, division=$6, ranked_points=$7,
       wins=$8, losses=$9, placement_matches_remaining=$10, season_id=$11,
       smurf_flagged=$12, mmr_multiplier=$13, updated_at=$15
     RETURNING *`,
    [
      p.playerId, p.hiddenMmr, p.ratingDeviation, p.volatility,
      p.visibleRank, p.division, p.rankedPoints, p.wins, p.losses,
      p.placementMatchesRemaining, p.seasonId, p.smurfFlagged, p.mmrMultiplier,
      p.createdAt, Date.now(),
    ],
  );
  return rowToProfile(rows[0]);
}

// ── Leaderboard ──────────────────────────────────────────────────────────────
export async function topByMmr(seasonId: string, limit = 100): Promise<RankedProfile[]> {
  if (!pool) {
    return [...mem.profiles.values()]
      .filter(p => p.seasonId === seasonId)
      .sort((a,b) => b.hiddenMmr - a.hiddenMmr)
      .slice(0, limit);
  }
  const { rows } = await pool.query(
    `SELECT * FROM ranked_profile WHERE season_id = $1
     ORDER BY hidden_mmr DESC, ranked_points DESC LIMIT $2`,
    [seasonId, limit],
  );
  return rows.map(rowToProfile);
}

// ── Queue ────────────────────────────────────────────────────────────────────
function rowToQueue(r: any): RankedQueueEntry {
  return {
    playerId: r.player_id,
    hiddenMmr: Number(r.hidden_mmr),
    region: r.region,
    queuedAt: Number(r.queued_at),
    selectedDeckId: r.selected_deck_id,
    seasonId: r.season_id,
  };
}
export async function enqueue(e: RankedQueueEntry) {
  if (!pool) { mem.queue.set(e.playerId, e); return; }
  await pool.query(
    `INSERT INTO ranked_queue (player_id, hidden_mmr, region, queued_at, selected_deck_id, season_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (player_id) DO UPDATE SET
       hidden_mmr=$2, region=$3, queued_at=$4, selected_deck_id=$5, season_id=$6, claimed_by=NULL`,
    [e.playerId, e.hiddenMmr, e.region, e.queuedAt, e.selectedDeckId, e.seasonId],
  );
}
export async function dequeue(playerId: string) {
  if (!pool) { mem.queue.delete(playerId); return; }
  await pool.query(`DELETE FROM ranked_queue WHERE player_id = $1`, [playerId]);
}
export async function queueStatus(playerId: string): Promise<RankedQueueEntry | null> {
  if (!pool) return mem.queue.get(playerId) ?? null;
  const { rows } = await pool.query(`SELECT * FROM ranked_queue WHERE player_id = $1`, [playerId]);
  return rows[0] ? rowToQueue(rows[0]) : null;
}
/**
 * Atomically claim two compatible entries from the queue. Uses
 * `FOR UPDATE SKIP LOCKED` so multiple matchmaker workers can run safely.
 * Returns the pair (or null if no compatible pairing exists yet).
 */
export async function claimPair(workerId: string, region: string, mmrCenter: number, mmrRange: number)
: Promise<[RankedQueueEntry, RankedQueueEntry] | null> {
  if (!pool) {
    const candidates = [...mem.queue.values()]
      .filter(e => e.region === region && Math.abs(e.hiddenMmr - mmrCenter) <= mmrRange);
    if (candidates.length < 2) return null;
    candidates.sort((a, b) => a.queuedAt - b.queuedAt);
    const [a, b] = candidates;
    mem.queue.delete(a.playerId); mem.queue.delete(b.playerId);
    return [a, b];
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT * FROM ranked_queue
       WHERE region = $1 AND ABS(hidden_mmr - $2) <= $3 AND claimed_by IS NULL
       ORDER BY queued_at ASC
       LIMIT 2 FOR UPDATE SKIP LOCKED`,
      [region, mmrCenter, mmrRange],
    );
    if (r.rowCount! < 2) { await client.query('ROLLBACK'); return null; }
    const ids = r.rows.map((row: any) => row.player_id);
    await client.query(
      `UPDATE ranked_queue SET claimed_by = $1 WHERE player_id = ANY($2::text[])`,
      [workerId, ids],
    );
    await client.query(`DELETE FROM ranked_queue WHERE player_id = ANY($1::text[])`, [ids]);
    await client.query('COMMIT');
    return [rowToQueue(r.rows[0]), rowToQueue(r.rows[1])];
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}
export async function listQueueForRegion(region: string): Promise<RankedQueueEntry[]> {
  if (!pool) return [...mem.queue.values()].filter(e => e.region === region);
  const { rows } = await pool.query(`SELECT * FROM ranked_queue WHERE region = $1 ORDER BY queued_at ASC`, [region]);
  return rows.map(rowToQueue);
}

// ── Match results ────────────────────────────────────────────────────────────
/**
 * Idempotent: returns 'duplicate' if the match was already recorded.
 * Atomically inserts the row + ratings deltas.
 */
export async function recordRankedMatch(
  m: RankedMatchOutcome,
  ratings: { p0Before: number; p1Before: number; p0After: number; p1After: number; p0LpChange: number; p1LpChange: number },
): Promise<'recorded' | 'duplicate'> {
  if (!pool) {
    if (mem.outcomes.has(m.matchId)) return 'duplicate';
    mem.outcomes.set(m.matchId, m); return 'recorded';
  }
  const r = await pool.query(
    `INSERT INTO ranked_match (
       match_id, season_id, player0, player1, winner, draw,
       started_at, ended_at, replay_seed, disconnected_player,
       p0_mmr_before, p1_mmr_before, p0_mmr_after, p1_mmr_after,
       p0_lp_change, p1_lp_change
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (match_id) DO NOTHING
     RETURNING match_id`,
    [
      m.matchId, m.seasonId, m.player0, m.player1, m.winner, m.draw,
      m.startedAt, m.endedAt, m.replaySeed, m.disconnectedPlayer,
      ratings.p0Before, ratings.p1Before, ratings.p0After, ratings.p1After,
      ratings.p0LpChange, ratings.p1LpChange,
    ],
  );
  return r.rowCount === 0 ? 'duplicate' : 'recorded';
}
export async function recentMatchesFor(playerId: string, limit = 30) {
  if (!pool) return [...mem.outcomes.values()].filter(m => m.player0 === playerId || m.player1 === playerId).slice(-limit);
  const { rows } = await pool.query(
    `SELECT * FROM ranked_match WHERE player0 = $1 OR player1 = $1 ORDER BY ended_at DESC LIMIT $2`,
    [playerId, limit],
  );
  return rows;
}

// ── Replay events ────────────────────────────────────────────────────────────
export async function appendReplayEvents(events: ReplayEvent[]) {
  if (events.length === 0) return;
  if (!pool) {
    for (const e of events) {
      const arr = mem.replay.get(e.matchId) ?? [];
      arr.push(e); mem.replay.set(e.matchId, arr);
    }
    return;
  }
  // Batched insert
  const cols = ['match_id','seq','ts','type','actor','payload'];
  const vals: any[] = [];
  const places: string[] = [];
  events.forEach((e, i) => {
    const off = i * cols.length;
    places.push(`(${cols.map((_, j) => `$${off + j + 1}`).join(',')})`);
    vals.push(e.matchId, e.seq, e.ts, e.type, e.actor, JSON.stringify(e.payload ?? null));
  });
  await pool.query(
    `INSERT INTO ranked_replay (match_id, seq, ts, type, actor, payload)
     VALUES ${places.join(',')} ON CONFLICT DO NOTHING`,
    vals,
  );
}
export async function getReplay(matchId: string): Promise<ReplayEvent[]> {
  if (!pool) return mem.replay.get(matchId) ?? [];
  const { rows } = await pool.query(
    `SELECT * FROM ranked_replay WHERE match_id = $1 ORDER BY seq ASC`, [matchId],
  );
  return rows.map((r: any) => ({
    matchId: r.match_id, seq: Number(r.seq), ts: Number(r.ts),
    type: r.type, actor: r.actor ?? null, payload: r.payload,
  }));
}

// ── Telemetry ────────────────────────────────────────────────────────────────
export async function emitTelemetry(events: TelemetryEvent[]) {
  if (events.length === 0) return;
  if (!pool) { mem.telemetry.push(...events); return; }
  const cols = ['ts','type','player_id','match_id','payload'];
  const vals: any[] = [];
  const places: string[] = [];
  events.forEach((e, i) => {
    const off = i * cols.length;
    places.push(`(${cols.map((_, j) => `$${off + j + 1}`).join(',')})`);
    vals.push(e.ts, e.type, e.playerId, e.matchId, JSON.stringify(e.payload ?? null));
  });
  await pool.query(
    `INSERT INTO ranked_telemetry (ts, type, player_id, match_id, payload)
     VALUES ${places.join(',')}`,
    vals,
  );
}
