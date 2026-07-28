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
  /**
   * Shown in the wallet prompt when an already-signed-in player links an
   * ADDITIONAL wallet. It must differ from `AUTH_STATEMENT`: the user has to be
   * able to tell "log me in" from "attach this wallet to my account", because
   * the second one hands over the collection derived from that wallet. The
   * server enforces the distinction independently via `auth.nonces.purpose`
   * (migration 0013) — this string is what makes it visible to the human.
   */
  AUTH_LINK_STATEMENT: z
    .string()
    .min(1)
    .max(200)
    .default('Link this wallet to your Chains TCG profile.'),

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

  /* ---------------------------------------------------------------------- */
  /* Smart-account (ERC-1271 / ERC-6492) signature verification              */
  /* ---------------------------------------------------------------------- */

  /**
   * Master switch for the on-chain verification path. `false` makes the auth
   * service EOA-only again — every dependency on an outbound RPC disappears
   * from the login path, at the cost of turning away smart accounts. It exists
   * so an RPC incident can be contained by a config change rather than a code
   * change, and so a deployment that has no outbound network can say so.
   */
  AUTH_SMART_ACCOUNT_LOGIN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * Robinhood Chain's public, keyless endpoint. Deliberately NOT the Alchemy
   * URL in `contracts/deployment.json`: that key is committed to the repo and
   * is being rotated, and a credential does not belong on an unauthenticated
   * code path in any case. Left out of any redaction list on purpose (same
   * reasoning as `CARD_PACK_RPC_URL` in the wager service) — the value must
   * stay auditable so nobody quietly swaps in a credentialed URL.
   */
  AUTH_EVM_RPC_URL: z.string().url().default('https://rpc.mainnet.chain.robinhood.com'),

  /**
   * The ONLY chain id this service will verify a contract signature against.
   * An ERC-1271 check is a call to a specific address on a specific chain; the
   * same address on a different chain is a different contract, or nothing at
   * all. If the endpoint's `eth_chainId` does not equal this, the verifier
   * refuses rather than believing an answer from the wrong network.
   */
  AUTH_EVM_CHAIN_ID: z.coerce.number().int().positive().default(4663),

  /**
   * Wall-clock budget for one RPC round trip. Short on purpose: this sits in
   * the middle of an unauthenticated login request, so a slow endpoint must
   * become a fast 503 rather than a pile of held-open sockets.
   */
  AUTH_EVM_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),

  /* --- Buckets that guard the RPC specifically ---------------------------- */
  /*
   * `/auth/verify` is public, so making it perform an outbound RPC call turns
   * it into an amplification lever: one cheap request in, one request to a
   * third party out. These three buckets are consumed ONLY when a request is
   * about to reach the chain — i.e. after cheap ECDSA verification has already
   * failed — so an ordinary EOA login never touches them.
   */
  /** Per caller IP. */
  AUTH_RL_ONCHAIN_IP_LIMIT: z.coerce.number().int().min(1).default(5),
  AUTH_RL_ONCHAIN_IP_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
  /** Per claimed wallet address, so a botnet cannot spread the cost. */
  AUTH_RL_ONCHAIN_ADDRESS_LIMIT: z.coerce.number().int().min(1).default(3),
  AUTH_RL_ONCHAIN_ADDRESS_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
  /**
   * Service-wide ceiling. The per-IP and per-address buckets bound one
   * attacker; this one bounds every attacker at once and is what actually
   * protects the public endpoint we do not own.
   */
  AUTH_RL_ONCHAIN_GLOBAL_LIMIT: z.coerce.number().int().min(1).default(60),
  AUTH_RL_ONCHAIN_GLOBAL_WINDOW_SEC: z.coerce.number().int().min(1).default(60),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

export const env: AuthEnv = loadEnv(authEnvSchema, { serviceName: 'auth' });
