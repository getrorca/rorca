/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { memo } from 'react';
import { AlertTriangle, ArrowRight, CircleUserRound, Radio, Sparkles } from 'lucide-react';
import {
  LIFECYCLE_PHASES,
  type LifecyclePhaseId,
  type LifecyclePortfolioItem,
} from '../types/lifecycle';
import {
  LifecycleStatusIcon,
  emptyLifecycleCell,
  lifecycleCellExplanation,
  LIFECYCLE_STATUS_LABELS,
} from './LifecycleCell';

interface LifecycleExplorerProps {
  items: LifecyclePortfolioItem[];
  selectedSpecId: string | null;
  selectedPhaseId: LifecyclePhaseId | null;
  pagination: { page: number; limit: number; total: number; hasMore: boolean };
  onSelect: (specId: string, phaseId: LifecyclePhaseId) => void;
  onOpenSpec: (specId: string) => void;
  onPageChange: (page: number) => void;
}

const PHASE_SHORT_LABELS: Record<LifecyclePhaseId, string> = {
  intake: 'Intake',
  requirements: 'Reqs',
  architecture: 'Arch',
  implementation: 'Build',
  validation: 'Valid',
  security: 'Sec',
  staging: 'Stage',
  qa: 'QA',
  merge: 'Merge',
  production: 'Prod',
  learn: 'Learn',
};

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

function livenessText(item: LifecyclePortfolioItem): string {
  return item.liveness ? titleCase(item.liveness.state) : 'No active run';
}

function storyProgress(item: LifecyclePortfolioItem): { label: string; detail: string; inconsistent: boolean } {
  const { total, passed } = item.storySummary;
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
  const currentPhase = LIFECYCLE_PHASES.find((phase) => phase.id === item.currentPhaseId)?.displayName ?? item.currentPhaseId;

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
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1 font-medium text-[var(--text)]">
              <LifecycleStatusIcon status={item.overallStatus === 'needs_compilation' ? 'stale' : item.overallStatus} size={13} />
              {item.overallStatus === 'needs_compilation' ? 'Needs compilation' : LIFECYCLE_STATUS_LABELS[item.overallStatus]}
            </span>
            <span>{titleCase(item.risk)} risk</span>
            <span
              className={`inline-flex items-center gap-1 tabular-nums ${progress.inconsistent ? 'text-warning' : ''}`}
              title={progress.detail}
              aria-label={progress.detail}
              data-story-progress={progress.inconsistent ? 'inconsistent' : 'current'}
            >
              {progress.inconsistent && <AlertTriangle size={13} aria-hidden="true" />}
              {progress.label}
            </span>
            <span className="inline-flex min-w-0 items-center gap-1">
              <CircleUserRound size={13} aria-hidden="true" />
              <span className="max-w-[14rem] truncate">{item.owner?.label ?? 'Unassigned'}</span>
            </span>
            <span className="inline-flex items-center gap-1" data-state={item.liveness?.state ?? 'none'}>
              <Radio size={13} aria-hidden="true" /> {livenessText(item)}
            </span>
          </div>
        </div>
        <span className="lifecycle-explorer-current-phase">Current · {currentPhase}</span>
      </div>

      <div className="lifecycle-explorer-row__body">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">11-phase journey</h3>
            <span className="text-[0.6875rem] text-muted">Select a phase for evidence</span>
          </div>
          <div className="lifecycle-explorer-rail" role="group" aria-label={`${item.title} lifecycle phases`}>
            {LIFECYCLE_PHASES.map((phase) => {
              const cell = item.phases.find((candidate) => candidate.phaseId === phase.id)
                ?? emptyLifecycleCell(phase.id, phase.displayName);
              const selected = phase.id === selectedPhaseId;
              const explanation = lifecycleCellExplanation(item.title, phase.displayName, cell);
              return (
                <button
                  key={phase.id}
                  type="button"
                  data-lifecycle-phase-cell="true"
                  data-status={cell.status}
                  data-selected={selected ? 'true' : 'false'}
                  aria-label={explanation}
                  aria-pressed={selected}
                  title={explanation}
                  onClick={() => onSelect(item.specId, phase.id)}
                  className="lifecycle-explorer-node focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <span className="lifecycle-explorer-node__icon"><LifecycleStatusIcon status={cell.status} size={15} /></span>
                  <span className="lifecycle-explorer-node__label">{PHASE_SHORT_LABELS[phase.id]}</span>
                  <span className="sr-only">{LIFECYCLE_STATUS_LABELS[cell.status]}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="lifecycle-explorer-guidance" aria-label={`${item.title} blocker and next action`}>
          {blocker ? (
            <div className="lifecycle-explorer-guidance__item" data-kind="blocker">
              <AlertTriangle size={15} aria-hidden="true" />
              <div className="min-w-0"><span>Blocker</span><p title={blocker}>{blocker}</p></div>
            </div>
          ) : (
            <div className="lifecycle-explorer-guidance__item" data-kind="clear">
              <Sparkles size={15} aria-hidden="true" />
              <div><span>Blocker</span><p>No blocker reported</p></div>
            </div>
          )}
          {action && (
            <div className="lifecycle-explorer-guidance__item" data-kind="action">
              <ArrowRight size={15} aria-hidden="true" />
              <div className="min-w-0"><span>Next safe action</span><p title={action}>{action}</p></div>
            </div>
          )}
        </div>
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
        Each spec includes eleven phase buttons. Activate a spec title to open Spec Review, or activate a phase to inspect its evidence.
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
