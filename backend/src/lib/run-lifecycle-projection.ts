/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Projects immutable, host-attested run facts into the lifecycle evidence
 * ledger. Gate proof is deliberately limited to the phases the run can prove;
 * every phase also receives a non-gate execution observation so the Lifecycle
 * UI never hides the run that explains an unmet downstream release gate.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { query, queryOne } from '../db/index';
import { ConflictError } from './errors';
import { logger } from './logger';
import {
  LifecyclePlanSchema,
  normalizeSsdlcContractJson,
  type LifecyclePlan,
  type PhaseId,
} from './ssdlc-contracts';
import {
  createCanonicalEvidence,
  persistCanonicalEvidence,
  type CanonicalLifecycleEvidence,
  type EvidenceClassification,
} from './ssdlc-evidence';
import { inspectRunHostAuthority } from './run-host-authority';
import {
  lifecycleSourceEvidenceProjection,
  lifecycleSourceLens,
  type LifecycleSourceLens,
  projectLifecycleSourceMaterial,
  type LifecycleSourceEvidenceProjection,
} from './lifecycle-source-material';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40,64}$/;

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && SHA256.test(value);
}
const EARLY_PHASES: Partial<Record<PhaseId, true>> = {
  planning: true,
  requirements: true,
  design: true,
};

interface ProjectionRunRow {
  id: number;
  workspace_id: string;
  spec_path: string;
  status: string;
  canonical_spec_revision: string | null;
  terminal_checkout_sha: string | null;
  branch_name: string | null;
  merge_strategy: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

interface ProjectionPlanRow {
  id: string;
  plan_json: unknown;
  provenance_json: unknown;
}

interface ProjectionWorkspaceRow {
  id: string;
  path: string;
}


export interface LifecycleRunProjectionResult {
  runId: number;
  workspaceId: string;
  specSlug: string | null;
  status: 'projected' | 'skipped';
  reason: string | null;
  persisted: number;
  replayed: number;
}

export interface CurrentLifecyclePlanEvidenceResult {
  workspaceId: string;
  specSlug: string;
  compiledPlanId: string | null;
  specHash: string | null;
  status: 'projected' | 'skipped';
  reason: string | null;
  persisted: number;
  replayed: number;
}



function timestamp(value: Date | string | null): string {
  const parsed = value instanceof Date ? value : value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function evidenceClassification(value: string): EvidenceClassification {
  switch (value) {
    case 'approval': return 'approval';
    case 'documentation': return 'documentation';
    case 'code_change': return 'revision';
    case 'test_result': return 'testing';
    case 'security_finding': return 'risk_judgment';
    case 'release_operation': return 'deployment';
    case 'runtime_observation': return 'completion';
    default: throw new ConflictError(`Unsupported lifecycle evidence classification ${value}`);
  }
}

function expectedClassification(plan: LifecyclePlan, gateId: string): EvidenceClassification {
  const gate = plan.gates.find((candidate) => candidate.gateId === gateId);
  if (!gate) throw new ConflictError(`Lifecycle plan does not contain gate ${gateId}`);
  const classifications = [...new Set(plan.evidenceRequirements
    .filter((requirement) => gate.evidenceRequirementIds.includes(requirement.evidenceRequirementId))
    .map((requirement) => requirement.classification))];
  if (classifications.length !== 1 || !classifications[0]) {
    throw new ConflictError(`Lifecycle gate ${gateId} does not have one projectable evidence classification`);
  }
  return evidenceClassification(classifications[0]);
}

function runSummary(run: ProjectionRunRow, passed: number, expected: number): string {
  const terminal = run.terminal_checkout_sha ?? 'unknown terminal commit';
  const branch = run.branch_name ? ` on ${run.branch_name}` : '';
  const mode = run.merge_strategy === 'branch-only'
    ? 'branch-only; no protected integration, artifact, or deployment was requested'
    : `release mode ${run.merge_strategy ?? 'unspecified'}`;
  return `Run ${run.id} completed${branch}: ${passed}/${expected} frozen stories passed at ${terminal}; ${mode}.`;
}

function phaseObservation(run: ProjectionRunRow, phaseId: PhaseId, passed: number, expected: number): string {
  const base = runSummary(run, passed, expected);
  switch (phaseId) {
    case 'development':
      return `${base} Host closeout recorded the terminal implementation revision.`;
    case 'testing':
      return `${base} Host validation accepted every frozen story result.`;
    case 'deployment':
      return `${base} No artifact digest, staging deployment identity, merge approval, or production observation was recorded.`;
    case 'maintenance':
      return `${base} Outcome learning cannot be bound to a production deployment until one exists.`;
    default:
      return base;
  }
}

function planGateEvidence(input: {
  plan: LifecyclePlan;
  planId: string;
  specHash: string;
  observedAt: string;
  workspaceId: string;
  specSlug: string;
  gateId: string;
}): CanonicalLifecycleEvidence {
  const gate = input.plan.gates.find((candidate) => candidate.gateId === input.gateId);
  if (!gate) throw new ConflictError(`Lifecycle plan does not contain gate ${input.gateId}`);
  const subject = { type: 'spec_hash' as const, value: input.specHash };
  return createCanonicalEvidence({
    sourceType: 'wal_validation',
    sourceSystem: 'rorca:lifecycle-plan-projection',
    sourceEventId: `compiled-plan:${input.planId}:gate:${input.gateId}`,
    observedAt: input.observedAt,
    scope: {
      workspaceId: input.workspaceId,
      specSlug: input.specSlug,
      runId: null,
      storyId: null,
      phaseId: gate.phaseId,
      gateId: gate.gateId,
    },
    subject,
    phaseSubject: subject,
    classification: expectedClassification(input.plan, gate.gateId),
    status: 'passed',
    trustLevel: 'host_observed',
    confidence: 1,
    excerpt: `The current compiled plan structurally verified ${gate.title.toLocaleLowerCase()} against the canonical spec revision.`,
    rawReference: null,
    provenanceChain: [{
      system: 'rorca:ssdlc-plan',
      eventId: input.planId,
      observedAt: input.observedAt,
      verification: 'validated-current-compiled-plan',
    }],
    details: {
      evidenceRequirementIds: gate.evidenceRequirementIds,
      planId: input.planId,
      planVersion: input.plan.planVersion,
      policyVersion: input.plan.policyVersion,
      compilerVersion: input.plan.compilerVersion,
      projection: 'compiled_plan',
    },
  });
}

function sourceMaterialGateEvidence(input: {
  plan: LifecyclePlan;
  planId: string;
  specHash: string;
  observedAt: string;
  workspaceId: string;
  specSlug: string;
  gateId: string;
  source: LifecycleSourceEvidenceProjection;
}): CanonicalLifecycleEvidence {
  const gate = input.plan.gates.find((candidate) => candidate.gateId === input.gateId);
  if (!gate) throw new ConflictError(`Lifecycle plan does not contain gate ${input.gateId}`);
  if (input.source.releaseSubject.type !== 'spec_hash'
    || input.source.releaseSubject.value !== input.specHash) {
    throw new ConflictError('Lifecycle source authority is not bound to the current canonical spec revision');
  }
  const firstReference = input.source.references[0]!;
  const subject = { type: 'spec_hash' as const, value: input.specHash };
  return createCanonicalEvidence({
    sourceType: 'wal_validation',
    sourceSystem: 'rorca:lifecycle-source-evidence-projection',
    sourceEventId: `compiled-plan:${input.planId}:gate:${gate.gateId}:source:${input.source.projectionHash}`,
    observedAt: input.observedAt,
    scope: {
      workspaceId: input.workspaceId,
      specSlug: input.specSlug,
      runId: null,
      storyId: null,
      phaseId: gate.phaseId,
      gateId: gate.gateId,
    },
    subject,
    phaseSubject: subject,
    classification: 'documentation',
    status: 'passed',
    trustLevel: 'host_observed',
    confidence: 1,
    excerpt: `Trusted receipt-backed ${input.source.lens} source references from canonical package ${input.source.packageId} were byte-verified for the current canonical spec revision.`,
    rawReference: `${firstReference.artifactPath}#L${firstReference.startLine}-L${firstReference.endLine}`,
    provenanceChain: [{
      system: 'genesis:canonical-package-publication',
      eventId: input.source.authorityReceiptId,
      observedAt: input.observedAt,
      verification: 'trusted-ledger-publication-receipt-manifest-and-artifact-byte-verification',
    }],
    details: {
      evidenceRequirementIds: gate.evidenceRequirementIds,
      planId: input.planId,
      planVersion: input.plan.planVersion,
      policyVersion: input.plan.policyVersion,
      compilerVersion: input.plan.compilerVersion,
      specHash: input.specHash,
      packageId: input.source.packageId,
      packageHash: input.source.packageHash,
      previewHash: input.source.previewHash,
      snapshotHash: input.source.snapshotHash,
      authorityReceiptId: input.source.authorityReceiptId,
      authorityReceiptHash: input.source.authorityReceiptHash,
      authorityTrustRoot: 'rorca.lifecycle_source_publication_receipts',
      authorityVerification: 'exact_persisted_receipt',
      authorityIssuerPrincipal: { id: 'rorca:canonical-writer' },
      manifestHash: input.source.manifestHash,
      releaseSubject: input.source.releaseSubject,
      projectionHash: input.source.projectionHash,
      references: input.source.references,
      executionPrincipal: { id: 'genesis:export-pack-builder' },
      verifierPrincipal: {
        id: 'rorca:lifecycle-source-evidence-projector',
        independentFromExecution: true,
      },
      projection: 'current_spec_export_kit',
    },
  });
}

function runGateEvidence(input: {
  plan: LifecyclePlan;
  run: ProjectionRunRow;
  specSlug: string;
  terminalCommit: string;
  observedAt: string;
  gateId: string;
  passedStories: string[];
}): CanonicalLifecycleEvidence {
  const gate = input.plan.gates.find((candidate) => candidate.gateId === input.gateId);
  if (!gate) throw new ConflictError(`Lifecycle plan does not contain gate ${input.gateId}`);
  const subject = { type: 'commit_sha' as const, value: input.terminalCommit };
  return createCanonicalEvidence({
    sourceType: 'wal_validation',
    sourceSystem: 'rorca:lifecycle-run-projection',
    sourceEventId: `completed-run:${input.run.id}:gate:${input.gateId}`,
    observedAt: input.observedAt,
    scope: {
      workspaceId: input.run.workspace_id,
      specSlug: input.specSlug,
      runId: input.run.id,
      storyId: null,
      phaseId: gate.phaseId,
      gateId: gate.gateId,
    },
    subject,
    phaseSubject: subject,
    releaseIdentity: { commitSha: input.terminalCommit },
    classification: expectedClassification(input.plan, gate.gateId),
    status: 'passed',
    trustLevel: 'host_observed',
    confidence: 1,
    excerpt: `Host closeout accepted all ${input.passedStories.length} frozen stories for ${gate.title.toLocaleLowerCase()} at terminal commit ${input.terminalCommit}.`,
    rawReference: `run:${input.run.id}`,
    provenanceChain: [{
      system: 'rorca:pipeline_runs',
      eventId: String(input.run.id),
      observedAt: input.observedAt,
      verification: 'exact-terminal-host-closeout',
    }],
    details: {
      evidenceRequirementIds: gate.evidenceRequirementIds,
      planId: input.plan.planId,
      planVersion: input.plan.planVersion,
      policyVersion: input.plan.policyVersion,
      compilerVersion: input.plan.compilerVersion,
      terminalCommit: input.terminalCommit,
      passedStoryIds: input.passedStories,
      projection: 'completed_run_gate',
    },
  });
}

function runObservationEvidence(input: {
  plan: LifecyclePlan;
  run: ProjectionRunRow;
  specSlug: string;
  terminalCommit: string;
  observedAt: string;
  phaseId: PhaseId;
  passed: number;
  expected: number;
}): CanonicalLifecycleEvidence {
  return createCanonicalEvidence({
    sourceType: 'completion_signal',
    sourceSystem: 'rorca:lifecycle-run-projection',
    sourceEventId: `completed-run:${input.run.id}:phase:${input.phaseId}`,
    observedAt: input.observedAt,
    scope: {
      workspaceId: input.run.workspace_id,
      specSlug: input.specSlug,
      runId: input.run.id,
      storyId: null,
      phaseId: input.phaseId,
      gateId: null,
    },
    subject: { type: 'commit_sha', value: input.terminalCommit },
    phaseSubject: null,
    releaseIdentity: { commitSha: input.terminalCommit },
    classification: 'completion',
    status: 'passed',
    trustLevel: 'host_observed',
    confidence: 1,
    excerpt: phaseObservation(input.run, input.phaseId, input.passed, input.expected),
    rawReference: `run:${input.run.id}`,
    provenanceChain: [{
      system: 'rorca:pipeline_runs',
      eventId: String(input.run.id),
      observedAt: input.observedAt,
      verification: 'exact-terminal-host-closeout',
    }],
    details: {
      planId: input.plan.planId,
      planVersion: input.plan.planVersion,
      policyVersion: input.plan.policyVersion,
      compilerVersion: input.plan.compilerVersion,
      terminalCommit: input.terminalCommit,
      mergeStrategy: input.run.merge_strategy,
      projection: 'completed_run_phase_observation',
    },
  });
}

async function persistAll(records: CanonicalLifecycleEvidence[]): Promise<{ persisted: number; replayed: number }> {
  let persisted = 0;
  let replayed = 0;
  for (const record of records) {
    const result = await persistCanonicalEvidence(record);
    if (result.replayed) replayed += 1;
    else persisted += 1;
  }
  return { persisted, replayed };
}

/**
 * Idempotently project the exact current compiled plan and hash-bound export
 * kit references before dispatch. Raw spec and package content never enters
 * the evidence records.
 */
export async function projectCurrentLifecyclePlanEvidence(input: {
  workspaceId: string;
  specId: string;
}): Promise<CurrentLifecyclePlanEvidenceResult> {
  const specSlug = input.specId.trim();
  const empty = (reason: string, compiledPlanId: string | null = null, specHash: string | null = null): CurrentLifecyclePlanEvidenceResult => ({
    workspaceId: input.workspaceId,
    specSlug,
    compiledPlanId,
    specHash,
    status: 'skipped',
    reason,
    persisted: 0,
    replayed: 0,
  });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(specSlug)) return empty('invalid_spec_slug');
  const [workspace, planRow] = await Promise.all([
    queryOne<ProjectionWorkspaceRow>('SELECT id, path FROM workspaces WHERE id = $1', [input.workspaceId]),
    queryOne<ProjectionPlanRow>(`
      SELECT id::text, plan_json, provenance_json
      FROM ssdlc_compiled_plans
      WHERE workspace_id = $1 AND spec_slug = $2
        AND is_current = TRUE AND validation_status = 'validated'
      LIMIT 1
    `, [input.workspaceId, specSlug]),
  ]);
  if (!workspace) return empty('workspace_not_found');
  if (!planRow) return empty('current_plan_not_found');
  const plan = LifecyclePlanSchema.parse(planRow.plan_json);
  const provenance = planRow.provenance_json && typeof planRow.provenance_json === 'object' && !Array.isArray(planRow.provenance_json)
    ? planRow.provenance_json as Record<string, unknown>
    : {};
  const specHash = provenance.specHash;
  if (!isSha256(specHash)) return empty('current_plan_spec_hash_invalid', planRow.id);

  let specContent: Record<string, unknown>;
  let workspacePath: string;
  try {
    workspacePath = await fs.realpath(workspace.path);
    const approvedRoot = path.resolve(workspacePath, 'forge', 'specs', 'approved');
    const specPath = path.resolve(approvedRoot, `${specSlug}.json`);
    if (!specPath.startsWith(`${approvedRoot}${path.sep}`)) return empty('invalid_spec_slug', planRow.id, specHash);
    const parsed = JSON.parse(await fs.readFile(specPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return empty('current_spec_not_available', planRow.id, specHash);
    }
    specContent = parsed as Record<string, unknown>;
  } catch {
    return empty('current_spec_not_available', planRow.id, specHash);
  }
  const observedSpecHash = `sha256:${createHash('sha256').update(normalizeSsdlcContractJson(specContent)).digest('hex')}`;
  if (observedSpecHash !== specHash) return empty('current_plan_not_bound_to_exact_spec', planRow.id, specHash);

  const earlyGates = plan.gates.filter((gate) =>
    EARLY_PHASES[gate.phaseId] && gate.subjectRevisionRequirement === 'current_spec_revision');
  const lenses = [...new Set(earlyGates
    .map((gate) => lifecycleSourceLens(gate.phaseId))
    .filter((lens): lens is LifecycleSourceLens => lens !== null))];
  const sourceByLens = new Map(await Promise.all(lenses.map(async (lens) => {
    const material = await projectLifecycleSourceMaterial({
      workspacePath,
      workspaceId: input.workspaceId,
      specId: specSlug,
      specTitle: typeof specContent.title === 'string' ? specContent.title : null,
      specContent,
      releaseSubject: { type: 'spec_hash', value: specHash },
      lens,
    });
    return [lens, lifecycleSourceEvidenceProjection(material)] as const;
  })));
  const records = earlyGates.flatMap((gate) => {
    const compiled = planGateEvidence({
      plan,
      planId: planRow.id,
      specHash,
      observedAt: plan.compiledAt,
      workspaceId: input.workspaceId,
      specSlug,
      gateId: gate.gateId,
    });
    const lens = lifecycleSourceLens(gate.phaseId);
    const source = lens ? sourceByLens.get(lens) : null;
    return source ? [compiled, sourceMaterialGateEvidence({
      plan,
      planId: planRow.id,
      specHash,
      observedAt: plan.compiledAt,
      workspaceId: input.workspaceId,
      specSlug,
      gateId: gate.gateId,
      source,
    })] : [compiled];
  });
  const counts = await persistAll(records);
  return {
    workspaceId: input.workspaceId,
    specSlug,
    compiledPlanId: planRow.id,
    specHash,
    status: 'projected',
    reason: null,
    ...counts,
  };
}

/**
 * Idempotently project one completed run. It refuses to attach run proof to a
 * different current spec revision, retaining run history without fabricating
 * lifecycle completion after a material spec change.
 */
export async function projectLifecycleEvidenceForRun(input: {
  workspaceId: string;
  runId: number;
  compiledPlanId?: string;
  specRevision?: string;
  planId?: string;
}): Promise<LifecycleRunProjectionResult> {
  const run = await queryOne<ProjectionRunRow>(`
    SELECT id, workspace_id, spec_path, status, canonical_spec_revision,
           terminal_checkout_sha, branch_name, merge_strategy, started_at, finished_at
    FROM pipeline_runs
    WHERE id = $1 AND workspace_id = $2
  `, [input.runId, input.workspaceId]);
  if (!run) return {
    runId: input.runId, workspaceId: input.workspaceId, specSlug: null,
    status: 'skipped', reason: 'run_not_found', persisted: 0, replayed: 0,
  };
  // PostgreSQL BIGINT values arrive as strings. Keep the public projection
  // contract numeric so host-authority lookups do not silently miss the run.
  run.id = input.runId;

  const specSlug = path.basename(run.spec_path, '.json');
  const planRow = input.compiledPlanId === undefined
    ? await queryOne<ProjectionPlanRow>(`
      SELECT id::text, plan_json, provenance_json
      FROM ssdlc_compiled_plans
      WHERE workspace_id = $1 AND spec_slug = $2
        AND is_current = TRUE AND validation_status = 'validated'
      LIMIT 1
    `, [run.workspace_id, specSlug])
    : await queryOne<ProjectionPlanRow>(`
      SELECT id::text, plan_json, provenance_json
      FROM ssdlc_compiled_plans
      WHERE workspace_id = $1 AND spec_slug = $2 AND id = $3::bigint
        AND is_current = TRUE AND validation_status = 'validated'
      LIMIT 1
    `, [run.workspace_id, specSlug, input.compiledPlanId]);
  if (!planRow) return {
    runId: run.id, workspaceId: run.workspace_id, specSlug,
    status: 'skipped', reason: input.compiledPlanId === undefined ? 'current_plan_not_found' : 'exact_plan_not_found', persisted: 0, replayed: 0,
  };

  const plan = LifecyclePlanSchema.parse(planRow.plan_json);
  const provenance = planRow.provenance_json && typeof planRow.provenance_json === 'object' && !Array.isArray(planRow.provenance_json)
    ? planRow.provenance_json as Record<string, unknown>
    : {};
  const specHash = provenance.specHash;
  if (!isSha256(specHash) || run.canonical_spec_revision !== specHash) {
    return {
      runId: run.id, workspaceId: run.workspace_id, specSlug,
      status: 'skipped', reason: 'current_plan_not_bound_to_run_revision', persisted: 0, replayed: 0,
    };
  }
  if ((input.specRevision !== undefined && input.specRevision !== specHash)
    || (input.planId !== undefined && input.planId !== plan.planId)) {
    return {
      runId: run.id, workspaceId: run.workspace_id, specSlug,
      status: 'skipped', reason: 'exact_plan_identity_mismatch', persisted: 0, replayed: 0,
    };
  }

  const planEvidence = plan.gates
    .filter((gate) => EARLY_PHASES[gate.phaseId] && gate.subjectRevisionRequirement === 'current_spec_revision')
    .map((gate) => planGateEvidence({
      plan, planId: planRow.id, specHash, observedAt: plan.compiledAt,
      workspaceId: run.workspace_id, specSlug, gateId: gate.gateId,
    }));

  if (run.status !== 'done' || !run.terminal_checkout_sha || !GIT_SHA.test(run.terminal_checkout_sha)) {
    const counts = await persistAll(planEvidence);
    return {
      runId: run.id, workspaceId: run.workspace_id, specSlug,
      status: 'projected', reason: 'terminal_run_evidence_not_available', ...counts,
    };
  }
  const authority = await inspectRunHostAuthority(run.id);
  const terminalCommit = run.terminal_checkout_sha.toLowerCase();
  if (!authority
    || authority.workspaceId !== run.workspace_id
    || authority.specId !== specSlug
    || !authority.releaseEligible
    || authority.terminalRevision !== terminalCommit
    || authority.finalCommitSha !== terminalCommit) {
    const counts = await persistAll(planEvidence);
    return {
      runId: run.id, workspaceId: run.workspace_id, specSlug,
      status: 'projected', reason: 'terminal_host_authority_not_available', ...counts,
    };
  }

  const passedStories = authority.authoritativePassedStoryIds;
  const expectedStories = authority.expectedStoryIds;
  const observedAt = timestamp(run.finished_at);
  const runGateEvidenceRecords = plan.gates
    .filter((gate) => gate.gateId === 'gate-ctrl-development-trace-unit'
      || gate.gateId === 'gate-ctrl-testing-req-regression')
    .map((gate) => runGateEvidence({
      plan, run, specSlug, terminalCommit, observedAt,
      gateId: gate.gateId, passedStories: [...new Set(passedStories)].sort(),
    }));
  const observations = plan.phaseOrder.map((phaseId) => runObservationEvidence({
    plan, run, specSlug, terminalCommit, observedAt, phaseId,
    passed: passedStories.length, expected: expectedStories.length,
  }));
  const counts = await persistAll([...planEvidence, ...runGateEvidenceRecords, ...observations]);
  return {
    runId: run.id,
    workspaceId: run.workspace_id,
    specSlug,
    status: 'projected',
    reason: null,
    ...counts,
  };
}

/** Recover the bounded recent terminal window when a worker and HTTP server do not share an in-process SSE hub. */
export async function reconcileRecentCompletedRunLifecycleEvidence(limit = 20): Promise<void> {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 100));
  const runs = await query<{ id: number; workspace_id: string }>(`
    SELECT id, workspace_id
    FROM pipeline_runs
    WHERE status = 'done'
    ORDER BY finished_at DESC NULLS LAST, id DESC
    LIMIT $1
  `, [boundedLimit]);
  for (const run of runs) {
    try {
      await projectLifecycleEvidenceForRun({ workspaceId: run.workspace_id, runId: run.id });
    } catch (error) {
      logger.warn({ err: error, runId: run.id, workspaceId: run.workspace_id }, '[lifecycle-run-projection] completed-run recovery failed');
    }
  }
}
