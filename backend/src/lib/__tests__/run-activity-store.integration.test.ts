/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import crypto from 'node:crypto';
import { Pool, type QueryResultRow } from 'pg';
import { closePool } from '../../db';
import { ContinuationScopeSchema, type ContinuationScope } from '../governed-contracts/context-continuation';
import { governedHash } from '../governed-contracts/primitives';
import { RuntimeNeutralObservationV1Schema, RuntimeTelemetryBatchV1Schema, type RuntimeNeutralObservationV1 } from '../governed-contracts/run-stream';
import { RunActivityStore, runtimeTelemetryBatchIntegrityHash } from '../run-activity-store';

const migrationDatabaseUrl = process.env.RORCA_MIGRATION_DATABASE_URL ?? process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
const runtimeDatabaseUrl = process.env.DATABASE_URL;
if (!migrationDatabaseUrl || !runtimeDatabaseUrl) throw new Error('Isolated migration and runtime database URLs are required');

const suffix = crypto.randomUUID();
const workspaceA = `workspace:activity-a-${suffix}`;
const workspaceB = `workspace:activity-b-${suffix}`;
const workspaceC = `workspace:activity-c-${suffix}`;
const H = (digit: string) => `sha256:${digit.repeat(64)}`;
const G = (digit: string) => digit.repeat(40);
const ownerPool = new Pool({ connectionString: migrationDatabaseUrl,
  options: '--search_path=rorca,public -c rorca.migration_mode=on' });
const runtimePool = new Pool({ connectionString: runtimeDatabaseUrl,
  options: `--search_path=rorca,public -c rorca.workspace_id=${workspaceA}` });
const store = new RunActivityStore();
async function queryWorkspace<T extends QueryResultRow>(
  workspaceId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await runtimePool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    const result = await client.query<T>(sql, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}


interface Fixture {
  workspaceId: string;
  runId: number;
  streamId: string;
  attemptId: string;
  leaseId: string;
  runtimeId: string;
  scope: ContinuationScope;
}

function fixture(workspaceId: string, runId: number, label: string): Fixture {
  const missionId = `mission:${label}`;
  const workPackageId = `work-package:${label}`;
  const attemptId = `attempt:${label}`;
  const leaseId = `lease:${label}`;
  const runtimeId = `runtime:${label}`;
  const spec = { specId: `spec:${label}`, specVersion: 1, specHash: H('1'), canonicalSpecPath: `specs/${label}.json`,
    storyId: `story:${label}`, storyVersion: 1, storyHash: H('2'), criteriaManifestHash: H('3') };
  const repository = { repositoryId: `repository:${label}`, remoteAuthorityHash: H('4'), gitObjectFormat: 'sha1' as const,
    baseSha: G('a'), currentSha: G('a'), expectedHeadSha: G('a'), worktreeId: `worktree:${label}`,
    allowedPathManifestHash: H('5'), requiredPathManifestHash: H('6'), changedPathManifestHash: H('7'),
    forbiddenPathManifestHash: H('8') };
  return {
    workspaceId,
    runId,
    streamId: `stream:${label}`,
    attemptId,
    leaseId,
    runtimeId,
    scope: ContinuationScopeSchema.parse({
      workspaceId, missionId, missionRevision: 1, missionHash: H('9'), workPackageId, workPackageRevision: 1,
      workPackageHash: H('a'), spec, runId, attemptId, leaseId, fencingToken: 1,
      leaseExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), cancellationId: 'cancellation:none', runtimeId,
      controllerGeneration: 1, runtimeGeneration: 0, sessionId: `session:${label}`, sessionFileHash: H('b'),
      turnId: `turn:${label}`, turnAttempt: 1, originatingGeneration: 0, cursor: 0, cursorHash: H('c'),
      priorEntryId: 'not_applicable', repository, validationStateHash: H('d'),
      rootCauseClassification: 'root-cause:none', rootCauseHash: H('e'),
      policyDefinitionId: `policy:${label}`, policyDefinitionVersion: '1.0.0', policyDefinitionHash: H('f'),
      policyActivationId: `activation:${label}`, policyActivationRevision: 1, policyActivationHash: H('0'),
    }),
  };
}

const a = fixture(workspaceA, 91001, `activity-a-${suffix}`);
const b = fixture(workspaceB, 91002, `activity-b-${suffix}`);
const c0 = fixture(workspaceC, 91003, `activity-c-${suffix}`);
const c1: Fixture = {
  ...c0,
  streamId: `${c0.streamId}:generation-1`,
  attemptId: `${c0.attemptId}:generation-1`,
  leaseId: `${c0.leaseId}:generation-1`,
  scope: ContinuationScopeSchema.parse({
    ...c0.scope,
    attemptId: `${c0.attemptId}:generation-1`,
    leaseId: `${c0.leaseId}:generation-1`,
    fencingToken: 2,
    controllerGeneration: 2,
    runtimeGeneration: 1,
    originatingGeneration: 1,
    sessionId: `${c0.scope.sessionId}:generation-1`,
    turnId: `${c0.scope.turnId}:generation-1`,
  }),
};

async function seed(input: Fixture): Promise<void> {
  const scope = input.scope;
  const spec = scope.spec;
  const repository = scope.repository;
  await ownerPool.query(`INSERT INTO workspaces(id,label,path) VALUES($1,$1,$2)`,
    [input.workspaceId, `/tmp/${input.workspaceId}`]);
  await ownerPool.query(`INSERT INTO governed_missions(workspace_id,mission_id,created_by) VALUES($1,$2,'host:test')`,
    [input.workspaceId, scope.missionId]);
  await ownerPool.query(`INSERT INTO governed_mission_versions(
      workspace_id,mission_id,mission_revision,mission_hash,contract_version,canonical_spec_id,
      canonical_spec_version,canonical_spec_hash,canonical_spec_path,repository_id,base_sha,payload_json,payload_hash,created_by)
    VALUES($1,$2,1,$3,'1.0.0',$4,1,$5,$6,$7,$8,$9::jsonb,$10,'host:test')`, [
    input.workspaceId, scope.missionId, scope.missionHash, spec.specId, spec.specHash, spec.canonicalSpecPath,
    repository.repositoryId, repository.baseSha, JSON.stringify({ spec }), H('1'),
  ]);
  await ownerPool.query(`INSERT INTO governed_work_packages(workspace_id,mission_id,work_package_id,created_by)
    VALUES($1,$2,$3,'host:test')`, [input.workspaceId, scope.missionId, scope.workPackageId]);
  const workPackagePayload = {
    schemaVersion: 'rorca.work-package.v1', contractId: 'rorca.work-package.v1', contractVersion: '1.0.0',
    workspaceId: input.workspaceId, missionId: scope.missionId, missionRevision: 1, missionHash: scope.missionHash,
    workPackageId: scope.workPackageId, workPackageRevision: 1, workPackageHash: scope.workPackageHash,
    spec, repository,
  };
  await ownerPool.query(`INSERT INTO governed_work_package_revisions(
      workspace_id,mission_id,work_package_id,work_package_revision,work_package_hash,mission_revision,
      mission_hash,story_id,repository_id,base_sha,allowed_path_manifest_hash,required_path_manifest_hash,
      validation_manifest_hash,authority_ceiling_hash,payload_json,proposal_id)
    VALUES($1,$2,$3,1,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)`, [
    input.workspaceId, scope.missionId, scope.workPackageId, scope.workPackageHash, scope.missionHash, spec.storyId,
    repository.repositoryId, repository.baseSha, repository.allowedPathManifestHash, repository.requiredPathManifestHash,
    H('2'), H('3'), JSON.stringify(workPackagePayload), `proposal:${input.attemptId}`,
  ]);
  await ownerPool.query(`INSERT INTO pipeline_runs(
      id,spec_path,workspace_id,status,branch_name,worktree_path,execution_workspace_path,
      execution_worktree_path,dispatch_fence,canonical_spec_revision)
    VALUES($1,$2,$3,'running','main',$4,$4,$4,$5,$6)`, [input.runId, spec.canonicalSpecPath, input.workspaceId,
    `/tmp/${input.workspaceId}`, H('4'), spec.specHash]);
  await ownerPool.query(`INSERT INTO governed_execution_attempts(
      workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,
      generation,manifest_hash,repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,
      criteria_manifest_hash,base_sha,current_sha,expected_head_sha,allowed_path_manifest_hash,
      required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,0,$8,$9,$10,$11,1,$12,1,$13,$14,$15,$15,$15,$16,$17,$18,$19)`, [
    input.workspaceId, input.attemptId, scope.missionId, scope.workPackageId, input.runId, spec.storyId, input.runtimeId,
    H('5'), repository.repositoryId, repository.worktreeId, spec.specId, spec.specHash, spec.storyHash,
    spec.criteriaManifestHash, repository.baseSha, repository.allowedPathManifestHash, repository.requiredPathManifestHash,
    repository.changedPathManifestHash, repository.forbiddenPathManifestHash,
  ]);
  await ownerPool.query(`INSERT INTO execution_lease_slots(workspace_id,lease_slot_key,last_fence) VALUES($1,$2,1)`,
    [input.workspaceId, H('6')]);
  await ownerPool.query(`INSERT INTO execution_leases(
      workspace_id,lease_id,lease_slot_key,attempt_id,fencing_token,work_package_revision,runtime_id,
      repository_id,base_sha,current_sha,worktree_id,policy_definition_hash,policy_activation_hash,
      checkpoint_hash,bundle_hash,cancellation_id,expires_at,state,payload_hash)
    VALUES($1,$2,$3,$4,1,1,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,statement_timestamp()+INTERVAL '1 day','active',$14)`, [
    input.workspaceId, input.leaseId, H('6'), input.attemptId, input.runtimeId, repository.repositoryId,
    repository.baseSha, repository.worktreeId, scope.policyDefinitionHash, scope.policyActivationHash,
    H('7'), H('8'), scope.cancellationId, H('9'),
  ]);
}

async function seedNextGeneration(previous: Fixture, next: Fixture): Promise<void> {
  await ownerPool.query(`UPDATE execution_leases SET state='superseded'
    WHERE workspace_id=$1 AND lease_id=$2`, [previous.workspaceId, previous.leaseId]);
  await ownerPool.query(`UPDATE execution_lease_slots SET last_fence=2
    WHERE workspace_id=$1 AND lease_slot_key=$2`, [previous.workspaceId, H('6')]);
  await ownerPool.query(`INSERT INTO governed_execution_attempts(
      workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,
      generation,manifest_hash,repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,
      criteria_manifest_hash,base_sha,current_sha,expected_head_sha,allowed_path_manifest_hash,
      required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash)
    SELECT workspace_id,$3,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,
      1,manifest_hash,repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,
      criteria_manifest_hash,base_sha,current_sha,expected_head_sha,allowed_path_manifest_hash,
      required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash
    FROM governed_execution_attempts WHERE workspace_id=$1 AND attempt_id=$2`, [
    previous.workspaceId, previous.attemptId, next.attemptId,
  ]);
  await ownerPool.query(`INSERT INTO execution_leases(
      workspace_id,lease_id,lease_slot_key,attempt_id,fencing_token,work_package_revision,runtime_id,
      repository_id,base_sha,current_sha,worktree_id,policy_definition_hash,policy_activation_hash,
      checkpoint_hash,bundle_hash,cancellation_id,expires_at,state,payload_hash)
    SELECT workspace_id,$3,lease_slot_key,$4,2,work_package_revision,runtime_id,
      repository_id,base_sha,current_sha,worktree_id,policy_definition_hash,policy_activation_hash,
      checkpoint_hash,bundle_hash,cancellation_id,statement_timestamp()+INTERVAL '1 day','active',payload_hash
    FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2`, [
    previous.workspaceId, previous.leaseId, next.leaseId, next.attemptId,
  ]);
}

function activityObservation(input: Fixture, id: string, overrides: Partial<RuntimeNeutralObservationV1> = {}): RuntimeNeutralObservationV1 {
  return RuntimeNeutralObservationV1Schema.parse({
    eventId: `event:${id}`, streamId: input.streamId, scope: input.scope,
    source: { store: 'run_activity_internal', recordId: `source:${id}`, recordRevision: 1,
      recordHash: governedHash('test.run-activity-source.v1', { id }), sourceSequence: 0 },
    observedAt: new Date(Date.now() - 86_400_000).toISOString(), kind: 'activity_observed', plane: 'activity',
    payload: { activityType: 'integration:observation', reasonCode: `reason:${id}`, count: 1, durationMs: 1,
      referenceHash: H('a'), establishesStoryCompletion: false },
    redactionClass: 'none', restrictedRef: null, orderingMode: 'live_projection',
    ...overrides,
  });
}

function statusObservation(input: Fixture, id: string, plane: 'runtime_health' | 'queue_outbox_freshness',
  status: 'healthy' | 'failed'): RuntimeNeutralObservationV1 {
  const sourceClass = plane === 'runtime_health' ? 'sandbox_resource_monitor' : 'queue_outbox_monitor';
  return RuntimeNeutralObservationV1Schema.parse({
    eventId: `event:${id}`, streamId: input.streamId, scope: input.scope,
    source: { store: plane === 'runtime_health' ? 'dependency_observation' : 'queue_outbox',
      recordId: `source:${id}`, recordRevision: 1, recordHash: H('b'), sourceSequence: 1 },
    observedAt: new Date(Date.now() - 86_400_000).toISOString(), kind: 'status_plane_observed', plane: 'operations',
    payload: { plane, status, sourceClass, sourceIdentity: `monitor:${id}`, sourceHash: H('b'),
      observedAt: new Date(Date.now() - 86_400_000).toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(), reasonCode: `status:${id}`,
      impact: 'Bounded independent impact.', nextSafeAction: 'Perform the bounded safe action.', establishesStoryCompletion: false },
    redactionClass: 'redacted', restrictedRef: null, orderingMode: 'live_projection',
  });
}

beforeAll(async () => {
  process.env.RORCA_RUN_ACTIVITY_CURSOR_SECRET = 'wave3b-integration-cursor-secret-32-bytes-minimum';
  await seed(a);
  await seed(b);
  await seed(c0);
});

afterAll(async () => {
  delete process.env.RORCA_RUN_ACTIVITY_CURSOR_SECRET;
  await runtimePool.end();
  await ownerPool.end();
  await closePool();
});

describe('Wave 3B run activity PostgreSQL store', () => {
  test('migration is ready, forced-RLS, additive, and creates no pg-boss object', async () => {
    const readiness = await ownerPool.query(`SELECT contract_version,migration_version,authority_effect,state
      FROM run_activity_schema_readiness WHERE singleton=TRUE`);
    expect(readiness.rows[0]).toMatchObject({ contract_version: '1.0.0', migration_version: '20260805100000',
      authority_effect: 'none', state: 'ready' });
    const rls = await ownerPool.query<{ relname: string; relforcerowsecurity: boolean }>(`SELECT relname,relforcerowsecurity
      FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
      WHERE nspname='rorca' AND relname LIKE 'run_activity_%' AND relkind='r'`);
    expect(rls.rows.filter((row) => row.relname !== 'run_activity_schema_readiness').every((row) => row.relforcerowsecurity)).toBe(true);
    const boss = await ownerPool.query(`SELECT 1 FROM pg_class JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
      WHERE nspname='pgboss' AND relname LIKE 'run_activity_%'`);
    expect(boss.rowCount).toBe(0);
  });

  test('allocates a hash-chained sequence concurrently and exact replay is idempotent', async () => {
    const first = activityObservation(a, 'first');
    const created = await store.append(first);
    expect(created).toMatchObject({ duplicate: false, event: { streamSequence: 1, priorEventHash: 'stream_origin', authorityEffect: 'none' } });
    const duplicate = await store.append(first);
    expect(duplicate.duplicate).toBe(true);
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => store.append(activityObservation(a, `concurrent-${index}`))));
    expect(results.map((result) => result.event.streamSequence).sort((left, right) => left - right)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 2));
    const tail = await store.page({ workspaceId: workspaceA, runId: a.runId, tail: true, limit: 5 });
    expect(tail.events.map((event) => event.streamSequence)).toEqual([9, 10, 11, 12, 13]);
    expect(tail).toMatchObject({ status: 'ok', hasMore: false, lastDurableSequence: 13 });
    await expect(store.append({ ...first, payload: { ...(first.payload as object), count: 2 } })).rejects.toMatchObject({
      details: { reason: 'changed_replay', retryable: false },
    });
    const conflict = await runtimePool.query(`SELECT reason_code,retryable FROM run_activity_projection_conflicts
      WHERE workspace_id=$1 AND event_id=$2`, [workspaceA, first.eventId]);
    expect(conflict.rows).toContainEqual({ reason_code: 'changed_replay', retryable: false });
  });

  test('rolls back an interrupted transaction without consuming sequence or leaving a partial event', async () => {
    const interrupted = activityObservation(a, 'transaction-interrupted');
    const before = await store.page({ workspaceId: workspaceA, runId: a.runId, limit: 100 });
    if (before.status !== 'ok' || before.lastDurableSequence === null) {
      throw new Error('Expected an existing durable stream before interruption');
    }
    const interruptedStore = new RunActivityStore({
      afterEventInsert: () => {
        throw new Error('injected transaction interruption');
      },
    });
    await expect(interruptedStore.append(interrupted)).rejects.toThrow('injected transaction interruption');
    const absent = await queryWorkspace<{ count: string }>(workspaceA,
      `SELECT COUNT(*)::text count FROM run_activity_events WHERE workspace_id=$1 AND event_id=$2`,
      [workspaceA, interrupted.eventId]);
    expect(absent[0]?.count).toBe('0');

    const retried = await store.append(interrupted);
    expect(retried.event.streamSequence).toBe(before.lastDurableSequence + 1);
    expect(retried.event.priorEventHash).toBe(before.events.at(-1)?.eventHash);
  });

  test('redacts restricted material before persistence and exposes only the sanitized replay', async () => {
    const observation = statusObservation(a, 'provider-safe', 'queue_outbox_freshness', 'failed');
    const secretBearing = { ...observation, payload: { ...(observation.payload as Record<string, unknown>),
      impact: 'Bearer abcdefghijklmnopqrstuvwxyz blocked postgresql://user:password@db/prod',
      nextSafeAction: 'Rotate api_key=super-secret-now' } };
    const result = await store.append(secretBearing);
    const serialized = JSON.stringify(result.event);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toMatch(/abcdefghijklmnopqrstuvwxyz|password@|super-secret-now/);
    const persisted = await runtimePool.query<{ envelope_json: unknown }>(`SELECT envelope_json FROM run_activity_events
      WHERE workspace_id=$1 AND event_id=$2`, [workspaceA, observation.eventId]);
    expect(persisted.rows[0].envelope_json).toEqual(result.event);
  });

  test('signed replay cursors are generation/workspace bound and survive a worker restart', async () => {
    const firstPage = await store.page({ workspaceId: workspaceA, runId: a.runId, limit: 5 });
    expect(firstPage.status).toBe('ok');
    expect(firstPage.events).toHaveLength(5);
    expect(firstPage.nextCursor).toBeTruthy();
    const restarted = new RunActivityStore();
    const secondPage = await restarted.page({ workspaceId: workspaceA, runId: a.runId, limit: 100,
      cursor: firstPage.nextCursor! });
    expect(secondPage.status).toBe('ok');
    expect(secondPage.events[0]!.streamSequence).toBe(6);
    const foreignReplay = await restarted.page({ workspaceId: workspaceB, runId: b.runId, cursor: firstPage.nextCursor! });
    expect(foreignReplay).toMatchObject({ status: 'reset', resetReason: 'scope_mismatch', events: [] });
    const foreignAudit = await queryWorkspace<{ reason_code: string }>(workspaceB,
      `SELECT reason_code FROM run_activity_access_audit
       WHERE workspace_id=$1 AND reason_code='scope_mismatch'`, [workspaceB]);
    expect(foreignAudit).toHaveLength(1);
    // Flip the first cursor character: base64 never begins with padding, so
    // this always corrupts the signed payload (a trailing-character tamper is
    // silently ignored when the cursor happens to end in padding).
    const tampered = `${firstPage.nextCursor![0] === 'A' ? 'B' : 'A'}${firstPage.nextCursor!.slice(1)}`;
    expect(await restarted.page({ workspaceId: workspaceA, runId: a.runId, cursor: tampered })).toMatchObject({
      status: 'reset', resetReason: 'cursor_invalid', events: [],
    });
  });

  test('isolates generation rollover and rejects the superseded live lease', async () => {
    const prior = await store.append(activityObservation(c0, 'generation-zero'));
    expect(prior.event).toMatchObject({ runtimeGeneration: 0, streamSequence: 1 });
    await seedNextGeneration(c0, c1);

    const next = await store.append(activityObservation(c1, 'generation-one'), { requireActiveLease: true });
    expect(next.event).toMatchObject({ runtimeGeneration: 1, streamSequence: 1, priorEventHash: 'stream_origin' });
    await expect(store.append(activityObservation(c0, 'generation-zero-late'), { requireActiveLease: true }))
      .rejects.toMatchObject({ details: { reason: 'lease_inactive_or_expired', retryable: false } });
    const selected = await store.page({ workspaceId: workspaceC, runId: c0.runId, runtimeGeneration: 1 });
    expect(selected).toMatchObject({ status: 'ok', runtimeGeneration: 1, streamId: c1.streamId });
    expect(selected.events).toHaveLength(1);
  });

  test('fake federated telemetry requires exact active lease/fence and is transactionally idempotent', async () => {
    const event = activityObservation(a, 'federated', {
      source: { store: 'fake_federated_runtime', recordId: 'federated:one', recordRevision: 1, recordHash: H('c'), sourceSequence: 0 },
    });
    const unsigned = RuntimeTelemetryBatchV1Schema.parse({ schemaVersion: 'rorca.runtime-telemetry-batch.v1', contractVersion: '1.0.0',
      batchId: 'batch:federated-one', batchHash: H('0'), workspaceId: workspaceA, runtimeId: a.runtimeId,
      attemptId: a.attemptId, leaseId: a.leaseId, fencingToken: 1, runtimeGeneration: 0,
      firstSourceSequence: 0, events: [event], compressedBytes: 100, uncompressedBytes: 200 });
    const batch = RuntimeTelemetryBatchV1Schema.parse({ ...unsigned, batchHash: runtimeTelemetryBatchIntegrityHash(unsigned) });
    const receipt = await store.ingestTelemetryBatch(batch);
    expect(receipt).toMatchObject({ duplicate: false, eventCount: 1 });
    expect(await store.ingestTelemetryBatch(batch)).toMatchObject({ duplicate: true, eventCount: 1 });
    const staleUnsigned = RuntimeTelemetryBatchV1Schema.parse({ ...unsigned, batchId: 'batch:federated-stale',
      batchHash: H('0'), fencingToken: 2, events: [{ ...event, eventId: 'event:federated-stale',
        scope: { ...(event.scope as object), fencingToken: 2 }, source: { ...event.source, recordId: 'federated:stale', sourceSequence: 1 } }],
      firstSourceSequence: 1 });
    const stale = RuntimeTelemetryBatchV1Schema.parse({ ...staleUnsigned, batchHash: runtimeTelemetryBatchIntegrityHash(staleUnsigned) });
    await expect(store.ingestTelemetryBatch(stale)).rejects.toMatchObject({ details: { reason: 'exact_subject_mismatch', retryable: false } });
  });

  test('keeps status planes and quotas isolated across workspaces', async () => {
    await store.append(statusObservation(a, 'runtime-a', 'runtime_health', 'healthy'));
    await store.append(statusObservation(b, 'runtime-b', 'runtime_health', 'failed'));
    const planesA = await store.listStatusPlanes({ workspaceId: workspaceA, runId: a.runId });
    const planesB = await store.listStatusPlanes({ workspaceId: workspaceB, runId: b.runId });
    expect(planesA).toContainEqual(expect.objectContaining({ plane: 'runtime_health', status: 'healthy', sourceIdentity: 'monitor:runtime-a' }));
    expect(planesB).toContainEqual(expect.objectContaining({ plane: 'runtime_health', status: 'failed', sourceIdentity: 'monitor:runtime-b' }));
    expect(JSON.stringify(planesA)).not.toContain('runtime-b');
    expect(JSON.stringify(planesB)).not.toContain('runtime-a');
  });

  test('retention during live replay writes an integrity tombstone, reports a gap, and preserves canonical rows', async () => {
    const before = await store.page({ workspaceId: workspaceA, runId: a.runId, limit: 3 });
    expect(before.nextCursor).toBeTruthy();
    const pruned = await store.prune({ workspaceId: workspaceA, streamId: a.streamId, runtimeGeneration: 0,
      now: new Date('2030-01-01T00:00:00.000Z'), reasonCode: 'manual_bounded_retention' });
    expect(pruned.prunedRecords).toBeGreaterThan(0);
    expect(pruned.tombstoneHash).toMatch(/^sha256:/);
    const replay = await store.page({ workspaceId: workspaceA, runId: a.runId, cursor: before.nextCursor! });
    expect(replay).toMatchObject({ status: 'gap', resetReason: 'pruned', events: [] });
    const tombstone = await runtimePool.query(`SELECT canonical_rows_deleted,event_window_hash FROM run_activity_retention_tombstones
      WHERE workspace_id=$1 AND stream_id=$2`, [workspaceA, a.streamId]);
    expect(tombstone.rows[0]).toMatchObject({ canonical_rows_deleted: false });
    const canonical = await ownerPool.query(`SELECT 1 FROM governed_execution_attempts WHERE workspace_id=$1 AND attempt_id=$2`,
      [workspaceA, a.attemptId]);
    expect(canonical.rowCount).toBe(1);
    const planesB = await store.listStatusPlanes({ workspaceId: workspaceB, runId: b.runId });
    expect(planesB).toContainEqual(expect.objectContaining({ sourceIdentity: 'monitor:runtime-b', status: 'failed' }));
  });

  test('archive manifests retain integrity state and never carry raw payload bytes', async () => {
    await store.recordArchiveManifest({ workspaceId: workspaceB, streamId: b.streamId, runtimeGeneration: 0,
      manifestId: 'archive:corrupt-one', manifestHash: H('d'), firstSequence: 1, lastSequence: 1,
      eventWindowHash: H('e'), restrictedReferenceId: 'reference:archive-one', integrityState: 'corrupt' });
    const row = await queryWorkspace<{
      integrity_state: string;
      raw_payload_included: boolean;
      restricted_reference_id: string;
    }>(workspaceB, `SELECT integrity_state,raw_payload_included,restricted_reference_id
      FROM run_activity_archive_manifests WHERE workspace_id=$1 AND manifest_id='archive:corrupt-one'`, [workspaceB]);
    expect(row[0]).toEqual({ integrity_state: 'corrupt', raw_payload_included: false,
      restricted_reference_id: 'reference:archive-one' });
  });

  test('never persists restricted PTY, prompt, transcript, context, credential, or secret material in Wave 3B tables', async () => {
    const markers = [
      'pty-secret-7fd39a', 'prompt-secret-1b99c2', 'transcript-secret-8ed117',
      'context-secret-76af03', 'credential-secret-a420de', 'secret-material-b3ad02',
    ];
    const observation = statusObservation(b, 'redaction-boundary', 'queue_outbox_freshness', 'failed');
    await store.append({
      ...observation,
      payload: {
        ...(observation.payload as Record<string, unknown>),
        impact: `PTY api_key=${markers[0]}; prompt Bearer ${markers[1]}; transcript password=${markers[2]}`,
        nextSafeAction: `context postgresql://user:${markers[3]}@db/prod; credential provider_token=${markers[4]}; secret=${markers[5]}`,
      },
    });
    await expect(store.append({
      ...activityObservation(b, 'raw-prompt-rejected'),
      payload: { rawPrompt: markers[1] },
    })).rejects.toBeDefined();

    const tables = await ownerPool.query<{ table_name: string }>(`SELECT table_name
      FROM information_schema.columns
      WHERE table_schema='rorca' AND column_name='workspace_id' AND table_name LIKE 'run_activity_%'
      ORDER BY table_name`);
    const persisted: string[] = [];
    for (const { table_name: tableName } of tables.rows) {
      if (!/^run_activity_[a-z0-9_]+$/.test(tableName)) throw new Error('Unexpected Wave 3B table name');
      const rows = await queryWorkspace<{ row_text: string }>(
        workspaceB,
        `SELECT row_to_json(t)::text row_text FROM rorca.${tableName} t WHERE workspace_id=$1`,
        [workspaceB],
      );
      persisted.push(...rows.map((row) => row.row_text));
    }
    const allRows = persisted.join('\n');
    for (const marker of markers) expect(allRows).not.toContain(marker);
    expect(allRows).toContain('[REDACTED]');
  });
});
