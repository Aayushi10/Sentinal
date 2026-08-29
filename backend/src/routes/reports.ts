/**
 * routes/reports.ts
 * -----------------
 * POST /reports        — submit a new report, insert to DB, fire agent async
 * GET  /reports        — list all reports (newest-first)
 * GET  /reports/:id    — get one report by UUID
 */

import { Router, Request, Response, IRouter } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { startAgentSession } from '../agent';

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// POST /reports
// ---------------------------------------------------------------------------
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { text, lat, lng, category, reporter_id } = req.body as {
    text?: string;
    lat?: number;
    lng?: number;
    category?: string;
    reporter_id?: string;
  };

  if (!text || lat == null || lng == null) {
    res.status(400).json({ error: 'text, lat, and lng are required' });
    return;
  }

  const reporterIdFinal = reporter_id ?? uuidv4();
  const categoryFinal = category ?? 'other';

  try {
    const { rows } = await pool.query<{ id: string; timestamp: Date }>(
      `INSERT INTO reports (text, lat, lng, category, reporter_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, timestamp`,
      [text, lat, lng, categoryFinal, reporterIdFinal],
    );
    const report = rows[0];

    // Fire agent session in the background — do NOT await.
    startAgentSession(report.id, text, lat, lng, categoryFinal).catch((err) => {
      console.error('[routes/reports] Background agent session failed:', err);
    });

    res.status(201).json({
      id: report.id,
      text,
      lat,
      lng,
      category: categoryFinal,
      timestamp: report.timestamp,
      reporter_id: reporterIdFinal,
      incident_id: null,
    });
  } catch (err) {
    console.error('[routes/reports] DB error:', err);
    res.status(500).json({ error: 'Failed to create report' });
  }
});

// ---------------------------------------------------------------------------
// GET /reports
// ---------------------------------------------------------------------------
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { rows } = await pool.query(
      `SELECT id, text, lat, lng, category, timestamp, reporter_id, incident_id
       FROM reports
       ORDER BY timestamp DESC
       LIMIT 200`,
    );
    res.json({ reports: rows });
  } catch (err) {
    console.error('[routes/reports] DB error:', err);
    res.status(500).json({ error: 'Failed to list reports' });
  }
});

// ---------------------------------------------------------------------------
// GET /reports/:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT id, text, lat, lng, category, timestamp, reporter_id, incident_id
       FROM reports WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Report not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[routes/reports] DB error:', err);
    res.status(500).json({ error: 'Failed to get report' });
  }
});

export default router;
