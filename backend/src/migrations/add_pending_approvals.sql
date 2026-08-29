-- Migration: add_pending_approvals.sql
-- Stores pending agent tool approvals independently of incidents.
-- Solves: TrueForge tool.approval_required fires before create_incident_action executes,
-- so CREATE_INCIDENT approvals cannot be attached to a non-existent incident row.

CREATE TABLE IF NOT EXISTS pending_approvals (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id        TEXT NOT NULL,
    turn_id           TEXT NOT NULL,
    thread_id         TEXT NOT NULL,
    tool_call_id      TEXT NOT NULL,
    report_id         UUID REFERENCES reports(id) ON DELETE SET NULL,
    incident_id       UUID REFERENCES incidents(id) ON DELETE SET NULL,
    tool_name         TEXT NOT NULL,
    action            TEXT,
    target            TEXT,
    call_args         JSONB,
    evidence          JSONB,
    recommendation    TEXT,
    status            TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'PROCESSING', 'APPROVED', 'REJECTED', 'FAILED')),
    operator          TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS pending_approvals_session_tool_idx
    ON pending_approvals (session_id, tool_call_id);

CREATE INDEX IF NOT EXISTS pending_approvals_status_idx
    ON pending_approvals (status, created_at DESC);

CREATE INDEX IF NOT EXISTS pending_approvals_incident_idx
    ON pending_approvals (incident_id);
