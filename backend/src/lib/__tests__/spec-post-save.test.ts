/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PSE-003: Unit tests for the post-save stage status contract.
 *
 * Tests cover:
 *   (1) buildPersistPostSaveStages sets correct initial states
 *   (2) Requested stages start as pending with reason 'requested_by_caller'
 *   (3) Disabled stages start as skipped with reason 'disabled_by_caller'
 *   (4) Mixed requested/disabled stages are handled correctly
 *   (5) All three stages (enrich, matchSkills, memorySynthesis) are always present
 *   (6) Stage status type includes all canonical values
 */

import {
  buildPersistPostSaveStages,
  type PersistPostSaveStageMap,
  type PersistStageStatus,
  type PersistPostSaveStageState,
} from '../spec-post-save';

// Mock DB and pg-boss — buildPersistPostSaveStages is pure logic, no I/O needed
jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  execute: jest.fn(),
}));
jest.mock('../../db/spec-jobs', () => ({
  createJob: jest.fn(),
  getJob: jest.fn(),
  listJobsForSpec: jest.fn(),
  updateJobStatus: jest.fn(),
}));
jest.mock('../pg-boss', () => ({
  initBoss: jest.fn(),
  getBoss: jest.fn(),
}));
jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('PSE-003: buildPersistPostSaveStages', () => {
  it('returns pending status for all requested stages', () => {
    const stages = buildPersistPostSaveStages({
      enrich: true,
      matchSkills: true,
      memorySynthesis: true,
    });

    expect(stages.enrich).toMatchObject({
      requested: true,
      status: 'pending',
      reason: 'requested_by_caller',
    });
    expect(stages.matchSkills).toMatchObject({
      requested: true,
      status: 'pending',
      reason: 'requested_by_caller',
    });
    expect(stages.memorySynthesis).toMatchObject({
      requested: true,
      status: 'pending',
      reason: 'requested_by_caller',
    });
  });

  it('returns skipped status for all disabled stages', () => {
    const stages = buildPersistPostSaveStages({
      enrich: false,
      matchSkills: false,
      memorySynthesis: false,
    });

    expect(stages.enrich).toMatchObject({
      requested: false,
      status: 'skipped',
      reason: 'disabled_by_caller',
    });
    expect(stages.matchSkills).toMatchObject({
      requested: false,
      status: 'skipped',
      reason: 'disabled_by_caller',
    });
    expect(stages.memorySynthesis).toMatchObject({
      requested: false,
      status: 'skipped',
      reason: 'disabled_by_caller',
    });
  });

  it('handles mixed requested and disabled stages', () => {
    const stages = buildPersistPostSaveStages({
      enrich: true,
      matchSkills: false,
      memorySynthesis: true,
    });

    expect(stages.enrich.requested).toBe(true);
    expect(stages.enrich.status).toBe('pending');
    expect(stages.matchSkills.requested).toBe(false);
    expect(stages.matchSkills.status).toBe('skipped');
    expect(stages.memorySynthesis.requested).toBe(true);
    expect(stages.memorySynthesis.status).toBe('pending');
  });

  it('always includes all three stage keys', () => {
    const stages = buildPersistPostSaveStages({
      enrich: false,
      matchSkills: false,
      memorySynthesis: false,
    });

    expect(Object.keys(stages).sort()).toEqual(['enrich', 'matchSkills', 'memorySynthesis']);
  });

  it('distinguishes "skipped because not requested" from a requested stage', () => {
    const stages = buildPersistPostSaveStages({
      enrich: true,
      matchSkills: false,
      memorySynthesis: false,
    });

    // Skipped stages have requested=false and reason='disabled_by_caller'
    expect(stages.matchSkills.requested).toBe(false);
    expect(stages.matchSkills.status).toBe('skipped');
    expect(stages.matchSkills.reason).toBe('disabled_by_caller');

    // Requested stages have requested=true and reason='requested_by_caller'
    expect(stages.enrich.requested).toBe(true);
    expect(stages.enrich.status).toBe('pending');
    expect(stages.enrich.reason).toBe('requested_by_caller');
  });
});

describe('PSE-003: PersistStageStatus type coverage', () => {
  it('covers all canonical status values', () => {
    const allStatuses: PersistStageStatus[] = [
      'pending', 'queued', 'running', 'completed', 'failed', 'skipped',
    ];
    // Ensure each is a valid assignment (compile-time check manifested as runtime array)
    expect(allStatuses).toHaveLength(6);
  });
});

describe('PSE-003: stage state shape contract', () => {
  it('stage state contains expected fields for a requested stage', () => {
    const stages = buildPersistPostSaveStages({
      enrich: true,
      matchSkills: true,
      memorySynthesis: true,
    });

    const stage: PersistPostSaveStageState = stages.enrich;
    expect(stage).toHaveProperty('requested');
    expect(stage).toHaveProperty('status');
    expect(stage).toHaveProperty('reason');
    // jobId, bossJobId, error, updatedAt are optional at initial state
    expect(stage.jobId).toBeUndefined();
    expect(stage.bossJobId).toBeUndefined();
    expect(stage.error).toBeUndefined();
  });
});
