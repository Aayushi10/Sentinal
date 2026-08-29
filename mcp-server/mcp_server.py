# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "fastmcp>=2.3.0",
#   "psycopg2-binary>=2.9.12",
#   "python-dotenv>=1.0.0",
#   "requests>=2.31.0",
# ]
# ///
"""
Sentinel MCP Server
===================
Provides MCP tools that an AI agent (running in TrueForge) uses to
investigate anonymous incident reports and correlate them into incidents.

Tool categories
---------------
READ-ONLY (safe to call at any time):
  • search_reports          – spatial + temporal filter; no AI inference
  • get_report_details      – fetch one report by ID
  • geocode_location        – free-text → lat/lng via Nominatim
  • check_response_resources – simulated nearby response units

SIDE-EFFECTING (requires human approval gate in TrueForge):
  • create_incident_action  – mutates incident state in the database

Usage
-----
  uv run mcp_server.py          # starts the MCP server (stdio transport)

Environment variables (loaded from .env in the same directory):
  DATABASE_URL   – PostgreSQL connection string (Supabase / PostGIS enabled)
"""

from __future__ import annotations

import hashlib
import os
import urllib.parse
from datetime import datetime, timezone, timedelta
from typing import Any

import psycopg2
import requests
from dotenv import load_dotenv
from fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

# Load .env from the directory where this file lives, so the server works
# regardless of the working directory it's launched from.
_HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(_HERE, ".env"))

mcp = FastMCP(
    name="Sentinel",
    instructions=(
        "You are an incident-correlation agent. Use the read-only tools to "
        "gather information about reports and existing incidents, then use "
        "create_incident_action (which requires human approval) to take "
        "consequential actions such as dispatching resources or escalating."
    ),
)

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------


def _get_db() -> psycopg2.extensions.connection:
    """Open and return a new psycopg2 connection using DATABASE_URL."""
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL environment variable is not set. "
            "Create a .env file in mcp-server/ with DATABASE_URL=<your-supabase-url>"
        )
    return psycopg2.connect(url)


def _row_to_report(row: tuple) -> dict[str, Any]:
    """Convert a DB row from the reports SELECT into a dict."""
    return {
        "id": str(row[0]),
        "text": row[1],
        "lat": row[2],
        "lng": row[3],
        "category": row[4],
        "timestamp": row[5].isoformat() if row[5] else None,
        "incident_id": str(row[6]) if row[6] else None,
    }


# ---------------------------------------------------------------------------
# Tool 1 – search_reports (READ-ONLY)
# ---------------------------------------------------------------------------


@mcp.tool()
def search_reports(
    center_lat: float,
    center_lng: float,
    radius_m: int = 400,
    since_minutes: int = 45,
    category: str | None = None,
) -> dict:
    """
    Find recent reports within a geographic radius of a given coordinate.

    This is a STRUCTURAL FILTER ONLY — it matches on location radius,
    recency, and (optionally) category. It does NOT perform any semantic
    or text-similarity comparison. The AI agent is responsible for reading
    the returned report texts and deciding whether they describe the same
    real-world event.

    Parameters
    ----------
    center_lat : float
        Latitude of the search centre (WGS-84 decimal degrees).
    center_lng : float
        Longitude of the search centre (WGS-84 decimal degrees).
    radius_m : int, default 400
        Search radius in metres. Uses PostGIS ST_DWithin on geography
        so distances are geodetic (accurate at all latitudes).
    since_minutes : int, default 45
        Only return reports submitted within the last N minutes.
        Use a larger window for older incidents; use a smaller window
        to focus on fast-moving, recent events.
    category : str | None, default None
        If provided, filters by exact category match
        ('fire', 'crime', 'hazard', 'other').
        Pass None to return all categories.

    Returns
    -------
    dict with keys:
        reports_found : int   – total number of matching reports
        radius_m      : int   – the radius used (echoed back for clarity)
        since_minutes : int   – the time window used
        reports       : list  – each item has:
            id, text, lat, lng, category, timestamp (ISO-8601), incident_id
    """
    since_time = datetime.now(tz=timezone.utc) - timedelta(minutes=since_minutes)

    sql = """
        SELECT id, text, lat, lng, category, timestamp, incident_id
        FROM   reports
        WHERE  timestamp > %(since)s
          AND  ST_DWithin(
                   geography(ST_MakePoint(lng, lat)),
                   geography(ST_MakePoint(%(clng)s, %(clat)s)),
                   %(radius)s
               )
    """
    params: dict[str, Any] = {
        "since": since_time,
        "clng": center_lng,
        "clat": center_lat,
        "radius": radius_m,
    }

    if category:
        sql += " AND category = %(cat)s"
        params["cat"] = category

    sql += " ORDER BY timestamp DESC"

    conn = _get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
    finally:
        conn.close()

    return {
        "reports_found": len(rows),
        "radius_m": radius_m,
        "since_minutes": since_minutes,
        "reports": [_row_to_report(r) for r in rows],
    }


# ---------------------------------------------------------------------------
# Tool 2 – get_report_details (READ-ONLY)
# ---------------------------------------------------------------------------


@mcp.tool()
def get_report_details(report_id: str) -> dict:
    """
    Retrieve the full details of a single report by its UUID.

    Use this after search_reports has returned a list of candidate reports
    and you need to read the complete text and metadata of a specific one
    (e.g. to assess credibility or extract location hints mentioned in the
    free-text field).

    Parameters
    ----------
    report_id : str
        UUID of the report (as returned in the `id` field of search_reports).

    Returns
    -------
    dict with keys:
        id, text, lat, lng, category, timestamp (ISO-8601),
        reporter_id, incident_id
    On failure:
        {"error": "<message>"}
    """
    conn = _get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, text, lat, lng, category, timestamp,
                       reporter_id, incident_id
                FROM   reports
                WHERE  id = %s
                """,
                (report_id,),
            )
            row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return {"error": f"No report found with id={report_id!r}"}

    return {
        "id": str(row[0]),
        "text": row[1],
        "lat": row[2],
        "lng": row[3],
        "category": row[4],
        "timestamp": row[5].isoformat() if row[5] else None,
        "reporter_id": row[6],
        "incident_id": str(row[7]) if row[7] else None,
    }


# ---------------------------------------------------------------------------
# Tool 3 – geocode_location (READ-ONLY)
# ---------------------------------------------------------------------------

_NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# Nominatim usage policy: identify your app with a descriptive User-Agent.
_NOMINATIM_HEADERS = {
    "User-Agent": "Sentinel-IncidentCorrelationAgent/1.0 (hackathon; contact: sentinel@example.com)"
}


@mcp.tool()
def geocode_location(description: str) -> dict:
    """
    Convert a free-text location description into a latitude / longitude pair.

    Uses the OpenStreetMap Nominatim geocoding API (no API key required).
    Call this when a report or user query mentions a named place, street
    address, or landmark and you need coordinates to pass into search_reports
    or check_response_resources.

    Parameters
    ----------
    description : str
        Any human-readable location string, e.g.:
          "Civic Center, San Francisco"
          "1 Market Street, SF"
          "Golden Gate Park bandshell"

    Returns
    -------
    dict with keys:
        lat          : float  – latitude (WGS-84)
        lng          : float  – longitude (WGS-84)
        display_name : str    – Nominatim's canonical name for the matched place
    On failure:
        {"error": "<message>"}

    Notes
    -----
    • Results are only as accurate as OSM data — verify against report coords
      before drawing hard conclusions.
    • Do NOT call this tool in a tight loop; Nominatim rate-limits to
      ~1 request/second per IP. One call per user query is sufficient.
    """
    try:
        resp = requests.get(
            _NOMINATIM_URL,
            params={
                "q": description,
                "format": "json",
                "limit": 1,
                "addressdetails": 0,
            },
            headers=_NOMINATIM_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        results = resp.json()
    except requests.RequestException as exc:
        return {"error": f"Geocoding request failed: {exc}"}

    if not results:
        return {"error": f"No geocoding result found for: {description!r}"}

    top = results[0]
    return {
        "lat": float(top["lat"]),
        "lng": float(top["lon"]),
        "display_name": top.get("display_name", ""),
    }


# ---------------------------------------------------------------------------
# Tool 4 – check_response_resources (READ-ONLY, SIMULATED)
# ---------------------------------------------------------------------------

# Simulated station data: (name, base_lat, base_lng)
_STATIONS = [
    ("Station 14 – Civic Center", 37.7793, -122.4185),
    ("Station 8  – Mission District", 37.7645, -122.4118),
    ("Station 3  – Financial District", 37.7960, -122.3993),
    ("Station 1  – Downtown / Tenderloin", 37.7842, -122.4102),
]


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in kilometres (Haversine formula)."""
    import math

    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@mcp.tool()
def check_response_resources(incident_type: str, lat: float, lng: float) -> dict:
    """
    Return a list of nearby simulated response units for a given incident type
    and location.

    THIS IS SIMULATED DATA — there is no real integration with emergency
    dispatch systems. Results are deterministic based on distance from the
    provided coordinates, so they will differ across locations but remain
    stable for the same input.

    Use this to assess response capacity before calling create_incident_action
    with action=DISPATCH_RESOURCE. The `unit_id` field from a returned unit
    can be used as the `target` argument of create_incident_action.

    Parameters
    ----------
    incident_type : str
        Category of the incident, e.g. 'fire', 'hazard', 'crime', 'medical'.
        Used to label the resource type in the response (no functional effect
        on routing in this simulation).
    lat : float
        Latitude of the incident (WGS-84 decimal degrees).
    lng : float
        Longitude of the incident (WGS-84 decimal degrees).

    Returns
    -------
    dict with keys:
        incident_type     : str   – echoed back
        units_available   : int   – number of units returned (always 3 in sim)
        units             : list  – up to 3 nearest simulated units, each with:
            unit_id     : str   – stable identifier (use as `target` when dispatching)
            name        : str   – human-readable station name
            distance_km : float – straight-line distance from incident (km)
            eta_minutes : int   – simulated ETA (distance × ~4 min/km, rounded)
            status      : str   – always 'AVAILABLE' in this simulation
    """
    # Compute distance from each simulated station to the incident location.
    scored: list[dict] = []
    for name, slat, slng in _STATIONS:
        dist_km = round(_haversine_km(lat, lng, slat, slng), 2)
        # Simple ETA model: ~4 minutes per km (urban speed + response overhead)
        # Add a tiny deterministic jitter per station so ETAs look realistic.
        jitter_seed = int(hashlib.md5(name.encode()).hexdigest(), 16) % 3  # 0-2 min
        eta = max(2, round(dist_km * 4) + jitter_seed)
        # Derive a stable unit_id from the station name
        unit_id = "unit_" + name.split("–")[0].strip().lower().replace(" ", "_")
        scored.append(
            {
                "unit_id": unit_id,
                "name": name,
                "distance_km": dist_km,
                "eta_minutes": eta,
                "status": "AVAILABLE",
            }
        )

    # Return the 3 closest units.
    scored.sort(key=lambda u: u["distance_km"])
    top3 = scored[:3]

    return {
        "incident_type": incident_type,
        "units_available": len(top3),
        "units": top3,
    }


# ---------------------------------------------------------------------------
# Tool 5 – create_incident_action (SIDE-EFFECTING — HUMAN APPROVAL REQUIRED)
# ---------------------------------------------------------------------------

# Maps the requested action to the resulting incident status.
_ACTION_STATUS_MAP = {
    "CREATE_INCIDENT": "INVESTIGATING",
    "DISPATCH_RESOURCE": "RESPONSE_IN_PROGRESS",
    "ESCALATE": "PENDING_APPROVAL",
    "REQUEST_ON_SITE_CONFIRMATION": "INVESTIGATING",
}


@mcp.tool()
def create_incident_action(incident_id: str, action: str, target: str) -> dict:
    """
    Execute a consequential action on an incident record.

    ⚠️  SIDE-EFFECTING — REQUIRES HUMAN APPROVAL ⚠️
    This tool writes to the database and may trigger real-world responses
    (resource dispatch, escalation to supervisors, on-site confirmation
    requests). It is IRREVERSIBLE in the sense that once a status transition
    is recorded, it cannot be undone programmatically — a human operator
    must intervene to correct a mistake.

    TrueForge gate: This tool MUST be placed behind a human-approval step
    in the TrueForge pipeline. The agent must not call it speculatively
    or as part of information-gathering; it is only appropriate after the
    agent has assessed the evidence and committed to a course of action.

    Parameters
    ----------
    incident_id : str
        UUID of the incident to act upon. The incident must already exist.
        Use search_reports + manual analysis to identify the correct incident
        before calling this tool.

    action : str
        One of the following (case-sensitive):
          CREATE_INCIDENT
              Marks a newly formed incident as INVESTIGATING.
              Use when correlated reports clearly describe a new real event.
          DISPATCH_RESOURCE
              Records that a response unit has been dispatched. Sets status
              to RESPONSE_IN_PROGRESS. Use `target` to record the unit_id
              returned by check_response_resources.
          ESCALATE
              Flags the incident for supervisor review (PENDING_APPROVAL).
              Use when severity is HIGH/CRITICAL or when the situation is
              ambiguous and requires human judgement.
          REQUEST_ON_SITE_CONFIRMATION
              Sends a request for a field unit to confirm the incident.
              Sets status to INVESTIGATING. Use when report credibility is
              low or conflicting.

    target : str
        Context-specific target for the action. Examples:
          • For DISPATCH_RESOURCE: the unit_id from check_response_resources
            (e.g. "unit_station_14")
          • For ESCALATE: the supervisor role/name (e.g. "duty_supervisor")
          • For REQUEST_ON_SITE_CONFIRMATION: the requesting unit
          • For CREATE_INCIDENT: brief rationale (e.g. "correlated 8 reports")

    Returns
    -------
    dict with keys:
        success     : bool  – True if the update succeeded
        incident_id : str   – the affected incident UUID
        action      : str   – the action that was recorded
        new_status  : str   – the incident's status after the update
        target      : str   – the target that was recorded
    On failure:
        {"error": "<message>", "incident_id": ..., "action": ...}
    """
    if action not in _ACTION_STATUS_MAP:
        return {
            "error": (
                f"Unknown action {action!r}. "
                f"Valid actions: {list(_ACTION_STATUS_MAP)}"
            ),
            "incident_id": incident_id,
            "action": action,
        }

    new_status = _ACTION_STATUS_MAP[action]

    conn = _get_db()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE incidents
                SET    status       = %s,
                       action_taken = %s,
                       target       = %s,
                       updated_at   = NOW()
                WHERE  id = %s
                RETURNING id
                """,
                (new_status, action, target, incident_id),
            )
            row = cur.fetchone()
            if not row:
                return {
                    "error": f"No incident found with id={incident_id!r}",
                    "incident_id": incident_id,
                    "action": action,
                }
        conn.commit()
    except Exception as exc:
        conn.rollback()
        return {
            "error": f"Database error: {exc}",
            "incident_id": incident_id,
            "action": action,
        }
    finally:
        conn.close()

    return {
        "success": True,
        "incident_id": incident_id,
        "action": action,
        "new_status": new_status,
        "target": target,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Default transport is stdio, which is what TrueForge and MCP Inspector
    # expect. Run with: uv run mcp_server.py
    mcp.run()