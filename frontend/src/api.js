/**
 * api.js — Sentinel API Client
 * Centralized backend communication with operator authentication and abort signal support.
 */

const BASE = import.meta.env.VITE_API_BASE ?? '';

/**
 * Retrieve operator session credentials.
 * Checks sessionStorage, localStorage, and environment configuration.
 */
export function getOperatorCredentials() {
  const key =
    (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('sentinel_operator_key')) ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('sentinel_operator_key')) ||
    import.meta.env.VITE_OPERATOR_API_KEY ||
    '';

  const name =
    (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('sentinel_operator_name')) ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('sentinel_operator_name')) ||
    import.meta.env.VITE_OPERATOR_NAME ||
    'duty_operator';

  return { key: key.trim(), name: name.trim() };
}

/**
 * Update operator session credentials in the current browser session.
 */
export function setOperatorCredentials({ key, name }) {
  if (typeof sessionStorage !== 'undefined') {
    if (key != null) sessionStorage.setItem('sentinel_operator_key', key.trim());
    if (name != null) sessionStorage.setItem('sentinel_operator_name', name.trim());
  }
}

/**
 * Generate operator authorization headers for secured backend endpoints.
 */
function getOperatorHeaders() {
  const { key, name } = getOperatorCredentials();
  const headers = {
    'x-operator-name': name || 'duty_operator',
  };

  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
    headers['x-operator-key'] = key;
  }

  return headers;
}

async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  const res = await fetch(url, {
    ...options,
    headers,
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
  getStatus:           (options)      => request('/status', options),
  getIncidents:        (options)      => request('/incidents', options),
  getIncident:         (id, options)  => request(`/incidents/${id}`, options),
  getPendingApprovals: (options)      => request('/incidents/pending-approvals', options),
  getReports:          (options)      => request('/reports', options),
  submitReport:        (body, options)=> request('/reports', { method: 'POST', body: JSON.stringify(body), ...options }),

  approve: (id, options = {}) =>
    request(`/incidents/${id}/approve`, {
      method: 'POST',
      ...options,
      headers: {
        ...getOperatorHeaders(),
        ...options.headers,
      },
    }),

  reject: (id, reason, options = {}) =>
    request(`/incidents/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
      ...options,
      headers: {
        ...getOperatorHeaders(),
        ...options.headers,
      },
    }),
};
