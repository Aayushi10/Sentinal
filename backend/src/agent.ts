/**
 * agent.ts
 * --------
 * Runs a TrueForge session against "sentinel-prod-v1", streams events,
 * handles `tool.approval_required` pauses, and persists results to the DB.
 *
 * The turn loop does NOT block the HTTP request — it runs in the background
 * after the report is inserted. The frontend polls /incidents for updates.
 */

import { TrueForgeApi, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';
import { pool } from './db';
import { trueforge, AGENT_NAME } from './trueforge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of `incidents` columns we write during agent processing. */
interface IncidentApprovalState {
  incidentId: string;
  sessionId: string;
  turnId: string;
  threadId: string;
  toolCallId: string;
  evidence: Record<string, unknown>;
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a best-effort evidence / recommendation summary from the accumulated
 * model messages seen during the turn, so the UI can show them even when the
 * agent is paused and hasn't written a final message.
 */
function extractEvidenceFromEvents(
  events: Map<string, TrueForgeApi.TurnStreamingEvent>,
): { evidence: Record<string, unknown>; recommendation: string } {
  let lastModelContent = '';

  for (const evt of events.values()) {
    if (evt.type === 'model.message' && evt.threadId === 'main') {
      const content = (evt as TrueForgeApi.ModelMessageEvent).content;
      if (content) {
        // content is string | ModelMessageEventContentOneItem[]
        if (typeof content === 'string') {
          lastModelContent = content;
        } else {
          // Concatenate all text parts from the content array
          lastModelContent = content
            .map((part) => ('text' in part ? (part as { text: string }).text : ''))
            .join('');
        }
      }
    }
  }

  // Try to split a "recommendation:" suffix the agent commonly produces.
  const recMatch = lastModelContent.match(/recommendation[:\s]+(.+)$/is);
  const recommendation = recMatch ? recMatch[1].trim() : lastModelContent.slice(-500);

  return {
    evidence: { agentSummary: lastModelContent },
    recommendation,
  };
}

/**
 * Persist the approval-pending state into the `incidents` row.
 * The incident row was already created by `create_incident_action` inside
 * the MCP server. We only update the TrueForge tracking columns here.
 */
async function persistApprovalState(state: IncidentApprovalState): Promise<void> {
  const { incidentId, sessionId, turnId, threadId, toolCallId, evidence, recommendation } = state;
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
    [sessionId, turnId, threadId, toolCallId, JSON.stringify(evidence), recommendation, incidentId],
  );
}

/**
 * Clear approval-pending state after the resumed turn completes or is rejected.
 * On rejection, we reset to OPEN/INVESTIGATING so the incident can be re-flagged.
 */
async function clearApprovalState(
  incidentId: string,
  approvalStatus: 'APPROVED' | 'REJECTED',
): Promise<void> {
  await pool.query(
    `UPDATE incidents
     SET pending_session_id   = NULL,
         pending_turn_id      = NULL,
         pending_thread_id    = NULL,
         pending_tool_call_id = NULL,
         approval_status      = $1,
         updated_at           = NOW()
         -- deliberately leave evidence + recommendation for the UI to display
     WHERE id = $2`,
    [approvalStatus, incidentId],
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * startAgentSession
 * -----------------
 * Opens a new TrueForge session against sentinel-prod-v1, sends the incoming
 * report text as the first user message, streams events until the turn ends
 * (either `done` or paused on `tool.approval_required`), and writes results
 * to the DB.
 *
 * Called in the background after a report is inserted — does NOT await from
 * the HTTP handler.
 */
export async function startAgentSession(
  reportId: string,
  reportText: string,
  reportLat: number,
  reportLng: number,
  category: string,
): Promise<void> {
  console.log(`[agent] Starting session for report ${reportId}`);

  try {
    // 1. Open a session on the saved agent.
    const { data: session } = await trueforge.sessions.create({
      agent: { name: AGENT_NAME },
    });
    console.log(`[agent] Session created: ${session.id}`);

    // 2. Stream the first turn — the full report context.
    const userMessage =
      `New anonymous incident report submitted.\n\n` +
      `Report ID: ${reportId}\n` +
      `Category: ${category}\n` +
      `Coordinates: lat=${reportLat}, lng=${reportLng}\n` +
      `Description: ${reportText}\n\n` +
      `Please investigate this report: search for nearby related reports, ` +
      `assess severity and corroboration, then decide whether to create an incident ` +
      `and/or dispatch resources. Use create_incident_action for any consequential steps.`;

    const events = new Map<string, TrueForgeApi.TurnStreamingEvent>();
    const pendingApprovals: TrueForgeApi.ToolApprovalRequiredEvent[] = [];
    let turnId: string | undefined;

    const stream = await trueforge.sessions.createTurnStream(session.id, {
      input: [{ type: 'user.message', content: userMessage }],
    });

    for await (const { data: event } of stream.withMetadata()) {
      if (event.type === 'turn.created') {
        turnId = (event as TrueForgeApi.TurnCreatedEvent).turnId;
      }

      if (isEventDelta(event)) {
        const base = events.get(event.id);
        if (base) mergeEventDelta(base, event);
      } else {
        events.set(event.id, event);
      }

      if (event.type === 'tool.approval_required') {
        pendingApprovals.push(event as TrueForgeApi.ToolApprovalRequiredEvent);
      }

      if (event.type === 'turn.done') {
        const done = event as TrueForgeApi.TurnDoneEvent;
        console.log(`[agent] Turn done, status=${done.state.status}`);
      }
    }

    // 3. If the turn paused for approval, find the incident the agent created
    //    and store the pending approval state.
    if (pendingApprovals.length > 0 && turnId) {
      const { evidence, recommendation } = extractEvidenceFromEvents(events);

      for (const pending of pendingApprovals) {
        for (const ref of pending.toolCalls) {
          const msg = events.get(ref.sourceEventId);
          if (msg?.type !== 'model.message') continue;
          const modelMsg = msg as TrueForgeApi.ModelMessageEvent;
          const call = modelMsg.toolCalls?.find((tc) => tc.id === ref.id);
          if (!call) continue;

          console.log(
            `[agent] Tool approval required: ${call.toolInfo.name}(${call.function.arguments})`,
          );

          // The agent must have called create_incident_action, which creates an
          // incidents row. Find the most recent PENDING_APPROVAL or INVESTIGATING
          // incident that has no pending_session_id yet (i.e. just created by the
          // MCP tool in this session).
          const { rows } = await pool.query<{ id: string }>(
            `SELECT id FROM incidents
             WHERE pending_session_id IS NULL
               AND status IN ('INVESTIGATING', 'PENDING_APPROVAL', 'OPEN')
             ORDER BY created_at DESC
             LIMIT 1`,
          );

          if (rows.length === 0) {
            console.warn('[agent] No untracked incident found to attach approval state to');
            continue;
          }

          const incidentId = rows[0].id;
          await persistApprovalState({
            incidentId,
            sessionId: session.id,
            turnId,
            threadId: pending.threadId ?? 'main',
            toolCallId: ref.id,
            evidence,
            recommendation,
          });

          console.log(`[agent] Approval state saved for incident ${incidentId}`);
        }
      }
    }
  } catch (err) {
    console.error(`[agent] Error in session for report ${reportId}:`, err);
  }
}

/**
 * approveIncidentAction
 * ---------------------
 * Resumes the paused TrueForge session with `user.tool_approval { status: 'allow' }`.
 * Clears the approval state on the incident after the turn completes.
 */
export async function approveIncidentAction(incidentId: string): Promise<void> {
  const { rows } = await pool.query<{
    pending_session_id: string;
    pending_thread_id: string;
    pending_tool_call_id: string;
  }>(
    `SELECT pending_session_id, pending_thread_id, pending_tool_call_id
     FROM incidents WHERE id = $1`,
    [incidentId],
  );

  if (rows.length === 0) throw new Error(`Incident ${incidentId} not found`);
  const { pending_session_id, pending_thread_id, pending_tool_call_id } = rows[0];

  if (!pending_session_id || !pending_tool_call_id) {
    throw new Error(`Incident ${incidentId} has no pending approval`);
  }

  console.log(`[agent] Resuming session ${pending_session_id} with ALLOW`);

  const approvalInput: TrueForgeApi.UserToolApprovalEvent[] = [
    {
      type: 'user.tool_approval',
      threadId: pending_thread_id ?? 'main',
      toolCallId: pending_tool_call_id,
      approval: { status: 'allow' },
    },
  ];

  const resume = await trueforge.sessions.createTurnStream(pending_session_id, {
    input: approvalInput,
  });

  for await (const { data: event } of resume.withMetadata()) {
    if (event.type === 'turn.done') {
      console.log(`[agent] Resume turn done for incident ${incidentId}`);
    }
  }

  await clearApprovalState(incidentId, 'APPROVED');
}

/**
 * rejectIncidentAction
 * --------------------
 * Resumes the paused TrueForge session with `user.tool_approval { status: 'deny' }`.
 * The incident is reset to OPEN/INVESTIGATING (not closed) so it can be re-flagged.
 */
export async function rejectIncidentAction(
  incidentId: string,
  reason: string,
): Promise<void> {
  const { rows } = await pool.query<{
    pending_session_id: string;
    pending_thread_id: string;
    pending_tool_call_id: string;
  }>(
    `SELECT pending_session_id, pending_thread_id, pending_tool_call_id
     FROM incidents WHERE id = $1`,
    [incidentId],
  );

  if (rows.length === 0) throw new Error(`Incident ${incidentId} not found`);
  const { pending_session_id, pending_thread_id, pending_tool_call_id } = rows[0];

  if (!pending_session_id || !pending_tool_call_id) {
    throw new Error(`Incident ${incidentId} has no pending approval`);
  }

  console.log(`[agent] Resuming session ${pending_session_id} with DENY: ${reason}`);

  const denyInput: TrueForgeApi.UserToolApprovalEvent[] = [
    {
      type: 'user.tool_approval',
      threadId: pending_thread_id ?? 'main',
      toolCallId: pending_tool_call_id,
      approval: { status: 'deny', reason },
    },
  ];

  const resume = await trueforge.sessions.createTurnStream(pending_session_id, {
    input: denyInput,
  });

  for await (const { data: event } of resume.withMetadata()) {
    if (event.type === 'turn.done') {
      console.log(`[agent] Deny turn done for incident ${incidentId}`);
    }
  }

  // Reset to INVESTIGATING — per design, rejection does NOT close the incident.
  await pool.query(
    `UPDATE incidents
     SET status       = 'INVESTIGATING',
         approval_status = 'REJECTED',
         pending_session_id   = NULL,
         pending_turn_id      = NULL,
         pending_thread_id    = NULL,
         pending_tool_call_id = NULL,
         updated_at   = NOW()
     WHERE id = $1`,
    [incidentId],
  );
}
