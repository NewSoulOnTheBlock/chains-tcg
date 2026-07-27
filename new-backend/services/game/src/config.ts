import { loadEnv, serviceEnvShape, z } from '@chains/shared';

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

export const config = loadEnv(
  z.object({
    ...serviceEnvShape,

    /**
     * The single port this service listens on: the lobby API, /healthz,
     * /readyz and boardgame.io's `/socket.io/` transport all share it, which is
     * what gateway/nginx.conf already routes to `game_upstream`.
     */
    PORT: z.coerce.number().int().min(1).max(65535).default(4003),

    /**
     * Advisory origin allowlist handed to boardgame.io. The gateway is the only
     * layer that emits CORS headers (see gateway/nginx.conf), and the socket
     * transport runs with socket.io's own CORS disabled, so this exists to
     * document intent and to keep boardgame.io from warning about an unset
     * `origins`. Never `*`.
     */
    ALLOWED_ORIGINS: csv,

    /** HMAC key over every authoritative match result. Never leaves the server. */
    MATCH_RESULT_HMAC_SECRET: z.string().min(32),

    /** Postgres schema holding boardgame.io's own opaque `Games` table. */
    BGIO_SCHEMA: z.string().min(1).default('bgio'),

    /** How often the authoritative-result writer sweeps finished matches. */
    RESULT_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(3_000),
    /**
     * Overlap subtracted from the sweep cursor, so a match that finishes while
     * a sweep is mid-flight is still picked up on the next pass.
     */
    RESULT_POLL_OVERLAP_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(120_000),

    /** Open (unjoined) matches a single profile may hold at once. */
    LOBBY_MAX_OPEN_PER_PROFILE: z.coerce.number().int().min(1).max(20).default(3),
    /** Rows returned by GET /games/lobby. */
    LOBBY_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(50),

    /* ── ranked ladder ────────────────────────────────────────────────────
     * All of these have defaults, so nothing needs adding to .env or
     * docker-compose.yml to run the ladder. They are declared here rather than
     * left as constants so a season length or a placement count can be changed
     * without a rebuild — and so the values a deployment is actually running
     * are visible in one place.
     */

    /**
     * Master switch. `false` unmounts every /games/ranked route and stops the
     * matchmaker; nothing else in the service changes, and results of matches
     * that are already `mode = 'ranked'` simply stop moving rating. The one
     * situation this is for is "the ladder is misbehaving and we need casual
     * and wager play to keep working while we look at it".
     */
    RANKED_ENABLED: z
      .string()
      .default('true')
      .transform((v) => v !== 'false' && v !== '0'),

    /** Rated games before a visible rank is assigned. */
    RANKED_PLACEMENT_MATCHES: z.coerce.number().int().min(1).max(50).default(10),

    /** Length of a bootstrapped season. */
    RANKED_SEASON_DURATION_DAYS: z.coerce.number().int().min(1).max(365).default(60),
    /** newRating = 1500 + (oldRating - 1500) * factor, applied at rollover. */
    RANKED_SEASON_SOFT_RESET: z.coerce.number().min(0).max(1).default(0.5),

    /** How often the pairer looks at the queue. */
    RANKED_MATCHMAKER_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
    /**
     * A queue entry older than this is dropped. Clients poll to stay visible;
     * one that stopped polling has closed its tab, and pairing it produces a
     * match nobody sits down to.
     */
    RANKED_QUEUE_STALE_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(900_000),

    /** Rating window at zero wait, and how fast it opens up. */
    RANKED_MMR_WINDOW_BASE: z.coerce.number().int().min(0).max(5_000).default(50),
    RANKED_MMR_WINDOW_STEP: z.coerce.number().int().min(1).max(5_000).default(50),
    RANKED_MMR_WINDOW_STEP_SEC: z.coerce.number().int().min(1).max(600).default(10),
    /**
     * Ceiling on the window. At 2000 rating points it is "anyone in the queue"
     * in practice — the point is that the number stays finite and legible in a
     * log line, not that it ever genuinely constrains a match.
     */
    RANKED_MMR_WINDOW_MAX: z.coerce.number().int().min(50).max(10_000).default(2_000),

    /** Rows returned by GET /games/ranked/leaderboard. */
    RANKED_LEADERBOARD_PAGE_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  }),
  { serviceName: 'game' },
);

export type Config = typeof config;
