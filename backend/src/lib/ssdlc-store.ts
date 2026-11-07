/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Workspace-scoped persistence for compiled SSDLC plans, normalized lifecycle
 * evidence, and governed decisions. Audit records have no hard-delete methods;
 * phase state is derived by getPhaseDetail rather than persisted.
 */

import crypto from 'crypto';
import { execute, query, queryOne } from '../db/index';
import { ConflictError, NotFoundError, ValidationError } from './errors';

export type PlanValidationStatus = 'draft' | 'validated' | 'failed';
export type PlanLifecycleState = 'current' | 'superseded' | 'draft' | 'failed';
export type EvidenceSubjectType = 'spec_hash' | 'commit_sha' | 'artifact_digest' | 'deployment_id';
export type LifecycleDecisionType =
  | 'defer'
  | 'not_applicable_confirmation'
  | 'gate_override'
  | 'qa_approval'
  | 'merge_approval'
  | 'production_approval';
export type DerivedPhaseState = 'pending' | 'evidence_available' | 'approved' | 'deferred' | 'not_applicable';
export type JsonObject = Record<string, unknown>;
export type JsonObjectInput = JsonObject | string;

type DbTimestamp = Date | string;

interface CompiledPlanRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  spec_version: string;
  compiler_version: string;
  normalized_input_hash: string;
  profile_hash: string | null;
  schema_version: string;
  plan_json: JsonObject;
  validation_status: PlanValidationStatus;
  is_current: boolean;
  created_at: DbTimestamp;
  validated_at: DbTimestamp | null;
  updated_at: DbTimestamp;
}

interface EvidenceRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  spec_version: string | null;
  revision: string | null;
  run_id: number | null;
  story_id: string | null;
  phase_id: string | null;
  gate_id: string | null;
  evidence_type: string;
  subject_type: EvidenceSubjectType;
  subject_value: string;
  source_system: string;
  source_idempotency_key: string;
  payload_hash: string;
  metadata: JsonObject;
  provenance: JsonObject;
  source_ref: string | null;
  observed_at: DbTimestamp;
  created_at: DbTimestamp;
}

interface DecisionRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  spec_version: string | null;
  revision: string | null;
  run_id: number | null;
  story_id: string | null;
  phase_id: string | null;
  gate_id: string | null;
  decision_type: LifecycleDecisionType;
  actor: string;
  rationale: string;
  scope: JsonObject;
  provenance: JsonObject;
  created_at: DbTimestamp;
  expires_at: DbTimestamp | null;
  revoked_at: DbTimestamp | null;
  revoked_by: string | null;
  revocation_rationale: string | null;
}

export interface CompiledPlan {
  id: string;
  workspaceId: string;
  specSlug: string;
  specVersion: string;
  compilerVersion: string;
  normalizedInputHash: string;
  profileHash: string | null;
  schemaVersion: string;
  plan: JsonObject;
  validationStatus: PlanValidationStatus;
  lifecycleState: PlanLifecycleState;
  isCurrent: boolean;
  createdAt: DbTimestamp;
  validatedAt: DbTimestamp | null;
  updatedAt: DbTimestamp;
}

export interface CreateCompiledPlanInput {
  workspaceId: string;
  specSlug: string;
  specVersion: string | number;
  compilerVersion: string;
  normalizedInputHash: string;
  schemaVersion: string;
  plan: JsonObjectInput;
  validationStatus: PlanValidationStatus;
}

export interface LifecycleEvidence {
  id: string;
  workspaceId: string;
  specSlug: string;
  specVersion: string | null;
  revision: string | null;
  runId: number | null;
  storyId: string | null;
  phaseId: string | null;
  gateId: string | null;
  evidenceType: string;
  subjectType: EvidenceSubjectType;
  subjectValue: string;
  sourceSystem: string;
  sourceIdempotencyKey: string;
  payloadHash: string;
  metadata: JsonObject;
  provenance: JsonObject;
  sourceRef: string | null;
  observedAt: DbTimestamp;
  createdAt: DbTimestamp;
}

export interface AppendEvidenceInput {
  workspaceId: string;
  specSlug: string;
  specVersion?: string | number | null;
  revision?: string | null;
  runId?: number | null;
  storyId?: string | null;
  phaseId?: string | null;
  gateId?: string | null;
  evidenceType: string;
  subjectType: EvidenceSubjectType;
  subjectValue: string;
  sourceSystem: string;
  sourceIdempotencyKey: string;
  metadata?: JsonObjectInput;
  provenance?: JsonObjectInput;
  sourceRef?: string | null;
  observedAt?: Date | string;
}

export interface LifecycleDecision {
  id: string;
  workspaceId: string;
  specSlug: string;
  specVersion: string | null;
  revision: string | null;
  runId: number | null;
  storyId: string | null;
  phaseId: string | null;
  gateId: string | null;
  decisionType: LifecycleDecisionType;
  actor: string;
  rationale: string;
  scope: JsonObject;
  provenance: JsonObject;
  createdAt: DbTimestamp;
  expiresAt: DbTimestamp | null;
  revokedAt: DbTimestamp | null;
  revokedBy: string | null;
  revocationRationale: string | null;
}

export interface CreateDecisionInput {
  workspaceId: string;
  specSlug: string;
  specVersion?: string | number | null;
  revision?: string | null;
  runId?: number | null;
  storyId?: string | null;
  phaseId?: string | null;
  gateId?: string | null;
  decisionType: LifecycleDecisionType;
  actor: string;
  rationale: string;
  scope?: JsonObjectInput;
  provenance?: JsonObjectInput;
  expiresAt?: Date | string | null;
}

const PLAN_STATUSES: readonly PlanValidationStatus[] = ['draft', 'validated', 'failed'];
const SUBJECT_TYPES: readonly EvidenceSubjectType[] = ['spec_hash', 'commit_sha', 'artifact_digest', 'deployment_id'];
const DECISION_TYPES: readonly LifecycleDecisionType[] = [
  'defer',
  'not_applicable_confirmation',
  'gate_override',
  'qa_approval',
  'merge_approval',
  'production_approval',
];

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field);
}

function normalizeVersion(value: string | number | null | undefined, field: string, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required`, { field });
    return null;
  }
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw new ValidationError(`${field} must be a non-empty string or number`, { field });
  }
  return String(value).trim();
}

function optionalRunId(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError('runId must be a positive integer', { field: 'runId' });
  }
  return value;
}

function normalizeJsonValue(value: unknown, field: string, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`${field} contains a non-finite number`, { field });
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new ValidationError(`${field} contains a circular reference`, { field });
    seen.add(value);
    const normalized = value.map((item) => normalizeJsonValue(item, field, seen));
    seen.delete(value);
    return normalized;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new ValidationError(`${field} contains a circular reference`, { field });
    seen.add(value);
    const normalized: JsonObject = {};
    for (const key of Object.keys(value as JsonObject).sort()) {
      const child = (value as JsonObject)[key];
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
        throw new ValidationError(`${field}.${key} is not valid JSON`, { field });
      }
      normalized[key] = normalizeJsonValue(child, field, seen);
    }
    seen.delete(value);
    return normalized;
  }
  throw new ValidationError(`${field} is not valid JSON`, { field });
}

function jsonObject(value: JsonObjectInput | undefined, field: string): JsonObject {
  let parsed: unknown = value ?? {};
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new ValidationError(`${field} contains malformed JSON`, { field });
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError(`${field} must be a JSON object`, { field });
  }
  return normalizeJsonValue(parsed, field, new WeakSet()) as JsonObject;
}

function validDate(value: Date | string | undefined, field: string, defaultNow = false): Date | null {
  if (value === undefined && defaultNow) return new Date();
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be a valid timestamp`, { field });
  return date;
}

function canonicalJson(value: JsonObject): string {
  return JSON.stringify(value);
}

function sha256(value: JsonObject): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function planFromRow(row: CompiledPlanRow): CompiledPlan {
  const lifecycleState: PlanLifecycleState = row.is_current
    ? 'current'
    : row.validation_status === 'validated'
      ? 'superseded'
      : row.validation_status;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    specSlug: row.spec_slug,
    specVersion: row.spec_version,
    compilerVersion: row.compiler_version,
    normalizedInputHash: row.normalized_input_hash,
    profileHash: row.profile_hash,
    schemaVersion: row.schema_version,
    plan: row.plan_json,
    validationStatus: row.validation_status,
    lifecycleState,
    isCurrent: row.is_current,
    createdAt: row.created_at,
    validatedAt: row.validated_at,
    updatedAt: row.updated_at,
  };
}

function evidenceFromRow(row: EvidenceRow): LifecycleEvidence {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    specSlug: row.spec_slug,
    specVersion: row.spec_version,
    revision: row.revision,
    runId: row.run_id,
    storyId: row.story_id,
    phaseId: row.phase_id,
    gateId: row.gate_id,
    evidenceType: row.evidence_type,
    subjectType: row.subject_type,
    subjectValue: row.subject_value,
    sourceSystem: row.source_system,
    sourceIdempotencyKey: row.source_idempotency_key,
    payloadHash: row.payload_hash,
    metadata: row.metadata,
    provenance: row.provenance,
    sourceRef: row.source_ref,
    observedAt: row.observed_at,
    createdAt: row.created_at,
  };
}

function decisionFromRow(row: DecisionRow): LifecycleDecision {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    specSlug: row.spec_slug,
    specVersion: row.spec_version,
    revision: row.revision,
    runId: row.run_id,
    storyId: row.story_id,
    phaseId: row.phase_id,
    gateId: row.gate_id,
    decisionType: row.decision_type,
    actor: row.actor,
    rationale: row.rationale,
    scope: row.scope,
    provenance: row.provenance,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revocationRationale: row.revocation_rationale,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

async function workspaceExists(workspaceId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  return Boolean(row);
}

export async function createCompiledPlan(input: CreateCompiledPlanInput): Promise<CompiledPlan> {
  const workspaceId = requiredText(input.workspaceId, 'workspaceId');
  const specSlug = requiredText(input.specSlug, 'specSlug');
  const specVersion = normalizeVersion(input.specVersion, 'specVersion', true)!;
  const compilerVersion = requiredText(input.compilerVersion, 'compilerVersion');
  const inputHash = requiredText(input.normalizedInputHash, 'normalizedInputHash');
  const schemaVersion = requiredText(input.schemaVersion, 'schemaVersion');
  const plan = jsonObject(input.plan, 'plan');
  if (!PLAN_STATUSES.includes(input.validationStatus)) {
    throw new ValidationError(`validationStatus must be one of: ${PLAN_STATUSES.join(', ')}`, { field: 'validationStatus' });
  }

  const profileHash = typeof plan.profile === 'object' && plan.profile !== null
    && typeof (plan.profile as JsonObject).profileHash === 'string'
    ? String((plan.profile as JsonObject).profileHash)
    : null;

  let row = await queryOne<CompiledPlanRow>(`
    INSERT INTO ssdlc_compiled_plans (
      workspace_id, spec_slug, spec_version, compiler_version,
      normalized_input_hash, profile_hash, schema_version, plan_json, validation_status, validated_at
    )
    SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
           CASE WHEN $9 = 'validated' THEN NOW() ELSE NULL END
    FROM workspaces w
    WHERE w.id = $1
    ON CONFLICT (workspace_id, spec_slug, spec_version, compiler_version, normalized_input_hash, profile_hash)
      DO NOTHING
    RETURNING *
  `, [
    workspaceId,
    specSlug,
    specVersion,
    compilerVersion,
    inputHash,
    profileHash,
    schemaVersion,
    canonicalJson(plan),
    input.validationStatus,
  ]);

  const inserted = Boolean(row);
  if (!row) {
    row = await queryOne<CompiledPlanRow>(`
      SELECT * FROM ssdlc_compiled_plans
      WHERE workspace_id = $1
        AND spec_slug = $2
        AND spec_version = $3
        AND compiler_version = $4
        AND normalized_input_hash = $5
        AND profile_hash IS NOT DISTINCT FROM $6
    `, [workspaceId, specSlug, specVersion, compilerVersion, inputHash, profileHash]);

    if (!row) {
      if (!(await workspaceExists(workspaceId))) throw new NotFoundError('Workspace', workspaceId);
      throw new ConflictError('Compiled plan identity could not be persisted');
    }
    const storedPlan = jsonObject(row.plan_json, 'storedPlan');
    if (
      row.validation_status !== input.validationStatus
      || row.schema_version !== schemaVersion
      || canonicalJson(storedPlan) !== canonicalJson(plan)
    ) {
      throw new ConflictError('Compiled plan identity already exists with a different immutable outcome');
    }
  }

  if (input.validationStatus === 'validated' && inserted) {
    return await selectCurrentPlan(workspaceId, specSlug, row.id);
  }
  if (input.validationStatus === 'validated' && !row.is_current) {
    const current = await queryOne<Pick<CompiledPlanRow, 'id'>>(`
      SELECT id FROM ssdlc_compiled_plans
      WHERE workspace_id = $1 AND spec_slug = $2 AND is_current = TRUE
    `, [workspaceId, specSlug]);
    if (!current) return await selectCurrentPlan(workspaceId, specSlug, row.id);
  }
  return planFromRow(row);
}

export async function selectCurrentPlan(workspaceIdInput: string, specSlugInput: string, planIdInput: string): Promise<CompiledPlan> {
  const workspaceId = requiredText(workspaceIdInput, 'workspaceId');
  const specSlug = requiredText(specSlugInput, 'specSlug');
  const planId = requiredText(planIdInput, 'planId');

  const selected = await queryOne<CompiledPlanRow>(`
    WITH candidate AS (
      SELECT id
      FROM ssdlc_compiled_plans
      WHERE workspace_id = $1
        AND spec_slug = $2
        AND id = $3
        AND validation_status = 'validated'
    ), cleared AS (
      UPDATE ssdlc_compiled_plans
      SET is_current = FALSE, updated_at = NOW()
      WHERE workspace_id = $1
        AND spec_slug = $2
        AND is_current = TRUE
        AND id <> $3
        AND EXISTS (SELECT 1 FROM candidate)
      RETURNING id
    )
    UPDATE ssdlc_compiled_plans
    SET is_current = TRUE, updated_at = NOW()
    WHERE workspace_id = $1
      AND spec_slug = $2
      AND id = (SELECT id FROM candidate)
      AND (SELECT COUNT(*) FROM cleared) >= 0
    RETURNING *
  `, [workspaceId, specSlug, planId]);

  if (selected) return planFromRow(selected);

  const existing = await queryOne<Pick<CompiledPlanRow, 'id' | 'validation_status'>>(`
    SELECT id, validation_status
    FROM ssdlc_compiled_plans
    WHERE workspace_id = $1 AND spec_slug = $2 AND id = $3
  `, [workspaceId, specSlug, planId]);
  if (!existing) throw new NotFoundError('Compiled plan', planId);
  throw new ValidationError('Only a validated plan can be selected as current', { planId });
}

export async function getCurrentPlan(workspaceIdInput: string, specSlugInput: string): Promise<CompiledPlan> {
  const workspaceId = requiredText(workspaceIdInput, 'workspaceId');
  const specSlug = requiredText(specSlugInput, 'specSlug');
  const row = await queryOne<CompiledPlanRow>(`
    SELECT * FROM ssdlc_compiled_plans
    WHERE workspace_id = $1 AND spec_slug = $2 AND is_current = TRUE
  `, [workspaceId, specSlug]);
  if (!row) throw new NotFoundError('Current compiled plan', `${workspaceId}/${specSlug}`);
  return planFromRow(row);
}

export async function getCompiledPlanVersion(
  workspaceIdInput: string,
  specSlugInput: string,
  specVersionInput: string | number,
  identity?: { compilerVersion: string; normalizedInputHash: string },
): Promise<CompiledPlan> {
  const workspaceId = requiredText(workspaceIdInput, 'workspaceId');
  const specSlug = requiredText(specSlugInput, 'specSlug');
  const specVersion = normalizeVersion(specVersionInput, 'specVersion', true)!;
  const compilerVersion = identity ? requiredText(identity.compilerVersion, 'compilerVersion') : null;
  const inputHash = identity ? requiredText(identity.normalizedInputHash, 'normalizedInputHash') : null;
  const row = await queryOne<CompiledPlanRow>(`
    SELECT * FROM ssdlc_compiled_plans
    WHERE workspace_id = $1
      AND spec_slug = $2
      AND spec_version = $3
      AND ($4::text IS NULL OR compiler_version = $4)
      AND ($5::text IS NULL OR normalized_input_hash = $5)
    ORDER BY is_current DESC, created_at DESC
    LIMIT 1
  `, [workspaceId, specSlug, specVersion, compilerVersion, inputHash]);
  if (!row) throw new NotFoundError('Compiled plan version', `${workspaceId}/${specSlug}@${specVersion}`);
  return planFromRow(row);
}

export async function listCompiledPlans(
  workspaceIdInput: string,
  filters: { specSlug?: string; validationStatus?: PlanValidationStatus } = {},
): Promise<CompiledPlan[]> {
  const workspaceId = requiredText(workspaceIdInput, 'workspaceId');
  const specSlug = filters.specSlug ? requiredText(filters.specSlug, 'specSlug') : null;
  if (filters.validationStatus && !PLAN_STATUSES.includes(filters.validationStatus)) {
    throw new ValidationError(`validationStatus must be one of: ${PLAN_STATUSES.join(', ')}`, { field: 'validationStatus' });
  }
  const rows = await query<CompiledPlanRow>(`
    SELECT * FROM ssdlc_compiled_plans
    WHERE workspace_id = $1
      AND ($2::text IS NULL OR spec_slug = $2)
      AND ($3::text IS NULL OR validation_status = $3)
    ORDER BY spec_slug, is_current DESC, created_at DESC
  `, [workspaceId, specSlug, filters.validationStatus ?? null]);
  return rows.map(planFromRow);
}

async function findEvidenceBySource(
  workspaceId: string,
  sourceSystem: string,
  sourceIdempotencyKey: string,
): Promise<EvidenceRow | undefined> {
  return await queryOne<EvidenceRow>(`
    SELECT * FROM ssdlc_lifecycle_evidence
    WHERE workspace_id = $1 AND source_system = $2 AND source_idempotency_key = $3
  `, [workspaceId, sourceSystem, sourceIdempotencyKey]);
}

async function resolveEvidenceReplay(existing: EvidenceRow, payloadHash: string): Promise<LifecycleEvidence> {
  if (existing.payload_hash === payloadHash) return evidenceFromRow(existing);
  await execute(`
    INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload)
    SELECT 'ssdlc_evidence_source_conflict', $1, $2, $3, 'ssdlc-store', $4::jsonb
    FROM workspaces w
    WHERE w.id = $1
  `, [
    existing.workspace_id,
    existing.spec_slug,
    existing.story_id,
    JSON.stringify({
      sourceSystem: existing.source_system,
      sourceIdempotencyKey: existing.source_idempotency_key,
      existingPayloadHash: existing.payload_hash,
      replayPayloadHash: payloadHash,
      evidenceId: existing.id,
    }),
  ]);
  throw new ConflictError('Evidence source id was replayed with a conflicting payload; the conflict was audit-recorded');
}

export async function appendEvidence(input: AppendEvidenceInput): Promise<LifecycleEvidence> {
  const workspaceId = requiredText(input.workspaceId, 'workspaceId');
  const specSlug = requiredText(input.specSlug, 'specSlug');
  const specVersion = normalizeVersion(input.specVersion, 'specVersion');
  const revision = optionalText(input.revision, 'revision');
  const runId = optionalRunId(input.runId);
  const storyId = optionalText(input.storyId, 'storyId');
  const phaseId = optionalText(input.phaseId, 'phaseId');
  const gateId = optionalText(input.gateId, 'gateId');
  const evidenceType = requiredText(input.evidenceType, 'evidenceType');
  if (!SUBJECT_TYPES.includes(input.subjectType)) {
    throw new ValidationError(`subjectType must be one of: ${SUBJECT_TYPES.join(', ')}`, { field: 'subjectType' });
  }
  const subjectValue = requiredText(input.subjectValue, 'subjectValue');
  const sourceSystem = requiredText(input.sourceSystem, 'sourceSystem');
  const sourceKey = requiredText(input.sourceIdempotencyKey, 'sourceIdempotencyKey');
  const metadata = jsonObject(input.metadata, 'metadata');
  const provenance = jsonObject(input.provenance, 'provenance');
  const sourceRef = optionalText(input.sourceRef, 'sourceRef');
  const observedAt = validDate(input.observedAt, 'observedAt', true)!;
  const payloadHash = sha256({
    specSlug,
    specVersion,
    revision,
    runId,
    storyId,
    phaseId,
    gateId,
    evidenceType,
    subjectType: input.subjectType,
    subjectValue,
    metadata,
    provenance,
    sourceRef,
    observedAt: input.observedAt === undefined ? null : observedAt.toISOString(),
  });

  const existing = await findEvidenceBySource(workspaceId, sourceSystem, sourceKey);
  if (existing) return await resolveEvidenceReplay(existing, payloadHash);

  let row: EvidenceRow | undefined;
  try {
    row = await queryOne<EvidenceRow>(`
      INSERT INTO ssdlc_lifecycle_evidence (
        workspace_id, spec_slug, spec_version, revision, run_id, story_id, phase_id, gate_id,
        evidence_type, subject_type, subject_value, source_system, source_idempotency_key,
        payload_hash, metadata, provenance, source_ref, observed_at
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14, $15::jsonb, $16::jsonb, $17, $18
      FROM workspaces w
      WHERE w.id = $1
        AND ($5::integer IS NULL OR EXISTS (
          SELECT 1 FROM pipeline_runs pr WHERE pr.workspace_id = $1 AND pr.id = $5
        ))
      RETURNING *
    `, [
      workspaceId,
      specSlug,
      specVersion,
      revision,
      runId,
      storyId,
      phaseId,
      gateId,
      evidenceType,
      input.subjectType,
      subjectValue,
      sourceSystem,
      sourceKey,
      payloadHash,
      canonicalJson(metadata),
      canonicalJson(provenance),
      sourceRef,
      observedAt,
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const concurrent = await findEvidenceBySource(workspaceId, sourceSystem, sourceKey);
    if (concurrent) return await resolveEvidenceReplay(concurrent, payloadHash);
    throw new ConflictError('Duplicate lifecycle evidence replay rejected');
  }

  if (!row) {
    if (!(await workspaceExists(workspaceId))) throw new NotFoundError('Workspace', workspaceId);
    throw new ValidationError('runId does not belong to the requested workspace', { runId });
  }
  return evidenceFromRow(row);
}

export async function listEvidence(
  workspaceIdInput: string,
  filters: {
    specSlug?: string;
    phaseId?: string;
    gateId?: string;
    storyId?: string;
    runId?: number;
    revision?: string;
    limit?: number;
  } = {},
): Promise<LifecycleEvidence[]> {
  const workspaceId = requiredText(workspaceIdInput, 'workspaceId');
  const specSlug = filters.specSlug ? requiredText(filters.specSlug, 'specSlug') : null;
  const phaseId = filters.phaseId ? requiredText(filters.phaseId, 'phaseId') : null;
  const gateId = filters.gateId ? requiredText(filters.gateId, 'gateId') : null;
  const storyId = filters.storyId ? requiredText(filters.storyId, 'storyId') : null;
  const runId = optionalRunId(filters.runId);
  const revision = filters.revision ? requiredText(filters.revision, 'revision') : null;
  const limit = filters.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new ValidationError('limit must be an integer between 1 and 500', { field: 'limit' });
  }
  const rows = await query<EvidenceRow>(`
    SELECT * FROM ssdlc_lifecycle_evidence
    WHERE workspace_id = $1
      AND ($2::text IS NULL OR spec_slug = $2)
      AND ($3::text IS NULL OR phase_id = $3)
      AND ($4::text IS NULL OR gate_id = $4)
      AND ($5::text IS NULL OR story_id = $5)
      AND ($6::integer IS NULL OR run_id = $6)
      AND ($7::text IS NULL OR revision = $7)
    ORDER BY created_at DESC
    LIMIT $8
  `, [workspaceId, specSlug, phaseId, gateId, storyId, runId, revision, limit]);
  return rows.map(evidenceFromRow);
}

export async function createDecision(input: CreateDecisionInput): Promise<LifecycleDecision> {
  const workspaceId = requiredText(input.workspaceId, 'workspaceId');
  const specSlug = requiredText(input.specSlug, 'specSlug');
  const specVersion = normalizeVersion(input.specVersion, 'specVersion');
  const revision = optionalText(input.revision, 'revision');
  const runId = optionalRunId(input.runId);
  const storyId = optionalText(input.storyId, 'storyId');
  const phaseId = optionalText(input.phaseId, 'phaseId');
  const gateId = optionalText(input.gateId, 'gateId');
  if (!DECISION_TYPES.includes(input.decisionType)) {
    throw new ValidationError(`decisionType must be one of: ${DECISION_TYPES.join(', ')}`, { field: 'decisionType' });
  }
  const actor = requiredText(input.actor, 'actor');
  const rationale = requiredText(input.rationale, 'rationale');
  const scope = jsonObject(input.scope, 'scope');
  const provenance = jsonObject(input.provenance, 'provenance');
  const expiresAt = validDate(input.expiresAt ?? undefined, 'expiresAt');
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new ValidationError('expiresAt must be in the future', { field: 'expiresAt' });
  }

  const row = await queryOne<DecisionRow>(`
    INSERT INTO ssdlc_lifecycle_decisions (
      workspace_id, spec_slug, spec_version, revision, run_id, story_id, phase_id, gate_id,
      decision_type, actor, rationale, scope, provenance, expires_at
    )
    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14
    FROM workspaces w
    WHERE w.id = $1
      AND ($5::integer IS NULL OR EXISTS (
        SELECT 1 FROM pipeline_runs pr WHERE pr.workspace_id = $1 AND pr.id = $5
      ))
    RETURNING *
  `, [
    workspaceId,
    specSlug,
    specVersion,
    revision,
    runId,
    storyId,
    phaseId,
    gateId,
    input.decisionType,
    actor,
    rationale,
    canonicalJson(scope),
    canonicalJson(provenance),
    expiresAt,
  ]);

  if (!row) {
    if (!(await workspaceExists(workspaceId))) throw new NotFoundError('Workspace', workspaceId);
    throw new ValidationError('runId does not belong to the requested workspace', { runId });
  }
  return decisionFromRow(row);
}

export async function revokeDecision(
  workspaceIdInput: string,
  decisionIdInput: string,
  actorInput: string,
  rationaleInput: string,
): Promise<LifecycleDecision> {
  const workspaceId = requiredText(workspaceIdInput, 'workspaceId');
  const decisionId = requiredText(decisionIdInput, 'decisionId');
  const actor = requiredText(actorInput, 'actor');
  const rationale = requiredText(rationaleInput, 'rationale');
  const row = await queryOne<DecisionRow>(`
    UPDATE ssdlc_lifecycle_decisions
    SET revoked_at = NOW(), revoked_by = $3, revocation_rationale = $4
    WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL
    RETURNING *
  `, [workspaceId, decisionId, actor, rationale]);
  if (row) return decisionFromRow(row);

  const existing = await queryOne<Pick<DecisionRow, 'id' | 'revoked_at'>>(`
    SELECT id, revoked_at FROM ssdlc_lifecycle_decisions
    WHERE workspace_id = $1 AND id = $2
  `, [workspaceId, decisionId]);
  if (!existing) throw new NotFoundError('Lifecycle decision', decisionId);
  throw new ConflictError('Lifecycle decision has already been revoked');
}

export async function listDecisions(
  workspaceIdInput: string,
  filters: {
    specSlug?: string;
    phaseId?: string;
    gateId?: string;
    storyId?: string;
    decisionType?: LifecycleDecisionType;
    activeOnly?: boolean;
    limit?: number;
  } = {},
): Promise<LifecycleDecision[]> {
  const workspaceId = requiredText(workspaceIdInput, 'workspaceId');
  const specSlug = filters.specSlug ? requiredText(filters.specSlug, 'specSlug') : null;
  const phaseId = filters.phaseId ? requiredText(filters.phaseId, 'phaseId') : null;
  const gateId = filters.gateId ? requiredText(filters.gateId, 'gateId') : null;
  const storyId = filters.storyId ? requiredText(filters.storyId, 'storyId') : null;
  if (filters.decisionType && !DECISION_TYPES.includes(filters.decisionType)) {
    throw new ValidationError(`decisionType must be one of: ${DECISION_TYPES.join(', ')}`, { field: 'decisionType' });
  }
  const limit = filters.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new ValidationError('limit must be an integer between 1 and 500', { field: 'limit' });
  }
  const activeClause = filters.activeOnly
    ? 'AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())'
    : '';
  const rows = await query<DecisionRow>(`
    SELECT * FROM ssdlc_lifecycle_decisions
    WHERE workspace_id = $1
      AND ($2::text IS NULL OR spec_slug = $2)
      AND ($3::text IS NULL OR phase_id = $3)
      AND ($4::text IS NULL OR gate_id = $4)
      AND ($5::text IS NULL OR story_id = $5)
      AND ($6::text IS NULL OR decision_type = $6)
      ${activeClause}
    ORDER BY created_at DESC
    LIMIT $7
  `, [workspaceId, specSlug, phaseId, gateId, storyId, filters.decisionType ?? null, limit]);
  return rows.map(decisionFromRow);
}

export async function listActiveDecisions(
  workspaceId: string,
  filters: Omit<Parameters<typeof listDecisions>[1], 'activeOnly'> = {},
): Promise<LifecycleDecision[]> {
  return await listDecisions(workspaceId, { ...filters, activeOnly: true });
}

export async function getPhaseDetail(
  workspaceIdInput: string,
  specSlugInput: string,
  phaseIdInput: string,
): Promise<{ state: DerivedPhaseState; evidence: LifecycleEvidence[]; activeDecisions: LifecycleDecision[] }> {
  const workspaceId = requiredText(workspaceIdInput, 'workspaceId');
  const specSlug = requiredText(specSlugInput, 'specSlug');
  const phaseId = requiredText(phaseIdInput, 'phaseId');
  const [evidence, activeDecisions] = await Promise.all([
    listEvidence(workspaceId, { specSlug, phaseId }),
    listActiveDecisions(workspaceId, { specSlug, phaseId }),
  ]);
  const types = new Set(activeDecisions.map((decision) => decision.decisionType));
  const state: DerivedPhaseState = types.has('defer')
    ? 'deferred'
    : types.has('not_applicable_confirmation')
      ? 'not_applicable'
      : types.has('gate_override')
        || types.has('qa_approval')
        || types.has('merge_approval')
        || types.has('production_approval')
        ? 'approved'
        : evidence.length > 0
          ? 'evidence_available'
          : 'pending';
  return { state, evidence, activeDecisions };
}
