/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { resetDisposableWave1Database } from './wave1-test-cleanup';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../../lib/test-db-safety';
import type {
  EXECUTION_ENGINE_RESULT_AUTHORITY as ExecutionEngineResultAuthority,
  persistCanonicalStoryResult as PersistCanonicalStoryResult,
  recoverIntegratedValidatedStoryFinalizations as RecoverIntegratedValidatedStoryFinalizations,
  stageIntegratedPassRecoveryPacket as StageIntegratedPassRecoveryPacket,
  CanonicalStoryResultInput,
  StoryResultAtomicFinalizationOptions,
} from '../../lib/story-result-persistence';
import type {
  advanceDurableWaveIntegration as AdvanceDurableWaveIntegration,
  prepareDurableWaveIntegration as PrepareDurableWaveIntegration,
  DurableWaveIntegrationIdentity,
} from '../../lib/wave-integration-store';
import type { closePool as ClosePool, query as RuntimeQuery } from '../../db/index';

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  RORCA_PROCESS_ROLE: process.env.RORCA_PROCESS_ROLE,
  RORCA_TEST_DATABASE_WORKSPACE_SCOPE: process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE,
};
const suiteWorkspaceId = `refinalize-${crypto.randomUUID()}`;
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
  EXECUTION_ENGINE_RESULT_AUTHORITY,
  persistCanonicalStoryResult,
  recoverIntegratedValidatedStoryFinalizations,
  stageIntegratedPassRecoveryPacket,
} = require('../../lib/story-result-persistence') as {
  EXECUTION_ENGINE_RESULT_AUTHORITY: typeof ExecutionEngineResultAuthority;
  persistCanonicalStoryResult: typeof PersistCanonicalStoryResult;
  recoverIntegratedValidatedStoryFinalizations: typeof RecoverIntegratedValidatedStoryFinalizations;
  stageIntegratedPassRecoveryPacket: typeof StageIntegratedPassRecoveryPacket;
};
const {
  advanceDurableWaveIntegration,
  prepareDurableWaveIntegration,
} = require('../../lib/wave-integration-store') as {
  advanceDurableWaveIntegration: typeof AdvanceDurableWaveIntegration;
  prepareDurableWaveIntegration: typeof PrepareDurableWaveIntegration;
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
const hash64 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('worker-only integrated pass re-finalization (real PostgreSQL/Git)', () => {
  const workspaceId = suiteWorkspaceId;
  const storyId = 'US-REFINALIZE-001';
  const blockedStoryId = 'US-REFINALIZE-BLOCKED';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-refinalize-'));
  const repository = path.join(root, 'repository');
  const branchName = `cert/refinalize-${crypto.randomUUID()}`;
  const manifestDigest = hash64('manifest');
  const manifestHash = `sha256:${manifestDigest}`;
  const receiptHash = hash64('receipt');
  const cancellationFence = `sha256:${hash64('fence')}`;
  const specRevision = `sha256:${hash64('spec-r1')}`;
  const storyRevision = `sha256:${hash64('story-r1')}`;
  const specBytesHash = `sha256:${hash64('spec-bytes')}`;
  let runId: number;
  let head: string;
  let input: CanonicalStoryResultInput;
  let options: StoryResultAtomicFinalizationOptions;

  beforeAll(async () => {
    await assertConnectedTestDatabase(ownerPool, migrationDatabaseUrl);
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ['init', '-b', branchName]);
    git(repository, ['config', 'user.email', 'cert@example.test']);
    git(repository, ['config', 'user.name', 'Rorca Certification']);
    fs.writeFileSync(path.join(repository, 'story.txt'), 'integrated implementation\n');
    git(repository, ['add', 'story.txt']);
    git(repository, ['commit', '-m', 'integrate certified story']);
    head = git(repository, ['rev-parse', 'HEAD']);

    await ownerPool.query(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Refinalization fixture', $2)`,
      [workspaceId, repository],
    );
    runId = Number((await ownerPool.query<{ id: string }>(
      `INSERT INTO pipeline_runs
         (spec_path, workspace_id, status, branch_name, expected_story_ids,
          execution_workspace_path, execution_worktree_path, dispatch_fence,
          canonical_spec_revision, canonical_spec_bytes_hash, run_spec_path,
          run_spec_revision, run_spec_bytes_hash)
       VALUES ('forge/specs/approved/refinalization.json', $1, 'running', $2, $3, $4, $4,
         $5,$6,$7,'.rorca/run-specs/refinalization.json',$6,$7)
       RETURNING id`,
      [workspaceId, branchName, [storyId, blockedStoryId], repository,
        cancellationFence, specRevision, specBytesHash],
    )).rows[0].id);
    await ownerPool.query(
      `INSERT INTO story_execution_manifests
         (manifest_hash, schema_version, workspace_id, spec_id, run_id, story_id,
          attempt, spec_revision, story_revision, payload)
       VALUES ($1, 'v1', $2, 'refinalization', $3, $4, 1, $5, $6, $7::jsonb)`,
      [manifestHash, workspaceId, runId, storyId, specRevision, storyRevision,
        JSON.stringify({ storyId, head })],
    );
    await ownerPool.query(
      `INSERT INTO host_story_attempt_envelopes(
         schema_version,workspace_id,run_id,story_id,attempt,launch_generation,
         cancellation_fence,manifest_hash,spec_id,spec_revision,story_revision,
         canonical_spec_path,canonical_spec_revision,canonical_spec_bytes_hash,
         run_spec_path,run_spec_revision,run_spec_bytes_hash,repository_realpath,
         repository_identity,base_git_sha,expected_git_sha,observed_git_sha,
         expected_git_branch,worktree_realpath,worktree_identity,worktree_branch,
         runtime_identity,identity_hash,authority_state,outcome,outcome_provenance,
         exit_code,finished_at,payload_hash)
       VALUES('rorca.host-story-attempt-envelope.v1',$1,$2,$3,1,$4,$5,$6,
         'refinalization',$7,$8,'forge/specs/approved/refinalization.json',$7,$9,
         '.rorca/run-specs/refinalization.json',$7,$9,$10,$11,$12::text,$12::text,$12::text,$13,
         $10,$14,$13,$15::jsonb,$16,'valid','success','host_process',0,
         statement_timestamp(),$17)`,
      [
        workspaceId, runId, storyId, crypto.randomUUID(), cancellationFence,
        manifestHash, specRevision, storyRevision, specBytesHash, repository,
        `sha256:${hash64('repository')}`, head, branchName,
        `sha256:${hash64('worktree')}`,
        JSON.stringify({ processRole: 'worker-engine', processPid: process.pid }),
        `sha256:${hash64('host-attempt-identity')}`,
        `sha256:${hash64('host-attempt-payload')}`,
      ],
    );
    const attemptResultId = `ATR-sha256:${hash64(`attempt:${runId}:${storyId}`)}`;
    const decisionId = `CLO-sha256:${hash64(`decision:${runId}:${storyId}`)}`;
    await ownerPool.query(
      `INSERT INTO story_attempt_results
         (attempt_result_id, manifest_hash, workspace_id, spec_id, run_id, story_id, attempt, payload)
       VALUES ($1, $2, $3, 'refinalization', $4, $5, 1, $6::jsonb)`,
      [attemptResultId, manifestHash, workspaceId, runId, storyId, JSON.stringify({ status: 'pass' })],
    );
    await ownerPool.query(
      `INSERT INTO story_closeout_decisions
         (decision_id, manifest_hash, attempt_result_id, workspace_id, spec_id,
          run_id, story_id, attempt, status, payload)
       VALUES ($1, $2, $3, $4, 'refinalization', $5, $6, 1, 'accepted', $7::jsonb)`,
      [decisionId, manifestHash, attemptResultId,
        workspaceId, runId, storyId, JSON.stringify({ accepted: true })],
    );

    const identity: DurableWaveIntegrationIdentity = {
      runId,
      storyId,
      attempt: 1,
      waveIndex: 1,
      integrationOrder: 1,
      sourceCommit: head,
      sourceBaseCommit: head,
      expectedParentHead: head,
      frozenManifestHash: manifestDigest,
    };
    await prepareDurableWaveIntegration(identity);
    await advanceDurableWaveIntegration({ identity, from: 'prepared', to: 'integrating' });
    await advanceDurableWaveIntegration({ identity, from: 'integrating', to: 'integrated', resultingHead: head });

    input = {
      runId,
      storyId,
      status: 'pass',
      integrated: true,
      commitSha: head,
      commitMessage: 'integrate certified story',
      worktreePath: repository,
      worktreeBranch: branchName,
      inputTokens: 21,
      outputTokens: 13,
      reasoningTokens: 5,
      modelUsed: 'cert-model',
      costUsd: 0.125,
      idempotencyKey: `refinalize:${runId}:${storyId}:1`,
      trustedPassOutbox: { payload: { result: 'pass', authority: 'locked-recovery-packet' } },
    };
    options = {
      integrationFinalization: {
        attempt: 1,
        resultingHead: head,
        validationIdentity: {
          validator: 'cert-validator', revision: head, treeHash: git(repository, ['rev-parse', 'HEAD^{tree}']),
          contractHash: hash64('validation-contract'),
        },
        finalizationIdentity: {
          idempotencyKey: input.idempotencyKey!, revision: head, receiptHash,
        },
      },
    };
    const staged = await stageIntegratedPassRecoveryPacket(input, options);
    expect(staged.replayed).toBe(false);

    // A second validated ledger without a packet proves the worker cannot infer
    // or author a result from state alone.
    await ownerPool.query(
      `INSERT INTO story_integration_ledger
         (run_id, story_id, attempt, wave_index, integration_order, state,
          source_commit, source_base_commit, expected_parent_head, resulting_head,
          frozen_manifest_hash, validation_identity)
       VALUES ($1, $2, 1, 1, 2, 'integrated_validated', $3, $3, $3, $3, $4, $5::jsonb)`,
      [runId, blockedStoryId, head, manifestDigest, JSON.stringify({ validator: 'no-packet' })],
    );
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
            fs.rmSync(root, { recursive: true, force: true });
          } finally {
            restoreEnvironment('NODE_ENV');
            restoreEnvironment('RORCA_PROCESS_ROLE');
            restoreEnvironment('RORCA_TEST_DATABASE_WORKSPACE_SCOPE');
          }
        }
      }
    }
  });

  it('binds the runtime principal to this suite and hides cross-workspace runs', async () => {
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
      `[principal-map] suite=story-result-worker-refinalization migration_owner=${ownerAuthority.current_user} `
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

  it('requires worker role, atomically projects the locked packet once, blocks missing packets, and replays exactly', async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    const priorRole = process.env.RORCA_PROCESS_ROLE;
    try {
      process.env.NODE_ENV = 'production';
      process.env.RORCA_PROCESS_ROLE = 'api';
      await expect(recoverIntegratedValidatedStoryFinalizations({ runId }))
        .rejects.toThrow('requires worker process authority');

      process.env.RORCA_PROCESS_ROLE = 'worker';
      const recovered = await recoverIntegratedValidatedStoryFinalizations({ runId, limit: 10 });
      expect(recovered).toMatchObject({ scanned: 2, finalized: 1, duplicates: 0, blocked: 1 });
      expect(recovered.finalizedStoryIds).toEqual([storyId]);
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
      if (priorRole === undefined) delete process.env.RORCA_PROCESS_ROLE;
      else process.env.RORCA_PROCESS_ROLE = priorRole;
    }

    const projections = await ownerPool.query<{
      results: string; commits: string; accounting: string; outbox: string; finalized: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM story_results WHERE run_id = $1 AND story_id = $2)::text AS results,
         (SELECT COUNT(*) FROM story_commits WHERE run_id = $1 AND story_id = $2)::text AS commits,
         (SELECT COUNT(*) FROM token_usage WHERE run_id = $1 AND story_id = $2)::text AS accounting,
         (SELECT COUNT(*) FROM wal_events WHERE canonical_run_id = $1 AND story_id = $2
           AND trust_provenance = 'host' AND trusted_source = 'story-result')::text AS outbox,
         (SELECT COUNT(*) FROM story_integration_ledger WHERE run_id = $1 AND story_id = $2
           AND state = 'finalized')::text AS finalized`,
      [runId, storyId],
    );
    expect(projections.rows[0]).toEqual({
      results: '1', commits: '1', accounting: '1', outbox: '1', finalized: '1',
    });
    expect((await ownerPool.query(
      `SELECT COUNT(*)::text AS count FROM story_results WHERE run_id = $1 AND story_id = $2`,
      [runId, blockedStoryId],
    )).rows[0].count).toBe('0');

    const replay = await persistCanonicalStoryResult(
      input,
      EXECUTION_ENGINE_RESULT_AUTHORITY,
      options,
    );
    expect(replay.duplicate).toBe(true);
    const afterReplay = await ownerPool.query(
      `SELECT
         (SELECT COUNT(*) FROM story_results WHERE run_id = $1 AND story_id = $2)::text AS results,
         (SELECT COUNT(*) FROM story_commits WHERE run_id = $1 AND story_id = $2)::text AS commits,
         (SELECT COUNT(*) FROM token_usage WHERE run_id = $1 AND story_id = $2)::text AS accounting,
         (SELECT COUNT(*) FROM wal_events WHERE canonical_run_id = $1 AND story_id = $2
           AND trusted_source = 'story-result')::text AS outbox`,
      [runId, storyId],
    );
    expect(afterReplay.rows[0]).toEqual({ results: '1', commits: '1', accounting: '1', outbox: '1' });
  }, 60_000);
});
