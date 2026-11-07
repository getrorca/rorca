/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import { BILLING_ANOMALY_LIFECYCLE_ITEM } from '../../fixtures/lifecycleMatrix';
import {
  LIFECYCLE_STAGES,
  lifecycleStageOf,
  type LifecyclePortfolioItem,
} from '../../types/lifecycle';
import {
  LIFECYCLE_STAGE_IDS,
  aggregateStageCells,
  currentStageOf,
  stageDisplayName,
  stageLeadPhase,
  stagePhaseDescriptors,
} from '../lifecycle-stages';

describe('lifecycle-stages', () => {
  it('exposes exactly the seven canonical phases as stages in canonical order', () => {
    expect(LIFECYCLE_STAGE_IDS).toEqual([
      'planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance',
    ]);
    expect(stageDisplayName('testing')).toBe('Testing');
    // Identity projection: each stage contains exactly its own phase.
    expect(stagePhaseDescriptors('testing').map((phase) => phase.id)).toEqual(['testing']);
    expect(stagePhaseDescriptors('planning').map((phase) => phase.id)).toEqual(['planning']);
  });

  it('aggregates the single phase cell into its stage cell', () => {
    const item: LifecyclePortfolioItem = {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      phases: BILLING_ANOMALY_LIFECYCLE_ITEM.phases.map((phase) => {
        if (phase.phaseId === 'testing') {
          return { ...phase, rationale: 'Testing is blocked, but this must not explain a stale stage.' };
        }
        return phase;
      }),
    };
    const cells = aggregateStageCells(item);
    expect(cells).toHaveLength(7);
    const byStage = new Map(cells.map((cell) => [cell.stageId, cell]));

    expect(byStage.get('planning')?.status).toBe('passed');
    expect(byStage.get('design')?.status).toBe('awaiting_approval');
    expect(byStage.get('development')?.status).toBe('in_progress');
    // Testing stage mirrors its single phase cell.
    const testing = byStage.get('testing')!;
    expect(testing.status).toBe('blocked');
    expect(testing.rationale).toBe('Testing is blocked, but this must not explain a stale stage.');
    expect(testing.blocker).toBe('Tenant-isolation integration test is failing.');
    expect(stageLeadPhase(testing)).toBe('testing');
    // Deployment stage mirrors its single deferred phase cell.
    const deployment = byStage.get('deployment')!;
    expect(deployment.status).toBe('deferred');
    expect(deployment.disposition).toBe('deferred');
    // Every canonical phase projects to exactly one stage.
    const projected = cells.flatMap((cell) => cell.phaseIds);
    expect([...projected].sort()).toEqual([
      'deployment', 'design', 'development', 'maintenance', 'planning', 'requirements', 'testing',
    ]);
  });

  it('reads a fully dispositioned stage as its disposition and never as passed', () => {
    const item: LifecyclePortfolioItem = {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      phases: BILLING_ANOMALY_LIFECYCLE_ITEM.phases.map((phase) => (
        phase.phaseId === 'deployment'
          ? { ...phase, disposition: 'deferred', rationale: 'Maintenance window.' }
          : phase
      )),
    };
    const deployment = aggregateStageCells(item).find((cell) => cell.stageId === 'deployment')!;
    expect(deployment.disposition).toBe('deferred');
    expect(deployment.status).toBe('deferred');
    expect(deployment.gateProgress).toBeUndefined();
    expect(deployment.rationale).toBe('Maintenance window.');
  });

  it('treats omitted phase cells as unassessed with unknown gate progress', () => {
    const item: LifecyclePortfolioItem = { ...BILLING_ANOMALY_LIFECYCLE_ITEM, phases: [] };
    const cells = aggregateStageCells(item);
    expect(cells.every((cell) => cell.status === 'unassessed')).toBe(true);
    expect(cells.every((cell) => cell.disposition === null)).toBe(true);
    expect(cells.every((cell) => cell.gateProgress?.passed === null && cell.gateProgress.required === null)).toBe(true);
  });

  it('projects a single passed phase cell as the passed stage (identity stages)', () => {
    const development = BILLING_ANOMALY_LIFECYCLE_ITEM.phases.find((phase) => phase.phaseId === 'development')!;
    const item: LifecyclePortfolioItem = {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      phases: [{ ...development, status: 'passed', gateProgress: { passed: 2, required: 2 }, blocker: null }],
    };
    const developmentCell = aggregateStageCells(item).find((cell) => cell.stageId === 'development')!;
    expect(developmentCell.status).toBe('passed');
    expect(developmentCell.gateProgress).toEqual({ passed: 2, required: 2 });
    expect(developmentCell.cells.map((cell) => [cell.phaseId, cell.status, cell.gateProgress])).toEqual([
      ['development', 'passed', { passed: 2, required: 2 }],
    ]);
    // The other stages have no cells and stay unassessed.
    const testing = aggregateStageCells(item).find((cell) => cell.stageId === 'testing')!;
    expect(testing.status).toBe('unassessed');
    expect(testing.gateProgress).toEqual({ passed: null, required: null });
  });

  it('keeps stage activity, own-gate outcome, and predecessor readiness separate', () => {
    const item: LifecyclePortfolioItem = {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      phases: BILLING_ANOMALY_LIFECYCLE_ITEM.phases.map((phase) => (
        phase.phaseId === 'development'
          ? {
              ...phase,
              status: 'not_started',
              ownStatus: 'passed',
              activityStatus: 'blocked',
              dependencyStatus: 'waiting',
            }
          : phase
      )),
    };

    const development = aggregateStageCells(item).find((cell) => cell.stageId === 'development')!;
    expect(development.status).toBe('not_started');
    expect(development.ownStatus).toBe('passed');
    expect(development.activityStatus).toBe('blocked');
    expect(development.dependencyStatus).toBe('waiting');
  });

  it('picks the aggregate-state-producing member as the stage lead phase', () => {
    const cells = aggregateStageCells(BILLING_ANOMALY_LIFECYCLE_ITEM);
    const byStage = new Map(cells.map((cell) => [cell.stageId, cell]));
    expect(stageLeadPhase(byStage.get('testing')!)).toBe('testing');
    expect(stageLeadPhase(byStage.get('planning')!)).toBe('planning');
  });

  it('derives the current stage label from the spec current phase', () => {
    expect(currentStageOf({ currentPhaseId: 'testing' })).toBe('testing');
    expect(currentStageOf({ currentPhaseId: 'maintenance' })).toBe('maintenance');
    expect(lifecycleStageOf('testing')).toBe('testing');
    expect(lifecycleStageOf('deployment')).toBe('deployment');
  });

  it('stages tile the canonical phases with no gaps or overlaps', () => {
    const projected = LIFECYCLE_STAGES.flatMap((stage) => stage.phaseIds);
    expect(new Set(projected).size).toBe(7);
    expect(projected).toHaveLength(7);
  });
});
