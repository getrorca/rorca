/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const mockGetJob = jest.fn();
const mockGetExactWorkflowRunForJob = jest.fn();
const mockQuery = jest.fn();
const mockTransaction = jest.fn();
const mockWithPgAdvisoryLock = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  transaction: (fn: (client: unknown) => Promise<unknown>) => mockTransaction(fn),
  withPgAdvisoryLock: (_key: string, operation: () => Promise<unknown>) => mockWithPgAdvisoryLock(operation),
}));
jest.mock('../../db/spec-jobs', () => ({
  getJob: (...args: unknown[]) => mockGetJob(...args),
}));
jest.mock('../spec-post-save-workflow', () => ({
  getExactWorkflowRunForJob: (...args: unknown[]) => mockGetExactWorkflowRunForJob(...args),
  getSpecPostSaveWorkflowJobMetadata: jest.fn(),
  withSpecPostSaveWorkflowFence: (_workspaceId: string,_specId: string,operation: () => Promise<unknown>) => mockWithPgAdvisoryLock(operation),
}));
jest.mock('../pg-boss-schema', () => ({ getPgBossSchemaSql: () => '"pgboss"' }));

const jobId = '340c973e-1829-4b9e-b7a0-1405a635d703';
const bossJobId = 'b1ed2642-d2bc-40df-b19b-10b9372b933a';
const policyHash = '8'.repeat(64);

function runRow() {
  return {
    id: 80, workspace_id: 'mission-waves', spec_id: 'wave-2', generation_log_id: 437,
    save_generation: 432, effective_policy_hash: policyHash,
    effective_policy: { version: 'v1', presetId: 'skill_first_strict', memory: 'synthesize', onFailure: 'fail' },
    idempotency_key: 'run-80', status: 'queued', source: 'repair', error_message: null,
    created_at: new Date(), updated_at: new Date(), finished_at: null,
  };
}

function stageRow(status = 'queued') {
  return {
    id: 800, run_id: 80, stage_key: 'memorySynthesis', requested: true, status,
    reason: 'durable_job_enqueued', job_id: jobId, boss_job_id: bossJobId,
    queue_name: 'spec:memory-synthesis', transport_schema: 'pgboss', error_message: null,
  };
}

function applicationJob(status = 'failed') {
  return {
    id: jobId, specId: 'wave-2', workspaceId: 'mission-waves', jobType: 'memory-synthesis',
    status, bossJobId, transportSchema: 'pgboss', saveGeneration: 432, progressCurrent: 0, progressTotal: 0,
    progressMessage: null,
    requestPayload: { origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 80, stage: 'memorySynthesis', saveGeneration: 432, transportSchema: 'pgboss' },
    resultPayload: status === 'completed' ? { arbitraryAuthority: 'must-not-be-used' } : null,
    errorMessage: status === 'failed' ? 'secret-bearing provider failure must not enter audit' : null,
    startedAt: new Date(), finishedAt: new Date(), createdAt: new Date(),
  };
}

function input() {
  return {
    workspaceId: 'mission-waves', specId: 'wave-2', workflowRunId: 80,
    stageKey: 'memorySynthesis' as const, applicationJobId: jobId,
    operationId: 'operator:wave2:run80:memory', source: 'operator' as const,
    actorId: 'local-admin', authorityClass: 'local_human_admin' as const,
  };
}

function fakeClient(options: {
  stageStatus?: string;
  jobStatus?: string;
  transportState?: string | null;
  transportLocation?: 'live' | 'archive';
  exactOk?: boolean;
  casWins?: boolean;
} = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const stage = stageRow(options.stageStatus ?? 'queued');
  const job = applicationJob(options.jobStatus ?? 'failed');
  mockGetJob.mockResolvedValue(job);
  mockGetExactWorkflowRunForJob.mockResolvedValue(options.exactOk === false
    ? { ok: false, reason: 'run_binding_mismatch' }
    : { ok: true, run: {
      id: 80, workspaceId: 'mission-waves', specId: 'wave-2', generationLogId: 437,
      saveGeneration: 432, effectivePolicyHash: policyHash, effectivePolicy: runRow().effective_policy,
    }, metadata: { stage: 'memorySynthesis', workflowRunId: 80, transportSchema: 'pgboss' }, stage });

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes("set_config('rorca.workspace_id'")) return { rows: [{ set_config: 'mission-waves' }] };
    if (sql.includes('FROM spec_post_save_reconciliation_operations')) return { rows: [] };
    if (sql.includes('INSERT INTO spec_post_save_reconciliation_operations')) return { rows: [] };
    if (sql.includes('FROM spec_post_save_workflow_runs WHERE id=$1 FOR UPDATE')) return { rows: [runRow()] };
    if (sql.includes('FROM spec_post_save_workflow_stages WHERE run_id=$1')) return { rows: [stage] };
    if (sql.includes('SELECT id FROM spec_jobs')) return { rows: [{ id: jobId }] };
    if (sql.includes('FROM "pgboss".job')) {
      if (options.transportState == null || options.transportLocation === 'archive') return { rows: [] };
      return { rows: [{ id: bossJobId, name: 'spec:memory-synthesis', state: options.transportState,
        data: { jobId, specId: 'wave-2', workspaceId: 'mission-waves' } }] };
    }
    if (sql.includes('FROM "pgboss".archive')) {
      if (options.transportState == null || options.transportLocation !== 'archive') return { rows: [] };
      return { rows: [{ id: bossJobId, name: 'spec:memory-synthesis', state: options.transportState,
        data: { jobId, specId: 'wave-2', workspaceId: 'mission-waves' } }] };
    }
    if (sql.includes('FROM spec_memory_synthesis_receipts receipt')) return { rows: [{ ok: true }] };
    if (sql.includes('UPDATE spec_post_save_workflow_stages')) {
      return { rows: options.casWins === false ? [] : [{ status: params[3] }] };
    }
    if (sql.includes('UPDATE spec_post_save_workflow_runs')) return { rows: [] };
    if (sql.includes('INSERT INTO spec_post_save_reconciliation_audit')) return { rows: [{ id: 901 }] };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { client: { query }, queries, job };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWithPgAdvisoryLock.mockImplementation(async (operation) => operation());
  mockTransaction.mockImplementation(async (fn) => fn(current.client));
});

let current: ReturnType<typeof fakeClient>;

describe('exact post-save workflow reconciliation', () => {
  test('repair and stage retry reconcile a stale exact active run before conflict rejection without broad supersession', () => {
    const specsSource = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'specs.ts'), 'utf8');
    const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'spec-post-save-reconciliation.ts'), 'utf8');
    const conflictLookup = specsSource.indexOf('let preexistingWorkflowConflict = await getActivePostSaveWorkflowConflict');
    const reconcile = specsSource.indexOf("await runEffect('workflow.reconcile.preexisting'", conflictLookup);
    const reject = specsSource.indexOf('if (preexistingWorkflowConflict && !dryRun) {', reconcile);
    expect(conflictLookup).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(conflictLookup);
    expect(reject).toBeGreaterThan(reconcile);
    const reconciliationBlock=specsSource.slice(reconcile,reject);
    expect(reconciliationBlock).toContain('reconcileStaleActivePostSaveWorkflowRun');
    expect(reconciliationBlock).toContain("input.invocationSurface === 'api.specs.workflow.stage-retry'");
    expect(serviceSource).not.toContain('supersedeActiveWorkflowRuns');
  });
  test('settles observed terminal failed job into exact queued run 80 and audits bounded identities only', async () => {
    current = fakeClient({ transportState: 'failed' });
    const { reconcilePostSaveWorkflowStage } = await import('../spec-post-save-reconciliation');
    const result = await reconcilePostSaveWorkflowStage(input());

    expect(result).toMatchObject({ outcome: 'accepted', reasonCode: 'terminal_application_job_applied', beforeStatus: 'queued', afterStatus: 'failed', auditId: 901 });
    expect(mockWithPgAdvisoryLock).toHaveBeenCalledTimes(1);
    const stageUpdate = current.queries.find((entry) => entry.sql.includes('UPDATE spec_post_save_workflow_stages'));
    expect(stageUpdate?.params).toEqual(expect.arrayContaining([80, 'memorySynthesis', jobId, 'failed', 'job_failed']));
    const audit = current.queries.find((entry) => entry.sql.includes('INSERT INTO spec_post_save_reconciliation_audit'));
    expect(JSON.stringify(audit?.params)).not.toContain('secret-bearing');
    expect(JSON.stringify(audit?.params)).not.toContain('arbitraryAuthority');
  });

  test('rejects nonterminal or live pg-boss work without changing the stage', async () => {
    current = fakeClient({ jobStatus: 'running', transportState: 'active' });
    const { reconcilePostSaveWorkflowStage } = await import('../spec-post-save-reconciliation');
    const result = await reconcilePostSaveWorkflowStage(input());

    expect(result).toMatchObject({ outcome: 'rejected', reasonCode: 'transport_live_work', afterStatus: 'queued' });
    expect(current.queries.some((entry) => entry.sql.includes('UPDATE spec_post_save_workflow_stages'))).toBe(false);
  });

  test('is idempotent when the exact failed stage is already reconciled', async () => {
    current = fakeClient({ stageStatus: 'failed', jobStatus: 'failed', transportState: 'failed', transportLocation: 'archive' });
    const { reconcilePostSaveWorkflowStage } = await import('../spec-post-save-reconciliation');
    const result = await reconcilePostSaveWorkflowStage(input());

    expect(result).toMatchObject({ outcome: 'no_op', reasonCode: 'stage_already_reconciled', beforeStatus: 'failed', afterStatus: 'failed' });
    expect(current.queries.some((entry) => entry.sql.includes('UPDATE spec_post_save_workflow_stages'))).toBe(false);
  });

  test('rejects fabricated completion for a required failed stage', async () => {
    current = fakeClient({ stageStatus: 'failed', jobStatus: 'completed', transportState: 'completed' });
    const { reconcilePostSaveWorkflowStage } = await import('../spec-post-save-reconciliation');
    const result = await reconcilePostSaveWorkflowStage(input());

    expect(result).toMatchObject({ outcome: 'rejected', reasonCode: 'required_failed_stage_cannot_be_promoted', afterStatus: 'failed' });
    expect(current.queries.some((entry) => entry.sql.includes('UPDATE spec_post_save_workflow_stages'))).toBe(false);
  });

  test('rejects wrong exact workflow/job binding and stale compare-and-set fences', async () => {
    current = fakeClient({ exactOk: false, transportState: 'failed' });
    const { reconcilePostSaveWorkflowStage } = await import('../spec-post-save-reconciliation');
    const wrong = await reconcilePostSaveWorkflowStage(input());
    expect(wrong).toMatchObject({ outcome: 'rejected', reasonCode: 'exact_job_run_binding_mismatch' });

    current = fakeClient({ transportState: 'failed', casWins: false });
    const stale = await reconcilePostSaveWorkflowStage({ ...input(), operationId: 'operator:wave2:stale-fence' });
    expect(stale).toMatchObject({ outcome: 'rejected', reasonCode: 'stage_compare_and_set_lost' });
  });

  test('accepts terminal application authority when the exact transport is absent and no live work exists', async () => {
    current = fakeClient({ transportState: null });
    const { reconcilePostSaveWorkflowStage } = await import('../spec-post-save-reconciliation');
    const result = await reconcilePostSaveWorkflowStage(input());
    expect(result).toMatchObject({ outcome: 'accepted', transport: { location: 'missing', state: null }, afterStatus: 'failed' });
  });

  test('repair preflight reconciles only bounded stale stages from the named active run', async () => {
    current = fakeClient({ transportState: 'failed' });
    mockQuery.mockResolvedValueOnce([{
      stage_key: 'memorySynthesis', job_id: jobId, status: 'queued',
      updated_at: new Date('2026-07-29T00:00:00.000Z'),
    }]);
    const { reconcileStaleActivePostSaveWorkflowRun } = await import('../spec-post-save-reconciliation');
    const result = await reconcileStaleActivePostSaveWorkflowRun({
      workspaceId: 'mission-waves', specId: 'wave-2', workflowRunId: 80,
      source: 'repair', now: new Date('2026-07-29T01:00:00.000Z'),
    });
    expect(result).toMatchObject({ workflowRunId: 80, attempted: 1 });
    expect(result.results[0]).toMatchObject({ outcome: 'accepted', workflowRunId: 80, stageKey: 'memorySynthesis' });
  });
});
