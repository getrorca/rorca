/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({
  execute: jest.fn(),
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { execute, query, queryOne } from '../../db/index';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import {
  appendEvidence,
  createCompiledPlan,
  createDecision,
  getCompiledPlanVersion,
  getCurrentPlan,
  getPhaseDetail,
  revokeDecision,
  type AppendEvidenceInput,
} from '../ssdlc-store';

const mockExecute = execute as jest.MockedFunction<typeof execute>;
const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;

const now = new Date('2026-07-14T16:00:00.000Z');

function planRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '11',
    workspace_id: 'ws-a',
    spec_slug: 'safe-delivery',
    spec_version: '2',
    compiler_version: 'compiler-1',
    normalized_input_hash: 'input-hash',
    schema_version: 'plan.v1',
    plan_json: { phases: [] },
    validation_status: 'validated',
    is_current: false,
    created_at: now,
    validated_at: now,
    updated_at: now,
    ...overrides,
  };
}

function evidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '21',
    workspace_id: 'ws-a',
    spec_slug: 'safe-delivery',
    spec_version: '2',
    revision: 'r2',
    run_id: 7,
    story_id: 'LFC-002',
    phase_id: 'verify',
    gate_id: 'qa',
    evidence_type: 'test_report',
    subject_type: 'commit_sha',
    subject_value: 'abc123',
    source_system: 'github',
    source_idempotency_key: 'check-run-42',
    payload_hash: 'set-by-test',
    metadata: { passed: true },
    provenance: { githubCheckRunId: '42' },
    source_ref: 'run-output-chunks:7',
    observed_at: now,
    created_at: now,
    ...overrides,
  };
}

function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '31',
    workspace_id: 'ws-a',
    spec_slug: 'safe-delivery',
    spec_version: '2',
    revision: 'r2',
    run_id: 7,
    story_id: 'LFC-002',
    phase_id: 'verify',
    gate_id: 'qa',
    decision_type: 'qa_approval',
    actor: 'reviewer@rorca.local',
    rationale: 'QA evidence is complete',
    scope: { environment: 'staging' },
    provenance: { hermesDecisionId: 'hermes-9' },
    created_at: now,
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    revocation_rationale: null,
    ...overrides,
  };
}

const evidenceInput: AppendEvidenceInput = {
  workspaceId: 'ws-a',
  specSlug: 'safe-delivery',
  specVersion: 2,
  revision: 'r2',
  runId: 7,
  storyId: 'LFC-002',
  phaseId: 'verify',
  gateId: 'qa',
  evidenceType: 'test_report',
  subjectType: 'commit_sha',
  subjectValue: 'abc123',
  sourceSystem: 'github',
  sourceIdempotencyKey: 'check-run-42',
  metadata: { passed: true },
  provenance: { githubCheckRunId: '42' },
  sourceRef: 'run-output-chunks:7',
  observedAt: now,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('compiled plans', () => {
  test('persists and selects a validated plan with workspace-scoped numbered SQL', async () => {
    mockQueryOne
      .mockResolvedValueOnce(planRow() as never)
      .mockResolvedValueOnce(planRow({ is_current: true }) as never);

    const result = await createCompiledPlan({
      workspaceId: 'ws-a',
      specSlug: 'safe-delivery',
      specVersion: 2,
      compilerVersion: 'compiler-1',
      normalizedInputHash: 'input-hash',
      schemaVersion: 'plan.v1',
      plan: '{"phases":[]}',
      validationStatus: 'validated',
    });

    expect(result.lifecycleState).toBe('current');
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
    for (const [sql, params] of mockQueryOne.mock.calls) {
      expect(sql).toContain('workspace_id');
      expect(sql).toMatch(/\$1/);
      expect(params?.[0]).toBe('ws-a');
      expect(sql).not.toMatch(/\?(?:\s|,|\))/);
    }
  });

  test('failed compilation remains inspectable and cannot replace current selection', async () => {
    mockQueryOne.mockResolvedValueOnce(planRow({
      id: '12',
      validation_status: 'failed',
      validated_at: null,
    }) as never);

    const result = await createCompiledPlan({
      workspaceId: 'ws-a',
      specSlug: 'safe-delivery',
      specVersion: 3,
      compilerVersion: 'compiler-1',
      normalizedInputHash: 'failed-hash',
      schemaVersion: 'plan.v1',
      plan: { failure: { code: 'INVALID_GATE' } },
      validationStatus: 'failed',
    });

    expect(result.lifecycleState).toBe('failed');
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockQueryOne.mock.calls[0][0]).not.toContain('SET is_current = TRUE');
  });

  test('does not reselect an old superseded plan on idempotent replay', async () => {
    mockQueryOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(planRow({ is_current: false }) as never)
      .mockResolvedValueOnce({ id: 'newer-plan' } as never);

    const result = await createCompiledPlan({
      workspaceId: 'ws-a',
      specSlug: 'safe-delivery',
      specVersion: 2,
      compilerVersion: 'compiler-1',
      normalizedInputHash: 'input-hash',
      schemaVersion: 'plan.v1',
      plan: { phases: [] },
      validationStatus: 'validated',
    });

    expect(result.lifecycleState).toBe('superseded');
    expect(mockQueryOne).toHaveBeenCalledTimes(3);
  });

  test('missing plan versions and cross-workspace current reads are typed not-found errors', async () => {
    mockQueryOne.mockResolvedValue(undefined);

    await expect(getCompiledPlanVersion('ws-b', 'safe-delivery', 99)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getCurrentPlan('ws-b', 'safe-delivery')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockQueryOne.mock.calls.every(([, params]) => params?.[0] === 'ws-b')).toBe(true);
  });

  test('malformed plan JSON is a typed validation error before database access', async () => {
    await expect(createCompiledPlan({
      workspaceId: 'ws-a',
      specSlug: 'safe-delivery',
      specVersion: 2,
      compilerVersion: 'compiler-1',
      normalizedInputHash: 'input-hash',
      schemaVersion: 'plan.v1',
      plan: '{broken',
      validationStatus: 'validated',
    })).rejects.toBeInstanceOf(ValidationError);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});

describe('append-only evidence', () => {
  test('rejects an exact duplicate replay with ConflictError', async () => {
    mockQueryOne
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async (_sql, params) => evidenceRow({ payload_hash: params?.[13] }) as never);

    const inserted = await appendEvidence(evidenceInput);
    jest.clearAllMocks();
    mockQueryOne.mockResolvedValueOnce(evidenceRow({ payload_hash: inserted.payloadHash }) as never);

    await expect(appendEvidence(evidenceInput)).rejects.toBeInstanceOf(ConflictError);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('records a source-id payload conflict in WAL before returning ConflictError', async () => {
    mockQueryOne
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async (_sql, params) => evidenceRow({ payload_hash: params?.[13] }) as never);
    const inserted = await appendEvidence(evidenceInput);

    jest.clearAllMocks();
    mockQueryOne.mockResolvedValueOnce(evidenceRow({ payload_hash: inserted.payloadHash }) as never);
    mockExecute.mockResolvedValue({ rowCount: 1 });

    await expect(appendEvidence({ ...evidenceInput, metadata: { passed: false } }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][0]).toContain('INSERT INTO wal_events');
    expect(mockExecute.mock.calls[0][0]).toContain('WHERE w.id = $1');
  });

  test('rejects malformed normalized metadata before database access', async () => {
    await expect(appendEvidence({ ...evidenceInput, metadata: '[1,2]' }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});

describe('governed decisions and derived phase state', () => {
  test('persists decision scope/provenance as JSON references with workspace isolation', async () => {
    mockQueryOne.mockResolvedValueOnce(decisionRow() as never);

    const decision = await createDecision({
      workspaceId: 'ws-a',
      specSlug: 'safe-delivery',
      specVersion: 2,
      runId: 7,
      phaseId: 'verify',
      gateId: 'qa',
      decisionType: 'qa_approval',
      actor: 'reviewer@rorca.local',
      rationale: 'QA evidence is complete',
      scope: { environment: 'staging' },
      provenance: { githubCheckRunId: '42', hermesDecisionId: 'hermes-9' },
    });

    expect(decision.decisionType).toBe('qa_approval');
    expect(mockQueryOne.mock.calls[0][0]).toContain('pr.workspace_id = $1');
    expect(mockQueryOne.mock.calls[0][1]?.[0]).toBe('ws-a');
  });

  test('revocation is one-way and duplicate revocation returns ConflictError', async () => {
    mockQueryOne
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: '31', revoked_at: now } as never);

    await expect(revokeDecision('ws-a', '31', 'lead', 'Approval invalidated'))
      .rejects.toBeInstanceOf(ConflictError);
    expect(mockQueryOne.mock.calls[0][0]).toContain('WHERE workspace_id = $1');
    expect(mockQueryOne.mock.calls[0][0]).toContain('revoked_at IS NULL');
  });

  test('cross-workspace revocation is a typed not-found error', async () => {
    mockQueryOne.mockResolvedValue(undefined);
    await expect(revokeDecision('ws-b', '31', 'lead', 'Not in this workspace'))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(mockQueryOne.mock.calls.every(([, params]) => params?.[0] === 'ws-b')).toBe(true);
  });

  test('derives deferred phase state from evidence and active decisions', async () => {
    mockQuery
      .mockResolvedValueOnce([evidenceRow()] as never)
      .mockResolvedValueOnce([decisionRow({ decision_type: 'defer' })] as never);

    const detail = await getPhaseDetail('ws-a', 'safe-delivery', 'verify');

    expect(detail.state).toBe('deferred');
    expect(detail.evidence).toHaveLength(1);
    expect(detail.activeDecisions).toHaveLength(1);
    expect(mockQuery.mock.calls.every(([sql, params]) => sql.includes('workspace_id = $1') && params?.[0] === 'ws-a')).toBe(true);
  });
});
