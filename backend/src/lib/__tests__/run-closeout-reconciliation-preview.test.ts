/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type * as RunHostAuthorityModule from '../run-host-authority';

const query = jest.fn();
const queryOne = jest.fn();
const execute = jest.fn();
const transaction = jest.fn();
const inspectRunHostAuthority = jest.fn();
const assertTrustedWal = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
  transaction: (...args: unknown[]) => transaction(...args),
  withPgAdvisoryLock: async (_key: string, operation: () => Promise<unknown>) => operation(),
}));
jest.mock('../run-host-authority', () => {
  const actual = jest.requireActual<typeof RunHostAuthorityModule>('../run-host-authority');
  return {
    assertExactRunLocalSpecLifecycleAuthority: actual.assertExactRunLocalSpecLifecycleAuthority,
    hasExactHostTimestampPrecisionCapability: () => true,
    inspectRunHostAuthority: (...args: unknown[]) => inspectRunHostAuthority(...args),
  };
});
jest.mock('../closeout-reconciliation-build-identity', () => {
  const actual = jest.requireActual<typeof import('../closeout-reconciliation-build-identity')>('../closeout-reconciliation-build-identity');
  const wave1 = jest.requireActual<typeof import('../wave-1-stabilization')>('../wave-1-stabilization');
  return {
    ...actual,
    resolveCloseoutReconciliationBuildIdentity: () => ({
      buildSha: 'd472df98102478f08f6dd5130158a3daa9ec06d9',
      buildReceiptHash: `sha256:${'b'.repeat(64)}`,
      buildReceipt: {
        schemaVersion: 'rorca.build-identity-receipt.v1',
        buildSha: 'd472df98102478f08f6dd5130158a3daa9ec06d9',
        reviewedSourceSha: 'd472df98102478f08f6dd5130158a3daa9ec06d9',
        requiredFixSha: actual.REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA,
        artifactDigest: `sha256:${'c'.repeat(64)}`,
        deploymentId: 'preview-test-deployment',
        deploymentEnvironment: 'production',
        workspaceId: 'proof-workspace',
        canonicalSpecPath: wave1.WAVE_1_SPEC_PATH,
        issuer: 'rorca-release-authority',
        keyId: 'wave1-test-key',
        signature: `ed25519:${'A'.repeat(86)}==`,
        issuedAt: '2026-07-26T23:30:00.000Z',
        implementationBaselineSha: wave1.WAVE_1_IMPLEMENTATION_BASELINE_SHA,
        waveSpecRevision: wave1.WAVE_1_SPEC_CONTENT_HASH,
        sourceRepository: wave1.WAVE_1_SOURCE_REPOSITORY,
      },
      requiredFixSha: actual.REQUIRED_CLOSEOUT_TIMESTAMP_FIX_SHA,
      implementationBaselineSha: wave1.WAVE_1_IMPLEMENTATION_BASELINE_SHA,
      waveSpecRevision: wave1.WAVE_1_SPEC_CONTENT_HASH,
      sourceRepository: wave1.WAVE_1_SOURCE_REPOSITORY,
      artifactDigest: `sha256:${'c'.repeat(64)}`,
      verification: 'startup-deployment-receipt+measured-artifact+runtime-capability',
    }),
  };
});
jest.mock('../trusted-wal', () => {
  const actual = jest.requireActual('../trusted-wal');
  return { ...actual, assertExactTrustedWalRow: (...args: unknown[]) => assertTrustedWal(...args) };
});
jest.mock('../run-closeout-authority', () => ({
  loadHostRunCloseoutReference: jest.fn(),
  persistHostRunCloseout: jest.fn(),
  prepareHostRunCloseout: jest.fn(),
  samePreparedHostCloseout: jest.fn(),
}));
jest.mock('../release-authority', () => ({
  prepareRunReleaseIntent: jest.fn(),
  reconcileRunReleaseIntent: jest.fn(),
}));
jest.mock('../provider-human-authority', () => {
  const actual = jest.requireActual('../provider-human-authority');
  return { ...actual, verifyAndPersistProviderHumanAuthority: jest.fn() };
});
jest.mock('../pg-boss', () => ({ initBoss: jest.fn(), getBoss: jest.fn() }));

import { retryHash } from '../retry-governance';
import { previewRunCloseoutReconciliation } from '../run-closeout-reconciliation';

const RUN_ID = 20260316000550;
const WORKSPACE_ID = 'proof-workspace';
const SPEC_ID = 'wave-1-stabilize-evidence-closeout-and-managed-branch-delivery';
const STORY_ID = 'W1-001';
const SPEC_PATH = `forge/specs/pending/${SPEC_ID}.json`;
const SOURCE_REPOSITORY = path.resolve(__dirname, '../../../..');
let root: string;
let workspace: string;
let worktree: string;
let terminalSha: string;
let runSpecPath: string;
let runRow: Record<string, unknown>;
let activeJobs: Array<Record<string, unknown>>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setStoryPassFlag(projection: unknown, storyId: string, passes: boolean): void {
  if (!projection || Array.isArray(projection) || typeof projection !== 'object'
    || !('userStories' in projection) || !Array.isArray(projection.userStories)) {
    throw new Error('Canonical Wave fixture is invalid');
  }
  const story: unknown = projection.userStories.find((candidate: unknown) =>
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      && 'id' in candidate && candidate.id === storyId);
  if (!story || Array.isArray(story) || typeof story !== 'object'
    || !('passes' in story)) throw new Error(`Wave fixture story ${storyId} is unavailable`);
  story.passes = passes;
}

function storyEvidence() {
  return {
    id: 17,
    story_id: STORY_ID,
    status: 'pass',
    reason: null,
    finished_at: new Date('2026-07-26T10:29:02.329Z'),
    spec_id: SPEC_ID,
    integrated: true,
    commit_sha: terminalSha,
    commit_message: `integrate ${STORY_ID}`,
    commit_author: 'rorca-execution-engine',
    commit_branch: 'feat/isolated-proof',
    commit_observed_source: 'worktree_branch',
    worktree_path: fs.realpathSync(worktree),
    closeout_decision_id: 'closeout-e2e-001',
    manifest_hash: `sha256:${'1'.repeat(64)}`,
    closeout_status: 'accepted',
    closeout_manifest_hash: `sha256:${'1'.repeat(64)}`,
    attestation_count: 1,
    attestation_id: '11111111-1111-4111-8111-111111111111',
    attestation_digest: 'd'.repeat(64),
    attestation_passed_at: new Date('2026-07-26T10:29:02.329Z'),
    attestation_expires_at: new Date('2099-08-02T10:29:02.329Z'),
    attestation_revoked_at: null,
    accounting_required: false,
    accounting_model: null,
    accounting_input_tokens: null,
    accounting_output_tokens: null,
    accounting_reasoning_tokens: null,
    accounting_cost_usd: null,
    accounting_cost_source: null,
    accounting_input_rate: null,
    accounting_output_rate: null,
    projected_accounting_model: null,
    projected_accounting_input_tokens: null,
    projected_accounting_output_tokens: null,
    projected_accounting_reasoning_tokens: null,
    projected_accounting_cost_usd: null,
    projected_accounting_cost_source: null,
    projected_accounting_input_rate: null,
    projected_accounting_output_rate: null,
    accounting_count: 0,
    result_provenance: 'host',
    result_source: 'execution-engine',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-closeout-preview-'));
  workspace = path.join(root, 'repository');
  worktree = path.join(root, 'run-worktree');
  git(root, 'clone', '-q', SOURCE_REPOSITORY, workspace);
  git(workspace, 'remote', 'set-url', 'origin', 'https://github.com/getrorca/rorca.git');
  git(workspace, 'config', 'user.email', 'test@rorca.invalid');
  git(workspace, 'config', 'user.name', 'Rorca Test');
  git(workspace, 'checkout', '-q', '-B', 'main');
  git(workspace, 'worktree', 'add', '-q', '-b', 'feat/isolated-proof', worktree);
  fs.writeFileSync(path.join(worktree, 'story.txt'), 'story\n');
  git(worktree, 'add', 'story.txt');
  git(worktree, 'commit', '-q', '-m', 'story');
  terminalSha = git(worktree, 'rev-parse', 'HEAD').toLowerCase();
  runSpecPath = path.join(worktree, '.rorca', 'run-specs', `run-${RUN_ID}.json`);
  fs.mkdirSync(path.dirname(runSpecPath), { recursive: true });
  const canonicalProjection: unknown = JSON.parse(fs.readFileSync(path.join(workspace, SPEC_PATH), 'utf8'));
  setStoryPassFlag(canonicalProjection, STORY_ID, true);
  fs.writeFileSync(runSpecPath, `${JSON.stringify(canonicalProjection, null, 2)}\n`);

  const effectiveOptions = {
    model: null,
    effort: null,
    worktree: { enabled: true, path: worktree, branch: 'feat/isolated-proof' },
    merge: { strategy: 'branch-only', autoMerge: false },
    graph: { enabled: false },
    terminal: 'ansi-html',
    safety: {
      guard: 'autonomous-command-guard-v1',
      allowBackendJest: false,
      deploy: false,
      externalSend: false,
      policyLocked: true,
      ordinaryLocalPi: false,
    },
  };
  runRow = {
    id: RUN_ID,
    workspace_id: WORKSPACE_ID,
    spec_path: SPEC_PATH,
    status: 'failed',
    lifecycle_status: 'failed',
    lifecycle_diagnostics: { owner: 'worker', reason: 'worker_closeout_failed' },
    lifecycle_updated_at: new Date('2026-07-26T10:30:00.000Z'),
    summary: 'worker_closeout_failed',
    started_at: new Date('2026-07-26T10:20:00.000Z'),
    finished_at: new Date('2026-07-26T10:30:00.000Z'),
    expected_story_ids: [STORY_ID],
    excluded_story_ids: [],
    branch_name: 'feat/isolated-proof',
    worktree_path: worktree,
    execution_workspace_path: fs.realpathSync(workspace),
    execution_worktree_path: fs.realpathSync(worktree),
    terminal_checkout_sha: null,
    terminal_checkout_attested_at: null,
    host_closeout_event_id: null,
    merge_strategy: 'branch-only',
    auto_merge: false,
    effective_options: effectiveOptions,
    dispatch_request_hash: `sha256:${'2'.repeat(64)}`,
    dispatch_effective_options_hash: retryHash(effectiveOptions),
    retried_from_run_id: null,
    pid: 999_999_991,
    opencode_server_pid: null,
    worker_id: 'historical-worker',
    last_heartbeat: new Date('2026-07-26T10:30:00.000Z'),
    dispatch_owner: null,
    dispatch_lease_expires_at: null,
    worktree_cleanup_status: 'not_started',
    worktree_cleaned_at: null,
    pr_number: null,
    merge_status: null,
    merge_commit_sha: null,
    workspace_path: workspace,
  };
  activeJobs = [];

  inspectRunHostAuthority.mockResolvedValue({
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    specId: SPEC_ID,
    status: 'failed',
    lifecycleStatus: 'failed',
    finishedAt: '2026-07-26T10:30:00.000Z',
    branchName: 'feat/isolated-proof',
    checkoutPath: fs.realpathSync(worktree),
    repositoryTopLevel: fs.realpathSync(workspace),
    expectedStoryIds: [STORY_ID],
    excludedStoryIds: [],
    stories: [{ storyId: STORY_ID, status: 'pass', reason: null, finishedAt: '2026-07-26T10:29:02.329Z', resultId: 17, commitSha: terminalSha }],
    authoritativePassedStoryIds: [STORY_ID],
    finalCommitSha: terminalSha,
    closeoutEligible: true,
    terminalRevision: terminalSha,
    integrationAncestry: [terminalSha],
    acceptedStoryIds: [STORY_ID],
    complete: true,
    releaseEligible: true,
    invalidReason: null,
  });
  transaction.mockImplementation(async (operation: (client: { query: jest.Mock }) => Promise<unknown>) => operation({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }));
  queryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('statement_timestamp()') && sql.includes('now_exact')) return { now_exact: '2026-07-27T00:00:00.000000Z' };
    if (sql.includes('FROM pipeline_runs run') && sql.includes('JOIN workspaces workspace')) return runRow;
    if (sql.includes('FROM pipeline_dispatch_publications')) return {
      state: 'failed',
      boss_job_id: '22222222-2222-4222-8222-222222222222',
      request_hash: runRow.dispatch_request_hash,
      effective_options_hash: runRow.dispatch_effective_options_hash,
      payload_hash: `sha256:${'3'.repeat(64)}`,
      lease_owner: null,
      lease_expires_at: null,
      completed_at: new Date('2026-07-26T10:30:00.000Z'),
    };
    if (sql.includes('COUNT(*) AS count FROM pty_generations')) return { count: 0 };
    if (sql.includes('COUNT(*) AS count FROM pipeline_run_cancellation_requests')) return { count: 0 };
    if (sql.includes('governed_retry_dispatches')) return { dispatch_count: 0, child_count: 0 };
    if (sql.includes('SELECT * FROM pipeline_run_release_intents')) return undefined;
    if (sql.includes('COUNT(*) AS count FROM github_check_run_projections')) return { count: 0 };
    return undefined;
  });
  query.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('DISTINCT ON (result.story_id)')) return [storyEvidence()];
    if (sql.includes("trusted_source = 'story-result'")) return [{
      id: 117,
      event_type: 'story_passed',
      workspace_id: WORKSPACE_ID,
      spec_id: SPEC_ID,
      story_id: STORY_ID,
      canonical_run_id: RUN_ID,
      story_result_id: 17,
      trust_provenance: 'host',
      trusted_source: 'story-result',
      event_identity_hash: 'e'.repeat(64),
      ingest_key: `trusted-wal:v1:${'e'.repeat(64)}`,
      payload: { run_id: RUN_ID, story_id: STORY_ID, story_result_id: 17 },
      outbox_ready_at: new Date('2026-07-26T10:29:02.329Z'),
      outbox_relayed_at: new Date('2026-07-26T10:29:03.000Z'),
    }];
    if (sql.includes("event_type = 'run_process_finished'")) return [{
      id: 118,
      ts: new Date('2026-07-26T10:30:00.000Z'),
      trust_provenance: 'untrusted',
      event_identity_hash: null,
      payload: { run_id: RUN_ID, status: 'failed', exit_code: 0, exit_signal: null, source: 'worker' },
    }];
    if (sql.includes('FROM run_pty_sessions')) return [];
    if (sql.includes('.job') && sql.includes('pipeline:closeout-reconcile')) return activeJobs;
    if (sql.includes("event_type = 'run_closeout'")) return [];
    if (sql.includes("event_type = 'run_finished'")) return [];
    return [];
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects protected Genesis before any run/evidence read or lock', async () => {
  await expect(previewRunCloseoutReconciliation({
    runId: 20260316000549,
    workspaceId: 'genesis-workspace',
  })).rejects.toMatchObject({
    code: 'WAVE_1_INTAKE_BLOCKED',
    details: { reason: 'PROTECTED_GENESIS_RUN' },
  });
  expect(query).not.toHaveBeenCalled();
  expect(queryOne).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  expect(inspectRunHostAuthority).not.toHaveBeenCalled();
});

test('builds a deterministic exact preview with fractional timestamps, frozen no-send posture, and zero owners', async () => {
  const first = await previewRunCloseoutReconciliation({ runId: RUN_ID, workspaceId: WORKSPACE_ID });
  const second = await previewRunCloseoutReconciliation({ runId: RUN_ID, workspaceId: WORKSPACE_ID });
  expect(second).toEqual(first);
  expect(first.eligible).toBe(true);
  expect(first.canonicalTargetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(first.target.immutableAuthorityHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(first.target.originalProjection).toMatchObject({
    status: 'failed', lifecycleStatus: 'failed', summary: 'worker_closeout_failed',
  });
  expect(first.target.immutableAuthority).toMatchObject({
    scope: { expectedStoryIds: [STORY_ID], excludedStoryIds: [] },
    canonicalSpec: { hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    runSpec: { hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) },
    processFinished: { id: 118, exitCode: 0, observedStatus: 'failed' },
    dispatch: {
      mergeStrategy: 'branch-only', autoMerge: false, externalSend: false, deploy: false,
    },
    git: {
      branch: 'feat/isolated-proof', terminalHead: terminalSha,
      orderedIntegrationAncestry: [terminalSha],
    },
    earliestEvidenceExpiry: '2099-08-02T10:29:02.329Z',
  });
  const stories = first.target.immutableAuthority.stories as Array<Record<string, unknown>>;
  expect(stories[0]).toMatchObject({
    result: { id: 17 },
    attestation: { passedAt: '2026-07-26T10:29:02.329Z', expiresAt: '2099-08-02T10:29:02.329Z' },
    storyPassWal: { id: 117, identityHash: 'e'.repeat(64) },
  });
  expect(first.target.ownership).toMatchObject({
    activeJobs: [], cancellationRequestCount: 0,
    governedRetryDispatchCount: 0, retryChildCount: 0,
  });
  expect(first.target.existingOutputs).toMatchObject({
    hostCloseouts: [], releaseIntent: null, terminalEvents: [], githubCheckProjectionCount: 0,
  });
});

test('fails closed while a direct-lane execution transport owns the exact run', async () => {
  activeJobs = [{ id: '33333333-3333-4333-8333-333333333333', name: 'pipeline:run:direct', state: 'active' }];
  await expect(previewRunCloseoutReconciliation({ runId: RUN_ID, workspaceId: WORKSPACE_ID }))
    .rejects.toThrow('still has execution, PTY, job, cancellation, or retry ownership');
});

test('fails closed on run-local spec projection drift', async () => {
  const driftedProjection: unknown = JSON.parse(fs.readFileSync(runSpecPath, 'utf8'));
  setStoryPassFlag(driftedProjection, STORY_ID, false);
  fs.writeFileSync(runSpecPath, JSON.stringify(driftedProjection));
  await expect(previewRunCloseoutReconciliation({ runId: RUN_ID, workspaceId: WORKSPACE_ID }))
    .rejects.toThrow('run spec projection lifecycle flags lack host authority');
});
