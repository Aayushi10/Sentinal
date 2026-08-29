-- ============================================================
-- Sentinel – database schema
-- Apply to Supabase via the SQL Editor or psql:
--   psql $DATABASE_URL -f schema.sql
-- (safe to re-run — all statements are idempotent)
-- ============================================================

-- PostGIS must be enabled before geography columns / functions are used.
CREATE EXTENSION IF NOT EXISTS postgis;

-- ------------------------------------------------------------
-- incidents
-- Represents a correlated cluster of reports that describe
-- the same real-world event.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Lifecycle status (controlled by create_incident_action tool)
    status        TEXT NOT NULL DEFAULT 'OPEN'
                  CHECK (status IN (
                      'OPEN',
                      'INVESTIGATING',
                      'PENDING_APPROVAL',
                      'RESPONSE_IN_PROGRESS',
                      'RESOLVED'
                  )),

    -- Agent-assigned severity / confidence after analysis
    severity      TEXT CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    confidence    TEXT CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),

    -- Geographic centre of the clustered reports
    centroid_lat  DOUBLE PRECISION,
    centroid_lng  DOUBLE PRECISION,

    -- Most recent action recorded by create_incident_action
    action_taken  TEXT,
    target        TEXT,        -- e.g. resource dispatched or escalation target

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keep updated_at current automatically
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS incidents_updated_at ON incidents;
CREATE TRIGGER incidents_updated_at
    BEFORE UPDATE ON incidents
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------
-- incident_audit_log
-- Append-only record of every action taken on an incident.
-- Fixes: actions were previously overwritten on each call to
-- create_incident_action, losing the history of what happened.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_audit_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    incident_id   UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    action        TEXT NOT NULL,
    target        TEXT,
    prev_status   TEXT,          -- status before the transition
    new_status    TEXT,          -- status after the transition
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_incident_idx
    ON incident_audit_log (incident_id, created_at DESC);

-- ------------------------------------------------------------
-- reports
-- Individual anonymous incident reports submitted by clients.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    text         TEXT NOT NULL,
    lat          DOUBLE PRECISION NOT NULL,
    lng          DOUBLE PRECISION NOT NULL,
    category     TEXT,          -- 'fire' | 'crime' | 'hazard' | 'other'
    timestamp    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reporter_id  TEXT NOT NULL, -- anonymous client-generated UUID
    incident_id  UUID REFERENCES incidents(id) ON DELETE SET NULL
);

-- Spatial index: dramatically speeds up ST_DWithin radius queries.
-- Cast to geography so distances are in metres (not degrees).
CREATE INDEX IF NOT EXISTS reports_location_gix
    ON reports
    USING GIST (geography(ST_MakePoint(lng, lat)));

-- Time index: used by the since_minutes filter in search_reports.
CREATE INDEX IF NOT EXISTS reports_timestamp_idx
    ON reports (timestamp DESC);
