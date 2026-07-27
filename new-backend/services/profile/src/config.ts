import { loadEnv, serviceEnvShape, z } from '@chains/shared';

/**
 * Service env = the shared service shape (DATABASE_URL, REDIS_URL, JWT_*,
 * LOG_LEVEL, TRUST_PROXY_HOPS, SHUTDOWN_GRACE_MS, …) plus this service's own.
 */
export const config = loadEnv(
  z.object({
    ...serviceEnvShape,

    PORT: z.coerce.number().int().min(1).max(65535).default(4002),

    /** Leaderboard cache TTL, seconds. */
    LEADERBOARD_TTL_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),

    /**
     * Optional avatar host allowlist (comma separated, exact host match).
     * Empty = any https host is accepted (still https-only and length capped).
     * Audit L-4: the long-term fix is to proxy/hash avatars server-side.
     */
    AVATAR_HOST_ALLOWLIST: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),

    AVATAR_URL_MAX_LENGTH: z.coerce.number().int().min(64).max(2048).default(512),
  }),
  { serviceName: 'profile' },
);

export type Config = typeof config;
