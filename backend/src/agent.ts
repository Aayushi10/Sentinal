/**
 * agent.ts
 * --------
 * Runs a TrueForge session against "sentinel-prod-v1", streams events,
 * handles `tool.approval_required` pauses, and persists results to the DB.
 *
 * The turn loop does NOT block HTTP requests — it is queued/run in the background
 * after a report is inserted. Concurrency is capped to avoid overwhelming TrueForge.
 */

import { TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { pool } from './db';
import { trueforge, AGENT_NAME } from './trueforge';

// ---------------------------------------------------------------------------
// Concurrency Limiter
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.MAX_CONCURRENT_SESSIONS ?? '5', 10);
let activeSessions = 0;
const sessionQueue: Array<() => Promise<void>> = [];

/**
 * Enqueue or execute an agent session with a concurrency cap.
 */
export function queueAgentSession(
  reportId: string,
  reportText: string,
  reportLat: number,
  reportLng: number,
  category: string,
): void {
  const task = async () => {
    activeSessions++;
    try {
      await executeAgentSession(reportId, reportText, reportLat, reportLng, category);
    } catch (err) {
      console.error(`[agent] Session failed for report ${reportId}:`, err);
    } finally {
      activeSessions--;
      const next = sessionQueue.shift();
      if (next) {
        void next();
      }
    }
  };

  if (activeSessions < MAX_CONCURRENT_SESSIONS) {
    void task();
  } else {
    console.warn(
      `[agent] Concurrency limit reached (${activeSessions}/${MAX_CONCURRENT_SESSIONS}). Queuing report ${reportId}`,
    );
    sessionQueue.push(task);
  }
}

// Backward-compatible alias
export const startAgentSession = queueAgentSession;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidUuid(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Extract agent summary and recommendation from accumulated model messages.
 */
function extractEvidenceFromEvents(
  events: Map<string, TrueForgeApi.TurnStreamingEvent>,
): { evidence: Record<string, unknown>; recommendation: string } {
  let lastModelContent = '';

  for (const evt of events.values()) {
    if (evt.type === 'model.message' && evt.threadId === 'main') {
      const content = (evt as TrueForgeApi.ModelMessageEvent).content;
      if (content) {
        if (typeof content === 'string') {
          lastModelContent = content;
        } else {
          lastModelContent = content
            .map((part) => ('text' in part ? (part as { text: string }).text : ''))
            .join('');
        }
      }
    }
  }

  const recMatch = lastModelContent.match(/recommendation[:\s]+(.+)$/is);
  const recommendation = recMatch ? recMatch[1].trim() : lastModelContent.slice(-500);

  return {
    evidence: { agentSummary: lastModelContent },
    recommendation,
  };
}

interface ProcessStreamResult {
  events: Map<string, TrueForgeApi.TurnStreamingEvent>;
  turnId?: string;
  hasPendingApproval: boolean;
  terminalStatus?: string;
}

/**
 * Shared turn stream processor for initial and resumed turns.
 * Accumulates events, merges deltas, persists pending approvals in `pending_approvals`,
 * and captures newly generated incident IDs from tool responses.
 */
async function processTurnStream(
  sessionId: string,
  stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
  context: { reportId?: string; incidentId?: string },
): Promise<ProcessStreamResult> {
  const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
  const pendingApprovals: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
  let turnId: string | undefined;
  let terminalStatus: string | undefined;

  for await (const event of stream) {
    if (event.type === 'turn.created') {
      turnId = (event as TrueForgeApi.TurnCreatedEvent).turnId;
    }

    if (isEventDelta(event)) {
      const base = events.get(event.id);
      if (base) mergeEventDelta(base, event);
    } else {
      events.set(event.id, event);
    }

    // Capture tool responses (e.g. create_incident_action returning new incident_id)
    if (event.type === 'tool.response') {
      const toolResp = event as TrueForgeApi.ToolResponseEvent;
      try {
        const parsed = JSON.parse(toolResp.content);
        if (parsed && isValidUuid(parsed.incident_id)) {
          console.log(`[agent] Captured incident_id ${parsed.incident_id} from tool response`);
          await pool.query(
            `UPDATE pending_approvals
             SET incident_id = $1, updated_at = NOW()
             WHERE session_id = $2 AND tool_call_id = $3`,
            [parsed.incident_id, sessionId, toolResp.toolCallId],
          );

          // If report was passed, ensure the report is linked to the new incident
          if (context.reportId) {
            await pool.query(
              `UPDATE reports SET incident_id = $1 WHERE id = $2 AND incident_id IS NULL`,
              [parsed.incident_id, context.reportId],
            );
          }
        }
      } catch {
        // Non-JSON tool responses are ignored
      }
    }

    if (event.type === 'tool.approval_required') {
      pendingApprovals.push(event as TrueForgeApi.ToolApprovalRequiredEvent);
    }

    if (event.type === 'turn.done') {
      const done = event as TrueForgeApi.TurnDoneEvent;
      terminalStatus = done.state.status;
      console.log(`[agent] Turn completed with status: ${terminalStatus}`);
    }
  }

  // Persist pending approvals to the dedicated pending_approvals table
  if (pendingApprovals.length > 0 && turnId) {
    const { evidence, recommendation } = extractEvidenceFromEvents(events);

    for (const pending of pendingApprovals) {
      for (const ref of pending.toolCalls) {
        const msg = events.get(ref.sourceEventId);
        if (msg?.type !== 'model.message') continue;
        const modelMsg = msg as TrueForgeApi.ModelMessageEvent;
        const call = modelMsg.toolCalls?.find((tc) => tc.id === ref.id);
        if (!call) continue;

        let callArgs: Record<string, unknown> = {};
        try {
          callArgs = JSON.parse(call.function.arguments || '{}');
        } catch {
          callArgs = { raw: call.function.arguments };
        }

        const targetIncidentId =
          isValidUuid(callArgs.incident_id) ? callArgs.incident_id : context.incidentId ?? null;

        console.log(
          `[agent] Recording pending approval: ${call.toolInfo.name} action=${callArgs.action} target=${callArgs.target}`,
        );

        // Store into dedicated pending_approvals table
        await pool.query(
          `INSERT INTO pending_approvals (
             session_id, turn_id, thread_id, tool_call_id,
             report_id, incident_id, tool_name, action, target,
             call_args, evidence, recommendation, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'PENDING')
           ON CONFLICT (session_id, tool_call_id) DO UPDATE
           SET turn_id = EXCLUDED.turn_id,
               call_args = EXCLUDED.call_args,
               evidence = EXCLUDED.evidence,
               recommendation = EXCLUDED.recommendation,
               status = 'PENDING',
               updated_at = NOW()`,
          [
            sessionId,
            turnId,
            pending.threadId ?? 'main',
            ref.id,
            context.reportId ?? null,
            targetIncidentId,
            call.toolInfo.name,
            callArgs.action ?? null,
            callArgs.target ?? null,
            JSON.stringify(callArgs),
            JSON.stringify(evidence),
            recommendation,
          ],
        );

        // If an existing incident was targeted, sync status on incidents table as well
        if (targetIncidentId) {
          await pool.query(
            `UPDATE incidents
             SET pending_session_id   = $1,
                 pending_turn_id      = $2,
                 pending_thread_id    = $3,
                 pending_tool_call_id = $4,
                 approval_status      = 'PENDING',
                 evidence             = $5,
                 recommendation       = $6,
                 updated_at           = NOW()
             WHERE id = $7`,
            [
              sessionId,
              turnId,
              pending.threadId ?? 'main',
              ref.id,
              JSON.stringify(evidence),
              recommendation,
              targetIncidentId,
            ],
          );
        }
      }
    }
  }

  return {
    events,
    turnId,
    hasPendingApproval: pendingApprovals.length > 0,
    terminalStatus,
  };
}

// ---------------------------------------------------------------------------
// Session Execution
// ---------------------------------------------------------------------------

async function executeAgentSession(
  reportId: string,
  reportText: string,
  reportLat: number,
  reportLng: number,
  category: string,
): Promise<void> {
  console.log(`[agent] Starting session for report ${reportId}`);

  const { data: session } = await trueforge.sessions.create({
    agent: { name: AGENT_NAME },
  });
  console.log(`[agent] Session created: ${session.id}`);

  const userMessage =
    `New anonymous incident report submitted.\n\n` +
    `Report ID: ${reportId}\n` +
    `Category: ${category}\n` +
    `Coordinates: lat=${reportLat}, lng=${reportLng}\n` +
    `Description: ${reportText}\n\n` +
    `Please investigate this report: search for nearby related reports, ` +
    `assess severity and corroboration, then decide whether to create an incident ` +
    `and/or dispatch resources. Use create_incident_action for any consequential steps.`;

  const stream = await trueforge.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: userMessage }],
  });

  await processTurnStream(session.id, stream, { reportId });
}

// ---------------------------------------------------------------------------
// Human-in-the-Loop Resumptions
// ---------------------------------------------------------------------------

/**
 * approveIncidentAction
 * ---------------------
 * Atomically transitions approval from PENDING to PROCESSING to prevent duplicate decisions.
 * Resumes TrueForge turn with allow, streams events, and handles any chained approvals.
 */
export async function approveIncidentAction(
  targetId: string,
  operator: string = 'operator',
): Promise<{ success: boolean; message: string }> {
  // Atomically claim the pending approval
  const { rows } = await pool.query<{
    id: string;
    session_id: string;
    thread_id: string;
    tool_call_id: string;
    incident_id: string | null;
  }>(
    `UPDATE pending_approvals
     SET status = 'PROCESSING', operator = $2, updated_at = NOW()
     WHERE (id::text = $1 OR incident_id::text = $1)
       AND status = 'PENDING'
     RETURNING id, session_id, thread_id, tool_call_id, incident_id`,
    [targetId, operator],
  );

  if (rows.length === 0) {
    throw new Error('No pending approval found (may already be approved or processing)');
  }

  const approval = rows[0];
  const incidentId = approval.incident_id;

  console.log(`[agent] Operator ${operator} approved tool call ${approval.tool_call_id}`);

  try {
    const approvalInput: TrueForgeApi.UserToolApprovalEvent[] = [
      {
        type: 'user.tool_approval',
        threadId: approval.thread_id ?? 'main',
        toolCallId: approval.tool_call_id,
        approval: { status: 'allow' },
      },
    ];

    const stream = await trueforge.sessions.createTurnStream(approval.session_id, {
      input: approvalInput,
    });

    const result = await processTurnStream(approval.session_id, stream, {
      incidentId: incidentId ?? undefined,
    });

    if (result.hasPendingApproval) {
      console.log(`[agent] Resumed turn triggered another approval gate`);
    } else if (result.terminalStatus === 'error' || result.terminalStatus === 'cancelled') {
      await pool.query(
        `UPDATE pending_approvals SET status = 'FAILED', updated_at = NOW() WHERE id = $1`,
        [approval.id],
      );
      throw new Error(`Agent turn terminated with status: ${result.terminalStatus}`);
    } else {
      await pool.query(
        `UPDATE pending_approvals SET status = 'APPROVED', updated_at = NOW() WHERE id = $1`,
        [approval.id],
      );

      if (incidentId) {
        await pool.query(
          `UPDATE incidents
           SET approval_status = 'APPROVED',
               pending_session_id = NULL,
               pending_turn_id = NULL,
               pending_thread_id = NULL,
               pending_tool_call_id = NULL,
               updated_at = NOW()
           WHERE id = $1`,
          [incidentId],
        );
      }
    }

    return { success: true, message: 'Approval processed successfully' };
  } catch (err) {
    // Rollback to PENDING on connection / SDK error so operator can retry
    await pool.query(
      `UPDATE pending_approvals SET status = 'PENDING', updated_at = NOW() WHERE id = $1`,
      [approval.id],
    );
    throw err;
  }
}

/**
 * rejectIncidentAction
 * --------------------
 * Atomically transitions approval from PENDING to PROCESSING.
 * Resumes TrueForge turn with deny, and marks incident status as INVESTIGATING.
 */
export async function rejectIncidentAction(
  targetId: string,
  reason: string,
  operator: string = 'operator',
): Promise<{ success: boolean; message: string }> {
  // Atomically claim the pending approval
  const { rows } = await pool.query<{
    id: string;
    session_id: string;
    thread_id: string;
    tool_call_id: string;
    incident_id: string | null;
  }>(
    `UPDATE pending_approvals
     SET status = 'PROCESSING', operator = $2, updated_at = NOW()
     WHERE (id::text = $1 OR incident_id::text = $1)
       AND status = 'PENDING'
     RETURNING id, session_id, thread_id, tool_call_id, incident_id`,
    [targetId, operator],
  );

  if (rows.length === 0) {
    throw new Error('No pending approval found (may already be rejected or processing)');
  }

  const approval = rows[0];
  const incidentId = approval.incident_id;

  console.log(`[agent] Operator ${operator} rejected tool call ${approval.tool_call_id}: ${reason}`);

  try {
    const denyInput: TrueForgeApi.UserToolApprovalEvent[] = [
      {
        type: 'user.tool_approval',
        threadId: approval.thread_id ?? 'main',
        toolCallId: approval.tool_call_id,
        approval: { status: 'deny', reason },
      },
    ];

    const stream = await trueforge.sessions.createTurnStream(approval.session_id, {
      input: denyInput,
    });

    await processTurnStream(approval.session_id, stream, {
      incidentId: incidentId ?? undefined,
    });

    await pool.query(
      `UPDATE pending_approvals SET status = 'REJECTED', updated_at = NOW() WHERE id = $1`,
      [approval.id],
    );

    if (incidentId) {
      await pool.query(
        `UPDATE incidents
         SET status = 'INVESTIGATING',
             approval_status = 'REJECTED',
             pending_session_id = NULL,
             pending_turn_id = NULL,
             pending_thread_id = NULL,
             pending_tool_call_id = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [incidentId],
      );

      // Audit log entry for rejection
      await pool.query(
        `INSERT INTO incident_audit_log (incident_id, action, target, prev_status, new_status)
         VALUES ($1, 'OPERATOR_REJECTED', $2, 'PENDING_APPROVAL', 'INVESTIGATING')`,
        [incidentId, `Rejected by ${operator}: ${reason}`],
      );
    }

    return { success: true, message: 'Rejection processed; incident kept in INVESTIGATING' };
  } catch (err) {
    await pool.query(
      `UPDATE pending_approvals SET status = 'PENDING', updated_at = NOW() WHERE id = $1`,
      [approval.id],
    );
    throw err;
  }
}
