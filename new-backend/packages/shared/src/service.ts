/**
 * Common service bootstrap, so every service in this backend behaves the same
 * way without five copies of the same forty lines.
 *
 * What it guarantees:
 *   - JSON body cap matching the gateway's 256 KB `client_max_body_size`
 *   - `x-request-id` on every response, structured request logs
 *   - `/healthz` (liveness) and `/readyz` (Postgres + Redis reachable)
 *   - **hard exit** if a declared dependency is unreachable at startup — no
 *     degraded mode, no in-memory fallback (audit finding H-3)
 *   - the error envelope and 404 handler wired in the right order
 *   - graceful shutdown on SIGTERM/SIGINT
 *
 * What it deliberately does NOT do: set CORS headers. The gateway is the single
 * CORS layer; a service adding its own would produce duplicate
 * `Access-Control-Allow-Origin` values, which browsers reject outright.
 */
import type { Server } from 'node:http';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import { configureAuth, route } from './auth.js';
import { closeDb, initDb, readyCheck as dbReadyCheck } from './db.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { createLogger, requestContext, type LogLevel, type Logger } from './log.js';
import { closeRedis, initRedis, readyCheck as redisReadyCheck } from './redis.js';

export interface ServiceDeps {
  postgres?: boolean;
  redis?: boolean;
}

export interface ServiceOptions {
  /** Appears in every log line and in `application_name` on Postgres. */
  name: string;
  port: number;
  deps?: ServiceDeps;
  /** Default '256kb' — keep in step with gateway `client_max_body_size`. */
  bodyLimit?: string;
  logLevel?: LogLevel;
  trustProxyHops?: number;
  shutdownGraceMs?: number;
  /** Extra checks for `/readyz`, run after the db/redis probes. */
  extraReadyChecks?: Array<() => Promise<void>>;
}

export interface ServiceContext {
  app: Express;
  logger: Logger;
  options: Required<Pick<ServiceOptions, 'name' | 'port'>> & ServiceOptions;
}

export interface RunningService extends ServiceContext {
  server: Server;
  close(): Promise<void>;
}

/** Defence-in-depth headers. The gateway sets the browser-facing policy. */
function securityHeaders(): RequestHandler {
  return (_req: Request, res: Response, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // API responses are per-caller; never let a shared cache hold one.
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

/**
 * Build the Express app with the standard middleware stack. Routes are mounted
 * by the caller; `finalizeApp` must be called afterwards.
 */
export function createApp(options: ServiceOptions, logger: Logger): Express {
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');
  // Needed for a correct `req.ip` behind the gateway, which is what the
  // per-IP token buckets key on.
  app.set('trust proxy', options.trustProxyHops ?? Number(process.env.TRUST_PROXY_HOPS ?? 1));

  app.use(requestContext(logger));
  app.use(securityHeaders());
  app.use(express.json({ limit: options.bodyLimit ?? '256kb', strict: true }));

  const deps = options.deps ?? {};

  route(app, {
    method: 'get',
    path: '/healthz',
    public: true,
    summary: 'liveness — process is up',
    handler: (_req, res) => {
      res.json({ status: 'ok', service: options.name });
    },
  });

  route(app, {
    method: 'get',
    path: '/readyz',
    public: true,
    summary: 'readiness — dependencies reachable',
    handler: async (req, res) => {
      const checks: Record<string, 'ok' | 'fail'> = {};
      let healthy = true;

      if (deps.postgres) {
        try {
          await dbReadyCheck();
          checks.postgres = 'ok';
        } catch (err) {
          checks.postgres = 'fail';
          healthy = false;
          req.log.error('readyz_postgres_failed', { err_message: (err as Error).message });
        }
      }
      if (deps.redis) {
        try {
          await redisReadyCheck();
          checks.redis = 'ok';
        } catch (err) {
          checks.redis = 'fail';
          healthy = false;
          req.log.error('readyz_redis_failed', { err_message: (err as Error).message });
        }
      }
      for (const [i, check] of (options.extraReadyChecks ?? []).entries()) {
        try {
          await check();
          checks[`extra_${i}`] = 'ok';
        } catch (err) {
          checks[`extra_${i}`] = 'fail';
          healthy = false;
          req.log.error('readyz_extra_failed', { index: i, err_message: (err as Error).message });
        }
      }

      res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', service: options.name, checks });
    },
  });

  return app;
}

/** Attach the 404 and error handlers. Call after all routes are mounted. */
export function finalizeApp(app: Express, logger: Logger): void {
  app.use(notFoundHandler());
  app.use(errorHandler(logger));
}

/**
 * Full startup: connect dependencies, verify them, mount routes, listen, and
 * install signal handlers.
 *
 *     await startService({ name: 'auth', port: 4001, deps: { postgres: true, redis: true } },
 *                        ({ app }) => mountAuthRoutes(app));
 */
export async function startService(
  options: ServiceOptions,
  mount: (ctx: ServiceContext) => void | Promise<void>,
): Promise<RunningService> {
  const logger = createLogger({
    service: options.name,
    level: options.logLevel ?? (process.env.LOG_LEVEL as LogLevel | undefined),
  });

  process.env.SERVICE_NAME ??= options.name;

  // Any unhandled fault is a bug; crash rather than continue in an unknown state.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { err_message: String(reason) });
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught_exception', { err_message: err.message, stack: err.stack });
    process.exit(1);
  });

  const deps = options.deps ?? {};

  try {
    configureAuth({});
    if (deps.postgres) {
      initDb({ logger });
      await dbReadyCheck();
      logger.info('postgres_connected');
    }
    if (deps.redis) {
      await initRedis({ logger });
      await redisReadyCheck();
      logger.info('redis_connected');
    }
  } catch (err) {
    // No fallback. A service without its dependencies must not accept traffic.
    logger.error('startup_failed', { err_message: (err as Error).message });
    process.exit(1);
  }

  const app = createApp(options, logger);
  const ctx: ServiceContext = { app, logger, options: { ...options, name: options.name, port: options.port } };
  await mount(ctx);
  finalizeApp(app, logger);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(options.port, '0.0.0.0', () => resolve(s));
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  logger.info('listening', { port: options.port });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    const graceMs = options.shutdownGraceMs ?? Number(process.env.SHUTDOWN_GRACE_MS ?? 10_000);
    logger.info('shutdown_started');

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs).unref();
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await Promise.allSettled([closeDb(), closeRedis()]);
    logger.info('shutdown_complete');
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void close().then(() => process.exit(0));
    });
  }

  return { ...ctx, server, close };
}
