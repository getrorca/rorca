/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type PgBossInstance from 'pg-boss';
import { Pool } from 'pg';
import type * as ReconciliationModule from '../../lib/run-closeout-reconciliation';
import type * as ArtifactModule from '../../lib/closeout-reconciliation-artifact';
import type * as DatabaseModule from '../index';
import type * as TestDatabaseSafetyModule from '../../lib/test-db-safety';
import type * as RetryGovernanceModule from '../../lib/retry-governance';
import type * as GovernedStoryRetryModule from '../../lib/governed-story-retry';
import type * as TrustedWalModule from '../../lib/trusted-wal';
import type * as RunCloseoutAuthorityModule from '../../lib/run-closeout-authority';
import type * as PipelineCancellationModule from '../../lib/pipeline-cancellation';
import type * as ReleaseAuthorityModule from '../../lib/release-authority';
import type * as GovernedRetryPublicationModule from '../../lib/governed-retry-publication';
import type * as GovernedRetryLeaseModule from '../../lib/governed-retry-execution-lease';
import {
  WAVE_1_IMPLEMENTATION_BASELINE_SHA,
  WAVE_1_SOURCE_REPOSITORY,
  WAVE_1_SPEC_CONTENT_HASH,
} from '../../lib/wave-1-stabilization';

const inspectRunHostAuthority = jest.fn();
jest.mock('../../lib/run-host-authority', () => ({
  ...jest.requireActual('../../lib/run-host-authority'),
  hasExactHostTimestampPrecisionCapability: () => true,
  inspectRunHostAuthority: (...args: unknown[]) => inspectRunHostAuthority(...args),
}));

const RealPgBoss: typeof PgBossInstance = require(
  path.resolve(__dirname, '../../../node_modules/pg-boss'),
);
jest.mock('../../lib/pg-boss', () => ({
  getBoss: () => boss,
  initBoss: async () => undefined,
}));

const ENVIRONMENT_KEYS = [
  'RORCA_BUILD_IDENTITY_RECEIPT',
  'RORCA_BUILD_IDENTITY_VERIFICATION_KEY',
  'RORCA_PROCESS_ROLE',
  'RORCA_PGBOSS_SCHEMA',
  'RORCA_TEST_DATABASE_WORKSPACE_SCOPE',
  'RORCA_CLOSEOUT_RELEASE_FAILPOINT',
  'RORCA_CLOSEOUT_RECONCILIATION_FAILPOINT',
] as const;
type EnvironmentKey = typeof ENVIRONMENT_KEYS[number];
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [
    key,
    Object.prototype.hasOwnProperty.call(process.env, key)
      ? { present: true, value: process.env[key] }
      : { present: false },
  ]),
) as Record<EnvironmentKey, { present: boolean; value?: string }>;

const RUN_ID = 20260316000550;
const WORKSPACE_ID = `proof-workspace-${randomUUID()}`;
const PGBOSS_SCHEMA = `pgboss_wave1_${randomUUID().replace(/-/g, '')}`;
const FOREIGN_WORKSPACE_ID = `proof-workspace-foreign-${randomUUID()}`;
const SPEC_ID = 'wave-1-stabilize-evidence-closeout-and-managed-branch-delivery';
const SPEC_PATH = `forge/specs/pending/${SPEC_ID}.json`;
const SOURCE_REPOSITORY = path.resolve(__dirname, '../../../..');
const STORY_ID = 'W1-001';
const BUILD_KEY_PAIR = crypto.generateKeyPairSync('ed25519');
const KEY = BUILD_KEY_PAIR.publicKey.export({ type: 'spki', format: 'pem' }).toString();

process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = WORKSPACE_ID;
process.env.RORCA_PGBOSS_SCHEMA = PGBOSS_SCHEMA;
process.env.RORCA_PROCESS_ROLE = 'worker';

const { measureCloseoutReconciliationArtifact } = require(
  '../../lib/closeout-reconciliation-artifact'
) as typeof ArtifactModule;

let fixtureRoot: string;
let repository: string;
let worktree: string;
let head: string;
let reconciliation: typeof ReconciliationModule;
let boss: PgBossInstance;
let reconciliationId: string;
let bossJobId: string;
let previewHash: string;
let proofHostAuthority: Record<string, unknown>;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function signedBuildReceipt(): string {
  const unsigned = {
    schemaVersion: 'rorca.build-identity-receipt.v1',
    buildSha: 'd472df98102478f08f6dd5130158a3daa9ec06d9',
    reviewedSourceSha: 'd472df98102478f08f6dd5130158a3daa9ec06d9',
    requiredFixSha: 'e0fbcff3dd227ef918da71e3b0fe8761ee79b6d1',
    artifactDigest: measureCloseoutReconciliationArtifact().digest,
    deploymentId: 'wave1-adversarial-deployment',
    deploymentEnvironment: 'production',
    workspaceId: WORKSPACE_ID,
    canonicalSpecPath: SPEC_PATH,
    issuer: 'rorca-release-authority',
    keyId: 'wave1-adversarial-key',
    issuedAt: '2026-07-27T00:00:00.000Z',
    implementationBaselineSha: WAVE_1_IMPLEMENTATION_BASELINE_SHA,
    waveSpecRevision: WAVE_1_SPEC_CONTENT_HASH,
    sourceRepository: WAVE_1_SOURCE_REPOSITORY,
  };
  const signature = `ed25519:${crypto.sign(
    null,
    Buffer.from(JSON.stringify(unsigned), 'utf8'),
    BUILD_KEY_PAIR.privateKey,
  ).toString('base64')}`;
  return JSON.stringify({ ...unsigned, signature });
}

process.env.RORCA_BUILD_IDENTITY_RECEIPT = signedBuildReceipt();
process.env.RORCA_BUILD_IDENTITY_VERIFICATION_KEY = KEY;

const { closePool } = require('../index') as typeof DatabaseModule;
const { resolveTestDatabaseUrl } = require('../../lib/test-db-safety') as typeof TestDatabaseSafetyModule;
const { retryHash } = require('../../lib/retry-governance') as typeof RetryGovernanceModule;
const {
  createGovernedRetryDispatchIdentity,
  deriveAuthoritativeRetryScope,
} = require('../../lib/governed-story-retry') as typeof GovernedStoryRetryModule;
const { trustedWalIdentityHash } = require('../../lib/trusted-wal') as typeof TrustedWalModule;
const { persistHostRunCloseout } = require('../../lib/run-closeout-authority') as typeof RunCloseoutAuthorityModule;
const { terminalizeCanonicalCancellation } = require('../../lib/pipeline-cancellation') as typeof PipelineCancellationModule;
const {
  prepareRunReleaseIntent,
  reconcileRunReleaseIntent,
} = require('../../lib/release-authority') as typeof ReleaseAuthorityModule;
const {
  publishGovernedRetryDispatch,
  requestGovernedRetryRunCancellation,
} = require('../../lib/governed-retry-publication') as typeof GovernedRetryPublicationModule;
const {
  bindGovernedRetryProcessLaunch,
  claimGovernedRetryExecutionLease,
  markGovernedRetryLeaseExecuting,
  renewGovernedRetryExecutionLease,
} = require('../../lib/governed-retry-execution-lease') as typeof GovernedRetryLeaseModule;

const databaseUrl = resolveTestDatabaseUrl();
const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const runtimePool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  options: `--search_path=rorca,public -c rorca.workspace_id=${WORKSPACE_ID}`,
});
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 4,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${WORKSPACE_ID}`,
});

async function seed(): Promise<void> {
  fixtureRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave1-reconcile-db-')));
  repository = path.join(fixtureRoot, 'repository');
  git(fixtureRoot, ['clone', '-q', SOURCE_REPOSITORY, repository]);
  repository = fs.realpathSync(repository);
  worktree = path.join(fixtureRoot, 'worktree');
  git(repository, ['remote', 'set-url', 'origin', 'https://github.com/getrorca/rorca.git']);
  git(repository, ['config', 'user.email', 'test@rorca.invalid']);
  git(repository, ['config', 'user.name', 'Rorca Test']);
  git(repository, ['checkout', '-q', '-B', 'main']);
  git(repository, ['worktree', 'add', '-q', '-b', 'feat/wave1-proof', worktree]);
  worktree = fs.realpathSync(worktree);
  fs.writeFileSync(path.join(worktree, 'proof.txt'), 'proof\n');
  git(worktree, ['add', 'proof.txt']);
  git(worktree, ['commit', '-q', '-m', 'proof']);
  head = git(worktree, ['rev-parse', 'HEAD']).toLowerCase();
  const canonicalSpec = JSON.parse(
    fs.readFileSync(path.join(repository, SPEC_PATH), 'utf8'),
  ) as { userStories: Array<Record<string, unknown>> };
  const runSpecPath = path.join(worktree, '.rorca', 'run-specs', `run-${RUN_ID}.json`);
  fs.mkdirSync(path.dirname(runSpecPath), { recursive: true });
  fs.writeFileSync(runSpecPath, JSON.stringify({
    ...canonicalSpec,
    userStories: canonicalSpec.userStories.map((story) => (
      story.id === STORY_ID ? { ...story, passes: true } : story
    )),
  }));

  const effectiveOptions = {
    model: null, effort: null,
    worktree: { enabled: true, path: worktree, branch: 'feat/wave1-proof' },
    merge: { strategy: 'branch-only', autoMerge: false },
    graph: { enabled: false }, terminal: 'ansi-html',
    safety: { guard: 'autonomous-command-guard-v1', allowBackendJest: false, deploy: false, externalSend: false, policyLocked: true, ordinaryLocalPi: false },
  };
  const manifestHash = `sha256:${'1'.repeat(64)}`;
  const attemptId = `ATR-sha256:${'2'.repeat(64)}`;
  const decisionId = `CLO-sha256:${'3'.repeat(64)}`;
  const hostFence = `sha256:${'b'.repeat(64)}`;
  await ownerPool.query('INSERT INTO workspaces(id,label,path) VALUES ($1,$1,$2)', [WORKSPACE_ID, repository]);
  await ownerPool.query(`
    INSERT INTO pipeline_runs (
      id,spec_path,workspace_id,status,lifecycle_status,lifecycle_diagnostics,lifecycle_updated_at,
      summary,finished_at,expected_story_ids,excluded_story_ids,branch_name,worktree_path,
      execution_workspace_path,execution_worktree_path,merge_strategy,auto_merge,effective_options,
      dispatch_request_hash,dispatch_effective_options_hash,worktree_cleanup_status,dispatch_fence
    ) VALUES ($1,$2,$3,'failed','failed',$4::jsonb,'2026-07-26T10:30:00.123456Z',
      'worker_closeout_failed','2026-07-26T10:30:00.654321Z',$5::text[],'{}'::text[],
      'feat/wave1-proof',$6,$7,$6,'branch-only',FALSE,$8::jsonb,$9,$10,'not_started',$11)
  `, [RUN_ID, SPEC_PATH, WORKSPACE_ID, JSON.stringify({ owner: 'worker', reason: 'worker_closeout_failed' }),
    [STORY_ID], fs.realpathSync(worktree), fs.realpathSync(repository), JSON.stringify(effectiveOptions),
    `sha256:${'4'.repeat(64)}`, retryHash(effectiveOptions), hostFence]);
  await ownerPool.query(`INSERT INTO story_execution_manifests
    (manifest_hash,schema_version,workspace_id,spec_id,run_id,story_id,attempt,spec_revision,story_revision,payload)
    VALUES ($1,'rorca.story-execution-manifest.v2',$2,$3,$4,$5,1,$6,$7,'{}'::jsonb)`,
    [manifestHash, WORKSPACE_ID, SPEC_ID, RUN_ID, STORY_ID, `sha256:${'5'.repeat(64)}`, `sha256:${'6'.repeat(64)}`]);
  await ownerPool.query(`INSERT INTO host_story_attempt_envelopes (
      schema_version,workspace_id,run_id,story_id,attempt,launch_generation,cancellation_fence,manifest_hash,
      spec_id,spec_revision,story_revision,canonical_spec_path,run_spec_path,repository_realpath,
      repository_identity,base_git_sha,observed_git_sha,worktree_realpath,worktree_identity,
      worktree_branch,runtime_identity,identity_hash,payload_hash,outcome,outcome_provenance,
      exit_code,finished_at,canonical_spec_revision,canonical_spec_bytes_hash,
      run_spec_revision,run_spec_bytes_hash,expected_git_sha,expected_git_branch
    ) VALUES ('rorca.host-story-attempt-envelope.v1',$1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,
      'feat/wave1-proof','{}'::jsonb,$17,$18,'success','host_process',0,statement_timestamp(),
      $19,$20,$8,$21,$22,'feat/wave1-proof')`, [
    WORKSPACE_ID, RUN_ID, STORY_ID, randomUUID(), hostFence, manifestHash, SPEC_ID,
    `sha256:${'5'.repeat(64)}`, `sha256:${'6'.repeat(64)}`, SPEC_PATH, runSpecPath,
    fs.realpathSync(repository), retryHash({ repository }), head, fs.realpathSync(worktree),
    retryHash({ worktree }), retryHash({ identity: 'host' }), retryHash({ payload: 'host' }),
    `sha256:${'5'.repeat(64)}`, `sha256:${'c'.repeat(64)}`, `sha256:${'d'.repeat(64)}`, head,
  ]);
  await ownerPool.query(`INSERT INTO story_attempt_results
    (attempt_result_id,manifest_hash,workspace_id,spec_id,run_id,story_id,attempt,payload)
    VALUES ($1,$2,$3,$4,$5,$6,1,'{}'::jsonb)`, [attemptId, manifestHash, WORKSPACE_ID, SPEC_ID, RUN_ID, STORY_ID]);
  await ownerPool.query(`INSERT INTO story_closeout_decisions
    (decision_id,manifest_hash,attempt_result_id,workspace_id,spec_id,run_id,story_id,attempt,status,payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,1,'accepted','{}'::jsonb)`,
    [decisionId, manifestHash, attemptId, WORKSPACE_ID, SPEC_ID, RUN_ID, STORY_ID]);
  const result = await ownerPool.query<{ id: number }>(`
    INSERT INTO story_results (
      run_id,story_id,status,finished_at,spec_id,integrated,commit_sha,commit_message,
      commit_author,commit_branch,commit_observed_source,worktree_path,closeout_decision_id,
      manifest_hash,result_provenance,result_source,accounting_required
    ) VALUES ($1,$2,'pass','2026-07-26T10:29:00.123456Z',$3,TRUE,$4,'proof','Rorca Test',
      'feat/wave1-proof','worktree_branch',$5,$6,$7,'host','execution-engine',FALSE) RETURNING id
  `, [RUN_ID, STORY_ID, SPEC_ID, head, fs.realpathSync(worktree), decisionId, manifestHash]);
  await ownerPool.query(`INSERT INTO checkpoint_validation_attestations
    (id,workspace_id,run_id,story_id,branch_name,checkpoint_sha,validation_gate,evidence_digest,passed_at,expires_at)
    VALUES ($1,$2,$3,$4,'feat/wave1-proof',$5,'execution-engine',$6,statement_timestamp(),statement_timestamp()+INTERVAL '1 day')`,
    [randomUUID(), WORKSPACE_ID, RUN_ID, STORY_ID, head, '7'.repeat(64)]);
  const payload = { run_id: RUN_ID, story_id: STORY_ID, story_result_id: result.rows[0].id };
  const eventIdentityHash = trustedWalIdentityHash({
    eventType: 'story_passed', workspaceId: WORKSPACE_ID, runId: RUN_ID, specId: SPEC_ID,
    storyId: STORY_ID, source: 'story-result', storyResultId: result.rows[0].id, payload,
  });
  await ownerPool.query(`INSERT INTO wal_events
    (event_type,workspace_id,spec_id,story_id,payload,ingest_key,trust_provenance,trusted_source,
     canonical_run_id,story_result_id,event_identity_hash,outbox_ready_at,outbox_relayed_at)
    VALUES ('story_passed',$1,$2,$3,$4::jsonb,$5,'host','story-result',$6,$7,$8,statement_timestamp(),statement_timestamp())`,
    [WORKSPACE_ID, SPEC_ID, STORY_ID, JSON.stringify(payload), `trusted-wal:v1:${eventIdentityHash}`,
      RUN_ID, result.rows[0].id, eventIdentityHash]);
  await ownerPool.query(`INSERT INTO wal_events(event_type,workspace_id,payload,trust_provenance)
    VALUES ('run_process_finished',$1,$2::jsonb,'untrusted')`, [WORKSPACE_ID, JSON.stringify({ run_id: RUN_ID, status: 'failed', exit_code: 0, exit_signal: null, source: 'worker' })]);
  await ownerPool.query(`INSERT INTO pipeline_dispatch_publications
    (run_id,workspace_id,boss_job_id,state,request_hash,effective_options_hash,payload_hash,payload,completed_at)
    VALUES ($1,$2,$3,'failed',$4,$5,$6,'{}'::jsonb,statement_timestamp())`,
    [RUN_ID, WORKSPACE_ID, randomUUID(), `sha256:${'4'.repeat(64)}`, retryHash(effectiveOptions), `sha256:${'8'.repeat(64)}`]);

  proofHostAuthority = {
    runId: RUN_ID, workspaceId: WORKSPACE_ID, specId: SPEC_ID, status: 'failed', lifecycleStatus: 'failed',
    finishedAt: '2026-07-26T10:30:00.654321Z', branchName: 'feat/wave1-proof',
    checkoutPath: fs.realpathSync(worktree), repositoryTopLevel: fs.realpathSync(repository),
    expectedStoryIds: [STORY_ID], excludedStoryIds: [],
    stories: [{ storyId: STORY_ID, status: 'pass', reason: null, finishedAt: '2026-07-26T10:29:00.123456Z', resultId: result.rows[0].id, commitSha: head }],
    authoritativePassedStoryIds: [STORY_ID], finalCommitSha: head, closeoutEligible: true,
    terminalRevision: head, integrationAncestry: [head], acceptedStoryIds: [STORY_ID], complete: true,
    releaseEligible: true, invalidReason: null,
  };
  inspectRunHostAuthority.mockResolvedValue(proofHostAuthority);
}

async function prepareAuthority(): Promise<void> {
  const preview = await reconciliation.previewRunCloseoutReconciliation({ runId: RUN_ID, workspaceId: WORKSPACE_ID });
  previewHash = preview.canonicalTargetHash;
  const receiptId = randomUUID();
  await ownerPool.query(`INSERT INTO provider_human_authority_receipts
    (id,workspace_id,purpose,target_hash,issuer_id,key_id,key_fingerprint,provider,provider_tenant_id,
     actor_id,conversation_id,thread_id,message_id,occurred_at,normalized_command_hash,
     ingress_idempotency_key,attestation_hash,requester_actor_id,workspace_owner_verified)
    VALUES ($1,$2,'run_closeout_reconciliation',$3,'issuer','key',$4,'slack','tenant','owner',
      'conversation','thread',$5,statement_timestamp(),$3,$6,$7,'local-admin',TRUE)`,
    [receiptId, WORKSPACE_ID, previewHash, `sha256:${'9'.repeat(64)}`, randomUUID(), `ingress:${randomUUID()}`, `sha256:${'a'.repeat(64)}`]);
  reconciliationId = randomUUID();
  bossJobId = randomUUID();
  const payload = reconciliation.closeoutReconciliationJobPayloadForTests({
    reconciliationId, runId: RUN_ID, workspaceId: WORKSPACE_ID, previewHash,
  });
  await ownerPool.query(`INSERT INTO pipeline_run_closeout_reconciliations
    (id,run_id,workspace_id,idempotency_key,request_hash,preview_hash,immutable_authority_hash,
     owner_receipt_id,requester_actor_id,rationale,required_fix_sha,build_sha,build_receipt_hash,
     preview_expires_at,state,boss_job_id,job_payload_hash,before_projection)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'local-admin','Independent owner approved exact closeout correction',
      'e0fbcff3dd227ef918da71e3b0fe8761ee79b6d1',$9,$10,$11,'prepared',$12,$13,$14::jsonb)`,
    [reconciliationId, RUN_ID, WORKSPACE_ID, `reconcile:${randomUUID()}`, `sha256:${'b'.repeat(64)}`,
      previewHash, preview.target.immutableAuthorityHash, receiptId, 'd472df98102478f08f6dd5130158a3daa9ec06d9',
      String((preview.target.immutableAuthority.software as Record<string, unknown>).buildReceiptHash),
      preview.target.expiresAt, bossJobId, retryHash(payload), JSON.stringify(preview)]);
}

async function cleanupFixture(): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'ALTER TABLE pipeline_run_closeout_reconciliations DISABLE TRIGGER trg_pipeline_run_closeout_reconciliation_lifecycle',
    );
    await client.query(
      'ALTER TABLE pipeline_run_closeout_reconciliation_events DISABLE TRIGGER trg_closeout_reconciliation_event_immutable',
    );
    await client.query(
      `UPDATE pipeline_run_closeout_reconciliations
          SET state='processing',after_projection=NULL,reconciled_at=NULL,
              result_receipt_hash=NULL,reconciliation_event_id=NULL,
              claim_token=NULL,claim_expires_at=NULL
        WHERE workspace_id=$1`,
      [WORKSPACE_ID],
    );
    await client.query(
      'DELETE FROM pipeline_run_closeout_reconciliation_events WHERE workspace_id=$1',
      [WORKSPACE_ID],
    );
    await client.query(
      'DELETE FROM pipeline_run_closeout_reconciliations WHERE workspace_id=$1',
      [WORKSPACE_ID],
    );
    await client.query(
      'ALTER TABLE pipeline_run_closeout_reconciliation_events ENABLE TRIGGER trg_closeout_reconciliation_event_immutable',
    );
    await client.query(
      'ALTER TABLE pipeline_runs DISABLE TRIGGER trg_pipeline_run_host_closeout_pointer',
    );
    await client.query(
      'UPDATE pipeline_runs SET host_closeout_event_id=NULL WHERE workspace_id=$1',
      [WORKSPACE_ID],
    );
    await client.query(
      'ALTER TABLE pipeline_runs ENABLE TRIGGER trg_pipeline_run_host_closeout_pointer',
    );
    await client.query('DELETE FROM pipeline_run_cancellation_requests WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query('DELETE FROM governed_retry_story_attempts WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query('DELETE FROM governed_retry_dispatches WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query('DELETE FROM pipeline_retry_previews WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query(`DELETE FROM pipeline_run_release_intents WHERE run_id IN (
      SELECT id FROM pipeline_runs WHERE workspace_id=$1
    )`, [WORKSPACE_ID]);
    await client.query('DELETE FROM pipeline_dispatch_publications WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query('DELETE FROM wal_events WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query(
      'ALTER TABLE checkpoint_validation_attestations DISABLE TRIGGER trg_checkpoint_validation_attestation_immutable',
    );
    await client.query('DELETE FROM checkpoint_validation_attestations WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query(
      'ALTER TABLE checkpoint_validation_attestations ENABLE TRIGGER trg_checkpoint_validation_attestation_immutable',
    );
    await client.query(`DELETE FROM story_results WHERE run_id IN (
      SELECT id FROM pipeline_runs WHERE workspace_id=$1
    )`, [WORKSPACE_ID]);
    await client.query(
      'ALTER TABLE story_closeout_decisions DISABLE TRIGGER story_closeout_decisions_completion_immutable',
    );
    await client.query(
      'ALTER TABLE story_attempt_results DISABLE TRIGGER story_attempt_results_completion_immutable',
    );
    await client.query('DELETE FROM story_closeout_decisions WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query('DELETE FROM story_attempt_results WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query(
      'ALTER TABLE story_attempt_results ENABLE TRIGGER story_attempt_results_completion_immutable',
    );
    await client.query(
      'ALTER TABLE story_closeout_decisions ENABLE TRIGGER story_closeout_decisions_completion_immutable',
    );
    await client.query(
      'ALTER TABLE host_story_attempt_envelopes DISABLE TRIGGER trg_host_story_attempt_envelope_update',
    );
    await client.query('DELETE FROM host_story_attempt_envelopes WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query(
      'ALTER TABLE host_story_attempt_envelopes ENABLE TRIGGER trg_host_story_attempt_envelope_update',
    );
    await client.query('DELETE FROM story_execution_manifests WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query(
      'ALTER TABLE provider_human_authority_receipts DISABLE TRIGGER trg_provider_human_receipt_append_only',
    );
    await client.query('DELETE FROM provider_human_authority_receipts WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query(
      'ALTER TABLE provider_human_authority_receipts ENABLE TRIGGER trg_provider_human_receipt_append_only',
    );
    await client.query(
      'ALTER TABLE pipeline_run_closeout_reconciliations ENABLE TRIGGER trg_pipeline_run_closeout_reconciliation_lifecycle',
    );
    await client.query('DELETE FROM pipeline_runs WHERE workspace_id=$1', [WORKSPACE_ID]);
    await client.query('DELETE FROM workspaces WHERE id=$1', [WORKSPACE_ID]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function restoreEnvironment(): void {
  for (const key of ENVIRONMENT_KEYS) {
    const original = originalEnvironment[key];
    if (original.present) process.env[key] = original.value!;
    else delete process.env[key];
  }
}

function prepareTransportSchema(): void {
  execFileSync(process.execPath, [
    '--import',
    'tsx',
    path.resolve(__dirname, '../pg-boss-install.ts'),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: migrationDatabaseUrl,
      RORCA_MIGRATION_DATABASE_URL: migrationDatabaseUrl,
      RORCA_PGBOSS_SCHEMA: PGBOSS_SCHEMA,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

beforeAll(async () => {
  reconciliation = require('../../lib/run-closeout-reconciliation') as typeof ReconciliationModule;
  prepareTransportSchema();
  await seed();
  boss = new RealPgBoss({
    connectionString: databaseUrl,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    archiveCompletedAfterSeconds: 1,
    archiveFailedAfterSeconds: 1,
    maintenanceIntervalSeconds: 60,
  });
  await boss.start();
  await boss.createQueue('pipeline:closeout-reconcile');
  await prepareAuthority();
});

afterAll(async () => {
  try {
    if (boss) await boss.stop({ graceful: true, timeout: 1000 });
    await cleanupFixture();
    await ownerPool.query(`DROP SCHEMA IF EXISTS ${PGBOSS_SCHEMA} CASCADE`);
  } finally {
    await Promise.allSettled([closePool(), runtimePool.end(), ownerPool.end()]);
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    restoreEnvironment();
  }
});

async function seedConcurrentCloseoutRun(runId: number, fence: string): Promise<void> {
  await ownerPool.query(`INSERT INTO pipeline_runs (
    id,spec_path,workspace_id,status,lifecycle_status,expected_story_ids,excluded_story_ids,
    branch_name,worktree_path,execution_workspace_path,execution_worktree_path,dispatch_fence
  ) VALUES ($1,$2,$3,'running','running',$4::text[],'{}'::text[],'feat/wave1-proof',$5,$6,$5,$7)`,
  [runId, SPEC_PATH, WORKSPACE_ID, [STORY_ID], worktree, repository, fence]);
}

function concurrentAuthority(runId: number) {
  return {
    runId, workspaceId: WORKSPACE_ID, specId: SPEC_ID, status: 'running', lifecycleStatus: 'running',
    finishedAt: null, branchName: 'feat/wave1-proof', checkoutPath: worktree,
    repositoryTopLevel: repository, expectedStoryIds: [STORY_ID], excludedStoryIds: [],
    stories: [{ storyId: STORY_ID, status: 'pass', reason: null, finishedAt: '2026-07-26T10:29:00.123456Z', resultId: 1, commitSha: head }],
    authoritativePassedStoryIds: [STORY_ID], finalCommitSha: head, closeoutEligible: true,
    terminalRevision: head, integrationAncestry: [head], acceptedStoryIds: [STORY_ID], complete: true,
    releaseEligible: true, invalidReason: null,
  };
}

async function requestCancellationUnderCanonicalFence(runId: number): Promise<void> {

  const client = await runtimePool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`pipeline-run-authority:${runId}`]);
    const run = (await client.query<{ status: string }>('SELECT status FROM pipeline_runs WHERE id=$1 FOR UPDATE', [runId])).rows[0];
    if (run && ['running', 'validating', 'release_pending'].includes(run.status)) {
      await client.query(`INSERT INTO pipeline_run_cancellation_requests(run_id,workspace_id,requested_by,reason)
        VALUES($1,$2,'race-test','concurrent_cancel') ON CONFLICT(run_id) DO NOTHING`, [runId, WORKSPACE_ID]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

test('runtime closeout authority denies a cross-workspace selector', async () => {
  await expect(reconciliation.previewRunCloseoutReconciliation({
    runId: RUN_ID,
    workspaceId: FOREIGN_WORKSPACE_ID,
  })).rejects.toThrow();
});

test('canonical run fence serializes real concurrent cancellation and worker closeout', async () => {
  const runId = 8_300_001;
  const fence = `sha256:${'c'.repeat(64)}`;
  await seedConcurrentCloseoutRun(runId, fence);
  inspectRunHostAuthority.mockImplementation(async (id: number) => id === runId ? concurrentAuthority(runId) : undefined);
  const [closeout, cancelRequest] = await Promise.allSettled([
    persistHostRunCloseout({ runId, status: 'done', terminalizeRun: true, expectedDispatchFence: fence }),
    requestCancellationUnderCanonicalFence(runId),
  ]);
  expect(cancelRequest.status).toBe('fulfilled');
  const cancellation = await terminalizeCanonicalCancellation({ runId, source: 'db_race', processQuiescent: true });
  const truth = await ownerPool.query<{ status: string; cancellation: string; closeouts: string }>(`
    SELECT run.status,
      (SELECT COUNT(*)::text FROM pipeline_run_cancellation_requests WHERE run_id=run.id) AS cancellation,
      (SELECT COUNT(*)::text FROM wal_events WHERE canonical_run_id=run.id AND event_type='run_closeout') AS closeouts
    FROM pipeline_runs run WHERE run.id=$1`, [runId]);
  expect(['done', 'cancelled']).toContain(truth.rows[0].status);
  if (truth.rows[0].status === 'done') {
    expect(closeout.status).toBe('fulfilled');
    expect(['no_intent', 'superseded_terminal']).toContain(cancellation.outcome);
    expect(truth.rows[0].closeouts).toBe('1');
  } else {
    expect(closeout.status).toBe('rejected');
    expect(['terminalized', 'already_terminal']).toContain(cancellation.outcome);
    expect(truth.rows[0].closeouts).toBe('0');
  }
  await ownerPool.query('DELETE FROM pipeline_run_cancellation_requests WHERE run_id=$1', [runId]);
  await ownerPool.query('DELETE FROM pipeline_runs WHERE id=$1', [runId]);
  inspectRunHostAuthority.mockResolvedValue(proofHostAuthority);
});

test('ordinary production closeout and release never revive cancellation at any success boundary', async () => {
  const boundaries = [
    'after_host_closeout',
    'after_release_pending',
    'after_terminal_event',
    'after_public_done',
    'after_terminal_relay',
  ] as const;
  for (const [index, boundary] of boundaries.entries()) {
    const runId = 8_310_000 + index;
    const fence = `sha256:${String(index + 1).padStart(64, 'f')}`;
    await seedConcurrentCloseoutRun(runId, fence);
    const authority = concurrentAuthority(runId);
    inspectRunHostAuthority.mockImplementation(async (id: number) => id === runId ? authority : undefined);
    await persistHostRunCloseout({
      runId,
      status: 'done',
      terminalizeRun: false,
      expectedDispatchFence: fence,
    });

    if (boundary === 'after_host_closeout') {
      await requestCancellationUnderCanonicalFence(runId);
      await expect(prepareRunReleaseIntent({
        hostAuthority: authority as never,
        mergeStrategy: 'branch-only',
        autoMerge: false,
        externalSend: false,
        expectedDispatchFence: fence,
      })).rejects.toThrow(/cancellation supersedes release authority/);
    } else {
      await prepareRunReleaseIntent({
        hostAuthority: authority as never,
        mergeStrategy: 'branch-only',
        autoMerge: false,
        externalSend: false,
        expectedDispatchFence: fence,
      });
      if (boundary === 'after_release_pending') {
        await requestCancellationUnderCanonicalFence(runId);
      } else {
        process.env.RORCA_CLOSEOUT_RELEASE_FAILPOINT = boundary;
        await expect(reconcileRunReleaseIntent(runId)).rejects.toThrow(`closeout_release_failpoint:${boundary}`);
        delete process.env.RORCA_CLOSEOUT_RELEASE_FAILPOINT;
        // public_done is the exact terminal linearization point. A request that
        // arrives after it loses to done; every earlier boundary is cancellable.
        if (boundary === 'after_public_done' || boundary === 'after_terminal_relay') {
          await ownerPool.query(`INSERT INTO pipeline_run_cancellation_requests(run_id,workspace_id,requested_by,reason)
            VALUES($1,$2,'race-test','late_cancel') ON CONFLICT(run_id) DO NOTHING`, [runId, WORKSPACE_ID]);
        } else {
          await requestCancellationUnderCanonicalFence(runId);
        }
      }
    }

    const cancellation = await terminalizeCanonicalCancellation({
      runId,
      source: `ordinary_release_race:${boundary}`,
      processQuiescent: true,
    });
    const statusAfterCancellation = (await ownerPool.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id=$1', [runId],
    )).rows[0].status;
    const resumed = await reconcileRunReleaseIntent(runId).catch((error) => ({
      runId,
      status: 'blocked' as const,
      error: error instanceof Error ? error.message : String(error),
    }));
    const final = (await ownerPool.query<{ status: string; intent_status: string | null }>(`
      SELECT run.status,intent.status AS intent_status FROM pipeline_runs run
      LEFT JOIN pipeline_run_release_intents intent ON intent.run_id=run.id
      WHERE run.id=$1`, [runId])).rows[0];
    if (['after_public_done', 'after_terminal_relay'].includes(boundary)) {
      expect(statusAfterCancellation).toBe('done');
      expect(cancellation.outcome).toBe('superseded_terminal');
      expect(final.status).toBe('done');
    } else {
      expect(['terminalized', 'already_terminal']).toContain(cancellation.outcome);
      expect(statusAfterCancellation).toBe('cancelled');
      expect(resumed.status).toBe('blocked');
      expect(final.status).toBe('cancelled');
      expect(final.intent_status).not.toBe('completed');
    }
    await ownerPool.query('DELETE FROM pipeline_run_cancellation_requests WHERE run_id=$1', [runId]);
    await ownerPool.query('DELETE FROM pipeline_run_release_intents WHERE run_id=$1', [runId]);
    await ownerPool.query('DELETE FROM pipeline_runs WHERE id=$1', [runId]);
    await ownerPool.query('DELETE FROM wal_events WHERE canonical_run_id=$1', [runId]);
  }
  delete process.env.RORCA_CLOSEOUT_RELEASE_FAILPOINT;
  inspectRunHostAuthority.mockResolvedValue(proofHostAuthority);
});

test('canonical run fence and dispatch CAS serialize retry generation against closeout', async () => {
  const runId = 8_300_002;
  const fence = `sha256:${'d'.repeat(64)}`;
  const retryFence = `sha256:${'e'.repeat(64)}`;
  await seedConcurrentCloseoutRun(runId, fence);
  inspectRunHostAuthority.mockImplementation(async (id: number) => id === runId ? concurrentAuthority(runId) : undefined);
  const retry = (async () => {
    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`pipeline-run-authority:${runId}`]);
      const changed = await client.query(`UPDATE pipeline_runs SET dispatch_fence=$2
        WHERE id=$1 AND status='running' AND dispatch_fence=$3 RETURNING id`, [runId, retryFence, fence]);
      await client.query('COMMIT');
      return changed.rowCount;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  })();
  const [closeout, retryResult] = await Promise.allSettled([
    persistHostRunCloseout({ runId, status: 'done', terminalizeRun: true, expectedDispatchFence: fence }),
    retry,
  ]);
  expect(retryResult.status).toBe('fulfilled');
  if (retryResult.status !== 'fulfilled') throw retryResult.reason;
  const truth = (await ownerPool.query<{ status: string; dispatch_fence: string; closeouts: string }>(`
    SELECT status,dispatch_fence,
      (SELECT COUNT(*)::text FROM wal_events WHERE canonical_run_id=$1 AND event_type='run_closeout') AS closeouts
    FROM pipeline_runs WHERE id=$1`, [runId])).rows[0];
  if (truth.status === 'done') {
    expect(closeout.status).toBe('fulfilled');
    expect(retryResult.value).toBe(0);
    expect(truth.closeouts).toBe('1');
  } else {
    expect(truth).toMatchObject({ status: 'running', dispatch_fence: retryFence, closeouts: '0' });
    expect(closeout.status).toBe('rejected');
    expect(retryResult.value).toBe(1);
  }
  await ownerPool.query('DELETE FROM pipeline_runs WHERE id=$1', [runId]);
  inspectRunHostAuthority.mockResolvedValue(proofHostAuthority);
});

test('retry publication self-fences cancellation, closeout, and duplicate dispatch in production code', async () => {
  const seedPublication = async (suffix: number) => {
    const originalRunId = 8_320_000 + suffix * 2;
    const retryRunId = originalRunId + 1;
    const preview = `sha256:${String(suffix).padStart(64, '1')}`;
    const identity = `sha256:${String(suffix).padStart(64, '2')}`;
    const queueHash = `sha256:${String(suffix).padStart(64, '3')}`;
    const fence = `sha256:${String(suffix).padStart(64, '4')}`;
    await ownerPool.query(`INSERT INTO pipeline_runs(id,spec_path,workspace_id,status,finished_at)
      VALUES($1,$2,$3,'failed',NOW())`, [originalRunId, SPEC_PATH, WORKSPACE_ID]);
    await ownerPool.query(`INSERT INTO pipeline_runs(
      id,spec_path,workspace_id,status,retried_from_run_id,
      branch_name,worktree_path,execution_workspace_path,execution_worktree_path,
      expected_story_ids,excluded_story_ids,dispatch_fence
    ) VALUES($1,$2,$3,'queued',$4,'feat/wave1-proof',$5,$6,$5,$7::text[],'{}'::text[],$8)`,
    [retryRunId, SPEC_PATH, WORKSPACE_ID, originalRunId, worktree, repository, [STORY_ID], fence]);
    await ownerPool.query(`INSERT INTO pipeline_retry_previews(
      preview_hash,original_run_id,retry_run_id,workspace_id,scope_hash,status,packet,
      preview_identity_hash,expires_at,idempotency_key,approved_at,preparation_state,
      preparation_owner,preparation_lease_expires_at,preparation_generation
    ) VALUES($1,$2,$3,$4,$5,'approved','{}'::jsonb,$6,NOW()+INTERVAL '5 minutes',$7,NOW(),
      'outbox_ready','publication-test',NOW()+INTERVAL '5 minutes',1)`,
    [preview, originalRunId, retryRunId, WORKSPACE_ID, retryHash([STORY_ID]),
      `sha256:${'5'.repeat(64)}`, `publication-preview:${suffix}`]);
    await ownerPool.query(`INSERT INTO governed_retry_dispatches(
      identity_hash,workspace_id,spec_id,spec_revision,original_run_id,retry_run_id,
      original_run_lineage,base_revision,integrated_revision,prior_integration_ancestry,
      recovery_ref,recovery_ref_revision,preview_hash,scope_hash,evidence_hash,
      execution_manifest_hash,queue_payload_hash,job_payload,queue_name,idempotency_key,
      lease_identity,state
    ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8,$9::jsonb,'HEAD',$8,$10,$11,$12,$13,$14,
      '{}'::jsonb,'pipeline:retry',$15,$16,'prepared')`, [
      identity, WORKSPACE_ID, SPEC_ID, `sha256:${'6'.repeat(64)}`, originalRunId, retryRunId,
      JSON.stringify([originalRunId]), head, JSON.stringify([head]), preview,
      retryHash([STORY_ID]), `sha256:${'7'.repeat(64)}`, `sha256:${'8'.repeat(64)}`, queueHash,
      `publication-dispatch:${suffix}`, retryHash({ publicationLease: suffix }),
    ]);
    return { originalRunId, retryRunId, preview, identity, queueHash, fence };
  };

  const cancellationFixture = await seedPublication(1);
  const bossJobId = randomUUID();
  const publish = () => publishGovernedRetryDispatch({
    previewHash: cancellationFixture.preview,
    dispatchIdentityHash: cancellationFixture.identity,
    retryRunId: cancellationFixture.retryRunId,
    queuePayloadHash: cancellationFixture.queueHash,
    bossJobId,
  });
  const raced = await Promise.all([
    publish(),
    publish(),
    requestGovernedRetryRunCancellation({
      runId: cancellationFixture.retryRunId,
      workspaceId: WORKSPACE_ID,
      requestedBy: 'publication-race',
      reason: 'concurrent cancellation',
    }),
  ]);
  const cancellationTruth = (await ownerPool.query<{
    state: string; boss_job_id: string | null; cancellation_requested_at: string | null;
  }>(`SELECT state,boss_job_id::text,cancellation_requested_at
      FROM governed_retry_dispatches WHERE identity_hash=$1`, [cancellationFixture.identity])).rows[0];
  expect(cancellationTruth.cancellation_requested_at).not.toBeNull();
  expect(cancellationTruth.boss_job_id === null || cancellationTruth.boss_job_id === bossJobId).toBe(true);
  expect(raced.slice(0, 2).filter((result) => result.outcome === 'published').length).toBeLessThanOrEqual(2);
  const replayAfterCancellation = await publish();
  expect(replayAfterCancellation.outcome).toBe('cancelled');

  const leaseFixture = await seedPublication(3);
  const leaseJobId = randomUUID();
  await publishGovernedRetryDispatch({
    previewHash: leaseFixture.preview,
    dispatchIdentityHash: leaseFixture.identity,
    retryRunId: leaseFixture.retryRunId,
    queuePayloadHash: leaseFixture.queueHash,
    bossJobId: leaseJobId,
  });
  const [workerA, workerB] = await Promise.all([
    claimGovernedRetryExecutionLease({
      runId: leaseFixture.retryRunId, previewHash: leaseFixture.preview,
      dispatchIdentityHash: leaseFixture.identity, leaseOwner: 'worker-a',
    }),
    claimGovernedRetryExecutionLease({
      runId: leaseFixture.retryRunId, previewHash: leaseFixture.preview,
      dispatchIdentityHash: leaseFixture.identity, leaseOwner: 'worker-b',
    }),
  ]);
  const firstLease = workerA ?? workerB;
  expect([workerA, workerB].filter(Boolean)).toHaveLength(1);
  expect(firstLease).toBeDefined();
  const firstOwner = workerA ? 'worker-a' : 'worker-b';
  expect(await markGovernedRetryLeaseExecuting({
    runId: leaseFixture.retryRunId,
    dispatchIdentityHash: leaseFixture.identity,
    fencingToken: firstLease!.fencingToken,
    leaseOwner: firstOwner,
  })).toBe(true);
  expect(await bindGovernedRetryProcessLaunch({
    runId: leaseFixture.retryRunId,
    dispatchIdentityHash: leaseFixture.identity,
    fencingToken: firstLease!.fencingToken,
    leaseOwner: firstOwner,
    launchTokenHash: `sha256:${'a'.repeat(64)}`,
    pid: 91_001,
    workerId: randomUUID(),
    expectedPriorPid: null,
  })).toBe(true);
  await expect(bindGovernedRetryProcessLaunch({
    runId: leaseFixture.retryRunId,
    dispatchIdentityHash: leaseFixture.identity,
    fencingToken: firstLease!.fencingToken,
    leaseOwner: firstOwner === 'worker-a' ? 'worker-b' : 'worker-a',
    launchTokenHash: `sha256:${'b'.repeat(64)}`,
    pid: 91_002,
    workerId: randomUUID(),
    expectedPriorPid: 91_001,
  })).rejects.toThrow('lost its dispatch generation');
  expect((await ownerPool.query<{ pid: number | null }>(
    'SELECT pid FROM pipeline_runs WHERE id=$1', [leaseFixture.retryRunId],
  )).rows[0].pid).toBe(91_001);
  // Crash/restart loses the process map but not PostgreSQL authority. Only after
  // lease expiry and observed dead PID may a new generation replace it.
  await ownerPool.query(`UPDATE governed_retry_dispatches SET lease_expires_at=NOW()-INTERVAL '1 second'
    WHERE identity_hash=$1`, [leaseFixture.identity]);
  await ownerPool.query(`UPDATE pipeline_runs SET pid=NULL WHERE id=$1 AND pid=91001`, [leaseFixture.retryRunId]);
  const restarted = await claimGovernedRetryExecutionLease({
    runId: leaseFixture.retryRunId,
    previewHash: leaseFixture.preview,
    dispatchIdentityHash: leaseFixture.identity,
    leaseOwner: 'worker-restart',
  });
  expect(restarted?.fencingToken).toBe(firstLease!.fencingToken + 1);
  expect(await markGovernedRetryLeaseExecuting({
    runId: leaseFixture.retryRunId,
    dispatchIdentityHash: leaseFixture.identity,
    fencingToken: restarted!.fencingToken,
    leaseOwner: 'worker-restart',
  })).toBe(true);
  expect(await bindGovernedRetryProcessLaunch({
    runId: leaseFixture.retryRunId,
    dispatchIdentityHash: leaseFixture.identity,
    fencingToken: restarted!.fencingToken,
    leaseOwner: 'worker-restart',
    launchTokenHash: `sha256:${'c'.repeat(64)}`,
    pid: 91_003,
    workerId: randomUUID(),
    expectedPriorPid: null,
  })).toBe(true);
  const leaseTruth = (await ownerPool.query<{
    fencing_token: string; lease_owner: string; launch_pid: number; pid: number;
  }>(`SELECT dispatch.fencing_token::text,dispatch.lease_owner,dispatch.launch_pid,run.pid
      FROM governed_retry_dispatches dispatch JOIN pipeline_runs run ON run.id=dispatch.retry_run_id
      WHERE dispatch.identity_hash=$1`, [leaseFixture.identity])).rows[0];
  expect(leaseTruth).toMatchObject({
    fencing_token: String(restarted!.fencingToken), lease_owner: 'worker-restart',
    launch_pid: 91_003, pid: 91_003,
  });
  expect(await renewGovernedRetryExecutionLease({
    runId: leaseFixture.retryRunId,
    dispatchIdentityHash: leaseFixture.identity,
    fencingToken: restarted!.fencingToken,
    leaseOwner: 'worker-restart',
  })).toBe(true);
  await ownerPool.query(`INSERT INTO pipeline_run_cancellation_requests
    (run_id,workspace_id,requested_by,reason) VALUES ($1,$2,'wave1-test','lease-renewal-race')`,
  [leaseFixture.retryRunId, WORKSPACE_ID]);
  expect(await renewGovernedRetryExecutionLease({
    runId: leaseFixture.retryRunId,
    dispatchIdentityHash: leaseFixture.identity,
    fencingToken: restarted!.fencingToken,
    leaseOwner: 'worker-restart',
  })).toBe(false);

  const prelaunchCrashFixture = await seedPublication(4);
  await publishGovernedRetryDispatch({
    previewHash: prelaunchCrashFixture.preview,
    dispatchIdentityHash: prelaunchCrashFixture.identity,
    retryRunId: prelaunchCrashFixture.retryRunId,
    queuePayloadHash: prelaunchCrashFixture.queueHash,
    bossJobId: randomUUID(),
  });
  const crashedBeforeLaunch = await claimGovernedRetryExecutionLease({
    runId: prelaunchCrashFixture.retryRunId,
    previewHash: prelaunchCrashFixture.preview,
    dispatchIdentityHash: prelaunchCrashFixture.identity,
    leaseOwner: 'worker-crashed-before-launch',
  });
  expect(crashedBeforeLaunch).toBeDefined();
  await ownerPool.query(`UPDATE governed_retry_dispatches SET lease_expires_at=NOW()-INTERVAL '1 second'
    WHERE identity_hash=$1`, [prelaunchCrashFixture.identity]);
  const recoveredBeforeLaunch = await claimGovernedRetryExecutionLease({
    runId: prelaunchCrashFixture.retryRunId,
    previewHash: prelaunchCrashFixture.preview,
    dispatchIdentityHash: prelaunchCrashFixture.identity,
    leaseOwner: 'worker-after-prelaunch-crash',
  });
  expect(recoveredBeforeLaunch?.fencingToken).toBe(crashedBeforeLaunch!.fencingToken + 1);
  expect((await ownerPool.query<{ pid: number | null }>(
    'SELECT pid FROM pipeline_runs WHERE id=$1', [prelaunchCrashFixture.retryRunId],
  )).rows[0].pid).toBeNull();

  const closeoutFixture = await seedPublication(2);
  inspectRunHostAuthority.mockImplementation(async (id: number) => id === closeoutFixture.retryRunId
    ? concurrentAuthority(closeoutFixture.retryRunId)
    : undefined);
  const closeoutJobId = randomUUID();
  const [publicationResult, closeoutResult] = await Promise.allSettled([
    publishGovernedRetryDispatch({
      previewHash: closeoutFixture.preview,
      dispatchIdentityHash: closeoutFixture.identity,
      retryRunId: closeoutFixture.retryRunId,
      queuePayloadHash: closeoutFixture.queueHash,
      bossJobId: closeoutJobId,
    }),
    persistHostRunCloseout({
      runId: closeoutFixture.retryRunId,
      status: 'failed',
      terminalizeRun: true,
      expectedDispatchFence: closeoutFixture.fence,
    }),
  ]);
  expect(closeoutResult.status).toBe('fulfilled');
  expect(publicationResult.status).toBe('fulfilled');
  const closeoutTruth = (await ownerPool.query<{ status: string; boss_job_id: string | null }>(`
    SELECT run.status,dispatch.boss_job_id::text FROM pipeline_runs run
    JOIN governed_retry_dispatches dispatch ON dispatch.retry_run_id=run.id
    WHERE run.id=$1`, [closeoutFixture.retryRunId])).rows[0];
  expect(closeoutTruth.status).toBe('failed');
  expect(closeoutTruth.boss_job_id === null || closeoutTruth.boss_job_id === closeoutJobId).toBe(true);

  for (const fixture of [cancellationFixture, leaseFixture, prelaunchCrashFixture, closeoutFixture]) {
    await ownerPool.query('DELETE FROM pipeline_run_cancellation_requests WHERE run_id=$1', [fixture.retryRunId]);
    await ownerPool.query('DELETE FROM governed_retry_story_attempts WHERE dispatch_identity_hash=$1', [fixture.identity]);
    await ownerPool.query('DELETE FROM governed_retry_dispatches WHERE identity_hash=$1', [fixture.identity]);
    await ownerPool.query('DELETE FROM pipeline_retry_previews WHERE preview_hash=$1', [fixture.preview]);
    await ownerPool.query('DELETE FROM pipeline_runs WHERE id=$1', [fixture.retryRunId]);
    await ownerPool.query('DELETE FROM wal_events WHERE canonical_run_id=$1', [fixture.retryRunId]);
    await ownerPool.query('DELETE FROM pipeline_runs WHERE id=$1', [fixture.originalRunId]);
  }
  inspectRunHostAuthority.mockResolvedValue(proofHostAuthority);
});

test('mixed passed/failed retry scope persists only failed work and carries exact passed evidence', async () => {
  const originalRunId = 8_330_000;
  const retryRunId = 8_330_001;
  const acceptedCommit = 'a'.repeat(40);
  const resultingHead = 'b'.repeat(40);
  const targetHead = 'c'.repeat(40);
  const scope = deriveAuthoritativeRetryScope({
    originalRunLineage: [originalRunId],
    targetRunId: originalRunId,
    completions: [
      { runId: originalRunId, storyId: 'PASSED', attempt: 1, resultIdentity: 'result-passed', outcome: 'accepted', sourceCommit: acceptedCommit },
      { runId: originalRunId, storyId: 'FAILED', attempt: 1, resultIdentity: 'result-failed', outcome: 'failed', sourceCommit: null },
    ],
    integrations: [
      { runId: originalRunId, storyId: 'PASSED', attempt: 1, state: 'finalized', sourceCommit: acceptedCommit, resultingHead, integrationOrder: 1 },
    ],
    closeouts: [
      { runId: originalRunId, status: 'partial_failure', integratedRevision: targetHead,
        integrationAncestry: [resultingHead], acceptedStoryIds: ['PASSED'], evidenceIdentity: 'closeout-exact' },
    ],
  });
  expect(scope.executableStoryIds).toEqual(['FAILED']);
  expect(scope.carriedForward.map((story) => story.storyId)).toEqual(['PASSED']);
  const preview = `sha256:${'d'.repeat(64)}`;
  const queueHash = `sha256:${'e'.repeat(64)}`;
  const manifestHash = `sha256:${'f'.repeat(64)}`;
  const identity = createGovernedRetryDispatchIdentity({
    workspaceId: WORKSPACE_ID,
    specId: SPEC_ID,
    specRevision: `sha256:${'1'.repeat(64)}`,
    originalRunId,
    originalRunLineage: [originalRunId],
    retryRunId,
    baseRevision: targetHead,
    integratedRevision: targetHead,
    priorIntegrationAncestry: scope.priorIntegrationAncestry,
    recoveryRef: 'HEAD',
    recoveryRefRevision: targetHead,
    fencingToken: 1,
    leaseIdentity: `sha256:${'2'.repeat(64)}`,
    idempotencyKey: 'mixed-scope-dispatch',
    queueName: 'pipeline:retry',
    queuePayloadHash: queueHash,
    executionManifestHash: manifestHash,
    approvedPreviewHash: preview,
    scopeHash: retryHash(scope.executableStoryIds),
    evidenceHash: scope.evidenceHash,
    taskManifestLineageHash: null,
    storyAttempts: [{ storyId: 'FAILED', attempt: 2, previousAttempt: 1, sourceRunId: originalRunId, idempotencyKey: 'mixed-failed-2' }],
    carriedForward: scope.carriedForward,
  });
  await ownerPool.query(`INSERT INTO pipeline_runs(id,spec_path,workspace_id,status,finished_at)
    VALUES($1,$2,$3,'partial_failure',NOW())`, [originalRunId, SPEC_PATH, WORKSPACE_ID]);
  await ownerPool.query(`INSERT INTO pipeline_runs(id,spec_path,workspace_id,status,retried_from_run_id,dispatch_fence)
    VALUES($1,$2,$3,'queued',$4,$5)`, [retryRunId, SPEC_PATH, WORKSPACE_ID, originalRunId, `sha256:${'3'.repeat(64)}`]);
  await ownerPool.query(`INSERT INTO pipeline_retry_previews(
    preview_hash,original_run_id,retry_run_id,workspace_id,scope_hash,status,packet,
    preview_identity_hash,expires_at,idempotency_key,approved_at,preparation_state,preparation_generation
  ) VALUES($1,$2,$3,$4,$5,'approved','{}'::jsonb,$6,NOW()+INTERVAL '5 minutes','mixed-preview',NOW(),'outbox_ready',1)`,
  [preview, originalRunId, retryRunId, WORKSPACE_ID, retryHash(scope.executableStoryIds), `sha256:${'4'.repeat(64)}`]);
  await ownerPool.query(`INSERT INTO governed_retry_dispatches(
    identity_hash,workspace_id,spec_id,spec_revision,original_run_id,retry_run_id,
    original_run_lineage,base_revision,integrated_revision,prior_integration_ancestry,
    recovery_ref,recovery_ref_revision,preview_hash,scope_hash,evidence_hash,
    execution_manifest_hash,queue_payload_hash,job_payload,queue_name,idempotency_key,lease_identity,state
  ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8,$9::jsonb,'HEAD',$8,$10,$11,$12,$13,$14,$15::jsonb,
    'pipeline:retry',$16,$17,'prepared')`, [
    identity.identityHash, WORKSPACE_ID, SPEC_ID, identity.specRevision, originalRunId, retryRunId,
    JSON.stringify(identity.originalRunLineage), targetHead, JSON.stringify(identity.priorIntegrationAncestry),
    preview, identity.scopeHash, identity.evidenceHash, identity.executionManifestHash, queueHash,
    JSON.stringify({ dispatchIdentity: identity }), identity.idempotencyKey, identity.leaseIdentity,
  ]);
  await ownerPool.query(`INSERT INTO story_execution_manifests(
    manifest_hash,schema_version,workspace_id,spec_id,run_id,story_id,attempt,spec_revision,story_revision,payload
  ) VALUES($1,'rorca.story-execution-manifest.v2',$2,$3,$4,'FAILED',2,$5,$6,'{}'::jsonb)`,
  [manifestHash, WORKSPACE_ID, SPEC_ID, retryRunId, identity.specRevision, `sha256:${'5'.repeat(64)}`]);
  await ownerPool.query(`INSERT INTO governed_retry_story_attempts(
    attempt_identity,dispatch_identity_hash,workspace_id,spec_id,original_root_run_id,source_run_id,
    retry_run_id,story_id,attempt,previous_attempt,idempotency_key,manifest_hash,state,recovery_ref
  ) VALUES($1,$2,$3,$4,$5,$5,$6,'FAILED',2,1,'mixed-failed-2',$7,'pending','HEAD')`,
  [retryHash(identity.storyAttempts[0]), identity.identityHash, WORKSPACE_ID, SPEC_ID, originalRunId, retryRunId, manifestHash]);
  const persisted = (await ownerPool.query<{
    attempts: string[]; carried: string[];
  }>(`SELECT
      ARRAY(SELECT story_id FROM governed_retry_story_attempts WHERE dispatch_identity_hash=dispatch.identity_hash ORDER BY story_id) AS attempts,
      ARRAY(SELECT value->>'storyId' FROM jsonb_array_elements(dispatch.job_payload->'dispatchIdentity'->'carriedForward') value ORDER BY value->>'storyId') AS carried
    FROM governed_retry_dispatches dispatch WHERE identity_hash=$1`, [identity.identityHash])).rows[0];
  expect(persisted).toEqual({ attempts: ['FAILED'], carried: ['PASSED'] });
  await ownerPool.query('DELETE FROM governed_retry_story_attempts WHERE dispatch_identity_hash=$1', [identity.identityHash]);
  await ownerPool.query('DELETE FROM governed_retry_dispatches WHERE identity_hash=$1', [identity.identityHash]);
  await ownerPool.query('DELETE FROM story_execution_manifests WHERE manifest_hash=$1', [manifestHash]);
  await ownerPool.query('DELETE FROM pipeline_retry_previews WHERE preview_hash=$1', [preview]);
  await ownerPool.query('DELETE FROM pipeline_runs WHERE id=$1', [retryRunId]);
  await ownerPool.query('DELETE FROM pipeline_runs WHERE id=$1', [originalRunId]);
});

test('exact transport matrix covers live/archive/missing/mismatch/null/partition/restart authority', async () => {
  const load = async () => (await ownerPool.query<{ boss_job_id: string; transport_generation: number; last_error_code: string | null; transport_history: Array<{ state: string; location: string }> }>(
    'SELECT boss_job_id::text,transport_generation,last_error_code,transport_history FROM pipeline_run_closeout_reconciliations WHERE id=$1', [reconciliationId],
  )).rows[0];

  try {
    await reconciliation.publishCloseoutReconciliation(reconciliationId, RUN_ID, boss);
  } catch (error) {
    const transport = await load();
    const observed = await boss.getJobById('pipeline:closeout-reconcile', transport.boss_job_id);
    throw new Error(`initial closeout publication failed: ${String(error)}; transport=${JSON.stringify(observed)}`);
  }
  let row = await load();
  expect((await boss.fetch('pipeline:closeout-reconcile'))[0]?.id).toBe(row.boss_job_id);
  await boss.complete('pipeline:closeout-reconcile', row.boss_job_id);

  await reconciliation.publishCloseoutReconciliation(reconciliationId, RUN_ID, boss);
  row = await load();
  // Recreate exact application identity with retries exhausted so pg-boss
  // exposes its terminal ordinary-failure representation immediately.
  await boss.deleteJob('pipeline:closeout-reconcile', row.boss_job_id);
  const failedPayload = reconciliation.closeoutReconciliationJobPayloadForTests({
    reconciliationId, runId: RUN_ID, workspaceId: WORKSPACE_ID, previewHash,
    transportGeneration: row.transport_generation,
  });
  await boss.send('pipeline:closeout-reconcile', failedPayload, {
    id: row.boss_job_id, retryLimit: 0, expireInSeconds: 600,
  });
  expect((await boss.fetch('pipeline:closeout-reconcile'))[0]?.id).toBe(row.boss_job_id);
  await boss.fail('pipeline:closeout-reconcile', row.boss_job_id, {
    value: { message: 'ordinary provider failure' },
  });
  expect((await boss.getJobById('pipeline:closeout-reconcile', row.boss_job_id))?.state).toBe('failed');

  await reconciliation.publishCloseoutReconciliation(reconciliationId, RUN_ID, boss);
  row = await load();
  // Recreate the exact application payload with a one-second pg-boss timeout so
  // the real active->timeout representation is practical in a bounded test.
  await boss.deleteJob('pipeline:closeout-reconcile', row.boss_job_id);
  const expiringPayload = reconciliation.closeoutReconciliationJobPayloadForTests({
    reconciliationId, runId: RUN_ID, workspaceId: WORKSPACE_ID, previewHash,
    transportGeneration: row.transport_generation,
  });
  await boss.send('pipeline:closeout-reconcile', expiringPayload, {
    id: row.boss_job_id, retryLimit: 0, expireInSeconds: 1,
  });
  expect((await boss.fetch('pipeline:closeout-reconcile'))[0]?.id).toBe(row.boss_job_id);
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await boss.expire();
  const expiredJob = await boss.getJobById('pipeline:closeout-reconcile', row.boss_job_id);
  expect(expiredJob?.state).toBe('failed');
  expect(expiredJob?.output).toMatchObject({ value: { message: 'job failed by timeout in active state' } });

  await reconciliation.publishCloseoutReconciliation(reconciliationId, RUN_ID, boss);
  row = await load();
  expect((await boss.fetch('pipeline:closeout-reconcile'))[0]?.id).toBe(row.boss_job_id);
  await boss.complete('pipeline:closeout-reconcile', row.boss_job_id);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await boss.archive();

  const archivedJob = await boss.getJobById('pipeline:closeout-reconcile', row.boss_job_id, { includeArchive: true });
  expect(archivedJob?.state).toBe('completed');
  const duplicateSent = await boss.send('pipeline:closeout-reconcile', archivedJob!.data as object, {
    id: row.boss_job_id, retryLimit: 0,
  });
  expect(duplicateSent).toBe(row.boss_job_id);
  await expect(reconciliation.publishCloseoutReconciliation(reconciliationId, RUN_ID, boss))
    .rejects.toThrow('duplicated across live and archive');
  expect((await load()).last_error_code).toBe('TRANSPORT_DUPLICATE');
  // Remove the conflicting live copy. The surviving completed archive row is
  // then canonical terminal transport evidence and rotates application identity.
  await boss.deleteJob('pipeline:closeout-reconcile', row.boss_job_id);
  await reconciliation.publishCloseoutReconciliation(reconciliationId, RUN_ID, boss);
  row = await load();
  expect((await boss.getJobById('pipeline:closeout-reconcile', row.boss_job_id))?.id).toBe(row.boss_job_id);
  expect(row.transport_generation).toBe(5);
  expect(row.transport_history.map((item) => item.state)).toEqual(['completed', 'failed', 'expired', 'completed']);
  expect(row.transport_history.at(-1)?.location).toBe('archive');

  // Missing live/archive row is redispatched without rotating application identity.
  await boss.deleteJob('pipeline:closeout-reconcile', row.boss_job_id);
  await reconciliation.publishCloseoutReconciliation(reconciliationId, RUN_ID, boss);
  expect((await load()).transport_generation).toBe(5);

  // A missing partition is repaired only by explicit createQueue-before-send.
  row = await load();
  await boss.deleteJob('pipeline:closeout-reconcile', row.boss_job_id);
  await boss.deleteQueue('pipeline:closeout-reconcile');
  await reconciliation.publishCloseoutReconciliation(reconciliationId, RUN_ID, boss);
  expect((await boss.getJobById('pipeline:closeout-reconcile', row.boss_job_id))?.id).toBe(row.boss_job_id);

  // Wrong queue/data under the exact UUID is durable conflict evidence.
  await boss.deleteJob('pipeline:closeout-reconcile', row.boss_job_id);
  await boss.createQueue('pipeline:wrong-closeout');
  await boss.send('pipeline:wrong-closeout', { marker: 'wrong' }, { id: row.boss_job_id, retryLimit: 0 });
  await expect(reconciliation.publishCloseoutReconciliation(reconciliationId, RUN_ID, boss))
    .rejects.toThrow('name/data/generation mismatch');
  expect((await load()).last_error_code).toBe('TRANSPORT_IDENTITY_MISMATCH');
  await boss.deleteJob('pipeline:wrong-closeout', row.boss_job_id);

  // Null send is diagnosed durably before the caller receives failure.
  await expect(reconciliation.publishCloseoutReconciliation(reconciliationId, RUN_ID, {
    createQueue: async () => undefined,
    send: async () => null,
  } as never)).rejects.toThrow('did not preserve application-owned job identity');
  expect((await load()).last_error_code).toBe('TRANSPORT_NULL_SEND');

  // Startup recovery drains the same bounded application row after transport loss.
  const recovery = await reconciliation.recoverPendingCloseoutReconciliationPublications(10);
  expect(recovery).toMatchObject({ scanned: 1, published: 1, failed: 0 });
  row = await load();
  expect((await boss.getJobById('pipeline:closeout-reconcile', row.boss_job_id))?.id).toBe(row.boss_job_id);
  bossJobId = row.boss_job_id;
});

test('every crash boundary rolls back event, run projection, and receipt before one exactly-once success', async () => {
  const transportGeneration = (await ownerPool.query<{ transport_generation: number }>(
    'SELECT transport_generation FROM pipeline_run_closeout_reconciliations WHERE id=$1', [reconciliationId],
  )).rows[0].transport_generation;
  const payload = reconciliation.closeoutReconciliationJobPayloadForTests({
    reconciliationId, runId: RUN_ID, workspaceId: WORKSPACE_ID, previewHash, transportGeneration,
  });
  for (const failpoint of ['before_host_closeout', 'after_host_closeout', 'after_release_intent', 'after_release_reconciliation']) {
    process.env.RORCA_CLOSEOUT_RECONCILIATION_FAILPOINT = failpoint;
    await expect(reconciliation.processCloseoutReconciliationJob({ jobId: bossJobId, data: payload }))
      .rejects.toThrow(`closeout_reconciliation_failpoint:${failpoint}`);
    const truth = await ownerPool.query<{ status: string; state: string; events: string }>(`
      SELECT run.status,reconciliation.state,
             (SELECT COUNT(*)::text FROM pipeline_run_closeout_reconciliation_events WHERE reconciliation_id=reconciliation.id) AS events
        FROM pipeline_runs run JOIN pipeline_run_closeout_reconciliations reconciliation ON reconciliation.run_id=run.id
       WHERE run.id=$1`, [RUN_ID]);
    expect(truth.rows[0]).toMatchObject({ status: 'failed', state: 'queued', events: '0' });
  }
  delete process.env.RORCA_CLOSEOUT_RECONCILIATION_FAILPOINT;
  await expect(reconciliation.processCloseoutReconciliationJob({ jobId: bossJobId, data: payload }))
    .resolves.toMatchObject({ state: 'completed', resultReceiptHash: expect.stringMatching(/^sha256:/) });
  await expect(reconciliation.processCloseoutReconciliationJob({ jobId: bossJobId, data: payload }))
    .resolves.toMatchObject({ state: 'noop' });
  const truth = await ownerPool.query<{ status: string; lifecycle_status: string; state: string; events: string; ordinary: string; releases: string }>(`
    SELECT run.status,run.lifecycle_status,reconciliation.state,
      (SELECT COUNT(*)::text FROM pipeline_run_closeout_reconciliation_events WHERE reconciliation_id=reconciliation.id) AS events,
      (SELECT COUNT(*)::text FROM wal_events WHERE canonical_run_id=run.id AND event_type='run_finished') AS ordinary,
      (SELECT COUNT(*)::text FROM pipeline_run_release_intents WHERE run_id=run.id) AS releases
    FROM pipeline_runs run JOIN pipeline_run_closeout_reconciliations reconciliation ON reconciliation.run_id=run.id
    WHERE run.id=$1`, [RUN_ID]);
  expect(truth.rows[0]).toEqual({ status: 'done', lifecycle_status: 'finished', state: 'completed', events: '1', ordinary: '0', releases: '0' });
});
