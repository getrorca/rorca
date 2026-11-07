/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({ query: jest.fn(), queryOne: jest.fn(), execute: jest.fn(), transaction: jest.fn() }));

import {
  pendingLifecycleApprovalGates,
  projectLifecycleExecution,
  projectLifecyclePhaseStatuses,
  projectLifecyclePhaseActivity,
  projectDevelopmentExecutionSnapshot,
} from '../ssdlc-lifecycle-read';
import type { LifecyclePlan, PhaseId } from '../ssdlc-contracts';
import type { LifecycleEvaluation, PhaseEvaluation } from '../ssdlc-phase-evaluator';

function gate(gateId: string, phaseId: PhaseId, status: PhaseEvaluation['status']) {
  return { gateId, phaseId, status } as unknown as PhaseEvaluation['gates'][number];
}

function phase(input: {
  phaseId: PhaseId;
  status: PhaseEvaluation['status'];
  gates: PhaseEvaluation['gates'];
  dependencies?: string[];
  excluded?: boolean;
}) {
  return {
    phaseId: input.phaseId,
    status: input.status,
    gates: input.gates,
    dependencies: input.dependencies ?? [],
    excluded: input.excluded ?? false,
  } as unknown as PhaseEvaluation;
}

describe('lifecycle readiness projection', () => {
  test('persisted completed execution is independent of partial entry assurance', () => {
    expect(projectLifecycleExecution({ id: 42, status: 'done' }, [{
      phaseId: 'requirements',
      excluded: false,
      ownStatus: 'awaiting_approval',
      dependencyStatus: 'waiting',
    }])).toEqual({
      status: 'completed',
      runId: 42,
      rationale: 'Persisted run 42 completed.',
    });
  });

  test('projects a running pipeline as development activity without passing gates', () => {
    expect(projectLifecyclePhaseActivity('development', 'not_started', { id: 64, status: 'running' })).toBe('in_progress');
    expect(projectLifecyclePhaseActivity('development', 'blocked', { id: 64, status: 'running' })).toBe('blocked');
    expect(projectLifecyclePhaseActivity('development', 'not_started', { id: 64, status: 'done' })).toBe('not_started');
    expect(projectLifecyclePhaseActivity('development', 'not_started', { id: 64, status: 'partial_failure' })).toBe('blocked');
    expect(projectLifecyclePhaseActivity('development', 'not_started', { id: 64, status: 'failed' })).toBe('blocked');
    expect(projectLifecyclePhaseActivity('testing', 'not_started', { id: 64, status: 'running' })).toBe('not_started');
  });

  test('projects an active Development run without changing gate truth', () => {
    const projection = projectDevelopmentExecutionSnapshot({
      storyReferences: ['ACC-001', 'ACC-002', 'ACC-003'],
      run: {
        id: 64,
        status: 'running',
        agentType: 'omp',
        startedAt: '2026-08-20T20:17:05.664Z',
        finishedAt: null,
      },
      results: [{
        id: 1,
        story_id: 'ACC-001',
        status: 'pass',
        retries: 0,
        started_at: '2026-08-20T20:20:00.000Z',
        finished_at: '2026-08-20T20:30:00.000Z',
        elapsed_seconds: 600,
        model_used: 'openai-codex/gpt-5.6-sol',
        worktree_path: '/workspace',
        worktree_branch: 'feat/acc',
      }],
      integrations: [{
        story_id: 'ACC-001',
        attempt: 1,
        integration_order: 0,
        state: 'finalized',
        source_commit: '1'.repeat(40),
        source_base_commit: '0'.repeat(40),
        resulting_head: '2'.repeat(40),
        failure_reason: null,
      }],
      reviews: [{
        story_id: 'ACC-001',
        validation_status: 'passed',
        manifest_json: {
          changedFiles: [{ path: 'src/accountant-copilot.ts', change: 'modified' }],
          validation: { receipts: [{ gate: 'unit-tests', revoked: false }] },
        },
      }],
      latestEvent: { event_type: 'story_started', story_id: 'ACC-002' },
    });

    expect(projection).toMatchObject({
      activityStatus: 'in_progress',
      currentStoryId: 'ACC-002',
      stories: { total: 3, passed: 1, failed: 0 },
      source: {
        worktreePath: '/workspace',
        branch: 'feat/acc',
        baseCommit: '0'.repeat(40),
        resultingHead: '2'.repeat(40),
      },
      integration: { finalized: 1, failed: 0, expected: 3 },
    });
    expect(projection.changes).toEqual({
      commits: 1,
      additions: null,
      deletions: null,
      files: [{ path: 'src/accountant-copilot.ts', change: 'modified' }],
    });
    expect(projection.verification).toMatchObject({
      hostReview: { status: 'passed', evidence: '1 canonical local-review bundle' },
      unit: { status: 'passed', evidence: '1 host-observed validation receipt' },
      security: { status: 'missing', evidence: null },
    });
    expect(projection.stories.items).toEqual([
      expect.objectContaining({ storyId: 'ACC-001', status: 'passed', integrationState: 'finalized' }),
      expect.objectContaining({ storyId: 'ACC-002', status: 'running' }),
      expect.objectContaining({ storyId: 'ACC-003', status: 'pending' }),
    ]);
  });

  test('projects partial Development execution as blocked rather than not started', () => {
    const projection = projectDevelopmentExecutionSnapshot({
      storyReferences: ['ACC-009', 'ACC-010'],
      run: {
        id: 67,
        status: 'partial_failure',
        agentType: 'omp',
        startedAt: '2026-08-21T01:08:32.818Z',
        finishedAt: '2026-08-21T02:01:09.983Z',
      },
      results: [{
        id: 1,
        story_id: 'ACC-009',
        status: 'pass',
        retries: 0,
        started_at: '2026-08-21T01:08:32.827Z',
        finished_at: '2026-08-21T02:00:38.159Z',
        elapsed_seconds: 3125,
        model_used: 'openai-codex/gpt-5.6-sol',
        worktree_path: '/workspace',
        worktree_branch: 'feat/acc',
      }],
      integrations: [],
      reviews: [],
      latestEvent: { event_type: 'run_finished', story_id: null },
    });

    expect(projection.activityStatus).toBe('blocked');
    expect(projection.stories).toMatchObject({ total: 2, passed: 1, failed: 0 });
  });

  test('separates a phase own gate state from predecessor waiting and blocking', () => {
    const upstream = phase({
      phaseId: 'requirements',
      status: 'awaiting_approval',
      gates: [gate('requirements-approval', 'requirements', 'awaiting_approval')],
    });
    const downstream = phase({
      phaseId: 'design',
      status: 'awaiting_approval',
      gates: [gate('architecture-review', 'design', 'not_started')],
      dependencies: ['gate:requirements-approval', 'gate:architecture-review'],
    });
    const evaluation = { phases: [upstream, downstream] } as unknown as LifecycleEvaluation;

    expect(projectLifecyclePhaseStatuses(evaluation, downstream)).toEqual({
      ownStatus: 'not_started',
      dependencyStatus: 'waiting',
    });

    upstream.gates[0]!.status = 'blocked';
    expect(projectLifecyclePhaseStatuses(evaluation, downstream).dependencyStatus).toBe('blocked');
  });

  test('counts unique active unresolved approval gates instead of propagated phase waits', () => {
    const policyGate = gate('requirements-approval', 'requirements', 'awaiting_approval');
    const humanGate = gate('security-approval', 'testing', 'awaiting_approval');
    const evaluation = {
      phases: [
        phase({ phaseId: 'requirements', status: 'awaiting_approval', gates: [policyGate] }),
        phase({ phaseId: 'design', status: 'awaiting_approval', gates: [] }),
        phase({ phaseId: 'testing', status: 'awaiting_approval', gates: [humanGate, humanGate] }),
      ],
    } as unknown as LifecycleEvaluation;
    const plan = {
      gates: [
        { gateId: 'requirements-approval', approvalRequirement: 'policy' },
        { gateId: 'security-approval', approvalRequirement: 'human' },
      ],
    } as unknown as Pick<LifecyclePlan, 'gates'>;

    expect(pendingLifecycleApprovalGates(plan, evaluation)).toEqual({
      policyGateIds: ['requirements-approval'],
      humanGateIds: ['security-approval'],
      total: 2,
    });
  });
});
