/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Bridges exact-SHA GitHub delivery evidence into the existing Lifecycle
 * evidence/decision ledgers. It does not evaluate a second lifecycle model.
 */

import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { execute, queryOne, transaction } from '../db/index';
import { ConflictError, NotFoundError, UnprocessableError } from './errors';
import type { GithubPrDeliveryEvidence } from './github-pr-delivery-evidence';
import { createCanonicalEvidence, persistCanonicalEvidence } from './ssdlc-evidence';
import { LifecyclePlanSchema, type LifecyclePlan, type PhaseId } from './ssdlc-contracts';
import { getLifecycleSpec } from './ssdlc-lifecycle-read';

interface DeliveryAuthoritySnapshot {
  deliveryId: string;
  workspaceId: string;
  runId: number;
  policyId: string;
  policyDigest: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

interface LifecycleContext {
  specSlug: string;
  planDbId: string;
  plan: LifecyclePlan;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskAssignmentCount: number;
  profiles: string[];
}

export interface DeliveryLifecycleBridgeResult {
  testingEvidenceId: string;
  deploymentEvidenceId: string;
  mergeDecisionId: string | null;
  lifecycleReady: boolean;
  blockers: string[];
  mergeGateStatus: string;
  planApprovalRequirement: 'none' | 'policy' | 'human';
  snapshotId: string;
  evidenceHighWaterMark: string;
  decisionHighWaterMark: string;
}

const PRE_MERGE_PHASES: PhaseId[] = [
  'planning', 'requirements', 'design', 'development', 'testing',
];

function hash(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function fullProviderPass(evidence: GithubPrDeliveryEvidence, authority: DeliveryAuthoritySnapshot): boolean {
  return evidence.policy?.id === authority.policyId
    && evidence.policy.digest === authority.policyDigest
    && evidence.pullRequest.state === 'open'
    && evidence.pullRequest.draft === false
    && evidence.pullRequest.merged === false
    && evidence.pullRequest.mergeable === true
    && ['clean', 'has_hooks'].includes(evidence.pullRequest.mergeableState)
    && evidence.freshness.branchFresh
    && evidence.checkSummary.policyAvailable
    && evidence.checkSummary.policyScopeMatches
    && evidence.checkSummary.allRequiredPassed
    && !evidence.checksTruncated
    && evidence.reviewSummary.policyAvailable
    && evidence.reviewSummary.policyScopeMatches
    && evidence.reviewSummary.reviewSatisfied
    && !evidence.reviewsTruncated;
}

async function assertPersistedProviderEvidence(
  authority: DeliveryAuthoritySnapshot,
  evidence: GithubPrDeliveryEvidence,
): Promise<void> {
  const row = await queryOne<{ id: string }>(`
    SELECT id FROM github_pr_delivery_evidence
    WHERE id = $1 AND workspace_id = $2 AND run_id = $3
      AND policy_id = $4 AND policy_digest = $5
      AND repo_owner = $6 AND repo_name = $7 AND pr_number = $8
      AND head_sha = $9 AND payload_hash = $10
  `, [
    evidence.id, authority.workspaceId, authority.runId, authority.policyId,
    authority.policyDigest, evidence.repository.owner, evidence.repository.name,
    evidence.pullRequest.number, evidence.pullRequest.headSha, evidence.payloadHash,
  ]);
  if (!row) throw new ConflictError('GitHub delivery evidence is not the persisted canonical authority snapshot');
}

async function loadContext(authority: DeliveryAuthoritySnapshot): Promise<LifecycleContext> {
  const row = await queryOne<{
    spec_slug: string;
    plan_db_id: string;
    plan_json: unknown;
    provenance_json: Record<string, unknown> | string | null;
  }>(`
    SELECT regexp_replace(r.spec_path, '^.*/|\\.json$', '', 'g') AS spec_slug,
           cp.id::text AS plan_db_id, cp.plan_json, cp.provenance_json
    FROM pipeline_runs r
    JOIN LATERAL (
      SELECT id, plan_json, provenance_json
      FROM ssdlc_compiled_plans
      WHERE workspace_id = r.workspace_id
        AND spec_slug = regexp_replace(r.spec_path, '^.*/|\\.json$', '', 'g')
        AND is_current = TRUE
      ORDER BY created_at DESC
      LIMIT 1
    ) cp ON TRUE
    WHERE r.id = $1 AND r.workspace_id = $2
  `, [authority.runId, authority.workspaceId]);
  if (!row) throw new NotFoundError('Current lifecycle policy', `${authority.workspaceId}/${authority.runId}`);
  const parsed = LifecyclePlanSchema.safeParse(row.plan_json);
  if (!parsed.success) throw new UnprocessableError('Current lifecycle policy is invalid', 'INVALID_LIFECYCLE_POLICY');
  if (parsed.data.workspaceId !== authority.workspaceId || parsed.data.specId !== row.spec_slug) {
    throw new ConflictError('Current lifecycle policy identity does not match the delivery run');
  }
  const provenance = typeof row.provenance_json === 'string'
    ? JSON.parse(row.provenance_json) as Record<string, unknown>
    : row.provenance_json ?? {};
  const risk = provenance.riskLevel;
  const riskAssignmentCount = Number(provenance.riskAssignmentCount ?? 0);
  if (!['low', 'medium', 'high', 'critical'].includes(String(risk)) || riskAssignmentCount < 1) {
    throw new UnprocessableError('Lifecycle plan has no explicit authoritative risk classification', 'RISK_CLASSIFICATION_REQUIRED');
  }
  if (risk !== authority.riskLevel) throw new ConflictError('Delivery risk snapshot no longer matches the current lifecycle plan');
  return {
    specSlug: row.spec_slug,
    planDbId: row.plan_db_id,
    plan: parsed.data,
    riskLevel: risk as LifecycleContext['riskLevel'],
    riskAssignmentCount,
    profiles: Array.isArray(provenance.profiles)
      ? provenance.profiles.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function gateFor(context: LifecycleContext, phaseId: 'testing' | 'deployment') {
  // Prefer the phase's approval-requiring gate (the authority gate for merge/
  // deployment decisions); fall back to the first gate of the phase.
  const gate = context.plan.gates.find((candidate) =>
    candidate.phaseId === phaseId && candidate.approvalRequirement !== 'none')
    ?? context.plan.gates.find((candidate) => candidate.phaseId === phaseId);
  if (!gate) throw new UnprocessableError(`Lifecycle plan has no ${phaseId} gate`, 'LIFECYCLE_GATE_REQUIRED');
  return gate;
}

async function artifactDigestForHead(
  workspaceId: string,
  specSlug: string,
  headSha: string,
): Promise<string | null> {
  const row = await queryOne<{ artifact_digest: string | null }>(`
    SELECT COALESCE(
      NULLIF(release_identity->>'artifactDigest', ''),
      CASE WHEN subject_type = 'artifact_digest' THEN subject_value END
    ) AS artifact_digest
    FROM ssdlc_lifecycle_evidence
    WHERE workspace_id = $1 AND spec_slug = $2
      AND evidence_status = 'passed'
      AND revision_mismatch = FALSE
      AND trust_level IN ('host_observed', 'provider_verified')
      AND (
        lower(COALESCE(release_identity->>'commitSha', '')) = $3
        OR (subject_type = 'commit_sha' AND lower(subject_value) = $3)
      )
      AND (
        NULLIF(release_identity->>'artifactDigest', '') IS NOT NULL
        OR subject_type = 'artifact_digest'
      )
    ORDER BY observed_at DESC, id DESC
    LIMIT 1
  `, [workspaceId, specSlug, headSha]);
  return row?.artifact_digest ?? null;
}

async function persistGateEvidence(input: {
  authority: DeliveryAuthoritySnapshot;
  context: LifecycleContext;
  provider: GithubPrDeliveryEvidence;
  phaseId: 'testing' | 'deployment';
  passed: boolean;
  artifactDigest: string | null;
}) {
  const gate = gateFor(input.context, input.phaseId);
  const classification = input.phaseId === 'testing' ? 'testing' as const : 'approval' as const;
  const evidence = createCanonicalEvidence({
    sourceType: 'github_check',
    sourceSystem: 'github-pr-delivery',
    sourceEventId: `github-pr-delivery:${input.provider.id}:${input.context.plan.planId}:v${input.context.plan.planVersion}:${input.phaseId}`,
    observedAt: input.provider.providerObservedAt,
    scope: {
      workspaceId: input.authority.workspaceId,
      specSlug: input.context.specSlug,
      runId: input.authority.runId,
      storyId: null,
      phaseId: input.phaseId,
      gateId: gate.gateId,
    },
    subject: { type: 'commit_sha', value: input.provider.pullRequest.headSha },
    phaseSubject: { type: 'commit_sha', value: input.provider.pullRequest.headSha },
    releaseIdentity: {
      commitSha: input.provider.pullRequest.headSha,
      ...(input.artifactDigest ? { artifactDigest: input.artifactDigest } : {}),
    },
    classification,
    // Non-passing provider observations remain historical warnings. They do
    // not become permanent failed gate records when checks later turn green
    // on the same immutable SHA.
    status: input.passed ? 'passed' : 'unknown',
    trustLevel: 'provider_verified',
    confidence: 1,
    excerpt: input.passed
      ? `GitHub PR #${input.provider.pullRequest.number} ${input.phaseId} evidence passed for ${input.provider.pullRequest.headSha.slice(0, 12)}.`
      : `GitHub PR #${input.provider.pullRequest.number} ${input.phaseId} evidence is not yet eligible.`,
    rawReference: input.provider.pullRequest.url,
    provenanceChain: [{
      system: 'github',
      eventId: input.provider.id,
      observedAt: input.provider.providerObservedAt,
      verification: `payload:${input.provider.payloadHash}`,
    }],
    details: {
      policyVersion: input.context.plan.policyVersion,
      compilerVersion: input.context.plan.compilerVersion,
      evidenceRequirementIds: gate.evidenceRequirementIds,
      dependencyReferences: [`gate:${gate.gateId}`, 'subject:commit_sha'],
      githubPrDeliveryEvidenceId: input.provider.id,
      compiledPlanId: input.context.planDbId,
      deliveryProjectionKind: input.phaseId,
      providerEvidenceId: input.provider.id,
      providerPayloadHash: input.provider.payloadHash,
      policyId: input.authority.policyId,
      policyDigest: input.authority.policyDigest,
      checksPassed: input.provider.checkSummary.allRequiredPassed,
      reviewsSatisfied: input.provider.reviewSummary.reviewSatisfied,
      branchFresh: input.provider.freshness.branchFresh,
      mergeable: input.provider.pullRequest.mergeable,
      mergeableState: input.provider.pullRequest.mergeableState,
    },
    upstreamPayloadHash: input.provider.payloadHash,
  });
  return await persistCanonicalEvidence(evidence);
}

async function advisoryLock(client: PoolClient, key: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

async function recordPolicyApproval(input: {
  authority: DeliveryAuthoritySnapshot;
  context: LifecycleContext;
  headSha: string;
  providerEvidenceId: string;
}): Promise<string | null> {
  const mergeGate = gateFor(input.context, 'deployment');
  const existingHuman = await queryOne<{ id: string }>(`
    SELECT id::text
    FROM ssdlc_decisions
    WHERE workspace_id = $1 AND spec_slug = $2 AND phase_id = 'deployment'
      AND gate_id = $3 AND decision_type = 'deployment_approval'
      AND subject_type = 'commit_sha' AND lower(subject_value) = $4
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC, id DESC LIMIT 1
  `, [input.authority.workspaceId, input.context.specSlug, mergeGate.gateId, input.headSha]);
  if (existingHuman) return existingHuman.id;
  if (mergeGate.approvalRequirement !== 'policy') return null;
  if (!['low', 'medium'].includes(input.context.riskLevel)
    || input.context.profiles.some((profile) => ['security-sensitive', 'release-operations'].includes(profile))) {
    return null;
  }

  return await transaction(async (client) => {
    await advisoryLock(client, `autonomous-policy-approval:${input.authority.workspaceId}:${input.context.specSlug}:merge`);
    const activePolicy = (await client.query<{ id: string }>(`
      SELECT id FROM autonomous_delivery_policies
      WHERE id = $1 AND workspace_id = $2 AND policy_digest = $3
        AND status = 'active' AND expires_at > NOW()
        AND allowed_risk_levels ? $4
      FOR UPDATE
    `, [input.authority.policyId, input.authority.workspaceId, input.authority.policyDigest, input.context.riskLevel])).rows[0];
    if (!activePolicy) throw new ConflictError('Standing delivery policy is no longer active for this risk level');

    const exact = (await client.query<{ id: string }>(`
      SELECT id::text FROM ssdlc_decisions
      WHERE workspace_id = $1 AND spec_slug = $2 AND phase_id = 'deployment'
        AND gate_id = $3 AND decision_type = 'policy_approval'
        AND subject_type = 'commit_sha' AND lower(subject_value) = $4
        AND policy_reference = $5
        AND compiled_plan_id = $6::bigint AND plan_id = $7
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY created_at DESC, id DESC LIMIT 1
    `, [
      input.authority.workspaceId,
      input.context.specSlug,
      mergeGate.gateId,
      input.headSha,
      `autonomous-delivery:${input.authority.policyId}:${input.authority.policyDigest}`,
      input.context.planDbId,
      input.context.plan.planId,
    ])).rows[0];
    if (exact) return exact.id;

    await client.query(`
      UPDATE ssdlc_decisions
      SET revoked_at = NOW(), revoked_by_principal_type = 'internal_service',
          revoked_by_principal_id = 'autonomous-delivery-steward',
          revoked_by_display_label = 'Autonomous Delivery Steward',
          revocation_rationale = 'Exact PR head SHA changed; standing policy approval was invalidated.',
          revocation_source_request_id = $4
      WHERE workspace_id = $1 AND spec_slug = $2 AND phase_id = 'deployment'
        AND gate_id = $3 AND decision_type = 'policy_approval'
        AND revoked_at IS NULL
    `, [
      input.authority.workspaceId,
      input.context.specSlug,
      mergeGate.gateId,
      `autonomous-delivery-revoke:${input.authority.deliveryId}:${input.headSha}`,
    ]);

    const sourceRequestId = `autonomous-delivery-approval:${input.authority.deliveryId}:${input.providerEvidenceId}`;
    const policyReference = `autonomous-delivery:${input.authority.policyId}:${input.authority.policyDigest}`;
    const requestHash = hash({
      workspaceId: input.authority.workspaceId,
      specSlug: input.context.specSlug,
      runId: input.authority.runId,
      gateId: mergeGate.gateId,
      subject: input.headSha,
      policyReference,
      providerEvidenceId: input.providerEvidenceId,
    });
    const inserted = (await client.query<{ id: string }>(`
      INSERT INTO ssdlc_decisions (
        workspace_id, spec_slug, run_id, phase_id, gate_id, decision_type,
        rationale, subject_type, subject_value, policy_version, policy_reference,
        policy_authorized, principal_type, principal_id, principal_display_label,
        actor, source_request_id, source_channel, scope_key, request_hash, expires_at,
        compiled_plan_id, plan_id
      )
      SELECT $1, $2, $3, 'deployment', $4, 'policy_approval',
             'Active operator-owned standing policy authorized this exact reviewed PR revision.',
             'commit_sha', $5, $6, $7, TRUE, 'internal_service',
             'autonomous-delivery-steward', 'Autonomous Delivery Steward',
             'Autonomous Delivery Steward', $8, 'internal', $9, $10, p.expires_at,
             $12::bigint, $13
      FROM autonomous_delivery_policies p
      JOIN ssdlc_compiled_plans current_plan
        ON current_plan.id = $12::bigint
       AND current_plan.workspace_id = $1
       AND current_plan.spec_slug = $2
       AND current_plan.is_current = TRUE
       AND current_plan.validation_status = 'validated'
       AND current_plan.plan_json->>'planId' = $13
      WHERE p.id = $11
      ON CONFLICT (workspace_id, source_request_id) DO NOTHING
      RETURNING id::text
    `, [
      input.authority.workspaceId,
      input.context.specSlug,
      input.authority.runId,
      mergeGate.gateId,
      input.headSha,
      input.context.plan.policyVersion,
      policyReference,
      sourceRequestId,
      `${input.context.specSlug}|merge|${mergeGate.gateId}|*|${input.authority.runId}`,
      requestHash,
      input.authority.policyId,
      input.context.planDbId,
      input.context.plan.planId,
    ])).rows[0];
    if (!inserted) {
      const replay = (await client.query<{ id: string; request_hash: string }>(`
        SELECT id::text, request_hash FROM ssdlc_decisions
        WHERE workspace_id = $1 AND source_request_id = $2
      `, [input.authority.workspaceId, sourceRequestId])).rows[0];
      if (!replay || replay.request_hash !== requestHash) throw new ConflictError('Policy approval idempotency conflict');
      return replay.id;
    }
    await client.query(`
      INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
      VALUES ('decision_recorded', $1, $2, 'autonomous-delivery-steward', $3::jsonb)
    `, [input.authority.workspaceId, input.context.specSlug, JSON.stringify({
      workspaceId: input.authority.workspaceId,
      specId: input.context.specSlug,
      phaseId: 'deployment',
      runId: input.authority.runId,
      changeKind: 'policy_decision_created',
      action: 'recorded',
      decisionId: inserted.id,
      decisionType: 'policy_approval',
      gateId: mergeGate.gateId,
      policyId: input.authority.policyId,
      headSha: input.headSha,
    })]);
    return inserted.id;
  });
}

async function revokeRegressedPolicyApproval(input: {
  authority: DeliveryAuthoritySnapshot;
  context: LifecycleContext;
  headSha: string;
  providerEvidenceId: string;
}): Promise<void> {
  const mergeGate = gateFor(input.context, 'deployment');
  await execute(`
    UPDATE ssdlc_decisions
    SET revoked_at = NOW(), revoked_by_principal_type = 'internal_service',
        revoked_by_principal_id = 'autonomous-delivery-steward',
        revoked_by_display_label = 'Autonomous Delivery Steward',
        revocation_rationale = 'Current same-SHA GitHub checks or review policy regressed.',
        revocation_source_request_id = $6
    WHERE workspace_id = $1 AND spec_slug = $2 AND phase_id = 'deployment'
      AND gate_id = $3 AND decision_type = 'policy_approval'
      AND subject_type = 'commit_sha' AND lower(subject_value) = $4
      AND policy_reference = $5 AND revoked_at IS NULL
  `, [
    input.authority.workspaceId,
    input.context.specSlug,
    mergeGate.gateId,
    input.headSha,
    `autonomous-delivery:${input.authority.policyId}:${input.authority.policyDigest}`,
    `autonomous-delivery-regression:${input.authority.deliveryId}:${input.providerEvidenceId}`,
  ]);
}

export async function bridgeGithubEvidenceToLifecycle(input: {
  authority: DeliveryAuthoritySnapshot;
  evidence: GithubPrDeliveryEvidence;
}): Promise<DeliveryLifecycleBridgeResult> {
  const { authority, evidence } = input;
  if (evidence.workspaceId !== authority.workspaceId || evidence.runId !== authority.runId) {
    throw new ConflictError('GitHub evidence does not belong to this autonomous delivery');
  }
  if (evidence.pullRequest.headSha !== evidence.pullRequest.headSha.toLowerCase()) {
    throw new ConflictError('GitHub evidence head SHA is not canonical lowercase');
  }
  await assertPersistedProviderEvidence(authority, evidence);
  const context = await loadContext(authority);
  const artifactDigest = await artifactDigestForHead(authority.workspaceId, context.specSlug, evidence.pullRequest.headSha);
  const checksPassed = evidence.checkSummary.policyAvailable
    && evidence.checkSummary.policyScopeMatches
    && evidence.checkSummary.allRequiredPassed
    && !evidence.checksTruncated;
  const mergePassed = fullProviderPass(evidence, authority) && Boolean(artifactDigest);

  const validation = await persistGateEvidence({
    authority, context, provider: evidence, phaseId: 'testing', passed: checksPassed, artifactDigest,
  });
  const merge = await persistGateEvidence({
    authority, context, provider: evidence, phaseId: 'deployment', passed: mergePassed, artifactDigest,
  });
  if (!mergePassed) {
    await revokeRegressedPolicyApproval({
      authority,
      context,
      headSha: evidence.pullRequest.headSha,
      providerEvidenceId: evidence.id,
    });
  }
  const mergeDecisionId = mergePassed
    ? await recordPolicyApproval({
      authority,
      context,
      headSha: evidence.pullRequest.headSha,
      providerEvidenceId: evidence.id,
    })
    : null;

  const lifecycle = await getLifecycleSpec({ workspaceId: authority.workspaceId, specId: context.specSlug });
  const phases = lifecycle.phaseTimeline as Array<{
    phaseId: PhaseId;
    status: string;
    disposition: string | null;
    blocker: string | null;
  }>;
  const blockers: string[] = [];
  if (lifecycle.state !== 'current') blockers.push('lifecycle_plan_stale');
  for (const phaseId of PRE_MERGE_PHASES) {
    const phase = phases.find((candidate) => candidate.phaseId === phaseId);
    if (!phase) {
      blockers.push(`missing_phase:${phaseId}`);
      continue;
    }
    if (phase.disposition === 'not_applicable') continue;
    if (phase.status !== 'passed') blockers.push(`${phaseId}:${phase.status}${phase.blocker ? `:${phase.blocker}` : ''}`);
  }
  const mergePhase = phases.find((phase) => phase.phaseId === 'deployment');
  return {
    testingEvidenceId: validation.evidence.id,
    deploymentEvidenceId: merge.evidence.id,
    mergeDecisionId,
    lifecycleReady: blockers.length === 0,
    blockers,
    mergeGateStatus: mergePhase?.status ?? 'missing',
    planApprovalRequirement: gateFor(context, 'deployment').approvalRequirement,
    snapshotId: lifecycle.snapshotId,
    evidenceHighWaterMark: lifecycle.evidenceHighWaterMark,
    decisionHighWaterMark: lifecycle.decisionHighWaterMark,
  };
}
