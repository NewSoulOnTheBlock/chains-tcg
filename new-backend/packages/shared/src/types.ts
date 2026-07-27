/**
 * Express request augmentation. Importing `@chains/shared` anywhere in a
 * service brings these properties into scope.
 */
import type { AuthContext } from './auth.js';
import type { Logger } from './log.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Per-request id, echoed to the client as `x-request-id`. */
      id: string;
      /** Logger bound to `request_id`. */
      log: Logger;
      /**
       * Present only after `requireAuth()` (or `optionalAuth()`) has run.
       * This is the ONLY source of identity. A `name`, `wallet`, `playerID`
       * or `profileId` in a body or query string is data, never identity.
       */
      auth?: AuthContext;
      /** Outputs of `validateBody` / `validateQuery` / `validateParams`. */
      valid: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

export {};
