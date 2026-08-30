/**
 * api.js — Sentinel API Client
 * All backend communication is centralized here.
 */

// In dev, Vite proxies /incidents|/reports|/status → http://localhost:3001
// In production, set VITE_API_BASE to your backend URL (e.g. https://api.sentinel.example.com)
const BASE = import.meta.env.VITE_API_BASE ?? '';

async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  getStatus:           ()         => request('/status'),
  getIncidents:        ()         => request('/incidents'),
  getIncident:         (id)       => request(`/incidents/${id}`),
  getPendingApprovals: ()         => request('/incidents/pending-approvals'),
  getReports:          ()         => request('/reports'),
  submitReport:        (body)     => request('/reports', { method: 'POST', body: JSON.stringify(body) }),
  approve:             (id)       => request(`/incidents/${id}/approve`, { method: 'POST' }),
  reject:              (id, reason) => request(`/incidents/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  }),
};
