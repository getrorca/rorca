/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockExecute = jest.fn();
const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockStageCandidate = jest.fn();
const mockCreateEvidence = jest.fn((input: unknown) => input);
const mockPersistEvidence = jest.fn();

jest.mock('../../db/index', () => ({
  execute: (...args: unknown[]) => mockExecute(...args),
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));
jest.mock('../context-distillation', () => ({
  stageGovernedMemoryCandidate: (...args: unknown[]) => mockStageCandidate(...args),
}));
jest.mock('../llm-client', () => ({ chatComplete: jest.fn() }));
jest.mock('../ssdlc-evidence', () => ({
  createCanonicalEvidence: (input: unknown) => mockCreateEvidence(input),
  persistCanonicalEvidence: (...args: unknown[]) => mockPersistEvidence(...args),
}));
jest.mock('../workflow-config-resolver', () => ({ resolveWorkflowConfig: jest.fn() }));

import { MAINTENANCE_OUTCOME_GATE_ID } from '../ssdlc-contracts';
import { generateLearnCloseoutCandidates } from '../learn-closeout';

const commitSha = 'a'.repeat(40);
const payloadHash = 'f'.repeat(64);

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute.mockResolvedValue(1);
  mockStageCandidate.mockResolvedValue({ candidateId: 91, inserted: true });
  mockPersistEvidence.mockResolvedValue(undefined);
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return {
      id: 42,
      workspace_id: 'workspace-maintenance',
      spec_path: 'specs/release-closeout.json',
      status: 'done',
      retried_from_run_id: null,
      merge_status: 'merged',
      merge_commit_sha: commitSha,
      pr_number: 17,
      finished_at: '2026-08-17T12:00:00.000Z',
    };
    if (sql.includes('FROM ssdlc_compiled_plans')) return {
      plan_json: {
        inputHash: `sha256:${'1'.repeat(64)}`,
        gates: [{ phaseId: 'maintenance', gateId: MAINTENANCE_OUTCOME_GATE_ID }],
      },
    };
    if (sql.includes('FROM pipeline_retry_previews')) return undefined;
    throw new Error(`Unexpected queryOne: ${sql}`);
  });
  mockQuery.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM ssdlc_lifecycle_evidence')) return [{
      id: '101', story_id: 'STORY-1', classification: 'test_result', evidence_status: 'passed',
      trust_level: 'host_observed', source_type: 'ci', source_system: 'rorca-host',
      subject_type: 'commit_sha', subject_value: commitSha,
      phase_subject_type: 'commit_sha', phase_subject_value: commitSha,
      release_identity: {}, payload_hash: payloadHash, revision_mismatch: false,
    }];
    if (sql.includes('FROM story_closeout_decisions')) return [{
      decision_id: 'closeout-1', story_id: 'STORY-1', status: 'accepted',
      payload: { normalizedEvidenceReferences: [`EVD-sha256:${payloadHash}`] },
    }];
    if (sql.includes('FROM ssdlc_decisions')) return [];
    throw new Error(`Unexpected query: ${sql}`);
  });
});

test('persists closeout evidence against the canonical maintenance outcome gate', async () => {
  const result = await generateLearnCloseoutCandidates({
    workspaceId: 'workspace-maintenance',
    runId: 42,
    specId: 'release-closeout',
  });

  expect(result.status).toBe('generated');
  expect(mockCreateEvidence).toHaveBeenCalledWith(expect.objectContaining({
    sourceType: 'memory_closeout',
    scope: expect.objectContaining({
      phaseId: 'maintenance',
      gateId: MAINTENANCE_OUTCOME_GATE_ID,
    }),
    classification: 'memory_closeout',
    sourceEventId: expect.stringContaining('learn-closeout:v2:'),
    details: expect.objectContaining({
      reviewableCandidateCount: 1,
      authoritativeEvidenceCount: 1,
    }),
  }));
  expect(mockPersistEvidence).toHaveBeenCalledTimes(1);
});
