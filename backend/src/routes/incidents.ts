/**
 * routes/incidents.ts
 * -------------------
 * GET  /incidents              — list incidents with their reports + approval state
 * GET  /incidents/:id          — get one incident (full detail)
 * POST /incidents/:id/approve  — approve a pending agent action (resume with allow)
 * POST /incidents/:id/reject   — reject a pending agent action (resume with deny)
 */

import { Router, Request, Response, IRouter } from 'express';
import { pool } from '../db';
import { approveIncidentAction, rejectIncidentAction } from '../agent';

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Shared column list — keeps SELECT statements DRY and type-safe
// ---------------------------------------------------------------------------
const INCIDENT_FIELDS = [
  'id', 'status', 'severity', 'confidence',
  'centroid_lat', 'centroid_lng', 'action_taken', 'target',
  'created_at', 'updated_at',
  'pending_session_id', 'pending_turn_id', 'pending_thread_id', 'pending_tool_call_id',
  'approval_status', 'evidence', 'recommendation'
];

const INCIDENT_COLUMNS_ALIASED = INCIDENT_FIELDS.map((f) => `i.${f}`).join(', ');
const INCIDENT_COLUMNS = INCIDENT_FIELDS.join(', ');

// ---------------------------------------------------------------------------
// GET /incidents
// ---------------------------------------------------------------------------
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Fetch all incidents with their linked reports in one round-trip
    const { rows } = await pool.query(`
      SELECT
        ${INCIDENT_COLUMNS_ALIASED},
        COALESCE(
          json_agg(
            json_build_object(
              'id',        r.id,
              'text',      r.text,
              'lat',       r.lat,
              'lng',       r.lng,
              'category',  r.category,
              'timestamp', r.timestamp
            ) ORDER BY r.timestamp DESC
          ) FILTER (WHERE r.id IS NOT NULL),
          '[]'::json
        ) AS reports
      FROM incidents i
      LEFT JOIN reports r ON r.incident_id = i.id
      GROUP BY i.id
      ORDER BY i.created_at DESC
      LIMIT 200
    `);
    res.json({ incidents: rows });
  } catch (err) {
    console.error('[routes/incidents] DB error:', err);
    res.status(500).json({ error: 'Failed to list incidents' });
  }
});

// ---------------------------------------------------------------------------
// GET /incidents/:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const [incidentResult, auditResult, reportsResult] = await Promise.all([
      pool.query(
        `SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE id = $1`,
        [id],
      ),
      pool.query(
        `SELECT id, action, target, prev_status, new_status, created_at
         FROM incident_audit_log
         WHERE incident_id = $1
         ORDER BY created_at ASC`,
        [id],
      ),
      pool.query(
        `SELECT id, text, lat, lng, category, timestamp, reporter_id
         FROM reports
         WHERE incident_id = $1
         ORDER BY timestamp DESC`,
        [id],
      ),
    ]);

    if (incidentResult.rows.length === 0) {
      res.status(404).json({ error: 'Incident not found' });
      return;
    }

    res.json({
      ...incidentResult.rows[0],
      audit_log: auditResult.rows,
      reports: reportsResult.rows,
    });
  } catch (err) {
    console.error('[routes/incidents] DB error:', err);
    res.status(500).json({ error: 'Failed to get incident' });
  }
});

// ---------------------------------------------------------------------------
// POST /incidents/:id/approve
// ---------------------------------------------------------------------------
router.post('/:id/approve', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    // Check that the incident exists and has a pending approval.
    const { rows } = await pool.query<{ approval_status: string | null }>(
      `SELECT approval_status FROM incidents WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Incident not found' });
      return;
    }
    if (rows[0].approval_status !== 'PENDING') {
      res.status(409).json({ error: 'Incident does not have a pending approval' });
      return;
    }

    // Resume the TrueForge session in the background.
    approveIncidentAction(id).catch((err) => {
      console.error(`[routes/incidents] Approve failed for incident ${id}:`, err);
    });

    res.json({ message: 'Approval submitted — agent resuming', incidentId: id });
  } catch (err) {
    console.error('[routes/incidents] DB error:', err);
    res.status(500).json({ error: 'Failed to approve incident action' });
  }
});

// ---------------------------------------------------------------------------
// POST /incidents/:id/reject
// ---------------------------------------------------------------------------
router.post('/:id/reject', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { reason } = req.body as { reason?: string };

  try {
    const { rows } = await pool.query<{ approval_status: string | null }>(
      `SELECT approval_status FROM incidents WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Incident not found' });
      return;
    }
    if (rows[0].approval_status !== 'PENDING') {
      res.status(409).json({ error: 'Incident does not have a pending approval' });
      return;
    }

    const rejectReason = reason ?? 'Rejected by operator';

    // Resume the TrueForge session with deny in the background.
    rejectIncidentAction(id, rejectReason).catch((err) => {
      console.error(`[routes/incidents] Reject failed for incident ${id}:`, err);
    });

    res.json({
      message: 'Rejection submitted — incident returned to INVESTIGATING',
      incidentId: id,
    });
  } catch (err) {
    console.error('[routes/incidents] DB error:', err);
    res.status(500).json({ error: 'Failed to reject incident action' });
  }
});

export default router;
