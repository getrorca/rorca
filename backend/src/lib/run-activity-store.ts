/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { transaction } from '../db/index';
import {
  RUN_STREAM_ORIGIN_HASH,
  RUN_STREAM_OPERATIONAL_PLANES,
  RUN_STREAM_SCHEMA_VERSION,
  RuntimeNeutralObservationV1Schema,
  RuntimeTelemetryBatchV1Schema,
  RunStreamEnvelopeV1Schema,
  StatusPlaneObservationPayloadSchema,
  type RunStreamEnvelopeV1,
  type RuntimeNeutralObservationV1,
  type RuntimeTelemetryBatchV1,
} from './governed-contracts/run-stream';
import { governedHash } from './governed-contracts/primitives';
import { ConflictError, NotFoundError, PayloadTooLargeError, TooManyRequestsError, UnprocessableError, ValidationError } from './errors';
import { redactRunActivityObservation } from './run-activity-redaction';

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_RECORDS = 100_000;
const DEFAULT_RETENTION_BYTES = 64 * 1024 * 1024;
const DEFAULT_WORKSPACE_BYTES = 256 * 1024 * 1024;
const CURSOR_TTL_SECONDS = 15 * 60;
const MAX_PAGE_SIZE = 100;

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export interface RunActivityRetentionPolicy {
  days: number;
  maxRecords: number;
  maxBytes: number;
  workspaceMaxBytes: number;
  policyHash: string;
}

export function getRunActivityRetentionPolicy(): RunActivityRetentionPolicy {
  const policy = {
    days: boundedInteger('RORCA_RUN_ACTIVITY_RETENTION_DAYS', DEFAULT_RETENTION_DAYS, 1, 90),
    maxRecords: boundedInteger('RORCA_RUN_ACTIVITY_RETENTION_RECORDS', DEFAULT_RETENTION_RECORDS, 100, 1_000_000),
    maxBytes: boundedInteger('RORCA_RUN_ACTIVITY_RETENTION_BYTES', DEFAULT_RETENTION_BYTES, 1024 * 1024, 1024 * 1024 * 1024),
    workspaceMaxBytes: boundedInteger('RORCA_RUN_ACTIVITY_WORKSPACE_BYTES', DEFAULT_WORKSPACE_BYTES, 1024 * 1024, 4 * 1024 * 1024 * 1024),
  };
  return { ...policy, policyHash: governedHash('rorca.run-activity-retention-policy.v1', policy) };
}

interface StoredEventRow {
  stream_sequence: string | number;
  event_hash: string;
  envelope_json: unknown;
  byte_length: number;
  retain_until: Date;
}
interface StoredStreamRow {
  workspace_id: string;
  stream_id: string;
  run_id: string | number;
  attempt_id: string;
  runtime_generation: string | number;
  subject_hash: string;
  retention_policy_hash: string;
  state: string;
}
interface StoredHeadRow {
  first_retained_sequence: string | number;
  last_sequence: string | number;
  last_event_hash: string | null;
  retained_records: string | number;
  retained_bytes: string | number;
  total_records: string | number;
  total_bytes: string | number;
}

interface CursorMaterial {
  v: 1;
  keyId: string;
  workspaceId: string;
  runId: number;
  attemptId: string;
  streamId: string;
  runtimeGeneration: number;
  sequence: number;
  eventHash: string;
  retentionPolicyHash: string;
  issuedAt: number;
  expiresAt: number;
}

export type RunActivityResetReason = 'cursor_invalid' | 'cursor_expired' | 'scope_mismatch' | 'future_sequence'
  | 'hash_mismatch' | 'pruned' | 'generation_changed' | 'stream_not_found';

export interface RunActivityPage {
  schemaVersion: 'rorca.run-activity-page.v1';
  status: 'ok' | 'gap' | 'reset';
  resetReason: RunActivityResetReason | null;
  streamId: string | null;
  runtimeGeneration: number | null;
  firstRetainedSequence: number | null;
  lastDurableSequence: number | null;
  events: RunStreamEnvelopeV1[];
  nextCursor: string | null;
  hasMore: boolean;
  authoritative: false;
  authorityEffect: 'none';
}

export interface AppendRunActivityResult {
  duplicate: boolean;
  event: RunStreamEnvelopeV1;
}

class ProjectionConflict extends Error {
  constructor(readonly workspaceId: string, readonly streamId: string | null, readonly generation: number | null,
    readonly eventId: string | null, readonly existingHash: string | null, readonly incomingHash: string | null,
    readonly reasonCode: string, readonly dimension: string) {
    super(reasonCode);
  }
}

function cursorSecret(): { keyId: string; secret: Buffer } {
  const configured = process.env.RORCA_RUN_ACTIVITY_CURSOR_SECRET;
  if (!configured || Buffer.byteLength(configured, 'utf8') < 32) {
    throw new Error('RORCA_RUN_ACTIVITY_CURSOR_SECRET must contain at least 32 bytes');
  }
  const keyId = process.env.RORCA_RUN_ACTIVITY_CURSOR_KEY_ID ?? 'run-activity-v1';
  if (!/^[A-Za-z][A-Za-z0-9._:-]{1,127}$/.test(keyId)) throw new Error('Run activity cursor key id is invalid');
  return { keyId, secret: Buffer.from(configured, 'utf8') };
}

function encodeCursor(material: Omit<CursorMaterial, 'v' | 'keyId' | 'issuedAt' | 'expiresAt'>, now = Date.now()): string {
  const key = cursorSecret();
  const payload: CursorMaterial = {
    v: 1,
    keyId: key.keyId,
    ...material,
    issuedAt: Math.floor(now / 1000),
    expiresAt: Math.floor(now / 1000) + CURSOR_TTL_SECONDS,
  };
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = createHmac('sha256', key.secret).update(bytes).digest();
  return `${bytes.toString('base64url')}.${signature.toString('base64url')}`;
}

function decodeCursor(cursor: string): CursorMaterial {
  if (cursor.length < 40 || cursor.length > 4096) throw new ValidationError('Run activity cursor is invalid');
  const parts = cursor.split('.');
  if (parts.length !== 2) throw new ValidationError('Run activity cursor is invalid');
  let bytes: Buffer;
  let supplied: Buffer;
  try {
    bytes = Buffer.from(parts[0]!, 'base64url');
    supplied = Buffer.from(parts[1]!, 'base64url');
  } catch {
    throw new ValidationError('Run activity cursor is invalid');
  }
  const key = cursorSecret();
  const expected = createHmac('sha256', key.secret).update(bytes).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ValidationError('Run activity cursor is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ValidationError('Run activity cursor is invalid');
  }
  if (!parsed || typeof parsed !== 'object') throw new ValidationError('Run activity cursor is invalid');
  const value = parsed as Partial<CursorMaterial>;
  if (value.v !== 1 || value.keyId !== key.keyId || typeof value.workspaceId !== 'string' || typeof value.attemptId !== 'string'
    || typeof value.streamId !== 'string' || !Number.isSafeInteger(value.runId) || !Number.isSafeInteger(value.runtimeGeneration)
    || !Number.isSafeInteger(value.sequence) || typeof value.eventHash !== 'string' || typeof value.retentionPolicyHash !== 'string'
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)) {
    throw new ValidationError('Run activity cursor is invalid');
  }
  return value as CursorMaterial;
}

async function setWorkspace(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
}

function observationMaterialHash(observation: RuntimeNeutralObservationV1, payload: unknown): string {
  return governedHash('rorca.run-activity-observation-material.v1', {
    eventId: observation.eventId,
    streamId: observation.streamId,
    scope: observation.scope,
    source: observation.source,
    observedAt: observation.observedAt,
    kind: observation.kind,
    plane: observation.plane,
    payload,
    redactionClass: observation.redactionClass,
    restrictedRef: observation.restrictedRef,
    orderingMode: observation.orderingMode,
  } as never);
}

function scopeSubjectHash(observation: RuntimeNeutralObservationV1): string {
  const scope = observation.scope;
  return governedHash('rorca.run-activity-stream-subject.v1', {
    streamId: observation.streamId,
    workspaceId: scope.workspaceId,
    missionId: scope.missionId,
    missionRevision: scope.missionRevision,
    missionHash: scope.missionHash,
    workPackageId: scope.workPackageId,
    workPackageRevision: scope.workPackageRevision,
    workPackageHash: scope.workPackageHash,
    spec: scope.spec,
    runId: scope.runId,
    attemptId: scope.attemptId,
    leaseId: scope.leaseId,
    fencingToken: scope.fencingToken,
    cancellationId: scope.cancellationId,
    runtimeId: scope.runtimeId,
    controllerGeneration: scope.controllerGeneration,
    runtimeGeneration: scope.runtimeGeneration,
    repository: {
      repositoryId: scope.repository.repositoryId,
      remoteAuthorityHash: scope.repository.remoteAuthorityHash,
      gitObjectFormat: scope.repository.gitObjectFormat,
      baseSha: scope.repository.baseSha,
      worktreeId: scope.repository.worktreeId,
      allowedPathManifestHash: scope.repository.allowedPathManifestHash,
      requiredPathManifestHash: scope.repository.requiredPathManifestHash,
      forbiddenPathManifestHash: scope.repository.forbiddenPathManifestHash,
    },
    policyDefinitionId: scope.policyDefinitionId,
    policyDefinitionVersion: scope.policyDefinitionVersion,
    policyDefinitionHash: scope.policyDefinitionHash,
    policyActivationId: scope.policyActivationId,
    policyActivationRevision: scope.policyActivationRevision,
    policyActivationHash: scope.policyActivationHash,
  } as never);
}

function numericRunId(observation: RuntimeNeutralObservationV1): number {
  if (typeof observation.scope.runId !== 'number') throw new UnprocessableError('Run activity requires a canonical numeric run identity', 'RUN_IDENTITY_INVALID');
  return observation.scope.runId;
}

async function verifyExactSourceSubject(client: PoolClient, observation: RuntimeNeutralObservationV1, requireActiveLease: boolean): Promise<void> {
  const scope = observation.scope;
  const row = await client.query<{
    run_id: string | number; mission_id: string; work_package_id: string; work_package_revision: number;
    story_id: string; runtime_id: string; generation: string | number; repository_id: string; base_sha: string;
    current_sha: string; worktree_id: string; lease_id: string; fencing_token: string | number; lease_runtime_id: string;
    lease_state: string; expires_at: Date; policy_activation_hash: string;
  }>(`SELECT run_id,mission_id,work_package_id,work_package_revision,story_id,runtime_id,generation,
      repository_id,base_sha,current_sha,worktree_id,lease_id,fencing_token,lease_runtime_id,
      lease_state,expires_at,policy_activation_hash
    FROM verify_run_activity_source_subject_v1($1,$2,$3)`,
  [scope.workspaceId, scope.attemptId, scope.leaseId]);
  const bound = row.rows[0];
  const mismatch = !bound || Number(bound.run_id) !== numericRunId(observation) || bound.mission_id !== scope.missionId
    || bound.work_package_id !== scope.workPackageId || bound.work_package_revision !== scope.workPackageRevision
    || bound.story_id !== scope.spec.storyId || bound.runtime_id !== scope.runtimeId || bound.lease_runtime_id !== scope.runtimeId
    || Number(bound.generation) !== scope.runtimeGeneration || Number(bound.fencing_token) !== scope.fencingToken
    || bound.repository_id !== scope.repository.repositoryId || bound.base_sha !== scope.repository.baseSha
    || bound.current_sha !== scope.repository.currentSha || bound.worktree_id !== scope.repository.worktreeId
    || bound.policy_activation_hash !== scope.policyActivationHash;
  if (mismatch) throw new ProjectionConflict(scope.workspaceId, observation.streamId, scope.runtimeGeneration,
    observation.eventId, null, observation.source.recordHash, 'exact_subject_mismatch', 'authority_scope');
  if (requireActiveLease && (bound.lease_state !== 'active' || bound.expires_at.getTime() <= Date.now())) {
    throw new ProjectionConflict(scope.workspaceId, observation.streamId, scope.runtimeGeneration,
      observation.eventId, null, observation.source.recordHash, 'lease_inactive_or_expired', 'lease');
  }
}

async function ensureStream(client: PoolClient, observation: RuntimeNeutralObservationV1, retention: RunActivityRetentionPolicy): Promise<void> {
  const scope = observation.scope;
  const subjectHash = scopeSubjectHash(observation);
  await client.query(`INSERT INTO run_activity_streams(
      workspace_id,stream_id,run_id,attempt_id,runtime_id,runtime_generation,mission_id,mission_revision,
      work_package_id,work_package_revision,spec_id,spec_version,story_id,story_version,lease_id,fencing_token,
      policy_activation_hash,repository_id,base_sha,current_sha,worktree_id,subject_hash,retention_policy_hash,
      retention_days,retention_max_records,retention_max_bytes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
    ON CONFLICT DO NOTHING`, [scope.workspaceId, observation.streamId, numericRunId(observation), scope.attemptId,
    scope.runtimeId, scope.runtimeGeneration, scope.missionId, scope.missionRevision, scope.workPackageId,
    scope.workPackageRevision, scope.spec.specId, scope.spec.specVersion, scope.spec.storyId, scope.spec.storyVersion,
    scope.leaseId, scope.fencingToken, scope.policyActivationHash, scope.repository.repositoryId, scope.repository.baseSha,
    scope.repository.currentSha, scope.repository.worktreeId, subjectHash, retention.policyHash, retention.days,
    retention.maxRecords, retention.maxBytes]);
  const stream = await client.query<StoredStreamRow>(`SELECT workspace_id,stream_id,run_id,attempt_id,runtime_generation,
      subject_hash,retention_policy_hash,state FROM run_activity_streams
    WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3 FOR UPDATE`,
  [scope.workspaceId, observation.streamId, scope.runtimeGeneration]);
  const stored = stream.rows[0];
  if (!stored || stored.subject_hash !== subjectHash || stored.retention_policy_hash !== retention.policyHash
    || stored.state === 'quarantined') {
    throw new ProjectionConflict(scope.workspaceId, observation.streamId, scope.runtimeGeneration,
      observation.eventId, stored?.subject_hash ?? null, subjectHash, stored?.state === 'quarantined' ? 'stream_quarantined' : 'stream_subject_conflict', 'stream');
  }
  await client.query(`INSERT INTO run_activity_stream_heads(workspace_id,stream_id,runtime_generation)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [scope.workspaceId, observation.streamId, scope.runtimeGeneration]);
}

async function appendWithClient(client: PoolClient, observationInput: unknown, options: {
  requireActiveLease: boolean;
  retention: RunActivityRetentionPolicy;
  subjectAlreadyVerified?: boolean;
  afterEventInsert?: (event: RunStreamEnvelopeV1) => Promise<void> | void;
}): Promise<AppendRunActivityResult> {
  const observation = RuntimeNeutralObservationV1Schema.parse(observationInput);
  await setWorkspace(client, observation.scope.workspaceId);
  const prerequisite = await client.query(`SELECT 1
    FROM run_activity_schema_readiness activity
    JOIN wave2_effective_readiness wave2 ON wave2.ready=TRUE
    WHERE activity.singleton=TRUE AND activity.state='ready' AND activity.authority_effect='none'
      AND activity.wave2_contract_source_digest=wave2.contract_source_digest
      AND activity.wave2_migration_version=wave2.migration_version
      AND activity.wave2_prerequisite_receipt_hash=wave2.prerequisite_receipt_hash
      AND activity.wave2_implementation_sha='1420fb4c819aad692894da9449bc4958ed74dd49'`);
  if (!prerequisite.rows[0]) {
    throw new ProjectionConflict(observation.scope.workspaceId, observation.streamId,
      observation.scope.runtimeGeneration, observation.eventId, null, observation.source.recordHash,
      'wave2_prerequisite_stale_or_missing', 'prerequisite_gate');
  }
  const redacted = redactRunActivityObservation(observation);
  const materialHash = observationMaterialHash(observation, redacted.payload);
  const existing = await client.query<{ event_hash: string; payload_hash: string; source_record_hash: string; envelope_json: unknown }>(
    `SELECT event_hash,payload_hash,source_record_hash,envelope_json FROM run_activity_events
     WHERE workspace_id=$1 AND (event_id=$2 OR (source_store=$3 AND source_record_id=$4 AND source_record_revision=$5)) LIMIT 1`,
    [observation.scope.workspaceId, observation.eventId, observation.source.store, observation.source.recordId, String(observation.source.recordRevision)],
  );
  if (existing.rows[0]) {
    const envelope = RunStreamEnvelopeV1Schema.parse(existing.rows[0].envelope_json);
    const existingMaterialHash = observationMaterialHash({
      eventId: envelope.eventId,
      streamId: envelope.streamId,
      scope: envelope.scope,
      source: envelope.source,
      observedAt: envelope.observedAt,
      kind: envelope.kind,
      plane: envelope.plane,
      payload: envelope.payload,
      redactionClass: envelope.redaction.class,
      restrictedRef: envelope.redaction.restrictedRef,
      orderingMode: envelope.orderingMode,
    }, envelope.payload);
    if (existingMaterialHash === materialHash) return { duplicate: true, event: envelope };
    throw new ProjectionConflict(observation.scope.workspaceId, observation.streamId, observation.scope.runtimeGeneration,
      observation.eventId, existingMaterialHash, materialHash, 'changed_replay', 'event_or_source_identity');
  }
  if (!options.subjectAlreadyVerified) await verifyExactSourceSubject(client, observation, options.requireActiveLease);
  await ensureStream(client, observation, options.retention);
  const headResult = await client.query<StoredHeadRow>(`SELECT first_retained_sequence,last_sequence,last_event_hash,
      retained_records,retained_bytes,total_records,total_bytes FROM run_activity_stream_heads
    WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3 FOR UPDATE`,
  [observation.scope.workspaceId, observation.streamId, observation.scope.runtimeGeneration]);
  const head = headResult.rows[0]!;
  if (observation.source.store === 'fake_federated_runtime') {
    const sourceHead = await client.query<{ last_source_sequence: string | number | null }>(`SELECT MAX(source_sequence) last_source_sequence
      FROM run_activity_events WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3 AND source_store='fake_federated_runtime'`,
    [observation.scope.workspaceId, observation.streamId, observation.scope.runtimeGeneration]);
    const lastSource = sourceHead.rows[0]?.last_source_sequence;
    if (lastSource !== null && lastSource !== undefined && observation.source.sourceSequence !== Number(lastSource) + 1) {
      throw new ProjectionConflict(observation.scope.workspaceId, observation.streamId, observation.scope.runtimeGeneration,
        observation.eventId, null, materialHash, 'source_sequence_gap_or_regression', 'source_sequence');
    }
  }
  const workspaceUsage = await client.query<{ retained_bytes: string | number }>(`SELECT COALESCE(SUM(retained_bytes),0) retained_bytes
    FROM run_activity_stream_heads WHERE workspace_id=$1`, [observation.scope.workspaceId]);
  if (Number(workspaceUsage.rows[0]?.retained_bytes ?? 0) >= options.retention.workspaceMaxBytes) {
    throw new TooManyRequestsError('Run activity workspace observability budget is exhausted');
  }
  const streamSequence = Number(head.last_sequence) + 1;
  const priorEventHash = head.last_event_hash ?? RUN_STREAM_ORIGIN_HASH;
  const payloadHash = governedHash('rorca.run-activity-event-payload.v1', redacted.payload as never);
  const clock = await client.query<{ database_time: Date }>('SELECT clock_timestamp() database_time');
  const databaseTime = clock.rows[0]!.database_time;
  const retainUntil = new Date(databaseTime.getTime() + options.retention.days * 86_400_000);
  const eventHash = governedHash('rorca.run-activity-event-chain.v1', {
    materialHash,
    streamSequence,
    priorEventHash,
    payloadHash,
    databaseTime: databaseTime.toISOString(),
    retentionPolicyHash: options.retention.policyHash,
  });
  const envelope = RunStreamEnvelopeV1Schema.parse({
    schemaVersion: RUN_STREAM_SCHEMA_VERSION,
    contractId: RUN_STREAM_SCHEMA_VERSION,
    contractVersion: '1.0.0',
    eventId: observation.eventId,
    streamId: observation.streamId,
    scope: observation.scope,
    runtimeGeneration: observation.scope.runtimeGeneration,
    streamSequence,
    priorEventHash,
    eventHash,
    payloadHash,
    source: observation.source,
    observedAt: observation.observedAt,
    receivedAt: databaseTime.toISOString(),
    databaseTime: databaseTime.toISOString(),
    projectedAt: databaseTime.toISOString(),
    kind: observation.kind,
    plane: observation.plane,
    payload: redacted.payload,
    redaction: {
      class: redacted.redactionClass,
      policyHash: redacted.policyHash,
      redactedFieldCount: redacted.redactedFieldCount,
      restrictedRef: observation.restrictedRef,
      ordinaryProjectionContainsRaw: false,
    },
    retention: {
      policyHash: options.retention.policyHash,
      retainUntil: retainUntil.toISOString(),
      archiveManifestHash: 'not_applicable',
    },
    orderingMode: observation.orderingMode,
    projectionOnly: true,
    authorityEffect: 'none',
  });
  const envelopeJson = JSON.stringify(envelope);
  const byteLength = Buffer.byteLength(envelopeJson, 'utf8');
  if (byteLength > 64 * 1024) throw new PayloadTooLargeError('Run activity envelope exceeds 64 KiB');
  await client.query(`INSERT INTO run_activity_events(
      workspace_id,stream_id,runtime_generation,stream_sequence,event_id,event_hash,payload_hash,prior_event_hash,kind,
      projection_plane,source_store,source_record_id,source_record_revision,source_record_hash,source_sequence,
      ordering_mode,redaction_class,redaction_policy_hash,restricted_reference_id,envelope_json,byte_length,
      observed_at,received_at,database_time,projected_at,retain_until)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24,$25,$26)`,
  [observation.scope.workspaceId, observation.streamId, observation.scope.runtimeGeneration, streamSequence,
    observation.eventId, eventHash, payloadHash, priorEventHash, observation.kind, observation.plane,
    observation.source.store, observation.source.recordId, String(observation.source.recordRevision), observation.source.recordHash,
    observation.source.sourceSequence, observation.orderingMode, redacted.redactionClass, redacted.policyHash,
    observation.restrictedRef?.referenceId ?? null, envelopeJson, byteLength, observation.observedAt, databaseTime,
    databaseTime, databaseTime, retainUntil]);
  await options.afterEventInsert?.(envelope);
  await client.query(`UPDATE run_activity_stream_heads SET last_sequence=$4,last_event_hash=$5,
      retained_records=retained_records+1,retained_bytes=retained_bytes+$6,total_records=total_records+1,
      total_bytes=total_bytes+$6,state_version=state_version+1
    WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3`,
  [observation.scope.workspaceId, observation.streamId, observation.scope.runtimeGeneration, streamSequence, eventHash, byteLength]);
  if (observation.kind === 'status_plane_observed') {
    const plane = StatusPlaneObservationPayloadSchema.parse(redacted.payload);
    await client.query(`INSERT INTO run_activity_status_plane_observations(
        workspace_id,stream_id,runtime_generation,plane,observation_sequence,event_hash,status,source_class,source_identity,source_hash,
        observed_at,valid_until,reason_code,impact,next_safe_action)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [observation.scope.workspaceId, observation.streamId, observation.scope.runtimeGeneration, plane.plane, streamSequence,
      eventHash, plane.status, plane.sourceClass, plane.sourceIdentity, plane.sourceHash, plane.observedAt, plane.validUntil,
      plane.reasonCode, plane.impact, plane.nextSafeAction]);
    await client.query(`INSERT INTO run_activity_status_planes(
        workspace_id,stream_id,runtime_generation,plane,observation_sequence,event_hash,status,source_class,source_identity,source_hash,
        observed_at,valid_until,reason_code,impact,next_safe_action)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT(workspace_id,stream_id,runtime_generation,plane) DO UPDATE SET
        observation_sequence=EXCLUDED.observation_sequence,event_hash=EXCLUDED.event_hash,status=EXCLUDED.status,
        source_class=EXCLUDED.source_class,source_identity=EXCLUDED.source_identity,source_hash=EXCLUDED.source_hash,
        observed_at=EXCLUDED.observed_at,valid_until=EXCLUDED.valid_until,reason_code=EXCLUDED.reason_code,
        impact=EXCLUDED.impact,next_safe_action=EXCLUDED.next_safe_action,
        state_version=run_activity_status_planes.state_version+1,updated_at=clock_timestamp()
      WHERE run_activity_status_planes.observation_sequence<EXCLUDED.observation_sequence`,
    [observation.scope.workspaceId, observation.streamId, observation.scope.runtimeGeneration, plane.plane, streamSequence,
      eventHash, plane.status, plane.sourceClass, plane.sourceIdentity, plane.sourceHash, plane.observedAt, plane.validUntil,
      plane.reasonCode, plane.impact, plane.nextSafeAction]);
  }
  await client.query(`SELECT pg_notify('run_activity_committed',$1)`,
    [`${observation.scope.workspaceId}:${observation.streamId}:${observation.scope.runtimeGeneration}:${streamSequence}`]);
  return { duplicate: false, event: envelope };
}

async function recordConflict(conflict: ProjectionConflict): Promise<void> {
  await transaction(async (client) => {
    await setWorkspace(client, conflict.workspaceId);
    const correlationHash = governedHash('rorca.run-activity-conflict-correlation.v1', {
      workspaceId: conflict.workspaceId,
      streamId: conflict.streamId ?? 'not_applicable',
      eventId: conflict.eventId ?? 'not_applicable',
      reasonCode: conflict.reasonCode,
      dimension: conflict.dimension,
    });
    await client.query(`INSERT INTO run_activity_projection_conflicts(workspace_id,stream_id,runtime_generation,event_id,
        existing_hash,incoming_hash,reason_code,dimension,retryable,correlation_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9)`, [conflict.workspaceId, conflict.streamId, conflict.generation,
      conflict.eventId, conflict.existingHash, conflict.incomingHash, conflict.reasonCode, conflict.dimension, correlationHash]);
  });
}

async function auditRead(client: PoolClient, workspaceId: string, operation: string, outcome: string, reasonCode: string,
  subject: Record<string, unknown>, correlationId = 'not_available'): Promise<void> {
  await client.query(`INSERT INTO run_activity_access_audit(workspace_id,operation,outcome,reason_code,subject_hash,correlation_hash)
    VALUES($1,$2,$3,$4,$5,$6)`, [workspaceId, operation, outcome, reasonCode,
    governedHash('rorca.run-activity-read-subject.v1', subject as never),
    governedHash('rorca.run-activity-read-correlation.v1', { correlationId })]);
}

export function runtimeTelemetryBatchIntegrityHash(batch: RuntimeTelemetryBatchV1): string {
  const { batchHash: _batchHash, ...material } = batch;
  return governedHash('rorca.runtime-telemetry-batch.integrity.v1', material as never);
}


export interface RunActivityStoreFaultHooks {
  afterEventInsert?: (event: RunStreamEnvelopeV1) => Promise<void> | void;
}
export class RunActivityStore {
  constructor(private readonly faultHooks: RunActivityStoreFaultHooks = {}) {}
  async append(observationInput: unknown, options: { requireActiveLease?: boolean } = {}): Promise<AppendRunActivityResult> {
    const retention = getRunActivityRetentionPolicy();
    try {
      return await transaction(async (client) => appendWithClient(client, observationInput, {
        requireActiveLease: options.requireActiveLease ?? false,
        retention,
        afterEventInsert: this.faultHooks.afterEventInsert,
      }));
    } catch (error) {
      if (error instanceof ProjectionConflict) {
        await recordConflict(error);
        throw new ConflictError('Run activity projection conflict', { reason: error.reasonCode, retryable: false });
      }
      throw error;
    }
  }

  async ingestTelemetryBatch(candidate: unknown): Promise<{
    duplicate: boolean; batchId: string; firstStreamSequence: number; lastStreamSequence: number; eventCount: number;
  }> {
    const batch = RuntimeTelemetryBatchV1Schema.parse(candidate);
    const computedBatchHash = runtimeTelemetryBatchIntegrityHash(batch);
    if (computedBatchHash !== batch.batchHash) throw new UnprocessableError('Telemetry batch hash is invalid', 'BATCH_HASH_MISMATCH');
    if (Buffer.byteLength(JSON.stringify(batch), 'utf8') > 256 * 1024) throw new PayloadTooLargeError('Telemetry batch exceeds 256 KiB');
    const retention = getRunActivityRetentionPolicy();
    try {
      return await transaction(async (client) => {
        await setWorkspace(client, batch.workspaceId);
        const existing = await client.query<{ batch_hash: string; first_stream_sequence: string | number; last_stream_sequence: string | number; event_count: number }>(
          `SELECT batch_hash,first_stream_sequence,last_stream_sequence,event_count FROM run_activity_ingest_batches
           WHERE workspace_id=$1 AND batch_id=$2 FOR UPDATE`, [batch.workspaceId, batch.batchId]);
        if (existing.rows[0]) {
          if (existing.rows[0].batch_hash !== batch.batchHash) {
            throw new ProjectionConflict(batch.workspaceId, null, batch.runtimeGeneration, null,
              existing.rows[0].batch_hash, batch.batchHash, 'changed_batch_replay', 'batch');
          }
          return { duplicate: true, batchId: batch.batchId, firstStreamSequence: Number(existing.rows[0].first_stream_sequence),
            lastStreamSequence: Number(existing.rows[0].last_stream_sequence), eventCount: existing.rows[0].event_count };
        }
        await verifyExactSourceSubject(client, batch.events[0]!, true);
        const appended: RunStreamEnvelopeV1[] = [];
        for (const event of batch.events) {
          const result = await appendWithClient(client, event, { requireActiveLease: true, retention, subjectAlreadyVerified: true });
          appended.push(result.event);
        }
        const first = appended[0]!.streamSequence;
        const last = appended.at(-1)!.streamSequence;
        const responseHash = governedHash('rorca.runtime-telemetry-batch-response.v1', {
          batchId: batch.batchId, firstStreamSequence: first, lastStreamSequence: last, eventCount: appended.length,
        });
        await client.query(`INSERT INTO run_activity_ingest_batches(workspace_id,batch_id,batch_hash,runtime_id,attempt_id,
            lease_id,fencing_token,runtime_generation,first_source_sequence,event_count,first_stream_sequence,last_stream_sequence,response_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [batch.workspaceId, batch.batchId, batch.batchHash,
          batch.runtimeId, batch.attemptId, batch.leaseId, batch.fencingToken, batch.runtimeGeneration,
          batch.firstSourceSequence, appended.length, first, last, responseHash]);
        return { duplicate: false, batchId: batch.batchId, firstStreamSequence: first, lastStreamSequence: last, eventCount: appended.length };
      });
    } catch (error) {
      if (error instanceof ProjectionConflict) {
        await recordConflict(error);
        throw new ConflictError('Runtime telemetry batch conflict', { reason: error.reasonCode, retryable: false });
      }
      throw error;
    }
  }

  async page(input: { workspaceId: string; runId: number; runtimeGeneration?: number; cursor?: string; tail?: boolean; limit?: number; correlationId?: string }): Promise<RunActivityPage> {
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(input.limit ?? 50)));
    if (input.tail && input.cursor) throw new ValidationError('Run activity tail reads do not accept a replay cursor');
    return transaction(async (client) => {
      await setWorkspace(client, input.workspaceId);
      let cursor: CursorMaterial | null = null;
      if (input.cursor) {
        try {
          cursor = decodeCursor(input.cursor);
        } catch {
          await auditRead(client, input.workspaceId, 'run-activity.page', 'invalid_cursor', 'cursor_invalid', { runId: input.runId }, input.correlationId);
          return this.resetPage('cursor_invalid');
        }
        if (cursor.expiresAt < Math.floor(Date.now() / 1000)) {
          await auditRead(client, input.workspaceId, 'run-activity.page', 'invalid_cursor', 'cursor_expired', { runId: input.runId }, input.correlationId);
          return this.resetPage('cursor_expired');
        }
        if (cursor.workspaceId !== input.workspaceId || cursor.runId !== input.runId
          || (input.runtimeGeneration !== undefined && cursor.runtimeGeneration !== input.runtimeGeneration)) {
          await auditRead(client, input.workspaceId, 'run-activity.page', 'denied', 'scope_mismatch', { runId: input.runId }, input.correlationId);
          return this.resetPage('scope_mismatch');
        }
      }
      const requestedGeneration = cursor?.runtimeGeneration ?? input.runtimeGeneration;
      const stream = await client.query<StoredStreamRow>(`SELECT workspace_id,stream_id,run_id,attempt_id,runtime_generation,
          subject_hash,retention_policy_hash,state FROM run_activity_streams
        WHERE workspace_id=$1 AND run_id=$2 ${requestedGeneration === undefined ? '' : 'AND runtime_generation=$3'}
        ORDER BY runtime_generation DESC LIMIT 1`, requestedGeneration === undefined
        ? [input.workspaceId, input.runId] : [input.workspaceId, input.runId, requestedGeneration]);
      const selected = stream.rows[0];
      if (!selected) {
        await auditRead(client, input.workspaceId, 'run-activity.page', 'not_found', 'stream_not_found', { runId: input.runId }, input.correlationId);
        return this.resetPage('stream_not_found');
      }
      if (cursor && (cursor.streamId !== selected.stream_id || cursor.attemptId !== selected.attempt_id
        || cursor.retentionPolicyHash !== selected.retention_policy_hash)) {
        await auditRead(client, input.workspaceId, 'run-activity.page', 'denied', 'generation_changed', { runId: input.runId }, input.correlationId);
        return this.resetPage('generation_changed');
      }
      const headResult = await client.query<StoredHeadRow>(`SELECT first_retained_sequence,last_sequence,last_event_hash,
          retained_records,retained_bytes,total_records,total_bytes FROM run_activity_stream_heads
        WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3`,
      [input.workspaceId, selected.stream_id, selected.runtime_generation]);
      const head = headResult.rows[0]!;
      const afterSequence = cursor?.sequence ?? 0;
      const firstRetained = Number(head.first_retained_sequence);
      const lastSequence = Number(head.last_sequence);
      if (afterSequence > lastSequence) {
        await auditRead(client, input.workspaceId, 'run-activity.page', 'invalid_cursor', 'future_sequence', { runId: input.runId }, input.correlationId);
        return this.resetPage('future_sequence');
      }
      if (cursor && afterSequence > 0) {
        if (afterSequence < firstRetained) {
          await auditRead(client, input.workspaceId, 'run-activity.page', 'gap', 'pruned', { runId: input.runId }, input.correlationId);
          return this.gapPage(selected, head, 'pruned');
        }
        const anchor = await client.query<{ event_hash: string }>(`SELECT event_hash FROM run_activity_events
          WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3 AND stream_sequence=$4`,
        [input.workspaceId, selected.stream_id, selected.runtime_generation, afterSequence]);
        if (!anchor.rows[0] || anchor.rows[0].event_hash !== cursor.eventHash) {
          await auditRead(client, input.workspaceId, 'run-activity.page', 'invalid_cursor', 'hash_mismatch', { runId: input.runId }, input.correlationId);
          return this.resetPage('hash_mismatch');
        }
      }
      if (!cursor && !input.tail && firstRetained > 1) {
        await auditRead(client, input.workspaceId, 'run-activity.page', 'gap', 'pruned', { runId: input.runId }, input.correlationId);
        return this.gapPage(selected, head, 'pruned');
      }
      const rows = input.tail && !cursor
        ? await client.query<StoredEventRow>(`SELECT stream_sequence,event_hash,envelope_json,byte_length,retain_until
            FROM run_activity_events WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3
            ORDER BY stream_sequence DESC LIMIT $4`,
          [input.workspaceId, selected.stream_id, selected.runtime_generation, limit])
        : await client.query<StoredEventRow>(`SELECT stream_sequence,event_hash,envelope_json,byte_length,retain_until
            FROM run_activity_events WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3 AND stream_sequence>$4
            ORDER BY stream_sequence ASC LIMIT $5`,
          [input.workspaceId, selected.stream_id, selected.runtime_generation, afterSequence, limit]);
      const orderedRows = input.tail && !cursor ? [...rows.rows].reverse() : rows.rows;
      const events = orderedRows.map((row) => RunStreamEnvelopeV1Schema.parse(row.envelope_json));
      const finalSequence = events.at(-1)?.streamSequence ?? afterSequence;
      const finalHash = events.at(-1)?.eventHash ?? cursor?.eventHash ?? RUN_STREAM_ORIGIN_HASH;
      const nextCursor = encodeCursor({
        workspaceId: input.workspaceId,
        runId: input.runId,
        attemptId: selected.attempt_id,
        streamId: selected.stream_id,
        runtimeGeneration: Number(selected.runtime_generation),
        sequence: finalSequence,
        eventHash: finalHash,
        retentionPolicyHash: selected.retention_policy_hash,
      });
      await auditRead(client, input.workspaceId, 'run-activity.page', 'allowed',
        input.tail ? 'tail_returned' : 'page_returned', { runId: input.runId }, input.correlationId);
      return {
        schemaVersion: 'rorca.run-activity-page.v1',
        status: 'ok',
        resetReason: null,
        streamId: selected.stream_id,
        runtimeGeneration: Number(selected.runtime_generation),
        firstRetainedSequence: firstRetained,
        lastDurableSequence: lastSequence,
        events,
        nextCursor,
        hasMore: input.tail ? false : finalSequence < lastSequence,
        authoritative: false,
        authorityEffect: 'none',
      };
    });
  }

  async listStatusPlanes(input: { workspaceId: string; runId: number; runtimeGeneration?: number }): Promise<Array<Record<string, unknown>>> {
    const observed = await transaction(async (client) => {
      await setWorkspace(client, input.workspaceId);
      const params: unknown[] = [input.workspaceId, input.runId];
      const generationFilter = input.runtimeGeneration === undefined ? '' : 'AND runtime_generation=$3';
      if (input.runtimeGeneration !== undefined) params.push(input.runtimeGeneration);
      const rows = await client.query(`WITH selected AS (
          SELECT workspace_id,stream_id,runtime_generation FROM run_activity_streams
          WHERE workspace_id=$1 AND run_id=$2 ${generationFilter}
          ORDER BY runtime_generation DESC LIMIT 1
        )
        SELECT p.plane,CASE WHEN p.valid_until<clock_timestamp() THEN 'stale' ELSE p.status END status,
          p.source_class "sourceClass",p.source_identity "sourceIdentity",p.source_hash "sourceHash",p.observed_at "observedAt",
          p.valid_until "validUntil",CASE WHEN p.valid_until<clock_timestamp() THEN 'observation_expired' ELSE p.reason_code END "reasonCode",
          p.impact,p.next_safe_action "nextSafeAction",p.observation_sequence "observationSequence"
        FROM run_activity_status_planes p JOIN selected s
          ON s.workspace_id=p.workspace_id AND s.stream_id=p.stream_id AND s.runtime_generation=p.runtime_generation
        ORDER BY p.plane`, params);
      return rows.rows as Array<Record<string, unknown>>;
    });
    const byPlane = Object.fromEntries(observed.map((plane) => [String(plane.plane), plane]));
    return RUN_STREAM_OPERATIONAL_PLANES.map((plane) => byPlane[plane] ?? {
      plane,
      status: 'unknown',
      sourceClass: null,
      sourceIdentity: null,
      sourceHash: null,
      observedAt: null,
      validUntil: null,
      reasonCode: 'not_observed',
      impact: 'No canonical observation is available for this independent plane.',
      nextSafeAction: 'Wait for or request a typed plane observation.',
      observationSequence: null,
    });
  }

  async prune(input: { workspaceId: string; streamId: string; runtimeGeneration: number; now?: Date; reasonCode?: 'age_limit' | 'record_limit' | 'byte_limit' | 'manual_bounded_retention' }): Promise<{
    prunedRecords: number; prunedBytes: number; firstPrunedSequence: number | null; lastPrunedSequence: number | null; tombstoneHash: string | null;
  }> {
    return transaction(async (client) => {
      await setWorkspace(client, input.workspaceId);
      const streamResult = await client.query<StoredStreamRow & { retention_max_records: number; retention_max_bytes: string | number }>(
        `SELECT workspace_id,stream_id,run_id,attempt_id,runtime_generation,subject_hash,retention_policy_hash,state,
          retention_max_records,retention_max_bytes FROM run_activity_streams
         WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3 FOR UPDATE`,
      [input.workspaceId, input.streamId, input.runtimeGeneration]);
      if (!streamResult.rows[0]) throw new NotFoundError('Run activity stream');
      const headResult = await client.query<StoredHeadRow>(`SELECT first_retained_sequence,last_sequence,last_event_hash,
          retained_records,retained_bytes,total_records,total_bytes FROM run_activity_stream_heads
        WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3 FOR UPDATE`,
      [input.workspaceId, input.streamId, input.runtimeGeneration]);
      const head = headResult.rows[0]!;
      const events = await client.query<StoredEventRow>(`SELECT stream_sequence,event_hash,envelope_json,byte_length,retain_until
        FROM run_activity_events WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3
        ORDER BY stream_sequence ASC FOR UPDATE`, [input.workspaceId, input.streamId, input.runtimeGeneration]);
      const now = input.now ?? new Date();
      const maxRecords = Number(streamResult.rows[0].retention_max_records);
      const maxBytes = Number(streamResult.rows[0].retention_max_bytes);
      let remainingRecords = Number(head.retained_records);
      let remainingBytes = Number(head.retained_bytes);
      const candidates: StoredEventRow[] = [];
      for (const event of events.rows) {
        const expired = event.retain_until.getTime() <= now.getTime();
        const overRecords = remainingRecords > maxRecords;
        const overBytes = remainingBytes > maxBytes;
        if (!expired && !overRecords && !overBytes) break;
        candidates.push(event);
        remainingRecords -= 1;
        remainingBytes -= event.byte_length;
      }
      if (candidates.length === 0) return { prunedRecords: 0, prunedBytes: 0, firstPrunedSequence: null, lastPrunedSequence: null, tombstoneHash: null };
      const firstSequence = Number(candidates[0]!.stream_sequence);
      const lastSequence = Number(candidates.at(-1)!.stream_sequence);
      const prunedBytes = candidates.reduce((total, event) => total + event.byte_length, 0);
      const eventWindowHash = governedHash('rorca.run-activity-retention-window.v1', candidates.map((event) => ({
        sequence: Number(event.stream_sequence), eventHash: event.event_hash, byteLength: event.byte_length,
      })) as never);
      const reasonCode = input.reasonCode ?? (candidates.some((event) => event.retain_until.getTime() <= now.getTime())
        ? 'age_limit' : Number(head.retained_records) > maxRecords ? 'record_limit' : 'byte_limit');
      const tombstone = await client.query<{ tombstone_id: string | number }>(`INSERT INTO run_activity_retention_tombstones(
          workspace_id,stream_id,runtime_generation,first_pruned_sequence,last_pruned_sequence,pruned_records,pruned_bytes,
          event_window_hash,reason_code,canonical_rows_deleted)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE) RETURNING tombstone_id`, [input.workspaceId, input.streamId,
        input.runtimeGeneration, firstSequence, lastSequence, candidates.length, prunedBytes, eventWindowHash, reasonCode]);
      await client.query(`SELECT set_config('rorca.run_activity_retention','on',TRUE)`);
      await client.query(`DELETE FROM run_activity_status_plane_observations o
        WHERE o.workspace_id=$1 AND o.stream_id=$2 AND o.runtime_generation=$3
          AND o.observation_sequence BETWEEN $4 AND $5
          AND NOT EXISTS(SELECT 1 FROM run_activity_status_planes p
            WHERE p.workspace_id=o.workspace_id AND p.stream_id=o.stream_id
              AND p.runtime_generation=o.runtime_generation AND p.plane=o.plane
              AND p.observation_sequence=o.observation_sequence)`,
      [input.workspaceId, input.streamId, input.runtimeGeneration, firstSequence, lastSequence]);
      await client.query(`DELETE FROM run_activity_events WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3
        AND stream_sequence BETWEEN $4 AND $5`, [input.workspaceId, input.streamId, input.runtimeGeneration, firstSequence, lastSequence]);
      await client.query(`UPDATE run_activity_stream_heads SET first_retained_sequence=$4,retained_records=$5,
          retained_bytes=$6,state_version=state_version+1 WHERE workspace_id=$1 AND stream_id=$2 AND runtime_generation=$3`,
      [input.workspaceId, input.streamId, input.runtimeGeneration, lastSequence + 1, remainingRecords, remainingBytes]);
      return {
        prunedRecords: candidates.length,
        prunedBytes,
        firstPrunedSequence: firstSequence,
        lastPrunedSequence: lastSequence,
        tombstoneHash: governedHash('rorca.run-activity-retention-tombstone.v1', {
          tombstoneId: Number(tombstone.rows[0]!.tombstone_id), eventWindowHash, firstSequence, lastSequence,
        }),
      };
    });
  }

  async recordArchiveManifest(input: {
    workspaceId: string; streamId: string; runtimeGeneration: number; manifestId: string; manifestHash: string;
    firstSequence: number; lastSequence: number; eventWindowHash: string; restrictedReferenceId: string;
    integrityState: 'verified' | 'corrupt' | 'expired';
  }): Promise<void> {
    await transaction(async (client) => {
      await setWorkspace(client, input.workspaceId);
      await client.query(`INSERT INTO run_activity_archive_manifests(workspace_id,stream_id,runtime_generation,manifest_id,
          manifest_hash,first_sequence,last_sequence,event_window_hash,restricted_reference_id,raw_payload_included,integrity_state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,$10)`, [input.workspaceId, input.streamId, input.runtimeGeneration,
        input.manifestId, input.manifestHash, input.firstSequence, input.lastSequence, input.eventWindowHash,
        input.restrictedReferenceId, input.integrityState]);
    });
  }

  private resetPage(reason: RunActivityResetReason): RunActivityPage {
    return { schemaVersion: 'rorca.run-activity-page.v1', status: 'reset', resetReason: reason, streamId: null,
      runtimeGeneration: null, firstRetainedSequence: null, lastDurableSequence: null, events: [], nextCursor: null,
      hasMore: false, authoritative: false, authorityEffect: 'none' };
  }

  private gapPage(stream: StoredStreamRow, head: StoredHeadRow, reason: RunActivityResetReason): RunActivityPage {
    return { schemaVersion: 'rorca.run-activity-page.v1', status: 'gap', resetReason: reason, streamId: stream.stream_id,
      runtimeGeneration: Number(stream.runtime_generation), firstRetainedSequence: Number(head.first_retained_sequence),
      lastDurableSequence: Number(head.last_sequence), events: [], nextCursor: null, hasMore: false,
      authoritative: false, authorityEffect: 'none' };
  }
}

export const runActivityStore = new RunActivityStore();
