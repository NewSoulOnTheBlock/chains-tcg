-- 0006_audit_log.sql
-- Operator action log.
--
-- ARCHITECTURE.md: "the operator-only POST /wager/:id/void … requires the
-- operator role plus a reason string that is written to an audit log."
-- This is that log. It is append-only by convention; nothing in the services
-- issues UPDATE or DELETE against it.

CREATE TABLE core.audit_log (
    id               bigserial   PRIMARY KEY,
    actor_profile_id bigint      REFERENCES core.profiles(id),
    actor_address    text,
    actor_roles      text[]      NOT NULL DEFAULT '{}',
    action           text        NOT NULL,
    subject          text,
    reason           text,
    details          jsonb,
    request_id       text,
    created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.audit_log IS
    'Append-only record of privileged actions. actor_* come from req.auth, never from a request body.';
COMMENT ON COLUMN core.audit_log.action IS
    'Dotted verb, e.g. wager.void, profile.force_rename, booster.mark_failed.';
COMMENT ON COLUMN core.audit_log.subject IS
    'Identifier of the affected row, e.g. the escrow id.';
COMMENT ON COLUMN core.audit_log.request_id IS
    'The x-request-id of the call, to tie this row to the structured logs.';

CREATE INDEX audit_log_action_idx  ON core.audit_log (action, created_at DESC);
CREATE INDEX audit_log_actor_idx   ON core.audit_log (actor_profile_id, created_at DESC);
CREATE INDEX audit_log_subject_idx ON core.audit_log (subject) WHERE subject IS NOT NULL;
