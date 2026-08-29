/**
 * routes/reports.ts
 * -----------------
 * POST /reports        — submit a new report, insert to DB, fire agent async
 * GET  /reports        — list all reports (newest-first, public projection)
 * GET  /reports/:id    — get one report by UUID
 */

import { Router, Request, Response, IRouter } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { queueAgentSession } from '../agent';

const router: IRouter = Router();

const ALLOWED_CATEGORIES = ['fire', 'crime', 'hazard', 'other'] as const;
type ReportCategory = (typeof ALLOWED_CATEGORIES)[number];

// Simple in-memory sliding-window rate limiter per client IP (30 requests/minute)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_REPORTS_PER_WINDOW = 30;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= MAX_REPORTS_PER_WINDOW) {
    return false;
  }

  entry.count++;
  return true;
}

// ---------------------------------------------------------------------------
// POST /reports
// ---------------------------------------------------------------------------
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    res.status(429).json({ error: 'Too many reports submitted. Please wait before submitting again.' });
    return;
  }

  const { text, lat, lng, category } = req.body as {
    text?: unknown;
    lat?: unknown;
    lng?: unknown;
    category?: unknown;
  };

  // 1. Text validation: non-blank string, length bounded
  if (typeof text !== 'string' || text.trim().length < 3 || text.trim().length > 2000) {
    res.status(400).json({ error: 'text is required and must be between 3 and 2000 characters' });
    return;
  }
  const cleanText = text.trim();

  // 2. Latitude validation: finite number [-90, 90]
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    res.status(400).json({ error: 'lat is required and must be a valid latitude between -90 and 90' });
    return;
  }

  // 3. Longitude validation: finite number [-180, 180]
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    res.status(400).json({ error: 'lng is required and must be a valid longitude between -180 and 180' });
    return;
  }

  // 4. Category validation
  let categoryFinal: ReportCategory = 'other';
  if (typeof category === 'string' && ALLOWED_CATEGORIES.includes(category.toLowerCase() as ReportCategory)) {
    categoryFinal = category.toLowerCase() as ReportCategory;
  }

  // Server-generated anonymous reporter ID (not client controlled)
  const reporterIdFinal = uuidv4();

  try {
    const { rows } = await pool.query<{ id: string; timestamp: Date }>(
      `INSERT INTO reports (text, lat, lng, category, reporter_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, timestamp`,
      [cleanText, lat, lng, categoryFinal, reporterIdFinal],
    );
    const report = rows[0];

    // Enqueue agent session asynchronously — does NOT await
    queueAgentSession(report.id, cleanText, lat, lng, categoryFinal);

    // Omit sensitive reporter_id from the public response
    res.status(201).json({
      id: report.id,
      text: cleanText,
      lat,
      lng,
      category: categoryFinal,
      timestamp: report.timestamp,
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
    // Project only public fields — reporter_id is stripped for privacy
    const { rows } = await pool.query(
      `SELECT id, text, lat, lng, category, timestamp, incident_id
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
      `SELECT id, text, lat, lng, category, timestamp, incident_id
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
