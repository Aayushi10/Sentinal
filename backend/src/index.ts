/**
 * index.ts — Sentinel Backend
 * ---------------------------
 * Single Express service that:
 *   - Accepts report submissions from the frontend
 *   - Runs TrueForge agent sessions in the background
 *   - Serves REST endpoints for reports + incidents
 *   - Provides a /status polling endpoint for live updates
 */

import express, { Express } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import reportsRouter from './routes/reports';
import incidentsRouter from './routes/incidents';
import { pool } from './db';
import { activeInvestigations } from './agent';

dotenv.config();

const app: Express = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// ---------------------------------------------------------------------------
// CORS Middleware (restricted origins with safe defaults)
// ---------------------------------------------------------------------------
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8080'];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
      if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS error: Origin ${origin} not allowed`));
    },
    credentials: true,
  }),
);

app.use(express.json());

// ---------------------------------------------------------------------------
// Health / polling
// ---------------------------------------------------------------------------

/** Simple liveness check. */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /status
 * Quick summary the frontend can poll every few seconds to detect new
 * incidents or approval state changes without fetching full payloads.
 */
app.get('/status', async (_req, res) => {
  try {
    const { rows } = await pool.query<{
      total_reports: string;
      total_incidents: string;
      pending_approvals: string;
      latest_incident_at: string | null;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM reports)                     AS total_reports,
        (SELECT COUNT(*) FROM incidents)                   AS total_incidents,
        (SELECT COUNT(*) FROM pending_approvals
          WHERE status = 'PENDING')                        AS pending_approvals,
        (SELECT MAX(created_at) FROM incidents)            AS latest_incident_at
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error('[/status] DB error:', err);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

/**
 * GET /investigations
 * Returns all live agent investigation sessions so the frontend can render
 * a real-time investigation feed without SSE.
 */
app.get('/investigations', (_req, res) => {
  res.json({ investigations: Array.from(activeInvestigations.values()) });
});

// ---------------------------------------------------------------------------
// Domain routes
// ---------------------------------------------------------------------------
app.use('/reports', reportsRouter);
app.use('/incidents', incidentsRouter);

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[sentinel-backend] Listening on http://localhost:${PORT}`);
  console.log(`[sentinel-backend] TRUEFORGE_BASE_URL=${process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790'}`);
});

export default app;
