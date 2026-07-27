/**
 * Wager service environment.
 *
 * `serviceEnvShape` brings DATABASE_URL / REDIS_URL / JWT_SECRET / operator
 * allowlist; everything money-touching is declared below. A missing or
 * malformed variable stops the process — there are no defaults for secrets and
 * no fallbacks (ARCHITECTURE rule 4).
 *
 * Nothing in here is ever logged: `describeEnv()` returns a redacted view.
 */
import { loadEnv, serviceEnvShape, z } from '../platform/shared.js';

const evmAddress = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
  .transform((v) => v.toLowerCase());

export const wagerEnvSchema = z.object({
  ...serviceEnvShape,
  PORT: z.coerce.number().int().min(1).max(65_535).default(4004),

  /** Escrow signer (EVM private key) for wager payouts. */
  WAGER_ESCROW_KEYPAIR: z.string().min(1, 'WAGER_ESCROW_KEYPAIR is required'),
  /**
   * H-4: a SEPARATE key. The legacy booster mint fell back to
   * `CUSTODIAL_ESCROW_KEYPAIR` when this was unset, so one hot wallet held both
   * the players' escrowed stakes and the NFT mint authority. No fallback exists
   * here, and `loadKeys()` refuses two identical keys.
   */
  BOOSTER_TREASURY_KEYPAIR: z
    .string()
    .min(1, 'BOOSTER_TREASURY_KEYPAIR is required — it must not be the escrow key (H-4)'),

  /** Shared with the game service; authenticates `game.match_results` rows. */
  MATCH_RESULT_HMAC_SECRET: z
    .string()
    .min(32, 'MATCH_RESULT_HMAC_SECRET must be at least 32 characters'),
  /** Seeds the deterministic digital pack roll, so a retry re-rolls nothing. */
  BOOSTER_PACK_SEED_SECRET: z
    .string()
    .min(32, 'BOOSTER_PACK_SEED_SECRET must be at least 32 characters'),

  /** Read-only chain access. RPC credentials live in the proxy, never here (H-5). */
  RPC_PROXY_URL: z.string().url(),
  /** Optional: buys the higher internal rate-limit tier, grants no extra methods. */
  RPC_PROXY_INTERNAL_TOKEN: z.string().default(''),
  RPC_PROXY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(12_000),
  /**
   * Payout submission. The proxy refuses `eth_sendRawTransaction` by design, so
   * signed payouts are broadcast from this server-only endpoint.
   */
  EVM_SUBMIT_RPC_URL: z.string().url(),
  EVM_CHAIN_ID: z.coerce.number().int().positive(),
  EVM_MIN_CONFIRMATIONS: z.coerce.number().int().min(1).max(64).default(2),

  /** The ERC-20 the escrow accepts. */
  WAGER_TOKEN_ADDRESS: evmAddress,
  WAGER_TOKEN_DECIMALS: z.coerce.number().int().min(0).max(18).default(18),
  /** Where the protocol cut goes. Defaults to the standard burn sink. */
  WAGER_BURN_ADDRESS: evmAddress.default('0x000000000000000000000000000000000000dead'),
  /** Gas ceiling for one ERC-20 transfer, and the fee headroom multiplier. */
  WAGER_GAS_LIMIT: z.coerce.number().int().min(21_000).max(1_000_000).default(120_000),
  WAGER_FEE_BUMP_PERCENT: z.coerce.number().int().min(100).max(500).default(150),
  /**
   * Server-decided amount policy: the allowlist of stakes, in base units. The
   * client names a TIER INDEX; it can never name an amount.
   */
  WAGER_STAKE_TIERS_BASE: z
    .string()
    .regex(/^\d+(\s*,\s*\d+)*$/, 'comma-separated base-unit integers, e.g. "1000000,5000000"')
    .transform((raw) => raw.split(',').map((s) => BigInt(s.trim())))
    .refine((tiers) => tiers.length > 0 && tiers.every((t) => t > 0n), {
      message: 'every stake tier must be greater than zero',
    }),
  WAGER_BURN_BPS: z.coerce.number().int().min(0).max(10_000).default(1_000),

  /** Booster sale, priced in the native currency (wei). */
  BOOSTER_PRICE_WEI: z
    .string()
    .regex(/^[0-9]+$/, 'must be an integer number of wei')
    .default('3500000000000000')
    .transform((v) => BigInt(v))
    .refine((v) => v > 0n, { message: 'must be greater than zero' }),
  BOOSTER_SUPPLY_CAP: z.coerce.number().int().min(0).default(2_000),
  BOOSTER_INTENT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  /**
   * Card ids a digital redemption may roll. Empty means digital redemption is
   * unavailable and the route answers 503 rather than inventing card ids.
   *
   * It must STAY empty. Cards players actually hold come from the CardPack
   * ERC-721 below; a populated pool here would roll different cards from a
   * second, server-side source, and `core.card_ownership` cannot represent two
   * competing truths (see `db/ownership.ts`).
   */
  BOOSTER_CARD_POOL: z
    .string()
    .default('')
    .transform((raw) =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),

  /**
   * CardPack ERC-721 — the real source of card ownership.
   *
   * Empty address means ownership sync is unconfigured and the sync route
   * answers 503, the same shape as an unconfigured card pool. That is the safe
   * default: a service that cannot see the contract must not conclude that
   * players own nothing, because the reconcile is destructive.
   */
  CARD_PACK_ADDRESS: z
    .union([z.literal(''), evmAddress])
    .default(''),
  /**
   * Robinhood Chain. The reader refuses to read anything if the endpoint
   * answers with a different id, so this is a safety anchor, not a label.
   */
  CARD_PACK_CHAIN_ID: z.coerce.number().int().positive().default(4663),
  /**
   * Robinhood Chain's PUBLIC, KEYLESS JSON-RPC. Not a secret and not redacted:
   * there is no API key, no account and nothing to rotate, and it must stay
   * auditable precisely so that nobody swaps in a credentialed URL. The
   * rpc-proxy cannot serve this — it is pinned to a different network.
   */
  CARD_PACK_RPC_URL: z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),
  /**
   * Block CardPack was deployed at. Scanning below it only wastes requests, and
   * public nodes prune old state, so a lower bound is worth setting.
   */
  CARD_PACK_DEPLOY_BLOCK: z.coerce.number().int().min(0).default(0),
  /**
   * Blocks per `eth_getLogs` window, used only when the node refuses the whole
   * range in one request. The full span is always covered either way.
   */
  CARD_PACK_LOG_WINDOW: z.coerce.number().int().min(1_000).max(10_000_000).default(500_000),
  /** Bound on the `nextId` fallback scan. Exceeding it fails the sync, never truncates it. */
  CARD_PACK_MAX_TOKEN_SCAN: z.coerce.number().int().min(1).max(200_000).default(20_000),
  CARD_PACK_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),

  /** Settlement worker. */
  SETTLEMENT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SETTLEMENT_POLL_MS: z.coerce.number().int().min(500).max(300_000).default(5_000),
  SETTLEMENT_BATCH: z.coerce.number().int().min(1).max(100).default(10),
  /** How long a half-finished payout may sit before another worker reconciles it. */
  SETTLEMENT_LEASE_MS: z.coerce.number().int().min(10_000).max(600_000).default(90_000),
  SETTLEMENT_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(180_000).default(45_000),

  /** Per-profile rate limits: `limit` requests per `windowSec`. */
  WAGER_RATE_LIMIT: z.coerce.number().int().min(1).default(30),
  WAGER_RATE_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
});

export type WagerEnv = z.infer<typeof wagerEnvSchema>;

let cached: WagerEnv | null = null;

export function env(): WagerEnv {
  if (!cached) cached = loadEnv(wagerEnvSchema, { serviceName: 'wager' });
  return cached;
}

/** For tests: parse an arbitrary source without touching `process.env`. */
export function parseEnv(source: Record<string, string | undefined>): WagerEnv {
  return loadEnv(wagerEnvSchema, { source, serviceName: 'wager', throwOnError: true });
}

const SECRET_KEYS = new Set([
  'WAGER_ESCROW_KEYPAIR',
  'BOOSTER_TREASURY_KEYPAIR',
  'MATCH_RESULT_HMAC_SECRET',
  'BOOSTER_PACK_SEED_SECRET',
  'RPC_PROXY_INTERNAL_TOKEN',
  'RPC_PROXY_URL',
  'EVM_SUBMIT_RPC_URL',
  'DATABASE_URL',
  'REDIS_URL',
  'JWT_SECRET',
]);

/** Redacted snapshot, safe to emit in the boot log. */
export function describeEnv(e: WagerEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) {
    if (SECRET_KEYS.has(k)) out[k] = v ? '[set]' : '[unset]';
    else if (Array.isArray(v)) out[k] = v.map(String);
    else if (typeof v === 'bigint') out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}
