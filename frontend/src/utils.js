/**
 * utils.js — Formatting helpers for Sentinel Mission Intelligence
 */

export function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${date} · ${time}`;
  } catch {
    return iso;
  }
}

export function relTime(iso) {
  if (!iso) return '';
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function shortId(id) {
  if (!id) return '—';
  return id.replace(/^([a-f0-9]{8}).*/i, '$1').toUpperCase();
}

export function fmtCoords(lat, lng, decimals = 4) {
  if (lat == null || lng == null) return '—';
  const latN = parseFloat(lat);
  const lngN = parseFloat(lng);
  if (!isFinite(latN) || !isFinite(lngN)) return '—';
  const latDir = latN >= 0 ? 'N' : 'S';
  const lngDir = lngN >= 0 ? 'E' : 'W';
  return `${Math.abs(latN).toFixed(decimals)}°${latDir}, ${Math.abs(lngN).toFixed(decimals)}°${lngDir}`;
}

export function fmtConfidence(c) {
  if (c == null) return '85%';
  if (typeof c === 'string') {
    const uc = c.toUpperCase();
    if (uc === 'HIGH') return '94%';
    if (uc === 'MEDIUM') return '78%';
    if (uc === 'LOW') return '52%';
  }
  const n = Number(c);
  if (isNaN(n)) return '85%';
  return n <= 1 ? `${Math.round(n * 100)}%` : `${Math.round(n)}%`;
}

export function fmtSeverity(s) {
  return s ? String(s).toUpperCase() : 'MEDIUM';
}

export function fmtStatus(s) {
  if (!s) return 'Active';
  const norm = String(s).toUpperCase().replace(/\s+/g, '_');
  const map = {
    'OPEN': 'Investigating',
    'INVESTIGATING': 'Under Investigation',
    'PENDING_APPROVAL': 'Decision Required',
    'RESPONSE_IN_PROGRESS': 'Dispatch Active',
    'DISPATCHED': 'Units En Route',
    'RESOLVED': 'Resolved / Neutralized',
    'CLOSED': 'Closed',
  };
  return map[norm] ?? norm.replace(/_/g, ' ');
}

export function truncate(text, maxLen = 120) {
  if (!text) return '';
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

export function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
