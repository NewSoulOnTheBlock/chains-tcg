/**
 * The rate limit that guards the outbound RPC call.
 *
 * ── The problem this exists for ────────────────────────────────────────────
 *
 * `POST /auth/verify` is PUBLIC. Adding an on-chain verification step to it
 * turns it into an amplification lever: one unauthenticated HTTP request in,
 * one `eth_call` out to `rpc.mainnet.chain.robinhood.com` — an endpoint we do
 * not own, do not pay for, and can be rate-limited or blocked from. A single
 * attacker who can send 1000 req/s at us can send 1000 req/s at Robinhood with
 * our IP on it, and the failure mode is that OUR logins stop working.
 *
 * The gateway's `/auth/` bucket (5 r/min per IP) and the existing per-address
 * bucket already bound this. They are not enough on their own: they are per-IP,
 * so a botnet defeats them, and they are shared with the ordinary EOA login
 * path, so tightening them to protect the RPC would punish the 99% of logins
 * that never make one.
 *
 * ── The shape of the answer ────────────────────────────────────────────────
 *
 * Three Redis token buckets, consumed at the moment a request is about to
 * reach the chain and at no other time:
 *
 *   per IP        bounds one host
 *   per address   bounds one wallet across many hosts (the botnet case)
 *   global        bounds EVERY caller at once — the ceiling that actually
 *                 protects the third-party endpoint, since the first two are
 *                 per-subject and an attacker chooses the number of subjects
 *
 * The order matters: the two narrow buckets are consumed first, so a legitimate
 * user who is about to be told "no" by the global ceiling has already been
 * charged for their own share and cannot spin.
 *
 * Because the budget is a REQUIRED argument of `verifyWalletSignature`, an
 * on-chain verification that forgot to charge it is a type error rather than a
 * missing line — the same reasoning as the `route()` helper refusing to
 * register a route with no auth declaration.
 */
import { AppError, tokenBucket } from '@chains/shared';
import { env } from '../env.js';

export interface OnChainBudget {
  /**
   * Charge for one chain round trip. Throws `AppError.rateLimited` when the
   * caller (or the service as a whole) has spent its allowance.
   */
  consume(): Promise<void>;
}

interface BucketSpec {
  key: string;
  limit: number;
  windowSec: number;
  scope: string;
}

async function spend(spec: BucketSpec): Promise<void> {
  const result = await tokenBucket(spec.key, spec.limit, spec.windowSec, 1);
  if (!result.allowed) {
    const retry = Math.max(1, result.retryAfterSec);
    throw AppError.rateLimited(
      'Too many smart-account verification attempts — retry shortly',
      { reason: 'onchain_verification_rate_limited', scope: spec.scope, retryAfterSec: retry },
    );
  }
}

/**
 * The production budget: per-IP, per-address and service-wide.
 *
 * `clientIp` comes from `clientIp(req)` — i.e. `req.ip` with `trust proxy`
 * configured for exactly one hop — so it is the gateway's view of the caller,
 * not a header the caller controls.
 */
export function redisOnChainBudget(input: {
  clientIp: string;
  chain: string;
  address: string;
}): OnChainBudget {
  return {
    async consume(): Promise<void> {
      await spend({
        key: `rl:auth:onchain:ip:${input.clientIp}`,
        limit: env.AUTH_RL_ONCHAIN_IP_LIMIT,
        windowSec: env.AUTH_RL_ONCHAIN_IP_WINDOW_SEC,
        scope: 'ip',
      });
      await spend({
        key: `rl:auth:onchain:addr:${input.chain}:${input.address}`,
        limit: env.AUTH_RL_ONCHAIN_ADDRESS_LIMIT,
        windowSec: env.AUTH_RL_ONCHAIN_ADDRESS_WINDOW_SEC,
        scope: 'address',
      });
      await spend({
        key: 'rl:auth:onchain:global',
        limit: env.AUTH_RL_ONCHAIN_GLOBAL_LIMIT,
        windowSec: env.AUTH_RL_ONCHAIN_GLOBAL_WINDOW_SEC,
        scope: 'service',
      });
    },
  };
}

/**
 * A budget that refuses every chain call.
 *
 * Use where a chain call would be wrong rather than merely expensive. Not a
 * default anywhere: a caller must choose it explicitly.
 */
export const noOnChainBudget: OnChainBudget = {
  async consume(): Promise<void> {
    throw AppError.unauthorized('Signature verification failed');
  },
};
