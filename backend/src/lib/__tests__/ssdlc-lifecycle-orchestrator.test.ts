/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { normalizeSsdlcContractJson } from '../ssdlc-contracts';

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockGetLifecyclePhase = jest.fn();
const mockGetLifecycleSpec = jest.fn();
const mockProjectCurrentLifecyclePlanEvidence = jest.fn();
const mockProjectLifecycleEvidenceForRun = jest.fn();
const mockPreviewPreStagingQualification = jest.fn();
const mockRunPreStagingQualification = jest.fn();
const mockPreviewLifecycleReconciliation = jest.fn();
const mockApplyLifecycleReconciliation = jest.fn();
const mockBossSend = jest.fn();
const mockBossWork = jest.fn();
const mockGetBoss = jest.fn(() => ({ send: mockBossSend, work: mockBossWork }));

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

jest.mock('../ssdlc-lifecycle-read', () => ({
  getLifecyclePhase: (...args: unknown[]) => mockGetLifecyclePhase(...args),
  getLifecycleSpec: (...args: unknown[]) => mockGetLifecycleSpec(...args),
}));

jest.mock('../run-lifecycle-projection', () => ({
  projectCurrentLifecyclePlanEvidence: (...args: unknown[]) =>
    mockProjectCurrentLifecyclePlanEvidence(...args),
  projectLifecycleEvidenceForRun: (...args: unknown[]) =>
    mockProjectLifecycleEvidenceForRun(...args),
}));

jest.mock('../pre-staging-qualification', () => ({
  previewPreStagingQualification: (...args: unknown[]) =>
    mockPreviewPreStagingQualification(...args),
  runPreStagingQualification: (...args: unknown[]) =>
    mockRunPreStagingQualification(...args),
}));

jest.mock('../lifecycle-reconciliation', () => ({
  previewLifecycleReconciliation: (...args: unknown[]) =>
    mockPreviewLifecycleReconciliation(...args),
  applyLifecycleReconciliation: (...args: unknown[]) =>
    mockApplyLifecycleReconciliation(...args),
}));

jest.mock('../pg-boss', () => ({
  getBoss: () => mockGetBoss(),
}));

import {
  EVALUATOR_PLAN,
} from './fixtures/ssdlc-phase-evaluator.fixtures';
import {
  advanceCurrentLifecyclePolicyGates,
  assertLifecycleDispatchReady,
  enqueueLifecycleAssuranceForRun,
  handleLifecycleAssurance,
  recoverRecentLifecycleAssurancePublications,
  registerLifecycleAssuranceWorker,
} from '../ssdlc-lifecycle-orchestrator';

const WORKSPACE_ID = 'workspace-evaluator';
const SPEC_ID = 'fixture-phase-evaluator';
const COMPILED_PLAN_ID = '41';
const CANONICAL_SPEC = {};
const CANONICAL_SPEC_HASH =
  `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(CANONICAL_SPEC), 'utf8').digest('hex')}`;


const planRow = {
  id: COMPILED_PLAN_ID,
  spec_version: '17',
  compiler_version: EVALUATOR_PLAN.compilerVersion,
  validation_status: 'validated',
  is_current: true,
  plan_json: EVALUATOR_PLAN,
  provenance_json: { specHash: CANONICAL_SPEC_HASH },
};

const ASSURANCE_IDENTITY = {
  workspaceId: WORKSPACE_ID,
  runId: 947,
  specRevision: CANONICAL_SPEC_HASH,
  planId: EVALUATOR_PLAN.planId,
  compiledPlanId: COMPILED_PLAN_ID,
};

function terminalRun(identity = ASSURANCE_IDENTITY) {
  return {
    id: identity.runId,
    workspace_id: identity.workspaceId,
    spec_path: `forge/specs/approved/${SPEC_ID}.json`,
    status: 'done',
    canonical_spec_revision: identity.specRevision,
    terminal_checkout_sha: 'a'.repeat(40),
    terminal_checkout_attested_at: '2026-07-15T12:00:00.000Z',
    trigger_options: {
      lifecycleAssuranceIdentity: identity,
      lifecycleDispatchClaim: {
        schemaVersion: 'lifecycle-dispatch-claim.v1',
        claimId: '725e0938-8489-49e9-8688-16f892ae8708',
        workspaceId: identity.workspaceId,
        specId: SPEC_ID,
        specHash: identity.specRevision,
        compiledPlanId: identity.compiledPlanId,
        requestIdentity: 'request-identity',
        requestHash: `sha256:${'d'.repeat(64)}`,
      },
    },
  };
}

function phaseDetail(phaseId: string) {
  const gates = EVALUATOR_PLAN.gates.filter((gate) => gate.phaseId === phaseId);
  return {
    requiredGates: {
      items: gates.map((gate) => ({
        gateId: gate.gateId,
        evaluation: {
          status: gate.approvalRequirement === 'none' ? 'passed' : 'awaiting_approval',
        },
      })),
    },
    evidence: {
      items: gates
        .filter((gate) => gate.subjectRevisionRequirement === 'current_spec_revision')
        .map((gate) => ({
          gateId: gate.gateId,
          status: 'passed',
          currentRevision: true,
          subject: { type: 'spec_hash', value: CANONICAL_SPEC_HASH },
        })),
    },
    blocker: null,
    nextSafeAction: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  let decisionId = 0;
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    if (sql.includes('INSERT INTO ssdlc_decisions')) return { id: String(++decisionId) };
    if (sql.includes('FROM ssdlc_reconciliation_receipts')) return undefined;
    return undefined;
  });
  mockGetLifecyclePhase.mockImplementation(async (input: { phaseId: string }) =>
    phaseDetail(input.phaseId));
  mockGetLifecycleSpec.mockResolvedValue({
    state: 'current',
    stale: false,
    plan: { databaseId: COMPILED_PLAN_ID },
    phaseTimeline: ['planning', 'requirements', 'design'].map((phaseId) => ({
      phaseId,
      status: 'passed',
      disposition: 'required',
    })),
  });
  mockProjectCurrentLifecyclePlanEvidence.mockResolvedValue({
    workspaceId: WORKSPACE_ID,
    specSlug: SPEC_ID,
    compiledPlanId: COMPILED_PLAN_ID,
    specHash: CANONICAL_SPEC_HASH,
    status: 'projected',
    reason: null,
    persisted: 1,
    replayed: 0,
  });
  mockBossSend.mockResolvedValue('f04df3c4-8cf3-4c2a-8c34-40accf18bd83');
});

test('dispatch projects exact current evidence and auto-advances only policy gates', async () => {
  const result = await assertLifecycleDispatchReady({
    workspaceId: WORKSPACE_ID,
    specId: SPEC_ID,
    canonicalSpec: CANONICAL_SPEC,
  });

  expect(result.compiledPlanId).toBe(COMPILED_PLAN_ID);
  expect(result.specHash).toBe(CANONICAL_SPEC_HASH);
  expect(mockProjectCurrentLifecyclePlanEvidence).toHaveBeenCalledWith({
    workspaceId: WORKSPACE_ID,
    specId: SPEC_ID,
  });

  const persistedGateIds = mockQueryOne.mock.calls
    .filter(([sql]) => String(sql).includes('INSERT INTO ssdlc_decisions'))
    .map(([, parameters]) => (parameters as readonly unknown[])[5]);
  const eligiblePolicyGateIds = EVALUATOR_PLAN.gates
    .filter((gate) => gate.approvalRequirement === 'policy'
      && gate.subjectRevisionRequirement === 'current_spec_revision')
    .map((gate) => gate.gateId)
    .sort();

  expect(persistedGateIds.sort()).toEqual(eligiblePolicyGateIds);
  expect(persistedGateIds.length).toBeGreaterThan(0);
  expect(EVALUATOR_PLAN.gates
    .filter((gate) => gate.approvalRequirement === 'human')
    .some((gate) => persistedGateIds.includes(gate.gateId))).toBe(false);
});

test('policy advancement replaces stale approvals when current exact-subject evidence remains valid', async () => {
  mockGetLifecyclePhase.mockImplementation(async (input: { phaseId: string }) => {
    const detail = phaseDetail(input.phaseId);
    return {
      ...detail,
      requiredGates: {
        items: detail.requiredGates.items.map((gate) => ({
          ...gate,
          evaluation: {
            status: gate.evaluation.status === 'awaiting_approval' ? 'stale' : gate.evaluation.status,
          },
        })),
      },
    };
  });

  const result = await advanceCurrentLifecyclePolicyGates({
    workspaceId: WORKSPACE_ID,
    specId: SPEC_ID,
  });
  const persistedGateIds = mockQueryOne.mock.calls
    .filter(([sql]) => String(sql).includes('INSERT INTO ssdlc_decisions'))
    .map(([, parameters]) => (parameters as readonly unknown[])[5]);
  const eligiblePolicyGateIds = EVALUATOR_PLAN.gates
    .filter((gate) => gate.approvalRequirement === 'policy'
      && gate.subjectRevisionRequirement === 'current_spec_revision')
    .map((gate) => gate.gateId)
    .sort();

  expect(result.created).toBe(eligiblePolicyGateIds.length);
  expect(persistedGateIds.sort()).toEqual(eligiblePolicyGateIds);
});

test('policy advancement mints a reconciled plan-bound generation when the replay row predates compiled-plan binding', async () => {
  mockGetLifecyclePhase.mockImplementation(async (input: { phaseId: string }) => {
    const detail = phaseDetail(input.phaseId);
    return {
      ...detail,
      requiredGates: {
        items: detail.requiredGates.items.map((gate) => ({
          ...gate,
          evaluation: {
            status: gate.evaluation.status === 'awaiting_approval' ? 'stale' : gate.evaluation.status,
          },
        })),
      },
    };
  });

  // Compute the exact request_hash the implementation digests so the replay row
  // hash-matches and the reconciliation path (not the conflict throw) is taken.
  const expectedHashes = new Map<string, string>();
  for (const gate of EVALUATOR_PLAN.gates.filter((gate) => gate.approvalRequirement === 'policy')) {
    const policyReference = [EVALUATOR_PLAN.policyVersion, EVALUATOR_PLAN.planId, COMPILED_PLAN_ID, EVALUATOR_PLAN.inputHash, gate.gateId].join(':');
    const requestHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
      workspaceId: WORKSPACE_ID, specId: SPEC_ID, specVersion: planRow.spec_version,
      runId: null, phaseId: gate.phaseId, gateId: gate.gateId,
      subject: { type: 'spec_hash', value: CANONICAL_SPEC_HASH },
      policyVersion: EVALUATOR_PLAN.policyVersion, policyReference,
      compilerVersion: EVALUATOR_PLAN.compilerVersion, verifier: 'lifecycle-policy-verifier',
    }), 'utf8').digest('hex')}`;
    expectedHashes.set(gate.gateId, requestHash);
  }

  // The historical policy approval occupies the canonical source_request_id but
  // was written before the compiled-plan identity columns existed, so it replays
  // with a matching hash while compiled_plan_id/plan_id stay NULL. Simulate the
  // ON CONFLICT DO NOTHING insert returning no row, the unbound replay row, and
  // a successful reconciled-generation insert.
  mockQueryOne.mockImplementation(async (sqlValue: unknown, parameters?: readonly unknown[]) => {
    const sql = String(sqlValue);
    if (sql.includes('INSERT INTO ssdlc_decisions')) {
      // canonical key is occupied (conflict → no row); reconciled key inserts.
      const sourceRequestId = String((parameters as readonly unknown[])[12] ?? '');
      return sourceRequestId.endsWith(':reconciled') ? { id: 'reconciled-decision' } : undefined;
    }
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    if (sql.includes('FROM ssdlc_decisions')) {
      // replay lookup: WHERE workspace_id=$1 AND source_request_id=$2
      const sourceRequestId = String(parameters?.[1] ?? '');
      const gateId = sourceRequestId.split(':')[2] ?? '';
      return {
        request_hash: expectedHashes.get(gateId) ?? 'sha256:missing',
        compiled_plan_id: null,
        plan_id: null,
      };
    }
    return undefined;
  });

  const result = await advanceCurrentLifecyclePolicyGates({
    workspaceId: WORKSPACE_ID,
    specId: SPEC_ID,
  });

  const reconciledRequests = mockQueryOne.mock.calls
    .filter(([sql]) => String(sql).includes('INSERT INTO ssdlc_decisions'))
    .map(([, parameters]) => String((parameters as readonly unknown[])[12]))
    .filter((key) => key.endsWith(':reconciled'));
  const reconciledGateIds = reconciledRequests.map((key) => key.split(':')[2]).sort();
  const eligiblePolicyGateIds = EVALUATOR_PLAN.gates
    .filter((gate) => gate.approvalRequirement === 'policy'
      && gate.subjectRevisionRequirement === 'current_spec_revision')
    .map((gate) => gate.gateId)
    .sort();
  expect(reconciledGateIds).toEqual(eligiblePolicyGateIds);
  expect(result.created).toBe(eligiblePolicyGateIds.length);
});

test('dispatch fails closed with the exact blocked phase and safe action', async () => {
  mockGetLifecycleSpec.mockResolvedValueOnce({
    state: 'current',
    stale: false,
    plan: { databaseId: COMPILED_PLAN_ID },
    phaseTimeline: [
      { phaseId: 'planning', status: 'passed', disposition: 'required' },
      { phaseId: 'requirements', status: 'blocked', disposition: 'required' },
      { phaseId: 'design', status: 'not_started', disposition: 'required' },
    ],
  });
  mockGetLifecyclePhase.mockImplementation(async (input: { phaseId: string }) => ({
    ...phaseDetail(input.phaseId),
    blocker: { gateId: `blocked-${input.phaseId}` },
    nextSafeAction: { code: 'supply-current-evidence' },
  }));

  await expect(assertLifecycleDispatchReady({
    workspaceId: WORKSPACE_ID,
    specId: SPEC_ID,
    canonicalSpec: CANONICAL_SPEC,
  }))
    .rejects.toMatchObject({
      code: 'LIFECYCLE_PRE_EXECUTION_BLOCKED',
      details: {
        blockedPhases: expect.arrayContaining([
          expect.objectContaining({
            phaseId: 'requirements',
            status: 'blocked',
            nextSafeAction: { code: 'supply-current-evidence' },
          }),
        ]),
      },
    });
});

test('dispatch rejects canonical bytes that do not match the compiled plan revision', async () => {
  await expect(assertLifecycleDispatchReady({
    workspaceId: WORKSPACE_ID,
    specId: SPEC_ID,
    canonicalSpec: { changed: true },
  })).rejects.toMatchObject({
    code: 'LIFECYCLE_PLAN_STALE',
    details: {
      compiledSpecHash: CANONICAL_SPEC_HASH,
    },
  });
  expect(mockProjectCurrentLifecyclePlanEvidence).not.toHaveBeenCalled();
});

test('trusted terminal publication is exact and an existing reconciliation receipt suppresses replay', async () => {
  const run = terminalRun();
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return run;
    if (sql.includes('UPDATE pipeline_runs')) return { id: '947' };
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    if (sql.includes('FROM ssdlc_reconciliation_receipts')) return undefined;
    return undefined;
  });

  await expect(enqueueLifecycleAssuranceForRun({ workspaceId: WORKSPACE_ID, runId: 947 }))
    .resolves.toMatchObject({ status: 'queued', reason: 'trusted_run_completion' });
  expect(mockBossSend).toHaveBeenCalledWith(
    'pipeline:lifecycle-assurance',
    ASSURANCE_IDENTITY,
    expect.objectContaining({ retryLimit: 5, retryBackoff: true }),
  );
  const durableClaim = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('UPDATE pipeline_runs'));
  expect(JSON.parse(String((durableClaim?.[1] as readonly unknown[])[2]))).toEqual(ASSURANCE_IDENTITY);

  mockBossSend.mockClear();
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return run;
    if (sql.includes('UPDATE pipeline_runs')) return { id: '947' };
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    if (sql.includes('FROM ssdlc_reconciliation_receipts')) return { id: 'receipt-1' };
  });
  await expect(enqueueLifecycleAssuranceForRun({ workspaceId: WORKSPACE_ID, runId: 947 }))
    .resolves.toMatchObject({ status: 'complete', reason: 'assurance_receipt_exists' });
  expect(mockBossSend).not.toHaveBeenCalled();
});

test('queued identity mismatch is classified before any assurance side effect', async () => {
  const staleIdentity = { ...ASSURANCE_IDENTITY, planId: `plan-${'f'.repeat(64)}` };
  const run = terminalRun(staleIdentity);
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return run;
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    return undefined;
  });

  await expect(handleLifecycleAssurance(staleIdentity))
    .rejects.toMatchObject({ code: 'LIFECYCLE_ASSURANCE_IDENTITY_MISMATCH' });
  expect(mockProjectLifecycleEvidenceForRun).not.toHaveBeenCalled();
  expect(mockRunPreStagingQualification).not.toHaveBeenCalled();
  expect(mockApplyLifecycleReconciliation).not.toHaveBeenCalled();
});

test('valid assurance jobs project the exact queued plan and bind receipts to the full identity', async () => {
  const run = terminalRun();
  let decisionId = 0;
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return run;
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    if (sql.includes('INSERT INTO ssdlc_decisions')) return { id: String(++decisionId) };
    return undefined;
  });
  mockProjectLifecycleEvidenceForRun.mockResolvedValue({
    runId: ASSURANCE_IDENTITY.runId,
    workspaceId: WORKSPACE_ID,
    specSlug: SPEC_ID,
    status: 'projected',
    reason: null,
    persisted: 4,
    replayed: 0,
  });
  mockPreviewPreStagingQualification.mockResolvedValue({
    runId: ASSURANCE_IDENTITY.runId,
    specRevisionHash: ASSURANCE_IDENTITY.specRevision,
    planId: ASSURANCE_IDENTITY.planId,
    compiledPlanId: ASSURANCE_IDENTITY.compiledPlanId,
    previewHash: `sha256:${'b'.repeat(64)}`,
  });
  mockRunPreStagingQualification.mockResolvedValue({ id: 'qualification-1' });
  mockPreviewLifecycleReconciliation.mockResolvedValue({
    specRevisionHash: ASSURANCE_IDENTITY.specRevision,
    compiledPlanId: ASSURANCE_IDENTITY.compiledPlanId,
    previewHash: `sha256:${'c'.repeat(64)}`,
  });
  mockApplyLifecycleReconciliation.mockResolvedValue({ id: 'reconciliation-1' });

  await expect(handleLifecycleAssurance(ASSURANCE_IDENTITY)).resolves.toMatchObject(ASSURANCE_IDENTITY);
  expect(mockProjectLifecycleEvidenceForRun).toHaveBeenCalledWith({
    workspaceId: WORKSPACE_ID,
    specRevision: ASSURANCE_IDENTITY.specRevision,
    planId: ASSURANCE_IDENTITY.planId,
    runId: ASSURANCE_IDENTITY.runId,
    compiledPlanId: COMPILED_PLAN_ID,
  });
  const suffix = crypto.createHash('sha256').update(JSON.stringify(ASSURANCE_IDENTITY), 'utf8').digest('hex');
  expect(mockRunPreStagingQualification).toHaveBeenCalledWith(expect.objectContaining({
    idempotencyKey: `lifecycle-assurance:${ASSURANCE_IDENTITY.runId}:${suffix}:qualification`,
  }));
  expect(mockApplyLifecycleReconciliation).toHaveBeenCalledWith(expect.objectContaining({
    idempotencyKey: `lifecycle-assurance:${ASSURANCE_IDENTITY.runId}:${suffix}:reconciliation`,
  }));
});

test('worker rejects non-strict assurance payloads before loading run or plan state', async () => {
  let handler: ((jobs: Array<{ data: unknown }>) => Promise<void>) | undefined;
  mockBossWork.mockImplementation(async (
    _queue: unknown,
    _options: unknown,
    callback: (jobs: Array<{ data: unknown }>) => Promise<void>,
  ) => { handler = callback; });
  await registerLifecycleAssuranceWorker({ work: mockBossWork } as never);

  await expect(handler!([{ data: { ...ASSURANCE_IDENTITY, unexpected: true } }]))
    .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  expect(mockQueryOne).not.toHaveBeenCalled();
  expect(mockProjectLifecycleEvidenceForRun).not.toHaveBeenCalled();
});

test('failed worker attempts durably release the exact publication for later recovery', async () => {
  const run = terminalRun();
  let handler: ((jobs: Array<{ id: string; data: unknown }>) => Promise<void>) | undefined;
  mockBossWork.mockImplementation(async (
    _queue: unknown,
    _options: unknown,
    callback: (jobs: Array<{ id: string; data: unknown }>) => Promise<void>,
  ) => { handler = callback; });
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return run;
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    if (sql.includes('UPDATE pipeline_runs')) return { id: String(run.id) };
    return undefined;
  });
  mockProjectLifecycleEvidenceForRun.mockRejectedValueOnce(new Error('projection unavailable'));
  await registerLifecycleAssuranceWorker({ work: mockBossWork } as never);

  await expect(handler!([{ id: 'job-failed', data: ASSURANCE_IDENTITY }]))
    .rejects.toThrow('projection unavailable');
  expect(mockQueryOne.mock.calls).toContainEqual([
    expect.stringContaining("'{lifecycleAssurancePublication}'"),
    expect.arrayContaining(['failed', 'job-failed', 'projection unavailable']),
  ]);
});

test('recovery republishes only the exact durable current assurance identity', async () => {
  const run = terminalRun();
  mockQuery.mockResolvedValue([{ id: run.id, workspace_id: run.workspace_id }]);
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return run;
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    if (sql.includes('UPDATE pipeline_runs')) return { id: String(run.id) };
    if (sql.includes('FROM ssdlc_reconciliation_receipts')) return undefined;
    return undefined;
  });

  await recoverRecentLifecycleAssurancePublications(20, { send: mockBossSend } as never);
  expect(mockBossSend).toHaveBeenCalledWith(
    'pipeline:lifecycle-assurance',
    ASSURANCE_IDENTITY,
    expect.objectContaining({ retryLimit: 5, retryBackoff: true }),
  );
  expect(mockBossSend.mock.calls[0]?.[2]).not.toHaveProperty('singletonKey');
  expect(mockBossSend.mock.calls[0]?.[2]).not.toHaveProperty('singletonSeconds');
});

test('an active durable publication lease suppresses duplicate queue sends without a time bucket', async () => {
  const run = terminalRun();
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return run;
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    if (sql.includes('FROM ssdlc_reconciliation_receipts')) return undefined;
    if (sql.includes("'{lifecycleAssuranceIdentity}'")) return { id: String(run.id) };
    if (sql.includes("'{lifecycleAssurancePublication}'") && sql.includes("'publishing'")) return undefined;
    return undefined;
  });

  await expect(enqueueLifecycleAssuranceForRun({ workspaceId: WORKSPACE_ID, runId: run.id }))
    .resolves.toMatchObject({ status: 'already_queued', reason: 'durable_publication_lease' });
  expect(mockBossSend).not.toHaveBeenCalled();
});

test('failed queue publication is durably retryable after its bounded lease', async () => {
  const run = terminalRun();
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return run;
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    if (sql.includes('FROM ssdlc_reconciliation_receipts')) return undefined;
    if (sql.includes('UPDATE pipeline_runs')) return { id: String(run.id) };
    return undefined;
  });
  mockBossSend.mockRejectedValueOnce(new Error('transport unavailable'));

  await expect(enqueueLifecycleAssuranceForRun({ workspaceId: WORKSPACE_ID, runId: run.id }))
    .rejects.toThrow('transport unavailable');
  expect(mockQueryOne.mock.calls).toContainEqual([
    expect.stringContaining("'{lifecycleAssurancePublication}'"),
    expect.arrayContaining(['failed', null, 'transport unavailable']),
  ]);
});

test('recovery never republishes an assurance job for a stale dispatch plan', async () => {
  const run = terminalRun();
  mockQuery.mockResolvedValue([{ id: run.id, workspace_id: run.workspace_id }]);
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return run;
    if (sql.includes('FROM ssdlc_compiled_plans')) return { ...planRow, is_current: false };
    return undefined;
  });

  await recoverRecentLifecycleAssurancePublications(20, { send: mockBossSend } as never);
  expect(mockBossSend).not.toHaveBeenCalled();
});

test('recovery filters completed leases before LIMIT so more than 100 newer completions cannot starve older due work', async () => {
  const dueRun = terminalRun();
  mockQuery.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    expect(sql.indexOf("IS DISTINCT FROM 'completed'")).toBeGreaterThan(-1);
    expect(sql.indexOf("IS DISTINCT FROM 'completed'")).toBeLessThan(sql.indexOf('LIMIT $1'));
    expect(sql).toContain("'leaseExpiresAt'");
    expect(sql).toContain('COALESCE(run.finished_at,run.started_at)');
    expect(sql).not.toContain('run.created_at');
    return [{ id: dueRun.id, workspace_id: dueRun.workspace_id }];
  });
  mockQueryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('FROM pipeline_runs')) return dueRun;
    if (sql.includes('FROM ssdlc_compiled_plans')) return planRow;
    if (sql.includes('FROM ssdlc_reconciliation_receipts')) return undefined;
    if (sql.includes('UPDATE pipeline_runs')) return { id: String(dueRun.id) };
    return undefined;
  });

  await recoverRecentLifecycleAssurancePublications(100, { send: mockBossSend } as never);
  expect(mockQuery).toHaveBeenCalledWith(
    expect.stringContaining("IS DISTINCT FROM 'completed'"),
    [100, null, Number.MAX_SAFE_INTEGER],
  );
  expect(mockBossSend).toHaveBeenCalledWith(
    'pipeline:lifecycle-assurance',
    ASSURANCE_IDENTITY,
    expect.any(Object),
  );
});

test('recovery drains every due page beyond the bounded batch size with a deterministic cursor', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: 1_000 - index,
    workspace_id: WORKSPACE_ID,
    recovery_order_at: `2026-07-15T12:${String(59 - Math.floor(index / 2)).padStart(2, '0')}:00.000Z`,
  }));
  const older = {
    id: 42,
    workspace_id: WORKSPACE_ID,
    recovery_order_at: '2026-07-14T12:00:00.000Z',
  };
  mockQuery.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([older]);
  mockQueryOne.mockResolvedValue(undefined);

  await recoverRecentLifecycleAssurancePublications(100, { send: mockBossSend } as never);
  expect(mockQuery).toHaveBeenNthCalledWith(1, expect.any(String), [100, null, Number.MAX_SAFE_INTEGER]);
  expect(mockQuery).toHaveBeenNthCalledWith(2, expect.any(String), [
    100,
    firstPage.at(-1)!.recovery_order_at,
    firstPage.at(-1)!.id,
  ]);
});

test('policy advancement rejects an invalid run identity without reading the plan', async () => {
  await expect(advanceCurrentLifecyclePolicyGates({
    workspaceId: WORKSPACE_ID,
    specId: SPEC_ID,
    runId: 0,
  })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  expect(mockQueryOne).not.toHaveBeenCalled();
});
