# Sentinel Backend

**Team:** BlackBox

Node/TypeScript Express service that:

1. Accepts anonymous incident reports from the frontend and persists them to the shared Supabase database.
2. Fires a TrueForge agent session (`sentinel-prod-v1`) per report, streaming events in the background.
3. Detects `tool.approval_required` pauses (issued when the agent wants to call `create_incident_action`) and stores the session/thread/tool-call IDs so the session can be resumed.
4. Exposes REST endpoints for the frontend to list/get reports and incidents, and to approve or reject pending agent actions.
5. Provides a lightweight `/status` polling endpoint for live update detection.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 22 | Required by `@truefoundry/trueforge-sdk` |
| pnpm ≥ 11 | Package manager |
| Supabase database | PostGIS enabled; `schema.sql` applied (see `mcp-server/`) |
| TrueForge running locally | Default `http://localhost:8790` — start with `npx @truefoundry/trueforge` |
| Agent `sentinel-prod-v1` saved in TrueForge | Created via the TrueForge UI/CLI with the MCP server attached |

---

## Environment Variables

Create `backend/.env` (see `.env.example`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string (same DB as `mcp-server/`) |
| `TRUEFORGE_BASE_URL` | | `http://localhost:8790` | URL of the running TrueForge server |
| `PORT` | | `3001` | Port the Express server listens on |
| `CORS_ORIGIN` | | `http://localhost:3000,http://localhost:5173` | Allowed frontend origins |
| `OPERATOR_API_KEY` | | — | Optional secret required for `/approve` and `/reject` |
| `MAX_CONCURRENT_SESSIONS` | | `5` | Concurrency cap for background TrueForge sessions |

---

## Local Setup

### 1. Run the DB migrations

Run the automated migration runner (applies all files in `src/migrations/`):

```bash
cd backend
node run-migration.js
```

This is idempotent — safe to re-run.

### 2. Install dependencies

```bash
cd backend
pnpm install
```

### 3. Start in dev mode

```bash
pnpm run dev
```

Or build and run for production:

```bash
pnpm run build
pnpm run start
```

---

## API Reference

### Health & Polling

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/status` | Poll-friendly summary (`total_reports`, `total_incidents`, `pending_approvals`, `latest_incident_at`) |

### Reports

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/reports` | `{ text, lat, lng, category?, reporter_id? }` | Submit a report; agent session starts in background |
| `GET` | `/reports` | — | List all reports (newest-first, max 200) |
| `GET` | `/reports/:id` | — | Get one report |

### Incidents

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/incidents` | — | List incidents with linked reports and approval state |
| `GET` | `/incidents/:id` | — | Get one incident with `audit_log` and `reports` |
| `POST` | `/incidents/:id/approve` | — | Approve the pending agent action (resumes TrueForge session with `allow`) |
| `POST` | `/incidents/:id/reject` | `{ reason? }` | Reject the pending agent action (resumes with `deny`; incident stays INVESTIGATING) |

---

## Architecture Notes

### Agent flow

```
POST /reports
  └─ Insert report → DB
  └─ startAgentSession() [background, no await]
       └─ trueforge.sessions.create({ agent: { name: 'sentinel-prod-v1' } })
       └─ createTurnStream(session.id, { input: [user.message] })
       └─ Stream events:
            • model.message / model.message.delta  → merged into event index
            • tool.approval_required               → saved to incidents table
            • turn.done                            → log status
```

### Approval flow

```
POST /incidents/:id/approve
  └─ Read pending_session_id + pending_tool_call_id from DB
  └─ approveIncidentAction() [background]
       └─ createTurnStream(sessionId, { input: [user.tool_approval { status: 'allow' }] })
       └─ On turn.done: clear pending state → approval_status = 'APPROVED'

POST /incidents/:id/reject
  └─ rejectIncidentAction() [background]
       └─ createTurnStream(sessionId, { input: [user.tool_approval { status: 'deny', reason }] })
       └─ On turn.done: reset status → 'INVESTIGATING', approval_status = 'REJECTED'
       [Incident remains OPEN/INVESTIGATING — not closed on rejection]
```

### DB columns added to `incidents`

| Column | Type | Purpose |
|---|---|---|
| `pending_session_id` | TEXT | TrueForge session to resume |
| `pending_turn_id` | TEXT | The paused turn id |
| `pending_thread_id` | TEXT | Thread that emitted `tool.approval_required` |
| `pending_tool_call_id` | TEXT | Exact tool call id for `user.tool_approval` |
| `approval_status` | TEXT | `PENDING` / `APPROVED` / `REJECTED` / null |
| `evidence` | JSONB | Agent's analysis snapshot before pausing |
| `recommendation` | TEXT | What the agent intended to do |
