/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export type KanbanActiveRunStatus = 'running' | 'queued';

export interface KanbanRunStatusFields {
  activeRunId?: number | null;
  activeRunStatus?: KanbanActiveRunStatus | null;
  queuePosition?: number | null;
  isParallelRun?: boolean | null;
}

export interface KanbanRunPresentation {
  hasActiveRun: boolean;
  status?: KanbanActiveRunStatus;
  isQueued: boolean;
  isParallelRun: boolean;
  queuePosition?: number;
  badgeText?: string;
}

export function getKanbanRunPresentation(spec: KanbanRunStatusFields): KanbanRunPresentation {
  const status = spec.activeRunId ? (spec.activeRunStatus ?? 'running') : undefined;
  const queuePosition = typeof spec.queuePosition === 'number' && Number.isFinite(spec.queuePosition)
    ? spec.queuePosition
    : undefined;
  const isQueued = status === 'queued';
  const isParallelRun = spec.isParallelRun === true;

  return {
    hasActiveRun: status !== undefined,
    status,
    isQueued,
    isParallelRun,
    queuePosition,
    badgeText: status === undefined
      ? undefined
      : isQueued
        ? `Queued${queuePosition ? ` #${queuePosition}` : ''}`
        : isParallelRun
          ? 'Running (parallel)'
          : 'Running',
  };
}

export function isRunStatusBlocking(activeRunStatus?: KanbanActiveRunStatus | null): boolean {
  return activeRunStatus === 'running' || activeRunStatus === 'queued';
}
