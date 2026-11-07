/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { resetDisposableWave1Database } from './wave1-test-cleanup';
import type {
  finalizeHostStoryAttempt as FinalizeHostStoryAttempt,
  persistHostAttemptLaunches as PersistHostAttemptLaunches,
  requireSuccessfulHostStoryAttempt as RequireSuccessfulHostStoryAttempt,
  HostAttemptOutcome,
} from '../../lib/host-story-attempt-envelope';
import type {
  createStoryExecutionManifest as CreateStoryExecutionManifest,
  deriveStoryContractRevision as DeriveStoryContractRevision,
  ImmutableStoryExecutionManifest,
} from '../../lib/story-execution-packet';
import type {
  storyLifecycleFixture as StoryLifecycleFixture,
} from '../../lib/__tests__/fixtures/story-execution-manifest.fixture';
import type { runHostGatedProviderProbe as RunHostGatedProviderProbe } from '../../lib/execution-engine';
import type { inspectRunHostAuthority as InspectRunHostAuthority } from '../../lib/run-host-authority';
import type { persistHostRunCloseout as PersistHostRunCloseout } from '../../lib/run-closeout-authority';
import type { trustedWalIdentityHash as TrustedWalIdentityHash } from '../../lib/trusted-wal';
import type { closePool as ClosePool, query as RuntimeQuery } from '../../db/index';
import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  RORCA_PROCESS_ROLE: process.env.RORCA_PROCESS_ROLE,
  RORCA_TEST_DATABASE_WORKSPACE_SCOPE: process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE,
};
const suiteWorkspaceId = `host-story-attempt-${randomUUID()}`;
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = suiteWorkspaceId;

resolveTestDatabaseUrl();
const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 2,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${suiteWorkspaceId}`,
});
const {
  finalizeHostStoryAttempt,
  persistHostAttemptLaunches,
  requireSuccessfulHostStoryAttempt,
} = require('../../lib/host-story-attempt-envelope') as {
  finalizeHostStoryAttempt: typeof FinalizeHostStoryAttempt;
  persistHostAttemptLaunches: typeof PersistHostAttemptLaunches;
  requireSuccessfulHostStoryAttempt: typeof RequireSuccessfulHostStoryAttempt;
};
const {
  createStoryExecutionManifest,
  deriveStoryContractRevision,
} = require('../../lib/story-execution-packet') as {
  createStoryExecutionManifest: typeof CreateStoryExecutionManifest;
  deriveStoryContractRevision: typeof DeriveStoryContractRevision;
};
const { storyLifecycleFixture } = require('../../lib/__tests__/fixtures/story-execution-manifest.fixture') as {
  storyLifecycleFixture: typeof StoryLifecycleFixture;
};
const { runHostGatedProviderProbe } = require('../../lib/execution-engine') as {
  runHostGatedProviderProbe: typeof RunHostGatedProviderProbe;
};
const { inspectRunHostAuthority } = require('../../lib/run-host-authority') as {
  inspectRunHostAuthority: typeof InspectRunHostAuthority;
};
const { persistHostRunCloseout } = require('../../lib/run-closeout-authority') as {
  persistHostRunCloseout: typeof PersistHostRunCloseout;
};
const { trustedWalIdentityHash } = require('../../lib/trusted-wal') as {
  trustedWalIdentityHash: typeof TrustedWalIdentityHash;
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
let repository: string;
let head: string;
let runSequence = 8_100_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function manifest(input: {
  workspaceId: string;
  runId: number;
  storyId: string;
  specRevision: string;
  storyRevision: string;
  attempt?: number;
}): ImmutableStoryExecutionManifest {
  return createStoryExecutionManifest({
    identity: { workspaceId: input.workspaceId, specId: 'wave1-attempt-proof', storyId: input.storyId, runId: input.runId, attempt: input.attempt ?? 1 },
    revisions: { specRevision: input.specRevision, storyRevision: input.storyRevision },
    executionMode: 'impl',
    lifecycle: storyLifecycleFixture(input.workspaceId, 'wave1-attempt-proof', input.storyId),
    execution: {
      agent: 'pi', model: 'test-model', effort: 'high', terminal: 'ansi-html',
      worktree: { enabled: true, path: repository, branch: 'main', baseRevision: head },
      merge: { enabled: false, strategy: 'branch-only', targetBranch: null },
    },
    validationPlan: [],
    evidenceExpectations: [{ criterionId: 'criterion:1', description: 'host proof', requiredEvidenceKinds: ['completion'] }],
    repositoryProfile: { profileId: 'wave1-test', changePolicy: 'no_code_allowed', noCodeReason: 'DB contract proof', runtimeMetadataPaths: [] },
    commandSafety: {
      profileId: 'wave1-test', guardVersion: 'v1', guardedWorkingDirectory: repository,
      allowedWorkingDirectories: [repository], blockedCommandPatterns: [], redactedEnvironmentKeys: [],
      allowBackendJest: false, baselineFailurePolicy: 'block',
    },
  });
}

async function seed(outcome: HostAttemptOutcome, index: number) {
  const workspaceId = suiteWorkspaceId;
  const runId = runSequence++;
  const storyId = `W1-${index}`;
  const fence = `sha256:${String(index).padStart(64, '0')}`;
  const generation = randomUUID();
  const canonicalSpecPath = 'forge/specs/approved/wave1-attempt-proof.json';
  const canonicalStory = { id: storyId, title: storyId, description: 'host attempt proof', passes: false };
  const canonicalSpec = { id: 'wave1-attempt-proof', userStories: [canonicalStory] };
  const canonicalBytes = `${JSON.stringify(canonicalSpec, null, 2)}\n`;
  const canonicalAbsolutePath = path.join(repository, canonicalSpecPath);
  fs.mkdirSync(path.dirname(canonicalAbsolutePath), { recursive: true });
  fs.writeFileSync(canonicalAbsolutePath, canonicalBytes);
  const runSpecPath = path.join(repository, '.rorca', 'run-specs', `run-${runId}.json`);
  fs.mkdirSync(path.dirname(runSpecPath), { recursive: true });
  fs.writeFileSync(runSpecPath, canonicalBytes);
  const specRevision = deriveStoryContractRevision(canonicalSpec);
  const exactManifest = manifest({
    workspaceId,
    runId,
    storyId,
    specRevision,
    storyRevision: deriveStoryContractRevision(canonicalStory),
  });
  const bytesHash = `sha256:${createHash('sha256').update(canonicalBytes).digest('hex')}`;
  await ownerPool.query(
    `INSERT INTO workspaces(id,label,path) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [workspaceId, workspaceId, repository],
  );
  await ownerPool.query(`
    INSERT INTO pipeline_runs (
      id, spec_path, workspace_id, status, branch_name, worktree_path,
      execution_workspace_path, execution_worktree_path, dispatch_fence,
      expected_story_ids, excluded_story_ids, canonical_spec_revision,
      canonical_spec_bytes_hash, run_spec_path, run_spec_revision, run_spec_bytes_hash
    ) VALUES ($1,$6,$2,'starting','main',$3,$3,$3,$4,$5::text[],'{}'::text[],$7,$8,$9,$7,$8)
  `, [runId, workspaceId, repository, fence, [storyId], canonicalSpecPath,
    specRevision, bytesHash, runSpecPath]);
  await ownerPool.query(`
    INSERT INTO story_execution_manifests (
      manifest_hash,schema_version,workspace_id,spec_id,run_id,story_id,attempt,
      spec_revision,story_revision,payload
    ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9::jsonb)
  `, [exactManifest.manifestHash, exactManifest.schemaVersion, workspaceId,
    exactManifest.identity.specId, runId, storyId, exactManifest.revisions.specRevision,
    exactManifest.revisions.storyRevision, JSON.stringify(exactManifest)]);
  const launch = {
    workspaceId, runId, launchGeneration: generation, cancellationFence: fence,
    canonicalSpecPath,
    runSpecPath,
    repositoryPath: repository, worktreePath: repository,
    expectedGitSha: head, expectedGitBranch: 'main',
    runtime: {
      processRole: 'worker-engine' as const, workerId: randomUUID(), engineEntrypoint: '/opt/rorca/execution-engine.js',
      agent: 'pi', model: 'test-model', terminalMode: 'ansi-html', processPid: process.pid,
    },
    manifests: [exactManifest],
  };
  return {
    workspaceId, runId, storyId, fence, generation, exactManifest, launch,
    canonicalAbsolutePath, runSpecPath, canonicalBytes,
  };
}

async function seedExactSemanticPass(fixture: Awaited<ReturnType<typeof seed>>): Promise<void> {
  const suffix = randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64);
  const attemptResultId = `ATR-sha256:${suffix}`;
  const decisionId = `CLO-sha256:${suffix}`;
  await ownerPool.query(`INSERT INTO story_attempt_results (
    attempt_result_id,manifest_hash,workspace_id,spec_id,run_id,story_id,attempt,payload
  ) VALUES($1,$2,$3,$4,$5,$6,1,'{}'::jsonb)`, [
    attemptResultId, fixture.exactManifest.manifestHash, fixture.workspaceId,
    fixture.exactManifest.identity.specId, fixture.runId, fixture.storyId,
  ]);
  await ownerPool.query(`INSERT INTO story_closeout_decisions (
    decision_id,manifest_hash,attempt_result_id,workspace_id,spec_id,run_id,story_id,attempt,status,payload
  ) VALUES($1,$2,$3,$4,$5,$6,$7,1,'accepted','{}'::jsonb)`, [
    decisionId, fixture.exactManifest.manifestHash, attemptResultId, fixture.workspaceId,
    fixture.exactManifest.identity.specId, fixture.runId, fixture.storyId,
  ]);
  const commitMessage = `integrated ${fixture.storyId}`;
  await ownerPool.query(`INSERT INTO story_commits (
    story_id,spec_id,workspace_id,commit_sha,commit_message,author,run_id,branch_name,observed_source
  ) VALUES($1,$2,$3,$4,$5,'rorca-execution-engine',$6,'main','worktree_branch')`, [
    fixture.storyId, fixture.exactManifest.identity.specId, fixture.workspaceId,
    head, commitMessage, fixture.runId,
  ]);
  const result = await ownerPool.query<{ id: number }>(`INSERT INTO story_results (
    run_id,story_id,status,finished_at,spec_id,integrated,commit_sha,commit_message,
    commit_author,commit_branch,commit_observed_source,worktree_path,closeout_decision_id,
    manifest_hash,result_provenance,result_source,accounting_required
  ) VALUES($1,$2,'pass',statement_timestamp(),$3,TRUE,$4,$5,
    'rorca-execution-engine','main','worktree_branch',$6,$7,$8,'host','execution-engine',FALSE)
  RETURNING id`, [
    fixture.runId, fixture.storyId, fixture.exactManifest.identity.specId, head,
    commitMessage, repository, decisionId, fixture.exactManifest.manifestHash,
  ]);
  const attestationId = randomUUID();
  const attestationDigest = 'd'.repeat(64);
  const passedAt = '2026-07-28T08:00:00.123Z';
  const expiresAt = '2099-07-28T08:00:00.123Z';
  await ownerPool.query(`INSERT INTO checkpoint_validation_attestations (
    id,workspace_id,run_id,story_id,branch_name,checkpoint_sha,validation_gate,
    evidence_digest,passed_at,expires_at
  ) VALUES($1,$2,$3,$4,'main',$5,'execution-engine',$6,$7,$8)`, [
    attestationId, fixture.workspaceId, fixture.runId, fixture.storyId, head,
    attestationDigest, passedAt, expiresAt,
  ]);
  const payload = {
    run_id: fixture.runId,
    story_id: fixture.storyId,
    story_result_id: result.rows[0].id,
    commit_sha: head,
    closeout_decision_id: decisionId,
    checkpoint_attestation_id: attestationId,
    checkpoint_attestation_digest: attestationDigest,
    checkpoint_attestation_passed_at: passedAt,
    checkpoint_attestation_expires_at: expiresAt,
  };
  const eventIdentityHash = trustedWalIdentityHash({
    eventType: 'story_passed', workspaceId: fixture.workspaceId, runId: fixture.runId,
    specId: fixture.exactManifest.identity.specId, storyId: fixture.storyId,
    source: 'story-result', storyResultId: result.rows[0].id, payload,
  });
  await ownerPool.query(`INSERT INTO wal_events (
    event_type,workspace_id,spec_id,story_id,payload,ingest_key,trust_provenance,
    trusted_source,canonical_run_id,story_result_id,event_identity_hash,outbox_ready_at
  ) VALUES('story_passed',$1,$2,$3,$4::jsonb,$5,'host','story-result',$6,$7,$8,statement_timestamp())`, [
    fixture.workspaceId, fixture.exactManifest.identity.specId, fixture.storyId,
    JSON.stringify(payload), `trusted-wal:v1:${eventIdentityHash}`, fixture.runId,
    result.rows[0].id, eventIdentityHash,
  ]);
}
beforeAll(async () => {
  repository = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave1-attempt-db-')));
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'test@rorca.invalid']);
  git(repository, ['config', 'user.name', 'Rorca Test']);
  fs.writeFileSync(path.join(repository, 'proof.txt'), 'proof\n');
  git(repository, ['add', 'proof.txt']);
  git(repository, ['commit', '-q', '-m', 'proof']);
  git(repository, ['branch', '-M', 'main']);
  head = git(repository, ['rev-parse', 'HEAD']);
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
          if (repository) fs.rmSync(repository, { recursive: true, force: true });
        } finally {
          restoreEnvironment('NODE_ENV');
          restoreEnvironment('RORCA_PROCESS_ROLE');
          restoreEnvironment('RORCA_TEST_DATABASE_WORKSPACE_SCOPE');
        }
      }
    }
  }
});

test('runtime principal stays bound to the suite workspace and cannot observe another workspace', async () => {
  const foreignWorkspaceId = `${suiteWorkspaceId}-foreign`;
  await ownerPool.query(
    `INSERT INTO workspaces(id,label,path) VALUES($1,$1,$2)`,
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
    `[principal-map] suite=host-story-attempt-envelope migration_owner=${ownerAuthority.current_user} `
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
});

test('actual stop/exec-gated provider children compose every host outcome and success alone authorizes closeout', async () => {
  const outcomes: HostAttemptOutcome[] = ['success', 'nonzero_exit', 'timeout', 'cancelled', 'crash'];
  for (const [index, outcome] of outcomes.entries()) {
    const fixture = await seed(outcome, index + 1);
    const script = outcome === 'success' ? 'process.exit(0)'
      : outcome === 'nonzero_exit' ? 'process.exit(7)'
        : outcome === 'crash' ? "process.kill(process.pid, 'SIGKILL')"
          : 'setTimeout(() => process.exit(0), 10000)';
    const observed = await runHostGatedProviderProbe({
      command: process.execPath,
      args: ['-e', script],
      cwd: repository,
      authority: {
        manifest: fixture.exactManifest,
        launchGeneration: fixture.generation,
        cancellationFence: fixture.fence,
        canonicalSpecPath: fixture.launch.canonicalSpecPath,
        runSpecPath: fixture.launch.runSpecPath,
        repositoryPath: repository,
        worktreePath: repository,
        expectedGitSha: head,
        expectedGitBranch: 'main',
        workerId: 'wave1-db-provider-worker',
        terminalMode: 'ansi-html',
      },
      timeoutMs: outcome === 'timeout' ? 50 : 5_000,
      cancelAfterMs: outcome === 'cancelled' ? 25 : undefined,
    });
    expect(observed.outcome).toBe(outcome);
    const persisted = await ownerPool.query<{ runtime_identity: { processRole: string; processPid: number }; outcome: string }>(
      'SELECT runtime_identity,outcome FROM host_story_attempt_envelopes WHERE run_id=$1 AND story_id=$2',
      [fixture.runId, fixture.storyId],
    );
    expect(persisted.rows[0]).toMatchObject({
      runtime_identity: { processRole: 'story-provider', processPid: observed.pid },
      outcome,
    });
    const authority = requireSuccessfulHostStoryAttempt({
      workspaceId: fixture.workspaceId, runId: fixture.runId, storyId: fixture.storyId,
      attempt: 1, launchGeneration: fixture.generation, cancellationFence: fixture.fence,
      manifestHash: fixture.exactManifest.manifestHash,
    });
    if (outcome === 'success') await expect(authority).resolves.toBeUndefined();
    else await expect(authority).rejects.toThrow('lacks exact successful host attempt authority');
  }
});

/* Synthetic duplicate replay remains separately covered because the actual
 * child's immutable runtime identity is intentionally not caller-reconstructible. */
test('an exact launch payload replay is idempotent before finalization', async () => {
  const fixture = await seed('success', 7);
  const first = await persistHostAttemptLaunches(fixture.launch);
  const duplicate = await persistHostAttemptLaunches(fixture.launch);
  expect(first).toMatchObject({ inserted: 1, replayed: 0 });
  expect(duplicate).toMatchObject({ inserted: 0, replayed: 1, envelopeIds: first.envelopeIds });
});

test('database immutability covers every canonical, run-spec, story, Git, branch, and ancestry authority field', async () => {
  const fixture = await seed('success', 47);
  await persistHostAttemptLaunches(fixture.launch);
  await finalizeHostStoryAttempt({
    workspaceId: fixture.workspaceId, runId: fixture.runId, storyId: fixture.storyId,
    attempt: 1, launchGeneration: fixture.generation, cancellationFence: fixture.fence,
    manifestHash: fixture.exactManifest.manifestHash, outcome: 'success',
    provenance: 'host_process', exitCode: 0,
  });
  const mutations: Array<[string, string]> = [
    ['spec_revision', `sha256:${'6'.repeat(64)}`],
    ['story_revision', `sha256:${'7'.repeat(64)}`],
    ['canonical_spec_revision', `sha256:${'8'.repeat(64)}`],
    ['canonical_spec_bytes_hash', `sha256:${'9'.repeat(64)}`],
    ['run_spec_revision', `sha256:${'a'.repeat(64)}`],
    ['run_spec_bytes_hash', `sha256:${'b'.repeat(64)}`],
    ['base_git_sha', 'c'.repeat(40)],
    ['expected_git_sha', 'd'.repeat(40)],
    ['observed_git_sha', 'e'.repeat(40)],
    ['expected_git_branch', 'changed/expected-branch'],
    ['worktree_branch', 'changed/observed-branch'],
  ];
  for (const [column, value] of mutations) {
    await expect(ownerPool.query(
      `UPDATE host_story_attempt_envelopes SET ${column}=$2 WHERE run_id=$1`,
      [fixture.runId, value],
    )).rejects.toMatchObject({ code: '23514' });
  }
  await expect(ownerPool.query(
    'UPDATE host_story_attempt_envelopes SET canonical_spec_revision=NULL WHERE run_id=$1',
    [fixture.runId],
  )).rejects.toMatchObject({ code: '23514' });
  await expect(requireSuccessfulHostStoryAttempt({
    workspaceId: fixture.workspaceId, runId: fixture.runId, storyId: fixture.storyId,
    attempt: 1, launchGeneration: fixture.generation, cancellationFence: fixture.fence,
    manifestHash: fixture.exactManifest.manifestHash,
  })).resolves.toBeUndefined();
});
test('first provider launch rejects initial HEAD/spec byte drift and absent canonical or run-spec paths', async () => {
  const headDrift = await seed('success', 15);
  fs.writeFileSync(path.join(repository, 'first-launch-head-drift.txt'), 'drift\n');
  git(repository, ['add', 'first-launch-head-drift.txt']);
  git(repository, ['commit', '-q', '-m', 'first launch head drift']);
  await expect(persistHostAttemptLaunches(headDrift.launch))
    .rejects.toThrow('conflicts with git_revision_mismatch');
  git(repository, ['reset', '--hard', '-q', head]);
  fs.rmSync(path.join(repository, 'first-launch-head-drift.txt'), { force: true });

  const specDrift = await seed('success', 16);
  fs.appendFileSync(specDrift.canonicalAbsolutePath, ' ');
  await expect(persistHostAttemptLaunches(specDrift.launch))
    .rejects.toThrow('conflicts with spec_revision_mismatch');

  const runSpecDrift = await seed('success', 17);
  fs.appendFileSync(runSpecDrift.runSpecPath, ' ');
  await expect(persistHostAttemptLaunches(runSpecDrift.launch))
    .rejects.toThrow('conflicts with spec_revision_mismatch');

  const missingCanonical = await seed('success', 18);
  fs.rmSync(missingCanonical.canonicalAbsolutePath);
  await expect(persistHostAttemptLaunches(missingCanonical.launch))
    .rejects.toThrow('Canonical spec is missing');

  const missingRunSpec = await seed('success', 19);
  fs.rmSync(missingRunSpec.runSpecPath);
  await expect(persistHostAttemptLaunches(missingRunSpec.launch))
    .rejects.toThrow('Run spec is missing');

  const invalidJson = await seed('success', 40);
  fs.writeFileSync(invalidJson.canonicalAbsolutePath, '{not-json');
  await expect(persistHostAttemptLaunches(invalidJson.launch))
    .rejects.toThrow('Canonical spec bytes are not valid JSON');

  const unreadable = await seed('success', 41);
  fs.rmSync(unreadable.runSpecPath);
  fs.mkdirSync(unreadable.runSpecPath);
  await expect(persistHostAttemptLaunches(unreadable.launch))
    .rejects.toThrow('Run spec is not a readable regular file');

  const symlinkEscape = await seed('success', 42);
  const symlinkTarget = path.join(repository, 'symlink-target.json');
  fs.writeFileSync(symlinkTarget, symlinkEscape.canonicalBytes);
  fs.rmSync(symlinkEscape.canonicalAbsolutePath);
  fs.symlinkSync(symlinkTarget, symlinkEscape.canonicalAbsolutePath);
  await expect(persistHostAttemptLaunches(symlinkEscape.launch))
    .rejects.toThrow('Canonical spec moved or traversed a symlink');
  fs.rmSync(symlinkEscape.canonicalAbsolutePath);
  fs.writeFileSync(symlinkEscape.canonicalAbsolutePath, symlinkEscape.canonicalBytes);

  const outsideRunSpec = await seed('success', 43);
  const escapedPath = path.join(os.tmpdir(), `rorca-wave1-escaped-${randomUUID()}.json`);
  fs.writeFileSync(escapedPath, outsideRunSpec.canonicalBytes);
  try {
    await expect(persistHostAttemptLaunches({ ...outsideRunSpec.launch, runSpecPath: escapedPath }))
      .rejects.toThrow('Run spec expected path escaped its authority root');
  } finally {
    fs.rmSync(escapedPath, { force: true });
  }

  const observations = await ownerPool.query<{ run_id: string; reason_code: string }>(`
    SELECT run_id::text, reason_code FROM host_story_attempt_conflicts
     WHERE run_id = ANY($1::bigint[]) ORDER BY run_id
  `, [[missingCanonical.runId, missingRunSpec.runId, invalidJson.runId, unreadable.runId,
    symlinkEscape.runId, outsideRunSpec.runId]]);
  expect(observations.rows.map((row) => row.reason_code).sort()).toEqual([
    'canonical_spec_file_missing', 'run_spec_file_missing', 'canonical_spec_invalid_json',
    'run_spec_file_unreadable', 'canonical_spec_path_moved', 'run_spec_path_escape',
  ].sort());
});

test('every distinct provider attempt revalidates exact files and explicit expected HEAD ancestry/branch', async () => {
  const fixture = await seed('success', 44);
  await persistHostAttemptLaunches(fixture.launch);
  const secondManifest = manifest({
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    storyId: fixture.storyId,
    specRevision: fixture.exactManifest.revisions.specRevision,
    storyRevision: fixture.exactManifest.revisions.storyRevision,
    attempt: 2,
  });
  await ownerPool.query(`INSERT INTO story_execution_manifests (
    manifest_hash,schema_version,workspace_id,spec_id,run_id,story_id,attempt,
    spec_revision,story_revision,payload
  ) VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,$9::jsonb)`, [
    secondManifest.manifestHash, secondManifest.schemaVersion, fixture.workspaceId,
    secondManifest.identity.specId, fixture.runId, fixture.storyId,
    secondManifest.revisions.specRevision, secondManifest.revisions.storyRevision,
    JSON.stringify(secondManifest),
  ]);
  fs.writeFileSync(path.join(repository, 'attempt-two.txt'), 'attempt two\n');
  git(repository, ['add', 'attempt-two.txt']);
  git(repository, ['commit', '-q', '-m', 'attempt two']);
  const secondHead = git(repository, ['rev-parse', 'HEAD']);
  try {
    await expect(persistHostAttemptLaunches({
      ...fixture.launch,
      launchGeneration: randomUUID(),
      manifests: [secondManifest],
      expectedGitSha: head,
    })).rejects.toThrow('conflicts with git_revision_mismatch');

    const validFixture = await seed('success', 45);
    const validSecond = manifest({
      workspaceId: validFixture.workspaceId,
      runId: validFixture.runId,
      storyId: validFixture.storyId,
      specRevision: validFixture.exactManifest.revisions.specRevision,
      storyRevision: validFixture.exactManifest.revisions.storyRevision,
      attempt: 2,
    });
    await ownerPool.query(`INSERT INTO story_execution_manifests (
      manifest_hash,schema_version,workspace_id,spec_id,run_id,story_id,attempt,
      spec_revision,story_revision,payload
    ) VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,$9::jsonb)`, [
      validSecond.manifestHash, validSecond.schemaVersion, validFixture.workspaceId,
      validSecond.identity.specId, validFixture.runId, validFixture.storyId,
      validSecond.revisions.specRevision, validSecond.revisions.storyRevision,
      JSON.stringify(validSecond),
    ]);
    await expect(persistHostAttemptLaunches({
      ...validFixture.launch,
      launchGeneration: randomUUID(),
      manifests: [validSecond],
      expectedGitSha: secondHead,
    })).resolves.toMatchObject({ inserted: 1 });

    const driftFixture = await seed('success', 46);
    await persistHostAttemptLaunches({ ...driftFixture.launch, expectedGitSha: secondHead });
    const driftSecond = manifest({
      workspaceId: driftFixture.workspaceId,
      runId: driftFixture.runId,
      storyId: driftFixture.storyId,
      specRevision: driftFixture.exactManifest.revisions.specRevision,
      storyRevision: driftFixture.exactManifest.revisions.storyRevision,
      attempt: 2,
    });
    fs.appendFileSync(driftFixture.runSpecPath, ' ');
    await expect(persistHostAttemptLaunches({
      ...driftFixture.launch,
      launchGeneration: randomUUID(),
      manifests: [driftSecond],
      expectedGitSha: secondHead,
    })).rejects.toThrow('conflicts with spec_revision_mismatch');
  } finally {
    git(repository, ['reset', '--hard', '-q', head]);
    fs.rmSync(path.join(repository, 'attempt-two.txt'), { force: true });
  }
});

/* Keep the common success-authority assertion close to the composed matrix. */
test('post-finalization stale or changed delivery poisons prior semantic success', async () => {
  for (const [index, staleGeneration] of [false, true].entries()) {
    const fixture = await seed('success', 20 + index);
    await persistHostAttemptLaunches(fixture.launch);
    await finalizeHostStoryAttempt({
      workspaceId: fixture.workspaceId, runId: fixture.runId, storyId: fixture.storyId,
      attempt: 1, launchGeneration: fixture.generation, cancellationFence: fixture.fence,
      manifestHash: fixture.exactManifest.manifestHash, outcome: 'success',
      provenance: 'host_process', exitCode: 0,
    });
    await seedExactSemanticPass(fixture);
    await expect(inspectRunHostAuthority(fixture.runId)).resolves.toMatchObject({
      complete: true,
      closeoutEligible: true,
      releaseEligible: true,
      authoritativePassedStoryIds: [fixture.storyId],
      invalidReason: null,
    });
    const conflicting = staleGeneration
      ? { ...fixture.launch, launchGeneration: randomUUID() }
      : {
          ...fixture.launch,
          manifests: [{
            ...fixture.exactManifest,
            manifestHash: `sha256:${'f'.repeat(64)}`,
          }],
        };
    await expect(persistHostAttemptLaunches(conflicting)).rejects.toThrow(/stale_generation|payload_changed/);
    const conflictBefore = await ownerPool.query<{
      conflict_id: string; reason_code: string; observed_payload: unknown;
    }>(`SELECT conflict_id,reason_code,observed_payload FROM host_story_attempt_conflicts
         WHERE run_id=$1 AND story_id=$2 AND attempt=1 ORDER BY observed_at DESC LIMIT 1`,
    [fixture.runId, fixture.storyId]);
    expect(conflictBefore.rows).toHaveLength(1);
    await expect(ownerPool.query(
      `UPDATE host_story_attempt_conflicts SET reason_code='payload_changed' WHERE conflict_id=$1`,
      [conflictBefore.rows[0].conflict_id],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(ownerPool.query(
      'DELETE FROM host_story_attempt_conflicts WHERE conflict_id=$1',
      [conflictBefore.rows[0].conflict_id],
    )).rejects.toMatchObject({ code: '23514' });
    const conflictAfter = await ownerPool.query<{
      conflict_id: string; reason_code: string; observed_payload: unknown;
    }>(`SELECT conflict_id,reason_code,observed_payload FROM host_story_attempt_conflicts
         WHERE conflict_id=$1`, [conflictBefore.rows[0].conflict_id]);
    expect(conflictAfter.rows).toEqual(conflictBefore.rows);
    await expect(requireSuccessfulHostStoryAttempt({
      workspaceId: fixture.workspaceId, runId: fixture.runId, storyId: fixture.storyId,
      attempt: 1, launchGeneration: fixture.generation, cancellationFence: fixture.fence,
      manifestHash: fixture.exactManifest.manifestHash,
    })).rejects.toThrow('lacks exact successful host attempt authority');
    await expect(inspectRunHostAuthority(fixture.runId)).resolves.toMatchObject({
      complete: false,
      closeoutEligible: false,
      releaseEligible: false,
      authoritativePassedStoryIds: [],
    });
    await expect(persistHostRunCloseout({
      runId: fixture.runId,
      status: 'done',
      terminalizeRun: true,
      expectedDispatchFence: fixture.fence,
    })).rejects.toThrow(/conflict|authority/i);
  }
});

/* Legacy direct service matrix verifies every normalized outcome constraint. */
test('direct finalization constraints retain exact outcome semantics', async () => {
  const fixture = await seed('success', 30);
  await persistHostAttemptLaunches(fixture.launch);
  await finalizeHostStoryAttempt({
    workspaceId: fixture.workspaceId, runId: fixture.runId, storyId: fixture.storyId,
    attempt: 1, launchGeneration: fixture.generation, cancellationFence: fixture.fence,
    manifestHash: fixture.exactManifest.manifestHash, outcome: 'success', provenance: 'host_process', exitCode: 0,
  });
  await expect(requireSuccessfulHostStoryAttempt({
    workspaceId: fixture.workspaceId, runId: fixture.runId, storyId: fixture.storyId,
    attempt: 1, launchGeneration: fixture.generation, cancellationFence: fixture.fence,
    manifestHash: fixture.exactManifest.manifestHash,
  })).resolves.toBeUndefined();
});

test('database decision trigger rejects success after the active fence changes', async () => {
  const fixture = await seed('success', 8);
  await persistHostAttemptLaunches(fixture.launch);
  await finalizeHostStoryAttempt({
    workspaceId: fixture.workspaceId, runId: fixture.runId, storyId: fixture.storyId,
    attempt: 1, launchGeneration: fixture.generation, cancellationFence: fixture.fence,
    manifestHash: fixture.exactManifest.manifestHash, outcome: 'success', provenance: 'host_process', exitCode: 0,
  });
  const idSuffix = randomUUID().replaceAll('-', '').padEnd(64, '0');
  const attemptId = `ATR-sha256:${idSuffix}`;
  await ownerPool.query(`
    INSERT INTO story_attempt_results (
      attempt_result_id, manifest_hash, workspace_id, spec_id, run_id, story_id, attempt, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,1,'{}'::jsonb)
  `, [attemptId, fixture.exactManifest.manifestHash, fixture.workspaceId,
    fixture.exactManifest.identity.specId, fixture.runId, fixture.storyId]);
  await ownerPool.query('UPDATE pipeline_runs SET dispatch_fence = $2 WHERE id = $1', [
    fixture.runId, `sha256:${'e'.repeat(64)}`,
  ]);
  await expect(ownerPool.query(`
    INSERT INTO story_closeout_decisions (
      decision_id, manifest_hash, attempt_result_id, workspace_id, spec_id,
      run_id, story_id, attempt, status, payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,1,'accepted','{}'::jsonb)
  `, [`CLO-sha256:${idSuffix}`, fixture.exactManifest.manifestHash, attemptId,
    fixture.workspaceId, fixture.exactManifest.identity.specId, fixture.runId, fixture.storyId]))
    .rejects.toThrow('accepted story closeout lacks current successful host attempt authority');
});

test('changed revision, generation, Git, path, worktree, and fence are typed conflicts', async () => {
  const changed = await seed('success', 9);
  await persistHostAttemptLaunches(changed.launch);
  const tampered = {
    ...changed.exactManifest,
    revisions: { ...changed.exactManifest.revisions, specRevision: `sha256:${'f'.repeat(64)}` },
  } as ImmutableStoryExecutionManifest;
  await expect(persistHostAttemptLaunches({ ...changed.launch, manifests: [tampered] }))
    .rejects.toThrow('conflicts with spec_revision_mismatch');

  const generation = await seed('success', 10);
  await persistHostAttemptLaunches(generation.launch);
  await expect(persistHostAttemptLaunches({ ...generation.launch, launchGeneration: randomUUID() }))
    .rejects.toThrow('conflicts with stale_generation');

  const movedPath = await seed('success', 11);
  const movedCanonicalPath = 'forge/specs/approved/moved-wave1-attempt-proof.json';
  fs.writeFileSync(path.join(repository, movedCanonicalPath), movedPath.canonicalBytes);
  await expect(persistHostAttemptLaunches({
    ...movedPath.launch,
    canonicalSpecPath: movedCanonicalPath,
  })).rejects.toThrow('conflicts with canonical_path_mismatch');

  const movedWorktree = await seed('success', 12);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave1-attempt-clone-'));
  fs.rmSync(clone, { recursive: true, force: true });
  git(os.tmpdir(), ['clone', '-q', repository, clone]);
  try {
    await expect(persistHostAttemptLaunches({ ...movedWorktree.launch, worktreePath: clone }))
      .rejects.toThrow('conflicts with worktree_identity_mismatch');
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
  }

  const siblingWorktree = await seed('success', 18);
  const siblingId = randomUUID();
  const siblingPath = `${repository}-sibling-${siblingId}`;
  git(repository, ['worktree', 'add', '-q', '-b', `sibling-${siblingId}`, siblingPath, head]);
  const siblingRunSpecPath = path.join(siblingPath, '.rorca', 'run-specs', `run-${siblingWorktree.runId}.json`);
  fs.mkdirSync(path.dirname(siblingRunSpecPath), { recursive: true });
  fs.copyFileSync(siblingWorktree.runSpecPath, siblingRunSpecPath);
  await ownerPool.query('UPDATE pipeline_runs SET run_spec_path=$2 WHERE id=$1', [
    siblingWorktree.runId, siblingRunSpecPath,
  ]);
  try {
    await expect(persistHostAttemptLaunches({
      ...siblingWorktree.launch,
      worktreePath: siblingPath,
      runSpecPath: siblingRunSpecPath,
    })).rejects.toThrow('conflicts with worktree_identity_mismatch');
  } finally {
    git(repository, ['worktree', 'remove', '--force', siblingPath]);
  }

  const changedGit = await seed('success', 13);
  await persistHostAttemptLaunches(changedGit.launch);
  fs.writeFileSync(path.join(repository, 'changed.txt'), 'changed\n');
  git(repository, ['add', 'changed.txt']);
  git(repository, ['commit', '-q', '-m', 'changed']);
  try {
    await expect(persistHostAttemptLaunches(changedGit.launch))
      .rejects.toThrow('conflicts with git_revision_mismatch');
  } finally {
    git(repository, ['reset', '--hard', '-q', head]);
    fs.rmSync(path.join(repository, 'changed.txt'), { force: true });
  }

  const stale = await seed('success', 14);
  await persistHostAttemptLaunches(stale.launch);
  await ownerPool.query('UPDATE pipeline_runs SET dispatch_fence = $2 WHERE id = $1', [stale.runId, `sha256:${'e'.repeat(64)}`]);
  await expect(finalizeHostStoryAttempt({
    workspaceId: stale.workspaceId, runId: stale.runId, storyId: stale.storyId,
    attempt: 1, launchGeneration: stale.generation, cancellationFence: stale.fence,
    manifestHash: stale.exactManifest.manifestHash, outcome: 'success', provenance: 'host_process', exitCode: 0,
  })).rejects.toThrow('conflicts with immutable launch authority');

  const conflicts = await ownerPool.query<{ reason_code: string }>(`
    SELECT reason_code FROM host_story_attempt_conflicts
     WHERE run_id = ANY($1::bigint[]) ORDER BY observed_at
  `, [[changed.runId, generation.runId, movedPath.runId, movedWorktree.runId,
    siblingWorktree.runId, changedGit.runId, stale.runId]]);
  expect(conflicts.rows.map((row) => row.reason_code).sort()).toEqual([
    'cancellation_fence_mismatch', 'canonical_path_mismatch', 'git_revision_mismatch',
    'spec_revision_mismatch', 'stale_generation', 'worktree_identity_mismatch',
    'worktree_identity_mismatch',
  ].sort());
});
