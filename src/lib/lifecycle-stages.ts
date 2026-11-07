/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Seven-stage delivery helpers (US-002 / ssdlc-universal-assurance).
 *
 * The canonical lifecycle phases and operator-facing stages share one identity
 * model. These helpers keep profile-driven ordering and status aggregation
 * consistent across the explorer rail, matrix columns, and phase switcher.
 */

import {
  LIFECYCLE_PHASES,
  LIFECYCLE_STAGES,
  type LifecycleMissionStage,
  type LifecyclePhaseCell,
  type LifecyclePhaseDescriptor,
  type LifecyclePhaseId,
  type LifecyclePortfolioItem,
  type LifecycleStageDescriptor,
} from '../types/lifecycle';

export const LIFECYCLE_STAGE_IDS: readonly LifecycleMissionStage[] = LIFECYCLE_STAGES.map((stage) => stage.id);

export function stageDisplayName(stageId: LifecycleMissionStage): string {
  return LIFECYCLE_STAGES.find((stage) => stage.id === stageId)?.displayName ?? stageId;
}

/** Member phase descriptors of one stage, in canonical phase order. */
export function stagePhaseDescriptors(stageId: LifecycleMissionStage): readonly LifecyclePhaseDescriptor[] {
  const stage = LIFECYCLE_STAGES.find((candidate) => candidate.id === stageId);
  if (!stage) return [];
  return LIFECYCLE_PHASES.filter((phase) => stage.phaseIds.includes(phase.id));
}

/** Stage cell — the rollup of one stage's member phase cells for one spec. */
export interface LifecycleStageCell {
  stageId: LifecycleMissionStage;
  displayName: string;
  phaseIds: readonly LifecyclePhaseId[];
  status: LifecyclePhaseCell['status'];
  ownStatus?: LifecyclePhaseCell['ownStatus'];
  activityStatus?: LifecyclePhaseCell['activityStatus'];
  dependencyStatus?: LifecyclePhaseCell['dependencyStatus'];
  disposition: LifecyclePhaseCell['disposition'];
  rationale: string | null;
  gateProgress?: { passed: number | null; required: number | null };
  blocker: string | null;
  nextSafeAction: string | null;
  /** Member phase cells, in canonical phase order, for drill-down. */
  cells: readonly LifecyclePhaseCell[];
}

/**
 * Canonical strongest-first status ordering from the SSDLC wire contract.
 * `unassessed` is UI-only and sits above completed states so an omitted
 * required member can never make a partially projected stage look complete.
 */
const STAGE_STATUS_SEVERITY: Record<LifecyclePhaseCell['status'], number> = {
  stale: 8,
  blocked: 7,
  awaiting_approval: 6,
  in_progress: 5,
  unassessed: 4,
  passed: 3,
  deferred: 2,
  not_applicable: 1,
  not_started: 0,
};

function isDispositioned(cell: LifecyclePhaseCell): boolean {
  return cell.disposition === 'deferred'
    || cell.disposition === 'not_applicable'
    || cell.status === 'deferred'
    || cell.status === 'not_applicable';
}

function worstMember(cells: readonly LifecyclePhaseCell[]): LifecyclePhaseCell | null {
  let worst: LifecyclePhaseCell | null = null;
  let worstSeverity = -1;
  for (const cell of cells) {
    const severity = STAGE_STATUS_SEVERITY[cell.status];
    if (severity > worstSeverity) {
      worstSeverity = severity;
      worst = cell;
    }
  }
  return worst;
}

/**
 * Aggregate one spec's phase cells into seven stage cells.
 *
 * `stages` defaults to the bundled canonical projection; pass the compiled
 * plan profile's stages when available so custom profiles drive the grouping.
 * The spec's phases that are not covered by any provided stage are ignored —
 * the profile is the single source of the stage mapping.
 */
export function aggregateStageCells(
  item: Pick<LifecyclePortfolioItem, 'phases'>,
  stages: readonly LifecycleStageDescriptor[] = LIFECYCLE_STAGES,
): LifecycleStageCell[] {
  return stages.map((stage) => {
    // Every profile member remains visible even when a compact/partial API
    // projection omits its phase cell. Absence is unevaluated, not evidence
    // that work has not started and never a synthetic zero-gate result.
    const cells = stage.phaseIds.map<LifecyclePhaseCell>((phaseId) => {
      const existing = item.phases.find((cell) => cell.phaseId === phaseId);
      if (existing) return existing;
      const displayName = LIFECYCLE_PHASES.find((phase) => phase.id === phaseId)?.displayName ?? phaseId;
      return { phaseId, displayName, status: 'unassessed', disposition: null, gateProgress: { passed: null, required: null }, rationale: null, blocker: null, nextSafeAction: null };
    });
    // Dispositioned controls are governed exclusions, not required work. They
    // stay visible for drill-down but cannot affect a mixed stage's status or
    // gate denominator.
    const requiredCells = cells.filter((cell) => !isDispositioned(cell));
    // A stage is dispositioned only when EVERY member is dispositioned
    // (deferred/not_applicable); a single required member keeps the stage
    // required so its rollup still reports gates and blockers.
    const disposition = cells.length > 0 && requiredCells.length === 0
      ? (cells.every((cell) => cell.disposition === 'deferred' || cell.status === 'deferred')
        ? 'deferred' as const
        : 'not_applicable' as const)
      : null;
    const statusMember = disposition === 'deferred'
      ? cells.find((cell) => cell.disposition === 'deferred' || cell.status === 'deferred') ?? null
      : disposition === 'not_applicable'
        ? cells.find((cell) => cell.disposition === 'not_applicable' || cell.status === 'not_applicable') ?? null
        : worstMember(requiredCells);
    const status = disposition ?? statusMember?.status ?? 'unassessed';
    const ownStatusMember = disposition === null
      ? worstMember(requiredCells.map((cell) => ({ ...cell, status: cell.ownStatus ?? cell.status })))
      : null;
    const ownStatus = disposition ?? ownStatusMember?.status ?? 'unassessed';
    const activityStatusMember = disposition === null
      ? worstMember(requiredCells.map((cell) => ({ ...cell, status: cell.activityStatus ?? cell.status })))
      : null;
    const activityStatus = disposition ?? activityStatusMember?.status ?? 'unassessed';
    const dependencyStatuses = requiredCells
      .map((cell) => cell.dependencyStatus)
      .filter((value): value is NonNullable<LifecyclePhaseCell['dependencyStatus']> => value !== undefined);
    const dependencyStatus = dependencyStatuses.includes('blocked')
      ? 'blocked' as const
      : dependencyStatuses.includes('waiting')
        ? 'waiting' as const
        : dependencyStatuses.length === requiredCells.length && dependencyStatuses.every((value) => value === 'ready')
          ? 'ready' as const
          : undefined;
    const progressCells = requiredCells.filter((cell) => cell.gateProgress !== undefined);
    const gateProgress = progressCells.length === 0
      ? undefined
      : progressCells.some((cell) => cell.gateProgress?.passed === null || cell.gateProgress?.required === null)
        ? { passed: null, required: null }
        : {
            passed: progressCells.reduce((total, cell) => total + (cell.gateProgress?.passed ?? 0), 0),
            required: progressCells.reduce((total, cell) => total + (cell.gateProgress?.required ?? 0), 0),
          };
    return {
      stageId: stage.id,
      displayName: stage.displayName,
      phaseIds: stage.phaseIds,
      status,
      ownStatus,
      activityStatus,
      dependencyStatus,
      disposition,
      rationale: statusMember?.rationale?.trim() ? statusMember.rationale : null,
      ...(gateProgress ? { gateProgress } : {}),
      blocker: statusMember?.blocker ?? null,
      nextSafeAction: statusMember?.nextSafeAction ?? null,
      cells,
    };
  });
}

/** The phase producing a stage's aggregate state, else its first member. */
export function stageLeadPhase(stage: LifecycleStageCell): LifecyclePhaseId {
  return stage.cells.find((cell) => cell.status === stage.status && (
    stage.disposition !== null || !isDispositioned(cell)
  ))?.phaseId
    ?? stage.cells.find((cell) => cell.status !== 'passed' && !isDispositioned(cell))?.phaseId
    ?? stage.phaseIds[0];
}

/**
 * Adapter for the shared cell presentation helpers (lifecycleCellTitle /
 * lifecycleCellExplanation), which are typed on LifecyclePhaseCell. The stage
 * cell carries the same presentation fields; only the synthetic phaseId
 * differs (the lead phase, used for deep-link focus restoration).
 */
export function stageCellAsPhaseCell(stage: LifecycleStageCell): LifecyclePhaseCell {
  return {
    phaseId: stageLeadPhase(stage),
    displayName: stage.displayName,
    status: stage.status,
    ownStatus: stage.ownStatus,
    activityStatus: stage.activityStatus,
    dependencyStatus: stage.dependencyStatus,
    disposition: stage.disposition,
    gateProgress: stage.gateProgress,
    rationale: stage.rationale,
    blocker: stage.blocker,
    nextSafeAction: stage.nextSafeAction,
  };
}

/** Stage id of a spec's current phase; null means no canonical evaluation. */
export function currentStageOf(item: Pick<LifecyclePortfolioItem, 'currentPhaseId'>): LifecycleMissionStage | null {
  const phaseId = item.currentPhaseId;
  if (!phaseId) return null;
  return LIFECYCLE_STAGES.find((candidate) => candidate.phaseIds.includes(phaseId))?.id ?? null;
}
