# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "fastmcp>=2.3.0",
# ]
# ///
"""
Sentinel MCP – end-to-end test client
======================================
Connects to mcp_server.py via stdio transport, lists all registered tools,
then exercises the two primary read-only tools against the seeded database.

Usage:
    uv run test_client.py

Expects mcp_server.py to be in the same directory and DATABASE_URL to be set
in .env (which mcp_server.py will load on startup).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from fastmcp import Client
from fastmcp.client.transports import PythonStdioTransport

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_GREEN = "\033[92m"
_RED = "\033[91m"
_YELLOW = "\033[93m"
_CYAN = "\033[96m"
_BOLD = "\033[1m"
_RESET = "\033[0m"


def _header(title: str) -> None:
    print(f"\n{_BOLD}{_CYAN}{'=' * 60}{_RESET}")
    print(f"{_BOLD}{_CYAN}  {title}{_RESET}")
    print(f"{_BOLD}{_CYAN}{'=' * 60}{_RESET}")


def _ok(label: str, value: object) -> None:
    print(f"  {_GREEN}✓{_RESET}  {_BOLD}{label}{_RESET}")
    if isinstance(value, (dict, list)):
        print(json.dumps(value, indent=4, default=str))
    else:
        print(f"     {value}")


def _fail(label: str, exc: Exception) -> None:
    print(f"  {_RED}✗{_RESET}  {_BOLD}{label}{_RESET}: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Test suite
# ---------------------------------------------------------------------------

# Civic Center, SF — centre of the seeded building-fire cluster.
FIRE_LAT = 37.7796
FIRE_LNG = -122.4194

# ID of the seeded test incident (from seed.sql).
SEEDED_INCIDENT_ID = "aaaaaaaa-0000-0000-0000-000000000001"


async def run_tests() -> None:
    server_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_server.py")

    transport = PythonStdioTransport(script_path=server_script)

    async with Client(transport) as client:

        # ------------------------------------------------------------------
        # 1. List tools
        # ------------------------------------------------------------------
        _header("1 · List registered tools")
        try:
            tools = await client.list_tools()
            _ok(f"Found {len(tools)} tools", [t.name for t in tools])
        except Exception as exc:
            _fail("list_tools", exc)
            return

        # ------------------------------------------------------------------
        # 2. search_reports — fire cluster (should return ≥12 results)
        # ------------------------------------------------------------------
        _header("2 · search_reports — fire cluster at Civic Center")
        try:
            result = await client.call_tool(
                "search_reports",
                {
                    "center_lat": FIRE_LAT,
                    "center_lng": FIRE_LNG,
                    "radius_m": 500,
                    "since_minutes": 60,
                    "category": None,
                },
            )
            data = json.loads(result[0].text) if result else {}
            _ok(f"reports_found = {data.get('reports_found', '?')}", data)

            # Grab the ID of the first report for the next test.
            first_report_id: str | None = None
            reports_list = data.get("reports", [])
            if reports_list:
                first_report_id = reports_list[0]["id"]
        except Exception as exc:
            _fail("search_reports", exc)
            first_report_id = None

        # ------------------------------------------------------------------
        # 3. search_reports — category filter (fire only)
        # ------------------------------------------------------------------
        _header("3 · search_reports — category='fire' filter")
        try:
            result = await client.call_tool(
                "search_reports",
                {
                    "center_lat": FIRE_LAT,
                    "center_lng": FIRE_LNG,
                    "radius_m": 500,
                    "since_minutes": 60,
                    "category": "fire",
                },
            )
            data = json.loads(result[0].text) if result else {}
            _ok(f"fire-only reports_found = {data.get('reports_found', '?')}", data)
        except Exception as exc:
            _fail("search_reports (fire filter)", exc)

        # ------------------------------------------------------------------
        # 4. search_reports — outside cluster (should return 0 or very few)
        # ------------------------------------------------------------------
        _header("4 · search_reports — away from cluster (Golden Gate Park)")
        try:
            result = await client.call_tool(
                "search_reports",
                {
                    "center_lat": 37.7694,
                    "center_lng": -122.4862,
                    "radius_m": 300,
                    "since_minutes": 60,
                    "category": None,
                },
            )
            data = json.loads(result[0].text) if result else {}
            _ok(f"reports_found = {data.get('reports_found', '?')} (expect 1)", data)
        except Exception as exc:
            _fail("search_reports (Golden Gate Park)", exc)

        # ------------------------------------------------------------------
        # 5. get_report_details
        # ------------------------------------------------------------------
        _header("5 · get_report_details — first report from cluster")
        if first_report_id:
            try:
                result = await client.call_tool(
                    "get_report_details", {"report_id": first_report_id}
                )
                data = json.loads(result[0].text) if result else {}
                _ok(f"Report {first_report_id[:8]}…", data)
            except Exception as exc:
                _fail("get_report_details", exc)
        else:
            print(f"  {_YELLOW}⚠{_RESET}  Skipped — no report ID from step 2")

        # ------------------------------------------------------------------
        # 6. get_report_details — unknown ID (expect error)
        # ------------------------------------------------------------------
        _header("6 · get_report_details — non-existent ID (expect error)")
        try:
            result = await client.call_tool(
                "get_report_details",
                {"report_id": "00000000-dead-beef-0000-000000000000"},
            )
            data = json.loads(result[0].text) if result else {}
            _ok("Response (expect error key)", data)
        except Exception as exc:
            _fail("get_report_details (bad id)", exc)

        # ------------------------------------------------------------------
        # 7. geocode_location
        # ------------------------------------------------------------------
        _header("7 · geocode_location — 'Civic Center, San Francisco'")
        try:
            result = await client.call_tool(
                "geocode_location",
                {"description": "Civic Center, San Francisco"},
            )
            data = json.loads(result[0].text) if result else {}
            _ok("Geocode result", data)
        except Exception as exc:
            _fail("geocode_location", exc)

        # ------------------------------------------------------------------
        # 8. check_response_resources
        # ------------------------------------------------------------------
        _header("8 · check_response_resources — fire at Civic Center")
        try:
            result = await client.call_tool(
                "check_response_resources",
                {"incident_type": "fire", "lat": FIRE_LAT, "lng": FIRE_LNG},
            )
            data = json.loads(result[0].text) if result else {}
            _ok("Response units", data)
        except Exception as exc:
            _fail("check_response_resources", exc)

    # ----------------------------------------------------------------------
    _header("All tests complete")
    print(
        f"\n  {_GREEN}✓{_RESET}  If you see data above, the server is wired up correctly.\n"
        f"  Next step: connect this MCP server to TrueForge and configure\n"
        f"  create_incident_action behind a human-approval gate.\n"
    )


if __name__ == "__main__":
    asyncio.run(run_tests())
