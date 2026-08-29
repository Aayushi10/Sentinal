/**
 * Migration: adds TrueForge session-tracking columns to `incidents`.
 * Safe to re-run (IF NOT EXISTS).
 *
 * Run once against your Supabase DB before starting the backend:
 *   psql $DATABASE_URL -f src/migrations/add_approval_state.sql
 */

-- pending_session_id  – TrueForge session id, retained even after approval so
--                       we can resume further turns on the same context.
ALTER TABLE incidents
  ADD COLUMN IF NOT EXISTS pending_session_id   TEXT,

-- pending_turn_id     – the turn that paused with tool.approval_required.
  ADD COLUMN IF NOT EXISTS pending_turn_id      TEXT,

-- pending_thread_id   – thread from the tool.approval_required event.
  ADD COLUMN IF NOT EXISTS pending_thread_id    TEXT,

-- pending_tool_call_id – the exact toolCallId to reference in user.tool_approval.
  ADD COLUMN IF NOT EXISTS pending_tool_call_id TEXT,

-- approval_status     – PENDING | APPROVED | REJECTED | null (not yet reached approval gate)
  ADD COLUMN IF NOT EXISTS approval_status      TEXT
                            CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),

-- evidence            – JSONB snapshot of what the agent reported before pausing.
  ADD COLUMN IF NOT EXISTS evidence             JSONB,

-- recommendation      – free-text action the agent wants to take.
  ADD COLUMN IF NOT EXISTS recommendation       TEXT;
