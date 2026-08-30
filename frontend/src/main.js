/**
 * SENTINEL — Autonomous Crisis Intelligence & Dispatch Orchestration
 * Core Tactical Operations Console Controller
 */

import './style.css';
import L from 'leaflet';
import { api } from './api.js';
import { showToast } from './toast.js';
import {
  fmtTime, relTime, shortId, fmtCoords,
  fmtConfidence, fmtSeverity, fmtStatus, truncate, esc,
} from './utils.js';

// ─────────────────────────────────────────────────────────────────
// Application State
// ─────────────────────────────────────────────────────────────────
const state = {
  incidents: [],
  reports: [],
  status: null,
  selectedIncidentId: null,
  selectedIncident: null,
  sidebarTab: 'incidents', // 'incidents' | 'reports' | 'submit'
  loading: true,
  detailLoading: false,
  backendOnline: false,
  approvingId: null,
  rejectingId: null,
  reportDraft: { text: '', lat: '', lng: '', category: 'other' },
  cursorCoords: { lat: 37.7796, lng: -122.4194 },
  mapTheme: 'black', // 'black' | 'satellite'
  activeSignalId: null,
  decisionInProgress: false,
};

// Selection race-condition tokens
let currentSelectToken = 0;
let selectAbortController = null;

// ─────────────────────────────────────────────────────────────────
// Leaflet Map & "Incident Field" Layer Management
// ─────────────────────────────────────────────────────────────────
let map = null;
let incidentLayerGroup = null;
let reportLayerGroup = null;
let convergenceLayerGroup = null;
let pickPinMarker = null;
let blackTileLayer = null;
let satelliteTileLayer = null;

function initLeafletMap() {
  if (map) return;

  const mapEl = document.getElementById('sentinel-map');
  if (!mapEl) return;

  mapEl.classList.add('map-mode-black');

  // Initialize persistent Leaflet map
  map = L.map(mapEl, {
    center: [37.7796, -122.4194],
    zoom: 12,
    zoomControl: true,
    attributionControl: false,
  });

  // Pitch-Black High-Resolution Vector Tiles (lossless PNG, up to zoom 19, zero distortion)
  blackTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    subdomains: ['a', 'b', 'c'],
    maxZoom: 19,
    attribution: '',
  }).addTo(map);

  // Night Satellite Imagery Layer (Available via 1-click toggle)
  satelliteTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18,
    attribution: '',
  });

  convergenceLayerGroup = L.layerGroup().addTo(map);
  incidentLayerGroup = L.layerGroup().addTo(map);
  reportLayerGroup = L.layerGroup().addTo(map);

  // Track mouse coordinates for the Map HUD
  map.on('mousemove', (e) => {
    state.cursorCoords = { lat: e.latlng.lat, lng: e.latlng.lng };
    updateMapHUD();
  });

  // Map Click Listener for Telemetry Pinning
  map.on('click', (e) => {
    const lat = e.latlng.lat.toFixed(5);
    const lng = e.latlng.lng.toFixed(5);

    if (state.sidebarTab === 'submit') {
      state.reportDraft.lat = lat;
      state.reportDraft.lng = lng;

      const latInput = document.getElementById('telemetry-lat');
      const lngInput = document.getElementById('telemetry-lng');
      if (latInput) latInput.value = lat;
      if (lngInput) lngInput.value = lng;

      setPickPin(e.latlng.lat, e.latlng.lng);
      showToast(`Target coordinate locked: ${lat}, ${lng}`, 'success', 2200);
    }
  });

  setTimeout(() => {
    map.invalidateSize();
  }, 200);
}

function setPickPin(lat, lng) {
  if (!map) return;
  if (pickPinMarker) {
    map.removeLayer(pickPinMarker);
  }

  const pinIcon = L.divIcon({
    className: '',
    html: `
      <div class="marker-radar-ping" style="color: var(--amber-bright);">
        <div class="marker-radar-wave"></div>
        <div class="marker-radar-circle" style="background: var(--amber-primary); border-color: #fff;"></div>
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  });

  pickPinMarker = L.marker([lat, lng], { icon: pinIcon }).addTo(map);
}

/**
 * Upgrade the map into an "Incident Field".
 * When an incident is selected, render animated convergence vectors connecting
 * each associated public report to the incident centroid.
 */
function updateIncidentField() {
  if (!map || !incidentLayerGroup || !convergenceLayerGroup) return;

  incidentLayerGroup.clearLayers();
  reportLayerGroup.clearLayers();
  convergenceLayerGroup.clearLayers();

  const selectedId = state.selectedIncidentId;

  // 1. Plot Incidents
  state.incidents.forEach((inc) => {
    const cLat = parseFloat(inc.centroid_lat);
    const cLng = parseFloat(inc.centroid_lng);
    if (!isFinite(cLat) || !isFinite(cLng)) return;

    const isSelected = inc.id === selectedId;
    const needsDecision = isPendingDecision(inc);
    const sev = (inc.severity || 'medium').toLowerCase();

    let color = '#f59e0b';
    if (sev === 'critical') color = '#ef4444';
    if (sev === 'high') color = '#f97316';
    if (sev === 'low') color = '#10b981';

    const size = isSelected ? 22 : needsDecision ? 18 : 14;

    const icon = L.divIcon({
      className: '',
      html: `
        <div class="marker-radar-ping" style="color: ${color};">
          ${isSelected ? '<div class="centroid-reticle"></div>' : ''}
          ${needsDecision || isSelected ? '<div class="marker-radar-wave"></div>' : ''}
          <div class="marker-radar-circle" style="background: ${color}; width: ${size}px; height: ${size}px; ${isSelected ? 'border: 2.5px solid #fff; box-shadow: 0 0 20px ' + color : ''}"></div>
        </div>
      `,
      iconSize: [52, 52],
      iconAnchor: [26, 26],
    });

    const marker = L.marker([cLat, cLng], { icon, zIndexOffset: isSelected ? 1000 : 100 });
    marker.on('click', () => selectIncident(inc.id));
    incidentLayerGroup.addLayer(marker);

    // 2. SIGNAL CONVERGENCE: Draw animated vector lines connecting reports to centroid
    if (isSelected && inc.reports && inc.reports.length > 0) {
      inc.reports.forEach((rep) => {
        const rLat = parseFloat(rep.lat);
        const rLng = parseFloat(rep.lng);
        if (!isFinite(rLat) || !isFinite(rLng)) return;

        // Animated dashed polyline: Report -> Centroid
        const line = L.polyline([[rLat, rLng], [cLat, cLng]], {
          className: 'convergence-vector',
          color: '#f59e0b',
          weight: 1.8,
          opacity: 0.7,
        });
        convergenceLayerGroup.addLayer(line);

        // Report Signal Dot
        const cat = (rep.category || 'other').toLowerCase();
        let dotColor = '#94a3b8';
        if (cat === 'fire') dotColor = '#f87171';
        if (cat === 'hazard') dotColor = '#fbbf24';
        if (cat === 'crime') dotColor = '#c084fc';

        const isHighlighted = state.activeSignalId === rep.id;

        const repIcon = L.divIcon({
          className: '',
          html: `
            <div style="
              width: ${isHighlighted ? 13 : 9}px;
              height: ${isHighlighted ? 13 : 9}px;
              border-radius: 50%;
              background: ${dotColor};
              border: 1.5px solid #fff;
              box-shadow: 0 0 ${isHighlighted ? '12px #fff' : '6px ' + dotColor};
              cursor: pointer;
              transition: all 0.2s ease;
            "></div>
          `,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        });

        const repMarker = L.marker([rLat, rLng], { icon: repIcon, zIndexOffset: isHighlighted ? 500 : 50 });
        repMarker.bindPopup(`
          <div style="max-width: 220px; font-family: sans-serif;">
            <div style="font-size: 10px; font-weight: 800; color: ${dotColor}; text-transform: uppercase; margin-bottom: 2px;">
              ${cat} Telemetry Signal
            </div>
            <div style="font-size: 12px; color: #f8fafc; margin-bottom: 4px; line-height: 1.4;">
              ${esc(truncate(rep.text, 80))}
            </div>
            <div style="font-size: 10px; font-family: monospace; color: #94a3b8;">
              ${fmtCoords(rep.lat, rep.lng)} · ${relTime(rep.timestamp)}
            </div>
          </div>
        `);
        reportLayerGroup.addLayer(repMarker);
      });
    }
  });

  updateMapHUD();
}

function flyToTarget(lat, lng, zoom = 14) {
  if (!map || !isFinite(lat) || !isFinite(lng)) return;
  try {
    map.flyTo([lat, lng], zoom, { duration: 1.2, easeLinearity: 0.25 });
  } catch (e) {
    console.warn('Map flyTo failed', e);
  }
}

function fitAllIncidents() {
  if (!map || !state.incidents.length) return;
  const coords = state.incidents
    .map((i) => [parseFloat(i.centroid_lat), parseFloat(i.centroid_lng)])
    .filter(([lat, lng]) => isFinite(lat) && isFinite(lng));

  if (!coords.length) return;
  if (coords.length === 1) {
    map.flyTo(coords[0], 13);
  } else {
    map.fitBounds(L.latLngBounds(coords), { padding: [50, 50] });
  }
}

// ─────────────────────────────────────────────────────────────────
// Lightweight Cinematic Canvas 2D Globe Intro Transition
// ─────────────────────────────────────────────────────────────────
function playGlobeIntro(targetLat, targetLng, onComplete) {
  const overlay = document.getElementById('globe-intro-overlay');
  const canvas = document.getElementById('sentinel-globe-canvas');
  const telemetryText = document.getElementById('globe-telemetry-text');
  if (!overlay || !canvas) {
    if (onComplete) onComplete();
    return;
  }

  overlay.classList.remove('dismissed');

  const ctx = canvas.getContext('2d');
  const size = 320;
  canvas.width = size * window.devicePixelRatio;
  canvas.height = size * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const cx = size / 2;
  const cy = size / 2;
  const radius = 100;
  let rotation = 0;
  let animFrameId = null;
  const startTime = performance.now();
  const duration = 1800; // 1.8s duration

  function renderGlobe(time) {
    const elapsed = time - startTime;
    const progress = Math.min(elapsed / duration, 1);
    rotation += 0.035;

    ctx.clearRect(0, 0, size, size);

    // 1. Atmosphere Glow
    const grad = ctx.createRadialGradient(cx, cy, radius * 0.7, cx, cy, radius * 1.2);
    grad.addColorStop(0, 'rgba(245, 158, 11, 0.02)');
    grad.addColorStop(0.8, 'rgba(245, 158, 11, 0.08)');
    grad.addColorStop(1, 'rgba(245, 158, 11, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 1.25, 0, Math.PI * 2);
    ctx.fill();

    // 2. Sphere Outer Ring
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // 3. Rotating Longitude Meridians
    for (let i = 0; i < 6; i++) {
      const angle = rotation + (i * Math.PI) / 6;
      const xRadius = Math.abs(Math.cos(angle)) * radius;
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(cx, cy, xRadius, radius, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 4. Latitude Parallels
    for (let lat = -60; lat <= 60; lat += 30) {
      const yOffset = (Math.sin((lat * Math.PI) / 180) * radius);
      const rAtLat = Math.cos((lat * Math.PI) / 180) * radius;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.beginPath();
      ctx.ellipse(cx, cy + yOffset * 0.4, rAtLat, rAtLat * 0.25, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 5. Radar Sweep Line
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const sweepAngle = rotation * 1.5;
    ctx.lineTo(cx + Math.cos(sweepAngle) * radius, cy + Math.sin(sweepAngle) * radius);
    ctx.stroke();

    // 6. Targeting Reticle Locking In
    const reticleScale = 1 + (1 - progress) * 1.5;
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 14 * reticleScale, 0, Math.PI * 2);
    ctx.stroke();

    // Reticle cross lines
    ctx.beginPath();
    ctx.moveTo(cx - 20 * reticleScale, cy);
    ctx.lineTo(cx + 20 * reticleScale, cy);
    ctx.moveTo(cx, cy - 20 * reticleScale);
    ctx.lineTo(cx, cy + 20 * reticleScale);
    ctx.stroke();

    // Telemetry text updates
    if (elapsed < 600) {
      if (telemetryText) telemetryText.textContent = 'SCANNING GLOBAL INCIDENT SENSORS...';
    } else if (elapsed < 1300) {
      if (telemetryText) telemetryText.textContent = `TELEMETRY LOCKING: ${fmtCoords(targetLat, targetLng)}`;
    } else {
      if (telemetryText) telemetryText.textContent = `SIGNAL CONVERGENCE ACQUIRED [${fmtCoords(targetLat, targetLng)}]`;
    }

    if (progress < 1) {
      animFrameId = requestAnimationFrame(renderGlobe);
    } else {
      // Transition out
      overlay.classList.add('dismissed');
      cancelAnimationFrame(animFrameId);
      if (onComplete) onComplete();
    }
  }

  animFrameId = requestAnimationFrame(renderGlobe);
}

// ─────────────────────────────────────────────────────────────────
// UI Renderers — Investigation Pipeline & Topbar
// ─────────────────────────────────────────────────────────────────

function renderHeader() {
  const headerEl = document.getElementById('header');
  if (!headerEl) return;

  const pendingCount = state.incidents.filter(isPendingDecision).length;
  const now = new Date();
  const utcString = now.toUTCString().slice(17, 25) + ' UTC';

  headerEl.innerHTML = `
    <div class="brand-cluster">
      <div class="brand-logo-badge">
        <svg width="18" height="20" viewBox="0 0 24 28" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 1L23 6V14C23 20.5 17.5 25.8 12 27.5C6.5 25.8 1 20.5 1 14V6L12 1Z"/>
          <path d="M12 8V14M12 18H12.01" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="brand-text-col">
        <div class="brand-title">
          SENTINEL
          <span style="font-size: 10px; font-weight: 700; color: var(--amber-bright); background: var(--amber-dim); padding: 1px 6px; border-radius: 3px; border: 1px solid rgba(245,158,11,0.3);">TACTICAL</span>
        </div>
        <div class="brand-tagline">Emergency Intelligence &amp; Dispatch</div>
      </div>
    </div>

    <div class="header-telemetry">
      ${pendingCount > 0 ? `
        <button class="dispatch-alert-btn" id="btn-header-decision">
          ⚡ ${pendingCount} DECISION${pendingCount > 1 ? 'S' : ''} REQUIRED
        </button>
      ` : ''}

      <div class="system-clock">
        <span style="color: var(--text-dim); margin-right: 4px;">SYS</span>
        <strong>${utcString}</strong>
      </div>

      <div class="telemetry-pill">
        <span>Incidents:</span> <strong>${state.incidents.length}</strong>
      </div>

      <div class="telemetry-pill">
        <span>Signals:</span> <strong>${state.reports.length}</strong>
      </div>

      <div class="engine-status-chip">
        <div class="pulse-radar-dot"></div>
        <span>${state.backendOnline ? 'AI CORRELATING' : 'OFFLINE'}</span>
      </div>
    </div>
  `;

  const alertBtn = document.getElementById('btn-header-decision');
  if (alertBtn) {
    alertBtn.addEventListener('click', () => {
      const first = state.incidents.find(isPendingDecision);
      if (first) {
        state.sidebarTab = 'incidents';
        renderSidebarTabs();
        patchSidebar();
        selectIncident(first.id);
      }
    });
  }
}

/**
 * PRESERVED: Top Investigation Pipeline
 * Communicates current investigation stage clearly.
 */
function renderPipeline() {
  const pipeEl = document.getElementById('pipeline-strip');
  if (!pipeEl) return;

  const steps = [
    'Public Feeds',
    'AI Correlation',
    'Incident Cluster',
    'AI Recommendation',
    'Human Approval',
    'Tactical Dispatch',
  ];

  let currentStep = 1;
  if (state.selectedIncident) {
    const inc = state.selectedIncident;
    if (isPendingDecision(inc)) currentStep = 4;
    else if (inc.status === 'RESPONSE_IN_PROGRESS' || inc.status === 'DISPATCHED') currentStep = 5;
    else currentStep = 2;
  } else if (state.incidents.length > 0) {
    currentStep = 2;
  }

  pipeEl.innerHTML = steps.map((label, idx) => {
    const isDone = idx < currentStep;
    const isActive = idx === currentStep;
    const cls = isActive ? 'active' : isDone ? 'done' : '';
    return `
      <div class="pipeline-node ${cls}">
        <span class="node-index">${isDone ? '✓' : idx + 1}</span>
        <span>${label}</span>
      </div>
      ${idx < steps.length - 1 ? '<span class="pipeline-connector">→</span>' : ''}
    `;
  }).join('');
}

function renderSidebarTabs() {
  const tabsEl = document.getElementById('sidebar-tabs');
  if (!tabsEl) return;

  const pendingCount = state.incidents.filter(isPendingDecision).length;

  tabsEl.innerHTML = `
    <button class="sidebar-tab-btn ${state.sidebarTab === 'incidents' ? 'active' : ''}" data-tab="incidents">
      Incidents <span class="tab-badge ${pendingCount > 0 ? 'badge-urgent' : ''}">${pendingCount > 0 ? `⚡${pendingCount}` : state.incidents.length}</span>
    </button>
    <button class="sidebar-tab-btn ${state.sidebarTab === 'reports' ? 'active' : ''}" data-tab="reports">
      Signal Stream <span class="tab-badge">${state.reports.length}</span>
    </button>
    <button class="sidebar-tab-btn ${state.sidebarTab === 'submit' ? 'active' : ''}" data-tab="submit">
      + Telemetry
    </button>
  `;

  tabsEl.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.sidebarTab = btn.dataset.tab;
      renderSidebarTabs();
      patchSidebar();
    });
  });
}

function patchSidebar() {
  const contentEl = document.getElementById('sidebar-content');
  if (!contentEl) return;

  if (state.sidebarTab === 'incidents') {
    contentEl.innerHTML = renderIncidentCards();
    bindIncidentCardEvents();
  } else if (state.sidebarTab === 'reports') {
    contentEl.innerHTML = renderSignalStream();
    bindSignalStreamEvents();
  } else if (state.sidebarTab === 'submit') {
    contentEl.innerHTML = renderSubmitForm();
    bindSubmitFormEvents();
  }
}

function renderIncidentCards() {
  if (state.loading) {
    return Array(3).fill(0).map(() => `
      <div class="incident-card" style="opacity: 0.5;">
        <div style="height: 12px; background: var(--bg-surface-elevated); border-radius: 4px; margin-bottom: 8px;"></div>
        <div style="height: 16px; width: 75%; background: var(--bg-surface-elevated); border-radius: 4px; margin-bottom: 8px;"></div>
        <div style="height: 12px; width: 40%; background: var(--bg-surface-elevated); border-radius: 4px;"></div>
      </div>
    `).join('');
  }

  if (!state.incidents.length) {
    return `
      <div style="padding: 30px 16px; text-align: center; color: var(--text-dim);">
        <div style="font-size: 22px; margin-bottom: 6px;">📡</div>
        <div style="font-weight: 700; color: var(--text-secondary); margin-bottom: 4px;">No Active Incidents</div>
        <div style="font-size: 12px;">Submit new telemetry reports to initiate automated Sentinel correlation.</div>
      </div>
    `;
  }

  const sorted = [...state.incidents].sort((a, b) => {
    const aP = isPendingDecision(a) ? 1 : 0;
    const bP = isPendingDecision(b) ? 1 : 0;
    if (bP !== aP) return bP - aP;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  return sorted.map((inc) => {
    const isSelected = inc.id === state.selectedIncidentId;
    const pending = isPendingDecision(inc);
    const sev = (inc.severity || 'medium').toLowerCase();

    return `
      <div class="incident-card ${isSelected ? 'active' : ''} ${pending ? 'decision-pending' : ''}" data-incident-id="${esc(inc.id)}">
        <div class="card-top-meta">
          <span class="incident-id-tag">#${shortId(inc.id)}</span>
          <div class="card-badges-row">
            ${pending ? '<span class="badge-sev high" style="animation: urgent-pulse 1.4s infinite alternate;">⚡ DECISION</span>' : ''}
            <span class="badge-sev ${sev}">${fmtSeverity(inc.severity)}</span>
            <span class="badge-status">${fmtStatus(inc.status)}</span>
          </div>
        </div>
        <div class="card-title-text">${esc(inc.target || inc.recommendation || 'Under Investigation')}</div>
        <div class="card-bottom-telemetry">
          <span class="card-feed-count">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 1 1 0 10A5 5 0 0 1 8 3zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
            ${inc.reports?.length ?? 1} Signals
          </span>
          <span>${relTime(inc.created_at)}</span>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Live "Signal Stream" in Sidebar (Reports Tab)
 * Compact, sleek feed rows with timestamp, source tag, and location.
 */
function renderSignalStream() {
  if (!state.reports.length) {
    return `
      <div style="padding: 30px 16px; text-align: center; color: var(--text-dim);">
        <div style="font-weight: 700; color: var(--text-secondary); margin-bottom: 4px;">Signal Stream Idle</div>
        <div style="font-size: 11px;">Waiting for incoming emergency telemetry feeds...</div>
      </div>
    `;
  }

  return `
    <div class="signal-stream-container">
      ${state.reports.map((rep) => {
        const cat = (rep.category || 'other').toLowerCase();
        const isLinked = !!rep.incident_id;
        const isActive = state.activeSignalId === rep.id;

        return `
          <div class="signal-stream-item ${isActive ? 'active-signal' : ''}"
               data-report-id="${esc(rep.id)}"
               data-incident-id="${esc(rep.incident_id || '')}"
               data-lat="${rep.lat ?? ''}"
               data-lng="${rep.lng ?? ''}">
            <div class="signal-top-line">
              <span class="category-tag ${cat}">${cat}</span>
              <span>${fmtTime(rep.timestamp).split('·')[1] || relTime(rep.timestamp)}</span>
            </div>
            <div class="signal-body-text">${esc(rep.text)}</div>
            <div class="signal-bottom-line">
              <span>${fmtCoords(rep.lat, rep.lng)}</span>
              ${isLinked
                ? `<span style="color: var(--amber-bright); font-weight: 700;">→ INC #${shortId(rep.incident_id)}</span>`
                : `<span style="color: var(--text-tertiary);">Uncorrelated</span>`}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderSubmitForm() {
  const d = state.reportDraft;
  return `
    <form class="telemetry-form" id="telemetry-form" novalidate>
      <div class="form-guidance">
        Field Telemetry Dispatch. Sentinel correlates incoming public signals into emergency clusters and prepares automated response recommendations.
      </div>

      <div class="input-group">
        <label class="input-label" for="telemetry-desc">Field Observation</label>
        <textarea class="input-textarea" id="telemetry-desc" name="text"
          placeholder="Describe observation (e.g. Chemical smoke pouring from second floor warehouse near McAllister & Larkin St)..." required>${esc(d.text)}</textarea>
      </div>

      <div class="input-group">
        <label class="input-label">Coordinates</label>
        <div class="coords-row">
          <input class="input-text" id="telemetry-lat" name="lat" type="number" step="any"
            placeholder="Latitude" value="${esc(d.lat)}" required />
          <input class="input-text" id="telemetry-lng" name="lng" type="number" step="any"
            placeholder="Longitude" value="${esc(d.lng)}" required />
        </div>
        <div class="coords-tools">
          <button type="button" class="tool-chip-btn" id="btn-pick-map">
            📍 Pick on Map
          </button>
          <button type="button" class="tool-chip-btn" id="btn-pick-gps">
            🎯 GPS
          </button>
          <button type="button" class="tool-chip-btn" id="btn-pick-demo">
            🏙 SF Demo
          </button>
        </div>
      </div>

      <div class="input-group">
        <label class="input-label" for="telemetry-cat">Hazard Classification</label>
        <select class="input-select" id="telemetry-cat" name="category">
          <option value="other" ${d.category === 'other' ? 'selected' : ''}>General Observation</option>
          <option value="fire" ${d.category === 'fire' ? 'selected' : ''}>🔥 Structure / Fire Alert</option>
          <option value="crime" ${d.category === 'crime' ? 'selected' : ''}>🚔 Tactical Emergency</option>
          <option value="hazard" ${d.category === 'hazard' ? 'selected' : ''}>⚠️ Hazard Material / Spill</option>
        </select>
      </div>

      <button type="submit" class="btn-primary-dispatch" id="btn-submit-telemetry">
        Transmitting Signal to Sentinel →
      </button>

      <div id="telemetry-error" style="display:none; color: var(--sev-critical); font-size: 11px; font-weight: 700; padding: 4px;"></div>
    </form>
  `;
}

function updateMapHUD() {
  const hudEl = document.getElementById('map-hud');
  if (!hudEl) return;

  const isBlack = state.mapTheme === 'black';

  hudEl.innerHTML = `
    <div class="hud-pill">
      <span style="color: var(--amber-bright);">●</span>
      <span>ACTIVE FIELD: <strong>${state.incidents.length} CLUSTER${state.incidents.length === 1 ? '' : 'S'}</strong></span>
      <button id="btn-fit-map" title="Fit all incidents on screen">FIT ALL</button>
      <span style="color: var(--border-medium); margin: 0 2px;">|</span>
      <button id="btn-toggle-theme" title="Toggle between Pitch Black vector and Night Satellite map">
        ${isBlack ? '🛰️ SATELLITE' : '⬛ PITCH BLACK'}
      </button>
      <span style="color: var(--border-medium); margin: 0 2px;">|</span>
      <button id="btn-reacquire" title="Replay Global Signal Acquisition">🌐 ACQUIRE</button>
    </div>

    <div class="hud-pill">
      <span>GRID: <strong>${fmtCoords(state.cursorCoords.lat, state.cursorCoords.lng)}</strong></span>
    </div>
  `;

  const fitBtn = document.getElementById('btn-fit-map');
  if (fitBtn) fitBtn.addEventListener('click', fitAllIncidents);

  const themeBtn = document.getElementById('btn-toggle-theme');
  if (themeBtn) themeBtn.addEventListener('click', toggleMapTheme);

  const acqBtn = document.getElementById('btn-reacquire');
  if (acqBtn) {
    acqBtn.addEventListener('click', () => {
      const activeLat = state.selectedIncident ? parseFloat(state.selectedIncident.centroid_lat) : 37.7796;
      const activeLng = state.selectedIncident ? parseFloat(state.selectedIncident.centroid_lng) : -122.4194;
      playGlobeIntro(activeLat, activeLng, () => {
        flyToTarget(activeLat, activeLng, 14);
      });
    });
  }
}

function toggleMapTheme() {
  const mapEl = document.getElementById('sentinel-map');
  if (!map || !mapEl) return;

  if (state.mapTheme === 'black') {
    state.mapTheme = 'satellite';
    if (map.hasLayer(blackTileLayer)) map.removeLayer(blackTileLayer);
    satelliteTileLayer.addTo(map);
    mapEl.classList.remove('map-mode-black');
    mapEl.classList.add('map-mode-satellite');
    showToast('Mode: Night Satellite', 'success', 1800);
  } else {
    state.mapTheme = 'black';
    if (map.hasLayer(satelliteTileLayer)) map.removeLayer(satelliteTileLayer);
    blackTileLayer.addTo(map);
    mapEl.classList.remove('map-mode-satellite');
    mapEl.classList.add('map-mode-black');
    showToast('Mode: Pitch Black Tactical Vector', 'success', 1800);
  }
  updateMapHUD();
}

// ─────────────────────────────────────────────────────────────────
// Investigation & Decision Panel: 4-Stage Narrative Architecture
// ─────────────────────────────────────────────────────────────────
function renderDetailDrawer() {
  const drawerEl = document.getElementById('detail-drawer');
  if (!drawerEl) return;

  if (!state.selectedIncident) {
    drawerEl.style.display = 'none';
    drawerEl.innerHTML = '';
    return;
  }

  drawerEl.style.display = 'flex';
  const inc = state.selectedIncident;
  const isPending = isPendingDecision(inc);
  const isAuthorized = inc.status === 'RESPONSE_IN_PROGRESS' || inc.status === 'DISPATCHED';
  const sev = (inc.severity || 'medium').toLowerCase();

  const approvalTarget = inc.active_approval?.target || inc.target || inc.recommendation || 'Dispatch Station 14';
  const evidenceSummary = inc.active_approval?.evidence || inc.evidence || 'Multiple correlated public signals confirm structural emergency with high convergence.';

  // Chronological reports for Evidence Convergence Timeline (oldest to newest)
  const validReports = (inc.reports || [])
    .map((r) => ({
      ...r,
      _timeMs: r.timestamp ? new Date(r.timestamp).getTime() : NaN,
    }))
    .sort((a, b) => (isNaN(a._timeMs) ? 1 : isNaN(b._timeMs) ? -1 : a._timeMs - b._timeMs));

  const earliestValid = validReports.find((r) => !isNaN(r._timeMs));
  const originMs = earliestValid ? earliestValid._timeMs : null;

  drawerEl.innerHTML = `
    <div class="drawer-header-bar">
      <div class="drawer-title-group">
        <span class="incident-id-tag">INCIDENT · #${shortId(inc.id)}</span>
        <div class="drawer-target-title">${esc(inc.target || inc.recommendation || 'Active Investigation')}</div>
        <span class="badge-sev ${sev}">${fmtSeverity(inc.severity)}</span>
        <span class="badge-status">${fmtStatus(inc.status)}</span>
      </div>
      <button class="drawer-close-btn" id="btn-close-drawer" title="Close Panel (Esc)">✕</button>
    </div>

    <div class="drawer-scroll-body">
      <!-- STAGE 1: INCIDENT CORRELATED -->
      <div class="investigation-stage">
        <div class="stage-header-label">
          <span>01 · Incident Correlated</span>
        </div>
        <div class="detail-telemetry-grid">
          <div class="telemetry-cell">
            <div class="cell-label">Centroid Coordinates</div>
            <div class="cell-value">${fmtCoords(inc.centroid_lat, inc.centroid_lng)}</div>
          </div>
          <div class="telemetry-cell">
            <div class="cell-label">Correlated Signals</div>
            <div class="cell-value" style="color: var(--amber-bright);">${inc.reports?.length ?? 1} Field Reports</div>
          </div>
          <div class="telemetry-cell">
            <div class="cell-label">Correlation Confidence</div>
            <div class="cell-value">${fmtConfidence(inc.confidence)}</div>
          </div>
          <div class="telemetry-cell">
            <div class="cell-label">Response Status</div>
            <div class="cell-value" style="color: ${isAuthorized ? 'var(--sev-low)' : isPending ? 'var(--amber-bright)' : 'var(--text-secondary)'};">
              ${isAuthorized ? '✓ RESPONSE AUTHORIZED' : isPending ? '⚡ DECISION PENDING' : fmtStatus(inc.status)}
            </div>
          </div>
        </div>
      </div>

      <!-- STAGE 2: EVIDENCE CONVERGENCE TIMELINE -->
      <div class="investigation-stage">
        <div class="stage-header-label">
          <span>02 · Evidence Convergence Timeline</span>
        </div>
        <div class="evidence-convergence-flow">
          ${validReports.length > 0 ? `
            <div class="timeline-signal-chain">
              ${validReports.map((r) => {
                let timeLabel = '[SIGNAL]';
                if (originMs != null && !isNaN(r._timeMs)) {
                  const diffSec = Math.max(0, Math.floor((r._timeMs - originMs) / 1000));
                  if (diffSec === 0) {
                    timeLabel = '[T-0s Initial]';
                  } else if (diffSec < 60) {
                    timeLabel = `[+${diffSec}s]`;
                  } else {
                    const mins = Math.floor(diffSec / 60);
                    const remSec = diffSec % 60;
                    timeLabel = remSec > 0 ? `[+${mins}m ${remSec}s]` : `[+${mins}m]`;
                  }
                } else if (r.timestamp) {
                  timeLabel = `[${relTime(r.timestamp)}]`;
                }
                return `
                  <div class="signal-chain-item" data-report-id="${esc(r.id)}">
                    <div class="signal-chain-dot"></div>
                    <span class="signal-chain-time">${timeLabel}</span>
                    <span style="font-weight: 700; color: var(--text-primary); text-transform: uppercase; font-size: 10px; margin-right: 6px;">
                      ${esc(r.category || 'signal')}
                    </span>
                    ${esc(r.text)}
                  </div>
                `;
              }).join('')}
            </div>
          ` : ''}

          <div class="convergence-synthesis-box">
            <div class="convergence-synthesis-label">Sentinel Synthesized Evidentiary Assessment</div>
            <div>${esc(evidenceSummary)}</div>
          </div>
        </div>
      </div>

      <!-- STAGE 3 & 4: WHAT SENTINEL FOUND, RECOMMENDS & HUMAN DECISION -->
      <div class="investigation-stage">
        <div class="stage-header-label">
          <span>03 · Recommended Response &amp; Human Authorization</span>
        </div>

        ${isPending ? `
          <div class="approval-callout-card">
            <div class="approval-prompt-lead">Sentinel Recommends Tactical Action</div>
            <div class="approval-action-heading">${esc(approvalTarget)}</div>
            <div class="approval-disclaimer">
              Autonomous execution is paused. Human verification required before emergency dispatch can proceed.
            </div>
            <div class="approval-btn-row">
              <button class="btn-approval-confirm" id="btn-approve-action" data-id="${esc(inc.id)}">
                ✓ APPROVE DISPATCH
              </button>
              <button class="btn-approval-reject" id="btn-reject-action" data-id="${esc(inc.id)}">
                ✕ REJECT / STAND DOWN
              </button>
            </div>
          </div>
        ` : isAuthorized ? `
          <div class="authorized-status-box">
            <div class="authorized-status-title">
              <span style="font-size: 16px;">✓</span>
              <span>Tactical Dispatch Authorized: ${esc(inc.action_taken || 'DISPATCH_RESOURCE')} → ${esc(inc.target || 'unit_station_14')}</span>
            </div>
            <span style="font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary);">
              ${inc.audit_log?.length ? 'Operator Verified' : 'In Progress'}
            </span>
          </div>
        ` : `
          <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 12px; font-size: 12px; color: var(--text-secondary);">
            Investigation in progress. Sentinel is continuously correlating incoming telemetry.
          </div>
        `}
      </div>

      <!-- AUDIT LOG IF AVAILABLE -->
      ${inc.audit_log && inc.audit_log.length > 0 ? `
        <div class="investigation-stage">
          <div class="stage-header-label">
            <span>04 · Mission Audit Log</span>
          </div>
          <div style="background: var(--bg-surface-elevated); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 10px 14px; font-family: var(--font-mono); font-size: 11px;">
            ${inc.audit_log.map((entry) => `
              <div style="padding: 4px 0; border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between;">
                <span style="color: var(--amber-bright); font-weight: 700;">[${esc(entry.action)}] → ${esc(entry.target || 'operator')}</span>
                <span style="color: var(--text-dim);">${fmtTime(entry.created_at)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;

  // Bind Drawer Actions
  const closeBtn = document.getElementById('btn-close-drawer');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      state.selectedIncident = null;
      state.selectedIncidentId = null;
      renderDetailDrawer();
      patchSidebar();
      updateIncidentField();
      if (map) map.invalidateSize();
    });
  }

  const approveBtn = document.getElementById('btn-approve-action');
  if (approveBtn) {
    approveBtn.addEventListener('click', () => handleApprove(approveBtn.dataset.id));
  }

  const rejectBtn = document.getElementById('btn-reject-action');
  if (rejectBtn) {
    rejectBtn.addEventListener('click', () => handleReject(rejectBtn.dataset.id));
  }
}

// ─────────────────────────────────────────────────────────────────
// Event Listeners & Dispatch Actions
// ─────────────────────────────────────────────────────────────────

function bindIncidentCardEvents() {
  document.querySelectorAll('.incident-card[data-incident-id]').forEach((card) => {
    card.addEventListener('click', () => {
      selectIncident(card.dataset.incidentId);
    });
  });
}

function bindSignalStreamEvents() {
  document.querySelectorAll('.signal-stream-item').forEach((card) => {
    card.addEventListener('click', () => {
      state.activeSignalId = card.dataset.reportId;
      document.querySelectorAll('.signal-stream-item').forEach(c => c.classList.remove('active-signal'));
      card.classList.add('active-signal');

      if (card.dataset.incidentId) {
        state.sidebarTab = 'incidents';
        renderSidebarTabs();
        selectIncident(card.dataset.incidentId);
      } else if (card.dataset.lat && card.dataset.lng) {
        const lat = parseFloat(card.dataset.lat);
        const lng = parseFloat(card.dataset.lng);
        flyToTarget(lat, lng, 15);
        showToast('Targeting telemetry signal on map', 'success', 1800);
      }
    });

    card.addEventListener('mouseenter', () => {
      state.activeSignalId = card.dataset.reportId;
      updateIncidentField();
    });
  });
}

function bindSubmitFormEvents() {
  const form = document.getElementById('telemetry-form');
  if (!form) return;

  const sync = () => {
    if (form.text) state.reportDraft.text = form.text.value;
    if (form.lat) state.reportDraft.lat = form.lat.value;
    if (form.lng) state.reportDraft.lng = form.lng.value;
    if (form.category) state.reportDraft.category = form.category.value;
  };
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);

  const mapPickBtn = document.getElementById('btn-pick-map');
  if (mapPickBtn) {
    mapPickBtn.addEventListener('click', () => {
      showToast('Click anywhere on the map to place telemetry coordinate', 'warning', 3500);
    });
  }

  const gpsBtn = document.getElementById('btn-pick-gps');
  if (gpsBtn) {
    gpsBtn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        showToast('Browser geolocation unavailable', 'error');
        return;
      }
      gpsBtn.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const lat = pos.coords.latitude.toFixed(5);
          const lng = pos.coords.longitude.toFixed(5);
          state.reportDraft.lat = lat;
          state.reportDraft.lng = lng;
          if (form.lat) form.lat.value = lat;
          if (form.lng) form.lng.value = lng;
          setPickPin(lat, lng);
          flyToTarget(lat, lng, 14);
          showToast('GPS coordinates acquired', 'success');
          gpsBtn.textContent = '🎯 GPS';
        },
        (err) => {
          showToast(`Location error: ${err.message}`, 'error');
          gpsBtn.textContent = '🎯 GPS';
        },
        { timeout: 8000 }
      );
    });
  }

  const demoBtn = document.getElementById('btn-pick-demo');
  if (demoBtn) {
    demoBtn.addEventListener('click', () => {
      const lat = (37.7796 + (Math.random() - 0.5) * 0.015).toFixed(5);
      const lng = (-122.4194 + (Math.random() - 0.5) * 0.015).toFixed(5);
      state.reportDraft.lat = lat;
      state.reportDraft.lng = lng;
      if (form.lat) form.lat.value = lat;
      if (form.lng) form.lng.value = lng;
      setPickPin(lat, lng);
      flyToTarget(lat, lng, 14);
      showToast('SF Downtown telemetry loaded', 'success', 1800);
    });
  }

  form.addEventListener('submit', handleTelemetrySubmit);
}

async function selectIncident(id) {
  if (!id) return;
  state.selectedIncidentId = id;
  patchSidebar();

  if (selectAbortController) {
    selectAbortController.abort();
  }
  selectAbortController = new AbortController();
  const token = ++currentSelectToken;

  try {
    const incData = await api.getIncident(id, { signal: selectAbortController.signal });
    // Guard against out-of-order responses or stale selections
    if (token !== currentSelectToken || state.selectedIncidentId !== id) {
      return;
    }
    state.selectedIncident = incData;

    renderPipeline();
    renderDetailDrawer();
    updateIncidentField();

    const lat = parseFloat(incData.centroid_lat);
    const lng = parseFloat(incData.centroid_lng);
    if (isFinite(lat) && isFinite(lng)) {
      flyToTarget(lat, lng, 14);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    showToast(`Failed to load incident detail: ${err.message}`, 'error');
  }
}

function setDecisionControlsBusy(isBusy, actionType = 'approve') {
  state.decisionInProgress = isBusy;
  const approveBtn = document.getElementById('btn-approve-action');
  const rejectBtn = document.getElementById('btn-reject-action');

  if (approveBtn) {
    approveBtn.disabled = isBusy;
    if (isBusy && actionType === 'approve') {
      approveBtn.textContent = 'AUTHORIZING DISPATCH…';
    } else if (!isBusy) {
      approveBtn.textContent = '✓ APPROVE DISPATCH';
    }
  }

  if (rejectBtn) {
    rejectBtn.disabled = isBusy;
    if (isBusy && actionType === 'reject') {
      rejectBtn.textContent = 'REJECTING…';
    } else if (!isBusy) {
      rejectBtn.textContent = '✕ REJECT / STAND DOWN';
    }
  }
}

async function handleApprove(id) {
  if (state.decisionInProgress) return;
  setDecisionControlsBusy(true, 'approve');

  try {
    await api.approve(id);
    showToast('✓ Dispatch Authorized: Response in progress', 'success', 5000);
    await reloadData();
    if (state.selectedIncidentId) {
      await selectIncident(state.selectedIncidentId);
    }
  } catch (err) {
    showToast(`Approval failed: ${err.message}`, 'error');
    setDecisionControlsBusy(false);
  } finally {
    state.decisionInProgress = false;
  }
}

async function handleReject(id) {
  if (state.decisionInProgress) return;
  setDecisionControlsBusy(true, 'reject');

  try {
    await api.reject(id, 'Rejected by Human Operator');
    showToast('Action rejected. Incident remains active under investigation.', 'warning', 5000);
    await reloadData();
    if (state.selectedIncidentId) {
      await selectIncident(state.selectedIncidentId);
    }
  } catch (err) {
    showToast(`Rejection failed: ${err.message}`, 'error');
    setDecisionControlsBusy(false);
  } finally {
    state.decisionInProgress = false;
  }
}

async function handleTelemetrySubmit(e) {
  e.preventDefault();
  const form = e.target;
  const errEl = document.getElementById('telemetry-error');
  const btn = document.getElementById('btn-submit-telemetry');

  const text = form.text?.value?.trim();
  const lat = parseFloat(form.lat?.value);
  const lng = parseFloat(form.lng?.value);
  const category = form.category?.value || 'other';

  if (errEl) errEl.style.display = 'none';

  if (!text || text.length < 3) {
    if (errEl) { errEl.textContent = 'Please enter an observation description (min 3 chars).'; errEl.style.display = 'block'; }
    return;
  }
  if (!isFinite(lat) || lat < -90 || lat > 90) {
    if (errEl) { errEl.textContent = 'Please provide a valid latitude (-90 to 90).'; errEl.style.display = 'block'; }
    return;
  }
  if (!isFinite(lng) || lng < -180 || lng > 180) {
    if (errEl) { errEl.textContent = 'Please provide a valid longitude (-180 to 180).'; errEl.style.display = 'block'; }
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Broadcasting to Sentinel…';

  try {
    await api.submitReport({ text, lat, lng, category });
    showToast('Field observation transmitted to Sentinel AI Engine', 'success');

    state.reportDraft = { text: '', lat: '', lng: '', category: 'other' };
    if (pickPinMarker && map) {
      map.removeLayer(pickPinMarker);
      pickPinMarker = null;
    }
    form.reset();

    await reloadData();
    state.sidebarTab = 'incidents';
    renderSidebarTabs();
    patchSidebar();
  } catch (err) {
    if (errEl) {
      errEl.textContent = `Transmission error: ${err.message}`;
      errEl.style.display = 'block';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Transmitting Signal to Sentinel →';
  }
}

// ─────────────────────────────────────────────────────────────────
// Data Sync & Polling
// ─────────────────────────────────────────────────────────────────
async function reloadData() {
  try {
    const activeDetailId = state.selectedIncidentId;
    const fetchDetail = activeDetailId && !state.decisionInProgress;
    const detailPromise = fetchDetail
      ? api.getIncident(activeDetailId).catch(() => null)
      : Promise.resolve(null);

    const [incData, repData, statData, refreshedIncident] = await Promise.all([
      api.getIncidents(),
      api.getReports(),
      api.getStatus().catch(() => null),
      detailPromise,
    ]);

    state.incidents = incData.incidents || [];
    state.reports = repData.reports || [];
    state.status = statData;
    state.backendOnline = true;
    state.loading = false;

    // Reconcile open selected incident detail safely without race conditions
    if (refreshedIncident && state.selectedIncidentId === activeDetailId && !state.decisionInProgress) {
      state.selectedIncident = refreshedIncident;
      renderDetailDrawer();
    } else if (activeDetailId && !state.incidents.some((i) => i.id === activeDetailId)) {
      state.selectedIncident = null;
      state.selectedIncidentId = null;
      renderDetailDrawer();
    }

    renderHeader();
    renderPipeline();
    renderSidebarTabs();

    const isTypingInSubmit = state.sidebarTab === 'submit';
    if (!isTypingInSubmit) {
      patchSidebar();
    }

    updateIncidentField();
  } catch (err) {
    state.backendOnline = false;
    state.loading = false;
    renderHeader();
  }
}

function isPendingDecision(inc) {
  if (!inc) return false;
  const status = String(inc.status || '').toUpperCase();
  return status === 'PENDING_APPROVAL' ||
         inc.active_approval != null ||
         inc.approval_status === 'PENDING' ||
         (inc.pending_session_id != null && inc.pending_turn_id != null);
}

// ─────────────────────────────────────────────────────────────────
// Bootstrap Initializer
// ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  initLeafletMap();

  renderHeader();
  renderPipeline();
  renderSidebarTabs();
  patchSidebar();
  updateMapHUD();

  await reloadData();

  // Initial Geographic Signal Acquisition: play globe animation for ~1.8s, then lock onto primary incident
  const primaryInc = state.incidents[0];
  const targetLat = primaryInc ? parseFloat(primaryInc.centroid_lat) : 37.7796;
  const targetLng = primaryInc ? parseFloat(primaryInc.centroid_lng) : -122.4194;

  const hasPlayed = sessionStorage.getItem('sentinel_globe_played');
  if (!hasPlayed) {
    sessionStorage.setItem('sentinel_globe_played', 'true');
    playGlobeIntro(targetLat, targetLng, () => {
      flyToTarget(targetLat, targetLng, 13);
      if (primaryInc) {
        selectIncident(primaryInc.id);
      }
    });
  } else {
    // If already played in session, dismiss overlay directly and fly
    const overlay = document.getElementById('globe-intro-overlay');
    if (overlay) overlay.classList.add('dismissed');
    setTimeout(() => {
      fitAllIncidents();
      if (primaryInc) selectIncident(primaryInc.id);
    }, 300);
  }

  // Polling cycle (every 5 seconds)
  setInterval(() => {
    reloadData();
  }, 5000);

  // Esc closes drawer
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selectedIncident) {
      state.selectedIncident = null;
      state.selectedIncidentId = null;
      renderDetailDrawer();
      patchSidebar();
      updateIncidentField();
    }
  });
}

bootstrap();
