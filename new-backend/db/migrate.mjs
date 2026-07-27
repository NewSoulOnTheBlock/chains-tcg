#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Rules:
 *   - Files in `db/migrations` named `NNNN_name.sql` are applied in filename
 *     order, each inside its own transaction. A failing file rolls back and
 *     stops the run; it is never half-applied.
 *   - Applied files are recorded in `public.schema_migrations` with a SHA-256
 *     checksum. Re-running is a no-op (idempotent).
 *   - Editing an already-applied migration is refused: the checksum mismatch
 *     aborts the run rather than silently diverging environments. Fix forward
 *     with a new file.
 *   - A session-level advisory lock serialises concurrent runners, so two
 *     `migrate` containers racing at boot cannot both apply the same file.
 *
 * There is no `CREATE TABLE IF NOT EXISTS` anywhere in the services. Schema
 * changes happen here or not at all.
 *
 * Usage:  node db/migrate.mjs [--dry-run] [--status]
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.join(HERE, 'migrations');

/** Arbitrary but fixed — all runners must agree on it. */
const ADVISORY_LOCK_KEY = 8_142_596_301_774_233n % 9223372036854775807n;

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const STATUS_ONLY = args.has('--status');

function log(level, msg, fields = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, service: 'migrate', ...fields }) + '\n',
  );
}

function die(msg, fields = {}) {
  process.stderr.write(
    JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg, service: 'migrate', ...fields }) + '\n',
  );
  process.exit(1);
}

const FILENAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

async function loadMigrations() {
  let entries;
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch (err) {
    die('cannot read migrations directory', { dir: MIGRATIONS_DIR, err_message: err.message });
  }

  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  const seenOrdinals = new Map();
  const migrations = [];
  for (const file of files) {
    const match = FILENAME_RE.exec(file);
    if (!match) {
      die('migration filename must match NNNN_lower_snake.sql', { file });
    }
    const ordinal = match[1];
    if (seenOrdinals.has(ordinal)) {
      die('duplicate migration ordinal', { ordinal, files: [seenOrdinals.get(ordinal), file] });
    }
    seenOrdinals.set(ordinal, file);

    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    migrations.push({
      version: file,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    });
  }
  return migrations;
}

async function ensureLedger(client) {
  // The ledger itself is the one thing that may use IF NOT EXISTS — it has to
  // bootstrap before any migration can be recorded.
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version      text        PRIMARY KEY,
      checksum     text        NOT NULL,
      applied_at   timestamptz NOT NULL DEFAULT now(),
      duration_ms  integer     NOT NULL DEFAULT 0
    )
  `);
}

async function waitForDatabase(connectionString, attempts = 30, delayMs = 1000) {
  for (let i = 1; i <= attempts; i += 1) {
    const probe = new pg.Client({ connectionString, connectionTimeoutMillis: 3000 });
    try {
      await probe.connect();
      await probe.query('SELECT 1');
      await probe.end();
      return;
    } catch (err) {
      await probe.end().catch(() => {});
      if (i === attempts) {
        die('database unreachable', { attempts, err_message: err.message });
      }
      log('info', 'waiting_for_database', { attempt: i, of: attempts });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    die('DATABASE_URL is not set');
  }

  const migrations = await loadMigrations();
  log('info', 'migrations_discovered', { count: migrations.length, dir: MIGRATIONS_DIR });

  await waitForDatabase(connectionString);

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    // Serialise concurrent runners for the whole session.
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY.toString()]);
    await ensureLedger(client);

    const { rows: appliedRows } = await client.query(
      'SELECT version, checksum FROM public.schema_migrations',
    );
    const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]));

    if (STATUS_ONLY) {
      for (const m of migrations) {
        const state = !applied.has(m.version)
          ? 'pending'
          : applied.get(m.version) === m.checksum
            ? 'applied'
            : 'CHECKSUM MISMATCH';
        log('info', 'migration_status', { version: m.version, state });
      }
      return;
    }

    // Any drift in an already-applied file is fatal — environments must not
    // diverge silently.
    for (const m of migrations) {
      const knownChecksum = applied.get(m.version);
      if (knownChecksum !== undefined && knownChecksum !== m.checksum) {
        die('checksum mismatch for an already-applied migration; fix forward with a new file', {
          version: m.version,
          applied_checksum: knownChecksum,
          file_checksum: m.checksum,
        });
      }
    }

    // A version in the database with no file usually means a rollback of code
    // without a rollback of the schema. Warn, do not fail.
    for (const version of applied.keys()) {
      if (!migrations.some((m) => m.version === version)) {
        log('warn', 'applied_migration_has_no_file', { version });
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.version));
    if (pending.length === 0) {
      log('info', 'nothing_to_apply', { applied: applied.size });
      return;
    }

    for (const m of pending) {
      if (DRY_RUN) {
        log('info', 'would_apply', { version: m.version });
        continue;
      }

      const startedAt = Date.now();
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        const durationMs = Date.now() - startedAt;
        await client.query(
          'INSERT INTO public.schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
          [m.version, m.checksum, durationMs],
        );
        await client.query('COMMIT');
        log('info', 'migration_applied', { version: m.version, duration_ms: durationMs });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        die('migration failed and was rolled back', {
          version: m.version,
          sqlstate: err.code,
          err_message: err.message,
          detail: err.detail,
          position: err.position,
        });
      }
    }

    log('info', 'migrations_complete', { applied: pending.length });
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY.toString()]).catch(() => {});
    await client.end().catch(() => {});
  }
}

main().catch((err) => die('migrate_crashed', { err_message: err.message, stack: err.stack }));
