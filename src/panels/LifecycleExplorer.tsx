/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { memo, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, ArrowRight, CircleUserRound } from 'lucide-react';
import LifecycleLivenessBadge from '../components/LifecycleLivenessBadge';
import { ProseWithHashes } from '../components/LifecycleHashChip';
import { LifecycleMetaChip, LifecycleReadinessStates, LifecycleRiskBadge, LifecycleStatusBadge } from '../components/LifecycleBadges';
import {
  lifecycleStageOf,
  type LifecycleMissionStage,
  type LifecyclePhaseId,
  type LifecyclePortfolioItem,
} from '../types/lifecycle';
import {
  LIFECYCLE_STAGE_IDS,
  aggregateStageCells,
  currentStageOf,
  stageCellAsPhaseCell,
  stageLeadPhase,
} from '../lib/lifecycle-stages';
import {
  LifecycleStatusIcon,
  LIFECYCLE_STATUS_TONES,
  lifecycleCellPresentationStatus,
  lifecycleCellExplanation,
  lifecycleCellTitle,
} from './LifecycleCell';

interface LifecycleExplorerProps {
  items: LifecyclePortfolioItem[];
  selectedSpecId: string | null;
  selectedPhaseId: LifecyclePhaseId | null;
  focusSpecId?: string | null;
  focusPhaseId?: LifecyclePhaseId | null;
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
  onSelect: (specId: string, phaseId: LifecyclePhaseId) => void;
  onOpenSpec: (specId: string) => void;
  onPageChange: (page: number) => void;
}

const STAGE_RAIL_LABELS: Record<LifecycleMissionStage, string> = {
  planning: 'Planning',
  requirements: 'Requirements',
  design: 'Design',
  development: 'Development',
  testing: 'Testing',
  deployment: 'Deployment',
  maintenance: 'Maintenance',
};

function storyProgress(item: LifecyclePortfolioItem): { label: string; detail: string; inconsistent: boolean } {
  const { total, passed } = item.storySummary;
  if (passed === null) {
    return {
      label: `${total} ${total === 1 ? 'story' : 'stories'} · outcome unverified`,
      detail: 'No exact-revision story reconciliation has established the current delivery outcome.',
      inconsistent: false,
    };
  }
  if (passed > total) {
    return {
      label: `${total} ${total === 1 ? 'story' : 'stories'} · progress inconsistent`,
      detail: `Progress unavailable: the latest run reports ${passed} passing result records for ${total} planned ${total === 1 ? 'story' : 'stories'}.`,
      inconsistent: true,
    };
  }
  return {
    label: `${passed}/${total} ${total === 1 ? 'story' : 'stories'} passed`,
    detail: `${passed} of ${total} planned ${total === 1 ? 'story has' : 'stories have'} passing results.`,
    inconsistent: false,
  };
}

function nextAction(item: LifecyclePortfolioItem): string | null {
  const current = item.phases.find((phase) => phase.phaseId === item.currentPhaseId);
  return current?.nextSafeAction
    ?? item.liveness?.nextSafeAction.explanation
    ?? null;
}

function blockerText(item: LifecyclePortfolioItem): string | null {
  return item.blockers[0]?.reason
    ?? item.liveness?.blocker?.summary
    ?? item.phases.find((phase) => phase.phaseId === item.currentPhaseId)?.blocker
    ?? null;
}

/** Guidance surfaces only when the spec actually needs an operator. */
function needsGuidance(item: LifecyclePortfolioItem): boolean {
  return item.blocked
    || item.blockers.length > 0
    || item.overallStatus === 'blocked'
    || item.overallStatus === 'stale'
    || item.overallStatus === 'awaiting_approval'
    || item.overallStatus === 'needs_compilation'
    || Boolean(item.liveness?.blocker);
}

const LifecycleExplorerRow = memo(function LifecycleExplorerRow({
  item,
  selectedPhaseId,
  onSelect,
  onOpenSpec,
}: {
  item: LifecyclePortfolioItem;
  selectedPhaseId: LifecyclePhaseId | null;
  onSelect: (specId: string, phaseId: LifecyclePhaseId) => void;
  onOpenSpec: (specId: string) => void;
}) {
  const blocker = blockerText(item);
  const action = nextAction(item);
  const progress = storyProgress(item);
  const stageCells = aggregateStageCells(item);
  const currentStage = currentStageOf(item);
  const selectedStage = selectedPhaseId ? lifecycleStageOf(selectedPhaseId) : currentStage;
  // Roving tabindex: one tab stop per seven-stage rail; arrows/Home/End move
  // focus without navigation. Activating a stage opens its detail directly.
  const [focusStageId, setFocusStageId] = useState<LifecycleMissionStage>(selectedStage ?? 'planning');
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = index + 1;
    else if (event.key === 'ArrowLeft') next = index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = LIFECYCLE_STAGE_IDS.length - 1;
    else return;
    event.preventDefault();
    const bounded = Math.max(0, Math.min(next, LIFECYCLE_STAGE_IDS.length - 1));
    const stageId = LIFECYCLE_STAGE_IDS[bounded];
    setFocusStageId(stageId);
    const rail = event.currentTarget.closest('.lifecycle-explorer-rail');
    rail?.querySelector<HTMLButtonElement>(`[data-stage="${stageId}"]`)?.focus();
  };

  return (
    <article className="lifecycle-explorer-row" aria-labelledby={`lifecycle-spec-${item.specId}`} data-spec-id={item.specId}>
      <div className="lifecycle-explorer-row__identity">
        <div className="min-w-0">
          <button
            id={`lifecycle-spec-${item.specId}`}
            type="button"
            onClick={() => onOpenSpec(item.specId)}
            title={item.title}
            className="max-w-full truncate rounded-sm text-left text-sm font-semibold text-[var(--text)] hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >{item.title}</button>
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
            <LifecycleStatusBadge
              status={item.overallStatus === 'needs_compilation' ? 'stale' : item.overallStatus}
              label={item.overallStatus === 'needs_compilation' ? 'Needs compilation' : undefined}
            />
            <LifecycleReadinessStates readiness={item.readiness} assurance={item.assurance} delivery={item.delivery} />
            <LifecycleRiskBadge risk={item.risk} />
            <LifecycleMetaChip title={progress.detail}>
              <span
                className={`inline-flex items-center gap-1 tabular-nums ${progress.inconsistent ? 'text-warning' : ''}`}
                aria-label={progress.detail}
                data-story-progress={progress.inconsistent ? 'inconsistent' : 'current'}
              >
                {progress.inconsistent && <AlertTriangle size={12} aria-hidden="true" />}
                {progress.label}
              </span>
            </LifecycleMetaChip>
            <LifecycleMetaChip>
              <span className="inline-flex min-w-0 items-center gap-1">
                <CircleUserRound size={12} aria-hidden="true" />
                <span className="max-w-[14rem] truncate">{item.owner?.label ?? 'Unassigned'}</span>
              </span>
            </LifecycleMetaChip>
            <LifecycleMetaChip>
              <LifecycleLivenessBadge liveness={item.liveness} />
            </LifecycleMetaChip>
          </div>
        </div>
        <span className="lifecycle-explorer-current-phase">{currentStage ? `Current · ${stageCells.find((stage) => stage.stageId === currentStage)?.displayName ?? currentStage}` : 'Current · Not evaluated'}</span>
      </div>

      <div className="lifecycle-explorer-row__body">
        <div className="lifecycle-explorer-rail" role="group" aria-label={`${item.title} lifecycle stages`}>
          {stageCells.map((stage, index) => {
            const selected = stage.stageId === selectedStage;
            const phaseCell = stageCellAsPhaseCell(stage);
            const presentationStatus = lifecycleCellPresentationStatus(phaseCell);
            return (
              <button
                key={stage.stageId}
                type="button"
                data-lifecycle-stage-cell="true"
                data-stage={stage.stageId}
                data-status={presentationStatus}
                data-dependency-status={stage.dependencyStatus ?? 'unknown'}
                data-tone={LIFECYCLE_STATUS_TONES[presentationStatus]}
                aria-label={lifecycleCellExplanation(item.title, stage.displayName, phaseCell)}
                aria-pressed={selected}
                title={lifecycleCellTitle(stage.displayName, phaseCell)}
                tabIndex={stage.stageId === focusStageId ? 0 : -1}
                onFocus={() => setFocusStageId(stage.stageId)}
                onKeyDown={(event) => moveFocus(event, index)}
                onClick={() => onSelect(item.specId, stageLeadPhase(stage))}
                className="lifecycle-explorer-node focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="lifecycle-explorer-node__icon"><LifecycleStatusIcon status={presentationStatus} size={15} /></span>
                <span className="lifecycle-explorer-node__label">{STAGE_RAIL_LABELS[stage.stageId]}</span>
                {stage.dependencyStatus === 'waiting' && <span className="lifecycle-explorer-node__dependency">Dependency wait</span>}
                {stage.dependencyStatus === 'blocked' && <span className="lifecycle-explorer-node__dependency">Dependency blocked</span>}
              </button>
            );
          })}
        </div>

        {needsGuidance(item) && (
          <div className="lifecycle-explorer-guidance" role="group" aria-label={`${item.title} blocker and next action`}>
            {blocker && (
              <div className="lifecycle-explorer-guidance__item" data-kind="blocker">
                <AlertTriangle size={15} aria-hidden="true" />
                <div className="min-w-0"><span>Blocker</span><p><ProseWithHashes text={blocker} /></p></div>
              </div>
            )}
            {action && (
              <div className="lifecycle-explorer-guidance__item" data-kind="action">
                <ArrowRight size={15} aria-hidden="true" />
                <div className="min-w-0"><span>Next step</span><p><ProseWithHashes text={action} /></p></div>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
});

export default function LifecycleExplorer({
  items,
  selectedSpecId,
  selectedPhaseId,
  pagination,
  onSelect,
  onOpenSpec,
  onPageChange,
}: LifecycleExplorerProps) {
  const pageCount = Math.max(1, Math.ceil(pagination.total / pagination.limit));
  return (
    <section className="lifecycle-explorer" aria-label="Lifecycle Explorer">
      <p className="sr-only" id="lifecycle-explorer-help">
        Each spec is organized into seven lifecycle stages. Activate a stage to open its evidence and controls.
        Within a stage rail, use the arrow keys to move between stages without navigating.
      </p>
      <div className="lifecycle-explorer-list" aria-describedby="lifecycle-explorer-help">
        {items.map((item) => (
          <LifecycleExplorerRow
            key={item.specId}
            item={item}
            selectedPhaseId={item.specId === selectedSpecId ? selectedPhaseId : null}
            onSelect={onSelect}
            onOpenSpec={onOpenSpec}
          />
        ))}
      </div>
      {pagination.total > pagination.limit && (
        <nav className="lifecycle-matrix-pagination" aria-label="Lifecycle pagination">
          <span>{pagination.total} specs · Page {pagination.page} of {pageCount}</span>
          <button type="button" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)}>Previous</button>
          <button type="button" disabled={!pagination.hasMore || pagination.page >= pageCount} onClick={() => onPageChange(pagination.page + 1)}>Next</button>
        </nav>
      )}
    </section>
  );
}
