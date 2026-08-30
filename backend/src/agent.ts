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
// Live Investigation Tracking (polled by GET /investigations)
// ---------------------------------------------------------------------------

export interface InvestigationStep {
  tool: string;
  label: string;
  startedAt: string;
  completedAt?: string;
}

export interface InvestigationStatus {
  reportId: string;
  reportText: string;
  category: string;
  sessionId: string;
  startedAt: string;
  steps: InvestigationStep[];
  findings: string;
  status: 'queued' | 'investigating' | 'awaiting_approval' | 'completed' | 'failed';
  updatedAt: string;
}

/** Active investigations keyed by reportId. Created synchronously on queue, removed after completion. */
export const activeInvestigations = new Map<string, InvestigationStatus>();

const TOOL_LABELS: Record<string, string> = {
  search_reports:              'Scanning nearby incident reports',
  get_report_details:          'Analyzing report details',
  geocode_location:            'Geocoding location reference',
  check_response_resources:    'Checking emergency resource availability',
  create_incident_action:      'Formulating tactical recommendation',
};

function scheduleInvestigationCleanup(reportId: string, delayMs = 15_000): void {
  setTimeout(() => {
    const inv = activeInvestigations.get(reportId);
    // Keep card sticky while waiting for human decision
    if (inv && inv.status === 'awaiting_approval') {
      return;
    }
    activeInvestigations.delete(reportId);
  }, delayMs);
}

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
  // Create investigation entry immediately so the frontend sees it on the next poll.
  activeInvestigations.set(reportId, {
    reportId,
    reportText: reportText.slice(0, 160),
    category,
    sessionId: '',
    startedAt: new Date().toISOString(),
    steps: [],
    findings: '',
    status: activeSessions < MAX_CONCURRENT_SESSIONS ? 'investigating' : 'queued',
    updatedAt: new Date().toISOString(),
  });

  const task = async () => {
    activeSessions++;
    try {
      await executeAgentSession(reportId, reportText, reportLat, reportLng, category);
    } catch (err) {
      console.error(`[agent] Session failed for report ${reportId}:`, err);
      const inv = activeInvestigations.get(reportId);
      if (inv) {
        inv.status = 'failed';
        inv.updatedAt = new Date().toISOString();
        scheduleInvestigationCleanup(reportId, 20_000);
      }
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
  const toolCallIdToName = new Map<string, string>(); // for investigation step tracking

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

    // --- Live investigation tracking (initial sessions only) ---
    if (context.reportId) {
      const investigation = activeInvestigations.get(context.reportId);
      if (investigation) {
        // After merge, check the resolved event for tool calls
        const resolved = isEventDelta(event) ? events.get(event.id) : event;
        if (resolved?.type === 'model.message') {
          const msg = resolved as TrueForgeApi.ModelMessageEvent;
          // Register new tool calls as pending steps
          for (const tc of (msg.toolCalls ?? [])) {
            if (!toolCallIdToName.has(tc.id)) {
              let toolName = (tc.toolInfo as { name?: string } | undefined)?.name ?? tc.id;
              
              // If wrapped by TrueForge system call_tool / get_tool_info, extract inner tool name
              if ((toolName === 'call_tool' || toolName === 'get_tool_info') && tc.function?.arguments) {
                try {
                  const args = JSON.parse(tc.function.arguments);
                  if (args.tool_name) {
                    toolName = args.tool_name;
                  }
                } catch {
                  // ignore json parse error
                }
              }

              toolCallIdToName.set(tc.id, toolName);
              // Only add domain steps or distinct steps (skip meta discovery noise)
              if (toolName !== 'list_tools' && toolName !== 'get_current_datetime' && !investigation.steps.some(s => s.tool === toolName)) {
                investigation.steps.push({
                  tool: toolName,
                  label: TOOL_LABELS[toolName] ?? (toolName === 'exec' ? 'Running correlation analysis' : toolName),
                  startedAt: new Date().toISOString(),
                });
              }
            }
          }
          // Capture agent reasoning text (non-tool-call messages only)
          const content = msg.content;
          if (content && !msg.toolCalls?.length) {
            const text = typeof content === 'string'
              ? content
              : (content as Array<{ text?: string }>).map(p => p.text ?? '').join('');
            if (text.trim().length > 20) {
              investigation.findings = text.slice(0, 700);
            }
          }
          investigation.updatedAt = new Date().toISOString();
        }

        // Mark step completed when tool response arrives
        if (event.type === 'tool.response' && !isEventDelta(event)) {
          const tr = event as TrueForgeApi.ToolResponseEvent;
          const toolName = toolCallIdToName.get((tr as { toolCallId?: string }).toolCallId ?? '');
          if (toolName) {
            const step = investigation.steps.find(s => s.tool === toolName && !s.completedAt);
            if (step) step.completedAt = new Date().toISOString();
          }
          investigation.updatedAt = new Date().toISOString();
        }

        if (event.type === 'tool.approval_required') {
          investigation.status = 'awaiting_approval';
          investigation.updatedAt = new Date().toISOString();
          // Keep for 5 min so human can see it while deciding
          scheduleInvestigationCleanup(context.reportId, 5 * 60 * 1000);
        }

        if (event.type === 'turn.done' && investigation.status !== 'awaiting_approval') {
          const done = event as TrueForgeApi.TurnDoneEvent;
          const isErr = done.state?.status === 'error';
          investigation.status = isErr ? 'failed' : 'completed';
          if (isErr && done.state?.message) {
            const errMsg = done.state.message.includes('429')
              ? 'LLM Rate Limit (429) encountered. Please wait a few seconds.'
              : done.state.message;
            investigation.findings = `⚠️ ${errMsg}`;
          }
          investigation.updatedAt = new Date().toISOString();
          scheduleInvestigationCleanup(context.reportId, isErr ? 20_000 : 12_000);
        }
      }
    }
    // --- End investigation tracking ---

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

    if (event.type === 'tool.approval_required' || event.type === 'tool.response_required') {
      pendingApprovals.push(event as TrueForgeApi.ToolApprovalRequiredEvent);
      if (context.reportId) {
        const inv = activeInvestigations.get(context.reportId);
        if (inv) {
          inv.status = 'awaiting_approval';
          inv.updatedAt = new Date().toISOString();
          scheduleInvestigationCleanup(context.reportId, 5 * 60 * 1000);
        }
      }
    }

    if (event.type === 'turn.done') {
      const done = event as TrueForgeApi.TurnDoneEvent;
      terminalStatus = done.state?.status;
      // Check if turn finished with requiredActions (e.g. tool.response_required or tool.approval_required)
      const hasRequiredActions = (done.state?.requiredActions?.length || 0) > 0;
      if (hasRequiredActions && done.state?.requiredActions) {
        for (const req of done.state.requiredActions) {
          if (!pendingApprovals.some(p => p.id === req.id)) {
            pendingApprovals.push(req as unknown as TrueForgeApi.ToolApprovalRequiredEvent);
          }
        }
        if (context.reportId) {
          const inv = activeInvestigations.get(context.reportId);
          if (inv) {
            inv.status = 'awaiting_approval';
            inv.updatedAt = new Date().toISOString();
            scheduleInvestigationCleanup(context.reportId, 5 * 60 * 1000);
          }
        }
      }
      console.log(`[agent] Turn completed with status: ${terminalStatus}, hasRequiredActions: ${hasRequiredActions}`);
    }
  }

  // Persist pending approvals to the dedicated pending_approvals table
  if (pendingApprovals.length > 0 && turnId) {
    const { evidence, recommendation } = extractEvidenceFromEvents(events);

    for (const pending of pendingApprovals) {
      for (const ref of pending.toolCalls) {
        // Find matching tool call across all events (or merged model.message)
        let call: TrueForgeApi.ToolCall | undefined;
        for (const evt of events.values()) {
          if (evt.type === 'model.message') {
            const tc = (evt as TrueForgeApi.ModelMessageEvent).toolCalls?.find((t) => t.id === ref.id);
            if (tc) { call = tc; break; }
          }
        }
        if (!call) continue;

        let callArgs: Record<string, unknown> = {};
        try {
          callArgs = JSON.parse(call.function?.arguments || '{}');
        } catch {
          callArgs = { raw: call.function?.arguments };
        }

        // TrueForge wraps MCP tool calls in call_tool system tool
        let actualToolName = call.toolInfo?.name ?? 'create_incident_action';
        let innerArgs = callArgs;
        if (callArgs.tool_name) {
          actualToolName = String(callArgs.tool_name);
        }
        if (callArgs.input && typeof callArgs.input === 'object') {
          innerArgs = callArgs.input as Record<string, unknown>;
        }

        const action = (innerArgs.action || callArgs.action || 'CREATE_INCIDENT') as string;
        const target = (innerArgs.target || callArgs.target || recommendation || 'Emergency dispatch requested') as string;
        const rawIncidentId = innerArgs.incident_id || callArgs.incident_id;
        const targetIncidentId = isValidUuid(rawIncidentId) ? rawIncidentId : context.incidentId ?? null;

        console.log(
          `[agent] Recording pending approval: ${actualToolName} action=${action} target=${target}`,
        );

        // Store into dedicated pending_approvals table
        const { rows: inserted } = await pool.query<{ id: string }>(
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
               updated_at = NOW()
           RETURNING id`,
          [
            sessionId,
            turnId,
            pending.threadId ?? 'main',
            ref.id,
            context.reportId ?? null,
            targetIncidentId,
            actualToolName,
            action,
            target,
            JSON.stringify(innerArgs),
            JSON.stringify(evidence),
            recommendation,
          ],
        );

        // Also enrich activeInvestigations so the live feed UI gets the approval ID & action details immediately
        if (context.reportId) {
          const inv = activeInvestigations.get(context.reportId);
          if (inv) {
            inv.status = 'awaiting_approval';
            const questionText = typeof innerArgs.question === 'string' ? innerArgs.question : target;
            inv.findings = questionText;
            (inv as unknown as Record<string, unknown>).approval = {
              id: inserted[0]?.id,
              toolCallId: ref.id,
              action,
              target,
              question: questionText,
              options: Array.isArray(innerArgs.options) ? innerArgs.options : [],
              toolName: actualToolName,
            };
            inv.updatedAt = new Date().toISOString();
          }
        }

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

  // Record the session ID in the investigation entry
  const inv = activeInvestigations.get(reportId);
  if (inv) {
    inv.sessionId = session.id;
    inv.status = 'investigating';
    inv.updatedAt = new Date().toISOString();
  }

  const userMessage =
    `New anonymous incident report submitted.\n\n` +
    `Report ID: ${reportId}\n` +
    `Category: ${category}\n` +
    `Coordinates: lat=${reportLat}, lng=${reportLng}\n` +
    `Description: ${reportText}\n\n` +
    `Please investigate this report efficiently:\n` +
    `1. Call search_reports(center_lat=${reportLat}, center_lng=${reportLng}, radius_m=1000) to find nearby reports (report text and coordinates are already returned in the search results; do NOT call get_report_details in a loop).\n` +
    `2. Call check_response_resources(incident_type="${category}", lat=${reportLat}, lng=${reportLng}) to check emergency unit availability.\n` +
    `3. Call ask_user_question (or create_incident_action) to request human authorization to dispatch the nearest emergency unit and create the incident.`;

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
    tool_name: string | null;
  }>(
    `UPDATE pending_approvals
     SET status = 'PROCESSING', operator = $2, updated_at = NOW()
     WHERE (id::text = $1 OR incident_id::text = $1)
       AND status = 'PENDING'
     RETURNING id, session_id, thread_id, tool_call_id, incident_id, tool_name`,
    [targetId, operator],
  );

  if (rows.length === 0) {
    throw new Error('No pending approval found (may already be approved or processing)');
  }

  const approval = rows[0];
  const incidentId = approval.incident_id;

  console.log(`[agent] Operator ${operator} approved tool call ${approval.tool_call_id} (tool: ${approval.tool_name})`);

  try {
    const isAskQuestion = approval.tool_name === 'ask_user_question';
    const approvalInput: TrueForgeApi.TurnInputItem[] = isAskQuestion
      ? [
          {
            type: 'user.tool_response',
            threadId: approval.thread_id ?? 'main',
            toolCallId: approval.tool_call_id,
            content: 'Approve DISPATCH_RESOURCE (Station 14 – Civic Center, ETA 2 min)',
          },
        ]
      : [
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
      // Remove from active investigations feed
      for (const [k, v] of activeInvestigations.entries()) {
        if ((v as unknown as { approval?: { id: string } }).approval?.id === approval.id || v.sessionId === approval.session_id) {
          activeInvestigations.delete(k);
        }
      }

      return { success: true, message: 'Approval processed successfully' };
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
    tool_name: string | null;
  }>(
    `UPDATE pending_approvals
     SET status = 'PROCESSING', operator = $2, updated_at = NOW()
     WHERE (id::text = $1 OR incident_id::text = $1)
       AND status = 'PENDING'
     RETURNING id, session_id, thread_id, tool_call_id, incident_id, tool_name`,
    [targetId, operator],
  );

  if (rows.length === 0) {
    throw new Error('No pending approval found (may already be rejected or processing)');
  }

  const approval = rows[0];
  const incidentId = approval.incident_id;

  console.log(`[agent] Operator ${operator} rejected tool call ${approval.tool_call_id} (reason: ${reason})`);

  try {
    const isAskQuestion = approval.tool_name === 'ask_user_question';
    const rejectionInput: TrueForgeApi.TurnInputItem[] = isAskQuestion
      ? [
          {
            type: 'user.tool_response',
            threadId: approval.thread_id ?? 'main',
            toolCallId: approval.tool_call_id,
            content: `Reject action and keep incident under monitoring: ${reason}`,
          },
        ]
      : [
          {
            type: 'user.tool_approval',
            threadId: approval.thread_id ?? 'main',
            toolCallId: approval.tool_call_id,
            approval: { status: 'deny', reason },
          },
        ];

    const stream = await trueforge.sessions.createTurnStream(approval.session_id, {
      input: rejectionInput,
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

    // Remove from active investigations feed
    for (const [k, v] of activeInvestigations.entries()) {
      if ((v as unknown as { approval?: { id: string } }).approval?.id === approval.id || v.sessionId === approval.session_id) {
        activeInvestigations.delete(k);
      }
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
