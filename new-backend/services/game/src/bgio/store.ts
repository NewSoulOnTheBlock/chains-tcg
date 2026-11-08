import { PostgresStore } from 'bgio-postgres';
import { createLogger } from '@chains/shared';
import { config } from '../config.js';

const log = createLogger({ service: 'game' }).child({ component: 'bgio-store' });

/**
 * boardgame.io's own match storage (its `Games` table: state, log, metadata).
 *
 * This is NOT the lobby. The lobby lives in `game.matches`, which migrations
 * own; this table is an opaque vendor store that only boardgame.io and the
 * authoritative-result writer read.
 *
 * DDL CAVEAT (documented deviation from "migrations only"): `PostgresStore
 * .connect()` calls `sequelize.sync()`, which issues `CREATE TABLE IF NOT
 * EXISTS "Games"`. That is vendor-internal and unavoidable short of forking the
 * adapter. It is confined to the dedicated `BGIO_SCHEMA` (default `bgio`),
 * which a migration must create — we never create the schema ourselves, so if
 * the migration has not run the service fails to boot instead of silently
 * writing into `public`.
 */
/**
 * Mirror the shared pool's `sslConfig()` so the connection carrying live match
 * state has the SAME TLS guarantee as every other connection to this database
 * (server-29). Previously every non-'disable' value mapped to
 * rejectUnauthorized:false, so `PGSSL=require` silently got UNVERIFIED TLS here
 * while the shared pool verified the CA.
 *   disable   -> no TLS
 *   require   -> TLS, verify the CA
 *   no-verify -> TLS, do not verify the CA
 */
function bgioDialectOptions(): Record<string, unknown> {
  switch (config.PGSSL) {
    case 'disable':
      return {};
    case 'no-verify':
      return { ssl: { require: true, rejectUnauthorized: false } };
    case 'require':
    default:
      return { ssl: { require: true, rejectUnauthorized: true } };
  }
}

export const store = new PostgresStore(config.DATABASE_URL, {
  logging: false,
  define: { schema: config.BGIO_SCHEMA },
  dialectOptions: bgioDialectOptions(),
  pool: { max: 5, idle: 30_000, acquire: 10_000 },
});

export async function connectStore(): Promise<void> {
  await store.connect();
  log.info('boardgame.io store connected', { schema: config.BGIO_SCHEMA });
}

export async function closeStore(): Promise<void> {
  await store.sequelize.close();
}
