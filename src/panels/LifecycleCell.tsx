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
import type {
  LifecycleEvaluatedStatus,
  LifecyclePhaseCell,
} from '../types/lifecycle';

export const LIFECYCLE_STATUS_LABELS: Record<LifecycleEvaluatedStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  awaiting_approval: 'Awaiting approval',
  passed: 'Passed',
  deferred: 'Deferred',
  not_applicable: 'Not applicable',
  stale: 'Stale warning',
};

export function LifecycleStatusIcon({ status, size = 16 }: { status: LifecycleEvaluatedStatus; size?: number }) {
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
    status: 'not_started',
    disposition: null,
    gateProgress: { passed: 0, required: 0 },
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
  const parts = [`${specTitle}, ${phaseName}: ${LIFECYCLE_STATUS_LABELS[cell.status]}.`];
  if (isExcluded(cell)) {
    parts.push(cell.rationale?.trim() ? 'Disposition rationale available.' : 'Disposition rationale missing.');
  } else {
    const progress = cell.gateProgress ?? { passed: 0, required: 0 };
    parts.push(`${progress.passed} of ${progress.required} required gates passed.`);
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
  const progress = cell.gateProgress ?? { passed: 0, required: 0 };
  const explanation = lifecycleCellExplanation(specTitle, phaseName, cell);

  return (
    <button
      ref={buttonRef}
      type="button"
      data-status={cell.status}
      data-selected={selected ? 'true' : 'false'}
      aria-label={explanation}
      aria-pressed={selected}
      title={explanation}
      tabIndex={tabIndex}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      className={`lifecycle-cell ${compact ? 'lifecycle-cell--compact' : ''}`}
    >
      <span className="lifecycle-cell__status">
        <LifecycleStatusIcon status={cell.status} />
        <span>{LIFECYCLE_STATUS_LABELS[cell.status]}</span>
      </span>
      {!compact && (
        <span className="lifecycle-cell__detail">
          {excluded
            ? (cell.rationale?.trim() ? 'Rationale available' : 'Rationale missing')
            : `${progress.passed}/${progress.required} gates`}
        </span>
      )}
    </button>
  );
}

export default memo(LifecycleCell);
