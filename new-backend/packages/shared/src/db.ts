/**
 * The single Postgres pool.
 *
 * There is deliberately **no in-memory fallback**. The previous backend kept a
 * `Map` around for when the database was unreachable, which meant idempotency
 * guards silently stopped being idempotent (audit finding H-3). Here a
 * connection failure throws, `readyCheck()` fails, and the container is marked
 * unhealthy and restarted.
 */
import pg from 'pg';
import type { Logger } from './log.js';

const { Pool } = pg;
export type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * pg parses `bigint` (OID 20) into a JS string by default to avoid precision
 * loss. We keep that, and expose helpers instead of switching it off — ids and
 * `amount_base` values must never round.
 */
export interface DbOptions {
  connectionString?: string;
  max?: number;
  ssl?: 'disable' | 'require' | 'no-verify';
  statementTimeoutMs?: number;
  logger?: Logger;
}

let pool: pg.Pool | null = null;
let poolLogger: Logger | null = null;

function sslConfig(mode: DbOptions['ssl']): pg.PoolConfig['ssl'] {
  switch (mode) {
    case 'require':
      return { rejectUnauthorized: true };
    case 'no-verify':
      return { rejectUnauthorized: false };
    default:
      return undefined;
  }
}

/**
 * Create the process-wide pool. Call once at startup. Idempotent — subsequent
 * calls return the existing pool.
 */
export function initDb(options: DbOptions = {}): pg.Pool {
  if (pool) return pool;

  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    // Not a warning, not a fallback. Nothing works without a database.
    throw new Error('DATABASE_URL is not set — refusing to start without a database');
  }

  poolLogger = options.logger ?? null;

  const config: pg.PoolConfig = {
    connectionString,
    max: options.max ?? Number(process.env.PGPOOL_MAX ?? 10),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: process.env.SERVICE_NAME ?? 'chains-backend',
  };

  const ssl = sslConfig(options.ssl ?? (process.env.PGSSL as DbOptions['ssl']));
  if (ssl) config.ssl = ssl;

  const timeout = options.statementTimeoutMs ?? Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000);
  if (timeout > 0) config.statement_timeout = timeout;

  pool = new Pool(config);

  // An idle client erroring out (server restart, network blip) must be visible.
  pool.on('error', (err) => {
    poolLogger?.error('pg_pool_error', { err_message: err.message });
  });

  return pool;
}

/** The pool, or a thrown error if `initDb` has not run. */
export function getPool(): pg.Pool {
  if (!pool) {
    throw new Error('Database pool not initialised — call initDb() during startup');
  }
  return pool;
}

/** One-shot parameterised query. Never interpolate values into `text`. */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<pg.QueryResult<R>> {
  return getPool().query<R>(text, params as unknown[] | undefined);
}

/** First row or `undefined`. */
export async function queryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<R | undefined> {
  const res = await query<R>(text, params);
  return res.rows[0];
}

/**
 * Run `fn` inside BEGIN/COMMIT with a dedicated client, rolling back on any
 * throw. Every money-touching write path must use this, together with
 * `SELECT … FOR UPDATE` on the row being spent (audit finding M-2).
 *
 *     await withTransaction(async (tx) => {
 *       const { rows } = await tx.query('select … from wager.escrows where id=$1 for update', [id]);
 *       …
 *     });
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  options: { isolation?: 'read committed' | 'repeatable read' | 'serializable' } = {},
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(
      options.isolation ? `BEGIN ISOLATION LEVEL ${options.isolation.toUpperCase()}` : 'BEGIN',
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it below discards it.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Dependency check for `/readyz`. Throws on any failure — the caller turns that
 * into a 503 and the orchestrator restarts the container.
 */
export async function readyCheck(): Promise<void> {
  if (!pool) throw new Error('database pool not initialised');
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

/** Graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/** True when the SQLSTATE is a unique-violation — the idempotency guard firing. */
export function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23505');
}

/** True when the SQLSTATE is a foreign-key violation. */
export function isForeignKeyViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '23503');
}
