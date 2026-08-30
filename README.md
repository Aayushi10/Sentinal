# Sentinel — Autonomous Crisis Intelligence & Human-in-the-Loop Dispatch Orchestration

**Team:** BlackBox  
> **Bridging the critical gap between chaotic public telemetry and decisive emergency response through AI signal correlation, spatial convergence, and verified human authority.**

---

## System Components & Architecture

Sentinel is structured into four core components that work together to ingest, correlate, analyze, and dispatch emergency response:

```
                          [ Public Telemetry & Citizen Reports ]
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   SENTINEL FRONTEND                                    │
│                    Tactical Command Console & Human Decision Interface                  │
│                                                                                        │
│  • Canvas 2D Globe Signal Acquisition           • Incident Field Convergence Vectors   │
│  • Real-Time Signal Stream                      • Evidence Convergence Timeline        │
│  • 6-Stage Investigation Pipeline               • High-Stakes Human Approval Gateway   │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ REST / Polling
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   SENTINEL BACKEND                                     │
│                     Event-Driven Express & TrueForge Orchestrator                      │
│                                                                                        │
│  • Real-Time Report Ingestion                   • TrueForge Agent Session Lifecycle    │
│  • Operator Authentication & Session Headers    • Atomic Human Decision Claims         │
│  • Comprehensive Audit Logging Engine           • Idempotent Schema Migrations         │
└──────────────────────────────────────┬─────────────────────────────────────────────────┘
                                       │
            ┌──────────────────────────┴──────────────────────────┐
            ▼                                                     ▼
┌──────────────────────────────────────┐       ┌─────────────────────────────────────────┐
│              MCP SERVER              │       │            POSTGRESQL DATABASE          │
│   Model Context Protocol (FastMCP)   │       │               (Supabase)                │
│                                      │       │                                         │
│ • Nearby Spatial Clustering          │       │ • `reports` (Citizen telemetry)         │
│ • Resource Telemetry & Readiness     │       │ • `incidents` (Correlated clusters)     │
│ • Incident Centroid Estimation       │       │ • `pending_approvals` (Human gate)      │
│ • Tactical Tool Execution            │       │ • `incident_audit_log` (Immutability)   │
└──────────────────────────────────────┘       └─────────────────────────────────────────┘
```

### Component Breakdown
- **Frontend (`/frontend`)**: A mission-critical command console featuring a lightweight Canvas 2D globe signal acquisition intro, Leaflet "Incident Field" animated convergence vectors connecting field reports to incident centroids, a live telemetry Signal Stream, an Evidence Convergence Timeline, and a high-stakes Human Approval Gateway.
- **Backend (`/backend`)**: An Express and TypeScript orchestration service that persists incoming citizen reports, fires autonomous TrueForge agent sessions (`sentinel-prod-v1`), intercepts proposed actions via an atomic approval claim engine, enforces operator authentication, and records tamper-evident audit logs.
- **MCP Server (`/mcp-server`)**: A Python FastMCP service exposing PostGIS spatial clustering, nearby telemetry radius queries, and emergency resource availability checks directly to autonomous LLM agents.
- **Database Layer**: PostgreSQL + PostGIS schema (`reports`, `incidents`, `pending_approvals`, and `incident_audit_log`) ensuring complete immutability, data privacy, and full operational traceability.

---

## Questions & Answers

### What does your project do?
Sentinel is an autonomous crisis intelligence and emergency dispatch platform built for 911 dispatchers, emergency operations centers (EOCs), and first response commanders who face severe sensory overload and coordination delays during chaotic disasters. During fast-moving events like fires, chemical hazards, or structural emergencies, hundreds of noisy citizen reports flood in simultaneously; Sentinel autonomously correlates these fragmented signals into unified spatial incident clusters, synthesizes an explainable chronological evidence timeline, and recommends targeted tactical unit dispatches while enforcing a strict human-in-the-loop approval gateway before any physical response can proceed.

### How did you use Qodo in your project?
We integrated Qodo Code Review directly into our GitHub pull request workflow to perform automated, deep static and architectural analysis on every branch. Qodo acted as an automated reliability and security engineer, identifying eight critical bugs that standard linters missed—including an unresolved pnpm 11 build policy placeholder, missing operator authorization headers on critical dispatch endpoints, concurrent decision race conditions, out-of-order async detail overwrites, stale polling states, coordinate hemisphere sign errors, timeline offset fabrication, and a Node 22 engine compatibility mismatch—allowing our team to resolve high-consequence failure modes before they could impact live emergency operations.

### How did you use TrueForge in your project?
Sentinel is an incident-correlation agent: it takes anonymous public reports (text, location, timestamp) and figures out whether they represent one emerging incident or several unrelated ones, then investigates severity before recommending a response. TrueForge is the core of the project, not a layer on top of it — the agent uses TrueForge's MCP tool-calling to search and read reports, geocode locations, and check simulated response resources; it uses TrueForge's sandbox to write and execute its own clustering/growth-rate/independence analysis on each batch of reports rather than relying on a fixed pre-written function; and every consequential action (dispatching a response, escalating an incident) goes through TrueForge's tool-approval gate, so the agent can investigate and recommend freely but can never act without a human explicitly approving it. Our backend talks to the agent entirely through the TrueForge SDK — creating sessions, streaming turns, and resuming paused turns when a dispatcher approves or rejects a recommendation.

### Which TrueForge feature was the most useful while building your project, and why?
The tool-approval mechanism (`require_approval_for_tools`) was the most useful, because it let us build genuine human-in-the-loop safety without writing any of that logic ourselves. We just marked our one side-effecting tool (`create_incident_action`) as requiring approval, and TrueForge handled pausing the turn, exposing the pending call, and resuming cleanly once we sent back an allow/deny decision. That meant our entire "never act without human approval" design constraint — which was central to the project — was enforced by the harness itself rather than something we had to implement and hope we got right.

### Where did you get stuck while building with TrueForge, and what would you improve about the developer experience?
Most of our friction was in deployment, not in building the agent itself. Getting from "working locally" to "usable by our backend" took several distinct stages: deploy the MCP server first (switching it from stdio to HTTP transport), separately deploy TrueForge itself via Docker on Render (backed by managed Postgres and Redis), then go back into the newly-deployed TrueForge instance and reconnect it to the now-deployed MCP server, recreate the agent there from scratch (local-mode agents don't carry over to a hosted instance, since local mode uses SQLite and hosted mode uses Postgres), and only then point our backend's `TRUEFORGE_BASE_URL` at it. Each of those steps worked, but none of them were obviously connected up front — we had to piece the sequence together ourselves. A guided "local mode → hosted mode" migration path (especially something that exports/imports agent configs across the two, so you're not manually recreating instructions and connector wiring a second time) would have saved real time.

---

## How to Run on Local Machine

### Prerequisites
- **Node.js:** `>= 22.0.0`
- **pnpm:** `>= 11.0.0`
- **Python:** `>= 3.11` with [`uv`](https://docs.astral.sh/uv/)
- **PostgreSQL:** PostgreSQL database with `pgcrypto` enabled (e.g. Supabase)

### Component Setup Guides
For setup and run instructions, refer to each component's dedicated documentation:
- **Database & MCP Server:** Refer to [mcp-server/README.md](mcp-server/README.md)
- **Backend Service & TrueForge:** Refer to [backend/README.md](backend/README.md)
- **Tactical Frontend:** Refer to [frontend/README.md](frontend/README.md)

---

## Screenshots & Visuals

### PostgreSQL Schema
<img width="767" height="700" alt="postgres_schema" src="https://github.com/user-attachments/assets/d18967b9-352a-49a5-b8a8-af87f8ea89b0" />

### Qodo Code Review
<img width="1202" height="720" alt="qodo" src="https://github.com/user-attachments/assets/50533660-2544-4c98-834a-84d92eed3946" />

### TrueForge Chat Approval & Rejection
<img width="732" height="305" alt="trueforge-chat approve-reject" src="https://github.com/user-attachments/assets/cccdbb44-a2cc-47a8-9937-c0cb993cdbc6" />