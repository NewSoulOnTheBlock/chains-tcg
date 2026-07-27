/**
 * THE ONLY SEAM onto `@chains/shared`.
 *
 * Every other module imports its platform primitives from here, so a change in
 * the shared package's surface is a one-file reconciliation.
 */
export {
  AppError,
  asyncHandler,
  clientIp,
  createLogger,
  getRedis,
  loadEnv,
  optionalAuth,
  rateLimit,
  registeredRoutes,
  resetRouteRegistry,
  route,
  serviceEnvShape,
  startService,
  strictBody,
  tokenBucket,
  validateBody,
  validatedBody,
  z,
} from '@chains/shared';

export type { AuthContext, Logger, ServiceContext } from '@chains/shared';
