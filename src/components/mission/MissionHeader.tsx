/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Mission workspace header. Renders exactly what the delivery case summary
 * projection provides: identity, exact revisions, a composed situation line,
 * the six-channel operational state, and ONE server-authored dominant action
 * (the packet's next safe action). Nothing is inferred client-side.
 */

import { useId } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ArrowLeft, Building2, ChevronRight, UserRound } from 'lucide-react';
import type { DeliveryCaseSummaryV1 } from '../../../shared/contracts/mission';
import StateChips, { ALL_STATE_FACETS, BlockerNote, EvidenceMeta } from './StateChips';
import LifecycleHashChip from '../LifecycleHashChip';
import { formatRelativeTime } from '../../lib/missionFormat';
import { consumeReturnContext, withReturnContext } from '../../lib/returnContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';

interface MissionHeaderProps {
  summary: DeliveryCaseSummaryV1;
  workspaceLabel?: string;
}

export default function MissionHeader({ summary, workspaceLabel }: MissionHeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { workspaceId } = useWorkspace();
  const titleId = useId();
  const consequenceId = useId();

  const { mission, spec } = summary;
  const { nextSafeAction } = summary.state;
  const matchingAction = summary.actions.find((action) => action.actionId === nextSafeAction.actionId);
  const actionOwnerLabel = matchingAction?.owner.label ?? 'unavailable';

  const backHref = consumeReturnContext(location.search, '/missions', workspaceId);

  const situation = [
    `Lifecycle ${summary.lifecycle.state.replaceAll('_', ' ')}`,
    `${summary.lifecycle.currentStage.replaceAll('_', ' ')} stage`,
    `readiness ${summary.readiness.completedChecks}/${summary.readiness.totalChecks}`,
    `review ${summary.review.state.replaceAll('_', ' ')}`,
    `Run: ${summary.run.state.replaceAll('_', ' ')}`,
    `Release: ${summary.release.state.replaceAll('_', ' ')}`,
  ].join(' · ');

  const actionDestination = withReturnContext(nextSafeAction.href, location, {
    lens: 'mission',
    focus: nextSafeAction.actionId,
  });

  return (
    <section aria-labelledby={titleId}>
      <header className="mission-header">
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted"
        >
          <Link
            to={backHref}
            className="inline-flex flex-none items-center gap-1 text-muted transition-colors hover:text-[var(--text)]"
          >
            <ArrowLeft size={12} aria-hidden="true" />
            Back
          </Link>
          <span aria-hidden="true" className="flex-none opacity-50">·</span>
          <Link to="/missions" className="flex-none transition-colors hover:text-[var(--text)]">
            Missions
          </Link>
          <ChevronRight size={12} aria-hidden="true" className="flex-none" />
          <span className="truncate text-[var(--text)]">{mission.label}</span>
        </nav>

        <div className="mission-header__title-row">
          <h1 id={titleId} className="mission-header__title">
            {mission.label}
          </h1>
          <Link
            to={actionDestination}
            className="mission-header__action"
            aria-describedby={consequenceId}
            onClick={(event) => {
              event.preventDefault();
              navigate(actionDestination);
            }}
          >
            {nextSafeAction.label}
            {nextSafeAction.requiresApproval && (
              <span className="sr-only"> (requires approval)</span>
            )}
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <LifecycleHashChip
            value={mission.revision!.value}
            label={`mission ${mission.revision!.kind}`}
          />
          <LifecycleHashChip
            value={spec.revision!.value}
            label={`spec ${spec.revision!.kind}`}
          />
        </div>

        <p className="mission-header__situation">{situation}</p>
        <p id={consequenceId} className="mission-header__situation">
          {summary.state.consequence}
        </p>

        <div className="mission-header__facets">
          <StateChips packet={summary.state} facets={ALL_STATE_FACETS} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="pk-meta">
            <Building2 size={12} aria-hidden="true" />
            Workspace {workspaceLabel ?? summary.workspaceId}
          </span>
          <span className="pk-meta">
            <UserRound size={12} aria-hidden="true" />
            Mission owner unavailable
          </span>
          <span className="pk-meta">Action owner {actionOwnerLabel}</span>
          <EvidenceMeta packet={summary.state} />
          <span className="pk-meta">projected {formatRelativeTime(summary.projectedAt)}</span>
        </div>

        {summary.state.blocker && <BlockerNote blocker={summary.state.blocker} />}
      </header>
    </section>
  );
}
