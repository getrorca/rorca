/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Exact-subject lifecycle automation at compile, dispatch, and run closeout. */
import crypto from 'node:crypto';
import path from 'node:path';
import type PgBoss from 'pg-boss';
import { query, queryOne } from '../db/index';
import { ConflictError, UnprocessableError, ValidationError } from './errors';
import { logger } from './logger';
import { getBoss } from './pg-boss';
import { previewLifecycleReconciliation, applyLifecycleReconciliation } from './lifecycle-reconciliation';
import { previewPreStagingQualification, runPreStagingQualification } from './pre-staging-qualification';
import { projectCurrentLifecyclePlanEvidence, projectLifecycleEvidenceForRun } from './run-lifecycle-projection';
import {
  projectLifecyclePlanCompatibility,
  normalizeSsdlcContractJson,
  type LifecyclePlan,
  type PhaseId,
  type ReleaseSubjectType,
} from './ssdlc-contracts';
import { getLifecyclePhase, getLifecycleSpec } from './ssdlc-lifecycle-read';
import { SSDLC_PLAN_COMPILER_VERSION } from './ssdlc-plan-compiler';

export const LIFECYCLE_ASSURANCE_QUEUE = 'pipeline:lifecycle-assurance' as const;
export const LIFECYCLE_ASSURANCE_EXECUTOR_ID = 'lifecycle-assurance-worker' as const;
export const LIFECYCLE_POLICY_VERIFIER_ID = 'lifecycle-policy-verifier' as const;
const VERIFIER_LABEL = 'Rorca Lifecycle Policy Verifier';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PRE_EXECUTION_PHASES: readonly PhaseId[] = ['planning', 'requirements', 'design'];
const EXCLUDED = new Set(['not_applicable', 'deferred']);
const PAGE = { limit: 250, offset: 0, cursor: null, usedCursor: false } as const;

interface PlanRow {
  id: string;
  spec_version: string;
  compiler_version: string;
  validation_status: string;
  is_current: boolean;
  plan_json: unknown;
  provenance_json: unknown;
}
interface RunRow {
  id: number;
  workspace_id: string;
  spec_path: string;
  status: string;
  canonical_spec_revision: string | null;
  terminal_checkout_sha: string | null;
  terminal_checkout_attested_at: Date | string | null;
  trigger_options: unknown;
}

interface LoadedLifecyclePlan {
  row: PlanRow;
  plan: LifecyclePlan;
  specHash: string;
}

export interface LifecycleAssuranceJobPayload {
  workspaceId: string;
  runId: number;
  specRevision: string;
  planId: string;
  compiledPlanId: string;
}

export interface LifecyclePolicyAdvancementResult {
  compiledPlanId: string;
  considered: number;
  created: number;
  replayed: number;
  awaitingHuman: string[];
  ineligible: string[];
}

interface LifecycleAssuranceRecoveryRow {
  id: number;
  workspace_id: string;
  recovery_order_at: Date | string;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}
function canonicalSpecHash(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(value), 'utf8').digest('hex')}`;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assuranceJobPayload(value: unknown): LifecycleAssuranceJobPayload {
  const data = object(value);
  const expectedKeys = ['compiledPlanId', 'planId', 'runId', 'specRevision', 'workspaceId'];
  if (Object.keys(data).sort().join(',') !== expectedKeys.join(',')) {
    throw new ValidationError('Invalid lifecycle assurance job payload');
  }
  const workspaceId = typeof data.workspaceId === 'string' ? data.workspaceId : '';
  const runId = data.runId;
  const specRevision = typeof data.specRevision === 'string' ? data.specRevision : '';
  const planId = typeof data.planId === 'string' ? data.planId : '';
  const compiledPlanId = typeof data.compiledPlanId === 'string' ? data.compiledPlanId : '';
  if (!workspaceId || workspaceId !== workspaceId.trim()
    || typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId <= 0
    || !SHA256.test(specRevision)
    || !planId || planId !== planId.trim() || planId.length > 256
    || !/^[1-9]\d*$/.test(compiledPlanId)) {
    throw new ValidationError('Invalid lifecycle assurance job payload');
  }
  return { workspaceId, runId, specRevision, planId, compiledPlanId };
}

async function currentPlan(workspaceId: string, specId: string): Promise<LoadedLifecyclePlan> {
  const row = await queryOne<PlanRow>(`
    SELECT id::text, spec_version, compiler_version, validation_status, is_current, plan_json, provenance_json
    FROM ssdlc_compiled_plans
    WHERE workspace_id=$1 AND spec_slug=$2 AND is_current=TRUE
    LIMIT 1
  `, [workspaceId, specId]);
  if (!row) throw new UnprocessableError(
    'Dispatch requires a current lifecycle plan for the exact canonical spec revision.',
    'LIFECYCLE_PLAN_REQUIRED',
    { workspaceId, specId, action: 'Compile the approved spec lifecycle plan, then retry dispatch.' },
  );
  const specHash = object(row.provenance_json).specHash;
  if (row.validation_status !== 'validated' || row.compiler_version !== SSDLC_PLAN_COMPILER_VERSION
    || typeof specHash !== 'string' || !SHA256.test(specHash)) {
    throw new UnprocessableError(
      'The selected lifecycle plan is stale or was not validated by the current compiler.',
      'LIFECYCLE_PLAN_STALE',
      { workspaceId, specId, compiledPlanId: row.id, planCompilerVersion: row.compiler_version, requiredCompilerVersion: SSDLC_PLAN_COMPILER_VERSION },
    );
  }
  let plan: LifecyclePlan;
  try {
    plan = projectLifecyclePlanCompatibility(row.plan_json);
  } catch {
    throw new UnprocessableError(
      'The current lifecycle plan payload is invalid.',
      'LIFECYCLE_PLAN_INVALID',
      { workspaceId, specId, compiledPlanId: row.id },
    );
  }
  if (plan.compilerVersion !== SSDLC_PLAN_COMPILER_VERSION) throw new UnprocessableError(
    'The current lifecycle plan payload was produced by an obsolete compiler.',
    'LIFECYCLE_PLAN_STALE',
    { workspaceId, specId, compiledPlanId: row.id },
  );
  return { row, plan, specHash };
}

async function exactPlan(workspaceId: string, specId: string, compiledPlanId: string): Promise<LoadedLifecyclePlan | undefined> {
  const row = await queryOne<PlanRow>(`
    SELECT id::text, spec_version, compiler_version, validation_status, is_current, plan_json, provenance_json
    FROM ssdlc_compiled_plans
    WHERE workspace_id=$1 AND spec_slug=$2 AND id=$3::bigint
    LIMIT 1
  `, [workspaceId, specId, compiledPlanId]);
  if (!row) return undefined;
  const specHash = object(row.provenance_json).specHash;
  if (!row.is_current || row.validation_status !== 'validated' || row.compiler_version !== SSDLC_PLAN_COMPILER_VERSION
    || typeof specHash !== 'string' || !SHA256.test(specHash)) {
    throw new UnprocessableError(
      'The queued lifecycle assurance plan is no longer current and validated.',
      'LIFECYCLE_ASSURANCE_IDENTITY_MISMATCH',
      { workspaceId, specId, compiledPlanId },
    );
  }
  let plan: LifecyclePlan;
  try {
    plan = projectLifecyclePlanCompatibility(row.plan_json);
  } catch {
    throw new UnprocessableError(
      'The queued lifecycle assurance plan payload is invalid or obsolete.',
      'LIFECYCLE_ASSURANCE_IDENTITY_MISMATCH',
      { workspaceId, specId, compiledPlanId },
    );
  }
  if (plan.compilerVersion !== SSDLC_PLAN_COMPILER_VERSION) {
    throw new UnprocessableError(
      'The queued lifecycle assurance plan payload is invalid or obsolete.',
      'LIFECYCLE_ASSURANCE_IDENTITY_MISMATCH',
      { workspaceId, specId, compiledPlanId },
    );
  }
  return { row, plan, specHash };
}

function requiredSubjectType(requirement: LifecyclePlan['gates'][number]['subjectRevisionRequirement']): ReleaseSubjectType {
  switch (requirement) {
    case 'current_spec_revision': return 'spec_hash';
    case 'current_commit': return 'commit_sha';
    case 'current_artifact': return 'artifact_digest';
    case 'current_deployment': return 'deployment_id';
  }
}

function exactSubject(
  gate: LifecyclePlan['gates'][number],
  specHash: string,
  evidence: Array<Record<string, unknown>>,
): { type: ReleaseSubjectType; value: string } | null {
  const type = requiredSubjectType(gate.subjectRevisionRequirement);
  const values = new Set<string>();
  for (const item of evidence) {
    const subject = object(item.subject);
    if (item.gateId === gate.gateId && item.status === 'passed' && item.currentRevision === true
      && subject.type === type && typeof subject.value === 'string') values.add(subject.value.toLowerCase());
  }
  if (type === 'spec_hash') return values.has(specHash) ? { type, value: specHash } : null;
  return values.size === 1 ? { type, value: [...values][0]! } : null;
}

async function persistPolicyDecision(input: {
  workspaceId: string;
  specId: string;
  specVersion: string;
  compiledPlanId: string;
  plan: LifecyclePlan;
  gate: LifecyclePlan['gates'][number];
  subject: { type: ReleaseSubjectType; value: string };
  runId?: number;
}): Promise<'created' | 'replayed'> {
  const policyReference = [input.plan.policyVersion, input.plan.planId, input.compiledPlanId, input.plan.inputHash, input.gate.gateId].join(':');
  const sourceRequestId = ['lifecycle-policy', input.compiledPlanId, input.gate.gateId, input.subject.type, input.subject.value, input.runId ?? 'plan'].join(':');
  const requestHash = digest({
    workspaceId: input.workspaceId, specId: input.specId, specVersion: input.specVersion,
    runId: input.runId ?? null, phaseId: input.gate.phaseId, gateId: input.gate.gateId,
    subject: input.subject, policyVersion: input.plan.policyVersion, policyReference,
    compilerVersion: input.plan.compilerVersion, verifier: LIFECYCLE_POLICY_VERIFIER_ID,
  });
  const inserted = await queryOne<{ id: string }>(`
    INSERT INTO ssdlc_decisions (
      workspace_id,spec_slug,spec_version,run_id,phase_id,gate_id,decision_type,
      rationale,subject_type,subject_value,policy_version,policy_reference,
      policy_authorized,principal_type,principal_id,principal_display_label,actor,
      source_request_id,source_channel,scope_key,request_hash,compiled_plan_id,plan_id
    )
    SELECT $1,$2,$3,$4,$5,$6,'policy_approval',
      'Current exact-subject evidence satisfies this compiled policy gate.',
      $7,$8,$9,$10,TRUE,'internal_service',$11,$12,$11,$13,'internal',$14,$15,$16::bigint,$18
    FROM ssdlc_compiled_plans current_plan
    WHERE current_plan.id=$16::bigint
      AND current_plan.workspace_id=$1
      AND current_plan.spec_slug=$2
      AND current_plan.is_current=TRUE
      AND current_plan.validation_status='validated'
      AND current_plan.compiler_version=$17
      AND current_plan.plan_json->>'planId'=$18
      AND current_plan.plan_json->>'inputHash'=$19
    ON CONFLICT (workspace_id,source_request_id) DO NOTHING
    RETURNING id::text
  `, [
    input.workspaceId, input.specId, input.specVersion, input.runId ?? null,
    input.gate.phaseId, input.gate.gateId, input.subject.type, input.subject.value,
    input.plan.policyVersion, policyReference, LIFECYCLE_POLICY_VERIFIER_ID, VERIFIER_LABEL,
    sourceRequestId, `${input.specId}|${input.gate.phaseId}|${input.gate.gateId}|*|${input.runId ?? '*'}`,
    requestHash,
    input.compiledPlanId, SSDLC_PLAN_COMPILER_VERSION, input.plan.planId, input.plan.inputHash,
  ]);
  if (inserted) return 'created';
  const replay = await queryOne<{ request_hash: string; compiled_plan_id: string | null; plan_id: string | null }>(
    `SELECT request_hash, compiled_plan_id::text, plan_id
     FROM ssdlc_decisions WHERE workspace_id=$1 AND source_request_id=$2`,
    [input.workspaceId, sourceRequestId],
  );
  if (!replay || replay.request_hash !== requestHash) throw new ConflictError('Lifecycle policy decision idempotency binding changed');
  // Governed self-heal for policy approvals written before the compiled-plan
  // identity columns existed (see migration 20260812120000_lifecycle_policy_subjects
  // and 20260817120000_lifecycle_policy_approval_plan_binding_reconciliation).
  // Such rows replay with a matching hash but stay unbound (compiled_plan_id /
  // plan_id NULL), so the evaluator reports plan_identity_mismatch and the gate
  // is permanently stale. Mint a fresh-generation approval bound to the current
  // plan under a ":reconciled" source_request_id that cannot collide with the
  // immutable historical row.
  if (replay.compiled_plan_id === null || replay.plan_id === null) {
    const reconciledRequestId = `${sourceRequestId}:reconciled`;
    const reconciled = await queryOne<{ id: string }>(`
      INSERT INTO ssdlc_decisions (
        workspace_id,spec_slug,spec_version,run_id,phase_id,gate_id,decision_type,
        rationale,subject_type,subject_value,policy_version,policy_reference,
        policy_authorized,principal_type,principal_id,principal_display_label,actor,
        source_request_id,source_channel,scope_key,request_hash,compiled_plan_id,plan_id
      )
      SELECT $1,$2,$3,$4,$5,$6,'policy_approval',
        'Current exact-subject evidence satisfies this compiled policy gate.',
        $7,$8,$9,$10,TRUE,'internal_service',$11,$12,$11,$13,'internal',$14,$15,$16::bigint,$18
      FROM ssdlc_compiled_plans current_plan
      WHERE current_plan.id=$16::bigint
        AND current_plan.workspace_id=$1
        AND current_plan.spec_slug=$2
        AND current_plan.is_current=TRUE
        AND current_plan.validation_status='validated'
        AND current_plan.compiler_version=$17
        AND current_plan.plan_json->>'planId'=$18
        AND current_plan.plan_json->>'inputHash'=$19
      ON CONFLICT (workspace_id,source_request_id) DO NOTHING
      RETURNING id::text
    `, [
      input.workspaceId, input.specId, input.specVersion, input.runId ?? null,
      input.gate.phaseId, input.gate.gateId, input.subject.type, input.subject.value,
      input.plan.policyVersion, policyReference, LIFECYCLE_POLICY_VERIFIER_ID, VERIFIER_LABEL,
      reconciledRequestId, `${input.specId}|${input.gate.phaseId}|${input.gate.gateId}|*|${input.runId ?? '*'}`,
      requestHash,
      input.compiledPlanId, SSDLC_PLAN_COMPILER_VERSION, input.plan.planId, input.plan.inputHash,
    ]);
    if (reconciled) {
      logger.info(
        { workspaceId: input.workspaceId, specId: input.specId, gateId: input.gate.gateId, compiledPlanId: input.compiledPlanId },
        '[lifecycle-policy] minted reconciled plan-bound approval for pre-binding historical decision',
      );
      return 'created';
    }
    const reconciledReplay = await queryOne<{ request_hash: string }>(
      'SELECT request_hash FROM ssdlc_decisions WHERE workspace_id=$1 AND source_request_id=$2',
      [input.workspaceId, reconciledRequestId],
    );
    if (!reconciledReplay || reconciledReplay.request_hash !== requestHash) {
      throw new ConflictError('Lifecycle policy decision idempotency binding changed', {
        workspaceId: input.workspaceId,
        specId: input.specId,
        gateId: input.gate.gateId,
        sourceRequestId,
      });
    }
  }
  return 'replayed';
}

/** Advance only gates compiled as policy, and only once exact evidence is complete. */
export async function advanceCurrentLifecyclePolicyGates(input: {
  workspaceId: string;
  specId: string;
  runId?: number;
  compiledPlanId?: string;
}): Promise<LifecyclePolicyAdvancementResult> {
  if (input.runId !== undefined && (!Number.isSafeInteger(input.runId) || input.runId <= 0)) {
    throw new ValidationError('runId must be a positive integer', { field: 'runId' });
  }
  const current = input.compiledPlanId === undefined
    ? await currentPlan(input.workspaceId, input.specId)
    : await exactPlan(input.workspaceId, input.specId, input.compiledPlanId);
  if (!current) throw new UnprocessableError(
    'The exact lifecycle policy plan is unavailable.',
    'LIFECYCLE_ASSURANCE_IDENTITY_MISMATCH',
    { workspaceId: input.workspaceId, specId: input.specId, compiledPlanId: input.compiledPlanId },
  );
  const policyGates = current.plan.gates.filter((gate) => gate.approvalRequirement === 'policy');
  const details = new Map<PhaseId, Awaited<ReturnType<typeof getLifecyclePhase>>>();
  for (const phaseId of new Set(policyGates.map((gate) => gate.phaseId))) {
    details.set(phaseId, await getLifecyclePhase({ workspaceId: input.workspaceId, specId: input.specId, phaseId, evidencePagination: PAGE }));
  }
  let created = 0;
  let replayed = 0;
  const ineligible: string[] = [];
  for (const gate of policyGates) {
    const detail = details.get(gate.phaseId)!;
    const evaluated = detail.requiredGates.items.find((item) => item.gateId === gate.gateId)?.evaluation;
    if (evaluated?.status === 'passed') continue;
    const subject = exactSubject(gate, current.specHash, detail.evidence.items);
    // A revoked, expired, or revision-mismatched approval makes the evaluator
    // report `stale`. Current exact-subject evidence still permits the policy
    // verifier to replace that stale approval with one bound to this plan.
    if (!subject || (evaluated?.status !== 'awaiting_approval' && evaluated?.status !== 'stale')) {
      ineligible.push(gate.gateId);
      continue;
    }
    const outcome = await persistPolicyDecision({
      workspaceId: input.workspaceId, specId: input.specId, specVersion: current.row.spec_version,
      compiledPlanId: current.row.id, plan: current.plan, gate, subject,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
    });
    outcome === 'created' ? created += 1 : replayed += 1;
  }
  return {
    compiledPlanId: current.row.id, considered: policyGates.length, created, replayed,
    awaitingHuman: current.plan.gates.filter((gate) => gate.approvalRequirement === 'human').map((gate) => gate.gateId).sort(),
    ineligible: ineligible.sort(),
  };
}
/**
 * Compile-time projection stays immediate in the API process. A runtime-only
 * worker publishes the exact plan to the API-owned canonical-writer consumer.
 */
export async function projectOrEnqueueCurrentLifecyclePlanEvidence(input: { workspaceId: string; specId: string }): Promise<void> {
  const current = await currentPlan(input.workspaceId, input.specId);
  if (process.env.RORCA_CANONICAL_WRITER_DATABASE_URL) {
    await projectCurrentLifecyclePlanEvidence(input);
    return;
  }
  const jobId = await getBoss().send(LIFECYCLE_ASSURANCE_QUEUE, {
    kind: 'current-plan',
    workspaceId: input.workspaceId,
    specId: input.specId,
    specRevision: current.specHash,
    planId: current.plan.planId,
    compiledPlanId: current.row.id,
  }, {
    singletonKey: `lifecycle-plan:${current.row.id}:${current.specHash}`,
    singletonSeconds: 86_400,
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
  });
  if (!jobId) return;
}


/** Narrow pipeline guard: evidence/policy automation first, then fail closed. */
export async function assertLifecycleDispatchReady(input: {
  workspaceId: string;
  specId: string;
  canonicalSpec: unknown;
}) {
  const current = await currentPlan(input.workspaceId, input.specId);
  const observedSpecHash = canonicalSpecHash(input.canonicalSpec);
  if (observedSpecHash !== current.specHash) {
    throw new UnprocessableError(
      'Lifecycle readiness is stale for the exact canonical spec bytes selected for dispatch.',
      'LIFECYCLE_PLAN_STALE',
      {
        workspaceId: input.workspaceId,
        specId: input.specId,
        observedSpecHash,
        compiledSpecHash: current.specHash,
      },
    );
  }
  const projection = await projectCurrentLifecyclePlanEvidence({
    workspaceId: input.workspaceId,
    specId: input.specId,
  });
  if (projection.status !== 'projected' || projection.compiledPlanId !== current.row.id || projection.specHash !== current.specHash) {
    throw new UnprocessableError('Current lifecycle evidence is not bound to the exact canonical plan.', 'LIFECYCLE_PLAN_EVIDENCE_BLOCKED', {
      workspaceId: input.workspaceId,
      specId: input.specId,
      projection,
    });
  }
  const lifecycleInput = { workspaceId: input.workspaceId, specId: input.specId };
  const policy = await advanceCurrentLifecyclePolicyGates(lifecycleInput);
  const lifecycle = await getLifecycleSpec(lifecycleInput);
  if (lifecycle.state !== 'current' || lifecycle.stale || lifecycle.plan?.databaseId !== current.row.id) {
    throw new UnprocessableError('Lifecycle readiness is stale for the current canonical spec revision.', 'LIFECYCLE_PLAN_STALE', {
      workspaceId: input.workspaceId,
      specId: input.specId,
      state: lifecycle.state,
    });
  }
  const phases = PRE_EXECUTION_PHASES.map((phaseId) => {
    const phase = lifecycle.phaseTimeline.find((candidate) => candidate.phaseId === phaseId);
    return { phaseId, status: phase?.status ?? 'not_started', disposition: phase?.disposition ?? null };
  });
  const blocked = phases.filter((phase) => phase.status !== 'passed' && !EXCLUDED.has(phase.status));
  if (blocked.length) {
    const human = new Set(policy.awaitingHuman);
    const blockedPhases = await Promise.all(blocked.map(async (phase) => {
      const detail = await getLifecyclePhase({ workspaceId: input.workspaceId, specId: input.specId, phaseId: phase.phaseId, evidencePagination: { ...PAGE, limit: 1 } });
      return {
        phaseId: phase.phaseId, status: phase.status, blocker: detail.blocker,
        humanApprovalGateIds: detail.requiredGates.items.filter((gate) => human.has(gate.gateId) && gate.evaluation?.status === 'awaiting_approval').map((gate) => gate.gateId),
        nextSafeAction: detail.nextSafeAction,
      };
    }));
    throw new UnprocessableError('Lifecycle pre-execution controls are not ready for dispatch.', 'LIFECYCLE_PRE_EXECUTION_BLOCKED', {
      workspaceId: input.workspaceId,
      specId: input.specId,
      blockedPhases,
    });
  }
  return {
    workspaceId: input.workspaceId,
    specId: input.specId,
    specHash: observedSpecHash,
    compiledPlanId: current.row.id,
    plan: current.plan,
    phases,
    policy,
  };
}

function assuranceKeys(identity: LifecycleAssuranceJobPayload) {
  const suffix = digest(identity).slice(7);
  return {
    qualification: `lifecycle-assurance:${identity.runId}:${suffix}:qualification`,
    reconciliation: `lifecycle-assurance:${identity.runId}:${suffix}:reconciliation`,
  };
}

type AssurancePublicationState = 'publishing' | 'published' | 'processing' | 'failed' | 'completed';

async function claimAssurancePublication(identity: LifecycleAssuranceJobPayload): Promise<boolean> {
  const identityHash = digest(identity);
  const claimed = await queryOne<{ id: string }>(`
    UPDATE pipeline_runs
    SET trigger_options = jsonb_set(
      COALESCE(trigger_options, '{}'::jsonb),
      '{lifecycleAssurancePublication}',
      jsonb_build_object(
        'identityHash', $3::text,
        'state', 'publishing',
        'leaseExpiresAt', NOW() + INTERVAL '30 minutes',
        'attempt', COALESCE((trigger_options->'lifecycleAssurancePublication'->>'attempt')::integer, 0) + 1
      ),
      TRUE
    )
    WHERE id=$1 AND workspace_id=$2
      AND trigger_options->'lifecycleAssuranceIdentity' = $4::jsonb
      AND (
        trigger_options->'lifecycleAssurancePublication' IS NULL
        OR (
          trigger_options->'lifecycleAssurancePublication'->>'identityHash' = $3
          AND trigger_options->'lifecycleAssurancePublication'->>'state' <> 'completed'
          AND COALESCE(
            (trigger_options->'lifecycleAssurancePublication'->>'leaseExpiresAt')::timestamptz,
            '-infinity'::timestamptz
          ) <= NOW()
        )
      )
    RETURNING id::text
  `, [identity.runId, identity.workspaceId, identityHash, JSON.stringify(identity)]);
  return Boolean(claimed);
}

async function recordAssurancePublication(
  identity: LifecycleAssuranceJobPayload,
  state: AssurancePublicationState,
  details: { jobId?: string; error?: string } = {},
): Promise<void> {
  const identityHash = digest(identity);
  await queryOne<{ id: string }>(`
    UPDATE pipeline_runs
    SET trigger_options = jsonb_set(
      trigger_options,
      '{lifecycleAssurancePublication}',
      COALESCE(trigger_options->'lifecycleAssurancePublication', '{}'::jsonb)
        || jsonb_build_object(
          'identityHash', $3::text,
          'state', $4::text,
          'leaseExpiresAt', CASE
            WHEN $4::text = 'completed' THEN 'infinity'::timestamptz
            ELSE NOW() + INTERVAL '30 minutes'
          END,
          'jobId', $5::text,
          'lastError', $6::text,
          'updatedAt', NOW()
        ),
      TRUE
    )
    WHERE id=$1 AND workspace_id=$2
      AND trigger_options->'lifecycleAssuranceIdentity' = $7::jsonb
      AND (
        trigger_options->'lifecycleAssurancePublication' IS NULL
        OR trigger_options->'lifecycleAssurancePublication'->>'identityHash' = $3
      )
    RETURNING id::text
  `, [
    identity.runId,
    identity.workspaceId,
    identityHash,
    state,
    details.jobId ?? null,
    details.error?.slice(0, 500) ?? null,
    JSON.stringify(identity),
  ]);
}

async function trustedRun(workspaceId: string, runId: number): Promise<RunRow | undefined> {
  return queryOne<RunRow>(`
    SELECT id,workspace_id,spec_path,status,canonical_spec_revision,
           terminal_checkout_sha,terminal_checkout_attested_at,trigger_options
    FROM pipeline_runs WHERE id=$1 AND workspace_id=$2
  `, [runId, workspaceId]);
}

function assuranceIdentity(run: RunRow, plan: LoadedLifecyclePlan): LifecycleAssuranceJobPayload {
  return {
    workspaceId: run.workspace_id,
    runId: run.id,
    specRevision: run.canonical_spec_revision!,
    planId: plan.plan.planId,
    compiledPlanId: plan.row.id,
  };
}

function dispatchPlanBinding(run: RunRow, specId: string): { specHash: string; compiledPlanId: string } | null {
  const claim = object(object(run.trigger_options).lifecycleDispatchClaim);
  const specHash = typeof claim.specHash === 'string' ? claim.specHash : '';
  const compiledPlanId = typeof claim.compiledPlanId === 'string' ? claim.compiledPlanId : '';
  if (claim.schemaVersion !== 'lifecycle-dispatch-claim.v1'
    || claim.workspaceId !== run.workspace_id
    || claim.specId !== specId
    || !SHA256.test(specHash)
    || !/^[1-9]\d*$/.test(compiledPlanId)) return null;
  return { specHash, compiledPlanId };
}

async function assertAssuranceIdentity(
  queued: LifecycleAssuranceJobPayload,
  specId: string,
  stage: 'projection' | 'qualification' | 'policy' | 'reconciliation',
): Promise<LoadedLifecyclePlan> {
  const [run, exact] = await Promise.all([
    trustedRun(queued.workspaceId, queued.runId),
    exactPlan(queued.workspaceId, specId, queued.compiledPlanId),
  ]);
  const actual = run && exact ? assuranceIdentity(run, exact) : null;
  const dispatch = run ? dispatchPlanBinding(run, specId) : null;
  let durable: LifecycleAssuranceJobPayload | null = null;
  try {
    durable = assuranceJobPayload(object(run?.trigger_options).lifecycleAssuranceIdentity);
  } catch {
    durable = null;
  }
  if (!run || run.status !== 'done' || !run.terminal_checkout_sha || !run.terminal_checkout_attested_at
    || path.basename(run.spec_path, '.json') !== specId
    || !dispatch
    || dispatch.specHash !== queued.specRevision
    || dispatch.compiledPlanId !== queued.compiledPlanId
    || !exact || !actual || !durable
    || digest(actual) !== digest(queued)
    || digest(durable) !== digest(queued)) {
    throw new UnprocessableError(
      'Lifecycle assurance job identity does not match the durable run and exact compiled plan.',
      'LIFECYCLE_ASSURANCE_IDENTITY_MISMATCH',
      { stage, queued, actual, durable },
    );
  }
  return exact;
}

/** Publish exact run/spec/plan assurance once; completed receipts suppress replay. */
export async function enqueueLifecycleAssuranceForRun(input: { workspaceId: string; runId: number; boss?: PgBoss }) {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) {
    return { status: 'skipped' as const, jobId: null, reason: 'invalid_run_id' };
  }
  const run = await trustedRun(input.workspaceId, input.runId);
  if (!run) return { status: 'skipped' as const, jobId: null, reason: 'run_not_found' };
  if (run.status !== 'done' || !run.canonical_spec_revision || !run.terminal_checkout_sha || !run.terminal_checkout_attested_at) {
    return { status: 'skipped' as const, jobId: null, reason: 'run_not_trusted_terminal' };
  }
  const specId = path.basename(run.spec_path, '.json');
  const binding = dispatchPlanBinding(run, specId);
  if (!binding || binding.specHash !== run.canonical_spec_revision) {
    return { status: 'skipped' as const, jobId: null, reason: 'run_dispatch_identity_unavailable' };
  }
  let current: LoadedLifecyclePlan | undefined;
  try {
    current = await exactPlan(run.workspace_id, specId, binding.compiledPlanId);
  } catch (error) {
    if (error instanceof UnprocessableError) {
      return { status: 'skipped' as const, jobId: null, reason: 'current_exact_plan_unavailable' };
    }
    throw error;
  }
  if (!current || current.specHash !== binding.specHash) {
    return { status: 'skipped' as const, jobId: null, reason: 'current_plan_not_bound_to_run' };
  }
  const identity = assuranceIdentity(run, current);
  const keys = assuranceKeys(identity);
  const claimed = await queryOne<{ id: string }>(`
    UPDATE pipeline_runs
    SET trigger_options = jsonb_set(COALESCE(trigger_options, '{}'::jsonb), '{lifecycleAssuranceIdentity}', $3::jsonb, TRUE)
    WHERE id=$1 AND workspace_id=$2
      AND (trigger_options->'lifecycleAssuranceIdentity' IS NULL
        OR trigger_options->'lifecycleAssuranceIdentity' = $3::jsonb)
    RETURNING id::text
  `, [run.id, run.workspace_id, JSON.stringify(identity)]);
  if (!claimed) return { status: 'skipped' as const, jobId: null, reason: 'durable_assurance_identity_conflict' };
  const complete = await queryOne<{ id: string }>(
    'SELECT id::text FROM ssdlc_reconciliation_receipts WHERE workspace_id=$1 AND spec_slug=$2 AND idempotency_key=$3 LIMIT 1',
    [run.workspace_id, specId, keys.reconciliation],
  );
  if (complete) {
    await recordAssurancePublication(identity, 'completed');
    return { status: 'complete' as const, jobId: null, reason: 'assurance_receipt_exists' };
  }
  if (!await claimAssurancePublication(identity)) {
    return { status: 'already_queued' as const, jobId: null, reason: 'durable_publication_lease' };
  }
  try {
    const jobId = await (input.boss ?? getBoss()).send(LIFECYCLE_ASSURANCE_QUEUE, identity, {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
    });
    if (!jobId) {
      await recordAssurancePublication(identity, 'failed', { error: 'queue_send_returned_no_job_id' });
      return { status: 'deferred' as const, jobId: null, reason: 'queue_publication_failed' };
    }
    await recordAssurancePublication(identity, 'published', { jobId });
    return { status: 'queued' as const, jobId, reason: 'trusted_run_completion' };
  } catch (error) {
    await recordAssurancePublication(identity, 'failed', {
      error: error instanceof Error ? error.message : 'queue_publication_failed',
    });
    throw error;
  }
}

/** Idempotent server-owned handler. It never updates the canonical run outcome. */
export async function handleLifecycleAssurance(input: LifecycleAssuranceJobPayload) {
  const queued = assuranceJobPayload(input);
  const run = await trustedRun(queued.workspaceId, queued.runId);
  if (!run) throw new UnprocessableError('Lifecycle assurance run was not found.', 'LIFECYCLE_ASSURANCE_RUN_NOT_FOUND', { ...queued });
  if (run.status !== 'done' || !run.canonical_spec_revision || !run.terminal_checkout_sha || !run.terminal_checkout_attested_at) {
    throw new UnprocessableError('Lifecycle assurance requires a trusted terminal pipeline run.', 'LIFECYCLE_ASSURANCE_RUN_NOT_TERMINAL', { ...queued, status: run.status });
  }
  const specId = path.basename(run.spec_path, '.json');
  await assertAssuranceIdentity(queued, specId, 'projection');
  const keys = assuranceKeys(queued);
  const projection = await projectLifecycleEvidenceForRun({
    workspaceId: queued.workspaceId,
    runId: queued.runId,
    compiledPlanId: queued.compiledPlanId,
    specRevision: queued.specRevision,
    planId: queued.planId,
  });
  if (projection.status !== 'projected' || projection.reason !== null) throw new UnprocessableError(
    'Completed-run lifecycle evidence could not be projected onto the exact queued plan.',
    'LIFECYCLE_ASSURANCE_PROJECTION_BLOCKED', { ...queued, projection },
  );

  await assertAssuranceIdentity(queued, specId, 'qualification');
  const preview = await previewPreStagingQualification({ workspaceId: queued.workspaceId, specId, runId: queued.runId });
  if (preview.runId !== queued.runId || preview.specRevisionHash !== queued.specRevision
    || preview.planId !== queued.planId || preview.compiledPlanId !== queued.compiledPlanId) {
    throw new UnprocessableError(
      'Lifecycle qualification preview is not bound to the queued assurance identity.',
      'LIFECYCLE_ASSURANCE_IDENTITY_MISMATCH',
      { stage: 'qualification', queued },
    );
  }
  const qualification = await runPreStagingQualification({
    workspaceId: queued.workspaceId, specId, runId: queued.runId, previewHash: preview.previewHash,
    idempotencyKey: keys.qualification, actorId: LIFECYCLE_ASSURANCE_EXECUTOR_ID,
  });

  await assertAssuranceIdentity(queued, specId, 'policy');
  const policy = await advanceCurrentLifecyclePolicyGates({
    workspaceId: queued.workspaceId,
    specId,
    runId: queued.runId,
    compiledPlanId: queued.compiledPlanId,
  });
  if (policy.compiledPlanId !== queued.compiledPlanId) throw new UnprocessableError(
    'Lifecycle policy advancement is not bound to the queued assurance identity.',
    'LIFECYCLE_ASSURANCE_IDENTITY_MISMATCH',
    { stage: 'policy', queued, compiledPlanId: policy.compiledPlanId },
  );

  await assertAssuranceIdentity(queued, specId, 'reconciliation');
  const reconciliationPreview = await previewLifecycleReconciliation({ workspaceId: queued.workspaceId, specId });
  if (reconciliationPreview.specRevisionHash !== queued.specRevision
    || reconciliationPreview.compiledPlanId !== queued.compiledPlanId) {
    throw new UnprocessableError(
      'Lifecycle reconciliation preview is not bound to the queued assurance identity.',
      'LIFECYCLE_ASSURANCE_IDENTITY_MISMATCH',
      { stage: 'reconciliation', queued },
    );
  }
  const reconciliation = await applyLifecycleReconciliation({
    workspaceId: queued.workspaceId, specId, previewHash: reconciliationPreview.previewHash,
    idempotencyKey: keys.reconciliation, actorId: LIFECYCLE_ASSURANCE_EXECUTOR_ID,
    actorLabel: 'Rorca Lifecycle Assurance Worker',
  });
  return { ...queued, specId, projection, qualification, policy, reconciliation };
}

/** Register the assurance consumer only in the API process holding canonical evidence-writer authority. */
export async function registerLifecycleAssuranceWorker(boss: PgBoss): Promise<void> {
  await boss.work(LIFECYCLE_ASSURANCE_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const data = object(job.data);
      const workspaceId = typeof data.workspaceId === 'string' ? data.workspaceId : '';
      if (!workspaceId) throw new ValidationError('Invalid lifecycle assurance job workspace');
      if (data.kind === 'current-plan') {
        const specId = typeof data.specId === 'string' ? data.specId : '';
        if (!specId) throw new ValidationError('Invalid lifecycle current-plan job payload');
        await projectCurrentLifecyclePlanEvidence({ workspaceId, specId });
        continue;
      }
      const payload = assuranceJobPayload(data);
      await recordAssurancePublication(payload, 'processing', { jobId: job.id });
      try {
        await handleLifecycleAssurance(payload);
        await recordAssurancePublication(payload, 'completed', { jobId: job.id });
      } catch (error) {
        await recordAssurancePublication(payload, 'failed', {
          jobId: job.id,
          error: error instanceof Error ? error.message : 'lifecycle_assurance_failed',
        });
        throw error;
      }
    }
  });
}

/** Bounded restart repair for terminal runs lacking exact current receipts. */
export async function recoverRecentLifecycleAssurancePublications(limit = 20, boss?: PgBoss): Promise<void> {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
  let cursorFinishedAt: Date | string | null = null;
  let cursorRunId = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const runs: LifecycleAssuranceRecoveryRow[] = await query<LifecycleAssuranceRecoveryRow>(`
      SELECT run.id,run.workspace_id,
             COALESCE(run.finished_at,run.started_at) AS recovery_order_at
      FROM pipeline_runs run
      WHERE run.status='done' AND run.terminal_checkout_sha IS NOT NULL
        AND run.terminal_checkout_attested_at IS NOT NULL
        AND (
          run.trigger_options->'lifecycleAssurancePublication' IS NULL
          OR (
            run.trigger_options->'lifecycleAssurancePublication'->>'state' IS DISTINCT FROM 'completed'
            AND COALESCE(
              (run.trigger_options->'lifecycleAssurancePublication'->>'leaseExpiresAt')::timestamptz,
              '-infinity'::timestamptz
            ) <= NOW()
          )
        )
        AND (
          $2::timestamptz IS NULL
          OR (COALESCE(run.finished_at,run.started_at),run.id) < ($2::timestamptz,$3::bigint)
        )
      ORDER BY COALESCE(run.finished_at,run.started_at) DESC,run.id DESC
      LIMIT $1
    `, [bounded, cursorFinishedAt, cursorRunId]);
    await Promise.allSettled(runs.map((run: LifecycleAssuranceRecoveryRow) =>
      enqueueLifecycleAssuranceForRun({
        workspaceId: run.workspace_id,
        runId: run.id,
        ...(boss ? { boss } : {}),
      })));
    if (runs.length < bounded) return;
    const cursor: LifecycleAssuranceRecoveryRow = runs[runs.length - 1]!;
    cursorFinishedAt = cursor.recovery_order_at;
    cursorRunId = cursor.id;
  }
}
