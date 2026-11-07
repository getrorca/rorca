/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { resetDisposableWave1Database } from './wave1-test-cleanup';
import type { handlePipelineRetry as HandlePipelineRetry } from '../../worker';
import type {
  requestGovernedRetryRunCancellation as RequestGovernedRetryRunCancellation,
} from '../../lib/governed-retry-publication';
import type { closePool as ClosePool, query as RuntimeQuery } from '../../db/index';

const inspectRunHostAuthority = jest.fn();
jest.mock('../../lib/run-host-authority', () => ({
  hasExactHostTimestampPrecisionCapability: () => true,
  inspectRunHostAuthority: (...args: unknown[]) => inspectRunHostAuthority(...args),
}));
jest.mock('../../lib/autonomous-sandbox', () => {
  const actual = jest.requireActual('../../lib/autonomous-sandbox');
  return { ...actual, assertAutonomousExecutionBoundary: jest.fn() };
});
jest.mock('../../lib/autonomous-model-egress', () => {
  const actual = jest.requireActual('../../lib/autonomous-model-egress');
  return {
    ...actual,
    ensureAutonomousModelEgress: async () => null,
    closeAutonomousModelEgress: async () => undefined,
  };
});

import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';
import {
  compareRetryPlanToPreview,
  createRetryPreview,
  retryHash,
  type RetryPreviewPacket,
} from '../../lib/retry-governance';
import {
  createGovernedRetryDispatchIdentity,
  governedRetryQueuePayloadHash,
} from '../../lib/governed-story-retry';
import { deriveStoryContractRevision } from '../../lib/story-execution-packet';
import { deriveStoryExecutionManifestPath } from '../../lib/run-spec-snapshot';

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  RORCA_PROCESS_ROLE: process.env.RORCA_PROCESS_ROLE,
  RORCA_TEST_DATABASE_WORKSPACE_SCOPE: process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE,
  RORCA_TEST_EXECUTION_ENGINE_ENTRYPOINT: process.env.RORCA_TEST_EXECUTION_ENGINE_ENTRYPOINT,
  RORCA_TEST_RETRY_PROCESS_AUDIT: process.env.RORCA_TEST_RETRY_PROCESS_AUDIT,
  RORCA_TEST_RETRY_LEASE_RENEWAL_MS: process.env.RORCA_TEST_RETRY_LEASE_RENEWAL_MS,
  RORCA_TEST_RETRY_PROVIDER_DELAY_MS: process.env.RORCA_TEST_RETRY_PROVIDER_DELAY_MS,
};
const suiteWorkspaceId = `retry-worker-${randomUUID()}`;
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = suiteWorkspaceId;
resolveTestDatabaseUrl();
const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 6,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${suiteWorkspaceId}`,
});
const { handlePipelineRetry } = require('../../worker') as {
  handlePipelineRetry: typeof HandlePipelineRetry;
};
const { requestGovernedRetryRunCancellation } = require('../../lib/governed-retry-publication') as {
  requestGovernedRetryRunCancellation: typeof RequestGovernedRetryRunCancellation;
};
const { query: runtimeQuery, closePool } = require('../../db/index') as {
  query: typeof RuntimeQuery;
  closePool: typeof ClosePool;
};

function restoreEnvironment(name: keyof typeof originalEnvironment): void {
  const value = originalEnvironment[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
const SPEC_ID = 'retry-worker-composition-proof';
const SPEC_PATH = `forge/specs/approved/${SPEC_ID}.json`;
const fakeEngine = path.resolve(__dirname, 'fixtures/retry-worker-engine.js');
let root: string;
let repository: string;
let worktree: string;
let head: string;
let sequence = 8_600_000;

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

interface Fixture {
  workspaceId: string;
  originalRunId: number;
  runId: number;
  preview: RetryPreviewPacket;
  identityHash: string;
  payload: Record<string, unknown>;
  jobId: string;
  auditPath: string;
  retrySpecPath: string;
  manifestHash: string;
}

function processEvents(auditPath: string): Array<{ type: string; pid?: number; enginePid?: number }> {
  if (!fs.existsSync(auditPath)) return [];
  return fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; pid?: number; enginePid?: number });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for retry worker process evidence');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap((nested) => errorMessages(nested))];
  }
  return [error instanceof Error ? error.message : String(error)];
}

async function expectHandlerSuccess(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    throw new Error(errorMessages(error).join('\n'), { cause: error });
  }
}

async function expectHandlerFailure(operation: Promise<void>, pattern: RegExp): Promise<void> {
  try {
    await operation;
    throw new Error('expected retry handler to fail');
  } catch (error) {
    expect(errorMessages(error).join('\n')).toMatch(pattern);
  }
}

async function seedFixture(options: {
  mixed?: boolean;
  runStatus?: 'queued' | 'running';
  runPid?: number | null;
  dispatchState?: 'prepared' | 'dispatched' | 'claimed' | 'executing';
  leaseOwner?: string | null;
  leaseExpired?: boolean;
  previewPublished?: boolean;
} = {}): Promise<Fixture> {
  const originalRunId = sequence++;
  const runId = sequence++;
  const workspaceId = suiteWorkspaceId;
  const auditPath = path.join(root, `audit-${runId}.ndjson`);
  const canonicalSpec = {
    id: SPEC_ID,
    userStories: options.mixed
      ? [
          { id: 'PASSED', title: 'passed', description: 'must not rerun', passes: true },
          { id: 'FAILED', title: 'failed', description: 'retry only this story', passes: false },
        ]
      : [{ id: 'FAILED', title: 'failed', description: 'retry this story', passes: false }],
  };
  const retrySpec = {
    ...canonicalSpec,
    userStories: canonicalSpec.userStories.map((story) => story.id === 'FAILED'
      ? { ...story, excluded: false }
      : { ...story, excluded: true }),
  };
  const canonicalPath = path.join(repository, SPEC_PATH);
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  fs.writeFileSync(canonicalPath, `${JSON.stringify(canonicalSpec, null, 2)}\n`);
  const retrySpecPath = path.join(worktree, '.rorca', 'run-specs', `run-${runId}.json`);
  fs.mkdirSync(path.dirname(retrySpecPath), { recursive: true });
  fs.writeFileSync(retrySpecPath, `${JSON.stringify(retrySpec, null, 2)}\n`);

  const scope = {
    requested: [{ storyId: 'FAILED', reasonCode: 'REQUESTED_FAILED_STORY' as const }],
    requiredDependency: [],
    copiedPassed: options.mixed
      ? [{ storyId: 'PASSED', reasonCode: 'PASSED_RESULT_COPIED_NOT_EXECUTABLE' as const }]
      : [],
    skipped: [],
    executable: [{ storyId: 'FAILED', reasonCode: 'EXECUTABLE_RETRY_WORK' as const }],
    remaining: [],
    excluded: [],
  };
  const preview = createRetryPreview({
    originalRunId,
    scope,
    options: {
      agent: 'pi', model: null, effort: null, terminalMode: 'ansi-html', includeGraph: false,
      worktree: { enabled: true, path: worktree, branch: 'retry-worker-proof' },
      merge: { strategy: 'branch-only', autoMerge: false },
      safety: { deploy: false, externalSend: false, policyLocked: false, allowBackendJest: false },
    },
    forceSequential: true,
    requiresApproval: false,
  });
  const plan = compareRetryPlanToPreview(retrySpec, preview);
  if (!plan.matches) throw new Error('composition fixture retry plan is invalid');
  const manifestHash = `sha256:${randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64)}`;
  const manifestPath = deriveStoryExecutionManifestPath({ runId, executionRoot: worktree });
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify([{
    manifestHash,
    execution: { agent: 'pi', model: null },
  }]));
  const executionManifestHash = retryHash([manifestHash]);
  const scopeHash = retryHash(['FAILED']);
  const canonicalRevision = deriveStoryContractRevision(canonicalSpec);
  await ownerPool.query(
    'INSERT INTO workspaces(id,label,path) VALUES($1,$1,$2) ON CONFLICT (id) DO NOTHING',
    [workspaceId, repository],
  );
  const compiledPlanId = (await ownerPool.query<{ id: string }>(`
    INSERT INTO ssdlc_compiled_plans(
      workspace_id,spec_slug,spec_version,compiler_version,normalized_input_hash,
      schema_version,plan_json,provenance_json,validation_status,validated_at,is_current
    ) VALUES($1,$2,$3,'retry-worker-composition',$4,'plan.v1','{}'::jsonb,$5::jsonb,
      'validated',NOW(),TRUE)
    RETURNING id::text`, [
    workspaceId, SPEC_ID, canonicalRevision, retryHash({ runId, plan: true }),
    JSON.stringify({ specHash: canonicalRevision }),
  ])).rows[0].id;
  const lifecycleDispatchClaim = {
    schemaVersion: 'lifecycle-dispatch-claim.v1' as const,
    claimId: randomUUID(),
    workspaceId,
    specId: SPEC_ID,
    specHash: canonicalRevision,
    compiledPlanId,
    requestIdentity: `pipeline:retry:${preview.previewHash}`,
    requestHash: retryHash({ runId, previewHash: preview.previewHash }),
  };
  await ownerPool.query(`INSERT INTO ssdlc_lifecycle_dispatch_claims(
    claim_id,workspace_id,spec_slug,spec_hash,compiled_plan_id,request_identity,request_hash
  ) VALUES($1,$2,$3,$4,$5::bigint,$6,$7)`, [
    lifecycleDispatchClaim.claimId, workspaceId, SPEC_ID, canonicalRevision, compiledPlanId,
    lifecycleDispatchClaim.requestIdentity, lifecycleDispatchClaim.requestHash,
  ]);
  const queueAuthority: Record<string, unknown> = {
    runId, executionTimeoutSeconds: 1_209_600, originalRunId, storyIds: ['FAILED'], scopeHash,
    previewHash: preview.previewHash, approvedPreview: preview,
    generatedPlanHash: plan.scopeHash, taskManifestLineageHash: null,
    workspacePath: repository, specPath: SPEC_PATH, runSpecPath: retrySpecPath,
    retrySpecPath, agent: 'pi', model: null, worktreePath: worktree, branchName: 'retry-worker-proof',
    terminalMode: 'ansi-html', orchestrationMode: 'sequential', parallelism: 1,
    sequenceOffset: 0, executionManifestPath: manifestPath, envOverrides: {},
    includeGraph: false, triggerOptions: { lifecycleDispatchClaim },
  };
  const queuePayloadHash = governedRetryQueuePayloadHash(queueAuthority);
  const identity = createGovernedRetryDispatchIdentity({
    workspaceId, specId: SPEC_ID, specRevision: canonicalRevision,
    originalRunId, originalRunLineage: [originalRunId], retryRunId: runId,
    baseRevision: head, integratedRevision: head, priorIntegrationAncestry: [head],
    recoveryRef: 'HEAD', recoveryRefRevision: head, fencingToken: 1,
    leaseIdentity: retryHash({ runId, lease: 'composition' }),
    idempotencyKey: `retry-worker-composition:${runId}`, queueName: 'pipeline:retry',
    queuePayloadHash, executionManifestHash, approvedPreviewHash: preview.previewHash,
    scopeHash, evidenceHash: retryHash({ runId, evidence: true }),
    taskManifestLineageHash: null,
    storyAttempts: [{
      storyId: 'FAILED', attempt: 2, previousAttempt: 1, sourceRunId: originalRunId,
      idempotencyKey: `retry-worker-story:${runId}:FAILED:2`,
    }],
    carriedForward: options.mixed ? [{
      storyId: 'PASSED', sourceRunId: originalRunId, sourceAttempt: 1,
      resultIdentity: `result:${originalRunId}:PASSED`, sourceCommit: head,
      resultingHead: head, integrationOrder: 0, reasonCode: 'ACCEPTED_INTEGRATED_SIBLING',
    }] : [],
  });
  const payload = { ...queueAuthority, dispatchIdentity: identity };
  const jobId = randomUUID();
  const dispatchState = options.dispatchState ?? 'prepared';
  const previewPublished = options.previewPublished ?? dispatchState !== 'prepared';
  const leaseOwner = options.leaseOwner ?? (['claimed', 'executing'].includes(dispatchState) ? 'crashed-worker' : null);

  await ownerPool.query(`INSERT INTO pipeline_runs(
    id,spec_path,workspace_id,status,lifecycle_status,finished_at,branch_name,
    execution_workspace_path,execution_worktree_path,expected_story_ids,excluded_story_ids
  ) VALUES($1,$2,$3,'partial_failure','failed',NOW(),'main',$4,$4,$5::text[],'{}'::text[])`,
  [originalRunId, SPEC_PATH, workspaceId, repository, options.mixed ? ['PASSED', 'FAILED'] : ['FAILED']]);
  const effectiveOptions = {
    model: null,
    effort: null,
    worktree: { enabled: true, path: worktree, branch: 'retry-worker-proof' },
    merge: { strategy: 'branch-only', autoMerge: false },
    safety: {
      ordinaryLocalPi: true,
      allowBackendJest: false,
      deploy: false,
      externalSend: false,
      policyLocked: false,
    },
    terminal: 'ansi-html',
    runtime: {
      piExecutable: {
        piBinPath: process.execPath,
        piRealPath: fs.realpathSync(process.execPath),
      },
    },
  };
  await ownerPool.query(`INSERT INTO pipeline_runs(
    id,spec_path,workspace_id,status,lifecycle_status,retried_from_run_id,parallelism,
    terminal_mode,branch_name,worktree_path,execution_workspace_path,execution_worktree_path,
    expected_story_ids,excluded_story_ids,dispatch_fence,pid,canonical_spec_revision,
    run_spec_path,run_spec_revision,effective_options,agent_type,execution_environment,
    orchestration_mode,trigger_options
  ) VALUES($1,$2,$3,$4,$4,$5,1,'ansi-html','retry-worker-proof',$6,$7,$6,$8::text[],'{}'::text[],
    $9,$10,$11,$12,$13,$14::jsonb,'pi','remote-rorca','sequential',$15::jsonb)`, [
    runId, SPEC_PATH, workspaceId, options.runStatus ?? 'queued', originalRunId,
    worktree, repository, ['FAILED'], `sha256:${'a'.repeat(64)}`, options.runPid ?? null,
    canonicalRevision, retrySpecPath, deriveStoryContractRevision(retrySpec), JSON.stringify(effectiveOptions),
    JSON.stringify({ lifecycleDispatchClaim }),
  ]);
  await ownerPool.query(`INSERT INTO pipeline_retry_previews(
    preview_hash,original_run_id,retry_run_id,workspace_id,scope_hash,status,packet,
    preview_identity_hash,expires_at,idempotency_key,approved_at,preparation_state,
    preparation_generation,boss_job_id
  ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW()+INTERVAL '10 minutes',$9,NOW(),$10,1,$11)`, [
    preview.previewHash, originalRunId, runId, workspaceId, scopeHash,
    previewPublished ? 'dispatched' : 'approved', JSON.stringify(preview),
    retryHash({ preview: preview.previewHash }), `retry-worker-preview:${runId}`,
    previewPublished ? 'published' : 'outbox_ready', previewPublished ? jobId : null,
  ]);
  await ownerPool.query(`INSERT INTO story_execution_manifests(
    manifest_hash,schema_version,workspace_id,spec_id,run_id,story_id,attempt,
    spec_revision,story_revision,payload
  ) VALUES($1,'rorca.story-execution-manifest.v2',$2,$3,$4,'FAILED',2,$5,$6,'{}'::jsonb)`, [
    manifestHash, workspaceId, SPEC_ID, runId, deriveStoryContractRevision(retrySpec), deriveStoryContractRevision(retrySpec.userStories.at(-1)),
  ]);
  await ownerPool.query(`INSERT INTO governed_retry_dispatches(
    identity_hash,workspace_id,spec_id,spec_revision,original_run_id,retry_run_id,
    original_run_lineage,base_revision,integrated_revision,prior_integration_ancestry,
    recovery_ref,recovery_ref_revision,preview_hash,scope_hash,evidence_hash,
    execution_manifest_hash,queue_payload_hash,job_payload,queue_name,idempotency_key,
    lease_identity,state,boss_job_id,lease_owner,lease_expires_at,fencing_token
  ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8,$9::jsonb,'HEAD',$8,$10,$11,$12,
    $13,$14,$15::jsonb,'pipeline:retry',$16,$17,$18,$19,$20,$21,1)`, [
    identity.identityHash, workspaceId, SPEC_ID, canonicalRevision, originalRunId, runId,
    JSON.stringify([originalRunId]), head, JSON.stringify([head]), preview.previewHash,
    scopeHash, identity.evidenceHash, executionManifestHash, queuePayloadHash,
    JSON.stringify(payload), identity.idempotencyKey, identity.leaseIdentity, dispatchState,
    dispatchState === 'prepared' ? null : jobId, leaseOwner,
    leaseOwner ? (options.leaseExpired ? new Date(Date.now() - 1_000) : new Date(Date.now() + 300_000)) : null,
  ]);
  await ownerPool.query(`INSERT INTO governed_retry_story_attempts(
    attempt_identity,dispatch_identity_hash,workspace_id,spec_id,original_root_run_id,
    source_run_id,retry_run_id,story_id,attempt,previous_attempt,idempotency_key,
    manifest_hash,state,recovery_ref
  ) VALUES($1,$2,$3,$4,$5,$5,$6,'FAILED',2,1,$7,$8,$9,'HEAD')`, [
    retryHash(identity.storyAttempts[0]), identity.identityHash, workspaceId, SPEC_ID,
    originalRunId, runId, identity.storyAttempts[0].idempotencyKey, manifestHash,
    dispatchState === 'executing' ? 'executing' : 'pending',
  ]);
  if (options.mixed) {
    await ownerPool.query(`INSERT INTO governed_retry_carry_forward(
      dispatch_identity_hash,story_id,source_run_id,source_attempt,result_identity,
      source_commit,resulting_head,integration_order,reason_code
    ) VALUES($1,'PASSED',$2,1,$3,$4,$4,0,'ACCEPTED_INTEGRATED_SIBLING')`,
    [identity.identityHash, originalRunId, `result:${originalRunId}:PASSED`, head]);
  }
  return { workspaceId, originalRunId, runId, preview, identityHash: identity.identityHash,
    payload, jobId, auditPath, retrySpecPath, manifestHash };
}

function job(fixture: Fixture, id = fixture.jobId) {
  return { id, name: 'pipeline:retry', data: fixture.payload } as never;
}

// Canonical run artifacts are immutable evidence. Retain them between scenarios
// so the shared reusable worktree exercises the production classification path.
async function cleanup(fixture: Fixture): Promise<void> {
  await resetDisposableWave1Database(ownerPool);
  fs.rmSync(fixture.auditPath, { force: true });
}

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-retry-worker-db-')));
  repository = path.join(root, 'repository');
  fs.mkdirSync(repository);
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'test@rorca.invalid'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Rorca Test'], { cwd: repository });
  fs.writeFileSync(path.join(repository, 'README.md'), 'retry worker proof\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repository });
  execFileSync('git', ['commit', '-q', '-m', 'retry worker proof'], { cwd: repository });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: repository });
  worktree = path.join(root, 'worktree');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'retry-worker-proof', worktree], { cwd: repository });
  repository = fs.realpathSync(repository);
  worktree = fs.realpathSync(worktree);
  head = git(['rev-parse', 'HEAD']);
  process.env.RORCA_TEST_EXECUTION_ENGINE_ENTRYPOINT = fakeEngine;
  process.env.RORCA_TEST_RETRY_LEASE_RENEWAL_MS = '1000';
  process.env.RORCA_TEST_RETRY_PROVIDER_DELAY_MS = '80';
  inspectRunHostAuthority.mockImplementation(async (runId: number) => {
    const run = (await ownerPool.query<{ workspace_id: string; status: string; lifecycle_status: string }>(
      'SELECT workspace_id,status,lifecycle_status FROM pipeline_runs WHERE id=$1', [runId],
    )).rows[0];
    if (!run) return null;
    return {
      runId, workspaceId: run.workspace_id, specId: SPEC_ID, status: run.status,
      lifecycleStatus: run.lifecycle_status, finishedAt: null, branchName: 'retry-worker-proof',
      checkoutPath: worktree, repositoryTopLevel: repository,
      expectedStoryIds: ['FAILED'], excludedStoryIds: [], stories: [], authoritativePassedStoryIds: [],
      finalCommitSha: null, closeoutEligible: true, terminalRevision: head,
      integrationAncestry: [head], acceptedStoryIds: [], complete: false,
      releaseEligible: false, invalidReason: null,
    };
  });
});

afterAll(async () => {
  try {
    await resetDisposableWave1Database(ownerPool);
  } finally {
    try {
      await closePool();
    } finally {
      try {
        await ownerPool.end();
      } finally {
        try {
          if (root) fs.rmSync(root, { recursive: true, force: true });
        } finally {
          restoreEnvironment('NODE_ENV');
          restoreEnvironment('RORCA_PROCESS_ROLE');
          restoreEnvironment('RORCA_TEST_DATABASE_WORKSPACE_SCOPE');
          restoreEnvironment('RORCA_TEST_EXECUTION_ENGINE_ENTRYPOINT');
          restoreEnvironment('RORCA_TEST_RETRY_PROCESS_AUDIT');
          restoreEnvironment('RORCA_TEST_RETRY_LEASE_RENEWAL_MS');
          restoreEnvironment('RORCA_TEST_RETRY_PROVIDER_DELAY_MS');
        }
      }
    }
  }
});

test('runtime worker principal stays bound to the suite workspace and denies cross-workspace rows', async () => {
  const foreignWorkspaceId = `${suiteWorkspaceId}-foreign`;
  await ownerPool.query(
    'INSERT INTO workspaces(id,label,path) VALUES($1,$1,$2)',
    [foreignWorkspaceId, repository],
  );
  await ownerPool.query(
    `INSERT INTO governed_spec_authority_snapshots(
       workspace_id,spec_id,spec_version,spec_hash,canonical_spec_path,repository_id,
       repository_sha,approval_receipt_hash,lifecycle_state)
     VALUES($1,'foreign-spec',1,$2,'forge/specs/approved/foreign.json','foreign-repository',
       $3,$4,'approved')`,
    [
      foreignWorkspaceId,
      `sha256:${'1'.repeat(64)}`,
      '2'.repeat(40),
      `sha256:${'3'.repeat(64)}`,
    ],
  );
  try {
    const runtimeAuthority = (await runtimeQuery<{
      current_user: string;
      principal_class: string;
      workspace_id: string;
    }>(`SELECT current_user,
        (SELECT principal_class FROM wave2_database_principals WHERE database_user=current_user) principal_class,
        current_setting('rorca.workspace_id',TRUE) workspace_id`))[0];
    const ownerAuthority = (await ownerPool.query<{ current_user: string; principal_class: string }>(
      `SELECT current_user,
        (SELECT principal_class FROM wave2_database_principals WHERE database_user=current_user) principal_class`,
    )).rows[0];
    console.info(
      `[principal-map] suite=governed-retry-worker-composition migration_owner=${ownerAuthority.current_user} `
      + `internal_runtime=${runtimeAuthority.current_user} workspace=${suiteWorkspaceId}`,
    );
    expect(runtimeAuthority).toMatchObject({
      principal_class: 'internal_runtime',
      workspace_id: suiteWorkspaceId,
    });
    expect(ownerAuthority.principal_class).toBe('migration_owner');
    expect(runtimeAuthority.current_user).not.toBe(ownerAuthority.current_user);
    expect(await runtimeQuery(
      'SELECT spec_id FROM governed_spec_authority_snapshots WHERE workspace_id=$1',
      [foreignWorkspaceId],
    )).toEqual([]);
  } finally {
    await resetDisposableWave1Database(ownerPool);
  }
});

test('actual retry handler fences duplicate delivery to one engine and one provider PID', async () => {
  const fixture = await seedFixture();
  process.env.RORCA_TEST_RETRY_PROCESS_AUDIT = fixture.auditPath;
  try {
  await expectHandlerSuccess(Promise.all([
    handlePipelineRetry([job(fixture)]),
    handlePipelineRetry([job(fixture, randomUUID())]),
  ]));
  const events = processEvents(fixture.auditPath);
  expect(events.filter((event) => event.type === 'engine')).toHaveLength(1);
  expect(events.filter((event) => event.type === 'provider')).toHaveLength(1);
  expect(new Set(events.filter((event) => event.type === 'provider').map((event) => event.pid)).size).toBe(1);
  } finally {
    await cleanup(fixture);
  }
});

test('actual retry handler loses a lease deterministically without a second provider', async () => {
  const fixture = await seedFixture();
  process.env.RORCA_TEST_RETRY_PROCESS_AUDIT = fixture.auditPath;
  process.env.RORCA_TEST_RETRY_PROVIDER_DELAY_MS = '1000';
  process.env.RORCA_TEST_RETRY_LEASE_RENEWAL_MS = '100';
  try {
    const running = handlePipelineRetry([job(fixture)]);
    await waitFor(() => processEvents(fixture.auditPath).some((event) => event.type === 'provider'));
    const ownerClient = await ownerPool.connect();
    try {
      await ownerClient.query('BEGIN');
      await ownerClient.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`pipeline-run-authority:${fixture.runId}`],
      );
      await ownerClient.query(`UPDATE governed_retry_dispatches SET lease_owner='stolen-owner'
        WHERE identity_hash=$1 AND state='executing'`, [fixture.identityHash]);
      await ownerClient.query('COMMIT');
    } catch (error) {
      await ownerClient.query('ROLLBACK');
      throw error;
    } finally {
      ownerClient.release();
    }
    await running;
    const events = processEvents(fixture.auditPath);
    expect(events.filter((event) => event.type === 'provider')).toHaveLength(1);
    expect((await ownerPool.query<{ state: string }>(
      'SELECT state FROM governed_retry_dispatches WHERE identity_hash=$1', [fixture.identityHash],
    )).rows[0].state).not.toBe('finalized');
  } finally {
    process.env.RORCA_TEST_RETRY_PROVIDER_DELAY_MS = '80';
    process.env.RORCA_TEST_RETRY_LEASE_RENEWAL_MS = '1000';
    await cleanup(fixture);
  }
});

test('actual retry handler refuses live PID restart and recovers only an expired dead PID generation', async () => {
  const fixture = await seedFixture({
    runStatus: 'running', runPid: process.pid, dispatchState: 'dispatched', previewPublished: true,
  });
  process.env.RORCA_TEST_RETRY_PROCESS_AUDIT = fixture.auditPath;
  try {
  await expectHandlerFailure(handlePipelineRetry([job(fixture)]), /prior fenced engine process is still alive/);
  expect(processEvents(fixture.auditPath).filter((event) => event.type === 'provider')).toHaveLength(0);
  await ownerPool.query(`UPDATE governed_retry_dispatches
    SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE identity_hash=$1`, [fixture.identityHash]);
  await ownerPool.query('UPDATE pipeline_runs SET pid=999999 WHERE id=$1', [fixture.runId]);
  await expectHandlerSuccess(handlePipelineRetry([job(fixture, randomUUID())]));
  expect(processEvents(fixture.auditPath).filter((event) => event.type === 'provider')).toHaveLength(1);
  } finally {
    await cleanup(fixture);
  }
});

test('actual retry handler recovers a crash before launch without duplicate provider execution', async () => {
  const fixture = await seedFixture({
    runStatus: 'running', runPid: 999999, dispatchState: 'executing',
    leaseOwner: 'crashed-worker', leaseExpired: true, previewPublished: true,
  });
  process.env.RORCA_TEST_RETRY_PROCESS_AUDIT = fixture.auditPath;
  try {
  await expectHandlerSuccess(handlePipelineRetry([job(fixture, randomUUID())]));
  expect(processEvents(fixture.auditPath).filter((event) => event.type === 'provider')).toHaveLength(1);
  } finally {
    await cleanup(fixture);
  }
});

test('actual retry handler reconciles crash-after-result/integration evidence without relaunch', async () => {
  const fixture = await seedFixture({
    runStatus: 'running', runPid: 999999, dispatchState: 'executing', leaseOwner: 'crashed-worker',
    leaseExpired: true, previewPublished: true,
  });
  process.env.RORCA_TEST_RETRY_PROCESS_AUDIT = fixture.auditPath;
  try {
  await ownerPool.query(`INSERT INTO story_results(
    run_id,story_id,status,reason,finished_at,result_provenance,result_source
  ) VALUES($1,'FAILED','fail','durable-result-before-crash',NOW(),'host','worker')`, [fixture.runId]);
  await ownerPool.query(`INSERT INTO story_integration_ledger(
    run_id,story_id,attempt,wave_index,integration_order,state,source_commit,
    source_base_commit,expected_parent_head,resulting_head,frozen_manifest_hash,
    validation_identity,finalization_identity,finalized_at
  ) VALUES($1,'FAILED',2,0,0,'finalized',$2,$2,$2,$2,$3,$4::jsonb,$5::jsonb,NOW())`, [
    fixture.runId, head, fixture.manifestHash.replace('sha256:', ''),
    JSON.stringify({ validator: 'crash-after-result' }),
    JSON.stringify({ idempotencyKey: `crash-after-result:${fixture.runId}` }),
  ]);
  await handlePipelineRetry([job(fixture, randomUUID())]);
  expect(processEvents(fixture.auditPath)).toHaveLength(0);
  expect((await ownerPool.query<{ state: string }>(
    'SELECT state FROM governed_retry_dispatches WHERE identity_hash=$1', [fixture.identityHash],
  )).rows[0].state).toBe('failed');
  await ownerPool.query('DELETE FROM story_integration_ledger WHERE run_id=$1', [fixture.runId]);
  } finally {
    await cleanup(fixture);
  }
});

test('actual retry handler cancellation and mixed scope never launch or persist a passed-story attempt', async () => {
  const cancelled = await seedFixture();
  process.env.RORCA_TEST_RETRY_PROCESS_AUDIT = cancelled.auditPath;
  try {
  await requestGovernedRetryRunCancellation({
    runId: cancelled.runId, workspaceId: cancelled.workspaceId,
    requestedBy: 'wave1-composition', reason: 'cancel before handler',
  });
  await handlePipelineRetry([job(cancelled)]);
  expect(processEvents(cancelled.auditPath)).toHaveLength(0);
  } finally {
    await cleanup(cancelled);
  }

  const mixed = await seedFixture({ mixed: true });
  process.env.RORCA_TEST_RETRY_PROCESS_AUDIT = mixed.auditPath;
  try {
  await handlePipelineRetry([job(mixed)]);
  expect(processEvents(mixed.auditPath).filter((event) => event.type === 'provider')).toHaveLength(1);
  const attempts = await ownerPool.query<{ story_id: string }>(
    'SELECT story_id FROM governed_retry_story_attempts WHERE dispatch_identity_hash=$1 ORDER BY story_id',
    [mixed.identityHash],
  );
  expect(attempts.rows.map((row) => row.story_id)).toEqual(['FAILED']);
  expect(attempts.rows.some((row) => row.story_id === 'PASSED')).toBe(false);
  } finally {
    await cleanup(mixed);
  }
});
