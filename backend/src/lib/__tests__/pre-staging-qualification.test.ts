/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fixture from '../../__tests__/fixtures/ssdlc/backend-data.json';
import * as mechanismDiscovery from '../mechanism-discovery';

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockTransaction = jest.fn();
const mockPreviewReconciliation = jest.fn();
const mockPersistEvidence = jest.fn();
const mockBossSend = jest.fn();
jest.mock('../pg-boss', () => ({ getBoss: () => ({ send: (...args: unknown[]) => mockBossSend(...args) }) }));

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../lifecycle-reconciliation', () => ({
  previewLifecycleReconciliation: (...args: unknown[]) => mockPreviewReconciliation(...args),
}));

jest.mock('../ssdlc-evidence', () => ({
  ...jest.requireActual('../ssdlc-evidence'),
  persistCanonicalEvidence: (...args: unknown[]) => mockPersistEvidence(...args),
}));

import { compileLifecyclePlan, SSDLC_PLAN_COMPILER_VERSION } from '../ssdlc-plan-compiler';
import { LifecycleCompilerInputSchema } from '../ssdlc-contracts';
import {
  previewPreStagingQualification,
  runPreStagingQualification,
} from '../pre-staging-qualification';

let root: string;
let storedReceipt: Record<string, unknown> | undefined;
let storedAttempt: Record<string, unknown> | undefined;
let compiledPlanRow: Record<string, unknown>;
let pipelineRunRow: {
  id: string;
  canonical_spec_revision: string | null;
  terminal_checkout_sha: string | null;
  terminal_checkout_attested_at: Date | string | null;
  execution_worktree_path: string | null;
} | undefined;
const workspaceId = 'qualification-workspace';
const specId = 'backend-data';
const plan = compileLifecyclePlan(LifecycleCompilerInputSchema.parse(fixture.input)).plan;
const revisionHash = `sha256:${'a'.repeat(64)}`;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}


beforeEach(() => {
  jest.clearAllMocks();
  storedReceipt = undefined;
  storedAttempt = undefined;
  pipelineRunRow = undefined;
  compiledPlanRow = {
    id: '1',
    compiler_version: SSDLC_PLAN_COMPILER_VERSION,
    plan_json: plan,
    provenance_json: { specHash: revisionHash },
  };
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pre-staging-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      lint: 'node -e "process.exit(0)"',
      typecheck: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
      security: 'node security-check.js',
      build: 'node -e "process.exit(0)"',
      e2e: 'node e2e-check.js',
    },
  }));
  fs.writeFileSync(path.join(root, 'security-check.js'), 'process.exit(0);');
  fs.writeFileSync(path.join(root, 'e2e-check.js'), 'process.exit(0);');
  git('init');
  git('config', 'user.email', 'qualification@example.test');
  git('config', 'user.name', 'Qualification Test');
  git('add', 'package.json', 'security-check.js', 'e2e-check.js');
  git('commit', '-m', 'qualification fixture');

  mockPreviewReconciliation.mockResolvedValue({
    workspaceId, specId, title: 'Backend data', specRevisionHash: revisionHash,
    compiledPlanId: '1', planState: 'current',
    previewHash: `sha256:${'b'.repeat(64)}`,
  });
  mockQuery.mockResolvedValue([]);
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM workspaces')) return { id: workspaceId, path: root };
    if (sql.includes('FROM pipeline_runs')) return pipelineRunRow;
    if (sql.includes('FROM ssdlc_compiled_plans')) {
      return sql.includes('is_current = TRUE') && sql.includes("validation_status = 'validated'")
        ? compiledPlanRow
        : undefined;
    }
    if (sql.includes('FROM ssdlc_release_qualifications')) return storedReceipt;
    if (sql.includes('FROM ssdlc_qualification_attempts')) return storedAttempt;
    return undefined;
  });
  let evidenceSequence = 0;
  mockPersistEvidence.mockImplementation(async () => ({ evidence: { id: `evidence-${++evidenceSequence}` } }));
  mockTransaction.mockImplementation(async (callback: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<unknown>) => callback({
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO ssdlc_qualification_attempts')) {
        if (!storedAttempt) {
          storedAttempt = {
            id: '22222222-2222-4222-8222-222222222222', workspace_id: params[0], spec_slug: params[1],
            preview_hash: params[2], run_id: params[3], actor_id: params[4], idempotency_key: params[5],
            request_hash: params[6], state: 'pending', lease_token: null, lease_expires_at: null,
            receipt_id: null, error_code: null, error_message: null,
          };
          return { rows: [storedAttempt] };
        }
        return { rows: [] };
      }
      if (sql.includes('FROM ssdlc_qualification_attempts')) return { rows: storedAttempt ? [storedAttempt] : [] };
      return { rows: [] };
    },
  }));
  mockBossSend.mockImplementation(async () => {
    const attempt = storedAttempt!;
    storedReceipt = {
      id: '11111111-1111-4111-8111-111111111111', workspace_id: attempt.workspace_id,
      spec_slug: attempt.spec_slug, spec_revision_hash: revisionHash, compiled_plan_id: '1',
      run_id: attempt.run_id, head_sha: git('rev-parse', 'HEAD'), request_hash: attempt.request_hash,
      preview_hash: attempt.preview_hash, status: 'passed', mechanisms: [], check_results: [],
      evidence_ids: [], readiness: { stagingAuthorityGranted: false, missingRequiredCategories: [] },
      receipt_hash: `sha256:${'d'.repeat(64)}`, created_by: attempt.actor_id,
      created_at: new Date('2026-08-11T00:00:00.000Z'),
    };
    storedAttempt = { ...attempt, state: 'complete', receipt_id: storedReceipt.id };
    return '33333333-3333-4333-8333-333333333333';
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('durably dispatches the exact preview and replays the completed worker receipt idempotently', async () => {
  const preview = await previewPreStagingQualification({ workspaceId, specId });

  expect(preview.preconditions).toEqual({ canExecute: true, blockers: [] });
  expect(preview.missingRequiredCategories).toEqual([]);
  expect(preview.checks.map((check) => check.category)).toEqual(['build', 'e2e', 'lint', 'security', 'typecheck', 'unit']);

  const first = await runPreStagingQualification({
    workspaceId, specId, previewHash: preview.previewHash,
    idempotencyKey: 'qualification-smoke-1', actorId: 'operator-1',
  });
  const replay = await runPreStagingQualification({
    workspaceId, specId, previewHash: preview.previewHash,
    idempotencyKey: 'qualification-smoke-1', actorId: 'operator-1',
  });

  expect(first.status).toBe('passed');
  expect(first.previewHash).toBe(preview.previewHash);
  expect(first.checkResults).toEqual([]);
  expect(first.evidenceIds).toEqual([]);
  expect(first.readiness).toMatchObject({ stagingAuthorityGranted: false, missingRequiredCategories: [] });
  expect(replay).toMatchObject({ id: first.id, receiptHash: first.receiptHash, replayed: true });
  expect(mockBossSend).toHaveBeenCalledTimes(1);
  expect(mockPersistEvidence).not.toHaveBeenCalled();
  expect(git('status', '--porcelain')).toBe('');
});

test('replays a completed request before mutable workspace state and rejects conflicting key reuse', async () => {
  const preview = await previewPreStagingQualification({ workspaceId, specId });
  const first = await runPreStagingQualification({
    workspaceId,
    specId,
    previewHash: preview.previewHash,
    idempotencyKey: 'qualification-replay-after-head-change',
    actorId: 'operator-1',
  });
  const previewCallsAfterCompletion = mockPreviewReconciliation.mock.calls.length;
  fs.writeFileSync(path.join(root, 'after.txt'), 'new revision\n');
  git('add', 'after.txt');
  git('commit', '-m', 'advance head after qualification');

  const replay = await runPreStagingQualification({
    workspaceId,
    specId,
    previewHash: preview.previewHash,
    idempotencyKey: 'qualification-replay-after-head-change',
    actorId: 'operator-1',
  });
  await expect(runPreStagingQualification({
    workspaceId,
    specId,
    previewHash: preview.previewHash,
    idempotencyKey: 'qualification-replay-after-head-change',
    actorId: 'different-operator',
  })).rejects.toMatchObject({
    statusCode: 409,
    message: 'Idempotency-Key was already used for a different qualification request',
  });

  expect(replay).toMatchObject({ id: first.id, receiptHash: first.receiptHash, replayed: true });
  expect(mockPreviewReconciliation).toHaveBeenCalledTimes(previewCallsAfterCompletion);
});

test('blocks stale plan state, mismatched plan provenance, and obsolete compiler output', async () => {
  mockPreviewReconciliation.mockResolvedValueOnce({
    workspaceId, specId, title: 'Backend data', specRevisionHash: revisionHash,
    compiledPlanId: '1', planState: 'stale',
    previewHash: `sha256:${'b'.repeat(64)}`,
  });
  const staleState = await previewPreStagingQualification({ workspaceId, specId });

  expect(staleState.preconditions).toMatchObject({ canExecute: false });
  expect(staleState.preconditions.blockers).toContain(
    'The lifecycle reconciliation plan is not current for this canonical spec revision.',
  );

  compiledPlanRow = {
    ...compiledPlanRow,
    provenance_json: { specHash: `sha256:${'d'.repeat(64)}` },
  };
  const staleProvenance = await previewPreStagingQualification({ workspaceId, specId });
  expect(staleProvenance.preconditions.blockers).toContain(
    'The compiled lifecycle plan provenance is not bound to this exact canonical spec revision.',
  );

  compiledPlanRow = {
    ...compiledPlanRow,
    compiler_version: 'ssdlc-plan-compiler-2',
    plan_json: { ...plan, compilerVersion: 'ssdlc-plan-compiler-2' },
    provenance_json: { specHash: revisionHash },
  };
  const staleCompiler = await previewPreStagingQualification({ workspaceId, specId });
  expect(staleCompiler.preconditions.blockers).toContain(
    `The compiled lifecycle plan was not produced by the current compiler ${SSDLC_PLAN_COMPILER_VERSION}.`,
  );
});
test('queues stale-plan revalidation for the worker without API-host execution', async () => {
  const currentPlanRow = compiledPlanRow;
  let planLoads = 0;
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM workspaces')) return { id: workspaceId, path: root };
    if (sql.includes('FROM ssdlc_compiled_plans')) {
      if (!sql.includes('is_current = TRUE') || !sql.includes("validation_status = 'validated'")) return undefined;
      planLoads += 1;
      return planLoads === 3
        ? { ...currentPlanRow, provenance_json: { specHash: `sha256:${'f'.repeat(64)}` } }
        : currentPlanRow;
    }
    if (sql.includes('FROM ssdlc_release_qualifications')) return storedReceipt;
    if (sql.includes('FROM ssdlc_qualification_attempts')) return storedAttempt;
    return undefined;
  });
  const preview = await previewPreStagingQualification({ workspaceId, specId });

  const dispatched = await runPreStagingQualification({
    workspaceId,
    specId,
    previewHash: preview.previewHash,
    idempotencyKey: 'qualification-stale-plan-1',
    actorId: 'operator-1',
  });

  expect(dispatched.status).toBe('passed');
  expect(mockBossSend).toHaveBeenCalledTimes(1);
  expect(planLoads).toBe(1);
  expect(mockPersistEvidence).not.toHaveBeenCalled();
});

test('rejects a run bound to a different canonical spec revision', async () => {
  pipelineRunRow = {
    id: '42',
    canonical_spec_revision: `sha256:${'e'.repeat(64)}`,
    terminal_checkout_sha: git('rev-parse', 'HEAD'),
    terminal_checkout_attested_at: new Date('2026-08-11T00:00:00.000Z'),
    execution_worktree_path: null,
  };

  await expect(previewPreStagingQualification({ workspaceId, specId, runId: 42 }))
    .rejects.toMatchObject({
      statusCode: 409,
      message: 'Pipeline run is not bound to the current canonical spec revision',
    });
});

test('binds run qualification to attested terminal HEAD despite an advanced dirty workspace', async () => {
  const terminalSha = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, 'advanced.txt'), 'advanced');
  git('add', 'advanced.txt');
  git('commit', '-m', 'advance canonical workspace');
  fs.writeFileSync(path.join(root, 'dirty.txt'), 'uncommitted');
  pipelineRunRow = {
    id: '42',
    canonical_spec_revision: revisionHash,
    terminal_checkout_sha: terminalSha,
    terminal_checkout_attested_at: new Date('2026-08-11T00:00:00.000Z'),
    execution_worktree_path: null,
  };

  const bound = await previewPreStagingQualification({ workspaceId, specId, runId: 42 });

  expect(bound).toMatchObject({
    runId: 42,
    headSha: terminalSha,
    cleanHead: true,
    preconditions: { canExecute: true, blockers: [] },
  });
  expect(bound.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
    'package:.:test',
    'package:.:e2e',
    'package:.:security',
  ]));
  expect(fs.existsSync(path.join(root, '.rorca-worktrees'))).toBe(false);
});

test('API dispatch never executes a repository command while awaiting the worker receipt', async () => {
  const discovery = jest.spyOn(mechanismDiscovery, 'discoverSoftwareQualificationChecks').mockImplementation(async (workspacePath: string) => ({
    checks: [{
      id: 'package:.:test',
      category: 'unit',
      label: 'root · test',
      executable: 'node',
      args: ['-e', 'require("node:net").createServer().listen(0)'],
      cwd: fs.realpathSync(workspacePath),
      discoveredFrom: ['package.json'],
      timeoutMs: 50,
    }],
    availableCategories: ['unit'],
    unavailableCategories: mechanismDiscovery.SOFTWARE_QUALIFICATION_CATEGORIES.filter((category) => category !== 'unit'),
    inspectedPaths: ['package.json'],
  }));
  try {
    const preview = await previewPreStagingQualification({ workspaceId, specId });
    const result = await runPreStagingQualification({
      workspaceId,
      specId,
      previewHash: preview.previewHash,
      idempotencyKey: 'qualification-timeout-1',
      actorId: 'operator-1',
    });

    expect(result.checkResults).toEqual([]);
    expect(mockBossSend).toHaveBeenCalledTimes(1);
  } finally {
    discovery.mockRestore();
  }
});
