# Sentinel MCP Server

**Team:** BlackBox

A high-performance Model Context Protocol (MCP) server built with Python and [FastMCP](https://github.com/jlowin/fastmcp). It exposes spatial queries, citizen report search, resource readiness telemetry, and incident creation tools to autonomous AI agents running inside TrueForge.

---

## Tool Categories

### 1. Read-Only Investigation Tools
Safe for autonomous agents to query freely during investigation:
- **`search_reports`**: Spatial and temporal filtering of citizen telemetry reports by coordinates, radius (km), time window, or hazard category (`fire`, `hazard`, `crime`, `other`).
- **`get_report_details`**: Fetches full metadata for a specific report by ID.
- **`geocode_location`**: Converts free-text addresses or landmark descriptions into latitude/longitude coordinates via OpenStreetMap Nominatim.
- **`check_response_resources`**: Queries real-time status, distance, and readiness of simulated emergency response units (e.g. Engine Companies, Hazmat units, Tactical Medics).

### 2. Side-Effecting Tactical Tools
Protected by human-in-the-loop authorization gates:
- **`create_incident_action`**: Mutates the shared database to group reports, create an incident cluster, or propose tactical dispatch. Configured with `require_approval_for_tools` in TrueForge to guarantee that physical resources cannot be mobilized without explicit dispatcher confirmation.

---

## Prerequisites

- **Python:** `>= 3.11`
- **Package Manager:** [`uv`](https://docs.astral.sh/uv/) (recommended)
- **Database:** PostgreSQL database with `pgcrypto` and PostGIS enabled (Supabase)

---

## Local Setup

### 1. Configure Environment Variables
Create `mcp-server/.env`:
```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/postgres"
```

### 2. Initialize Database Schema & Seed Data
```bash
cd mcp-server

# Apply tables, indexes, and PostGIS extensions
psql "$DATABASE_URL" -f schema.sql

# Optional: Seed sample emergency reports and response units
psql "$DATABASE_URL" -f seed.sql
```

### 3. Run the MCP Server (Local Stdio Mode)
Using `uv`:
```bash
uv run python mcp_server.py
```

### 4. Interactive Testing with MCP Inspector
To inspect and test available MCP tools visually in your browser:
```bash
npx @modelcontextprotocol/inspector uv run python mcp_server.py
```

### 5. Automated Testing
Run the client test suite to verify tool outputs against your database:
```bash
uv run python test_client.py
```

---

## TrueForge Integration

To connect this MCP server to your local or hosted TrueForge instance:

1. **Local Mode (Stdio):**
   In the TrueForge Agent configuration, register an MCP tool with command:
   ```bash
   uv --directory /path/to/mcp-server run python mcp_server.py
   ```
2. **Hosted / Cloud Mode (HTTP / SSE):**
   When deploying (e.g. to Render or Cloud Run), run FastMCP with SSE/HTTP transport and point your TrueForge instance's MCP connector to the deployed service URL.
3. **Approval Gate:**
   In your TrueForge agent definition (`sentinel-prod-v1`), ensure `create_incident_action` is listed in `require_approval_for_tools`.
