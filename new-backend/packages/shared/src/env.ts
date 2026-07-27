/**
 * Environment loading. Two rules:
 *
 *  1. Every variable a service needs is declared in a zod schema.
 *  2. A missing or malformed variable is a **startup failure**, not a default.
 *     There is no `process.env.JWT_SECRET || 'dev-secret'` anywhere in this
 *     codebase — that pattern is how a staging secret becomes a production one.
 *
 * Non-secret ergonomic values (log level, pool size, port) may have defaults.
 * Secrets and connection strings may not.
 */
import { z } from 'zod';

/** Base shape every service shares. */
export const baseEnvShape = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Number of proxy hops to trust for `req.ip`. The gateway is one hop. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),
};

/** Postgres. No default — a missing DATABASE_URL must stop the process. */
export const postgresEnvShape = {
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (postgres://user:pass@host:5432/db)')
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'DATABASE_URL must start with postgres:// or postgresql://',
    }),
  PGPOOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  PGSSL: z
    .enum(['disable', 'require', 'no-verify'])
    .default('disable')
    .describe('require = verify CA; no-verify = TLS without CA validation'),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
};

/** Redis. No default — a missing REDIS_URL must stop the process. */
export const redisEnvShape = {
  REDIS_URL: z
    .string()
    .min(1, 'REDIS_URL is required (redis://host:6379)')
    .refine((v) => v.startsWith('redis://') || v.startsWith('rediss://'), {
      message: 'REDIS_URL must start with redis:// or rediss://',
    }),
};

/**
 * JWT. The secret is validated for length here so a weak HS256 key can never
 * reach production. 32 bytes is the minimum for HMAC-SHA256.
 */
export const jwtEnvShape = {
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters — generate with: openssl rand -hex 32'),
  JWT_ISSUER: z.string().min(1).default('chains-auth'),
  JWT_AUDIENCE: z.string().min(1).default('chains-api'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
};

/**
 * Operator allowlist. Comes from env and NEVER from the database, so a
 * database write can never grant privilege. Format: comma-separated
 * `chain:address` pairs, or bare addresses (matched on any chain).
 */
export const operatorEnvShape = {
  OPERATOR_ADDRESSES: z.string().default(''),
};

/** Everything a typical data-plane service needs. */
export const serviceEnvShape = {
  ...baseEnvShape,
  ...postgresEnvShape,
  ...redisEnvShape,
  ...jwtEnvShape,
  ...operatorEnvShape,
};

export type BaseEnv = z.infer<z.ZodObject<typeof baseEnvShape>>;
export type ServiceEnv = z.infer<z.ZodObject<typeof serviceEnvShape>>;

/** Structurally typed so this keeps compiling across zod majors. */
interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

function formatIssues(issues: readonly IssueLike[]): string {
  return issues
    .map((issue) => {
      const name = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `  - ${name}: ${issue.message}`;
    })
    .join('\n');
}

export interface LoadEnvOptions {
  /** Where to read from. Defaults to `process.env`. */
  source?: Record<string, string | undefined>;
  /** Shown in the failure banner. */
  serviceName?: string;
  /** Throw instead of calling `process.exit(1)` — used by tests. */
  throwOnError?: boolean;
}

/**
 * Parse and validate the environment, or die loudly.
 *
 *     const env = loadEnv(z.object({ ...serviceEnvShape, PORT: z.coerce.number().default(4001) }),
 *                        { serviceName: 'auth' });
 *
 * On failure this prints every offending variable and exits 1 — the container
 * then crash-loops visibly rather than booting in a half-configured state.
 */
export function loadEnv<T extends z.ZodType>(schema: T, options: LoadEnvOptions = {}): z.infer<T> {
  const source = options.source ?? process.env;
  const result = schema.safeParse(source);

  if (result.success) return result.data;

  const banner = options.serviceName
    ? `Invalid environment for service "${options.serviceName}"`
    : 'Invalid environment';
  const message = `${banner}:\n${formatIssues(result.error.issues)}\n\nSee new-backend/.env.example for every required variable.`;

  if (options.throwOnError) throw new Error(message);

  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
}

/**
 * Parse `OPERATOR_ADDRESSES` into a normalised set.
 * Accepts `solana:Abc…`, `ethereum:0x…` or a bare `0x…`.
 */
export function parseOperatorAddresses(raw: string): Set<string> {
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const idx = entry.indexOf(':');
    if (idx > 0) {
      const chain = entry.slice(0, idx).trim().toLowerCase();
      const address = entry.slice(idx + 1).trim();
      // EVM addresses are case-insensitive; Solana base58 is not.
      out.add(`${chain}:${address.startsWith('0x') ? address.toLowerCase() : address}`);
    } else {
      out.add(`*:${entry.startsWith('0x') ? entry.toLowerCase() : entry}`);
    }
  }
  return out;
}

/** True when `address` on `chain` is listed in OPERATOR_ADDRESSES. */
export function isOperatorAddress(operators: Set<string>, chain: string, address: string): boolean {
  const norm = address.startsWith('0x') ? address.toLowerCase() : address;
  return operators.has(`${chain.toLowerCase()}:${norm}`) || operators.has(`*:${norm}`);
}
