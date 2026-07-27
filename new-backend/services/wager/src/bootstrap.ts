/**
 * Composition root. Everything is wired as an interface at the point of use, so
 * tests can substitute a fake chain client without touching the services.
 */
import { createHmac } from 'node:crypto';
import { describeEnv, env as loadServiceEnv, type WagerEnv } from './config/env.js';
import { initKeys, type ServiceKeys } from './config/keys.js';
import { log } from './platform/logger.js';
import { RpcProxyClient } from './chain/rpcProxyClient.js';
import { EvmSender } from './chain/evmSender.js';
import { UnavailableTicketMinter } from './chain/ticketMinter.js';
import { StakePolicy } from './domain/stakes.js';
import type { EscrowServiceDeps } from './services/escrowService.js';
import type { BoosterServiceDeps } from './services/boosterService.js';
import type { PayoutRunnerDeps } from './services/payoutRunner.js';
import type { SettlementWorkerDeps } from './worker/settlementWorker.js';

export interface Wiring {
  env: WagerEnv;
  keys: ServiceKeys;
  escrowDeps: EscrowServiceDeps;
  boosterDeps: BoosterServiceDeps;
  workerDeps: SettlementWorkerDeps;
}

export function wire(envOverride?: WagerEnv): Wiring {
  const env = envOverride ?? loadServiceEnv();
  // Fails startup when the escrow and treasury keys are the same (H-4).
  const keys = initKeys(env);

  log().info('wager_config_loaded', {
    escrow_address: keys.escrowAddress,
    treasury_address: keys.treasuryAddress,
    config: describeEnv(env),
  });

  const reader = new RpcProxyClient({
    baseUrl: env.RPC_PROXY_URL,
    internalToken: env.RPC_PROXY_INTERNAL_TOKEN,
    timeoutMs: env.RPC_PROXY_TIMEOUT_MS,
  });

  const sender = new EvmSender({
    submitRpcUrl: env.EVM_SUBMIT_RPC_URL,
    chainId: env.EVM_CHAIN_ID,
    account: keys.escrow,
    token: env.WAGER_TOKEN_ADDRESS,
    reader,
    gasLimit: BigInt(env.WAGER_GAS_LIMIT),
    feeBumpPercent: env.WAGER_FEE_BUMP_PERCENT,
  });

  const payout: PayoutRunnerDeps = {
    reader,
    sender,
    leaseSeconds: Math.ceil(env.SETTLEMENT_LEASE_MS / 1000),
    confirmTimeoutMs: env.SETTLEMENT_CONFIRM_TIMEOUT_MS,
    confirmPollMs: 2_000,
  };

  const escrowDeps: EscrowServiceDeps = {
    reader,
    payout,
    stakes: new StakePolicy(env.WAGER_STAKE_TIERS_BASE),
    token: env.WAGER_TOKEN_ADDRESS,
    decimals: env.WAGER_TOKEN_DECIMALS,
    // Recorded on every new escrow, so verification always compares against the
    // address that escrow was created with rather than current configuration.
    depositAddress: keys.escrowAddress,
    minConfirmations: env.EVM_MIN_CONFIRMATIONS,
    depositTxTimeoutSeconds: Math.ceil(env.RPC_PROXY_TIMEOUT_MS / 1000) + 10,
  };

  const boosterDeps: BoosterServiceDeps = {
    reader,
    // TODO: chain integration pending — see chain/ticketMinter.ts.
    minter: new UnavailableTicketMinter(),
    treasuryAddress: keys.treasuryAddress,
    priceWei: env.BOOSTER_PRICE_WEI,
    minConfirmations: env.EVM_MIN_CONFIRMATIONS,
    supplyCap: env.BOOSTER_SUPPLY_CAP,
    intentTtlSeconds: env.BOOSTER_INTENT_TTL_SECONDS,
    cardPool: env.BOOSTER_CARD_POOL,
    // Derived, so there is no extra secret to manage, and never equal to the
    // seed secret itself.
    packSecret: createHmac('sha256', env.BOOSTER_PACK_SEED_SECRET).update('pack-roll').digest('hex'),
  };

  const workerDeps: SettlementWorkerDeps = {
    payout,
    hmacSecret: env.MATCH_RESULT_HMAC_SECRET,
    burnBps: env.WAGER_BURN_BPS,
    burnAddress: env.WAGER_BURN_ADDRESS,
    batchSize: env.SETTLEMENT_BATCH,
    pollMs: env.SETTLEMENT_POLL_MS,
  };

  return { env, keys, escrowDeps, boosterDeps, workerDeps };
}
