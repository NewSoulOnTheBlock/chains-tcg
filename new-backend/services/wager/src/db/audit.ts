/**
 * Append-only operator audit trail (`core.audit_log`, migration 0006).
 *
 * Privileged actions write here in the SAME transaction as the effect they
 * describe, so the log cannot drift from reality. There is deliberately no
 * update or delete path in this module.
 *
 * `actor_*` always come from `req.auth`, never from a request body.
 */
import type { Pool, PoolClient } from 'pg';

export interface AuditEntry {
  actorProfileId: string;
  actorAddress: string;
  actorRoles: string[];
  /** Dotted verb, e.g. `wager.void`. */
  action: string;
  /** Identifier of the affected row, e.g. the escrow id. */
  subject: string;
  reason: string;
  details?: Record<string, unknown>;
  /** `x-request-id`, to tie this row to the structured logs. */
  requestId?: string;
}

export async function appendAudit(q: Pool | PoolClient, entry: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO core.audit_log
       (actor_profile_id, actor_address, actor_roles, action, subject, reason, details, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      entry.actorProfileId,
      entry.actorAddress,
      entry.actorRoles,
      entry.action,
      entry.subject,
      entry.reason,
      JSON.stringify(entry.details ?? {}),
      entry.requestId ?? null,
    ],
  );
}
