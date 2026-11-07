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

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockGetLifecycleReconciliationSnapshot = jest.fn();
const mockInspectPasses = jest.fn();
const mockTransaction = jest.fn();
const mockClientQuery = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../ssdlc-lifecycle-read', () => ({
  getLifecycleReconciliationSnapshot: (...args: unknown[]) => mockGetLifecycleReconciliationSnapshot(...args),
}));

jest.mock('../ssdlc-pass-reconciler', () => ({
  inspectApprovedSpecPasses: (...args: unknown[]) => mockInspectPasses(...args),
}));

import { applyLifecycleReconciliation, previewLifecycleReconciliation } from '../lifecycle-reconciliation';
import { deriveStoryContractRevision } from '../story-execution-packet';

const workspaceId = 'reconciliation-workspace';
const specId = 'spec-a';
let root: string;
let runCommit: string;
let runSpecRevision: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function writeSpec(input: {
  passes: boolean;
  criterion: string;
  assuranceOverride?: string;
  notes?: string;
  secondStory?: boolean;
}): Record<string, unknown> {
  const approved = path.join(root, 'forge', 'specs', 'approved');
  fs.mkdirSync(approved, { recursive: true });
  const firstStory = {
    id: 'US-001',
    title: 'Exact delivery',
    description: 'Prove the committed story intent.',
    acceptanceCriteria: [input.criterion],
    dependsOn: [],
    passes: input.passes,
    notes: input.notes,
  };
  const content = {
    title: 'Exact revision spec',
    assurance: { override: input.assuranceOverride ?? 'baseline' },
    userStories: input.secondStory
      ? [firstStory, {
        id: 'US-002',
        title: 'Second exact delivery',
        description: 'Prove every expected story independently.',
        acceptanceCriteria: ['The second story has a terminal authoritative result.'],
        dependsOn: [],
        passes: input.passes,
      }]
      : [firstStory],
  };
  fs.writeFileSync(path.join(approved, `${specId}.json`), JSON.stringify(content, null, 2));
  return content;
}

function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 41,
    status: 'done',
    branch_name: 'feat/spec-a',
    merge_status: null,
    merge_commit_sha: null,
    terminal_checkout_sha: runCommit,
    expected_story_ids: ['US-001'],
    canonical_spec_revision: runSpecRevision,
    run_spec_path: null,
    run_spec_bytes_hash: null,
    execution_worktree_path: null,
    started_at: new Date('2026-08-10T00:00:00.000Z'),
    finished_at: new Date('2026-08-10T00:01:00.000Z'),
    terminal_story_results: [{ storyId: 'US-001', status: 'pass' }],
    ...overrides,
  };
}

function watermarkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec_slug: specId,
    compiled_plan_state: { id: null },
    evidence_state: { maximumId: null, rowCount: '0' },
    decision_state: { maximumId: null, rowCount: '0' },
    run_state: [{ id: 41, status: 'done' }],
    mutation_state: { decisionRevocations: [], effectiveStoryResults: [] },
    ...overrides,
  };
}

function installReceiptPersistence(receipts: Array<Record<string, unknown>>): void {
  mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM workspaces')) return { id: workspaceId, path: root };
    if (!sql.includes('FROM ssdlc_reconciliation_receipts')) return undefined;
    if (sql.includes('idempotency_key = $2')) {
      return receipts.find((row) => row.workspace_id === params[0] && row.idempotency_key === params[1]);
    }
    const exactReceipts = receipts.filter((row) =>
      row.workspace_id === params[0] && row.spec_slug === params[1] && row.spec_revision_hash === params[2]);
    if (sql.includes('operator_attestation IS NOT NULL')) {
      for (let index = exactReceipts.length - 1; index >= 0; index -= 1) {
        if (exactReceipts[index]!.operator_attestation !== null) return exactReceipts[index];
      }
      return undefined;
    }
    return exactReceipts.at(-1);
  });
  const client = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('WITH requested AS')) return { rows: [watermarkRow()] };
      if (sql.includes('FROM workspaces')) return { rows: [{ id: workspaceId, path: root }] };
      if (sql.includes('FROM pipeline_runs') || sql.includes('FROM spec_versions')) {
        return { rows: await mockQuery(sql, params) };
      }
      if (sql.includes('FROM ssdlc_reconciliation_receipts')) {
        const row = await mockQueryOne(sql, params);
        return { rows: row ? [row] : [] };
      }
      if (!sql.includes('INSERT INTO ssdlc_reconciliation_receipts')) return { rows: [] };
      const row: Record<string, unknown> = {
        id: `receipt-${receipts.length + 1}`,
        workspace_id: params[0],
        spec_slug: params[1],
        spec_revision_hash: params[2],
        compiled_plan_id: params[3],
        preview_hash: params[4],
        reconciliation_watermarks: JSON.parse(String(params[5])),
        idempotency_key: params[6],
        request_hash: params[7],
        result_hash: params[8],
        delivery_status: params[9],
        assurance_status: params[10],
        story_summary: JSON.parse(String(params[11])),
        stage_evidence: JSON.parse(String(params[12])),
        source_evidence: JSON.parse(String(params[13])),
        unresolved_gaps: JSON.parse(String(params[14])),
        operator_attestation: params[15] === null ? null : JSON.parse(String(params[15])),
        created_by: params[16],
        created_at: new Date(`2026-08-10T00:0${receipts.length + 2}:00.000Z`),
      };
      receipts.push(row);
      return { rows: [row] };
    }),
  };
  mockTransaction.mockImplementation(async (callback: (transactionClient: typeof client) => Promise<unknown>) =>
    callback(client));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClientQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('WITH requested AS')) return { rows: [watermarkRow()] };
    if (sql.includes('FROM workspaces')) return { rows: [{ id: workspaceId, path: root }] };
    if (sql.includes('FROM pipeline_runs') || sql.includes('FROM spec_versions')) {
      return { rows: await mockQuery(sql, params) };
    }
    if (sql.includes('FROM ssdlc_reconciliation_receipts')) {
      const row = await mockQueryOne(sql, params);
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  });
  mockTransaction.mockImplementation(async (
    callback: (transactionClient: { query: typeof mockClientQuery }) => Promise<unknown>,
  ) => callback({ query: mockClientQuery }));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-lifecycle-reconciliation-'));
  git('init');
  git('config', 'user.email', 'reconciliation@example.test');
  git('config', 'user.name', 'Reconciliation Test');
  const runSpec = writeSpec({ passes: false, criterion: 'Original acceptance criterion' });
  git('add', '.');
  git('commit', '-m', 'run revision');
  runCommit = git('rev-parse', 'HEAD');
  runSpecRevision = deriveStoryContractRevision(runSpec);

  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM workspaces')) return { id: workspaceId, path: root };
    if (sql.includes('FROM ssdlc_reconciliation_receipts')) return undefined;
    return undefined;
  });
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM spec_versions')) return [];
    if (!sql.includes('FROM pipeline_runs')) return [];
    return [runRow()];
  });
  mockGetLifecycleReconciliationSnapshot.mockResolvedValue({
    plan: null,
    profile: null,
    state: 'needs_compilation',
    phaseTimeline: [],
    overallReadiness: { counts: null },
    provenance: {},
    evidenceHighWaterMark: 'evidence:0',
    decisionHighWaterMark: 'decision:0',
  });
  mockInspectPasses.mockResolvedValue({ stories: [{ id: 'US-001', status: 'consistent-passed' }] });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('accepts mutable pass reconciliation but rejects an integrated run for different story intent', async () => {
  writeSpec({
    passes: true,
    criterion: 'Original acceptance criterion',
    notes: 'Completed by Rorca pass reconciler',
  });
  git('add', '.');
  git('commit', '-m', 'reconcile mutable pass state');

  const matching = await previewLifecycleReconciliation({ workspaceId, specId });
  expect(matching.delivery).toMatchObject({ status: 'completed', integratedRunId: 41, integratedCommit: runCommit });
  expect(matching.sourceEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'pipeline_run', runId: 41, integrated: true, exactSpecRevision: true }),
  ]));

  writeSpec({ passes: true, criterion: 'Materially changed acceptance criterion' });
  git('add', '.');
  git('commit', '-m', 'change story intent');

  const stale = await previewLifecycleReconciliation({ workspaceId, specId });
  expect(stale.delivery).toMatchObject({ status: 'unknown', integratedRunId: null, integratedCommit: null });
  expect(stale.sourceEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'pipeline_run', runId: 41, integrated: true, exactSpecRevision: false }),
  ]));
  expect(stale.unresolvedGaps).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'HISTORICAL_RUN_REVISION_MISMATCH' }),
  ]));
});

test('retains human-authored story notes in historical delivery identity', async () => {
  writeSpec({
    passes: true,
    criterion: 'Original acceptance criterion',
    notes: 'Human-authored delivery constraint changed after the run.',
  });
  git('add', '.');
  git('commit', '-m', 'change human delivery note');

  const preview = await previewLifecycleReconciliation({ workspaceId, specId });

  expect(preview.delivery.status).toBe('unknown');
  expect(preview.sourceEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'pipeline_run', runId: 41, exactSpecRevision: false }),
  ]));
});

test('requires the historical source document to match the run canonical revision before comparison', async () => {
  writeSpec({ passes: true, criterion: 'Original acceptance criterion' });
  git('add', '.');
  git('commit', '-m', 'reconcile pass state');
  mockQuery.mockImplementation(async (sql: string) =>
    sql.includes('FROM pipeline_runs')
      ? [runRow({ canonical_spec_revision: `sha256:${'f'.repeat(64)}` })]
      : []);

  const preview = await previewLifecycleReconciliation({ workspaceId, specId });

  expect(preview.delivery.status).toBe('unknown');
  expect(preview.sourceEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'pipeline_run',
      runId: 41,
      exactSpecRevision: false,
      observedSpecRevision: null,
      observedDeliveryIdentityHash: null,
    }),
  ]));
});

test('uses the latest exact run for failed state but any integrated successful exact run for completion', async () => {
  mockQuery.mockImplementation(async (sql: string) => {
    if (!sql.includes('FROM pipeline_runs')) return [];
    return [
      runRow({ id: 42, status: 'running', canonical_spec_revision: `sha256:${'e'.repeat(64)}` }),
      runRow({ status: 'failed', terminal_story_results: [{ storyId: 'US-001', status: 'fail' }] }),
    ];
  });
  const failed = await previewLifecycleReconciliation({ workspaceId, specId });
  expect(failed.delivery).toMatchObject({ status: 'failed', integratedRunId: null });

  mockQuery.mockImplementation(async (sql: string) => {
    if (!sql.includes('FROM pipeline_runs')) return [];
    return [
      runRow({ id: 42, status: 'failed', terminal_story_results: [{ storyId: 'US-001', status: 'fail' }] }),
      runRow(),
    ];
  });
  const completed = await previewLifecycleReconciliation({ workspaceId, specId });
  expect(completed.delivery).toMatchObject({ status: 'completed', integratedRunId: 41 });
});

test('requires one latest passing terminal result for every exact expected story', async () => {
  const twoStorySpec = writeSpec({
    passes: false,
    criterion: 'Original acceptance criterion',
    secondStory: true,
  });
  git('add', '.');
  git('commit', '-m', 'two story run revision');
  runCommit = git('rev-parse', 'HEAD');
  runSpecRevision = deriveStoryContractRevision(twoStorySpec);
  let runQuery = '';
  mockQuery.mockImplementation(async (sql: string) => {
    if (!sql.includes('FROM pipeline_runs')) return [];
    runQuery = sql;
    return [runRow({
      expected_story_ids: ['US-001', 'US-002'],
      terminal_story_results: [
        { storyId: 'US-001', status: 'pass' },
        { storyId: 'US-X', status: 'pass' },
      ],
    })];
  });

  const missingExpected = await previewLifecycleReconciliation({ workspaceId, specId });
  expect(missingExpected.delivery).toMatchObject({ status: 'unknown', integratedRunId: null });
  expect(missingExpected.sourceEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({
      runId: 41,
      passedStoryCount: 1,
      storyResultsComplete: false,
    }),
  ]));

  mockQuery.mockImplementation(async (sql: string) => {
    if (!sql.includes('FROM pipeline_runs')) return [];
    runQuery = sql;
    return [runRow({
      expected_story_ids: ['US-001', 'US-002'],
      terminal_story_results: [
        { storyId: 'US-001', status: 'pass' },
        { storyId: 'US-002', status: 'pass' },
      ],
    })];
  });
  const successfulRetry = await previewLifecycleReconciliation({ workspaceId, specId });
  expect(successfulRetry.delivery).toMatchObject({ status: 'completed', integratedRunId: 41 });
  expect(runQuery).toContain('SELECT DISTINCT ON (sr.story_id)');
  expect(runQuery).toContain('ORDER BY sr.story_id, sr.id DESC');
  expect(runQuery).toContain('LIMIT $4');
});

test('projects partial_failure as terminal failed rather than active', async () => {
  mockQuery.mockImplementation(async (sql: string) =>
    sql.includes('FROM pipeline_runs')
      ? [runRow({
        status: 'partial_failure',
        terminal_story_results: [{ storyId: 'US-001', status: 'fail' }],
      })]
      : []);

  const preview = await previewLifecycleReconciliation({ workspaceId, specId });
  expect(preview.delivery).toMatchObject({ status: 'failed', integratedRunId: null });
  expect(preview.sourceEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ runId: 41, status: 'partial_failure', terminal: true }),
  ]));
});

test('rejects a hash-bound historical run when assurance intent changes', async () => {
  writeSpec({
    passes: true,
    criterion: 'Original acceptance criterion',
    assuranceOverride: 'stricter-override',
  });
  git('add', '.');
  git('commit', '-m', 'change assurance override');

  const preview = await previewLifecycleReconciliation({ workspaceId, specId });

  expect(preview.delivery).toMatchObject({ status: 'unknown', integratedRunId: null });
  expect(preview.sourceEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'pipeline_run',
      runId: 41,
      observedSpecRevision: expect.stringMatching(/^sha256:/),
      observedDeliveryIdentityHash: expect.stringMatching(/^sha256:/),
      exactSpecRevision: false,
    }),
  ]));
});

test('does not fall back to stale ledger evidence when the terminal commit spec is malformed', async () => {
  fs.writeFileSync(path.join(root, 'forge', 'specs', 'approved', `${specId}.json`), '{\"title\":');
  git('add', '.');
  git('commit', '-m', 'malformed terminal spec');
  const malformedCommit = git('rev-parse', 'HEAD');
  const currentDocument = writeSpec({ passes: false, criterion: 'Original acceptance criterion' });
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM spec_versions')) return [{ content_json: currentDocument }];
    if (sql.includes('FROM pipeline_runs')) {
      return [runRow({ terminal_checkout_sha: malformedCommit, merge_status: 'merged' })];
    }
    return [];
  });

  const preview = await previewLifecycleReconciliation({ workspaceId, specId });

  expect(preview.delivery).toMatchObject({ status: 'unknown', integratedRunId: null });
  expect(preview.sourceEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({
      runId: 41,
      exactSpecRevision: false,
      specIdentitySource: 'terminal_commit',
      specIdentityConflict: expect.stringContaining('malformed'),
    }),
  ]));
  expect(preview.unresolvedGaps).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'CONTRADICTORY_RUN_SPEC_EVIDENCE' }),
  ]));
});


test('returns an actionable typed conflict instead of truncating exact-spec run authority', async () => {
  mockQuery.mockImplementation(async (sql: string) =>
    sql.includes('FROM pipeline_runs')
      ? Array.from({ length: 51 }, (_, index) => runRow({ id: index + 1 }))
      : []);

  await expect(previewLifecycleReconciliation({ workspaceId, specId })).rejects.toMatchObject({
    code: 'CONFLICT',
    statusCode: 409,
    details: {
      type: 'lifecycle_reconciliation_run_bound_exceeded',
      specId,
      maximumRuns: 50,
      remediation: expect.any(String),
    },
  });
});

test('bounds oversized run story payloads and refuses them as delivery authority', async () => {
  mockQuery.mockImplementation(async (sql: string) =>
    sql.includes('FROM pipeline_runs')
      ? [runRow({
        merge_status: 'merged',
        expected_story_ids: Array.from({ length: 2_001 }, (_, index) => `US-${index}`),
        terminal_story_results: Array.from({ length: 2_001 }, (_, index) => ({
          storyId: `US-${index}`,
          status: 'pass',
        })),
      })]
      : []);

  const preview = await previewLifecycleReconciliation({ workspaceId, specId });

  expect(preview.delivery.status).toBe('unknown');
  expect(preview.sourceEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({
      runId: 41,
      storyScopeValid: false,
      expectedStoryCount: 2_000,
      storyScopeMaximum: 2_000,
    }),
  ]));
  expect(preview.unresolvedGaps).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'RUN_STORY_SCOPE_INVALID' }),
  ]));
});

test('returns an actionable typed conflict instead of truncating historical spec identity sources', async () => {
  mockQuery.mockImplementation(async (sql: string) =>
    sql.includes('COUNT(*)::text AS total') && sql.includes('FROM spec_versions')
      ? [{ total: 101 }]
      : []);

  await expect(previewLifecycleReconciliation({ workspaceId, specId })).rejects.toMatchObject({
    code: 'CONFLICT',
    statusCode: 409,
    details: {
      type: 'lifecycle_reconciliation_spec_version_bound_exceeded',
      specId,
      maximumVersions: 100,
      remediation: expect.any(String),
    },
  });
});

test('returns an actionable typed error for a malformed current approved spec', async () => {
  fs.writeFileSync(path.join(root, 'forge', 'specs', 'approved', `${specId}.json`), '{\"title\":');

  await expect(previewLifecycleReconciliation({ workspaceId, specId })).rejects.toMatchObject({
    code: 'LIFECYCLE_RECONCILIATION_SPEC_INVALID',
    statusCode: 422,
    details: {
      specId,
      remediation: expect.any(String),
    },
  });
});

test('replays an idempotency key before receipt-mutated preview state is recomputed', async () => {
  const receipts: Array<Record<string, unknown>> = [];
  installReceiptPersistence(receipts);
  const preview = await previewLifecycleReconciliation({ workspaceId, specId });
  const first = await applyLifecycleReconciliation({
    workspaceId,
    specId,
    previewHash: preview.previewHash,
    idempotencyKey: 'replay-key',
    actorId: 'actor-1',
    actorLabel: 'operator@example.test',
  });
  const previewCallsAfterInsert = mockGetLifecycleReconciliationSnapshot.mock.calls.length;

  const replay = await applyLifecycleReconciliation({
    workspaceId,
    specId,
    previewHash: preview.previewHash,
    idempotencyKey: 'replay-key',
    actorId: 'actor-1',
    actorLabel: 'operator@example.test',
  });

  expect(replay).toMatchObject({
    id: first.id,
    resultHash: first.resultHash,
    watermarks: first.watermarks,
    replayed: true,
  });
  expect(first.watermarks).toEqual(preview.watermarks);
  expect(mockGetLifecycleReconciliationSnapshot).toHaveBeenCalledTimes(previewCallsAfterInsert);
});

test('persists attestation-specific gaps and carries the effective attestation into later receipts', async () => {
  const receipts: Array<Record<string, unknown>> = [];
  installReceiptPersistence(receipts);
  mockQuery.mockResolvedValue([]);
  const initial = await previewLifecycleReconciliation({ workspaceId, specId });
  const attested = await applyLifecycleReconciliation({
    workspaceId,
    specId,
    previewHash: initial.previewHash,
    idempotencyKey: 'attested-key',
    actorId: 'actor-1',
    actorLabel: 'operator@example.test',
    operatorAttestation: {
      deliveryOutcome: 'completed',
      rationale: 'The external delivery record proves this exact revision completed.',
      evidenceReferences: ['https://delivery.example.test/receipt/1'],
    },
  });
  expect(attested).toMatchObject({ deliveryStatus: 'operator_attested' });
  expect(attested.unresolvedGaps).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'DELIVERY_INTEGRATION_UNPROVEN' }),
  ]));

  const nextPreview = await previewLifecycleReconciliation({ workspaceId, specId });
  expect(nextPreview.delivery.status).toBe('operator_attested');
  const later = await applyLifecycleReconciliation({
    workspaceId,
    specId,
    previewHash: nextPreview.previewHash,
    idempotencyKey: 'later-key',
    actorId: 'actor-1',
    actorLabel: 'operator@example.test',
  });

  expect(later.deliveryStatus).toBe('operator_attested');
  expect(later.operatorAttestation).toEqual(attested.operatorAttestation);
  expect(later.unresolvedGaps).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'DELIVERY_INTEGRATION_UNPROVEN' }),
  ]));
});

test('rejects a decision revocation that lands between preview computation and final identity validation', async () => {
  let watermarkReads = 0;
  const baseClientQuery = mockClientQuery.getMockImplementation()!;
  mockClientQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('WITH requested AS')) {
      watermarkReads += 1;
      return {
        rows: [watermarkRow({
          mutation_state: watermarkReads < 3
            ? { decisionRevocations: [] }
            : { decisionRevocations: [['19', '2026-08-10T00:02:00.000Z']] },
        })],
      };
    }
    return baseClientQuery(sql, params);
  });
  const preview = await previewLifecycleReconciliation({ workspaceId, specId });

  await expect(applyLifecycleReconciliation({
    workspaceId,
    specId,
    previewHash: preview.previewHash,
    idempotencyKey: 'revocation-race',
    actorId: 'actor-1',
    actorLabel: 'operator@example.test',
  })).rejects.toMatchObject({
    message: 'Lifecycle reconciliation identity changed before receipt persistence',
    details: { type: 'new_preview_required' },
  });
  expect(mockClientQuery).toHaveBeenCalledWith('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  expect(mockClientQuery.mock.calls.some(([sql]) =>
    String(sql).includes('INSERT INTO ssdlc_reconciliation_receipts'))).toBe(false);
});

test('binds plan evidence decision and run high-water marks into stale-preview identity', async () => {
  let watermarkReads = 0;
  const baseClientQuery = mockClientQuery.getMockImplementation()!;
  mockClientQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('WITH requested AS')) {
      watermarkReads += 1;
      return {
        rows: [watermarkRow(watermarkReads === 1 ? {} : {
          compiled_plan_state: { id: '72', inputHash: 'sha256:changed' },
          evidence_state: { maximumId: '501', rowCount: '501' },
          decision_state: { maximumId: '201', rowCount: '201' },
          run_state: [{ id: 42, status: 'running' }],
        })],
      };
    }
    return baseClientQuery(sql, params);
  });
  const preview = await previewLifecycleReconciliation({ workspaceId, specId });

  await expect(applyLifecycleReconciliation({
    workspaceId,
    specId,
    previewHash: preview.previewHash,
    idempotencyKey: 'watermark-race',
    actorId: 'actor-1',
    actorLabel: 'operator@example.test',
  })).rejects.toMatchObject({
    message: 'Lifecycle reconciliation preview is stale; refresh before applying',
    details: {
      type: 'new_preview_required',
      requestedPreviewHash: preview.previewHash,
    },
  });
  expect(Object.keys(preview.watermarks).sort()).toEqual([
    'compiledPlan', 'decisions', 'evidence', 'mutationState', 'runs',
  ]);
});

test('lifecycle projections select the newest receipt inside the exact current revision', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'ssdlc-lifecycle-read.ts'), 'utf8');
  const selection = source.slice(
    source.indexOf('async function loadLatestReconciliations'),
    source.indexOf('function withReconciliation'),
  );
  expect(selection).toContain('WITH exact_revisions(spec_slug, spec_revision_hash)');
  expect(selection).toContain('receipt.spec_revision_hash = exact.spec_revision_hash');
  expect(selection).toContain('ORDER BY receipt.spec_slug, receipt.created_at DESC, receipt.id DESC');
  expect(selection).toContain('COALESCE(receipt.operator_attestation');
  expect(selection.indexOf('receipt.spec_revision_hash = exact.spec_revision_hash')).toBeLessThan(
    selection.indexOf('ORDER BY receipt.spec_slug'),
  );
});
