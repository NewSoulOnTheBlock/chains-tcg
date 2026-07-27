/**
 * THE ONLY SEAM onto `@chains/shared`.
 *
 * Every other module in this service imports its platform primitives from here,
 * so a change in the shared package's surface is a one-file reconciliation
 * rather than a hundred-import sweep.
 */
export {
  AppError,
  asyncHandler,
  isUniqueViolation,
  isForeignKeyViolation,
  createLogger,
  getPool,
  getRedis,
  initDb,
  initRedis,
  loadEnv,
  query,
  queryOne,
  rateLimit,
  requireAuth,
  requireRole,
  route,
  routes,
  registeredRoutes,
  resetRouteRegistry,
  serviceEnvShape,
  startService,
  strictBody,
  tokenBucket,
  validateBody,
  validateParams,
  validateQuery,
  validatedBody,
  validatedParams,
  validatedQuery,
  withTransaction,
  z,
} from '@chains/shared';

export type {
  AuthContext,
  Logger,
  Pool,
  PoolClient,
  RouteDefinition,
  ServiceContext,
} from '@chains/shared';

import { AppError, type AuthContext } from '@chains/shared';
import type { Request } from 'express';

/**
 * Identity accessor. Handlers read the caller through this and never through
 * `req.body` — the C-3 rule, enforced at the point of use.
 *
 * `requireAuth()` has already populated `req.auth`; if it somehow has not, we
 * fail closed rather than proceeding with an undefined caller.
 */
export function callerOf(req: Request): AuthContext {
  const auth = req.auth;
  if (!auth || typeof auth.profileId !== 'string' || auth.profileId.length === 0) {
    throw AppError.unauthorized('Authentication required');
  }
  return auth;
}

export function isOperator(auth: AuthContext): boolean {
  return Array.isArray(auth.roles) && auth.roles.includes('operator');
}

/**
 * Attach a machine-readable reason to an `AppError`.
 *
 * The shared envelope's `code` is a fixed, small enum (`conflict`,
 * `bad_request`, …) so that clients can branch on transport semantics. The
 * specific cause — `seat_already_funded`, `deposit_wrong_amount` — travels in
 * `details.reason`, which keeps both stable.
 */
export function reasoned(err: AppError, reason: string, extra?: Record<string, unknown>): AppError {
  const details =
    err.details && typeof err.details === 'object' ? (err.details as Record<string, unknown>) : {};
  return new AppError(err.code, err.message, { ...details, reason, ...(extra ?? {}) });
}
