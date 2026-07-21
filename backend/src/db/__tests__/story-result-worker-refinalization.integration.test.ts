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
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../../lib/test-db-safety';
import {
  EXECUTION_ENGINE_RESULT_AUTHORITY,
  persistCanonicalStoryResult,
  recoverIntegratedValidatedStoryFinalizations,
  stageIntegratedPassRecoveryPacket,
  type CanonicalStoryResultInput,
  type StoryResultAtomicFinalizationOptions,
} from '../../lib/story-result-persistence';
import {
  advanceDurableWaveIntegration,
  prepareDurableWaveIntegration,
  type DurableWaveIntegrationIdentity,
} from '../../lib/wave-integration-store';

const connectionString = resolveTestDatabaseUrl();
const pool = new Pool({ connectionString, max: 2 });
const hash64 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('worker-only integrated pass re-finalization (real PostgreSQL/Git)', () => {
  const workspaceId = `refinalize-${crypto.randomUUID()}`;
  const storyId = 'US-REFINALIZE-001';
  const blockedStoryId = 'US-REFINALIZE-BLOCKED';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-refinalize-'));
  const repository = path.join(root, 'repository');
  const branchName = `cert/refinalize-${crypto.randomUUID()}`;
  const manifestDigest = hash64('manifest');
  const manifestHash = `sha256:${manifestDigest}`;
  const receiptHash = hash64('receipt');
  let runId: number;
  let head: string;
  let input: CanonicalStoryResultInput;
  let options: StoryResultAtomicFinalizationOptions;

  beforeAll(async () => {
    await assertConnectedTestDatabase(pool, connectionString);
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ['init', '-b', branchName]);
    git(repository, ['config', 'user.email', 'cert@example.test']);
    git(repository, ['config', 'user.name', 'Rorca Certification']);
    fs.writeFileSync(path.join(repository, 'story.txt'), 'integrated implementation\n');
    git(repository, ['add', 'story.txt']);
    git(repository, ['commit', '-m', 'integrate certified story']);
    head = git(repository, ['rev-parse', 'HEAD']);

    await pool.query(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Refinalization fixture', $2)`,
      [workspaceId, repository],
    );
    runId = Number((await pool.query<{ id: string }>(
      `INSERT INTO pipeline_runs
         (spec_path, workspace_id, status, branch_name, expected_story_ids,
          execution_workspace_path, execution_worktree_path)
       VALUES ('forge/specs/approved/refinalization.json', $1, 'running', $2, $3, $4, $4)
       RETURNING id`,
      [workspaceId, branchName, [storyId, blockedStoryId], repository],
    )).rows[0].id);
    await pool.query(
      `INSERT INTO story_execution_manifests
         (manifest_hash, schema_version, workspace_id, spec_id, run_id, story_id,
          attempt, spec_revision, story_revision, payload)
       VALUES ($1, 'v1', $2, 'refinalization', $3, $4, 1, 'spec-r1', 'story-r1', $5::jsonb)`,
      [manifestHash, workspaceId, runId, storyId, JSON.stringify({ storyId, head })],
    );
    const attemptResultId = `ATR-sha256:${hash64(`attempt:${runId}:${storyId}`)}`;
    const decisionId = `CLO-sha256:${hash64(`decision:${runId}:${storyId}`)}`;
    await pool.query(
      `INSERT INTO story_attempt_results
         (attempt_result_id, manifest_hash, workspace_id, spec_id, run_id, story_id, attempt, payload)
       VALUES ($1, $2, $3, 'refinalization', $4, $5, 1, $6::jsonb)`,
      [attemptResultId, manifestHash, workspaceId, runId, storyId, JSON.stringify({ status: 'pass' })],
    );
    await pool.query(
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
    await pool.query(
      `INSERT INTO story_integration_ledger
         (run_id, story_id, attempt, wave_index, integration_order, state,
          source_commit, source_base_commit, expected_parent_head, resulting_head,
          frozen_manifest_hash, validation_identity)
       VALUES ($1, $2, 1, 1, 2, 'integrated_validated', $3, $3, $3, $3, $4, $5::jsonb)`,
      [runId, blockedStoryId, head, manifestDigest, JSON.stringify({ validator: 'no-packet' })],
    );
  });

  afterAll(async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.RORCA_PROCESS_ROLE;
    if (runId) {
      await pool.query('DELETE FROM wal_events WHERE canonical_run_id = $1', [runId]);
      await pool.query('DELETE FROM token_usage WHERE run_id = $1', [runId]);
      await pool.query('DELETE FROM story_commits WHERE run_id = $1', [runId]);
      await pool.query('DELETE FROM story_results WHERE run_id = $1', [runId]);
      await pool.query('DELETE FROM pipeline_runs WHERE id = $1', [runId]);
    }
    await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
    await pool.end();
    fs.rmSync(root, { recursive: true, force: true });
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
      process.env.NODE_ENV = priorNodeEnv;
      if (priorRole === undefined) delete process.env.RORCA_PROCESS_ROLE;
      else process.env.RORCA_PROCESS_ROLE = priorRole;
    }

    const projections = await pool.query<{
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
    expect((await pool.query(
      `SELECT COUNT(*)::text AS count FROM story_results WHERE run_id = $1 AND story_id = $2`,
      [runId, blockedStoryId],
    )).rows[0].count).toBe('0');

    const replay = await persistCanonicalStoryResult(
      input,
      EXECUTION_ENGINE_RESULT_AUTHORITY,
      options,
    );
    expect(replay.duplicate).toBe(true);
    const afterReplay = await pool.query(
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
