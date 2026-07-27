/** Postgres error helpers. Constraint violations are the primary control flow
 *  for idempotency here, so they are matched precisely rather than by message. */

export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const CHECK_VIOLATION = '23514';

interface PgErrorish {
  code?: string;
  constraint?: string;
}

function asPgError(err: unknown): PgErrorish | null {
  if (err && typeof err === 'object' && 'code' in err) return err as PgErrorish;
  return null;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = asPgError(err);
  if (!e || e.code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || e.constraint === constraint;
}

export function violatedConstraint(err: unknown): string | null {
  const e = asPgError(err);
  return e?.constraint ?? null;
}

export function isCheckViolation(err: unknown): boolean {
  return asPgError(err)?.code === CHECK_VIOLATION;
}
