import { db } from '../db/index';
import { subscribe, type WalEvent } from './sse-hub';
import { createNotification } from '../routes/notifications';

/**
 * Maps WAL events to notifications for relevant users.
 * Called once on startup to subscribe to the SSE hub.
 */
export function startNotificationDispatcher(): void {
  subscribe(handleWalEvent);
}

function handleWalEvent(event: WalEvent): void {
  try {
    const payload = event.payload ? JSON.parse(event.payload) : {};
    const specTitle = (payload.title as string) || event.spec_id || 'a spec';

    switch (event.event_type) {
      case 'review_requested':
        notifyReviewRequest(event, specTitle, payload);
        break;
      case 'spec_approved':
        notifySpecDecision(event, specTitle, 'spec_approved', 'approved');
        break;
      case 'spec_rejected':
        notifySpecDecision(event, specTitle, 'spec_rejected', 'rejected');
        break;
      case 'run_finished':
        notifyPipelineCompleted(event, specTitle, 'completed', payload);
        break;
      case 'run_failed':
        notifyPipelineCompleted(event, specTitle, 'failed', payload);
        break;
      case 'budget_alert':
        notifyBudgetAlert(event, payload);
        break;
    }
  } catch {
    // Don't let notification errors break the event pipeline
  }
}

/** Notify assigned users about review requests */
function notifyReviewRequest(event: WalEvent, specTitle: string, payload: Record<string, unknown>): void {
  // Notify the reviewer if specified in payload
  const reviewerId = payload.reviewerId as string | undefined;
  if (reviewerId && reviewerId !== event.actor) {
    createNotification(
      reviewerId,
      'review_request',
      'Review requested',
      `You've been asked to review "${specTitle}"`,
      event.spec_id ? `/specs/${event.spec_id}` : undefined,
    );
  }

  // Also notify spec assignees (excluding the actor)
  notifySpecAssignees(event, 'review_request', 'Review requested', `Review requested for "${specTitle}"`);
}

/** Notify spec creator/assignees about approval or rejection */
function notifySpecDecision(
  event: WalEvent,
  specTitle: string,
  type: 'spec_approved' | 'spec_rejected',
  verb: string,
): void {
  notifySpecAssignees(
    event,
    type,
    `Spec ${verb}`,
    `"${specTitle}" has been ${verb}`,
  );
}

/** Notify the user who triggered the run about completion */
function notifyPipelineCompleted(
  event: WalEvent,
  specTitle: string,
  status: string,
  payload: Record<string, unknown>,
): void {
  // Notify spec assignees
  notifySpecAssignees(
    event,
    'pipeline_completed',
    `Pipeline ${status}`,
    `Pipeline run for "${specTitle}" ${status}`,
  );

  // Also notify the run triggerer if different from assignees
  const runTriggerer = payload.triggeredBy as string | undefined;
  if (runTriggerer && runTriggerer !== event.actor) {
    createNotification(
      runTriggerer,
      'pipeline_completed',
      `Pipeline ${status}`,
      `Pipeline run for "${specTitle}" ${status}`,
      payload.runId ? `/pipeline/${payload.runId}` : undefined,
    );
  }
}

/** Notify workspace members about budget alerts */
function notifyBudgetAlert(event: WalEvent, payload: Record<string, unknown>): void {
  if (!event.workspace_id) return;

  const members = getWorkspaceTeamMembers(event.workspace_id);
  const message = (payload.message as string) || 'Budget threshold reached';

  for (const userId of members) {
    createNotification(
      userId,
      'budget_alert',
      'Budget alert',
      message,
      event.workspace_id ? `/workspaces/${event.workspace_id}/budget` : undefined,
    );
  }
}

/** Get all users assigned to a spec and notify them (excluding the event actor) */
function notifySpecAssignees(
  event: WalEvent,
  type: 'review_request' | 'spec_approved' | 'spec_rejected' | 'pipeline_completed',
  title: string,
  body: string,
): void {
  if (!event.spec_id || !event.workspace_id) return;

  const assignees = db.prepare(
    'SELECT assignee_id FROM spec_assignments WHERE spec_id = ? AND workspace_id = ?'
  ).all(event.spec_id, event.workspace_id) as { assignee_id: string }[];

  const link = `/specs/${event.spec_id}`;

  for (const { assignee_id } of assignees) {
    if (assignee_id === event.actor) continue; // don't notify yourself
    createNotification(assignee_id, type, title, body, link);
  }
}

/** Get all team member user IDs for a workspace (via workspace_access join table) */
function getWorkspaceTeamMembers(workspaceId: string): string[] {
  const members = db.prepare(`
    SELECT DISTINCT tm.user_id FROM team_members tm
    JOIN workspace_access wa ON wa.team_id = tm.team_id
    WHERE wa.workspace_id = ?
  `).all(workspaceId) as { user_id: string }[];
  return members.map(m => m.user_id);
}
