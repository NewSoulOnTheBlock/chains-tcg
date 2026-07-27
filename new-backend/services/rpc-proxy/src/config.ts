/**
 * rpc-proxy environment.
 *
 * `EVM_RPC_URL` is the whole point of this service: it is the ONLY place the
 * upstream credential exists, and it is never returned, logged or echoed in an
 * error. `describeConfig()` is what the boot log gets.
 */
import { loadEnv, serviceEnvShape, z } from './platform/shared.js';

export const proxyEnvSchema = z.object({
  ...serviceEnvShape,
  PORT: z.coerce.number().int().min(1).max(65_535).default(4005),

  /** H-5: contains the API key. Never leaves this process. */
  EVM_RPC_URL: z.string().url(),
  /** Optional narrowing of the built-in allowlist. Never widens it. */
  RPC_ALLOWED_METHODS: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  /**
   * Optional shared secret for server-to-server callers (the wager service).
   * It buys a higher rate-limit tier and NOTHING else — it grants no extra
   * methods, so a leak cannot become a broadcast path.
   */
  RPC_INTERNAL_TOKEN: z.string().default(''),

  RPC_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
  /** Hard cap on a single JSON-RPC request body. */
  RPC_MAX_BODY_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(32_768),

  /** Per-IP: browsers. Per-profile: authenticated users. Internal: services. */
  RPC_IP_LIMIT: z.coerce.number().int().min(1).default(120),
  RPC_IP_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
  RPC_PROFILE_LIMIT: z.coerce.number().int().min(1).default(300),
  RPC_PROFILE_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
  RPC_INTERNAL_LIMIT: z.coerce.number().int().min(1).default(3_000),
  RPC_INTERNAL_WINDOW_SEC: z.coerce.number().int().min(1).default(60),

  /** Cache TTLs, seconds. Short by design: a re-org must not be served for long. */
  RPC_CACHE_RECEIPT_TTL_SEC: z.coerce.number().int().min(0).max(3_600).default(30),
  RPC_CACHE_TX_TTL_SEC: z.coerce.number().int().min(0).max(3_600).default(30),
  RPC_CACHE_BLOCK_TTL_SEC: z.coerce.number().int().min(0).max(3_600).default(30),
  RPC_CACHE_CHAINID_TTL_SEC: z.coerce.number().int().min(0).max(86_400).default(3_600),

  RPC_BREAKER_FAILURES: z.coerce.number().int().min(1).max(100).default(5),
  RPC_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
});

export type ProxyEnv = z.infer<typeof proxyEnvSchema>;

let cached: ProxyEnv | null = null;

export function env(): ProxyEnv {
  if (!cached) cached = loadEnv(proxyEnvSchema, { serviceName: 'rpc-proxy' });
  return cached;
}

export function parseEnv(source: Record<string, string | undefined>): ProxyEnv {
  return loadEnv(proxyEnvSchema, { source, serviceName: 'rpc-proxy', throwOnError: true });
}

const SECRET_KEYS = new Set([
  'EVM_RPC_URL',
  'RPC_INTERNAL_TOKEN',
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
]);

/** Redacted snapshot, safe to emit in the boot log. */
export function describeConfig(e: ProxyEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (SECRET_KEYS.has(k)) out[k] = v ? '[set]' : '[unset]';
    else if (Array.isArray(v)) out[k] = v.map(String);
    else out[k] = v;
  }
  return out;
}

/** Host of the upstream, for logs. The path and query (the key) are dropped. */
export function upstreamHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}
