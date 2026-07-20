/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { execute, queryOne } from '../../db/index';
import {
  cancelGovernedRetryPreview,
  classifyGovernedRetryPublication,
  waitForGovernedRetryPublication,
  type GovernedRetryPublicationSnapshot,
} from '../governed-retry-publication';
import { createRetryPreview, retryHash } from '../retry-governance';

const HASH = (character: string): string => `sha256:${character.repeat(64)}`;
const SHA = (character: string): string => character.repeat(40);

function publication(overrides: Partial<GovernedRetryPublicationSnapshot> = {}): GovernedRetryPublicationSnapshot {
  return {
    previewStatus: 'approved',
    preparationState: 'outbox_ready',
    dispatchState: 'prepared',
    runStatus: 'queued',
    bossJobId: null,
    ...overrides,
  };
}

test('a fast exact delivery waits through prepared/approved publication without classifying the run failed', async () => {
  const snapshots = [
    publication(),
    publication(),
    publication({
      previewStatus: 'dispatched',
      preparationState: 'published',
      dispatchState: 'dispatched',
      bossJobId: randomUUID(),
    }),
  ];
  let reads = 0;
  const result = await waitForGovernedRetryPublication({
    read: async () => snapshots[Math.min(reads++, snapshots.length - 1)],
    attempts: 4,
    delayMs: 0,
    sleep: async () => undefined,
  });

  expect(result.outcome).toBe('published');
  expect(reads).toBe(3);
  expect(classifyGovernedRetryPublication(publication())).toBe('pending');
});

test('publication and cancellation replays are terminal and idempotent classifications', () => {
  const published = publication({
    previewStatus: 'dispatched', preparationState: 'published', dispatchState: 'claimed', bossJobId: randomUUID(),
  });
  const cancelled = publication({
    previewStatus: 'cancelled', preparationState: 'cancelled', dispatchState: 'cancelled', runStatus: 'cancelled',
  });
  expect(classifyGovernedRetryPublication(published)).toBe('published');
  expect(classifyGovernedRetryPublication(published)).toBe('published');
  expect(classifyGovernedRetryPublication(cancelled)).toBe('cancelled');
  expect(classifyGovernedRetryPublication(cancelled)).toBe('cancelled');
});

test('cancelPreview atomically terminalizes the queued run, dispatch, pending attempt, and evidence once', async () => {
  const suffix = randomUUID();
  const workspaceId = `retry-cancel-${suffix}`;
  const specId = `retry-cancel-${suffix}`;
  let originalRunId: number | undefined;
  let retryRunId: number | undefined;
  let previewHash: string | undefined;
  let dispatchIdentityHash: string | undefined;
  let manifestHash: string | undefined;

  try {
    await execute(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Governed retry cancellation', '/tmp')`,
      [workspaceId],
    );
    originalRunId = Number((await queryOne<{ id: number | string }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, finished_at)
       VALUES ('forge/specs/approved/retry-cancel.json', $1, 'failed', NOW()) RETURNING id`,
      [workspaceId],
    ))!.id);
    retryRunId = Number((await queryOne<{ id: number | string }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, retried_from_run_id, trigger_type)
       VALUES ('forge/specs/approved/retry-cancel.json', $1, 'queued', $2, 'retry') RETURNING id`,
      [workspaceId, originalRunId],
    ))!.id);

    const packet = createRetryPreview({
      originalRunId,
      scope: {
        requested: [{ storyId: 'US-001', reasonCode: 'REQUESTED_FAILED_STORY' }],
        requiredDependency: [], copiedPassed: [], skipped: [], remaining: [], excluded: [],
        executable: [{ storyId: 'US-001', reasonCode: 'EXECUTABLE_RETRY_WORK' }],
      },
      options: {
        agent: 'pi', model: null, effort: null, terminalMode: 'ansi-html', includeGraph: false,
        worktree: { enabled: false, path: null, branch: null },
        merge: { strategy: 'branch-only', autoMerge: false },
        safety: { deploy: false, externalSend: false, policyLocked: true, allowBackendJest: false },
      },
      forceSequential: true,
      requiresApproval: false,
    });
    previewHash = packet.previewHash;
    dispatchIdentityHash = retryHash({ fixture: suffix, kind: 'dispatch' });
    manifestHash = retryHash({ fixture: suffix, kind: 'manifest' });
    const bossJobId = randomUUID();

    await execute(
      `INSERT INTO pipeline_retry_previews (
         preview_hash, original_run_id, retry_run_id, workspace_id, scope_hash, status,
         packet, preview_identity_hash, expires_at, idempotency_key, approved_at,
         preparation_state, preparation_owner, preparation_lease_expires_at, preparation_generation
       ) VALUES ($1,$2,$3,$4,$5,'approved',$6::jsonb,$7,NOW() + INTERVAL '5 minutes',$8,NOW(),
                 'outbox_ready','test-owner',NOW() + INTERVAL '5 minutes',1)`,
      [previewHash, originalRunId, retryRunId, workspaceId, retryHash(['US-001']), JSON.stringify(packet), HASH('1'), `cancel-test:${suffix}`],
    );
    await execute(
      `INSERT INTO governed_retry_dispatches (
         identity_hash, workspace_id, spec_id, spec_revision, original_run_id, retry_run_id,
         original_run_lineage, base_revision, integrated_revision, prior_integration_ancestry,
         recovery_ref, recovery_ref_revision, preview_hash, scope_hash, evidence_hash,
         execution_manifest_hash, queue_payload_hash, job_payload, queue_name, idempotency_key,
         lease_identity, state, boss_job_id
       ) VALUES ($1,$2,$3,'spec-revision',$4,$5,$6::jsonb,$7,$7,$8::jsonb,'HEAD',$7,$9,$10,$11,
                 $12,$13,'{}'::jsonb,'pipeline:retry',$14,$15,'dispatched',$16::uuid)`,
      [
        dispatchIdentityHash, workspaceId, specId, originalRunId, retryRunId,
        JSON.stringify([originalRunId]), SHA('a'), JSON.stringify([SHA('a')]), previewHash,
        retryHash(['US-001']), HASH('2'), HASH('3'), HASH('4'), `cancel-dispatch:${suffix}`,
        HASH('5'), bossJobId,
      ],
    );
    await execute(
      `INSERT INTO story_execution_manifests (
         manifest_hash, schema_version, workspace_id, spec_id, run_id, story_id, attempt,
         spec_revision, story_revision, payload
       ) VALUES ($1,'story-execution-manifest.v1',$2,$3,$4,'US-001',2,'spec-revision','story-revision','{}'::jsonb)`,
      [manifestHash, workspaceId, specId, retryRunId],
    );
    await execute(
      `INSERT INTO governed_retry_story_attempts (
         attempt_identity, dispatch_identity_hash, workspace_id, spec_id, original_root_run_id,
         source_run_id, retry_run_id, story_id, attempt, previous_attempt, idempotency_key,
         manifest_hash, state, recovery_ref
       ) VALUES ($1,$2,$3,$4,$5,$5,$6,'US-001',2,1,$7,$8,'pending','HEAD')`,
      [retryHash({ fixture: suffix, kind: 'attempt' }), dispatchIdentityHash, workspaceId, specId, originalRunId, retryRunId, `cancel-attempt:${suffix}`, manifestHash],
    );

    const cancellationInput = {
      previewHash,
      originalRunId,
      workspaceId,
      packet,
      previewIdentityHash: HASH('1'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const first = await cancelGovernedRetryPreview(cancellationInput);
    const replay = await cancelGovernedRetryPreview(cancellationInput);

    expect(first).toMatchObject({ cancelled: true, duplicate: false, terminal: 'cancelled', retryRunId });
    expect(replay).toMatchObject({ cancelled: true, duplicate: true, terminal: 'cancelled', retryRunId });
    expect(await queryOne(`SELECT status, lifecycle_status FROM pipeline_runs WHERE id = $1`, [retryRunId])).toMatchObject({
      status: 'cancelled', lifecycle_status: 'cancelled',
    });
    expect(await queryOne(`SELECT state, cancellation_evidence FROM governed_retry_dispatches WHERE identity_hash = $1`, [dispatchIdentityHash])).toMatchObject({
      state: 'cancelled',
    });
    expect(await queryOne(`SELECT state, cancellation_evidence FROM governed_retry_story_attempts WHERE dispatch_identity_hash = $1`, [dispatchIdentityHash])).toMatchObject({
      state: 'cancelled',
    });
    const evidenceCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM wal_events WHERE ingest_key = $1`,
      [`governed-retry-cancel:${previewHash}`],
    );
    expect(evidenceCount?.count).toBe('1');
    await expect(execute(
      `UPDATE governed_retry_dispatches SET state = 'dispatched' WHERE identity_hash = $1`,
      [dispatchIdentityHash],
    )).rejects.toThrow(/illegal governed retry dispatch transition|terminal governed retry evidence is immutable/);
  } finally {
    if (previewHash) await execute('DELETE FROM wal_events WHERE ingest_key = $1', [`governed-retry-cancel:${previewHash}`]).catch(() => undefined);
    if (dispatchIdentityHash) await execute('DELETE FROM governed_retry_story_attempts WHERE dispatch_identity_hash = $1', [dispatchIdentityHash]).catch(() => undefined);
    if (dispatchIdentityHash) await execute('DELETE FROM governed_retry_dispatches WHERE identity_hash = $1', [dispatchIdentityHash]).catch(() => undefined);
    if (previewHash) await execute('DELETE FROM pipeline_retry_previews WHERE preview_hash = $1', [previewHash]).catch(() => undefined);
    if (manifestHash) await execute('DELETE FROM story_execution_manifests WHERE manifest_hash = $1', [manifestHash]).catch(() => undefined);
    if (retryRunId) await execute('DELETE FROM pipeline_runs WHERE id = $1', [retryRunId]).catch(() => undefined);
    if (originalRunId) await execute('DELETE FROM pipeline_runs WHERE id = $1', [originalRunId]).catch(() => undefined);
    await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]).catch(() => undefined);
  }
});
