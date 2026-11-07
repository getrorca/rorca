/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { canonicalTransaction } from '../db/index';
import { AppError, ConflictError, NotFoundError, UnprocessableError, ValidationError } from './errors';
import { logger } from './logger';
import { verifyLocalWave2Prerequisites, type Wave2SourceGateDecision } from './governed-prerequisite-gate';
import {
  ActivationScopeSchema, assertNoForbiddenGovernedFields, CancellationV1Schema, CloseoutEvaluationV1Schema, ContextBundleDeltaV1Schema,
  ContextBundleV1Schema, ContextCheckpointV1Schema, ContextPolicyActivationV1Schema, ContextPolicyDefinitionV1Schema,
  ContinuationDispatchV1Schema, ContinuationRetryBudgetV1Schema, EvidenceEnvelopeV1Schema, ExecutionLeaseV1Schema,
  governedHash, MissionContractV1Schema, PlanChangeProposalV1Schema, RetrievalReceiptV1Schema, RuntimeEventV1Schema,
  WorkPackageV1Schema,
  type ContinuationScope, type EvidenceEnvelopeV1,
} from './governed-contracts';

const MAX_LEASE_SECONDS = 60 * 60;
const PERMANENT_RETRY_REASONS = new Set([
  'authority_conflict', 'identity_conflict', 'workspace_mismatch', 'secret_bearing_payload', 'hash_mismatch',
  'unsupported_version', 'stale_artifact', 'idempotency_payload_conflict', 'aborted_compaction', 'forbidden_delta',
]);

export function evaluateEvidenceStatusPolicy(requiredStatus:'passed'|'failed',evidenceStatus:string):'satisfied'|'failed'|'conflicting' {
  if (['unknown','conflicted','cancelled'].includes(evidenceStatus)) return 'conflicting';
  if (evidenceStatus === 'failed' || requiredStatus === 'failed') return 'failed';
  return evidenceStatus === requiredStatus ? 'satisfied' : 'failed';
}

type GovernedAuthorityCeiling='none'|'observe'|'propose'|'execute_bounded';
type GovernedExecutionPosture={
  execution:GovernedAuthorityCeiling;autoMerge:boolean;deployment:boolean;providerMutation:boolean;
};
const GOVERNED_AUTHORITY_CEILINGS:readonly GovernedAuthorityCeiling[]=['none','observe','propose','execute_bounded'];
function minimumAuthorityCeiling(left:GovernedAuthorityCeiling,right:GovernedAuthorityCeiling):GovernedAuthorityCeiling{
  return GOVERNED_AUTHORITY_CEILINGS[Math.min(GOVERNED_AUTHORITY_CEILINGS.indexOf(left),GOVERNED_AUTHORITY_CEILINGS.indexOf(right))]!;
}
/** Each categorical maximum is independently capped and can never exceed the mission-wide execution ceiling. */
export function maximumWorkPackageAuthorityCeilings(posture:GovernedExecutionPosture):Record<'delivery'|'operational'|'knowledge'|'interactive',GovernedAuthorityCeiling>{
  const categoricalCaps={
    delivery:posture.autoMerge?'execute_bounded':'propose',
    operational:posture.deployment||posture.providerMutation?'execute_bounded':'observe',
    knowledge:'execute_bounded',
    interactive:posture.providerMutation?'execute_bounded':'propose',
  } as const;
  return {
    delivery:minimumAuthorityCeiling(posture.execution,categoricalCaps.delivery),
    operational:minimumAuthorityCeiling(posture.execution,categoricalCaps.operational),
    knowledge:minimumAuthorityCeiling(posture.execution,categoricalCaps.knowledge),
    interactive:minimumAuthorityCeiling(posture.execution,categoricalCaps.interactive),
  };
}

function stableHash(domain: string, value: unknown): string {
  return governedHash(domain, value as never);
}
function asJson(value: unknown): string { return JSON.stringify(value); }
function governedArtifactIntegrityHash(domain: string, value: Record<string, unknown>, omitted: string[]): string {
  return stableHash(domain, Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key))));
}
function assertGovernedPayloadSafe(value: unknown): void {
  try { assertNoForbiddenGovernedFields(value); }
  catch { throw new UnprocessableError('Governed payload contains forbidden authority or secret material', 'SECRET_BEARING_PAYLOAD'); }
}
function assertTokenAccounting(accounting: { required: number; advisory: number; instructions: number; total: number }): void {
  if (accounting.total !== accounting.required + accounting.advisory + accounting.instructions) {
    throw new UnprocessableError('Token accounting total must equal required + advisory + instructions', 'TOKEN_ACCOUNTING_MISMATCH');
  }
}
function jsonPointerSegments(path: string): string[] | null {
  if (!path.startsWith('/') || path.includes('//')) return null;
  return path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}
function valueAtPointer(value: unknown, path: string): { exists: boolean; value?: unknown } {
  const segments = jsonPointerSegments(path); if (!segments) return { exists: false };
  let current: unknown = value;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return { exists: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { exists: true, value: current };
}
function changedJsonPointers(base: unknown, target: unknown, prefix = ''): string[] {
  if (stableHash('rorca.context-delta-comparison.v1', base) === stableHash('rorca.context-delta-comparison.v1', target)) return [];
  if (!base || !target || typeof base !== 'object' || typeof target !== 'object' || Array.isArray(base) || Array.isArray(target)) return [prefix || '/'];
  const left = base as Record<string, unknown>; const right = target as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) => changedJsonPointers(left[key], right[key], `${prefix}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
}
function applyServerVerifiedDelta(base: unknown, target: unknown, operations: Array<{ index: number; type: 'add' | 'remove' | 'replace'; path: string; valueHash: string | null }>): unknown | null {
  const result = structuredClone(base) as Record<string, unknown>;
  for (let position = 0; position < operations.length; position += 1) {
    const operation = operations[position]!; const segments = jsonPointerSegments(operation.path);
    if (operation.index !== position || !segments?.length) return null;
    let parent: Record<string, unknown> = result;
    for (const segment of segments.slice(0, -1)) {
      const next = parent[segment]; if (!next || typeof next !== 'object' || Array.isArray(next)) return null;
      parent = next as Record<string, unknown>;
    }
    const key = segments.at(-1)!; const targetValue = valueAtPointer(target, operation.path);
    if (operation.type === 'remove') {
      if (!Object.prototype.hasOwnProperty.call(parent, key) || targetValue.exists || operation.valueHash !== null) return null;
      delete parent[key]; continue;
    }
    if (!targetValue.exists || operation.valueHash !== stableHash('rorca.context-delta-value.v1', targetValue.value)
      || (operation.type === 'replace' && !Object.prototype.hasOwnProperty.call(parent, key))
      || (operation.type === 'add' && Object.prototype.hasOwnProperty.call(parent, key))) return null;
    parent[key] = structuredClone(targetValue.value);
  }
  return result;
}

async function verifyActiveLeaseScope(client: PoolClient, scope: ContinuationScope): Promise<void> {
  const lease = await client.query<{ state: string; expires_at: Date; fencing_token: string; runtime_id: string;
    work_package_revision: number; policy_activation_hash: string; repository_id: string; base_sha: string; current_sha: string; worktree_id: string }>(
    `SELECT state,expires_at,fencing_token,runtime_id,work_package_revision,policy_activation_hash,repository_id,base_sha,current_sha,worktree_id
     FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`, [scope.workspaceId, scope.leaseId]);
  const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time');
  const row = lease.rows[0];
  if (!row || row.state !== 'active' || row.expires_at <= clock.rows[0]!.db_time) throw new UnprocessableError('Execution lease is expired or inactive', 'LEASE_EXPIRED');
  if (Number(row.fencing_token) !== scope.fencingToken || row.runtime_id !== scope.runtimeId
    || row.work_package_revision !== scope.workPackageRevision || row.policy_activation_hash !== scope.policyActivationHash
    || row.repository_id !== scope.repository.repositoryId || row.base_sha !== scope.repository.baseSha
    || row.current_sha !== scope.repository.currentSha || row.worktree_id !== scope.repository.worktreeId) {
    throw new ConflictError('Runtime lease subject mismatch', { reason: 'stale_fence' });
  }
  const activation = await client.query<{ scope_key: string; activation_id: string; current_revision: number;
    policy_definition_id: string; policy_definition_version: string; policy_definition_hash: string; scope_json: unknown }>(
    `SELECT h.scope_key,h.activation_id,h.current_revision,a.policy_definition_id,a.policy_definition_version,
            d.policy_definition_hash,a.scope_json FROM context_policy_activation_heads h
     JOIN context_policy_activations a ON a.workspace_id=h.workspace_id AND a.activation_id=h.activation_id AND a.activation_revision=h.current_revision
     JOIN context_policy_definitions d ON d.workspace_id=a.workspace_id AND d.policy_definition_id=a.policy_definition_id
      AND d.policy_definition_version=a.policy_definition_version
     WHERE h.workspace_id=$1 AND h.current_hash=$2 AND h.effective_state='active' AND a.state='active'
      AND d.lifecycle_state='published' AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp()) FOR KEY SHARE OF h,a,d`,
    [scope.workspaceId, scope.policyActivationHash]);
  const policy = activation.rows[0];
  const expectedScope = ActivationScopeSchema.parse({ workspaceId: scope.workspaceId, missionId: scope.missionId,
    missionRevision: scope.missionRevision, missionHash: scope.missionHash, workPackageId: scope.workPackageId,
    workPackageRevision: scope.workPackageRevision, workPackageHash: scope.workPackageHash, spec: scope.spec,
    runId: scope.runId, attemptId: scope.attemptId, leaseId: scope.leaseId, fencingToken: scope.fencingToken,
    cancellationId: scope.cancellationId, runtimeId: scope.runtimeId, repositoryId: scope.repository.repositoryId,
    remoteAuthorityHash: scope.repository.remoteAuthorityHash, baseSha: scope.repository.baseSha,
    worktreeId: scope.repository.worktreeId, allowedPathManifestHash: scope.repository.allowedPathManifestHash,
    requiredPathManifestHash: scope.repository.requiredPathManifestHash, policyDefinitionId: scope.policyDefinitionId,
    policyDefinitionVersion: scope.policyDefinitionVersion, policyDefinitionHash: scope.policyDefinitionHash });
  if (!policy || policy.activation_id !== scope.policyActivationId || policy.current_revision !== scope.policyActivationRevision
    || policy.policy_definition_id !== scope.policyDefinitionId || policy.policy_definition_version !== scope.policyDefinitionVersion
    || policy.policy_definition_hash !== scope.policyDefinitionHash
    || stableHash('rorca.context-policy-activation-scope.v1', expectedScope) !== policy.scope_key) {
    throw new UnprocessableError('Policy activation is no longer active for the exact scope', 'POLICY_ACTIVATION_INACTIVE');
  }
}

async function audit(client: PoolClient, input: {
  workspaceId: string; operation: string; actorId: string; authoritySource: string; requestHash: string;
  subjectHash: string; decision: string; resultCode: string; correlationId: string; metadata?: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO mission_control_audit
      (workspace_id,operation,actor_id,authority_source,request_hash,subject_hash,decision,result_code,correlation_id,metadata_json)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [input.workspaceId, input.operation, input.actorId, input.authoritySource, input.requestHash, input.subjectHash,
      input.decision, input.resultCode, input.correlationId, asJson(input.metadata ?? {})],
  );
}

async function recordConflict(client: PoolClient, input: {
  workspaceId: string; operation: string; subjectHash: string; existingHash?: string; incomingHash: string;
  dimension: string; actorId: string; correlationId: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO mission_control_replay_conflicts
      (workspace_id,operation,subject_hash,existing_hash,incoming_hash,dimension,reason_code,actor_id,correlation_id)
     VALUES($1,$2,$3,$4,$5,$6,'idempotency_payload_conflict',$7,$8)`,
    [input.workspaceId, input.operation, input.subjectHash, input.existingHash ?? null, input.incomingHash,
      input.dimension, input.actorId, input.correlationId],
  );
}

type MutationResult<T> = { kind: 'created' | 'duplicate'; value: T } | { kind: 'conflict'; existingHash: string };
function declaredArtifactCreators(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(declaredArtifactCreators);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [...(typeof record.createdBy === 'string' ? [record.createdBy] : []),
    ...Object.entries(record).filter(([key]) => ['artifact', 'value', 'delta', 'acknowledgement'].includes(key))
      .flatMap(([, nested]) => declaredArtifactCreators(nested))];
}

let cachedWave2Gate: { decision: Wave2SourceGateDecision; receiptHash: string } | null = null;
function verifiedWave2Gate(): { decision: Wave2SourceGateDecision; receiptHash: string } {
  if (cachedWave2Gate) return cachedWave2Gate;
  const repositoryRoot = path.resolve(__dirname, '../../..');
  const decision = verifyLocalWave2Prerequisites(repositoryRoot);
  cachedWave2Gate = { decision, receiptHash: stableHash('rorca.wave2-prerequisite-receipt.v1', decision) };
  return cachedWave2Gate;
}
async function ensureWave2PrerequisiteReceipt(client: PoolClient): Promise<string> {
  const verified = verifiedWave2Gate(); const decision = verified.decision;
  const receipt = await client.query<{ receipt_hash: string }>(`SELECT receipt_hash FROM wave2_prerequisite_receipts
    WHERE gate_version=$1 AND gate_for=$2`, [decision.schemaVersion, decision.gateFor]);
  if (receipt.rows[0]?.receipt_hash !== verified.receiptHash) throw new ConflictError('Durable Wave 2 prerequisite receipt differs from exact verified evidence', { reason: 'prerequisite_conflict' });
  const readiness = await client.query(`SELECT 1 FROM wave2_schema_readiness
    WHERE singleton=TRUE AND state='ready' AND migration_version>=20260729152000
      AND contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb'
      AND prerequisite_receipt_hash=$1`, [verified.receiptHash]);
  if (!readiness.rows[0]) throw new UnprocessableError('Wave 2 schema or prerequisite readiness is unavailable', 'WAVE2_NOT_READY');
  const ready = await client.query(`SELECT 1 FROM wave2_effective_readiness WHERE ready=TRUE AND prerequisite_receipt_hash=$1`, [verified.receiptHash]);
  if (!ready.rows[0]) throw new UnprocessableError('Wave 2 exact prerequisite receipt is not effective', 'WAVE2_PREREQUISITE_BLOCKED');
  return verified.receiptHash;
}

export async function authorizeWave2Transaction(client: PoolClient, workspaceId: string, capability?: {
  operation: string; request: unknown; requestHash?: string; subject?: unknown;subjectHash?:string;
}): Promise<string> {
  await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
  const receipt=await ensureWave2PrerequisiteReceipt(client);
  if(capability){
    const requestHash=capability.requestHash??stableHash(`rorca.api-request.${capability.operation}.v1`,capability.request);
    const subjectHash=capability.subjectHash??stableHash(`rorca.api-subject.${capability.operation}.v1`,capability.subject??capability.request);
    try {
      await client.query(`SELECT authorize_wave2_canonical_writer_mutation_v3($1,$2,$3,$4,$5::jsonb)`,
        [workspaceId,capability.operation,requestHash,subjectHash,asJson(capability.request)]);
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: string }).code === '42501') {
        throw new ConflictError('Canonical database authority denied the mutation', { reason: 'database_authority_denied' });
      }
      throw error;
    }
  }
  return receipt;
}

async function authorizeRejectedMutationAudit(client: PoolClient, workspaceId: string, operation: string,
  request: unknown, requestHash: string, subject: unknown): Promise<void> {
  await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[workspaceId]);
  const authority=await client.query<{scoped:boolean;registered:boolean}>(`SELECT
    current_setting('rorca.workspace_id',TRUE)=$1 scoped,
    EXISTS(SELECT 1 FROM wave2_canonical_writer_identities WHERE database_user=current_user) registered`,[workspaceId]);
  if(!authority.rows[0]?.scoped||!authority.rows[0]?.registered)throw new Error('Rejected mutation audit workspace authority is unavailable');
  await client.query(`SELECT authorize_wave2_canonical_writer_mutation_v3($1,'mutation-rejection.audit',$2,$3,$4::jsonb)`,[workspaceId,requestHash,
    stableHash(`rorca.api-subject.${operation}.v1`,subject),asJson({operation,request})]);
}

async function runIdempotentMutation<T>(input: {
  workspaceId: string; operation: string; principalId: string; authoritySource: string; idempotencyKey: string;
  request: unknown; subject: unknown; correlationId: string; relayPrincipalId?: string;
  mutate: (client: PoolClient, requestHash: string, subjectHash: string) => Promise<T>;
}): Promise<{ duplicate: boolean; value: T }> {
  assertGovernedPayloadSafe(input.request);
  const creators = declaredArtifactCreators(input.request);
  if (creators.some((creator) => creator !== input.principalId)) {
    throw new UnprocessableError('Artifact creator is server-bound to the authenticated principal', 'ACTOR_SUBSTITUTION_FORBIDDEN');
  }
  const requestHash = stableHash(`rorca.api-request.${input.operation}.v1`, input.request);
  const subjectHash = stableHash(`rorca.api-subject.${input.operation}.v1`, input.subject);
  const idempotencyKeyHash = stableHash('rorca.api-idempotency-key.v1', { key: input.idempotencyKey });
  let result: MutationResult<T>;
  try {
    result = await canonicalTransaction<MutationResult<T>>(async (client) => {
    await authorizeWave2Transaction(client, input.workspaceId, { operation: input.operation, request: input.request,
      requestHash, subject: input.subject });
    const existing = await client.query<{ request_hash: string; status: string; response_json: T | null }>(
      `SELECT request_hash,status,response_json FROM mission_control_idempotency
       WHERE workspace_id=$1 AND principal_id=$2 AND operation=$3 AND idempotency_key_hash=$4 FOR UPDATE`,
      [input.workspaceId, input.principalId, input.operation, idempotencyKeyHash],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_hash !== requestHash) {
        await recordConflict(client, { workspaceId: input.workspaceId, operation: input.operation, subjectHash,
          existingHash: existing.rows[0].request_hash, incomingHash: requestHash, dimension: 'request', actorId: input.principalId,
          correlationId: input.correlationId });
        await audit(client, { workspaceId: input.workspaceId, operation: input.operation, actorId: input.principalId,
          authoritySource: input.authoritySource, requestHash, subjectHash, decision: 'blocked',
          resultCode: 'idempotency_payload_conflict', correlationId: input.correlationId });
        return { kind: 'conflict', existingHash: existing.rows[0].request_hash };
      }
      if (existing.rows[0].status === 'completed' && existing.rows[0].response_json !== null) {
        return { kind: 'duplicate', value: existing.rows[0].response_json };
      }
      throw new ConflictError('The identical mutation is still in flight', { reason: 'idempotency_in_progress', retryable: true });
    }
    await client.query(
      `INSERT INTO mission_control_idempotency
        (workspace_id,principal_id,operation,idempotency_key_hash,request_hash,subject_hash,status)
       VALUES($1,$2,$3,$4,$5,$6,'in_flight')`,
      [input.workspaceId, input.principalId, input.operation, idempotencyKeyHash, requestHash, subjectHash],
    );
    const value = await input.mutate(client, requestHash, subjectHash);
    const responseHash = stableHash(`rorca.api-response.${input.operation}.v1`, value);
    await client.query(
      `UPDATE mission_control_idempotency SET status='completed',response_hash=$5,response_json=$6::jsonb,completed_at=clock_timestamp()
       WHERE workspace_id=$1 AND principal_id=$2 AND operation=$3 AND idempotency_key_hash=$4`,
      [input.workspaceId, input.principalId, input.operation, idempotencyKeyHash, responseHash, asJson(value)],
    );
    await audit(client, { workspaceId: input.workspaceId, operation: input.operation, actorId: input.principalId,
      authoritySource: input.authoritySource, requestHash, subjectHash, decision: 'accepted', resultCode: 'created',
      correlationId: input.correlationId, metadata: { responseHash, ...(input.relayPrincipalId ? { relayPrincipalId: input.relayPrincipalId } : {}) } });
      return { kind: 'created', value };
    });
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    try {
      await canonicalTransaction(async (client) => {
        await authorizeRejectedMutationAudit(client,input.workspaceId,input.operation,input.request,requestHash,input.subject);
        await audit(client, { workspaceId: input.workspaceId, operation: input.operation,
          actorId: input.principalId, authoritySource: input.authoritySource, requestHash, subjectHash,
          decision: 'blocked', resultCode: String(appError?.details?.reason ?? appError?.code ?? 'mutation_rejected'),
          correlationId: input.correlationId, metadata: input.relayPrincipalId ? { relayPrincipalId: input.relayPrincipalId } : undefined });
      });
    } catch (auditError) {
      logger.error({component:'mission-control',event:'rejected_mutation_audit_unavailable',operation:input.operation,
        workspaceId:input.workspaceId,errorName:auditError instanceof Error?auditError.name:'unknown'},
      '[mission-control] rejected mutation audit failed closed');
    }
    throw error;
  }
  if (result.kind === 'conflict') throw new ConflictError('Idempotency key was reused with changed payload', { reason: 'idempotency_payload_conflict', retryable: false, existingHash: result.existingHash });
  return { duplicate: result.kind === 'duplicate', value: result.value };
}

export interface GovernedMutationContext {
  principalId: string; authoritySource: 'local_admin' | 'authenticated_user' | 'runtime_lease' | 'provider_human';
  idempotencyKey: string; correlationId: string; relayPrincipalId?: string;
}

export async function compileGovernedMission(candidate: unknown, expectedStateVersion: number | null,
  context: GovernedMutationContext) {
  const mission = MissionContractV1Schema.parse(candidate);
  const canonicalHash = governedArtifactIntegrityHash('rorca.mission-contract.integrity.v1', mission, ['contentHash', 'missionHash']);
  if (mission.contentHash !== canonicalHash || mission.missionHash !== canonicalHash) {
    throw new UnprocessableError('Mission content and mission hashes must match canonical contract bytes', 'CANONICAL_HASH_MISMATCH', { canonicalHash });
  }
  return runIdempotentMutation({
    workspaceId: mission.workspaceId, operation: 'mission.compile', ...context, request: { mission, expectedStateVersion },
    subject: { missionId: mission.missionId, revision: mission.missionRevision, hash: mission.missionHash },
    mutate: async (client) => {
      const canonicalSpec = await client.query(`SELECT 1 FROM governed_spec_authority_snapshots
        WHERE workspace_id=$1 AND spec_id=$2 AND spec_version=$3 AND spec_hash=$4 AND canonical_spec_path=$5
          AND repository_id=$6 AND repository_sha=$7 AND lifecycle_state='approved'`,
      [mission.workspaceId, mission.canonicalSpec.specId, mission.canonicalSpec.specVersion, mission.canonicalSpec.specHash,
        mission.canonicalSpec.canonicalSpecPath, mission.repository.repositoryId, mission.repository.baseSha]);
      if (!canonicalSpec.rows[0]) throw new UnprocessableError('Mission canonical spec/repository authority is absent or mismatched', 'CANONICAL_SPEC_AUTHORITY_MISSING');
      const exactReferences = await client.query<{ reference_kind: string; maximum_authority_ceiling: string | null;
        sequential_only: boolean | null; branch_only: boolean | null; auto_merge_allowed: boolean | null;
        deployment_allowed: boolean | null; provider_mutation_allowed: boolean | null }>(`WITH requested(reference_kind,reference_id,reference_revision,reference_hash) AS (VALUES
          ('compiler'::text,$2::text,$3::bigint,$4::text),
          ('mission_policy'::text,$5::text,$6::bigint,$7::text),
          ('context_policy_definition'::text,$8::text,$9::bigint,$10::text))
        SELECT authority.reference_kind,authority.maximum_authority_ceiling,authority.sequential_only,authority.branch_only,
               authority.auto_merge_allowed,authority.deployment_allowed,authority.provider_mutation_allowed
          FROM requested JOIN governed_exact_revision_authority_snapshots authority USING(reference_kind,reference_id,reference_revision,reference_hash)
         WHERE authority.workspace_id=$1 AND authority.lifecycle_state='accepted'`,
      [mission.workspaceId, mission.compiler.id, mission.compiler.revision, mission.compiler.hash,
        mission.policy.id, mission.policy.revision, mission.policy.hash, mission.contextPolicyDefinition.id,
        mission.contextPolicyDefinition.revision, mission.contextPolicyDefinition.hash]);
      if (new Set(exactReferences.rows.map((row) => row.reference_kind)).size !== 3) {
        throw new UnprocessableError('Mission compiler or policy exact revision authority is absent or mismatched', 'EXACT_REVISION_AUTHORITY_MISSING');
      }
      const policyAuthority = exactReferences.rows.find((row) => row.reference_kind === 'mission_policy')!;
      const ceilingRank = ['none', 'observe', 'propose', 'execute_bounded'];
      if (ceilingRank.indexOf(mission.allowedExecutionPosture.execution) > ceilingRank.indexOf(policyAuthority.maximum_authority_ceiling ?? 'none')
        || (policyAuthority.sequential_only && !mission.allowedExecutionPosture.sequential)
        || (policyAuthority.branch_only && !mission.allowedExecutionPosture.branchOnly)
        || (!policyAuthority.auto_merge_allowed && mission.allowedExecutionPosture.autoMerge)
        || (!policyAuthority.deployment_allowed && mission.allowedExecutionPosture.deployment)
        || (!policyAuthority.provider_mutation_allowed && mission.allowedExecutionPosture.providerMutation)) {
        throw new UnprocessableError('Mission execution posture exceeds canonical policy authority', 'MISSION_AUTHORITY_CEILING_EXCEEDED');
      }
      const repository = await client.query(`SELECT 1 FROM governed_repository_authority_snapshots
        WHERE workspace_id=$1 AND repository_id=$2 AND remote_authority_hash=$3 AND git_object_format=$4
          AND base_sha=$5 AND current_sha=$6 AND expected_head_sha=$7 AND worktree_id=$8
          AND allowed_path_manifest_hash=$9 AND required_path_manifest_hash=$10
          AND changed_path_manifest_hash=$11 AND forbidden_path_manifest_hash=$12`,
      [mission.workspaceId, mission.repository.repositoryId, mission.repository.remoteAuthorityHash, mission.repository.gitObjectFormat,
        mission.repository.baseSha, mission.repository.currentSha, mission.repository.expectedHeadSha, mission.repository.worktreeId,
        mission.repository.allowedPathManifestHash, mission.repository.requiredPathManifestHash,
        mission.repository.changedPathManifestHash, mission.repository.forbiddenPathManifestHash]);
      if (!repository.rows[0]) throw new UnprocessableError('Mission repository authority is absent or mismatched', 'REPOSITORY_AUTHORITY_MISSING');
      const manifests = await client.query<{ manifest_kind: string }>(`WITH requested(manifest_kind,manifest_hash) AS (VALUES
          ('allowed'::text,$4::text),('required'::text,$5::text),('changed'::text,$6::text),('forbidden'::text,$7::text))
        SELECT manifest.manifest_kind FROM requested JOIN governed_path_manifest_snapshots manifest USING(manifest_kind,manifest_hash)
         WHERE manifest.workspace_id=$1 AND manifest.repository_id=$2 AND manifest.base_sha=$3`,
      [mission.workspaceId, mission.repository.repositoryId, mission.repository.baseSha, mission.repository.allowedPathManifestHash,
        mission.repository.requiredPathManifestHash, mission.repository.changedPathManifestHash, mission.repository.forbiddenPathManifestHash]);
      if (new Set(manifests.rows.map((row) => row.manifest_kind)).size !== 4) {
        throw new UnprocessableError('Mission path-manifest authority is absent or mismatched', 'PATH_MANIFEST_AUTHORITY_MISSING');
      }
      const decisions = await client.query<{ decision_ref: string }>(`SELECT decision_ref FROM governed_decision_authority_snapshots
        WHERE workspace_id=$1 AND decision_ref=ANY($2::text[]) AND decision_state='accepted'`,
      [mission.workspaceId, mission.approvedDecisionReferences]);
      if (new Set(decisions.rows.map((row) => row.decision_ref)).size !== mission.approvedDecisionReferences.length) {
        throw new UnprocessableError('Mission approved-decision authority is absent or mismatched', 'APPROVED_DECISION_AUTHORITY_MISSING');
      }
      await client.query(`INSERT INTO governed_missions(workspace_id,mission_id,created_by)
        SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM governed_missions WHERE workspace_id=$1 AND mission_id=$2)`,
      [mission.workspaceId, mission.missionId, context.principalId]);
      const head = await client.query<{ current_revision: number; current_hash: string; state_version: string }>(
        `SELECT current_revision,current_hash,state_version FROM governed_mission_heads
         WHERE workspace_id=$1 AND mission_id=$2 FOR UPDATE`, [mission.workspaceId, mission.missionId]);
      const existing = await client.query<{ mission_hash: string }>(
        `SELECT mission_hash FROM governed_mission_versions WHERE workspace_id=$1 AND mission_id=$2 AND mission_revision=$3`,
        [mission.workspaceId, mission.missionId, mission.missionRevision],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].mission_hash !== mission.missionHash) throw new ConflictError('Mission revision already exists with changed hash', { reason: 'revision_conflict' });
        return { missionId: mission.missionId, revision: mission.missionRevision, hash: mission.missionHash };
      }
      if (!head.rows[0] && mission.missionRevision !== 1) throw new ConflictError('First mission revision must be one', { reason: 'revision_conflict' });
      if (head.rows[0] && (expectedStateVersion === null || Number(head.rows[0].state_version) !== expectedStateVersion
        || mission.missionRevision !== head.rows[0].current_revision + 1)) throw new ConflictError('Mission revision/head CAS is stale', { reason: 'stale_revision' });
      await client.query(
        `INSERT INTO governed_mission_versions
          (workspace_id,mission_id,mission_revision,mission_hash,contract_version,canonical_spec_id,canonical_spec_version,
           canonical_spec_hash,canonical_spec_path,repository_id,base_sha,payload_json,payload_hash,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
        [mission.workspaceId, mission.missionId, mission.missionRevision, mission.missionHash, mission.contractVersion,
          mission.canonicalSpec.specId, mission.canonicalSpec.specVersion, mission.canonicalSpec.specHash,
          mission.canonicalSpec.canonicalSpecPath, mission.repository.repositoryId, mission.repository.baseSha,
          asJson(mission), mission.contentHash, context.principalId],
      );
      if (head.rows[0]) {
        const updated = await client.query(`UPDATE governed_mission_heads SET current_revision=$3,current_hash=$4,
          lifecycle_state='compiled',state_version=state_version+1,updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND mission_id=$2 AND state_version=$5`, [mission.workspaceId, mission.missionId,
          mission.missionRevision, mission.missionHash, expectedStateVersion]);
        if (updated.rowCount !== 1) throw new ConflictError('Mission head CAS lost', { reason: 'stale_revision' });
      } else await client.query(
        `INSERT INTO governed_mission_heads(workspace_id,mission_id,current_revision,current_hash,lifecycle_state)
         VALUES($1,$2,$3,$4,'compiled')`, [mission.workspaceId, mission.missionId, mission.missionRevision, mission.missionHash]);
      return { missionId: mission.missionId, revision: mission.missionRevision, hash: mission.missionHash };
    },
  });
}

export async function createWorkPackageRevision(candidate: unknown, expectedStateVersion: number | null, context: GovernedMutationContext) {
  const value = WorkPackageV1Schema.parse(candidate);
  const canonicalHash = governedArtifactIntegrityHash('rorca.work-package.integrity.v1', value, ['contentHash', 'workPackageHash']);
  if (value.contentHash !== canonicalHash || value.workPackageHash !== canonicalHash) {
    throw new UnprocessableError('Work-package content and identity hashes must match canonical bytes', 'CANONICAL_HASH_MISMATCH', { canonicalHash });
  }
  return runIdempotentMutation({
    workspaceId: value.workspaceId, operation: 'work-package.revise', ...context, request: { value, expectedStateVersion },
    subject: { missionId: value.missionId, workPackageId: value.workPackageId, revision: value.workPackageRevision },
    mutate: async (client) => {
      const missionHead = await client.query<{ current_revision: number; current_hash: string; lifecycle_state: string; payload_json: unknown }>(
        `SELECT head.current_revision,head.current_hash,head.lifecycle_state,version.payload_json
           FROM governed_mission_heads head JOIN governed_mission_versions version
             ON version.workspace_id=head.workspace_id AND version.mission_id=head.mission_id
            AND version.mission_revision=head.current_revision
          WHERE head.workspace_id=$1 AND head.mission_id=$2 FOR UPDATE OF head FOR KEY SHARE OF version`, [value.workspaceId, value.missionId]);
      if (!missionHead.rows[0] || missionHead.rows[0].current_revision !== value.missionRevision
        || missionHead.rows[0].current_hash !== value.missionHash || !['compiled', 'active'].includes(missionHead.rows[0].lifecycle_state)) {
        throw new ConflictError('Work package must bind the exact current mission head', { reason: 'stale_revision' });
      }
      const mission = MissionContractV1Schema.parse(missionHead.rows[0].payload_json);
      if (stableHash('rorca.work-package-spec-subset.v1', value.spec) !== stableHash('rorca.work-package-spec-subset.v1', mission.canonicalSpec)
        || value.repository.repositoryId !== mission.repository.repositoryId
        || value.repository.remoteAuthorityHash !== mission.repository.remoteAuthorityHash
        || value.repository.gitObjectFormat !== mission.repository.gitObjectFormat
        || value.repository.baseSha !== mission.repository.baseSha
        || value.repository.currentSha !== mission.repository.currentSha
        || value.repository.expectedHeadSha !== mission.repository.expectedHeadSha
        || value.repository.worktreeId !== mission.repository.worktreeId) {
        throw new UnprocessableError('Work package spec or repository is not a subset of mission authority', 'WORK_PACKAGE_SCOPE_EXPANSION');
      }
      const requestedManifestHashes = [
        mission.repository.allowedPathManifestHash, mission.repository.requiredPathManifestHash,
        mission.repository.changedPathManifestHash, mission.repository.forbiddenPathManifestHash,
        value.repository.allowedPathManifestHash, value.repository.requiredPathManifestHash,
        value.repository.changedPathManifestHash, value.repository.forbiddenPathManifestHash,
      ];
      const manifests = await client.query<{ manifest_kind: string; manifest_hash: string; paths_json: unknown }>(`SELECT manifest_kind,manifest_hash,paths_json
        FROM governed_path_manifest_snapshots WHERE workspace_id=$1 AND repository_id=$2 AND base_sha=$3
          AND manifest_hash=ANY($4::text[])`,
      [value.workspaceId, value.repository.repositoryId, value.repository.baseSha, requestedManifestHashes]);
      const pathSet = (kind: string, hash: string) => {
        const row = manifests.rows.find((item) => item.manifest_kind === kind && item.manifest_hash === hash);
        return row && Array.isArray(row.paths_json) && row.paths_json.every((item) => typeof item === 'string')
          ? new Set(row.paths_json as string[]) : null;
      };
      const missionAllowed = pathSet('allowed', mission.repository.allowedPathManifestHash);
      const missionRequired = pathSet('required', mission.repository.requiredPathManifestHash);
      const missionChanged = pathSet('changed', mission.repository.changedPathManifestHash);
      const missionForbidden = pathSet('forbidden', mission.repository.forbiddenPathManifestHash);
      const packageAllowed = pathSet('allowed', value.repository.allowedPathManifestHash);
      const packageRequired = pathSet('required', value.repository.requiredPathManifestHash);
      const packageChanged = pathSet('changed', value.repository.changedPathManifestHash);
      const packageForbidden = pathSet('forbidden', value.repository.forbiddenPathManifestHash);
      const sorted = (items: Set<string>) => [...items].sort();
      if (!missionAllowed || !missionRequired || !missionChanged || !missionForbidden
        || !packageAllowed || !packageRequired || !packageChanged || !packageForbidden
        || stableHash('rorca.path-manifest-members.v1', sorted(packageAllowed)) !== stableHash('rorca.path-manifest-members.v1', [...value.allowedPaths].sort())
        || stableHash('rorca.path-manifest-members.v1', sorted(packageRequired)) !== stableHash('rorca.path-manifest-members.v1', [...value.requiredPaths].sort())
        || sorted(packageAllowed).some((item) => !missionAllowed.has(item))
        || sorted(missionRequired).some((item) => !packageRequired.has(item))
        || sorted(packageRequired).some((item) => !packageAllowed.has(item))
        || sorted(packageChanged).some((item) => !missionChanged.has(item) || !packageAllowed.has(item) || packageForbidden.has(item))
        || sorted(missionForbidden).some((item) => !packageForbidden.has(item))) {
        throw new UnprocessableError('Work-package path manifests are unresolved or expand mission scope', 'WORK_PACKAGE_PATH_SCOPE_EXPANSION');
      }
      const ceilingRank = ['none', 'observe', 'propose', 'execute_bounded'] as const;
      const ceilingAtMost = (actual: typeof value.authorityCeilings.delivery, maximum: typeof value.authorityCeilings.delivery) =>
        ceilingRank.indexOf(actual) <= ceilingRank.indexOf(maximum);
      const categoryMaximum = maximumWorkPackageAuthorityCeilings(mission.allowedExecutionPosture);
      if (!ceilingAtMost(value.authorityCeilings.delivery, categoryMaximum.delivery)
        || !ceilingAtMost(value.authorityCeilings.operational, categoryMaximum.operational)
        || !ceilingAtMost(value.authorityCeilings.knowledge, categoryMaximum.knowledge)
        || !ceilingAtMost(value.authorityCeilings.interactive, categoryMaximum.interactive)
        || value.executionPostureHash !== stableHash('rorca.mission-execution-posture.v1', mission.allowedExecutionPosture)) {
        throw new UnprocessableError('Work-package posture or authority ceiling exceeds the mission categorical authority', 'WORK_PACKAGE_AUTHORITY_CEILING_EXCEEDED');
      }
      const obligationSet = await client.query<{ obligation_set_id: string; obligation_policy_id: string; obligation_policy_revision: string;
        obligation_policy_hash: string; manifest_hash: string; manifest_json: unknown }>(`SELECT obligation_set_id,obligation_policy_id,
          obligation_policy_revision,obligation_policy_hash,manifest_hash,manifest_json
        FROM governed_evidence_obligation_sets WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3
          AND work_package_revision=$4 AND manifest_hash=$5`,
      [value.workspaceId,value.missionId,value.workPackageId,value.workPackageRevision,value.evidenceObligationsHash]);
      const obligations = obligationSet.rows[0];
      if (!obligations || obligations.obligation_policy_id !== mission.policy.id
        || Number(obligations.obligation_policy_revision) !== mission.policy.revision
        || obligations.obligation_policy_hash !== mission.policy.hash
        || !Array.isArray(obligations.manifest_json)
        || stableHash('rorca.evidence-obligation-manifest.v1', obligations.manifest_json) !== obligations.manifest_hash) {
        throw new UnprocessableError('Work-package evidence obligation set is absent, substituted, or policy-mismatched', 'EVIDENCE_OBLIGATION_SET_INVALID');
      }
      const obligationRows = await client.query<{ obligation_order: number; obligation_kind: string; minimum_trust: string;
        required_status: string; obligation_hash: string }>(`SELECT obligation_order,obligation_kind,minimum_trust,required_status,obligation_hash
        FROM governed_evidence_obligations WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3
          AND work_package_revision=$4 AND obligation_set_id=$5 ORDER BY obligation_order`,
      [value.workspaceId,value.missionId,value.workPackageId,value.workPackageRevision,obligations.obligation_set_id]);
      const canonicalObligationManifest = obligationRows.rows.map((row) => ({ kind: row.obligation_kind, minimumTrust: row.minimum_trust,
        requiredStatus: row.required_status, obligationHash: row.obligation_hash }));
      if (stableHash('rorca.evidence-obligation-manifest.v1', canonicalObligationManifest) !== obligations.manifest_hash
        || stableHash('rorca.evidence-obligation-manifest.v1', obligations.manifest_json) !== obligations.manifest_hash) {
        throw new UnprocessableError('Evidence obligation rows do not match the immutable set manifest', 'EVIDENCE_OBLIGATION_MANIFEST_MISMATCH');
      }
      await client.query(`INSERT INTO governed_work_packages(workspace_id,mission_id,work_package_id,created_by)
        SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM governed_work_packages
          WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3)`,
      [value.workspaceId, value.missionId, value.workPackageId, context.principalId]);
      const head = await client.query<{ current_revision: number; state_version: string }>(
        `SELECT current_revision,state_version FROM governed_work_package_heads
         WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3 FOR UPDATE`,
        [value.workspaceId, value.missionId, value.workPackageId],
      );
      if (head.rows[0]) {
        if (expectedStateVersion === null || Number(head.rows[0].state_version) !== expectedStateVersion) throw new ConflictError('Stale work-package state version', { reason: 'stale_revision' });
        if (value.workPackageRevision !== head.rows[0].current_revision + 1) throw new ConflictError('Work-package revision must increment current head', { reason: 'revision_conflict' });
      } else if (value.workPackageRevision !== 1) throw new ConflictError('First work-package revision must be one', { reason: 'revision_conflict' });
      if (head.rows[0]) {
        const proposal = await client.query<{ base_revision: number; base_hash: string; diff_hash: string; requested_paths_hash: string;
          dependencies_hash: string; validation_hash: string; current_state: string; review_hash: string }>(`SELECT proposal.base_revision,
            proposal.base_hash,proposal.diff_hash,proposal.requested_paths_hash,proposal.dependencies_hash,proposal.validation_hash,
            head.current_state,review.review_hash
          FROM plan_change_proposals proposal JOIN plan_change_proposal_heads head
            ON head.workspace_id=proposal.workspace_id AND head.proposal_id=proposal.proposal_id
          JOIN LATERAL (SELECT review_hash FROM plan_change_proposal_reviews
            WHERE workspace_id=proposal.workspace_id AND proposal_id=proposal.proposal_id AND next_state='accepted'
            ORDER BY review_sequence DESC LIMIT 1) review ON TRUE
          WHERE proposal.workspace_id=$1 AND proposal.proposal_id=$2 FOR KEY SHARE OF proposal,head`,
        [value.workspaceId,value.proposalId]);
        const accepted = proposal.rows[0];
        const dependencyManifestHash = stableHash('rorca.work-package-dependencies.v1', value.dependencies);
        const requestedPathsHash = stableHash('rorca.proposal-paths.v1', value.allowedPaths);
        const expectedDiffHash = stableHash('rorca.work-package-revision-diff.v1', { baseRevision: head.rows[0].current_revision,
          targetRevision: value.workPackageRevision, baseHash: accepted?.base_hash, targetHash: value.workPackageHash,
          requestedPathsHash, dependencyManifestHash, validationHash: value.validationObligationsHash });
        if (!accepted || accepted.current_state !== 'accepted' || accepted.base_revision !== head.rows[0].current_revision
          || accepted.base_hash !== (await client.query<{ current_hash: string }>(`SELECT current_hash FROM governed_work_package_heads
            WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3`,[value.workspaceId,value.missionId,value.workPackageId])).rows[0]?.current_hash
          || accepted.requested_paths_hash !== requestedPathsHash || accepted.dependencies_hash !== dependencyManifestHash
          || accepted.validation_hash !== value.validationObligationsHash || accepted.diff_hash !== expectedDiffHash) {
          throw new UnprocessableError('Work-package revision lacks an exact accepted prior-head proposal receipt', 'WORK_PACKAGE_PROPOSAL_AUTHORITY_INVALID');
        }
      }
      await client.query(
        `INSERT INTO governed_work_package_revisions
          (workspace_id,mission_id,work_package_id,work_package_revision,work_package_hash,mission_revision,mission_hash,
           story_id,repository_id,base_sha,allowed_path_manifest_hash,required_path_manifest_hash,validation_manifest_hash,
           authority_ceiling_hash,payload_json,proposal_id,evidence_obligation_set_id,evidence_obligation_policy_id,
           evidence_obligation_policy_revision,evidence_obligation_policy_hash,evidence_obligation_manifest_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21)`,
        [value.workspaceId, value.missionId, value.workPackageId, value.workPackageRevision, value.workPackageHash,
          value.missionRevision, value.missionHash, value.spec.storyId, value.repository.repositoryId, value.repository.baseSha,
          value.repository.allowedPathManifestHash, value.repository.requiredPathManifestHash, value.validationObligationsHash,
          stableHash('rorca.work-package-authority-ceiling.v1', value.authorityCeilings), asJson(value), value.proposalId,
          obligations.obligation_set_id,obligations.obligation_policy_id,Number(obligations.obligation_policy_revision),
          obligations.obligation_policy_hash,obligations.manifest_hash],
      );
      for (let index = 0; index < value.dependencies.length; index += 1) {
        const dependency = value.dependencies[index];
        const insertedDependency = await client.query(
          `INSERT INTO governed_work_package_dependencies
            (workspace_id,mission_id,work_package_id,work_package_revision,dependency_order,dependency_work_package_id,dependency_revision,dependency_hash)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8
            WHERE EXISTS(SELECT 1 FROM governed_work_package_revisions dependency
              WHERE dependency.workspace_id=$1 AND dependency.mission_id=$2 AND dependency.work_package_id=$6
                AND dependency.work_package_revision=$7 AND dependency.work_package_hash=$8)`,
          [value.workspaceId, value.missionId, value.workPackageId, value.workPackageRevision, index, dependency.workPackageId, dependency.revision, dependency.hash],
        );
        if (insertedDependency.rowCount !== 1) throw new UnprocessableError('Work-package dependency hash is absent or mismatched', 'DEPENDENCY_AUTHORITY_MISMATCH');
      }
      if (head.rows[0]) {
        const updated = await client.query(
          `UPDATE governed_work_package_heads SET current_revision=$4,current_hash=$5,lifecycle_state=$6,
             state_version=state_version+1,updated_at=clock_timestamp()
           WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3 AND state_version=$7`,
          [value.workspaceId, value.missionId, value.workPackageId, value.workPackageRevision, value.workPackageHash,
            value.state, expectedStateVersion],
        );
        if (updated.rowCount !== 1) throw new ConflictError('Work-package CAS lost', { reason: 'stale_revision' });
      } else {
        await client.query(`INSERT INTO governed_work_package_heads
          (workspace_id,mission_id,work_package_id,current_revision,current_hash,lifecycle_state)
          VALUES($1,$2,$3,$4,$5,$6)`, [value.workspaceId, value.missionId, value.workPackageId, value.workPackageRevision, value.workPackageHash, value.state]);
      }
      return { workPackageId: value.workPackageId, revision: value.workPackageRevision, hash: value.workPackageHash };
    },
  });
}

export async function acquireExecutionLease(candidate: unknown, context: GovernedMutationContext) {
  const lease = ExecutionLeaseV1Schema.parse(candidate);
  if (lease.state !== 'proposed') throw new ValidationError('Lease acquisition requires proposed input state');
  const slotKey = stableHash('rorca.execution-lease-slot.v1', {
    workspaceId: lease.workspaceId, missionId: lease.missionId, workPackageId: lease.workPackageId,
    storyId: lease.spec.storyId, attemptId: lease.attemptId,
  });
  return runIdempotentMutation({
    workspaceId: lease.workspaceId, operation: 'lease.acquire', ...context, request: lease,
    subject: { slotKey, leaseId: lease.leaseId, attemptId: lease.attemptId },
    mutate: async (client) => {
      const attempt = await client.query<{ mission_id: string; work_package_id: string; work_package_revision: number; story_id: string;
        runtime_id: string; repository_id: string; worktree_id: string; work_package_hash: string; mission_revision: number;
        mission_hash: string; spec_id: string; spec_version: number; spec_hash: string; story_version: number; story_hash: string;
        criteria_manifest_hash: string; base_sha: string; current_sha: string; expected_head_sha: string;
        allowed_path_manifest_hash: string; required_path_manifest_hash: string; changed_path_manifest_hash: string;
        forbidden_path_manifest_hash: string }>(
        `SELECT a.mission_id,a.work_package_id,a.work_package_revision,a.story_id,a.runtime_id,a.repository_id,a.worktree_id,
                a.spec_id,a.spec_version,a.spec_hash,a.story_version,a.story_hash,a.criteria_manifest_hash,
                a.base_sha,a.current_sha,a.expected_head_sha,a.allowed_path_manifest_hash,a.required_path_manifest_hash,
                a.changed_path_manifest_hash,a.forbidden_path_manifest_hash,w.work_package_hash,w.mission_revision,w.mission_hash
         FROM governed_execution_attempts a JOIN governed_work_package_revisions w
           ON w.workspace_id=a.workspace_id AND w.mission_id=a.mission_id AND w.work_package_id=a.work_package_id
          AND w.work_package_revision=a.work_package_revision
         WHERE a.workspace_id=$1 AND a.attempt_id=$2 FOR KEY SHARE OF w`, [lease.workspaceId, lease.attemptId]);
      const exact = attempt.rows[0];
      if (!exact || exact.mission_id !== lease.missionId || exact.work_package_id !== lease.workPackageId
        || exact.work_package_revision !== lease.workPackageRevision || exact.story_id !== lease.spec.storyId
        || exact.runtime_id !== lease.runtimeId || exact.repository_id !== lease.repository.repositoryId
        || exact.worktree_id !== lease.repository.worktreeId || exact.work_package_hash !== lease.workPackageHash
        || exact.mission_revision !== lease.missionRevision || exact.mission_hash !== lease.missionHash
        || exact.spec_id !== lease.spec.specId || exact.spec_version !== lease.spec.specVersion || exact.spec_hash !== lease.spec.specHash
        || exact.story_version !== lease.spec.storyVersion || exact.story_hash !== lease.spec.storyHash
        || exact.criteria_manifest_hash !== lease.spec.criteriaManifestHash || exact.base_sha !== lease.repository.baseSha
        || exact.current_sha !== lease.repository.currentSha || exact.expected_head_sha !== lease.repository.expectedHeadSha
        || exact.allowed_path_manifest_hash !== lease.repository.allowedPathManifestHash
        || exact.required_path_manifest_hash !== lease.repository.requiredPathManifestHash
        || exact.changed_path_manifest_hash !== lease.repository.changedPathManifestHash
        || exact.forbidden_path_manifest_hash !== lease.repository.forbiddenPathManifestHash) {
        throw new ConflictError('Lease attempt subject or runtime substitution mismatch', { reason: 'identity_conflict' });
      }
      await client.query(`INSERT INTO execution_lease_slots(workspace_id,lease_slot_key)
        SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM execution_lease_slots WHERE workspace_id=$1 AND lease_slot_key=$2)`,
      [lease.workspaceId, slotKey]);
      const slot = await client.query<{ last_fence: string; active_lease_id: string | null }>(
        `SELECT last_fence,active_lease_id FROM execution_lease_slots WHERE workspace_id=$1 AND lease_slot_key=$2 FOR UPDATE`, [lease.workspaceId, slotKey],
      );
      const dbTime = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time');
      const observed = dbTime.rows[0]!.db_time;
      const fence = Number(slot.rows[0]!.last_fence) + 1;
      if (lease.fencingToken !== fence) throw new ConflictError('Lease acquisition fence differs from the database-issued next fence',{reason:'stale_fence'});
      if (slot.rows[0]!.active_lease_id) {
        const active = await client.query<{ lease_id: string; payload_hash: string; expires_at: Date; state: string }>(
          `SELECT lease_id,payload_hash,expires_at,state FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`,
          [lease.workspaceId, slot.rows[0]!.active_lease_id],
        );
        if (active.rows[0]?.state === 'active' && active.rows[0].expires_at.getTime() > observed.getTime()) {
          throw new ConflictError('An active lease already owns this execution slot', { reason: 'lease_conflict' });
        }
        if (active.rows[0]?.state === 'active') await client.query(`UPDATE execution_leases SET state='expired',state_version=state_version+1 WHERE workspace_id=$1 AND lease_id=$2 AND state='active'`, [lease.workspaceId, active.rows[0].lease_id]);
      }
      const requestedSeconds = Math.max(1, Math.min(MAX_LEASE_SECONDS, Math.floor((Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt)) / 1000)));
      const expiresAt = new Date(observed.getTime() + requestedSeconds * 1000);
      const effectiveLease={...lease,fencingToken:fence,state:'active' as const,issuedAt:observed.toISOString(),observedAt:observed.toISOString(),expiresAt:expiresAt.toISOString()};
      const leasePayloadHash=stableHash('rorca.execution-lease-payload.v1',effectiveLease);
      const activePolicy = await client.query<{ scope_key: string; activation_id: string; current_revision: number;
        activation_hash: string; definition_id: string; definition_version: string; definition_hash: string; scope_json: unknown }>(
        `SELECT h.scope_key,h.activation_id,h.current_revision,a.activation_hash,a.policy_definition_id definition_id,
                a.policy_definition_version definition_version,d.policy_definition_hash definition_hash,a.scope_json
         FROM context_policy_activation_heads h JOIN context_policy_activations a
          ON a.workspace_id=h.workspace_id AND a.activation_id=h.activation_id AND a.activation_revision=h.current_revision
         JOIN context_policy_definitions d ON d.workspace_id=a.workspace_id AND d.policy_definition_id=a.policy_definition_id
          AND d.policy_definition_version=a.policy_definition_version
         WHERE h.workspace_id=$1 AND h.current_hash=$2 AND h.effective_state='active' AND a.state='active'
          AND d.lifecycle_state='published' AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp()) FOR KEY SHARE OF h,a,d`,
      [lease.workspaceId, lease.policyActivationHash]);
      const expectedActivationScope = ActivationScopeSchema.parse({
        workspaceId: lease.workspaceId, missionId: lease.missionId, missionRevision: lease.missionRevision,
        missionHash: lease.missionHash, workPackageId: lease.workPackageId, workPackageRevision: lease.workPackageRevision,
        workPackageHash: lease.workPackageHash, spec: lease.spec, runId: lease.runId, attemptId: lease.attemptId,
        leaseId: lease.leaseId, fencingToken: fence, cancellationId: lease.cancellationId, runtimeId: lease.runtimeId,
        repositoryId: lease.repository.repositoryId, remoteAuthorityHash: lease.repository.remoteAuthorityHash,
        baseSha: lease.repository.baseSha, worktreeId: lease.repository.worktreeId,
        allowedPathManifestHash: lease.repository.allowedPathManifestHash,
        requiredPathManifestHash: lease.repository.requiredPathManifestHash,
        policyDefinitionId: lease.policyDefinitionId, policyDefinitionVersion: lease.policyDefinitionVersion,
        policyDefinitionHash: lease.policyDefinitionHash,
      });
      const policy = activePolicy.rows[0];
      const actualScope = policy ? ActivationScopeSchema.safeParse(policy.scope_json) : null;
      if (!policy || policy.activation_id !== lease.policyActivationId || policy.current_revision !== lease.policyActivationRevision
        || policy.activation_hash !== lease.policyActivationHash || policy.definition_id !== lease.policyDefinitionId
        || policy.definition_version !== lease.policyDefinitionVersion || policy.definition_hash !== lease.policyDefinitionHash
        || !actualScope?.success || stableHash('rorca.context-policy-activation-scope.v1', actualScope.data) !== policy.scope_key
        || stableHash('rorca.context-policy-activation-scope.v1', expectedActivationScope) !== policy.scope_key) {
        throw new UnprocessableError('Lease policy activation does not match the exact canonical scope', 'POLICY_ACTIVATION_SCOPE_MISMATCH');
      }
      await client.query(`UPDATE execution_lease_slots SET last_fence=$3,active_lease_id=$4,state_version=state_version+1,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND lease_slot_key=$2`, [lease.workspaceId, slotKey, fence, lease.leaseId]);
      await client.query(
        `INSERT INTO execution_leases
          (workspace_id,lease_id,lease_slot_key,attempt_id,fencing_token,work_package_revision,runtime_id,repository_id,base_sha,current_sha,
           worktree_id,policy_definition_hash,policy_activation_hash,checkpoint_hash,bundle_hash,cancellation_id,issued_at,expires_at,state,payload_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'active',$19)`,
        [lease.workspaceId, lease.leaseId, slotKey, lease.attemptId, fence, lease.workPackageRevision, lease.runtimeId,
          lease.repository.repositoryId, lease.repository.baseSha, lease.repository.currentSha, lease.repository.worktreeId,
          lease.policyDefinitionHash, lease.policyActivationHash, lease.checkpointHash, lease.bundleHash, lease.cancellationId,
          observed, expiresAt, leasePayloadHash],
      );
      await client.query(`INSERT INTO execution_lease_events(workspace_id,lease_id,fencing_token,event_type,next_state,reason_code,event_hash)
        VALUES($1,$2,$3,'acquired','active','issued',$4)`, [lease.workspaceId, lease.leaseId, fence, stableHash('rorca.lease-event.v1', { leaseId: lease.leaseId, fence, type: 'acquired' })]);
      return { leaseId: lease.leaseId, fencingToken: fence, issuedAt: observed.toISOString(), expiresAt: expiresAt.toISOString(), duplicate: false };
    },
  });
}

export async function renewExecutionLease(input: {
  workspaceId: string; leaseId: string; fencingToken: number; runtimeId: string; expectedStateVersion: number; extendSeconds: number;
}, context: GovernedMutationContext) {
  if (!Number.isInteger(input.extendSeconds) || input.extendSeconds < 1 || input.extendSeconds > MAX_LEASE_SECONDS) throw new ValidationError('Lease extension must be 1-3600 seconds');
  return runIdempotentMutation({ workspaceId: input.workspaceId, operation: 'lease.renew', ...context, request: input,
    subject: { leaseId: input.leaseId, fence: input.fencingToken }, mutate: async (client) => {
      const locator = await client.query<{ lease_slot_key: string }>(
        `SELECT lease_slot_key FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2`, [input.workspaceId, input.leaseId]);
      if (!locator.rows[0]) throw new NotFoundError('Execution lease', input.leaseId);
      await client.query(`SELECT 1 FROM execution_lease_slots WHERE workspace_id=$1 AND lease_slot_key=$2 FOR UPDATE`,
        [input.workspaceId, locator.rows[0].lease_slot_key]);
      const lease = await client.query<{ lease_slot_key: string; state: string; expires_at: Date; state_version: string; runtime_id: string; fencing_token: string }>(
        `SELECT lease_slot_key,state,expires_at,state_version,runtime_id,fencing_token FROM execution_leases
         WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`, [input.workspaceId, input.leaseId]);
      if (!lease.rows[0]) throw new NotFoundError('Execution lease', input.leaseId);
      const time = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time'); const dbTime = time.rows[0]!.db_time;
      if (lease.rows[0].state !== 'active' || lease.rows[0].expires_at.getTime() <= dbTime.getTime()) throw new UnprocessableError('Lease is expired or inactive', 'LEASE_EXPIRED');
      if (Number(lease.rows[0].fencing_token) !== input.fencingToken || lease.rows[0].runtime_id !== input.runtimeId) throw new ConflictError('Stale fence or runtime substitution', { reason: 'stale_fence' });
      if (Number(lease.rows[0].state_version) !== input.expectedStateVersion) throw new ConflictError('Stale lease state version', { reason: 'stale_revision' });
      const activation = await client.query(`SELECT 1 FROM context_policy_activation_heads h JOIN execution_leases l
        ON l.workspace_id=h.workspace_id AND l.policy_activation_hash=h.current_hash
        WHERE l.workspace_id=$1 AND l.lease_id=$2 AND h.effective_state='active' FOR KEY SHARE OF h`, [input.workspaceId, input.leaseId]);
      if (!activation.rows[0]) throw new UnprocessableError('Policy activation is no longer active', 'POLICY_ACTIVATION_INACTIVE');
      const expiresAt = new Date(dbTime.getTime() + input.extendSeconds * 1000);
      const updated = await client.query(`UPDATE execution_leases SET expires_at=$4,state_version=state_version+1
        WHERE workspace_id=$1 AND lease_id=$2 AND state_version=$3 AND state='active'`, [input.workspaceId, input.leaseId, input.expectedStateVersion, expiresAt]);
      if (updated.rowCount !== 1) throw new ConflictError('Lease renewal CAS lost', { reason: 'stale_revision' });
      await client.query(`INSERT INTO execution_lease_events(workspace_id,lease_id,fencing_token,event_type,prior_state,next_state,reason_code,event_hash)
        VALUES($1,$2,$3,'renewed','active','active','renewed',$4)`, [input.workspaceId, input.leaseId, input.fencingToken, stableHash('rorca.lease-event.v1', { leaseId: input.leaseId, fence: input.fencingToken, type: 'renewed', expiresAt: expiresAt.toISOString() })]);
      return { leaseId: input.leaseId, fencingToken: input.fencingToken, expiresAt: expiresAt.toISOString(), stateVersion: input.expectedStateVersion + 1 };
    } });
}

export async function releaseExecutionLease(input: {
  workspaceId: string; leaseId: string; fencingToken: number; runtimeId: string; expectedStateVersion: number; reasonCode: string;
}, context: GovernedMutationContext) {
  return runIdempotentMutation({ workspaceId: input.workspaceId, operation: 'lease.release', ...context, request: input,
    subject: { leaseId: input.leaseId, fence: input.fencingToken }, mutate: async (client) => {
      const locator = await client.query<{ lease_slot_key: string }>(`SELECT lease_slot_key FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2`,
        [input.workspaceId, input.leaseId]);
      if (!locator.rows[0]) throw new NotFoundError('Execution lease', input.leaseId);
      await client.query(`SELECT 1 FROM execution_lease_slots WHERE workspace_id=$1 AND lease_slot_key=$2 FOR UPDATE`,
        [input.workspaceId, locator.rows[0].lease_slot_key]);
      const lease = await client.query<{ state: string; state_version: string; fencing_token: string; runtime_id: string }>(
        `SELECT state,state_version,fencing_token,runtime_id FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`,
        [input.workspaceId, input.leaseId]);
      if (lease.rows[0]!.state !== 'active') throw new ConflictError('Lease is already inactive', { reason: 'lease_inactive' });
      if (Number(lease.rows[0]!.fencing_token) !== input.fencingToken || lease.rows[0]!.runtime_id !== input.runtimeId) throw new ConflictError('Release fence or runtime mismatch', { reason: 'stale_fence' });
      if (Number(lease.rows[0]!.state_version) !== input.expectedStateVersion) throw new ConflictError('Release state version is stale', { reason: 'stale_revision' });
      const activation = await client.query(`SELECT 1 FROM context_policy_activation_heads h JOIN execution_leases l
        ON l.workspace_id=h.workspace_id AND l.policy_activation_hash=h.current_hash
        WHERE l.workspace_id=$1 AND l.lease_id=$2 AND h.effective_state='active' FOR KEY SHARE OF h`,
      [input.workspaceId, input.leaseId]);
      if (!activation.rows[0]) throw new UnprocessableError('Policy activation is no longer active', 'POLICY_ACTIVATION_INACTIVE');
      const updated = await client.query(`UPDATE execution_leases SET state='released',state_version=state_version+1
        WHERE workspace_id=$1 AND lease_id=$2 AND state='active' AND state_version=$3`, [input.workspaceId, input.leaseId, input.expectedStateVersion]);
      if (updated.rowCount !== 1) throw new ConflictError('Release CAS lost', { reason: 'stale_revision' });
      await client.query(`UPDATE execution_lease_slots SET active_lease_id=NULL,state_version=state_version+1,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND lease_slot_key=$2 AND active_lease_id=$3`, [input.workspaceId, locator.rows[0].lease_slot_key, input.leaseId]);
      await client.query(`INSERT INTO execution_lease_events(workspace_id,lease_id,fencing_token,event_type,prior_state,next_state,reason_code,event_hash)
        VALUES($1,$2,$3,'released','active','released',$4,$5)`, [input.workspaceId, input.leaseId, input.fencingToken,
        input.reasonCode, stableHash('rorca.lease-event.v1', { leaseId: input.leaseId, fence: input.fencingToken, type: 'released', reasonCode: input.reasonCode })]);
      return { leaseId: input.leaseId, state: 'released', stateVersion: input.expectedStateVersion + 1 };
    } });
}

export async function publishContextPolicyDefinition(workspaceId: string, candidate: unknown, authorityReceiptId: string,
  context: GovernedMutationContext) {
  const policy = ContextPolicyDefinitionV1Schema.parse(candidate);
  if (!/^[A-Za-z][A-Za-z0-9._:-]{1,127}$/.test(authorityReceiptId)) throw new ValidationError('Explicit policy authority receipt ID is required');
  if (policy.lifecycleState !== 'published') throw new ValidationError('Policy publication endpoint requires published lifecycle state');
  return runIdempotentMutation({ workspaceId, operation: 'context-policy.publish', ...context, request: { policy, authorityReceiptId },
    subject: { policyDefinitionId: policy.policyDefinitionId, version: policy.policyDefinitionVersion }, mutate: async (client) => {
      const authority = await client.query(`SELECT 1 FROM context_policy_authority_receipts
        WHERE workspace_id=$1 AND authority_receipt_id=$2 AND operation='publish' AND authority_ref=$3
          AND artifact_hash=$4 AND decision_state='accepted'`,
      [workspaceId, authorityReceiptId, policy.issuerAuthorityRef, policy.policyDefinitionHash]);
      if (!authority.rows[0]) throw new UnprocessableError('Policy publication authority receipt is absent or mismatched', 'POLICY_AUTHORITY_RECEIPT_INVALID');
      const existing = await client.query<{ policy_definition_hash: string }>(`SELECT policy_definition_hash FROM context_policy_definitions
        WHERE workspace_id=$1 AND policy_definition_id=$2 AND policy_definition_version=$3`, [workspaceId, policy.policyDefinitionId, policy.policyDefinitionVersion]);
      if (existing.rows[0] && existing.rows[0].policy_definition_hash !== policy.policyDefinitionHash) throw new ConflictError('Policy definition version is immutable', { reason: 'revision_conflict' });
      if (!existing.rows[0]) await client.query(`INSERT INTO context_policy_definitions
        (workspace_id,policy_definition_id,policy_definition_version,policy_definition_hash,lifecycle_state,body_json,issuer_authority_ref,created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [workspaceId, policy.policyDefinitionId, policy.policyDefinitionVersion,
        policy.policyDefinitionHash, policy.lifecycleState, asJson(policy), policy.issuerAuthorityRef, policy.createdAt]);
      return { policyDefinitionId: policy.policyDefinitionId, version: policy.policyDefinitionVersion, hash: policy.policyDefinitionHash };
    } });
}

export async function activateContextPolicy(candidate: unknown, context: GovernedMutationContext) {
  const activation = ContextPolicyActivationV1Schema.parse(candidate);
  const scopeKey = stableHash('rorca.context-policy-activation-scope.v1', activation.scope);
  return runIdempotentMutation({ workspaceId: activation.workspaceId, operation: 'context-policy.activate', ...context,
    request: activation, subject: { activationId: activation.activationId, revision: activation.activationRevision }, mutate: async (client) => {
      const authority = await client.query(`SELECT 1 FROM context_policy_authority_receipts
        WHERE workspace_id=$1 AND authority_receipt_id=$2 AND operation='activate' AND artifact_hash=$3
          AND scope_key=$4 AND decision_state='accepted'`,
      [activation.workspaceId, activation.authorityReceiptId, activation.activationHash, scopeKey]);
      if (!authority.rows[0]) throw new UnprocessableError('Policy activation authority receipt is absent or mismatched', 'POLICY_AUTHORITY_RECEIPT_INVALID');
      const definition = await client.query<{ policy_definition_hash: string; lifecycle_state: string }>(`SELECT policy_definition_hash,lifecycle_state FROM context_policy_definitions
        WHERE workspace_id=$1 AND policy_definition_id=$2 AND policy_definition_version=$3 FOR KEY SHARE`,
      [activation.workspaceId, activation.definitionId, activation.definitionVersion]);
      if (!definition.rows[0] || definition.rows[0].policy_definition_hash !== activation.definitionHash
        || definition.rows[0].lifecycle_state !== 'published') throw new ConflictError('Policy activation definition mismatch', { reason: 'identity_conflict' });
      const existing = await client.query<{ activation_hash: string }>(`SELECT activation_hash FROM context_policy_activations
        WHERE workspace_id=$1 AND activation_id=$2 AND activation_revision=$3`,
      [activation.workspaceId, activation.activationId, activation.activationRevision]);
      if (existing.rows[0]) {
        if (existing.rows[0].activation_hash !== activation.activationHash) throw new ConflictError('Activation revision identity changed', { reason: 'revision_conflict' });
        return { activationId: activation.activationId, revision: activation.activationRevision, hash: activation.activationHash, scopeKey };
      }
      const attempt = await client.query<{ mission_id: string; work_package_id: string; work_package_revision: number; story_id: string;
        runtime_id: string; repository_id: string; worktree_id: string; spec_id: string; spec_version: number; spec_hash: string;
        story_version: number; story_hash: string; criteria_manifest_hash: string; base_sha: string; allowed_path_manifest_hash: string;
        required_path_manifest_hash: string }>(`SELECT mission_id,work_package_id,work_package_revision,story_id,runtime_id,
          repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,criteria_manifest_hash,base_sha,
          allowed_path_manifest_hash,required_path_manifest_hash FROM governed_execution_attempts
        WHERE workspace_id=$1 AND attempt_id=$2`, [activation.workspaceId, activation.scope.attemptId]);
      const bound = attempt.rows[0];
      if (!bound || bound.mission_id !== activation.scope.missionId || bound.work_package_id !== activation.scope.workPackageId
        || bound.work_package_revision !== activation.scope.workPackageRevision || bound.story_id !== activation.scope.spec.storyId
        || bound.runtime_id !== activation.scope.runtimeId || bound.repository_id !== activation.scope.repositoryId
        || bound.worktree_id !== activation.scope.worktreeId || bound.spec_id !== activation.scope.spec.specId
        || bound.spec_version !== activation.scope.spec.specVersion || bound.spec_hash !== activation.scope.spec.specHash
        || bound.story_version !== activation.scope.spec.storyVersion || bound.story_hash !== activation.scope.spec.storyHash
        || bound.criteria_manifest_hash !== activation.scope.spec.criteriaManifestHash || bound.base_sha !== activation.scope.baseSha
        || bound.allowed_path_manifest_hash !== activation.scope.allowedPathManifestHash
        || bound.required_path_manifest_hash !== activation.scope.requiredPathManifestHash) {
        throw new ConflictError('Policy activation scope does not match the canonical attempt', { reason: 'identity_conflict' });
      }
      const leaseSlotKey = stableHash('rorca.execution-lease-slot.v1', { workspaceId: activation.workspaceId,
        missionId: activation.scope.missionId, workPackageId: activation.scope.workPackageId,
        storyId: activation.scope.spec.storyId, attemptId: activation.scope.attemptId });
      await client.query(`INSERT INTO execution_lease_slots(workspace_id,lease_slot_key)
        SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM execution_lease_slots WHERE workspace_id=$1 AND lease_slot_key=$2)`,
      [activation.workspaceId, leaseSlotKey]);
      const slot = await client.query<{ last_fence: string }>(`SELECT last_fence FROM execution_lease_slots
        WHERE workspace_id=$1 AND lease_slot_key=$2 FOR UPDATE`, [activation.workspaceId, leaseSlotKey]);
      const head = await client.query<{ activation_id: string; current_revision: number; effective_state: string; state_version: string }>(
        `SELECT activation_id,current_revision,effective_state,state_version FROM context_policy_activation_heads
         WHERE workspace_id=$1 AND scope_key=$2 FOR UPDATE`, [activation.workspaceId, scopeKey]);
      if (!head.rows[0] && activation.scope.fencingToken !== Number(slot.rows[0]!.last_fence) + 1) {
        throw new ConflictError('Policy activation fence does not match the next canonical lease fence', { reason: 'stale_fence' });
      }
      const transitions: Record<string, readonly string[]> = { proposed: ['verified', 'rejected'], verified: ['active', 'rejected'],
        active: ['superseded', 'revoked'], superseded: ['active'], rejected: [], revoked: [] };
      if (!head.rows[0] && (activation.activationRevision !== 1 || activation.state !== 'proposed')) throw new ConflictError('First activation revision must be proposed revision one', { reason: 'revision_conflict' });
      if (head.rows[0] && (head.rows[0].activation_id !== activation.activationId
        || activation.activationRevision !== head.rows[0].current_revision + 1
        || !transitions[head.rows[0].effective_state]?.includes(activation.state))) {
        throw new ConflictError('Activation transition or revision is stale', { reason: 'stale_revision' });
      }
      await client.query(`INSERT INTO context_policy_activations
        (workspace_id,activation_id,activation_revision,activation_hash,policy_definition_id,policy_definition_version,scope_key,
         scope_json,effective_values_hash,authority_receipt_id,state,activated_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`, [activation.workspaceId, activation.activationId,
        activation.activationRevision, activation.activationHash, activation.definitionId, activation.definitionVersion, scopeKey,
        asJson(activation.scope), activation.effectiveValuesHash, activation.authorityReceiptId, activation.state,
        activation.activatedAt, activation.expiresAt]);
      if (head.rows[0]) {
        const updated = await client.query(`UPDATE context_policy_activation_heads SET current_revision=$3,current_hash=$4,effective_state=$5,
          state_version=state_version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND scope_key=$2 AND state_version=$6`,
        [activation.workspaceId, scopeKey, activation.activationRevision, activation.activationHash, activation.state, head.rows[0].state_version]);
        if (updated.rowCount !== 1) throw new ConflictError('Activation CAS lost', { reason: 'stale_revision' });
      } else await client.query(`INSERT INTO context_policy_activation_heads
        (workspace_id,scope_key,activation_id,current_revision,current_hash,effective_state) VALUES($1,$2,$3,$4,$5,$6)`,
      [activation.workspaceId, scopeKey, activation.activationId, activation.activationRevision, activation.activationHash, activation.state]);
      return { activationId: activation.activationId, revision: activation.activationRevision, hash: activation.activationHash, scopeKey, effectiveState: activation.state };
    } });
}

export async function persistRetrievalReceipt(candidate: unknown, context: GovernedMutationContext) {
  const receipt = RetrievalReceiptV1Schema.parse(candidate);
  const scopeKey = stableHash('rorca.continuation-scope.v1', receipt.scope);
  return runIdempotentMutation({ workspaceId: receipt.scope.workspaceId, operation: 'retrieval-receipt.persist', ...context,
    request: receipt, subject: { receiptId: receipt.receiptId, retrievalKey: receipt.retrievalKey }, mutate: async (client) => {
      await verifyActiveLeaseScope(client, receipt.scope);
      assertTokenAccounting(receipt.tokenAccounting);
      if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) throw new UnprocessableError('Receipt finish precedes start', 'INVALID_TIME_ORDER');
      const sourceKeys = receipt.sources.map((source) => `${source.contextClass}\u0000${source.sourceType}\u0000${source.stableSourceId}\u0000${source.sourceVersion}\u0000${source.contentHash}`);
      if (new Set(sourceKeys).size !== sourceKeys.length) throw new UnprocessableError('Receipt contains duplicate same-class source identity', 'DUPLICATE_SOURCE');
      if (receipt.definitionHash !== receipt.scope.policyDefinitionHash || receipt.activationHash !== receipt.scope.policyActivationHash) {
        throw new ConflictError('Receipt policy identity does not match active scope', { reason: 'identity_conflict' });
      }
      const definition = await client.query<{ body_json: unknown }>(`SELECT body_json FROM context_policy_definitions
        WHERE workspace_id=$1 AND policy_definition_id=$2 AND policy_definition_version=$3 AND policy_definition_hash=$4
          AND lifecycle_state='published' FOR KEY SHARE`, [receipt.scope.workspaceId, receipt.scope.policyDefinitionId,
        receipt.scope.policyDefinitionVersion, receipt.definitionHash]);
      const policy = definition.rows[0] ? ContextPolicyDefinitionV1Schema.safeParse(definition.rows[0].body_json) : null;
      if (!policy?.success) throw new UnprocessableError('Canonical context policy definition is unavailable', 'POLICY_DEFINITION_INVALID');
      if (receipt.tokenAccounting.total > policy.data.limits.totalTokens || receipt.tokenAccounting.required > policy.data.limits.requiredTokens
        || receipt.tokenAccounting.advisory > policy.data.limits.advisoryTokens || receipt.tokenAccounting.instructions > policy.data.limits.instructionTokens
        || receipt.sources.filter((source) => source.contextClass === 'required').length > policy.data.limits.requiredSources
        || receipt.sources.filter((source) => source.contextClass === 'advisory').length > policy.data.limits.advisoryItems) {
        throw new UnprocessableError('Receipt exceeds effective context policy limits', 'CONTEXT_POLICY_LIMIT_EXCEEDED');
      }
      const checkpoint = await client.query<{ checkpoint_hash: string; scope_key: string; lease_id: string; fencing_token: string;
        activation_hash: string; state: string }>(`SELECT checkpoint_hash,scope_key,lease_id,fencing_token,activation_hash,state FROM context_checkpoints
        WHERE workspace_id=$1 AND checkpoint_id=$2 FOR KEY SHARE`, [receipt.scope.workspaceId, receipt.checkpointId]);
      if (!checkpoint.rows[0] || checkpoint.rows[0].scope_key !== scopeKey || checkpoint.rows[0].lease_id !== receipt.scope.leaseId
        || Number(checkpoint.rows[0].fencing_token) !== receipt.scope.fencingToken
        || checkpoint.rows[0].activation_hash !== receipt.scope.policyActivationHash || checkpoint.rows[0].state !== 'current') {
        throw new ConflictError('Receipt checkpoint scope mismatch', { reason: 'identity_conflict' });
      }
      await client.query(`INSERT INTO context_retrieval_receipts
        (workspace_id,receipt_id,retrieval_key,scope_key,checkpoint_id,activation_hash,required_complete,status,reason_code,retryable,request_hash,payload_json,created_at,finished_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`, [receipt.scope.workspaceId,
        receipt.receiptId, receipt.retrievalKey, scopeKey, receipt.checkpointId, receipt.activationHash, receipt.requiredComplete,
        receipt.status, receipt.reasonCode, receipt.retryable, stableHash('rorca.retrieval-receipt-request.v1', receipt), asJson(receipt),
        receipt.startedAt, receipt.finishedAt]);
      for (let index = 0; index < receipt.sources.length; index += 1) {
        const source = receipt.sources[index]!;
        await client.query(`INSERT INTO context_retrieval_sources
          (workspace_id,receipt_id,source_order,context_class,source_type,stable_source_id,source_version,content_hash,freshness,excluded,redaction_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [receipt.scope.workspaceId, receipt.receiptId, index,
          source.contextClass, source.sourceType, source.stableSourceId, source.sourceVersion, source.contentHash,
          source.freshness, source.excluded, source.redactionHash]);
      }
      return { receiptId: receipt.receiptId, retrievalKey: receipt.retrievalKey, status: receipt.status };
    } });
}

export async function persistContextBundle(candidate: unknown, context: GovernedMutationContext) {
  const bundle = ContextBundleV1Schema.parse(candidate);
  const scopeKey = stableHash('rorca.continuation-scope.v1', bundle.scope);
  return runIdempotentMutation({ workspaceId: bundle.scope.workspaceId, operation: 'context-bundle.persist', ...context,
    request: bundle, subject: { bundleId: bundle.bundleId, version: bundle.bundleVersion }, mutate: async (client) => {
      await verifyActiveLeaseScope(client, bundle.scope);
      assertTokenAccounting(bundle.tokenAccounting);
      const lineage = await client.query<{ checkpoint_hash: string; receipt_id: string; scope_key: string; required_complete: boolean;
        status: string; activation_hash: string; payload_json: unknown; bundle_hash: string; lease_expires_at: Date }>(
        `SELECT c.checkpoint_hash,r.receipt_id,r.scope_key,r.required_complete,r.status,r.activation_hash,r.payload_json,
                l.bundle_hash,l.expires_at lease_expires_at
         FROM context_checkpoints c JOIN context_retrieval_receipts r ON r.workspace_id=c.workspace_id AND r.checkpoint_id=c.checkpoint_id
         JOIN execution_leases l ON l.workspace_id=c.workspace_id AND l.lease_id=c.lease_id
         WHERE c.workspace_id=$1 AND c.checkpoint_id=$2 AND r.receipt_id=$3 FOR KEY SHARE OF c,r FOR UPDATE OF l`,
      [bundle.scope.workspaceId, bundle.checkpointId, bundle.receiptId]);
      const row = lineage.rows[0];
      const receipt = row ? RetrievalReceiptV1Schema.safeParse(row.payload_json) : null;
      if (!row || !receipt?.success || row.scope_key !== scopeKey || row.checkpoint_hash !== bundle.checkpointHash
        || row.status !== receipt.data.status || !['completed', 'degraded'].includes(row.status) || !row.required_complete
        || row.activation_hash !== bundle.activationHash || receipt.data.contentHash !== bundle.receiptHash
        || bundle.definitionHash !== bundle.scope.policyDefinitionHash || bundle.activationHash !== bundle.scope.policyActivationHash
        || (bundle.state === 'active' && row.bundle_hash !== bundle.bundleHash)) throw new ConflictError('Bundle canonical lineage mismatch', { reason: 'identity_conflict' });
      const orderedSources = [...bundle.requiredContext, ...bundle.advisoryMemory];
      if (bundle.orderedSourceHash !== stableHash('rorca.context-bundle-ordered-sources.v1', orderedSources)
        || bundle.redactionManifestHash !== stableHash('rorca.context-bundle-redactions.v1', orderedSources.map((source) => source.redactionHash))
        || bundle.tokenAllocationHash !== stableHash('rorca.context-bundle-token-allocation.v1', bundle.tokenAccounting)) {
        throw new UnprocessableError('Bundle source ordering, redaction, or token-allocation hash is not canonical', 'BUNDLE_CANONICAL_HASH_MISMATCH');
      }
      if (stableHash('rorca.bundle-required-context.v1', bundle.requiredContext)
          !== stableHash('rorca.bundle-required-context.v1', receipt.data.sources.filter((source) => source.contextClass === 'required' && !source.excluded))
        || stableHash('rorca.bundle-advisory-context.v1', bundle.advisoryMemory)
          !== stableHash('rorca.bundle-advisory-context.v1', receipt.data.sources.filter((source) => source.contextClass === 'advisory' && !source.excluded))
        || stableHash('rorca.bundle-token-accounting.v1', bundle.tokenAccounting)
          !== stableHash('rorca.bundle-token-accounting.v1', receipt.data.tokenAccounting)) {
        throw new UnprocessableError('Bundle sources or token accounting differ from canonical receipt', 'BUNDLE_RECEIPT_MISMATCH');
      }
      const definition = await client.query<{ body_json: unknown }>(`SELECT body_json FROM context_policy_definitions
        WHERE workspace_id=$1 AND policy_definition_id=$2 AND policy_definition_version=$3 AND policy_definition_hash=$4
          AND lifecycle_state='published' FOR KEY SHARE`, [bundle.scope.workspaceId, bundle.scope.policyDefinitionId,
        bundle.scope.policyDefinitionVersion, bundle.definitionHash]);
      const policy = definition.rows[0] ? ContextPolicyDefinitionV1Schema.safeParse(definition.rows[0].body_json) : null;
      const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time');
      if (!policy?.success || bundle.serializedBytes > policy.data.limits.serializedBytes
        || bundle.tokenAccounting.total > policy.data.limits.totalTokens || Date.parse(bundle.expiresAt) <= clock.rows[0]!.db_time.getTime()
        || Date.parse(bundle.expiresAt) > row.lease_expires_at.getTime()) {
        throw new UnprocessableError('Bundle exceeds policy or active lease lifetime', 'CONTEXT_POLICY_LIMIT_EXCEEDED');
      }
      await client.query(`INSERT INTO context_bundles
        (workspace_id,bundle_id,bundle_hash,scope_key,checkpoint_id,receipt_id,required_manifest_hash,advisory_manifest_hash,
         serialized_bytes,token_count,expires_at,state,payload_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`, [bundle.scope.workspaceId, bundle.bundleId,
        bundle.bundleHash, scopeKey, bundle.checkpointId, bundle.receiptId,
        stableHash('rorca.required-context-manifest.v1', bundle.requiredContext), stableHash('rorca.advisory-context-manifest.v1', bundle.advisoryMemory),
        bundle.serializedBytes, bundle.tokenAccounting.total, bundle.expiresAt, bundle.state, asJson(bundle)]);
      return { bundleId: bundle.bundleId, version: bundle.bundleVersion, hash: bundle.bundleHash, state: bundle.state };
    } });
}

export async function persistContextBundleDelta(candidate: unknown, context: GovernedMutationContext) {
  const delta = ContextBundleDeltaV1Schema.parse(candidate);
  return runIdempotentMutation({ workspaceId: delta.scope.workspaceId, operation: 'context-delta.persist', ...context,
    request: delta, subject: { deltaId: delta.deltaId, baseBundleId: delta.baseBundleId, targetBundleId: delta.targetBundleId },
    mutate: async (client) => {
      await verifyActiveLeaseScope(client, delta.scope);
      const full = (reason: string) => ({ deltaId: delta.deltaId, mode: 'full' as const, reason, fullBundleRequired: true });
      const bundles = await client.query<{ bundle_id: string; bundle_hash: string; scope_key: string; state: string;
        expires_at: Date; payload_json: unknown }>(`SELECT bundle_id,bundle_hash,scope_key,state,expires_at,payload_json FROM context_bundles
        WHERE workspace_id=$1 AND bundle_id=ANY($2::text[]) FOR KEY SHARE`,
      [delta.scope.workspaceId, [delta.baseBundleId, delta.targetBundleId]]);
      const base = bundles.rows.find((row) => row.bundle_id === delta.baseBundleId);
      const target = bundles.rows.find((row) => row.bundle_id === delta.targetBundleId);
      if (!base) return full('base_missing');
      if (!target) return full('target_missing');
      const parsedBase = ContextBundleV1Schema.safeParse(base.payload_json); const parsedTarget = ContextBundleV1Schema.safeParse(target.payload_json);
      if (!parsedBase.success || parsedBase.data.bundleHash !== base.bundle_hash || parsedBase.data.bundleId !== base.bundle_id
        || base.bundle_hash !== delta.baseBundleHash) return full('base_corrupt');
      if (!parsedTarget.success || parsedTarget.data.bundleHash !== target.bundle_hash || parsedTarget.data.bundleId !== target.bundle_id
        || target.bundle_hash !== delta.reconstructedTargetHash) return full('target_corrupt');
      const scopeKey = stableHash('rorca.continuation-scope.v1', delta.scope);
      if (base.scope_key !== scopeKey || target.scope_key !== scopeKey
        || stableHash('rorca.continuation-scope.v1', parsedBase.data.scope) !== scopeKey
        || stableHash('rorca.continuation-scope.v1', parsedTarget.data.scope) !== scopeKey
        || delta.targetScopeHash !== scopeKey) return full('stable_scope_changed');
      const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time');
      if (base.expires_at <= clock.rows[0]!.db_time || target.expires_at <= clock.rows[0]!.db_time
        || !['active', 'verified', 'superseded'].includes(base.state) || target.state !== 'verified') return full('bundle_state_or_expiry_invalid');
      const definition = await client.query<{ body_json: unknown }>(`SELECT body_json FROM context_policy_definitions
        WHERE workspace_id=$1 AND policy_definition_id=$2 AND policy_definition_version=$3 AND policy_definition_hash=$4
          AND lifecycle_state='published' FOR KEY SHARE`, [delta.scope.workspaceId, delta.scope.policyDefinitionId,
        delta.scope.policyDefinitionVersion, delta.scope.policyDefinitionHash]);
      const policy = definition.rows[0] ? ContextPolicyDefinitionV1Schema.safeParse(definition.rows[0].body_json) : null;
      if (!policy?.success || delta.chainDepth > policy.data.limits.deltaChain) return full('delta_chain_exceeded');
      const priorDepth = await client.query<{ chain_depth: number }>(`SELECT chain_depth FROM context_bundle_deltas
        WHERE workspace_id=$1 AND target_bundle_id=$2 AND state IN('verified','applied') ORDER BY chain_depth DESC LIMIT 1 FOR KEY SHARE`,
      [delta.scope.workspaceId, delta.baseBundleId]);
      if (delta.chainDepth !== (priorDepth.rows[0]?.chain_depth ?? 0) + 1) return full('delta_chain_mismatch');
      const allowed = new Set(['/artifactId', '/contentHash', '/bundleId', '/bundleVersion', '/bundleHash', '/state']);
      const differences = changedJsonPointers(parsedBase.data, parsedTarget.data).sort();
      const operationPaths = delta.operations.map((operation) => operation.path).sort();
      if (differences.some((path) => !allowed.has(path))
        || stableHash('rorca.context-delta-path-set.v1', differences) !== stableHash('rorca.context-delta-path-set.v1', operationPaths)) {
        return full('forbidden_difference');
      }
      if (delta.operationListHash !== stableHash('rorca.context-delta-operations.v1', delta.operations)) return full('operation_hash_mismatch');
      const reconstructed = applyServerVerifiedDelta(parsedBase.data, parsedTarget.data, delta.operations);
      if (!reconstructed || stableHash('rorca.context-delta-reconstruction.v1', reconstructed)
        !== stableHash('rorca.context-delta-reconstruction.v1', parsedTarget.data)) return full('target_reconstruction_mismatch');
      const proof = stableHash('rorca.context-delta-verification-receipt.v1', { scopeKey, baseBundleId: base.bundle_id,
        baseBundleHash: base.bundle_hash, targetBundleId: target.bundle_id, targetBundleHash: target.bundle_hash,
        operationListHash: delta.operationListHash, chainDepth: delta.chainDepth,
        reconstructionHash: stableHash('rorca.context-delta-reconstruction.v1', reconstructed) });
      if (delta.verificationReceiptHash !== proof) return full('verification_receipt_mismatch');
      const deltaKey = stableHash('rorca.context-delta-key.v1', { scope: delta.scope, base: delta.baseBundleHash, target: delta.reconstructedTargetHash });
      await client.query(`INSERT INTO context_bundle_deltas
        (workspace_id,delta_id,delta_key,base_bundle_id,base_bundle_hash,target_bundle_id,target_bundle_hash,operations_hash,chain_depth,state,fallback_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'verified',NULL)`, [delta.scope.workspaceId, delta.deltaId, deltaKey,
        delta.baseBundleId, delta.baseBundleHash, delta.targetBundleId, delta.reconstructedTargetHash,
        delta.operationListHash, delta.chainDepth]);
      return { deltaId: delta.deltaId, mode: 'delta' as const, reason: 'verified_reconstruction' as const, fullBundleRequired: false,
        verificationReceiptHash: proof };
    } });
}

export async function persistContinuationRetryBudget(candidate: unknown, context: GovernedMutationContext) {
  const budget = ContinuationRetryBudgetV1Schema.parse(candidate);
  return runIdempotentMutation({ workspaceId: budget.workspaceId, operation: 'continuation-budget.persist', ...context,
    request: budget, subject: { retryBudgetId: budget.retryBudgetId, continuationKey: budget.continuationKey }, mutate: async (client) => {
      if (budget.workspaceId !== budget.scope.workspaceId) throw new ConflictError('Retry budget workspace differs from scope', { reason: 'identity_conflict' });
      await verifyActiveLeaseScope(client, budget.scope);
      const scopeKey = stableHash('rorca.continuation-scope.v1', budget.scope);
      const leaseLineage = await client.query<{ checkpoint_hash: string; bundle_hash: string }>(`SELECT checkpoint_hash,bundle_hash
        FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2 FOR KEY SHARE`, [budget.workspaceId, budget.scope.leaseId]);
      if (!leaseLineage.rows[0] || leaseLineage.rows[0].checkpoint_hash !== budget.checkpointHash
        || leaseLineage.rows[0].bundle_hash !== budget.bundleHash) throw new ConflictError('Retry budget checkpoint or bundle lineage differs from lease', { reason: 'identity_conflict' });
      await client.query(`INSERT INTO continuation_retry_budgets
        (workspace_id,continuation_key,retry_budget_id,scope_key,attempt_id,lease_id,fencing_token,activation_hash,checkpoint_hash,bundle_hash,payload_json,
         retrieval_max,retrieval_spent,transport_max,transport_spent,in_flight_owner,retry_fence,retry_expires_at,next_retry_at,
         permanent_conflict_count,state,reason_code)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [budget.workspaceId, budget.continuationKey, budget.retryBudgetId, scopeKey, budget.scope.attemptId, budget.scope.leaseId,
        budget.scope.fencingToken, budget.scope.policyActivationHash, budget.checkpointHash, budget.bundleHash, asJson(budget),
        budget.retrievalMaximum, budget.retrievalSpent, budget.transportMaximum, budget.transportSpent,
        budget.inFlightOwner, budget.retryFence, budget.retryExpiresAt, budget.nextRetryAt, budget.permanentConflictCount,
        budget.state, budget.reasonCode]);
      return { retryBudgetId: budget.retryBudgetId, continuationKey: budget.continuationKey, state: budget.state };
    } });
}

export async function authorizeContinuationDispatch(candidate: unknown, context: GovernedMutationContext) {
  const dispatch = ContinuationDispatchV1Schema.parse(candidate);
  if (dispatch.state !== 'lease_verified') throw new ValidationError('Dispatch must enter authorization from lease_verified state');
  const scopeKey = stableHash('rorca.continuation-scope.v1', dispatch.scope);
  return runIdempotentMutation({ workspaceId: dispatch.scope.workspaceId, operation: 'continuation-dispatch.authorize', ...context,
    request: dispatch, subject: { dispatchId: dispatch.dispatchId, continuationKey: dispatch.continuationKey }, mutate: async (client) => {
      await verifyActiveLeaseScope(client, dispatch.scope);
      const lease = await client.query<{ state: string; expires_at: Date; fencing_token: string; runtime_id: string; policy_activation_hash: string; checkpoint_hash: string; bundle_hash: string }>(
        `SELECT state,expires_at,fencing_token,runtime_id,policy_activation_hash,checkpoint_hash,bundle_hash FROM execution_leases
         WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`, [dispatch.scope.workspaceId, dispatch.scope.leaseId]);
      const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time'); const now = clock.rows[0]!.db_time;
      if (!lease.rows[0] || lease.rows[0].state !== 'active' || lease.rows[0].expires_at <= now) throw new UnprocessableError('Dispatch lease is expired or inactive', 'LEASE_EXPIRED');
      if (Number(lease.rows[0].fencing_token) !== dispatch.scope.fencingToken || lease.rows[0].runtime_id !== dispatch.scope.runtimeId
        || lease.rows[0].policy_activation_hash !== dispatch.activationHash || lease.rows[0].checkpoint_hash !== dispatch.checkpointHash
        || lease.rows[0].bundle_hash !== dispatch.bundleHash) throw new ConflictError('Dispatch lease subject mismatch', { reason: 'stale_fence' });
      const lineage = await client.query<{ checkpoint_hash: string; checkpoint_scope: string; checkpoint_state: string;
        receipt_status: string; required_complete: boolean; receipt_payload: unknown; bundle_hash: string; bundle_scope: string;
        bundle_state: string; bundle_expires_at: Date; retry_budget_id: string; retry_state: string; in_flight_owner: string | null;
        retry_expires_at: Date | null }>(`SELECT c.checkpoint_hash,c.scope_key checkpoint_scope,c.state checkpoint_state,
          r.status receipt_status,r.required_complete,r.payload_json receipt_payload,b.bundle_hash,b.scope_key bundle_scope,
          b.state bundle_state,b.expires_at bundle_expires_at,rb.retry_budget_id,rb.state retry_state,
          rb.in_flight_owner,rb.retry_expires_at
        FROM context_checkpoints c JOIN context_retrieval_receipts r ON r.workspace_id=c.workspace_id AND r.receipt_id=$3 AND r.checkpoint_id=c.checkpoint_id
         JOIN context_bundles b ON b.workspace_id=c.workspace_id AND b.bundle_id=$4 AND b.checkpoint_id=c.checkpoint_id AND b.receipt_id=r.receipt_id
         JOIN continuation_retry_budgets rb ON rb.workspace_id=c.workspace_id AND rb.continuation_key=$5
        WHERE c.workspace_id=$1 AND c.checkpoint_id=$2 FOR KEY SHARE OF c,r,b,rb`,
      [dispatch.scope.workspaceId, dispatch.checkpointId, dispatch.receiptId, dispatch.bundleId, dispatch.continuationKey]);
      const canonical = lineage.rows[0]; const receipt = canonical ? RetrievalReceiptV1Schema.safeParse(canonical.receipt_payload) : null;
      if (!canonical || !receipt?.success || canonical.checkpoint_hash !== dispatch.checkpointHash
        || canonical.checkpoint_scope !== scopeKey || canonical.checkpoint_state !== 'current'
        || !['completed', 'degraded'].includes(canonical.receipt_status) || !canonical.required_complete
        || receipt.data.contentHash !== dispatch.receiptHash || canonical.bundle_hash !== dispatch.bundleHash
        || canonical.bundle_scope !== scopeKey || canonical.bundle_state !== 'active' || canonical.bundle_expires_at <= now
        || canonical.retry_budget_id !== dispatch.retryBudgetId || !['open', 'backoff'].includes(canonical.retry_state)
        || (canonical.in_flight_owner && canonical.retry_expires_at && canonical.retry_expires_at > now)) {
        throw new ConflictError('Dispatch checkpoint, receipt, bundle, or retry lineage is not authorization-ready', { reason: 'identity_conflict' });
      }
      const expiry = new Date(Math.min(lease.rows[0].expires_at.getTime(), Date.parse(dispatch.authorizationExpiresAt)));
      if (expiry <= now) throw new UnprocessableError('Dispatch authorization is expired', 'AUTHORIZATION_EXPIRED');
      const firstVerificationHash = stableHash('rorca.dispatch-first-lease-verification.v1', { leaseId: dispatch.scope.leaseId,
        fence: dispatch.scope.fencingToken, runtimeId: dispatch.scope.runtimeId, observedAt: now.toISOString() });
      const dispatchHash = stableHash('rorca.continuation-dispatch-payload.v1', dispatch);
      await client.query(`INSERT INTO continuation_dispatches
        (workspace_id,dispatch_id,continuation_key,scope_key,lease_id,fencing_token,checkpoint_id,receipt_id,bundle_id,activation_hash,
         rendered_payload_hash,first_verification_hash,authorization_expires_at,state,reason_code,dispatch_hash,payload_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'authorized',$14,$15,$16::jsonb)`, [dispatch.scope.workspaceId,
        dispatch.dispatchId, dispatch.continuationKey, scopeKey, dispatch.scope.leaseId, dispatch.scope.fencingToken,
        dispatch.checkpointId, dispatch.receiptId, dispatch.bundleId, dispatch.activationHash, dispatch.renderedPayloadHash,
        firstVerificationHash, expiry, dispatch.reasonCode, dispatchHash, asJson(dispatch)]);
      return { dispatchId: dispatch.dispatchId, state: 'authorized', dispatchHash, firstVerificationHash, authorizationExpiresAt: expiry.toISOString() };
    } });
}

export async function persistContextCheckpoint(candidate: unknown, context: GovernedMutationContext) {
  const checkpoint = ContextCheckpointV1Schema.parse(candidate);
  const scopeKey = stableHash('rorca.continuation-scope.v1', checkpoint.scope);
  return runIdempotentMutation({ workspaceId: checkpoint.scope.workspaceId, operation: 'checkpoint.persist', ...context,
    request: checkpoint, subject: { checkpointId: checkpoint.checkpointId, scopeKey }, mutate: async (client) => {
      await verifyActiveLeaseScope(client, checkpoint.scope);
      await client.query(`INSERT INTO context_scope_heads(workspace_id,scope_key)
        SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM context_scope_heads WHERE workspace_id=$1 AND scope_key=$2)`,
      [checkpoint.scope.workspaceId, scopeKey]);
      const head = await client.query<{ checkpoint_sequence: string }>(`SELECT checkpoint_sequence FROM context_scope_heads WHERE workspace_id=$1 AND scope_key=$2 FOR UPDATE`, [checkpoint.scope.workspaceId, scopeKey]);
      const existing = await client.query<{ checkpoint_hash: string }>(`SELECT checkpoint_hash FROM context_checkpoints WHERE workspace_id=$1 AND checkpoint_id=$2`, [checkpoint.scope.workspaceId, checkpoint.checkpointId]);
      if (existing.rows[0]) {
        if (existing.rows[0].checkpoint_hash !== checkpoint.contentHash) throw new ConflictError('Checkpoint identity changed', { reason: 'idempotency_payload_conflict' });
        return { checkpointId: checkpoint.checkpointId, sequence: checkpoint.checkpointSequence, duplicate: true };
      }
      if (checkpoint.checkpointSequence !== Number(head.rows[0]!.checkpoint_sequence) + 1) throw new ConflictError('Checkpoint sequence gap or regression', { reason: 'event_order_conflict' });
      await client.query(`INSERT INTO context_checkpoints
        (workspace_id,checkpoint_id,scope_key,checkpoint_sequence,checkpoint_hash,trigger_type,trigger_hash,lease_id,fencing_token,activation_hash,state,payload_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'current',$11::jsonb)`, [checkpoint.scope.workspaceId, checkpoint.checkpointId, scopeKey,
        checkpoint.checkpointSequence, checkpoint.contentHash, checkpoint.trigger.type, stableHash('rorca.trigger-material.v1', checkpoint.trigger),
        checkpoint.scope.leaseId, checkpoint.scope.fencingToken, checkpoint.scope.policyActivationHash, asJson(checkpoint)]);
      await client.query(`UPDATE context_scope_heads SET checkpoint_id=$3,checkpoint_sequence=$4,state_version=state_version+1,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND scope_key=$2`, [checkpoint.scope.workspaceId, scopeKey, checkpoint.checkpointId, checkpoint.checkpointSequence]);
      return { checkpointId: checkpoint.checkpointId, sequence: checkpoint.checkpointSequence, duplicate: false };
    } });
}

export interface GovernedEventIngress {
  correlationId: string; observerId: string; observerClass: 'runtime' | 'host';
  maximumTrust: 'runtime_asserted' | 'host_observed' | 'automated_test';
  idempotencyKey?: string;
}

export async function ingestRuntimeEvent(candidate: unknown, ingress: GovernedEventIngress): Promise<{
  duplicate: boolean; eventId: string; canonicalStateOrder: number; hostReceiptOrder: number; databaseTime: string;
}> {
  const event = RuntimeEventV1Schema.parse(candidate);
  assertGovernedPayloadSafe(event);
  const trustLevels = ['runtime_asserted', 'host_observed', 'automated_test'];
  if (event.createdBy !== ingress.observerId || event.observerClass !== ingress.observerClass
    || trustLevels.indexOf(event.trustClass) > trustLevels.indexOf(ingress.maximumTrust)) {
    throw new UnprocessableError('Event observer class or trust exceeds authenticated ingress', 'TRUST_ESCALATION_FORBIDDEN');
  }
  const correlationId = ingress.correlationId;
  const eventHash = stableHash('rorca.runtime-event-payload.v1', event);
  const subjectHash = stableHash('rorca.runtime-event-subject.v1', { workspaceId: event.scope.workspaceId, eventId: event.eventId });
  type EventResult = { kind: 'created' | 'duplicate'; canonicalStateOrder: number; hostReceiptOrder: number; databaseTime: string }
    | { kind: 'conflict'; reason: string };
  const result = await canonicalTransaction<EventResult>(async (client) => {
    await authorizeWave2Transaction(client, event.scope.workspaceId,{operation:'runtime-event.ingest',request:event,
      requestHash:eventHash,subjectHash});
    if (ingress.idempotencyKey) {
      const keyed = await client.query<{ event_id: string; event_hash: string; canonical_state_order: string;
        host_receipt_order: string; received_at: Date }>(`SELECT event_id,event_hash,canonical_state_order,host_receipt_order,received_at
          FROM runtime_events WHERE workspace_id=$1 AND federated_idempotency_key=$2 FOR KEY SHARE`,
      [event.scope.workspaceId, ingress.idempotencyKey]);
      if (keyed.rows[0]) {
        if (keyed.rows[0].event_id !== event.eventId || keyed.rows[0].event_hash !== eventHash) {
          await client.query(`INSERT INTO runtime_event_conflicts(workspace_id,event_id,existing_hash,incoming_hash,reason_code,correlation_id)
            VALUES($1,$2,$3,$4,'changed_idempotency_replay',$5)`,
          [event.scope.workspaceId, event.eventId, keyed.rows[0].event_hash, eventHash, correlationId]);
          return { kind: 'conflict', reason: 'changed_idempotency_replay' };
        }
        return { kind: 'duplicate', canonicalStateOrder: Number(keyed.rows[0].canonical_state_order),
          hostReceiptOrder: Number(keyed.rows[0].host_receipt_order), databaseTime: keyed.rows[0].received_at.toISOString() };
      }
    }
    const existing = await client.query<{ event_hash: string }>(`SELECT event_hash FROM runtime_events WHERE workspace_id=$1 AND event_id=$2`, [event.scope.workspaceId, event.eventId]);
    if (existing.rows[0]) {
      if (existing.rows[0].event_hash === eventHash) {
        await audit(client, { workspaceId: event.scope.workspaceId, operation: 'runtime-event.ingest', actorId: event.createdBy,
          authoritySource: 'runtime_lease', requestHash: eventHash, subjectHash, decision: 'accepted', resultCode: 'duplicate', correlationId });
        const duplicate = await client.query<{ canonical_state_order: string; host_receipt_order: string; received_at: Date }>(
          `SELECT canonical_state_order,host_receipt_order,received_at FROM runtime_events WHERE workspace_id=$1 AND event_id=$2`,
          [event.scope.workspaceId, event.eventId]);
        return { kind: 'duplicate', canonicalStateOrder: Number(duplicate.rows[0]!.canonical_state_order),
          hostReceiptOrder: Number(duplicate.rows[0]!.host_receipt_order), databaseTime: duplicate.rows[0]!.received_at.toISOString() };
      }
      await client.query(`INSERT INTO runtime_event_conflicts(workspace_id,event_id,existing_hash,incoming_hash,reason_code,correlation_id)
        VALUES($1,$2,$3,$4,'changed_replay',$5)`, [event.scope.workspaceId, event.eventId, existing.rows[0].event_hash, eventHash, correlationId]);
      await audit(client, { workspaceId: event.scope.workspaceId, operation: 'runtime-event.ingest', actorId: event.createdBy,
        authoritySource: 'runtime_lease', requestHash: eventHash, subjectHash, decision: 'blocked', resultCode: 'changed_replay', correlationId });
      return { kind: 'conflict', reason: 'changed_replay' };
    }
    const attempt = await client.query<{ runtime_id: string; generation: string; fencing_token: string; work_package_revision: number;
      policy_activation_hash: string; repository_id: string; base_sha: string; current_sha: string; worktree_id: string;
      state: string; expires_at: Date }>(
      `SELECT a.runtime_id,a.generation,l.fencing_token,l.work_package_revision,l.policy_activation_hash,l.repository_id,l.base_sha,
              l.current_sha,l.worktree_id,l.state,l.expires_at
       FROM governed_execution_attempts a JOIN execution_leases l ON l.workspace_id=a.workspace_id AND l.attempt_id=a.attempt_id
       WHERE a.workspace_id=$1 AND a.attempt_id=$2 AND l.lease_id=$3 FOR UPDATE OF l`,
      [event.scope.workspaceId, event.scope.attemptId, event.scope.leaseId]);
    const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time');
    const databaseTime = clock.rows[0]!.db_time;
    const bound = attempt.rows[0];
    const activeActivation = bound ? await client.query(`SELECT 1 FROM context_policy_activation_heads
      WHERE workspace_id=$1 AND current_hash=$2 AND effective_state='active' FOR KEY SHARE`,
    [event.scope.workspaceId, bound.policy_activation_hash]) : { rows: [] };
    const scopeReason = !bound ? 'attempt_or_lease_missing'
      : bound.state !== 'active' || bound.expires_at <= databaseTime ? 'lease_inactive_or_expired'
        : !activeActivation.rows[0] ? 'policy_activation_inactive'
          : bound.runtime_id !== event.scope.runtimeId ? 'runtime_substitution'
        : Number(bound.generation) !== event.scope.runtimeGeneration ? 'stale_generation'
          : Number(bound.fencing_token) !== event.scope.fencingToken ? 'stale_fence'
            : bound.work_package_revision !== event.scope.workPackageRevision
              || bound.policy_activation_hash !== event.scope.policyActivationHash
              || bound.repository_id !== event.scope.repository.repositoryId || bound.base_sha !== event.scope.repository.baseSha
              || bound.current_sha !== event.scope.repository.currentSha || bound.worktree_id !== event.scope.repository.worktreeId
              ? 'leased_subject_mismatch' : null;
    if (scopeReason) {
      await client.query(`INSERT INTO runtime_event_conflicts(workspace_id,event_id,incoming_hash,reason_code,correlation_id)
        VALUES($1,$2,$3,$4,$5)`, [event.scope.workspaceId, event.eventId, eventHash, scopeReason, correlationId]);
      await audit(client, { workspaceId: event.scope.workspaceId, operation: 'runtime-event.ingest', actorId: event.createdBy,
        authoritySource: 'runtime_lease', requestHash: eventHash, subjectHash, decision: 'blocked', resultCode: scopeReason, correlationId });
      return { kind: 'conflict', reason: scopeReason };
    }
    await client.query(`INSERT INTO runtime_event_stream_heads(workspace_id,attempt_id,runtime_generation)
      SELECT $1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM runtime_event_stream_heads
        WHERE workspace_id=$1 AND attempt_id=$2 AND runtime_generation=$3)`,
    [event.scope.workspaceId, event.scope.attemptId, event.scope.runtimeGeneration]);
    const head = await client.query<{ last_runtime_sequence: string; last_canonical_state_order: string; last_host_receipt_order: string }>(
      `SELECT last_runtime_sequence,last_canonical_state_order,last_host_receipt_order FROM runtime_event_stream_heads
       WHERE workspace_id=$1 AND attempt_id=$2 AND runtime_generation=$3 FOR UPDATE`, [event.scope.workspaceId, event.scope.attemptId, event.scope.runtimeGeneration],
    );
    const reason = event.runtimeSequence !== Number(head.rows[0]!.last_runtime_sequence) + 1 ? 'sequence_gap_or_regression' : null;
    const canonicalStateOrder = Number(head.rows[0]!.last_canonical_state_order) + 1;
    const hostReceiptOrder = Number(head.rows[0]!.last_host_receipt_order) + 1;
    if (reason) {
      await client.query(`INSERT INTO runtime_event_conflicts(workspace_id,event_id,incoming_hash,reason_code,correlation_id)
        VALUES($1,$2,$3,$4,$5)`, [event.scope.workspaceId, event.eventId, eventHash, reason, correlationId]);
      await audit(client, { workspaceId: event.scope.workspaceId, operation: 'runtime-event.ingest', actorId: event.createdBy,
        authoritySource: 'runtime_lease', requestHash: eventHash, subjectHash, decision: 'blocked', resultCode: reason, correlationId });
      return { kind: 'conflict', reason };
    }
    await client.query(`INSERT INTO runtime_events
      (workspace_id,event_id,attempt_id,runtime_generation,runtime_sequence,canonical_state_order,host_receipt_order,event_type,event_hash,payload_hash,trust_class,reason_code,payload_json,observed_at,received_at,federated_idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`, [event.scope.workspaceId, event.eventId, event.scope.attemptId,
      event.scope.runtimeGeneration, event.runtimeSequence, canonicalStateOrder, hostReceiptOrder, event.eventType,
      eventHash, event.payloadHash, event.trustClass, event.reasonCode,
      asJson({ ...event, canonicalStateOrder, hostReceiptOrder, receivedAt: databaseTime.toISOString(), databaseTime: databaseTime.toISOString() }),
      event.observedAt, databaseTime, ingress.idempotencyKey ?? null]);
    await client.query(`UPDATE runtime_event_stream_heads SET last_runtime_sequence=$4,last_canonical_state_order=$5,last_host_receipt_order=$6,state_version=state_version+1
      WHERE workspace_id=$1 AND attempt_id=$2 AND runtime_generation=$3`, [event.scope.workspaceId, event.scope.attemptId, event.scope.runtimeGeneration,
      event.runtimeSequence, canonicalStateOrder, hostReceiptOrder]);
    await audit(client, { workspaceId: event.scope.workspaceId, operation: 'runtime-event.ingest', actorId: event.createdBy,
      authoritySource: 'runtime_lease', requestHash: eventHash, subjectHash, decision: 'accepted', resultCode: 'created', correlationId });
    return { kind: 'created', canonicalStateOrder, hostReceiptOrder, databaseTime: databaseTime.toISOString() };
  });
  if (result.kind === 'conflict') throw new ConflictError('Runtime event ordering or replay conflict', { reason: result.reason, retryable: false });
  return { duplicate: result.kind === 'duplicate', eventId: event.eventId,
    canonicalStateOrder: result.canonicalStateOrder, hostReceiptOrder: result.hostReceiptOrder, databaseTime: result.databaseTime };
}

function evidenceTrust(value: EvidenceEnvelopeV1['trustClass']): string {
  if (value === 'runtime_asserted') return 'agent_proposed';
  if (value === 'provider_verified') return 'provider_verified';
  if (value === 'provider_human') return 'authenticated_manual';
  return 'host_observed';
}
export async function ingestGovernedEvidence(candidate: unknown, authenticatedObserver: {
  id: string; maximumTrust: EvidenceEnvelopeV1['trustClass']; correlationId?: string;
}) {
  const evidence = EvidenceEnvelopeV1Schema.parse(candidate);
  assertGovernedPayloadSafe(evidence);
  const envelopeHash = governedArtifactIntegrityHash('rorca.evidence-envelope.integrity.v1', evidence, ['contentHash', 'evidenceHash']);
  if (evidence.contentHash !== envelopeHash || evidence.evidenceHash !== envelopeHash) {
    throw new UnprocessableError('Evidence content and evidence hashes must equal server-derived canonical bytes',
      'CANONICAL_EVIDENCE_HASH_MISMATCH', { canonicalHash: envelopeHash });
  }
  if (evidence.observerId !== authenticatedObserver.id) throw new UnprocessableError('Observer identity is server-owned', 'TRUST_ESCALATION_FORBIDDEN');
  const levels = ['runtime_asserted', 'host_observed', 'automated_test', 'provider_verified', 'provider_human'];
  if (levels.indexOf(evidence.trustClass) > levels.indexOf(authenticatedObserver.maximumTrust)) throw new UnprocessableError('Evidence trust escalation is forbidden', 'TRUST_ESCALATION_FORBIDDEN');
  const subjectHash = stableHash('rorca.evidence-envelope-subject.v1', { workspaceId: evidence.workspaceId, evidenceId: evidence.evidenceId });
  const correlationId = authenticatedObserver.correlationId ?? `evidence:${evidence.evidenceId}`;
  type EvidenceResult = { kind: 'created' | 'duplicate'; id: number } | { kind: 'conflict' };
  const result = await canonicalTransaction<EvidenceResult>(async (client) => {
    await authorizeWave2Transaction(client, evidence.workspaceId,{operation:'evidence.ingest',request:evidence,
      requestHash:envelopeHash,subjectHash});
    const existing = await client.query<{ id: string; governed_contract_hash: string | null }>(
      `SELECT id,governed_contract_hash FROM ssdlc_lifecycle_evidence WHERE workspace_id=$1 AND source_system='governed-mission' AND source_idempotency_key=$2 FOR KEY SHARE`,
      [evidence.workspaceId, evidence.evidenceId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].governed_contract_hash === envelopeHash) {
        await audit(client, { workspaceId: evidence.workspaceId, operation: 'evidence.ingest', actorId: evidence.observerId,
          authoritySource: 'runtime_lease', requestHash: envelopeHash, subjectHash, decision: 'accepted', resultCode: 'duplicate', correlationId });
        return { kind: 'duplicate', id: Number(existing.rows[0].id) };
      }
      await recordConflict(client, { workspaceId: evidence.workspaceId, operation: 'evidence.ingest', subjectHash,
        existingHash: existing.rows[0].governed_contract_hash ?? undefined, incomingHash: envelopeHash,
        dimension: 'evidence_envelope', actorId: evidence.observerId, correlationId });
      await audit(client, { workspaceId: evidence.workspaceId, operation: 'evidence.ingest', actorId: evidence.observerId,
        authoritySource: 'runtime_lease', requestHash: envelopeHash, subjectHash, decision: 'blocked',
        resultCode: 'idempotency_payload_conflict', correlationId });
      return { kind: 'conflict' };
    }
    const leasedSubject = await client.query<{ attempt_id: string; fencing_token: string; runtime_id: string; work_package_revision: number;
      policy_activation_hash: string; repository_id: string; current_sha: string; worktree_id: string; mission_id: string;
      work_package_id: string; mission_revision: number; mission_hash: string; payload_json: unknown; state: string;
      expires_at: Date; checkpoint_hash: string }>(
      `SELECT l.attempt_id,l.fencing_token,l.runtime_id,l.work_package_revision,l.policy_activation_hash,l.repository_id,
              l.current_sha,l.worktree_id,l.state,l.expires_at,l.checkpoint_hash,a.mission_id,a.work_package_id,
              w.mission_revision,w.mission_hash,w.payload_json
       FROM execution_leases l JOIN governed_execution_attempts a ON a.workspace_id=l.workspace_id AND a.attempt_id=l.attempt_id
       JOIN governed_work_package_revisions w ON w.workspace_id=a.workspace_id AND w.mission_id=a.mission_id
        AND w.work_package_id=a.work_package_id AND w.work_package_revision=a.work_package_revision
       WHERE l.workspace_id=$1 AND l.lease_id=$2 FOR KEY SHARE OF w FOR UPDATE OF l`, [evidence.workspaceId, evidence.leaseId]);
    const leased = leasedSubject.rows[0];
    const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time');
    const workPackage = leased ? WorkPackageV1Schema.parse(leased.payload_json) : null;
    const activation = leased ? await client.query<{ activation_id: string }>(`SELECT a.activation_id FROM context_policy_activation_heads h
      JOIN context_policy_activations a ON a.workspace_id=h.workspace_id AND a.activation_id=h.activation_id AND a.activation_revision=h.current_revision
      WHERE h.workspace_id=$1 AND h.current_hash=$2 AND h.effective_state='active' AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
      FOR KEY SHARE OF h,a`, [evidence.workspaceId, evidence.policyActivationHash]) : { rows: [] };
    const checkpoint = leased ? await client.query(`SELECT 1 FROM context_checkpoints WHERE workspace_id=$1 AND checkpoint_id=$2
      AND checkpoint_hash=$3 AND lease_id=$4 AND fencing_token=$5 FOR KEY SHARE`,
    [evidence.workspaceId, evidence.checkpointId, leased.checkpoint_hash, evidence.leaseId, evidence.fencingToken]) : { rows: [] };
    if (!leased || leased.state !== 'active' || leased.expires_at <= clock.rows[0]!.db_time
      || leased.attempt_id !== evidence.attemptId || Number(leased.fencing_token) !== evidence.fencingToken
      || leased.work_package_revision !== evidence.workPackageRevision || leased.policy_activation_hash !== evidence.policyActivationHash
      || activation.rows[0]?.activation_id !== evidence.policyActivationId || !checkpoint.rows[0]
      || leased.repository_id !== evidence.repositoryId || leased.current_sha !== evidence.repositoryRevision
      || leased.worktree_id !== evidence.worktreeId || leased.mission_id !== evidence.missionId
      || leased.mission_revision !== evidence.missionRevision || leased.work_package_id !== evidence.workPackageId
      || !workPackage || workPackage.spec.specId !== evidence.specId || workPackage.spec.specVersion !== evidence.specVersion
      || workPackage.spec.specHash !== evidence.specHash || workPackage.spec.storyId !== evidence.storyId
      || workPackage.spec.storyVersion !== evidence.storyVersion || workPackage.spec.storyHash !== evidence.storyHash
      || (evidence.trustClass === 'runtime_asserted' && leased.runtime_id !== evidence.observerId)) {
      throw new ConflictError('Evidence leased-subject lineage mismatch', { reason: 'identity_conflict' });
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ssdlc_lifecycle_evidence
       (workspace_id,spec_slug,spec_version,revision,story_id,evidence_type,subject_type,subject_value,source_system,source_idempotency_key,
        payload_hash,metadata,provenance,source_ref,observed_at,source_type,classification,evidence_status,trust_level,confidence,
        release_identity,revision_mismatch,lineage_verified,actor,rationale,governed_contract_id,governed_contract_hash,governed_mission_id,
        governed_work_package_id,governed_spec_id,governed_spec_version,governed_spec_hash,governed_story_id,governed_story_version,
        governed_story_hash,governed_attempt_id,governed_lease_id,governed_fencing_token,governed_activation_hash,governed_checkpoint_id,
        governed_repository_id,governed_worktree_id,governed_observer_id)
       VALUES($1,$2,$3,$4,$5,$6,'commit_sha',$7,'governed-mission',$8,$9,$10::jsonb,$11::jsonb,$12,$13,$34,'completion',$14,$15,1,
        $16::jsonb,FALSE,TRUE,$17,$18,'rorca.evidence-envelope.v1',$19,$20,$21,$2,$33,$22,$5,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32) RETURNING id`,
      [evidence.workspaceId, evidence.specId, String(evidence.specVersion), evidence.repositoryRevision, evidence.storyId, evidence.kind,
        evidence.repositoryRevision, evidence.evidenceId, evidence.payloadHash, asJson({ redactionClass: evidence.redactionClass }),
        asJson({ independentReviewProvenanceHash: evidence.independentReviewProvenanceHash }), evidence.restrictedRef.referenceId,
        evidence.observedAt, evidence.status === 'passed' ? 'passed' : evidence.status === 'failed' ? 'story_caused_failure' : 'unknown', evidenceTrust(evidence.trustClass),
        asJson(evidence.trustClass === 'provider_human' ? { observerId: evidence.observerId } : {}),
        evidence.trustClass === 'provider_human' ? evidence.observerId : null,
        evidence.trustClass === 'provider_human' ? 'Exact provider-human governed evidence' : null,
        envelopeHash, evidence.missionId, evidence.workPackageId, evidence.specHash, evidence.storyVersion,
        evidence.storyHash, evidence.attemptId, evidence.leaseId, evidence.fencingToken, evidence.policyActivationHash,
        evidence.checkpointId, evidence.repositoryId, evidence.worktreeId, evidence.observerId, evidence.specVersion,
        evidence.trustClass === 'provider_human' ? 'manual_qa' : 'completion_signal'],
    );
    await audit(client, { workspaceId: evidence.workspaceId, operation: 'evidence.ingest', actorId: evidence.observerId,
      authoritySource: 'runtime_lease', requestHash: envelopeHash, subjectHash, decision: 'accepted', resultCode: 'created', correlationId });
    return { kind: 'created', id: Number(inserted.rows[0]!.id) };
  });
  if (result.kind === 'conflict') throw new ConflictError('Evidence identity changed', { reason: 'idempotency_payload_conflict', retryable: false });
  return { evidenceRowId: result.id, evidenceHash: envelopeHash, duplicate: result.kind === 'duplicate' };
}

async function appendContinuationRetryEvent(client: PoolClient, input: { workspaceId: string; continuationKey: string;
  retryFence: number; phase: 'retrieval' | 'transport'; eventType: string; owner: string | null; reasonCode: string }): Promise<string> {
  const sequence = await client.query<{ next: string }>(`SELECT COALESCE(max(event_sequence),0)+1 next FROM continuation_retry_events
    WHERE workspace_id=$1 AND continuation_key=$2`, [input.workspaceId, input.continuationKey]);
  const eventHash = stableHash('rorca.continuation-retry-event.v1', { ...input, sequence: Number(sequence.rows[0]!.next) });
  await client.query(`INSERT INTO continuation_retry_events
    (workspace_id,continuation_key,event_sequence,retry_fence,phase,event_type,owner,reason_code,event_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.workspaceId, input.continuationKey, sequence.rows[0]!.next,
    input.retryFence, input.phase, input.eventType, input.owner, input.reasonCode, eventHash]);
  return eventHash;
}

export async function claimContinuationRetry(input: {
  workspaceId: string; continuationKey: string; actorAttemptId: string; runtimeId: string; owner: string;
  phase: 'retrieval' | 'transport'; failureReason?: string;
}): Promise<{ claimed: boolean; retryFence: number; state: string; retrySpent: number }> {
  return canonicalTransaction(async (client) => {
    await authorizeWave2Transaction(client, input.workspaceId,{operation:'continuation-retry.claim',request:input});
    const budget = await client.query<{ retrieval_spent: number; retrieval_max: number; transport_spent: number; transport_max: number;
      in_flight_owner: string | null; retry_fence: string; retry_expires_at: Date | null; next_retry_at: Date | null;
      state: string; attempt_id: string; payload_json: unknown }>(`SELECT retrieval_spent,retrieval_max,transport_spent,transport_max,
        in_flight_owner,retry_fence,retry_expires_at,next_retry_at,state,attempt_id,payload_json FROM continuation_retry_budgets
       WHERE workspace_id=$1 AND continuation_key=$2 FOR UPDATE`, [input.workspaceId, input.continuationKey]);
    const row = budget.rows[0]; if (!row) throw new NotFoundError('Continuation retry budget', input.continuationKey);
    if (row.attempt_id !== input.actorAttemptId) throw new ConflictError('Retry actor attempt differs from canonical budget subject', { reason: 'identity_conflict' });
    const parsed = ContinuationRetryBudgetV1Schema.safeParse(row.payload_json);
    if (!parsed.success) throw new UnprocessableError('Retry budget canonical subject is invalid', 'RETRY_SUBJECT_INVALID');
    if (parsed.data.scope.runtimeId !== input.runtimeId) throw new ConflictError('Retry runtime differs from canonical budget subject', { reason: 'identity_conflict' });
    await verifyActiveLeaseScope(client, parsed.data.scope);
    const time = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time'); const now = time.rows[0]!.db_time;
    const spent = input.phase === 'retrieval' ? row.retrieval_spent : row.transport_spent;
    const maximum = input.phase === 'retrieval' ? row.retrieval_max : row.transport_max;
    if (input.failureReason && PERMANENT_RETRY_REASONS.has(input.failureReason)) {
      await client.query(`UPDATE continuation_retry_budgets SET permanent_conflict_count=permanent_conflict_count+1,
        reason_code=$3,state_version=state_version+1 WHERE workspace_id=$1 AND continuation_key=$2`,
      [input.workspaceId, input.continuationKey, input.failureReason]);
      await appendContinuationRetryEvent(client, { ...input, retryFence: Number(row.retry_fence), eventType: 'permanent_conflict', reasonCode: input.failureReason });
      return { claimed: false, retryFence: Number(row.retry_fence), state: 'permanent_conflict', retrySpent: spent };
    }
    if (['quarantined', 'exhausted', 'closed'].includes(row.state)) return { claimed: false, retryFence: Number(row.retry_fence), state: row.state, retrySpent: spent };
    if (row.next_retry_at && row.next_retry_at > now) return { claimed: false, retryFence: Number(row.retry_fence), state: 'backoff', retrySpent: spent };
    if (row.in_flight_owner && row.retry_expires_at && row.retry_expires_at > now) return { claimed: false, retryFence: Number(row.retry_fence), state: 'in_flight', retrySpent: spent };
    if (spent >= maximum) {
      await client.query(`UPDATE continuation_retry_budgets SET state='quarantined',reason_code=$3,in_flight_owner=NULL,
        retry_expires_at=NULL,state_version=state_version+1 WHERE workspace_id=$1 AND continuation_key=$2`,
      [input.workspaceId, input.continuationKey, `${input.phase}_retry_budget_exhausted`]);
      await client.query(`INSERT INTO continuation_quarantines(workspace_id,quarantine_id,continuation_key,reason_code,evidence_hash,state)
        SELECT $1,$2,$3,$4,$5,'open' WHERE NOT EXISTS(SELECT 1 FROM continuation_quarantines
          WHERE workspace_id=$1 AND continuation_key=$3)`, [input.workspaceId,`quarantine:${input.actorAttemptId}`,
        input.continuationKey,`${input.phase}_retry_budget_exhausted`,stableHash('rorca.quarantine.v1', input)]);
      await appendContinuationRetryEvent(client, { ...input, retryFence: Number(row.retry_fence), eventType: 'exhausted', reasonCode: `${input.phase}_retry_budget_exhausted` });
      return { claimed: false, retryFence: Number(row.retry_fence), state: 'quarantined', retrySpent: spent };
    }
    const fence = Number(row.retry_fence) + 1; const stale = Boolean(row.in_flight_owner);
    const spentColumn = input.phase === 'retrieval' ? 'retrieval_spent' : 'transport_spent';
    await client.query(`UPDATE continuation_retry_budgets SET ${spentColumn}=${spentColumn}+1,in_flight_owner=$3,retry_fence=$4,
      retry_expires_at=$5,next_retry_at=NULL,state='in_flight',reason_code='claimed',state_version=state_version+1
      WHERE workspace_id=$1 AND continuation_key=$2`, [input.workspaceId, input.continuationKey, input.owner, fence,
      new Date(now.getTime() + 30_000)]);
    await appendContinuationRetryEvent(client, { ...input, retryFence: fence, eventType: stale ? 'stale_reclaimed' : 'claimed', reasonCode: stale ? 'stale_owner_recovered' : 'claimed' });
    return { claimed: true, retryFence: fence, state: 'in_flight', retrySpent: spent + 1 };
  });
}

export async function settleContinuationRetry(input: { workspaceId: string; continuationKey: string; runtimeId: string; owner: string;
  retryFence: number; phase: 'retrieval' | 'transport'; outcome: 'succeeded' | 'retryable_failed' | 'permanent_conflict' | 'released';
  reasonCode: string; backoffSeconds?: number }): Promise<{ state: string; retryable: boolean; eventHash: string }> {
  return canonicalTransaction(async (client) => {
    await authorizeWave2Transaction(client, input.workspaceId,{operation:'continuation-retry.settle',request:input});
    const budget = await client.query<{ in_flight_owner: string | null; retry_fence: string; state: string; payload_json: unknown }>(
      `SELECT in_flight_owner,retry_fence,state,payload_json FROM continuation_retry_budgets
       WHERE workspace_id=$1 AND continuation_key=$2 FOR UPDATE`, [input.workspaceId, input.continuationKey]);
    const row = budget.rows[0]; if (!row) throw new NotFoundError('Continuation retry budget', input.continuationKey);
    if (row.state !== 'in_flight' || row.in_flight_owner !== input.owner || Number(row.retry_fence) !== input.retryFence) {
      throw new ConflictError('Retry settlement claim is stale', { reason: 'stale_fence' });
    }
    const parsed = ContinuationRetryBudgetV1Schema.safeParse(row.payload_json);
    if (!parsed.success) throw new UnprocessableError('Retry budget canonical subject is invalid', 'RETRY_SUBJECT_INVALID');
    if (parsed.data.scope.runtimeId !== input.runtimeId) throw new ConflictError('Retry runtime differs from canonical budget subject', { reason: 'identity_conflict' });
    await verifyActiveLeaseScope(client, parsed.data.scope);
    const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time'); const now = clock.rows[0]!.db_time;
    const state = input.outcome === 'succeeded' ? 'closed' : input.outcome === 'permanent_conflict' ? 'quarantined'
      : input.outcome === 'retryable_failed' ? 'backoff' : 'open';
    const backoff = input.outcome === 'retryable_failed' ? Math.min(Math.max(input.backoffSeconds ?? 1, 1), 300) : null;
    await client.query(`UPDATE continuation_retry_budgets SET state=$3,reason_code=$4,in_flight_owner=NULL,retry_expires_at=NULL,
      next_retry_at=$5,permanent_conflict_count=permanent_conflict_count+$6,state_version=state_version+1
      WHERE workspace_id=$1 AND continuation_key=$2`, [input.workspaceId, input.continuationKey, state, input.reasonCode,
      backoff ? new Date(now.getTime() + backoff * 1000) : null, input.outcome === 'permanent_conflict' ? 1 : 0]);
    if (state === 'quarantined') await client.query(`INSERT INTO continuation_quarantines
      (workspace_id,quarantine_id,continuation_key,reason_code,evidence_hash,state)
      SELECT $1,$2,$3,$4,$5,'open' WHERE NOT EXISTS(SELECT 1 FROM continuation_quarantines
        WHERE workspace_id=$1 AND continuation_key=$3)`, [input.workspaceId, `quarantine:${input.continuationKey.slice(-24)}`,
      input.continuationKey, input.reasonCode, stableHash('rorca.quarantine.v1', input)]);
    const eventHash = await appendContinuationRetryEvent(client, { ...input, eventType: input.outcome,
      reasonCode: input.reasonCode });
    return { state, retryable: state === 'backoff' || state === 'open', eventHash };
  });
}

export interface ContinuationReceiverPayloadV1{
  schemaVersion:'rorca.continuation-receiver-payload.v1';dispatchId:string;continuationKey:string;leaseId:string;
  fencingToken:number;bundleId:string;
}
export function continuationReceiverPayload(input:{dispatchId:string;continuationKey:string;leaseId:string;fencingToken:number;bundleId:string}):ContinuationReceiverPayloadV1{
  return {schemaVersion:'rorca.continuation-receiver-payload.v1',...input};
}
function receiverPayloadBytes(payload:ContinuationReceiverPayloadV1):Buffer{return Buffer.from(JSON.stringify(payload),'utf8');}
function receiverPayloadBytesHash(payloadBytes:Buffer):string{return `sha256:${crypto.createHash('sha256').update(payloadBytes).digest('hex')}`;}

export async function consumeContinuationDispatch(input: {
  workspaceId: string; dispatchId: string; continuationKey: string; leaseId: string; fencingToken: number;
  runtimeId: string;
}, context: GovernedMutationContext): Promise<{ consumed: boolean; duplicate: boolean; outboxState: string }> {
  assertGovernedPayloadSafe(input);
  const requestHash = stableHash('rorca.continuation-dispatch-consumption.v1', input);
  const subjectHash = stableHash('rorca.continuation-dispatch-consumption-subject.v1', { dispatchId: input.dispatchId, continuationKey: input.continuationKey });
  return canonicalTransaction(async (client) => {
    await authorizeWave2Transaction(client,input.workspaceId,{operation:'continuation-dispatch.consume',request:input,requestHash,subjectHash});
    const dispatch = await client.query<{ state: string; authorization_expires_at: Date; lease_id: string; fencing_token: string; bundle_id: string; activation_hash: string }>(
      `SELECT state,authorization_expires_at,lease_id,fencing_token,bundle_id,activation_hash FROM continuation_dispatches
       WHERE workspace_id=$1 AND dispatch_id=$2 AND continuation_key=$3 FOR UPDATE`, [input.workspaceId, input.dispatchId, input.continuationKey],
    );
    if (!dispatch.rows[0]) throw new NotFoundError('Continuation dispatch', input.dispatchId);
    const consumed = await client.query(`SELECT 1 FROM continuation_dispatch_consumptions WHERE workspace_id=$1 AND continuation_key=$2`, [input.workspaceId, input.continuationKey]);
    // Global dispatch hierarchy: dispatch -> outbox -> lease -> activation.
    const lockedOutbox = await client.query<{ state: string }>(`SELECT state FROM continuation_dispatch_outbox
      WHERE workspace_id=$1 AND dispatch_id=$2 FOR UPDATE`, [input.workspaceId, input.dispatchId]);
    const lease = await client.query<{ state: string; expires_at: Date; fencing_token: string; runtime_id: string; policy_activation_hash: string; bundle_hash: string }>(
      `SELECT state,expires_at,fencing_token,runtime_id,policy_activation_hash,bundle_hash FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`, [input.workspaceId, input.leaseId],
    );
    const time = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time'); const now = time.rows[0]!.db_time;
    if (!lease.rows[0] || lease.rows[0].state !== 'active' || lease.rows[0].expires_at <= now || dispatch.rows[0].authorization_expires_at <= now) throw new UnprocessableError('Lease or dispatch authorization expired', 'AUTHORIZATION_EXPIRED');
    if ((!consumed.rows[0] && dispatch.rows[0].state !== 'authorized') || (consumed.rows[0] && !['dispatched', 'settled'].includes(dispatch.rows[0].state))
      || dispatch.rows[0].lease_id !== input.leaseId || Number(dispatch.rows[0].fencing_token) !== input.fencingToken
      || Number(lease.rows[0].fencing_token) !== input.fencingToken || lease.rows[0].runtime_id !== input.runtimeId
      || lease.rows[0].policy_activation_hash !== dispatch.rows[0].activation_hash) throw new ConflictError('Dispatch lease verification failed', { reason: 'stale_fence' });
    const activation = await client.query(`SELECT 1 FROM context_policy_activation_heads
      WHERE workspace_id=$1 AND current_hash=$2 AND effective_state='active' FOR KEY SHARE`,
    [input.workspaceId, dispatch.rows[0].activation_hash]);
    if (!activation.rows[0]) throw new UnprocessableError('Dispatch policy activation is inactive', 'POLICY_ACTIVATION_INACTIVE');
    if (consumed.rows[0]) {
      if (!lockedOutbox.rows[0]) throw new UnprocessableError('Consumed dispatch is missing durable outbox publication', 'DISPATCH_OUTBOX_MISSING');
      await audit(client, { workspaceId: input.workspaceId, operation: 'continuation-dispatch.consume', actorId: context.principalId,
        authoritySource: context.authoritySource, requestHash, subjectHash, decision: 'accepted', resultCode: 'duplicate_revalidated', correlationId: context.correlationId });
      return { consumed: true, duplicate: true, outboxState: lockedOutbox.rows[0].state };
    }
    const casVerificationHash = stableHash('rorca.dispatch-cas-lease-verification.v1', { dispatchId: input.dispatchId,
      continuationKey: input.continuationKey, leaseId: input.leaseId, fencingToken: input.fencingToken,
      runtimeId: input.runtimeId, activationHash: dispatch.rows[0].activation_hash, observedAt: now.toISOString() });
    await client.query(`INSERT INTO continuation_dispatch_consumptions(workspace_id,dispatch_id,continuation_key,lease_verification_hash)
      VALUES($1,$2,$3,$4)`, [input.workspaceId, input.dispatchId, input.continuationKey, casVerificationHash]);
    const receiverPayload=continuationReceiverPayload({dispatchId:input.dispatchId,continuationKey:input.continuationKey,
      leaseId:input.leaseId,fencingToken:input.fencingToken,bundleId:dispatch.rows[0].bundle_id});
    await client.query(`INSERT INTO continuation_dispatch_outbox
      (workspace_id,dispatch_id,continuation_key,delivery_key,payload_hash,state)
      VALUES($1,$2,$3,$3,$4,'pending')`, [input.workspaceId, input.dispatchId, input.continuationKey,
      stableHash('rorca.continuation-dispatch-outbox-payload.v1',receiverPayload)]);
    await client.query(`UPDATE continuation_dispatches SET state='dispatched',cas_verification_hash=$3,state_version=state_version+1
      WHERE workspace_id=$1 AND dispatch_id=$2 AND state='authorized'`, [input.workspaceId, input.dispatchId, casVerificationHash]);
    await audit(client, { workspaceId: input.workspaceId, operation: 'continuation-dispatch.consume', actorId: context.principalId,
      authoritySource: context.authoritySource, requestHash, subjectHash, decision: 'accepted', resultCode: 'consumed', correlationId: context.correlationId });
    return { consumed: true, duplicate: false, outboxState: 'pending' };
  });
}

export async function claimContinuationDispatchOutbox(input: {
  workspaceId: string; dispatchId: string; owner: string; claimSeconds: number;
}): Promise<{ claimed: boolean; duplicate: boolean; state: string; claimFence: number; deliveryKey: string; payloadHash: string }> {
  if (!Number.isInteger(input.claimSeconds) || input.claimSeconds < 5 || input.claimSeconds > 300) throw new ValidationError('Dispatch claimSeconds must be 5-300');
  return canonicalTransaction(async (client) => {
    await authorizeWave2Transaction(client, input.workspaceId,{operation:'continuation-outbox.claim',request:input});
    const dispatch = await client.query<{ state: string; lease_id: string; fencing_token: string; activation_hash: string; authorization_expires_at: Date }>(
      `SELECT state,lease_id,fencing_token,activation_hash,authorization_expires_at FROM continuation_dispatches
       WHERE workspace_id=$1 AND dispatch_id=$2 FOR UPDATE`, [input.workspaceId, input.dispatchId]);
    const canonical = dispatch.rows[0]; if (!canonical) throw new NotFoundError('Continuation dispatch', input.dispatchId);
    const outbox = await client.query<{ state: string; claim_owner: string | null; claim_fence: string; claim_expires_at: Date | null;
      delivery_key: string; payload_hash: string }>(`SELECT state,claim_owner,claim_fence,claim_expires_at,delivery_key,payload_hash
      FROM continuation_dispatch_outbox WHERE workspace_id=$1 AND dispatch_id=$2 FOR UPDATE`, [input.workspaceId, input.dispatchId]);
    const row = outbox.rows[0]; if (!row) throw new NotFoundError('Continuation dispatch outbox', input.dispatchId);
    if (row.state === 'sent') return { claimed: false, duplicate: true, state: 'sent', claimFence: Number(row.claim_fence), deliveryKey: row.delivery_key, payloadHash: row.payload_hash };
    if (['failed', 'unknown', 'quarantined'].includes(row.state)) return { claimed: false, duplicate: false, state: row.state, claimFence: Number(row.claim_fence), deliveryKey: row.delivery_key, payloadHash: row.payload_hash };
    if (canonical.state !== 'dispatched') throw new ConflictError('Dispatch is not publication-ready', { reason: 'state_conflict' });
    const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time'); const now = clock.rows[0]!.db_time;
    if (row.state === 'claimed' && row.claim_expires_at && row.claim_expires_at > now) {
      return { claimed: row.claim_owner === input.owner, duplicate: row.claim_owner === input.owner, state: 'claimed',
        claimFence: Number(row.claim_fence), deliveryKey: row.delivery_key, payloadHash: row.payload_hash };
    }
    const lease = await client.query<{ state: string; expires_at: Date; fencing_token: string; policy_activation_hash: string }>(
      `SELECT state,expires_at,fencing_token,policy_activation_hash FROM execution_leases
       WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`, [input.workspaceId, canonical.lease_id]);
    const active = lease.rows[0];
    const activation = await client.query(`SELECT 1 FROM context_policy_activation_heads WHERE workspace_id=$1
      AND current_hash=$2 AND effective_state='active' FOR KEY SHARE`, [input.workspaceId, canonical.activation_hash]);
    if (!active || active.state !== 'active' || active.expires_at <= now || canonical.authorization_expires_at <= now
      || active.fencing_token !== canonical.fencing_token || active.policy_activation_hash !== canonical.activation_hash || !activation.rows[0]) {
      await client.query(`UPDATE continuation_dispatch_outbox SET state='quarantined',claim_owner=NULL,claim_expires_at=NULL,
        last_error_code='authority_stale_before_send',state_version=state_version+1,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND dispatch_id=$2`, [input.workspaceId, input.dispatchId]);
      return { claimed: false, duplicate: false, state: 'quarantined', claimFence: Number(row.claim_fence), deliveryKey: row.delivery_key, payloadHash: row.payload_hash };
    }
    const fence = Number(row.claim_fence) + 1;
    await client.query(`UPDATE continuation_dispatch_outbox SET state='claimed',claim_owner=$3,claim_fence=$4,
      claim_expires_at=$5,attempt_count=attempt_count+1,state_version=state_version+1,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND dispatch_id=$2`, [input.workspaceId, input.dispatchId, input.owner, fence,
      new Date(now.getTime() + input.claimSeconds * 1000)]);
    return { claimed: true, duplicate: false, state: 'claimed', claimFence: fence, deliveryKey: row.delivery_key, payloadHash: row.payload_hash };
  });
}

/**
 * Last authority check before transport. The delivery endpoint MUST use
 * deliveryKey as its idempotency key and MUST NOT accept a claim response as
 * send authority. The short-lived hash is required again at settlement.
 */
export async function authorizeContinuationDispatchSend(input: {
  workspaceId: string; dispatchId: string; owner: string; claimFence: number; deliveryKey: string; payloadHash: string;
}): Promise<{ authorized: true; sendAuthorizationHash: string; expiresAt: string; deliveryKey: string; payloadHash: string; payload:ContinuationReceiverPayloadV1 }> {
  return canonicalTransaction(async (client) => {
    await authorizeWave2Transaction(client, input.workspaceId,{operation:'continuation-outbox.authorize-send',request:input});
    const dispatch = await client.query<{ lease_id: string; fencing_token: string; activation_hash: string; authorization_expires_at: Date;
      continuation_key:string;bundle_id:string }>(
      `SELECT lease_id,fencing_token,activation_hash,authorization_expires_at,continuation_key,bundle_id FROM continuation_dispatches
       WHERE workspace_id=$1 AND dispatch_id=$2 AND state='dispatched' FOR UPDATE`, [input.workspaceId, input.dispatchId]);
    const canonical = dispatch.rows[0]; if (!canonical) throw new ConflictError('Dispatch is not send-authorizable', { reason: 'state_conflict' });
    const outbox = await client.query<{ state: string; claim_owner: string | null; claim_fence: string; claim_expires_at: Date | null;
      delivery_key: string; payload_hash: string }>(`SELECT state,claim_owner,claim_fence,claim_expires_at,delivery_key,payload_hash
      FROM continuation_dispatch_outbox WHERE workspace_id=$1 AND dispatch_id=$2 FOR UPDATE`, [input.workspaceId, input.dispatchId]);
    const row = outbox.rows[0];
    const lease = await client.query<{ state: string; expires_at: Date; fencing_token: string; policy_activation_hash: string }>(
      `SELECT state,expires_at,fencing_token,policy_activation_hash FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`,
    [input.workspaceId, canonical.lease_id]);
    const activation = await client.query(`SELECT 1 FROM context_policy_activation_heads WHERE workspace_id=$1
      AND current_hash=$2 AND effective_state='active' FOR KEY SHARE`, [input.workspaceId, canonical.activation_hash]);
    const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time'); const now = clock.rows[0]!.db_time;
    if (!row || row.state !== 'claimed' || row.claim_owner !== input.owner || Number(row.claim_fence) !== input.claimFence
      || !row.claim_expires_at || row.claim_expires_at <= now || row.delivery_key !== input.deliveryKey || row.payload_hash !== input.payloadHash
      || !lease.rows[0] || lease.rows[0].state !== 'active' || lease.rows[0].expires_at <= now
      || canonical.authorization_expires_at <= now || lease.rows[0].fencing_token !== canonical.fencing_token
      || lease.rows[0].policy_activation_hash !== canonical.activation_hash || !activation.rows[0]) {
      throw new ConflictError('Dispatch send authority is stale', { reason: 'authority_revoked_before_send' });
    }
    const expiresAt = new Date(Math.min(row.claim_expires_at.getTime(), canonical.authorization_expires_at.getTime(),
      lease.rows[0].expires_at.getTime(), now.getTime() + 5_000));
    const sendAuthorizationHash = stableHash('rorca.dispatch-send-authorization.v1', { ...input,
      leaseId: canonical.lease_id, fencingToken: Number(canonical.fencing_token), activationHash: canonical.activation_hash,
      authorizedAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
    const payload=continuationReceiverPayload({dispatchId:input.dispatchId,continuationKey:canonical.continuation_key,
      leaseId:canonical.lease_id,fencingToken:Number(canonical.fencing_token),bundleId:canonical.bundle_id});
    if(stableHash('rorca.continuation-dispatch-outbox-payload.v1',payload)!==row.payload_hash){
      throw new ConflictError('Dispatch receiver payload differs from the durable outbox hash',{reason:'payload_hash_mismatch'});
    }
    await client.query(`UPDATE continuation_dispatch_outbox SET send_authorization_hash=$3,send_authorized_at=$4,
      send_authorization_expires_at=$5,state_version=state_version+1,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND dispatch_id=$2`, [input.workspaceId, input.dispatchId, sendAuthorizationHash, now, expiresAt]);
    return { authorized: true, sendAuthorizationHash, expiresAt: expiresAt.toISOString(), deliveryKey: row.delivery_key, payloadHash: row.payload_hash,payload };
  });
}

export async function acceptContinuationDispatchDelivery(input: {
  workspaceId: string; dispatchId: string; owner: string; claimFence: number; sendAuthorizationHash: string;
  deliveryKey: string; payloadHash: string;payload:ContinuationReceiverPayloadV1;
}, receiverPrincipalId: string): Promise<{ accepted: true; duplicate: boolean; acceptanceReceiptHash: string; acceptedAt: string }> {
  assertGovernedPayloadSafe(input);
  if (receiverPrincipalId !== 'rorca-dispatch-receiver') {
    throw new ValidationError('Dispatch acceptance requires the dedicated receiver principal');
  }
  return canonicalTransaction(async (client) => {
    await authorizeWave2Transaction(client,input.workspaceId);
    const dispatch=await client.query<{lease_id:string;fencing_token:string;activation_hash:string;authorization_expires_at:Date;
      continuation_key:string;bundle_id:string}>(
      `SELECT lease_id,fencing_token,activation_hash,authorization_expires_at,continuation_key,bundle_id FROM continuation_dispatches
       WHERE workspace_id=$1 AND dispatch_id=$2 AND state='dispatched' FOR UPDATE`,[input.workspaceId,input.dispatchId]);
    const canonical=dispatch.rows[0];
    if(!canonical)throw new ConflictError('Dispatch is not receiver-acceptable',{reason:'state_conflict'});
    const outbox=await client.query<{state:string;claim_owner:string|null;claim_fence:string;claim_expires_at:Date|null;
      delivery_key:string;payload_hash:string;send_authorization_hash:string|null;send_authorization_expires_at:Date|null;
      send_authorization_consumed_at:Date|null}>(
      `SELECT state,claim_owner,claim_fence,claim_expires_at,delivery_key,payload_hash,send_authorization_hash,
              send_authorization_expires_at,send_authorization_consumed_at
         FROM continuation_dispatch_outbox WHERE workspace_id=$1 AND dispatch_id=$2 FOR UPDATE`,[input.workspaceId,input.dispatchId]);
    const row=outbox.rows[0];
    const payload=continuationReceiverPayload(input.payload);
    const payloadBytes=receiverPayloadBytes(payload);
    const payloadBytesHash=receiverPayloadBytesHash(payloadBytes);
    const canonicalPayloadHash=stableHash('rorca.continuation-dispatch-outbox-payload.v1',payload);
    if(payload.dispatchId!==input.dispatchId||payload.continuationKey!==canonical.continuation_key
      ||payload.leaseId!==canonical.lease_id||payload.fencingToken!==Number(canonical.fencing_token)
      ||payload.bundleId!==canonical.bundle_id||canonicalPayloadHash!==input.payloadHash){
      throw new ConflictError('Receiver rejected payload bytes outside the exact dispatch authority',{reason:'payload_hash_mismatch'});
    }
    const prior=await client.query<{acceptance_receipt_hash:string;accepted_at:Date;receiver_id:string;send_authorization_hash:string;
      delivery_key:string;payload_hash:string;claim_fence:string;receiver_enforced:boolean}>(`SELECT acceptance.acceptance_receipt_hash,
        acceptance.accepted_at,acceptance.receiver_id,acceptance.send_authorization_hash,acceptance.delivery_key,
        acceptance.payload_hash,acceptance.claim_fence,(inbox.dispatch_id IS NOT NULL) receiver_enforced
        FROM continuation_dispatch_acceptances acceptance LEFT JOIN continuation_dispatch_receiver_inbox inbox
          ON inbox.workspace_id=acceptance.workspace_id AND inbox.dispatch_id=acceptance.dispatch_id
        WHERE acceptance.workspace_id=$1 AND acceptance.dispatch_id=$2`,[input.workspaceId,input.dispatchId]);
    if(prior.rows[0]){
      const exact=prior.rows[0];
      if(exact.receiver_enforced&&exact.receiver_id===receiverPrincipalId&&exact.send_authorization_hash===input.sendAuthorizationHash
        &&exact.delivery_key===input.deliveryKey&&exact.payload_hash===input.payloadHash&&Number(exact.claim_fence)===input.claimFence){
        return {accepted:true,duplicate:true,acceptanceReceiptHash:exact.acceptance_receipt_hash,acceptedAt:exact.accepted_at.toISOString()};
      }
      throw new ConflictError('Dispatch receiver authorization was already consumed by a different subject',{reason:'send_authorization_consumed'});
    }
    const lease=await client.query<{state:string;expires_at:Date;fencing_token:string;policy_activation_hash:string}>(
      `SELECT state,expires_at,fencing_token,policy_activation_hash FROM execution_leases
       WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`,[input.workspaceId,canonical.lease_id]);
    const activation=await client.query(`SELECT 1 FROM context_policy_activation_heads WHERE workspace_id=$1
      AND current_hash=$2 AND effective_state='active' FOR KEY SHARE`,[input.workspaceId,canonical.activation_hash]);
    const clock=await client.query<{db_time:Date}>('SELECT clock_timestamp() db_time');const now=clock.rows[0]!.db_time;
    if(!row||row.state!=='claimed'||row.claim_owner!==input.owner||Number(row.claim_fence)!==input.claimFence
      ||!row.claim_expires_at||row.claim_expires_at<=now||row.delivery_key!==input.deliveryKey||row.payload_hash!==input.payloadHash
      ||row.send_authorization_hash!==input.sendAuthorizationHash||!row.send_authorization_expires_at
      ||row.send_authorization_expires_at<=now||row.send_authorization_consumed_at
      ||!lease.rows[0]||lease.rows[0].state!=='active'||lease.rows[0].expires_at<=now
      ||canonical.authorization_expires_at<=now||lease.rows[0].fencing_token!==canonical.fencing_token
      ||lease.rows[0].policy_activation_hash!==canonical.activation_hash||!activation.rows[0]){
      throw new ConflictError('Receiver rejected stale, expired, cancelled, or revoked dispatch authority',{reason:'authority_revoked_before_acceptance'});
    }
    const acceptanceReceiptHash=stableHash('rorca.dispatch-receiver-acceptance.v1',{...input,receiverPrincipalId,
      leaseId:canonical.lease_id,fencingToken:Number(canonical.fencing_token),activationHash:canonical.activation_hash,
      acceptedAt:now.toISOString()});
    await authorizeWave2Transaction(client,input.workspaceId,{operation:'continuation-outbox.accept',
      request:{...input,receiverPrincipalId,acceptanceReceiptHash,acceptedAt:now.toISOString(),payloadBytesHash}});
    const consumed=await client.query(`UPDATE continuation_dispatch_outbox SET send_authorization_consumed_at=$3,
      receiver_acceptance_receipt_hash=$4,receiver_accepted_at=$3,state_version=state_version+1,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND dispatch_id=$2 AND send_authorization_consumed_at IS NULL`,
    [input.workspaceId,input.dispatchId,now,acceptanceReceiptHash]);
    if(consumed.rowCount!==1)throw new ConflictError('Receiver acceptance CAS was lost',{reason:'send_authorization_consumed'});
    await client.query(`INSERT INTO continuation_dispatch_acceptances(workspace_id,dispatch_id,claim_fence,send_authorization_hash,
      delivery_key,payload_hash,receiver_id,acceptance_receipt_hash,accepted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.workspaceId,input.dispatchId,input.claimFence,input.sendAuthorizationHash,input.deliveryKey,input.payloadHash,
      receiverPrincipalId,acceptanceReceiptHash,now]);
    // This is the actual receiver-side transport effect: exact payload bytes,
    // one-use authorization consumption, and durable acceptance commit in one transaction.
    await client.query(`SELECT insert_continuation_receiver_inbox_v2($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.workspaceId,input.dispatchId,receiverPrincipalId,acceptanceReceiptHash,input.deliveryKey,input.payloadHash,now,
      payloadBytes,payloadBytesHash]);
    return {accepted:true,duplicate:false,acceptanceReceiptHash,acceptedAt:now.toISOString()};
  });
}

export async function settleContinuationDispatchOutbox(input: {
  workspaceId: string; dispatchId: string; owner: string; claimFence: number; sendAuthorizationHash: string;
  receiverAcceptanceReceiptHash: string | null;
  outcome: 'sent' | 'failed_retryable' | 'failed_permanent' | 'unknown'; transportAccepted: boolean;
  transportReceiptHash: string | null; reasonCode: string;
}): Promise<{ state: string; outcomeHash: string; retryable: boolean }> {
  assertGovernedPayloadSafe(input);
  return canonicalTransaction(async (client) => {
    await authorizeWave2Transaction(client,input.workspaceId);
    const dispatch = await client.query<{ state: string; lease_id: string; fencing_token: string; activation_hash: string; authorization_expires_at: Date }>(
      `SELECT state,lease_id,fencing_token,activation_hash,authorization_expires_at FROM continuation_dispatches
       WHERE workspace_id=$1 AND dispatch_id=$2 FOR UPDATE`, [input.workspaceId, input.dispatchId]);
    const canonical = dispatch.rows[0]; if (!canonical) throw new NotFoundError('Continuation dispatch', input.dispatchId);
    const outbox = await client.query<{ state: string; claim_owner: string | null; claim_fence: string; claim_expires_at: Date | null;
      send_authorization_hash: string | null; send_authorization_expires_at: Date | null }>(
      `SELECT state,claim_owner,claim_fence,claim_expires_at,send_authorization_hash,send_authorization_expires_at FROM continuation_dispatch_outbox
       WHERE workspace_id=$1 AND dispatch_id=$2 FOR UPDATE`, [input.workspaceId, input.dispatchId]);
    const row = outbox.rows[0]; if (!row) throw new NotFoundError('Continuation dispatch outbox', input.dispatchId);
    if (row.state !== 'claimed' || row.claim_owner !== input.owner || Number(row.claim_fence) !== input.claimFence) {
      throw new ConflictError('Dispatch outbox claim is stale', { reason: 'stale_fence' });
    }
    if (input.transportAccepted && (!input.transportReceiptHash || !input.receiverAcceptanceReceiptHash)) {
      throw new ValidationError('Accepted transport outcome requires transport and receiver-acceptance receipts');
    }
    if (input.outcome === 'sent' && !input.transportAccepted) throw new ValidationError('Sent outcome requires transport acceptance');
    if (row.send_authorization_hash !== input.sendAuthorizationHash || !row.send_authorization_expires_at) {
      throw new ConflictError('Dispatch send authorization is absent or changed', { reason: 'stale_send_authorization' });
    }
    const acceptance = await client.query<{ acceptance_receipt_hash:string;send_authorization_hash:string;claim_fence:string }>(
      `SELECT acceptance.acceptance_receipt_hash,acceptance.send_authorization_hash,acceptance.claim_fence
         FROM continuation_dispatch_acceptances acceptance JOIN continuation_dispatch_receiver_inbox inbox
           ON inbox.workspace_id=acceptance.workspace_id AND inbox.dispatch_id=acceptance.dispatch_id
          AND inbox.acceptance_receipt_hash=acceptance.acceptance_receipt_hash AND inbox.state='accepted'
        WHERE acceptance.workspace_id=$1 AND acceptance.dispatch_id=$2`,[input.workspaceId,input.dispatchId]);
    if(input.transportAccepted && (!acceptance.rows[0]
      || acceptance.rows[0].acceptance_receipt_hash!==input.receiverAcceptanceReceiptHash
      || acceptance.rows[0].send_authorization_hash!==input.sendAuthorizationHash
      || Number(acceptance.rows[0].claim_fence)!==input.claimFence)){
      throw new ConflictError('Transport acceptance lacks exact receiver-enforced authority',{reason:'receiver_acceptance_missing'});
    }
    const lease = await client.query<{ state: string; expires_at: Date; fencing_token: string; policy_activation_hash: string }>(
      `SELECT state,expires_at,fencing_token,policy_activation_hash FROM execution_leases
       WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`, [input.workspaceId, canonical.lease_id]);
    const active = lease.rows[0];
    const authority = await client.query(`SELECT 1 FROM context_policy_activation_heads WHERE workspace_id=$1
      AND current_hash=$2 AND effective_state='active' FOR KEY SHARE`, [input.workspaceId, canonical.activation_hash]);
    const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time');
    const authorityCurrent = active && active.state === 'active' && active.expires_at > clock.rows[0]!.db_time
      && canonical.authorization_expires_at > clock.rows[0]!.db_time && active.fencing_token === canonical.fencing_token
      && active.policy_activation_hash === canonical.activation_hash && Boolean(authority.rows[0]);
    const sendAuthorizationCurrent = row.send_authorization_expires_at > clock.rows[0]!.db_time;
    const effectiveOutcome = input.outcome === 'sent' && (!authorityCurrent || !sendAuthorizationCurrent) ? 'unknown' : input.outcome;
    const effectiveReason = effectiveOutcome === 'unknown' && input.outcome === 'sent' ? 'authority_revoked_or_expired_after_send' : input.reasonCode;
    const outcomeHash = stableHash('rorca.continuation-dispatch-outcome.v1', { ...input, outcome: effectiveOutcome, reasonCode: effectiveReason });
    const state = effectiveOutcome === 'sent' ? 'sent'
      : effectiveOutcome === 'failed_retryable' && !input.transportAccepted ? 'pending'
        : effectiveOutcome === 'failed_permanent' ? 'failed' : 'unknown';
    const dispatchState=state === 'sent' ? 'settled' : state === 'failed' ? 'failed' : state === 'unknown' ? 'quarantined' : 'dispatched';
    await authorizeWave2Transaction(client,input.workspaceId,{operation:'continuation-outbox.settle',
      request:{...input,effectiveOutcome,effectiveReason,outcomeHash,state,dispatchState}});
    const sequence = await client.query<{ next: string }>(`SELECT COALESCE(max(outcome_sequence),0)+1 next
      FROM continuation_dispatch_outcomes WHERE workspace_id=$1 AND dispatch_id=$2`, [input.workspaceId, input.dispatchId]);
    await client.query(`INSERT INTO continuation_dispatch_outcomes
      (workspace_id,dispatch_id,outcome_sequence,claim_fence,outcome_hash,outcome_state,transport_accepted,transport_receipt_hash,reason_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.workspaceId, input.dispatchId, sequence.rows[0]!.next,
      input.claimFence, outcomeHash, effectiveOutcome, input.transportAccepted, input.transportReceiptHash, effectiveReason]);
    await client.query(`UPDATE continuation_dispatch_outbox SET state=$3,claim_owner=NULL,claim_expires_at=NULL,
      transport_receipt_hash=$4,last_error_code=$5,state_version=state_version+1,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND dispatch_id=$2`, [input.workspaceId, input.dispatchId, state,
      input.transportReceiptHash, input.outcome === 'sent' ? null : input.reasonCode]);
    await client.query(`UPDATE continuation_dispatches SET state=$3,state_version=state_version+1 WHERE workspace_id=$1 AND dispatch_id=$2`,
      [input.workspaceId, input.dispatchId, dispatchState]);
    return { state, outcomeHash, retryable: state === 'pending' };
  });
}

export async function evaluateGovernedCloseout(candidate: unknown, context: GovernedMutationContext) {
  const evaluation = CloseoutEvaluationV1Schema.parse(candidate);
  return runIdempotentMutation({ workspaceId: evaluation.workspaceId, operation: 'closeout.evaluate', ...context,
    request: evaluation, subject: { evaluationId: evaluation.evaluationId, attemptId: evaluation.attemptId },
    mutate: async (client) => {
      const lease = await client.query<{ attempt_id: string; fencing_token: string; work_package_revision: number;
        policy_activation_hash: string; checkpoint_hash: string; current_sha: string; worktree_id: string; state: string;
        expires_at: Date; mission_id: string; work_package_id: string; mission_revision: number; payload_json: unknown;
        run_id: string; story_id: string; evidence_obligation_set_id: string | null; evidence_obligation_policy_id: string | null;
        evidence_obligation_policy_revision: string | null; evidence_obligation_policy_hash: string | null;
        evidence_obligation_manifest_hash: string | null }>(
        `SELECT l.attempt_id,l.fencing_token,l.work_package_revision,l.policy_activation_hash,l.checkpoint_hash,l.current_sha,
                l.worktree_id,l.state,l.expires_at,a.mission_id,a.work_package_id,a.run_id,a.story_id,w.mission_revision,w.payload_json,
                w.evidence_obligation_set_id,w.evidence_obligation_policy_id,w.evidence_obligation_policy_revision,
                w.evidence_obligation_policy_hash,w.evidence_obligation_manifest_hash
         FROM execution_leases l JOIN governed_execution_attempts a ON a.workspace_id=l.workspace_id AND a.attempt_id=l.attempt_id
         JOIN governed_work_package_revisions w ON w.workspace_id=a.workspace_id AND w.mission_id=a.mission_id
          AND w.work_package_id=a.work_package_id AND w.work_package_revision=a.work_package_revision
         WHERE l.workspace_id=$1 AND l.lease_id=$2 FOR KEY SHARE OF w FOR UPDATE OF l`,
        [evaluation.workspaceId, evaluation.leaseId]);
      const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time');
      const leased = lease.rows[0];
      const workPackage = leased ? WorkPackageV1Schema.parse(leased.payload_json) : null;
      const exact = leased && leased.attempt_id === evaluation.attemptId && Number(leased.fencing_token) === evaluation.fencingToken
        && leased.mission_id === evaluation.missionId && leased.mission_revision === evaluation.missionRevision
        && leased.work_package_id === evaluation.workPackageId && leased.work_package_revision === evaluation.workPackageRevision
        && leased.policy_activation_hash === evaluation.policyActivationHash && leased.checkpoint_hash === evaluation.checkpointHash
        && leased.current_sha === evaluation.repositoryRevision && leased.worktree_id === evaluation.worktreeId
        && workPackage?.spec.specHash === evaluation.specHash && workPackage.spec.storyHash === evaluation.storyHash;
      if (!exact || !leased || !workPackage) throw new ConflictError('Closeout subject does not match exact leased revision', { reason: 'identity_conflict' });
      const activePolicy = await client.query(`SELECT 1 FROM context_policy_activation_heads h
        JOIN context_policy_activations a ON a.workspace_id=h.workspace_id AND a.activation_id=h.activation_id AND a.activation_revision=h.current_revision
        WHERE h.workspace_id=$1 AND h.current_hash=$2 AND h.effective_state='active'
          AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp()) FOR KEY SHARE OF h,a`,
      [evaluation.workspaceId, evaluation.policyActivationHash]);
      const checkpoint = await client.query<{ checkpoint_id: string }>(`SELECT checkpoint_id FROM context_checkpoints
        WHERE workspace_id=$1 AND lease_id=$2 AND fencing_token=$3 AND checkpoint_hash=$4 FOR KEY SHARE`,
      [evaluation.workspaceId, evaluation.leaseId, evaluation.fencingToken, evaluation.checkpointHash]);
      if (!checkpoint.rows[0]) throw new ConflictError('Closeout checkpoint lineage is missing', { reason: 'identity_conflict' });
      if (!leased.evidence_obligation_set_id || !leased.evidence_obligation_policy_id
        || !leased.evidence_obligation_policy_revision || !leased.evidence_obligation_policy_hash
        || !leased.evidence_obligation_manifest_hash || evaluation.obligationSetId !== leased.evidence_obligation_set_id
        || evaluation.obligationSetHash !== leased.evidence_obligation_manifest_hash
        || evaluation.policyVersion !== String(leased.evidence_obligation_policy_revision)) {
        throw new UnprocessableError('Closeout obligation set or policy version differs from the work-package binding', 'CLOSEOUT_OBLIGATION_BINDING_MISMATCH');
      }
      const obligationSet = await client.query<{ obligation_policy_id: string; obligation_policy_revision: string;
        obligation_policy_hash: string; manifest_hash: string; manifest_json: unknown }>(`SELECT obligation_policy_id,
          obligation_policy_revision,obligation_policy_hash,manifest_hash,manifest_json
        FROM governed_evidence_obligation_sets WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3
          AND work_package_revision=$4 AND obligation_set_id=$5`,
      [evaluation.workspaceId,evaluation.missionId,evaluation.workPackageId,evaluation.workPackageRevision,evaluation.obligationSetId]);
      const boundSet = obligationSet.rows[0];
      if (!boundSet || boundSet.obligation_policy_id !== leased.evidence_obligation_policy_id
        || boundSet.obligation_policy_revision !== leased.evidence_obligation_policy_revision
        || boundSet.obligation_policy_hash !== leased.evidence_obligation_policy_hash
        || boundSet.manifest_hash !== evaluation.obligationSetHash || !Array.isArray(boundSet.manifest_json)
        || stableHash('rorca.evidence-obligation-manifest.v1', boundSet.manifest_json) !== boundSet.manifest_hash) {
        throw new UnprocessableError('Canonical closeout obligation policy/set is absent or substituted', 'CLOSEOUT_OBLIGATION_SET_INVALID');
      }
      const obligations = await client.query<{ obligation_order: number; obligation_kind: string; minimum_trust: string;
        required_status: string; obligation_hash: string }>(
        `SELECT obligation_order,obligation_kind,minimum_trust,required_status,obligation_hash FROM governed_evidence_obligations
         WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3 AND work_package_revision=$4
           AND obligation_set_id=$5 ORDER BY obligation_order`,
      [evaluation.workspaceId, evaluation.missionId, evaluation.workPackageId, evaluation.workPackageRevision,evaluation.obligationSetId]);
      const canonicalManifest = obligations.rows.map((row) => ({ kind: row.obligation_kind, minimumTrust: row.minimum_trust,
        requiredStatus: row.required_status, obligationHash: row.obligation_hash }));
      if (obligations.rows.length === 0 || stableHash('rorca.evidence-obligation-manifest.v1', canonicalManifest) !== evaluation.obligationSetHash) {
        throw new UnprocessableError('Canonical evidence obligation rows do not match the bound digest', 'EVIDENCE_OBLIGATIONS_MISSING');
      }
      const found = await client.query<{ source_idempotency_key: string; governed_contract_hash: string; evidence_status: string;
        evidence_type: string; trust_level: string; revision_mismatch: boolean; lineage_verified: boolean; governed_mission_id: string;
        governed_work_package_id: string; governed_spec_id: string; governed_spec_version: number; governed_spec_hash: string;
        governed_story_id: string; governed_story_version: number; governed_story_hash: string; governed_attempt_id: string;
        governed_lease_id: string; governed_fencing_token: string; governed_activation_hash: string;
        governed_checkpoint_id: string; governed_repository_id: string; governed_worktree_id: string }>(
        `SELECT source_idempotency_key,governed_contract_hash,
                CASE evidence_status WHEN 'story_caused_failure' THEN 'failed' ELSE evidence_status END evidence_status,
                evidence_type,trust_level,revision_mismatch,lineage_verified,
                governed_mission_id,governed_work_package_id,governed_spec_id,governed_spec_version,governed_spec_hash,
                governed_story_id,governed_story_version,governed_story_hash,governed_attempt_id,governed_lease_id,
                governed_fencing_token,governed_activation_hash,governed_checkpoint_id,governed_repository_id,governed_worktree_id
         FROM ssdlc_lifecycle_evidence WHERE workspace_id=$1 AND source_system='governed-mission'
           AND source_idempotency_key=ANY($2::text[])`, [evaluation.workspaceId, evaluation.evidence.map((item) => item.evidenceId)],
      );
      const byId = new Map(found.rows.map((row) => [row.source_idempotency_key, row]));
      const trustRank = (value: string) => ['agent_proposed', 'host_observed', 'automated_test', 'provider_verified', 'authenticated_manual'].indexOf(value);
      const requiredTrust = (value: string) => value === 'provider_human' ? 'authenticated_manual' : value;
      const selectedRows = evaluation.evidence.flatMap((item) => { const row = byId.get(item.evidenceId); return row ? [row] : []; });
      const eligibleLineage = (row: typeof found.rows[number]) => !row.revision_mismatch && row.lineage_verified
        && row.governed_mission_id === evaluation.missionId && row.governed_work_package_id === evaluation.workPackageId
        && row.governed_spec_id === workPackage.spec.specId && row.governed_spec_version === workPackage.spec.specVersion
        && row.governed_spec_hash === evaluation.specHash && row.governed_story_id === workPackage.spec.storyId
        && row.governed_story_version === workPackage.spec.storyVersion && row.governed_story_hash === evaluation.storyHash
        && row.governed_attempt_id === evaluation.attemptId && row.governed_lease_id === evaluation.leaseId
        && Number(row.governed_fencing_token) === evaluation.fencingToken
        && row.governed_activation_hash === evaluation.policyActivationHash
        && row.governed_checkpoint_id === checkpoint.rows[0]!.checkpoint_id
        && row.governed_repository_id === workPackage.repository.repositoryId
        && row.governed_worktree_id === evaluation.worktreeId;
      const missing = obligations.rows.filter((obligation) => !selectedRows.some((row) => row.evidence_type === obligation.obligation_kind
        && trustRank(row.trust_level) >= trustRank(requiredTrust(obligation.minimum_trust)) && eligibleLineage(row)))
        .map((obligation) => obligation.obligation_kind);
      const conflicting = evaluation.evidence.filter((item) => {
        const row = byId.get(item.evidenceId);
        return Boolean(row && (row.governed_contract_hash !== item.evidenceHash
          || ['unknown','conflicted','cancelled'].includes(row.evidence_status)
          || row.trust_level === 'agent_proposed' || !eligibleLineage(row)
          || row.revision_mismatch || !row.lineage_verified
          || row.governed_mission_id !== evaluation.missionId || row.governed_work_package_id !== evaluation.workPackageId
          || row.governed_spec_id !== workPackage.spec.specId || row.governed_spec_version !== workPackage.spec.specVersion
          || row.governed_spec_hash !== evaluation.specHash || row.governed_story_id !== workPackage.spec.storyId
          || row.governed_story_version !== workPackage.spec.storyVersion || row.governed_story_hash !== evaluation.storyHash
          || row.governed_attempt_id !== evaluation.attemptId || row.governed_lease_id !== evaluation.leaseId
          || Number(row.governed_fencing_token) !== evaluation.fencingToken
          || row.governed_activation_hash !== evaluation.policyActivationHash
          || row.governed_checkpoint_id !== checkpoint.rows[0]!.checkpoint_id
          || row.governed_repository_id !== workPackage.repository.repositoryId
          || row.governed_worktree_id !== evaluation.worktreeId));
      }).map((item) => item.evidenceId);
      // Failure evidence is never completion-eligible. `required_status='failed'`
      // means the policy requires observing a terminal failure, not that the
      // failure satisfies successful closeout.
      const hasFailedEvidence = obligations.rows.some((obligation) => selectedRows.some((row) =>
        row.evidence_type === obligation.obligation_kind
          && evaluateEvidenceStatusPolicy(obligation.required_status as 'passed'|'failed',row.evidence_status) === 'failed'
          && trustRank(row.trust_level) >= trustRank(requiredTrust(obligation.minimum_trust)) && eligibleLineage(row)));
      const hasStatusPolicyMismatch = hasFailedEvidence;
      const outcome = leased.state === 'cancelled' ? 'cancelled'
        : leased.state === 'expired' || leased.expires_at <= clock.rows[0]!.db_time ? 'expired'
          : leased.state !== 'active' ? 'reconciliation_required'
            : !activePolicy.rows[0] ? 'stale'
              : conflicting.length > 0 ? 'conflicted' : (hasFailedEvidence || hasStatusPolicyMismatch) ? 'failed'
                : missing.length > 0 ? 'blocked' : 'eligible';
      const sameMembers = (left: string[], right: string[]) => left.length === right.length
        && [...left].sort().every((value, index) => value === [...right].sort()[index]);
      if (evaluation.outcome !== outcome || !sameMembers(evaluation.missingEvidenceKinds, missing)
        || !sameMembers(evaluation.conflictingEvidenceIds, conflicting)) {
        throw new UnprocessableError('Closeout result is server-evaluated from canonical evidence', 'CLOSEOUT_EVALUATION_MISMATCH', { expectedOutcome: outcome, missing, conflicting });
      }
      if (evaluation.storyCloseoutDecisionId && outcome !== 'eligible') {
        throw new UnprocessableError('Only an eligible evaluation may reference a StoryCloseoutDecision', 'CLOSEOUT_DECISION_NOT_ELIGIBLE');
      }
      if (evaluation.storyCloseoutDecisionId) {
        const decision = await client.query(`SELECT 1 FROM story_closeout_decisions
          WHERE decision_id=$1 AND workspace_id=$2 AND spec_id=$3 AND run_id=$4 AND story_id=$5 AND status='accepted'
          FOR KEY SHARE`, [evaluation.storyCloseoutDecisionId, evaluation.workspaceId, workPackage.spec.specId,
          Number(leased.run_id), workPackage.spec.storyId]);
        if (!decision.rows[0]) throw new ConflictError('Story closeout decision does not match exact accepted subject', { reason: 'identity_conflict' });
      }
      const subjectHash = stableHash('rorca.closeout-subject.v1', {
        missionId: evaluation.missionId, missionRevision: evaluation.missionRevision,
        workPackageId: evaluation.workPackageId, workPackageRevision: evaluation.workPackageRevision,
        specHash: evaluation.specHash, storyHash: evaluation.storyHash, attemptId: evaluation.attemptId,
        leaseId: evaluation.leaseId, fencingToken: evaluation.fencingToken,
        policyActivationHash: evaluation.policyActivationHash, checkpointHash: evaluation.checkpointHash,
        repositoryRevision: evaluation.repositoryRevision, worktreeId: evaluation.worktreeId,
      });
      const evidenceManifestHash = stableHash('rorca.closeout-evidence-manifest.v1', evaluation.evidence);
      const payloadHash = stableHash('rorca.closeout-evaluation-payload.v1', evaluation);
      await client.query(`INSERT INTO governed_closeout_evaluations
        (workspace_id,evaluation_id,attempt_id,lease_id,fencing_token,work_package_id,work_package_revision,policy_activation_hash,
         checkpoint_hash,evidence_manifest_hash,resolver_version,outcome,missing_evidence,conflicting_evidence,subject_hash,
         story_closeout_decision_id,decision_time,payload_hash,obligation_set_id,obligation_policy_id,
         obligation_policy_revision,obligation_policy_hash,obligation_manifest_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [evaluation.workspaceId, evaluation.evaluationId, evaluation.attemptId, evaluation.leaseId, evaluation.fencingToken,
        evaluation.workPackageId, evaluation.workPackageRevision, evaluation.policyActivationHash, evaluation.checkpointHash,
        evidenceManifestHash, evaluation.resolverVersion, outcome, asJson(missing), asJson(conflicting), subjectHash,
        evaluation.storyCloseoutDecisionId, evaluation.decisionTime, payloadHash,evaluation.obligationSetId,
        leased.evidence_obligation_policy_id,Number(leased.evidence_obligation_policy_revision),
        leased.evidence_obligation_policy_hash,evaluation.obligationSetHash]);
      return { evaluationId: evaluation.evaluationId, outcome, missingEvidenceIds: missing, conflictingEvidenceIds: conflicting,
        establishesStoryCompletion: false, storyCloseoutDecisionId: evaluation.storyCloseoutDecisionId };
    } });
}

export async function requestExecutionCancellation(candidate: unknown, context: GovernedMutationContext) {
  const cancellation = CancellationV1Schema.parse(candidate);
  if (cancellation.disposition !== 'requested' || cancellation.acknowledgementId !== null || cancellation.acknowledgedAt !== null) {
    throw new ValidationError('Cancellation request must begin in requested state without acknowledgement');
  }
  return runIdempotentMutation({ workspaceId: cancellation.workspaceId, operation: 'cancellation.request', ...context,
    request: cancellation, subject: { cancellationId: cancellation.cancellationId, leaseId: cancellation.leaseId },
    mutate: async (client) => {
      const locator = await client.query<{ lease_slot_key: string }>(`SELECT lease_slot_key FROM execution_leases
        WHERE workspace_id=$1 AND lease_id=$2`, [cancellation.workspaceId, cancellation.leaseId]);
      if (!locator.rows[0]) throw new NotFoundError('Execution lease', cancellation.leaseId);
      await client.query(`SELECT 1 FROM execution_lease_slots WHERE workspace_id=$1 AND lease_slot_key=$2 FOR UPDATE`,
        [cancellation.workspaceId, locator.rows[0].lease_slot_key]);
      const lease = await client.query<{ attempt_id: string; fencing_token: string; state: string }>(
        `SELECT attempt_id,fencing_token,state FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2 FOR UPDATE`,
        [cancellation.workspaceId, cancellation.leaseId]);
      if (!lease.rows[0] || lease.rows[0].attempt_id !== cancellation.attemptId
        || Number(lease.rows[0].fencing_token) !== cancellation.fencingToken) {
        throw new ConflictError('Cancellation subject or fence mismatch', { reason: 'stale_fence' });
      }
      if (lease.rows[0].state !== 'active') throw new ConflictError('Lease is no longer cancellable', { reason: 'lease_inactive' });
      await client.query(`INSERT INTO execution_cancellation_requests
        (workspace_id,cancellation_id,attempt_id,lease_id,fencing_token,requester_authority_ref,reason_code,requested_at,deadline_at,state,request_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'requested',$10)`, [cancellation.workspaceId, cancellation.cancellationId,
        cancellation.attemptId, cancellation.leaseId, cancellation.fencingToken, cancellation.requesterAuthorityRef,
        cancellation.reasonCode, cancellation.requestedAt, cancellation.deadlineAt,
        stableHash('rorca.cancellation-request-payload.v1', cancellation)]);
      await client.query(`UPDATE execution_leases SET state='cancelled',state_version=state_version+1
        WHERE workspace_id=$1 AND lease_id=$2 AND state='active'`, [cancellation.workspaceId, cancellation.leaseId]);
      await client.query(`INSERT INTO execution_lease_events(workspace_id,lease_id,fencing_token,event_type,prior_state,next_state,reason_code,event_hash)
        VALUES($1,$2,$3,'cancellation_requested','active','cancelled',$4,$5)`, [cancellation.workspaceId, cancellation.leaseId,
        cancellation.fencingToken, cancellation.reasonCode, stableHash('rorca.lease-event.v1', { cancellationId: cancellation.cancellationId, type: 'cancellation_requested' })]);
      return { cancellationId: cancellation.cancellationId, requestState: 'requested', effectiveDisposition: 'requested',
        requestRowImmutable: true, leaseAuthorityRevoked: true };
    } });
}

export async function acknowledgeExecutionCancellation(candidate: unknown, runtimeId: string, context: GovernedMutationContext) {
  const acknowledgement = CancellationV1Schema.parse(candidate);
  if (!acknowledgement.acknowledgementId || !acknowledgement.acknowledgedAt || acknowledgement.disposition === 'requested') {
    throw new ValidationError('Cancellation acknowledgement identity, time, and disposition are required');
  }
  return runIdempotentMutation({ workspaceId: acknowledgement.workspaceId, operation: 'cancellation.acknowledge', ...context,
    request: { acknowledgement, runtimeId }, subject: { cancellationId: acknowledgement.cancellationId, acknowledgementId: acknowledgement.acknowledgementId },
    mutate: async (client) => {
      const request = await client.query<{ attempt_id: string; lease_id: string; fencing_token: string; deadline_at: Date; state: string }>(
        `SELECT attempt_id,lease_id,fencing_token,deadline_at,state FROM execution_cancellation_requests
         WHERE workspace_id=$1 AND cancellation_id=$2 FOR UPDATE`, [acknowledgement.workspaceId, acknowledgement.cancellationId]);
      if (!request.rows[0]) throw new NotFoundError('Cancellation request', acknowledgement.cancellationId);
      const lease = await client.query<{ runtime_id: string }>(`SELECT runtime_id FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2 FOR KEY SHARE`,
        [acknowledgement.workspaceId, request.rows[0].lease_id]);
      const dbTime = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time');
      const priorAccepted = await client.query(`SELECT 1 FROM execution_cancellation_acknowledgements
        WHERE workspace_id=$1 AND cancellation_id=$2 AND classification='accepted' LIMIT 1`,
      [acknowledgement.workspaceId, acknowledgement.cancellationId]);
      const classification = request.rows[0].state !== 'requested' || Boolean(priorAccepted.rows[0]) ? 'duplicate'
        : request.rows[0].lease_id !== acknowledgement.leaseId || request.rows[0].attempt_id !== acknowledgement.attemptId ? 'contradictory'
          : Number(request.rows[0].fencing_token) !== acknowledgement.fencingToken ? 'wrong_fence'
            : lease.rows[0]?.runtime_id !== runtimeId ? 'wrong_runtime'
              : request.rows[0].deadline_at < dbTime.rows[0]!.db_time ? 'late' : 'accepted';
      const acknowledgementHash = stableHash('rorca.cancellation-acknowledgement-payload.v1', { acknowledgement, runtimeId, classification });
      await client.query(`INSERT INTO execution_cancellation_acknowledgements
        (workspace_id,acknowledgement_id,cancellation_id,runtime_id,lease_id,fencing_token,classification,acknowledgement_hash,disposition,acknowledged_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [acknowledgement.workspaceId, acknowledgement.acknowledgementId,
        acknowledgement.cancellationId, runtimeId, acknowledgement.leaseId, acknowledgement.fencingToken, classification, acknowledgementHash,
        acknowledgement.disposition, acknowledgement.acknowledgedAt]);
      const effective = await client.query<{ request_state: string; effective_disposition: string; acknowledged: boolean; request_row_immutable: boolean }>(
        `SELECT request_state,effective_disposition,acknowledged,request_row_immutable FROM execution_cancellation_effective_state
         WHERE workspace_id=$1 AND cancellation_id=$2`, [acknowledgement.workspaceId, acknowledgement.cancellationId]);
      return { acknowledgementId: acknowledgement.acknowledgementId, classification,
        requestState: effective.rows[0]!.request_state, effectiveDisposition: effective.rows[0]!.effective_disposition,
        acknowledged: effective.rows[0]!.acknowledged, requestRowImmutable: effective.rows[0]!.request_row_immutable };
    } });
}

export async function submitPlanChangeProposal(candidate: unknown, context: GovernedMutationContext) {
  const proposal = PlanChangeProposalV1Schema.parse(candidate);
  return runIdempotentMutation({ workspaceId: proposal.workspaceId, operation: 'plan-change.propose', ...context,
    request: proposal, subject: { proposalId: proposal.proposalId, baseRevision: proposal.baseRevision }, mutate: async (client) => {
      const lease = await client.query<{ state: string; expires_at: Date; fencing_token: string; runtime_id: string; attempt_id: string;
        work_package_revision: number; policy_activation_hash: string; mission_id: string; work_package_id: string }>(
        `SELECT l.state,l.expires_at,l.fencing_token,l.runtime_id,l.attempt_id,l.work_package_revision,l.policy_activation_hash,
                a.mission_id,a.work_package_id FROM execution_leases l JOIN governed_execution_attempts a
          ON a.workspace_id=l.workspace_id AND a.attempt_id=l.attempt_id
         WHERE l.workspace_id=$1 AND l.lease_id=$2 FOR UPDATE OF l`, [proposal.workspaceId, proposal.leaseId]);
      const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time'); const active = lease.rows[0];
      if (!active || active.state !== 'active' || active.expires_at <= clock.rows[0]!.db_time
        || active.attempt_id !== proposal.attemptId || Number(active.fencing_token) !== proposal.fencingToken
        || active.runtime_id !== proposal.proposerRuntimeId || active.policy_activation_hash !== proposal.policyActivationHash
        || active.mission_id !== proposal.missionId || active.work_package_id !== proposal.workPackageId
        || active.work_package_revision !== proposal.baseRevision) {
        throw new ConflictError('Plan proposal does not match exact active lease', { reason: 'identity_conflict' });
      }
      const activation = await client.query(`SELECT 1 FROM context_policy_activation_heads
        WHERE workspace_id=$1 AND current_hash=$2 AND effective_state='active' FOR KEY SHARE`,
      [proposal.workspaceId, proposal.policyActivationHash]);
      if (!activation.rows[0]) throw new UnprocessableError('Policy activation is no longer active', 'POLICY_ACTIVATION_INACTIVE');
      const head = await client.query<{ current_revision: number; current_hash: string; payload_json: unknown }>(`SELECT h.current_revision,h.current_hash,r.payload_json
        FROM governed_work_package_heads h JOIN governed_work_package_revisions r
          ON r.workspace_id=h.workspace_id AND r.mission_id=h.mission_id AND r.work_package_id=h.work_package_id
         AND r.work_package_revision=h.current_revision
        WHERE h.workspace_id=$1 AND h.mission_id=$2 AND h.work_package_id=$3 FOR KEY SHARE OF h,r`,
      [proposal.workspaceId, proposal.missionId, proposal.workPackageId]);
      if (!head.rows[0] || head.rows[0].current_revision !== proposal.baseRevision || head.rows[0].current_hash !== proposal.baseHash) throw new ConflictError('Plan proposal base revision is stale', { reason: 'stale_revision' });
      const workPackage = WorkPackageV1Schema.parse(head.rows[0].payload_json);
      const allowed = new Set(workPackage.allowedPaths);
      if (proposal.requestedPaths.some((path) => !allowed.has(path))) throw new UnprocessableError('Plan proposal cannot expand allowed path scope', 'SCOPE_EXPANSION_FORBIDDEN');
      const existing = await client.query<{ base_hash: string; diff_hash: string; proposer_runtime_id: string; impact_hash: string }>(
        `SELECT base_hash,diff_hash,proposer_runtime_id,impact_hash FROM plan_change_proposals
         WHERE workspace_id=$1 AND proposal_id=$2`, [proposal.workspaceId, proposal.proposalId]);
      if (existing.rows[0]) {
        if (existing.rows[0].base_hash !== proposal.baseHash || existing.rows[0].diff_hash !== proposal.diffHash
          || existing.rows[0].proposer_runtime_id !== proposal.proposerRuntimeId || existing.rows[0].impact_hash !== proposal.impactHash) {
          throw new ConflictError('Plan proposal identity changed', { reason: 'idempotency_payload_conflict' });
        }
        return { proposalId: proposal.proposalId, state: 'proposed', canonicalMutationPerformed: false };
      }
      await client.query(`INSERT INTO plan_change_proposals
        (workspace_id,proposal_id,mission_id,work_package_id,attempt_id,lease_id,fencing_token,activation_hash,base_revision,base_hash,
         diff_hash,proposer_runtime_id,rationale,impact_hash,requested_paths_hash,dependencies_hash,validation_hash,state,requests_merge,requests_deployment)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'proposed',FALSE,FALSE)`,
      [proposal.workspaceId, proposal.proposalId, proposal.missionId, proposal.workPackageId, proposal.attemptId, proposal.leaseId,
        proposal.fencingToken, proposal.policyActivationHash, proposal.baseRevision, proposal.baseHash, proposal.diffHash,
        proposal.proposerRuntimeId, proposal.rationale, proposal.impactHash,
        stableHash('rorca.proposal-paths.v1', proposal.requestedPaths), proposal.dependencyManifestHash, proposal.validationManifestHash]);
      await client.query(`INSERT INTO plan_change_proposal_heads(workspace_id,proposal_id,current_state)
        VALUES($1,$2,'proposed')`, [proposal.workspaceId, proposal.proposalId]);
      return { proposalId: proposal.proposalId, state: 'proposed', stateVersion: 1, canonicalMutationPerformed: false };
    } });
}

export async function reviewPlanChangeProposal(input: { workspaceId: string; proposalId: string;
  expectedStateVersion: number; decision: 'under_review' | 'accepted' | 'rejected' | 'stale'; reasonCode: string },
context: GovernedMutationContext) {
  return runIdempotentMutation({ workspaceId: input.workspaceId, operation: 'plan-change.review', ...context,
    request: input, subject: { proposalId: input.proposalId, decision: input.decision }, mutate: async (client) => {
      const proposal = await client.query<{ state: string; state_version: string; lease_id: string; fencing_token: string;
        activation_hash: string; mission_id: string; work_package_id: string; base_revision: number; base_hash: string }>(
        `SELECT h.current_state state,h.state_version,p.lease_id,p.fencing_token,p.activation_hash,p.mission_id,
                p.work_package_id,p.base_revision,p.base_hash
         FROM plan_change_proposal_heads h JOIN plan_change_proposals p
          ON p.workspace_id=h.workspace_id AND p.proposal_id=h.proposal_id
         WHERE h.workspace_id=$1 AND h.proposal_id=$2 FOR KEY SHARE OF p FOR UPDATE OF h`, [input.workspaceId, input.proposalId]);
      const row = proposal.rows[0]; if (!row) throw new NotFoundError('Plan change proposal', input.proposalId);
      if (Number(row.state_version) !== input.expectedStateVersion) throw new ConflictError('Proposal review state version is stale', { reason: 'stale_revision' });
      const transitions: Record<string, readonly string[]> = { proposed: ['under_review', 'rejected', 'stale'],
        under_review: ['accepted', 'rejected', 'stale'], accepted: [], rejected: [], stale: [] };
      if (!transitions[row.state]?.includes(input.decision)) throw new ConflictError('Proposal review transition is invalid', { reason: 'state_conflict' });
      if (input.decision === 'accepted') {
        const authority = await client.query<{ state: string; expires_at: Date; fencing_token: string; policy_activation_hash: string }>(
          `SELECT state,expires_at,fencing_token,policy_activation_hash FROM execution_leases
           WHERE workspace_id=$1 AND lease_id=$2 FOR KEY SHARE`, [input.workspaceId, row.lease_id]);
        const head = await client.query<{ current_revision: number; current_hash: string }>(`SELECT current_revision,current_hash
          FROM governed_work_package_heads WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3 FOR KEY SHARE`,
        [input.workspaceId, row.mission_id, row.work_package_id]);
        const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time'); const lease = authority.rows[0];
        if (!lease || lease.state !== 'active' || lease.expires_at <= clock.rows[0]!.db_time
          || Number(lease.fencing_token) !== Number(row.fencing_token) || lease.policy_activation_hash !== row.activation_hash
          || head.rows[0]?.current_revision !== row.base_revision || head.rows[0]?.current_hash !== row.base_hash) {
          throw new ConflictError('Proposal authority or base revision became stale', { reason: 'stale_revision' });
        }
      }
      const reviewSequence = await client.query<{ next: string }>(`SELECT COALESCE(max(review_sequence),0)+1 next
        FROM plan_change_proposal_reviews WHERE workspace_id=$1 AND proposal_id=$2`, [input.workspaceId, input.proposalId]);
      const reviewHash = stableHash('rorca.plan-change-proposal-review.v1', { ...input, priorState: row.state,
        reviewerAuthorityRef: context.principalId, sequence: Number(reviewSequence.rows[0]!.next) });
      await client.query(`INSERT INTO plan_change_proposal_reviews
        (workspace_id,proposal_id,review_sequence,prior_state,next_state,reviewer_authority_ref,reason_code,review_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [input.workspaceId, input.proposalId, reviewSequence.rows[0]!.next,
        row.state, input.decision, context.principalId, input.reasonCode, reviewHash]);
      const updated = await client.query<{ state_version: string }>(`UPDATE plan_change_proposal_heads SET current_state=$3,
        state_version=state_version+1,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND proposal_id=$2 AND state_version=$4 RETURNING state_version`,
      [input.workspaceId, input.proposalId, input.decision, input.expectedStateVersion]);
      if (!updated.rows[0]) throw new ConflictError('Proposal review CAS lost', { reason: 'stale_revision' });
      return { proposalId: input.proposalId, state: input.decision, stateVersion: Number(updated.rows[0].state_version), canonicalMutationPerformed: false as const };
    } });
}

export type DeltaReuseDecision = { mode: 'delta'; reason: 'verified_reconstruction' } | { mode: 'full'; reason: string };
export function classifyDeltaReuse(input: {
  stableScopeMatches: boolean; baseAvailable: boolean; baseIntegrityValid: boolean; versionSupported: boolean;
  redactionUncertain: boolean; chainDepth: number; targetBytesMatch: boolean; targetHashMatches: boolean;
  onlyAllowedDifferences: boolean; gitDescendantProved: boolean; interveningPathsAllowed: boolean;
}): DeltaReuseDecision {
  if (!input.baseAvailable) return { mode: 'full', reason: 'base_missing' };
  if (!input.baseIntegrityValid) return { mode: 'full', reason: 'base_corrupt' };
  if (!input.versionSupported) return { mode: 'full', reason: 'unsupported_version' };
  if (!input.stableScopeMatches) return { mode: 'full', reason: 'stable_scope_changed' };
  if (input.redactionUncertain) return { mode: 'full', reason: 'redaction_uncertain' };
  if (input.chainDepth > 8) return { mode: 'full', reason: 'delta_chain_exceeded' };
  if (!input.onlyAllowedDifferences) return { mode: 'full', reason: 'forbidden_difference' };
  if (!input.gitDescendantProved || !input.interveningPathsAllowed) return { mode: 'full', reason: 'git_or_path_unverified' };
  if (!input.targetBytesMatch || !input.targetHashMatches) return { mode: 'full', reason: 'target_reconstruction_mismatch' };
  return { mode: 'delta', reason: 'verified_reconstruction' };
}

export function evaluateContextEpochRetirement(input: {
  consecutiveMinorReleases: number; daysSinceWriteCurrent: number; zeroReadDays: number; supportedConsumersRemaining: number;
  migrationFixturesPass: boolean; rollbackFixturesPass: boolean; breakMarkersPresent: boolean; releaseNotesPresent: boolean;
  nextMajorDeclared: boolean; independentReviewAccepted: boolean;
}) {
  const gates = {
    releaseGate: input.consecutiveMinorReleases >= 2 && input.nextMajorDeclared,
    ageGate: input.daysSinceWriteCurrent >= 90,
    zeroUseGate: input.zeroReadDays >= 30,
    clientsGate: input.supportedConsumersRemaining === 0,
    fixturesGate: input.migrationFixturesPass && input.rollbackFixturesPass,
    breakMarkersGate: input.breakMarkersPresent && input.releaseNotesPresent,
    independentReviewGate: input.independentReviewAccepted,
  };
  return { eligible: Object.values(gates).every(Boolean), gates,
    failedReasons: Object.entries(gates).filter(([, pass]) => !pass).map(([name]) => name) };
}

export async function recordContextEpochRetirementEvaluation(input: {
  workspaceId: string; evaluationId: string; nextMajorVersion: string;
  evidence: { migrationFixtureEvidenceHash: string; rollbackFixtureEvidenceHash: string; breakMarkerEvidenceHash: string;
    releaseNotesHash: string; nextMajorDeclarationHash: string; independentReviewReceiptId: string;
    independentReviewEvidenceHash: string; };
}, context: GovernedMutationContext) {
  return runIdempotentMutation({ workspaceId: input.workspaceId, operation: 'context-epoch-retirement.evaluate', ...context,
    request: input, subject: { evaluationId: input.evaluationId, nextMajorVersion: input.nextMajorVersion }, mutate: async (client) => {
      const clock = await client.query<{ db_time: Date }>('SELECT clock_timestamp() db_time'); const now = clock.rows[0]!.db_time;
      const releases = await client.query<{ contract_version: string; released_at: Date; write_current: boolean }>(
        `SELECT contract_version,released_at,write_current FROM context_contract_release_history ORDER BY released_at DESC`);
      const targetMajor = Number(input.nextMajorVersion.split('.')[0]);
      const priorMinorReleases = releases.rows.filter((row) => Number(row.contract_version.split('.')[0]) === targetMajor - 1);
      const latestWriter = releases.rows.find((row) => row.write_current);
      const latestRead = await client.query<{ database_time: Date | null }>(
        `SELECT max(database_time) database_time FROM context_epoch_projection_reads WHERE workspace_id=$1`, [input.workspaceId]);
      const remaining = await client.query<{ count: string }>(`SELECT count(*) count FROM context_epoch_client_migrations WHERE migrated=FALSE`);
      const requiredEvidence = [input.evidence.migrationFixtureEvidenceHash, input.evidence.rollbackFixtureEvidenceHash,
        input.evidence.breakMarkerEvidenceHash, input.evidence.releaseNotesHash, input.evidence.nextMajorDeclarationHash];
      const evidenceRows = await client.query<{ evidence_hash: string; evidence_kind: string; status: string }>(
        `SELECT evidence_hash,evidence_kind,status FROM context_epoch_retirement_evidence
         WHERE workspace_id=$1 AND evidence_hash=ANY($2::text[])`, [input.workspaceId, requiredEvidence]);
      const evidenceByKind = new Map(evidenceRows.rows.map((row) => [row.evidence_kind, row]));
      const review = await client.query<{ evidence_hash: string; accepted: boolean }>(`SELECT evidence_hash,accepted
        FROM context_epoch_retirement_review_decisions WHERE workspace_id=$1 AND review_receipt_id=$2`,
      [input.workspaceId, input.evidence.independentReviewReceiptId]);
      const passed = (kind: string, hash: string) => evidenceByKind.get(kind)?.evidence_hash === hash && evidenceByKind.get(kind)?.status === 'passed';
      const ageDays = latestWriter ? Math.floor((now.getTime() - latestWriter.released_at.getTime()) / 86_400_000) : 0;
      const zeroReadDays = latestRead.rows[0]?.database_time
        ? Math.floor((now.getTime() - latestRead.rows[0].database_time.getTime()) / 86_400_000) : 1_000_000;
      const metrics = { consecutiveMinorReleases: priorMinorReleases.length, daysSinceWriteCurrent: Math.max(0, ageDays),
        zeroReadDays: Math.max(0, zeroReadDays), supportedConsumersRemaining: Number(remaining.rows[0]!.count),
        migrationFixturesPass: passed('migration_fixtures', input.evidence.migrationFixtureEvidenceHash),
        rollbackFixturesPass: passed('rollback_fixtures', input.evidence.rollbackFixtureEvidenceHash),
        breakMarkersPresent: passed('break_markers', input.evidence.breakMarkerEvidenceHash),
        releaseNotesPresent: passed('release_notes', input.evidence.releaseNotesHash),
        nextMajorDeclared: passed('next_major_declaration', input.evidence.nextMajorDeclarationHash),
        independentReviewAccepted: review.rows[0]?.accepted === true
          && review.rows[0].evidence_hash === input.evidence.independentReviewEvidenceHash };
      const result = evaluateContextEpochRetirement(metrics);
      const packetHash = stableHash('rorca.context-epoch-retirement-packet.v1', { ...input, metrics, result, evaluatedAt: now.toISOString() });
      await client.query(`INSERT INTO context_epoch_retirement_evaluations
        (workspace_id,evaluation_id,next_major_version,evaluated_at,release_gate_passed,age_gate_passed,zero_use_gate_passed,clients_gate_passed,
         fixtures_gate_passed,break_markers_gate_passed,independent_review_gate_passed,eligible,packet_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [input.workspaceId, input.evaluationId, input.nextMajorVersion, now,
        result.gates.releaseGate, result.gates.ageGate, result.gates.zeroUseGate, result.gates.clientsGate,
        result.gates.fixturesGate, result.gates.breakMarkersGate, result.gates.independentReviewGate, result.eligible, packetHash]);
      return { evaluationId: input.evaluationId, packetHash, metrics, ...result };
    } });
}
