// Postgres connection pool. DATABASE_URL is injected by docker-compose;
// the default targets a local postgres for no-docker development.
import { Pool } from 'pg';

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://chains:chains@localhost:5432/chains',
});

pool.on('error', err => {
  console.error('[db] idle client error', err);
});
