/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ActionCard — the atomic Action Inbox row.
 *
 * Everything visible comes from the server-authored ActionEnvelopeV1:
 * priority, identity, state facets, why-now, consequence, provenance, owner,
 * blocker, and exactly one permitted action. The card never infers state and
 * never offers client-side affordances (snooze/dismiss) that have no backend
 * preference behind them. The card body is not clickable; the entity title
 * link and the permitted-action link are the only navigation elements.
 */

import { Link, useLocation } from 'react-router';
import {
  CheckCircle2, Gavel, Info, OctagonAlert, ShieldAlert, type LucideIcon,
} from 'lucide-react';
import type { ActionEnvelopeV1, EntityRefV1 } from '../../../shared/contracts/mission';
import LifecycleHashChip from '../LifecycleHashChip';
import { entityRoute } from '../../lib/entityRoutes';
import { missionCasePath } from '../../lib/missionRoutes';
import { formatRelativeTime } from '../../lib/missionFormat';
import { withReturnContext } from '../../lib/returnContext';
import StateChips, { BlockerNote, EvidenceMeta } from './StateChips';

type Priority = ActionEnvelopeV1['priority'];
type Outcome = ActionEnvelopeV1['state']['outcome'];
type EntityKind = EntityRefV1['kind'];

interface PriorityPresentation {
  label: string;
  icon: LucideIcon;
  tone: 'failed' | 'warning' | 'stale' | 'success' | 'neutral';
}

const PRIORITY_PRESENTATION: Record<Priority, PriorityPresentation> = {
  safety: { label: 'Safety risk', icon: ShieldAlert, tone: 'failed' },
  decision: { label: 'Decision needed', icon: Gavel, tone: 'warning' },
  blocked: { label: 'Blocked', icon: OctagonAlert, tone: 'stale' },
  ready: { label: 'Ready to advance', icon: CheckCircle2, tone: 'success' },
  informational: { label: 'For awareness', icon: Info, tone: 'neutral' },
};

const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  workspace: 'Workspace',
  mission: 'Mission',
  spec: 'Spec',
  story: 'Story',
  run: 'Run',
  attempt: 'Attempt',
  process: 'Process',
  phase: 'Phase',
  gate: 'Gate',
  evidence: 'Evidence',
  decision: 'Decision',
  commit: 'Commit',
  bundle: 'Bundle',
  knowledge: 'Knowledge',
  insight: 'Insight',
};

/** Spoken form of the outcome channel for the article's accessible name. */
const OUTCOME_ARIA: Record<Outcome, string> = {
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  partial: 'partially complete',
  pending: 'pending',
  not_available: 'outcome not available',
  unknown: 'outcome unknown',
};

interface ActionCardProps {
  action: ActionEnvelopeV1;
  workspaceId: string;
}

export default function ActionCard({ action, workspaceId }: ActionCardProps) {
  // workspaceId is part of the panel-level contract for this row; navigation
  // targets already carry the envelope's own workspace identity.
  void workspaceId;
  const location = useLocation();
  const priority = PRIORITY_PRESENTATION[action.priority];
  const PriorityIcon = priority.icon;
  const returnOptions = { lens: 'today', focus: action.actionId };
  const actionHref = withReturnContext(action.permittedAction.href, location, returnOptions);
  // Canonical object destination: specs open the Mission Workspace.
  const entityDestination = action.entity.kind === 'spec'
    ? missionCasePath(action.entity.id)
    : entityRoute(action.entity);
  const entityHref = withReturnContext(entityDestination, location, returnOptions);
  const ownerText = action.owner.kind === 'unassigned' ? 'Unassigned' : `Owner: ${action.owner.label}`;

  return (
    <article
      className="action-card"
      aria-label={`${priority.label}: ${action.entity.label} — ${OUTCOME_ARIA[action.state.outcome]}`}
    >
      <div className="action-card__row">
        <div className="action-card__identity">
          <span className="pk-chip self-start" data-tone={priority.tone}>
            <PriorityIcon size={12} aria-hidden="true" />
            <span>{priority.label}</span>
          </span>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted">
              {ENTITY_KIND_LABELS[action.entity.kind]}
            </span>
            <Link to={entityHref} className="action-card__title">
              {action.entity.label}
            </Link>
            {action.entity.revision && (
              <LifecycleHashChip
                value={action.entity.revision.value}
                label={action.entity.revision.kind}
              />
            )}
          </div>
          {action.mission && (
            <span className="pk-meta">Mission: {action.mission.label}</span>
          )}
        </div>
        <Link
          to={actionHref}
          className="action-card__action"
          aria-label={
            action.permittedAction.requiresApproval
              ? `${action.permittedAction.label}, requires approval`
              : action.permittedAction.label
          }
        >
          {action.permittedAction.label}
        </Link>
      </div>
      <div className="action-card__facets">
        <StateChips packet={action.state} facets={['outcome', 'liveness', 'risk']} />
      </div>
      <p className="action-card__why">{action.whyNow}</p>
      <p className="action-card__consequence">Consequence: {action.state.consequence}</p>
      {action.state.blocker && <BlockerNote blocker={action.state.blocker} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <EvidenceMeta packet={action.state} />
        <span className="pk-meta">{ownerText}</span>
        <span className="pk-meta">raised {formatRelativeTime(action.createdAt)}</span>
      </div>
    </article>
  );
}
