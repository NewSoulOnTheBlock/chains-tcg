import { loadEnv, serviceEnvShape, z } from '@chains/shared';

/**
 * Auth service configuration.
 *
 * `AUTH_DOMAIN` and `AUTH_URI` are baked into the signed message. They are not
 * secrets, but they are what makes a signature bound to *this* application —
 * a signature harvested by a phishing site for `evil.example` will not verify
 * here, because the server re-derives the message with its own domain.
 */
export const authEnvSchema = z.object({
  ...serviceEnvShape,
  PORT: z.coerce.number().int().min(1).max(65535).default(4001),

  AUTH_DOMAIN: z.string().min(1).default('localhost:8080'),
  AUTH_URI: z.string().url().default('http://localhost:8080'),
  AUTH_STATEMENT: z.string().min(1).max(200).default('Sign in to Chains TCG.'),

  NONCE_TTL_SEC: z.coerce.number().int().min(30).max(900).default(300),
  REFRESH_TOKEN_TTL_SEC: z.coerce
    .number()
    .int()
    .min(3600)
    .max(90 * 24 * 3600)
    .default(30 * 24 * 3600),

  /** Per-IP bucket across all /auth routes. */
  AUTH_RL_IP_LIMIT: z.coerce.number().int().min(1).default(30),
  AUTH_RL_IP_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
  /** Per-wallet-address bucket on /auth/nonce and /auth/verify. */
  AUTH_RL_ADDRESS_LIMIT: z.coerce.number().int().min(1).default(10),
  AUTH_RL_ADDRESS_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

export const env: AuthEnv = loadEnv(authEnvSchema, { serviceName: 'auth' });
