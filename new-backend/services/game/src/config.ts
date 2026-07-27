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
  }),
  { serviceName: 'game' },
);

export type Config = typeof config;
