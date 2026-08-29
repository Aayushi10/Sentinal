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
then exercises the read-only tools against the seeded database.

Usage:
    uv run test_client.py

Exit codes:
    0  – all assertions passed
    1  – one or more checks failed (details printed to stderr)

Expects mcp_server.py to be in the same directory and DATABASE_URL to be set
in .env (which mcp_server.py will load on startup).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any

from fastmcp import Client
from fastmcp.client.transports import PythonStdioTransport

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

_GREEN  = "\033[92m"
_RED    = "\033[91m"
_YELLOW = "\033[93m"
_CYAN   = "\033[96m"
_BOLD   = "\033[1m"
_RESET  = "\033[0m"


def _header(title: str) -> None:
    print(f"\n{_BOLD}{_CYAN}{'=' * 60}{_RESET}")
    print(f"{_BOLD}{_CYAN}  {title}{_RESET}")
    print(f"{_BOLD}{_CYAN}{'=' * 60}{_RESET}")


def _pass(label: str, detail: str = "") -> None:
    print(f"  {_GREEN}✓{_RESET}  {label}" + (f"  ({detail})" if detail else ""))


def _fail(label: str, reason: str, failures: list[str]) -> None:
    msg = f"  {_RED}✗{_RESET}  {label}: {reason}"
    print(msg, file=sys.stderr)
    failures.append(f"{label}: {reason}")


def _dump(data: Any) -> None:
    print(json.dumps(data, indent=4, default=str))


# ---------------------------------------------------------------------------
# Assertion helpers
# ---------------------------------------------------------------------------

def _assert(condition: bool, label: str, reason: str, failures: list[str]) -> bool:
    if condition:
        _pass(label)
        return True
    _fail(label, reason, failures)
    return False


def _call_result(raw: Any) -> dict:
    """Parse the first content item from a tool call result into a dict."""
    if not raw:
        return {}
    text = raw[0].text if hasattr(raw[0], "text") else str(raw[0])
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"_raw": text}


# ---------------------------------------------------------------------------
# Test suite
# ---------------------------------------------------------------------------

# Civic Center, SF — centre of the seeded building-fire cluster.
FIRE_LAT = 37.7796
FIRE_LNG = -122.4194

EXPECTED_TOOLS = {
    "search_reports",
    "get_report_details",
    "geocode_location",
    "check_response_resources",
    "create_incident_action",
}


async def run_tests() -> list[str]:
    """Run all checks. Returns a list of failure messages (empty = all passed)."""
    failures: list[str] = []
    server_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mcp_server.py")
    transport = PythonStdioTransport(script_path=server_script)

    async with Client(transport) as client:

        # ------------------------------------------------------------------
        # 1. Tool registry
        # ------------------------------------------------------------------
        _header("1 · Tool registry")
        try:
            tools = await client.list_tools()
            registered = {t.name for t in tools}
            _pass(f"Server returned {len(tools)} tools", str(registered))
            missing = EXPECTED_TOOLS - registered
            _assert(
                not missing,
                "All expected tools present",
                f"missing: {missing}",
                failures,
            )
        except Exception as exc:
            _fail("list_tools", str(exc), failures)
            # Can't continue without tools
            return failures

        # ------------------------------------------------------------------
        # 2. search_reports — fire cluster (expect ≥ 12 results)
        # ------------------------------------------------------------------
        _header("2 · search_reports — fire cluster")
        first_report_id: str | None = None
        try:
            data = _call_result(await client.call_tool(
                "search_reports",
                {"center_lat": FIRE_LAT, "center_lng": FIRE_LNG,
                 "radius_m": 500, "since_minutes": 60},
            ))
            _dump(data)
            found = data.get("reports_found", -1)
            ok = _assert(found >= 12, f"reports_found ≥ 12", f"got {found}", failures)
            _assert("error" not in data, "No error key in response",
                    data.get("error", ""), failures)
            if ok and data.get("reports"):
                first_report_id = data["reports"][0]["id"]
        except Exception as exc:
            _fail("search_reports (fire cluster)", str(exc), failures)

        # ------------------------------------------------------------------
        # 3. search_reports — category filter
        # ------------------------------------------------------------------
        _header("3 · search_reports — category='fire' filter")
        try:
            data = _call_result(await client.call_tool(
                "search_reports",
                {"center_lat": FIRE_LAT, "center_lng": FIRE_LNG,
                 "radius_m": 500, "since_minutes": 60, "category": "fire"},
            ))
            _dump(data)
            found = data.get("reports_found", -1)
            _assert(found >= 10, "fire-only reports_found ≥ 10", f"got {found}", failures)
            categories = {r["category"] for r in data.get("reports", [])}
            _assert(
                categories <= {"fire"},
                "All returned reports have category='fire'",
                f"unexpected categories: {categories - {'fire'}}",
                failures,
            )
        except Exception as exc:
            _fail("search_reports (fire filter)", str(exc), failures)

        # ------------------------------------------------------------------
        # 4. search_reports — outside cluster (expect exactly 1)
        # ------------------------------------------------------------------
        _header("4 · search_reports — Golden Gate Park (expect 1)")
        try:
            data = _call_result(await client.call_tool(
                "search_reports",
                {"center_lat": 37.7694, "center_lng": -122.4862,
                 "radius_m": 300, "since_minutes": 60},
            ))
            _dump(data)
            found = data.get("reports_found", -1)
            _assert(found == 1, "reports_found == 1 (GGP noise complaint)",
                    f"got {found}", failures)
        except Exception as exc:
            _fail("search_reports (Golden Gate Park)", str(exc), failures)

        # ------------------------------------------------------------------
        # 5. search_reports — input validation (negative radius)
        # ------------------------------------------------------------------
        _header("5 · search_reports — invalid negative radius (expect error)")
        try:
            data = _call_result(await client.call_tool(
                "search_reports",
                {"center_lat": FIRE_LAT, "center_lng": FIRE_LNG,
                 "radius_m": -100, "since_minutes": 30},
            ))
            _dump(data)
            _assert("error" in data, "Returns error for radius_m=-100",
                    "no 'error' key returned", failures)
        except Exception as exc:
            _fail("search_reports (negative radius)", str(exc), failures)

        # ------------------------------------------------------------------
        # 6. search_reports — input validation (out-of-range lat)
        # ------------------------------------------------------------------
        _header("6 · search_reports — invalid lat=999 (expect error)")
        try:
            data = _call_result(await client.call_tool(
                "search_reports",
                {"center_lat": 999.0, "center_lng": FIRE_LNG,
                 "radius_m": 400, "since_minutes": 30},
            ))
            _dump(data)
            _assert("error" in data, "Returns error for lat=999",
                    "no 'error' key returned", failures)
        except Exception as exc:
            _fail("search_reports (bad lat)", str(exc), failures)

        # ------------------------------------------------------------------
        # 7. get_report_details — valid report
        # ------------------------------------------------------------------
        _header("7 · get_report_details — first report from cluster")
        if first_report_id:
            try:
                data = _call_result(await client.call_tool(
                    "get_report_details", {"report_id": first_report_id}
                ))
                _dump(data)
                _assert("error" not in data, "No error key", data.get("error", ""), failures)
                _assert("text" in data and data["text"], "Has non-empty text", "", failures)
                _assert(data.get("id") == first_report_id, "ID matches",
                        f"{data.get('id')} ≠ {first_report_id}", failures)
            except Exception as exc:
                _fail("get_report_details", str(exc), failures)
        else:
            print(f"  {_YELLOW}⚠{_RESET}  Skipped — no report ID from step 2")

        # ------------------------------------------------------------------
        # 8. get_report_details — non-existent ID (expect error)
        # ------------------------------------------------------------------
        _header("8 · get_report_details — non-existent ID (expect error)")
        try:
            data = _call_result(await client.call_tool(
                "get_report_details",
                {"report_id": "00000000-dead-beef-0000-000000000000"},
            ))
            _dump(data)
            _assert("error" in data, "Returns error for unknown ID",
                    "no 'error' key returned", failures)
        except Exception as exc:
            _fail("get_report_details (bad id)", str(exc), failures)

        # ------------------------------------------------------------------
        # 9. geocode_location
        # ------------------------------------------------------------------
        _header("9 · geocode_location — 'Civic Center, San Francisco'")
        try:
            data = _call_result(await client.call_tool(
                "geocode_location",
                {"description": "Civic Center, San Francisco"},
            ))
            _dump(data)
            _assert("error" not in data, "No error", data.get("error", ""), failures)
            _assert("lat" in data and "lng" in data, "Has lat/lng", "", failures)
            if "lat" in data:
                _assert(
                    37.0 < data["lat"] < 38.0,
                    f"lat is in SF range (got {data['lat']:.4f})",
                    f"lat={data['lat']} outside [37, 38]",
                    failures,
                )
        except Exception as exc:
            _fail("geocode_location", str(exc), failures)

        # ------------------------------------------------------------------
        # 10. check_response_resources
        # ------------------------------------------------------------------
        _header("10 · check_response_resources — fire at Civic Center")
        try:
            data = _call_result(await client.call_tool(
                "check_response_resources",
                {"incident_type": "fire", "lat": FIRE_LAT, "lng": FIRE_LNG},
            ))
            _dump(data)
            _assert("error" not in data, "No error", data.get("error", ""), failures)
            units = data.get("units", [])
            _assert(len(units) == 3, f"Returns 3 units (got {len(units)})", "", failures)
            if units:
                _assert(
                    units[0]["distance_km"] <= units[-1]["distance_km"],
                    "Units ordered nearest-first",
                    f"{units[0]['distance_km']} > {units[-1]['distance_km']}",
                    failures,
                )
                _assert(
                    all("unit_id" in u and "eta_minutes" in u for u in units),
                    "All units have unit_id and eta_minutes",
                    "",
                    failures,
                )
        except Exception as exc:
            _fail("check_response_resources", str(exc), failures)

    return failures


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    failures = asyncio.run(run_tests())

    _header("Results")
    total   = 10   # number of test sections above
    n_fail  = len(failures)
    n_pass  = total - n_fail   # approximate; multiple assertions per section

    if not failures:
        print(f"\n  {_GREEN}{_BOLD}All checks passed ✓{_RESET}")
        print(
            "\n  Next step: connect this MCP server to TrueForge and configure\n"
            "  create_incident_action behind a human-approval gate.\n"
        )
        sys.exit(0)
    else:
        print(f"\n  {_RED}{_BOLD}{len(failures)} check(s) FAILED:{_RESET}", file=sys.stderr)
        for f in failures:
            print(f"    • {f}", file=sys.stderr)
        sys.exit(1)
