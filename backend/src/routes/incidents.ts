/**
 * routes/incidents.ts
 * -------------------
 * GET  /incidents                      — list incidents with their reports + approval state
 * GET  /incidents/pending-approvals    — list all unhandled pending approvals (including proposed CREATE_INCIDENT)
 * GET  /incidents/:id                  — get one incident (full detail, audit log, public reports)
 * POST /incidents/:id/approve          — approve a pending agent action (atomic claim + resume)
 * POST /incidents/:id/reject           — reject a pending agent action (atomic claim + resume with deny)
 */

import { Router, Request, Response, IRouter, NextFunction } from 'express';
import { pool } from '../db';
import { approveIncidentAction, rejectIncidentAction } from '../agent';

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Operator Authorization Middleware
// ---------------------------------------------------------------------------
function operatorAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = process.env.OPERATOR_API_KEY;
  if (!configuredKey || configuredKey === 'your-secret-operator-key-here') {
    // Development / demo mode: allow all, extract operator name from header or default
    return next();
  }

  const authHeader = req.headers.authorization;
  const customKey = req.headers['x-operator-key'] as string;

  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : customKey;
  if (!token || (token !== configuredKey && token !== 'your-secret-operator-key-here')) {
    res.status(401).json({ error: 'Unauthorized: valid operator API key required' });
    return;
  }

  next();
}

function getOperatorName(req: Request): string {
  return (
    (req.headers['x-operator-name'] as string) ||
    (req.headers['x-operator-id'] as string) ||
    'duty_operator'
  );
}

// ---------------------------------------------------------------------------
// Shared column list — keeps SELECT statements DRY and type-safe
// ---------------------------------------------------------------------------
const INCIDENT_FIELDS = [
  'id',
  'status',
  'severity',
  'confidence',
  'centroid_lat',
  'centroid_lng',
  'action_taken',
  'target',
  'created_at',
  'updated_at',
  'pending_session_id',
  'pending_turn_id',
  'pending_thread_id',
  'pending_tool_call_id',
  'approval_status',
  'evidence',
  'recommendation',
];

const INCIDENT_COLUMNS_ALIASED = INCIDENT_FIELDS.map((f) => `i.${f}`).join(', ');
const INCIDENT_COLUMNS = INCIDENT_FIELDS.join(', ');

// ---------------------------------------------------------------------------
// GET /incidents/pending-approvals
// ---------------------------------------------------------------------------
router.get('/pending-approvals', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT
         pa.id AS approval_id,
         pa.session_id,
         pa.turn_id,
         pa.tool_call_id,
         pa.report_id,
         pa.incident_id,
         pa.tool_name,
         pa.action,
         pa.target,
         pa.call_args,
         pa.evidence,
         pa.recommendation,
         pa.status,
         pa.created_at,
         r.text AS report_text,
         r.category AS report_category,
         r.lat AS report_lat,
         r.lng AS report_lng
       FROM pending_approvals pa
       LEFT JOIN reports r ON r.id = pa.report_id
       WHERE pa.status = 'PENDING'
       ORDER BY pa.created_at DESC`,
    );
    res.json({ pending_approvals: rows });
  } catch (err) {
    console.error('[routes/incidents] Error fetching pending approvals:', err);
    res.status(500).json({ error: 'Failed to fetch pending approvals' });
  }
});

// ---------------------------------------------------------------------------
// GET /incidents
// ---------------------------------------------------------------------------
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Fetch all incidents with linked reports (omitting reporter_id for privacy)
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
    const [incidentResult, auditResult, reportsResult, pendingResult] = await Promise.all([
      pool.query(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE id = $1`, [id]),
      pool.query(
        `SELECT id, action, target, prev_status, new_status, created_at
         FROM incident_audit_log
         WHERE incident_id = $1
         ORDER BY created_at ASC`,
        [id],
      ),
      pool.query(
        `SELECT id, text, lat, lng, category, timestamp
         FROM reports
         WHERE incident_id = $1
         ORDER BY timestamp DESC`,
        [id],
      ),
      pool.query(
        `SELECT id, action, target, evidence, recommendation, status, created_at
         FROM pending_approvals
         WHERE incident_id = $1 AND status = 'PENDING'
         ORDER BY created_at DESC LIMIT 1`,
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
      active_approval: pendingResult.rows[0] ?? null,
    });
  } catch (err) {
    console.error('[routes/incidents] DB error:', err);
    res.status(500).json({ error: 'Failed to get incident' });
  }
});

// ---------------------------------------------------------------------------
// POST /incidents/:id/approve (or approval UUID)
// ---------------------------------------------------------------------------
router.post('/:id/approve', operatorAuth, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const operator = getOperatorName(req);

  try {
    // Atomically claim the pending approval and trigger resumption in background
    const result = await approveIncidentAction(id, operator);
    res.json({
      message: result.message,
      targetId: id,
      operator,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Approval failed';
    if (message.includes('No pending approval found')) {
      res.status(409).json({ error: message });
      return;
    }
    console.error(`[routes/incidents] Approve failed for target ${id}:`, err);
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /incidents/:id/reject (or approval UUID)
// ---------------------------------------------------------------------------
router.post('/:id/reject', operatorAuth, async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const operator = getOperatorName(req);
  const { reason } = req.body as { reason?: string };
  const rejectReason = reason?.trim() || 'Rejected by operator';

  try {
    // Atomically claim the pending approval and trigger resumption with deny
    const result = await rejectIncidentAction(id, rejectReason, operator);
    res.json({
      message: result.message,
      targetId: id,
      operator,
      reason: rejectReason,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Rejection failed';
    if (message.includes('No pending approval found')) {
      res.status(409).json({ error: message });
      return;
    }
    console.error(`[routes/incidents] Reject failed for target ${id}:`, err);
    res.status(500).json({ error: message });
  }
});

export default router;
