/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { memo, type KeyboardEvent, type Ref } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Circle,
  Clock3,
  Hourglass,
  PauseCircle,
} from 'lucide-react';
import type { LifecyclePhaseCell } from '../types/lifecycle';

type LifecycleCellStatus = LifecyclePhaseCell['status'];

export const LIFECYCLE_STATUS_LABELS: Record<LifecycleCellStatus, string> = {
  unassessed: 'Not evaluated',
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  awaiting_approval: 'Awaiting approval',
  passed: 'Passed',
  deferred: 'Deferred',
  not_applicable: 'Not applicable',
  stale: 'Stale warning',
};

/**
 * Semantic tone per status. Drives the `--lc-*` token pair selected by the
 * `data-tone` attribute so every surface (badges, rail nodes, matrix cells,
 * phase view, legend) shares one status color language. Never color-only:
 * every usage pairs the tone with an icon and text.
 */
export type LifecycleStatusTone = 'passed' | 'progress' | 'blocked' | 'approval' | 'stale' | 'muted';

export const LIFECYCLE_STATUS_TONES: Record<LifecycleCellStatus, LifecycleStatusTone> = {
  passed: 'passed',
  in_progress: 'progress',
  blocked: 'blocked',
  awaiting_approval: 'approval',
  stale: 'stale',
  unassessed: 'muted',
  deferred: 'muted',
  not_applicable: 'muted',
  not_started: 'muted',
};

/** Development is presented by observable execution; every other phase by gate truth. */
export function lifecycleCellPresentationStatus(cell: LifecyclePhaseCell): LifecycleCellStatus {
  const ownStatus = cell.ownStatus ?? cell.status;
  return cell.phaseId === 'development'
    ? cell.activityStatus ?? ownStatus
    : ownStatus;
}

/** Short hover copy; the full explanation stays in the accessible name, not the tooltip. */
export function lifecycleCellTitle(phaseName: string, cell: LifecyclePhaseCell): string {
  const ownStatus = cell.ownStatus ?? cell.status;
  const presentationStatus = lifecycleCellPresentationStatus(cell);
  const activity = cell.phaseId === 'development'
    ? `; activity ${LIFECYCLE_STATUS_LABELS[presentationStatus]}`
    : '';
  const dependency = cell.dependencyStatus ? cell.dependencyStatus.replace(/_/g, ' ') : 'unknown';
  return `${phaseName}: own gates ${LIFECYCLE_STATUS_LABELS[ownStatus]}${activity}; dependencies ${dependency}`;
}

export function LifecycleStatusIcon({ status, size = 16 }: { status: LifecycleCellStatus; size?: number }) {
  const common = { size, 'aria-hidden': true } as const;
  switch (status) {
    case 'passed': return <CheckCircle2 {...common} />;
    case 'blocked': return <AlertTriangle {...common} />;
    case 'in_progress': return <Clock3 {...common} />;
    case 'awaiting_approval': return <Hourglass {...common} />;
    case 'stale': return <AlertTriangle {...common} />;
    case 'deferred': return <PauseCircle {...common} />;
    case 'not_applicable': return <Ban {...common} />;
    default: return <Circle {...common} />;
  }
}

export function emptyLifecycleCell(phaseId: LifecyclePhaseCell['phaseId'], displayName: string): LifecyclePhaseCell {
  return {
    phaseId,
    displayName,
    status: 'unassessed',
    disposition: null,
    gateProgress: { passed: null, required: null },
    rationale: null,
    blocker: null,
    nextSafeAction: null,
  };
}

function isExcluded(cell: LifecyclePhaseCell): boolean {
  return cell.disposition === 'deferred'
    || cell.disposition === 'not_applicable'
    || cell.status === 'deferred'
    || cell.status === 'not_applicable';
}

export function lifecycleCellExplanation(specTitle: string, phaseName: string, cell: LifecyclePhaseCell): string {
  const ownStatus = cell.ownStatus ?? cell.status;
  const presentationStatus = lifecycleCellPresentationStatus(cell);
  const dependency = cell.dependencyStatus ? cell.dependencyStatus.replace(/_/g, ' ') : 'unknown';
  const parts = [`${specTitle}, ${phaseName}. Own gates: ${LIFECYCLE_STATUS_LABELS[ownStatus]}. Dependencies: ${dependency}.`];
  if (cell.phaseId === 'development') {
    parts.push(`Activity: ${LIFECYCLE_STATUS_LABELS[presentationStatus]}.`);
  }
  if (isExcluded(cell)) {
    parts.push(cell.rationale?.trim() ? 'Disposition rationale available.' : 'Disposition rationale missing.');
  } else {
    const progress = cell.gateProgress;
    parts.push(progress?.passed === null || progress?.required === null || !progress
      ? 'Gate progress has not been evaluated.'
      : `${progress.passed} of ${progress.required} required gates passed.`);
  }
  if (cell.learn) {
    parts.push(`${cell.learn.candidateCount} of ${cell.learn.requiredCandidateCount} required candidates and ${cell.learn.sourceEvidenceCount} source evidence records.`);
    const reviewStates = Object.entries(cell.learn.reviewStates).map(([state, count]) => `${count} ${state.replace(/_/g, ' ')}`).join(', ');
    if (reviewStates) parts.push(`Review states: ${reviewStates}.`);
  }
  if (cell.blocker) parts.push(`Blocker: ${cell.blocker}.`);
  if (cell.nextSafeAction) parts.push(`Next safe action: ${cell.nextSafeAction}.`);
  return parts.join(' ');
}

interface LifecycleCellProps {
  specTitle: string;
  phaseName: string;
  cell: LifecyclePhaseCell;
  selected: boolean;
  compact: boolean;
  tabIndex: number;
  buttonRef: Ref<HTMLButtonElement>;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

function LifecycleCell({
  specTitle,
  phaseName,
  cell,
  selected,
  compact,
  tabIndex,
  buttonRef,
  onSelect,
  onKeyDown,
}: LifecycleCellProps) {
  const excluded = isExcluded(cell);
  const progress = cell.gateProgress;
  const ownStatus = cell.ownStatus ?? cell.status;
  const presentationStatus = lifecycleCellPresentationStatus(cell);
  const dependencyWaiting = cell.dependencyStatus === 'waiting' || cell.dependencyStatus === 'blocked';
  const explanation = lifecycleCellExplanation(specTitle, phaseName, cell);

  return (
    <button
      ref={buttonRef}
      type="button"
      data-lifecycle-phase-cell="true"
      data-phase={cell.phaseId}
      data-status={presentationStatus}
      data-dependency-status={cell.dependencyStatus ?? 'unknown'}
      data-tone={LIFECYCLE_STATUS_TONES[presentationStatus]}
      data-selected={selected ? 'true' : 'false'}
      aria-label={explanation}
      aria-pressed={selected}
      title={lifecycleCellTitle(phaseName, cell)}
      tabIndex={tabIndex}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={`lifecycle-cell ${compact ? 'lifecycle-cell--compact' : ''}`}
    >
      <span className="lifecycle-cell__status">
        <LifecycleStatusIcon status={presentationStatus} />
        <span>{LIFECYCLE_STATUS_LABELS[presentationStatus]}</span>
      </span>
      {(!compact || dependencyWaiting) && (
        <span className="lifecycle-cell__detail">
          {cell.dependencyStatus === 'waiting'
            ? 'Waiting on dependencies'
            : cell.dependencyStatus === 'blocked'
              ? 'Dependencies blocked'
              : cell.learn
                ? `${cell.learn.candidateCount}/${cell.learn.requiredCandidateCount} candidates · ${cell.learn.sourceEvidenceCount} evidence`
                : excluded
                  ? (cell.rationale?.trim() ? 'Rationale available' : 'Rationale missing')
                  : progress?.passed === null || progress?.required === null || !progress
                    ? 'Not evaluated'
                    : `${progress.passed}/${progress.required} gates`}
        </span>
      )}
    </button>
  );
}

export default memo(LifecycleCell);
