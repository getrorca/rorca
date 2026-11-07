/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Bounded, workspace-scoped lifecycle read models for the dashboard. Mutable
 * phase state is never accepted from callers: every cell and detail is reduced
 * by the canonical evaluator from one plan/evidence/decision snapshot.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { query, queryOne, transaction } from '../db/index';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from './errors';
import { paginateArray, type PaginationParams } from './paginate';
import { SourceBundleV1Schema, type SourceBundleV1 } from './source-contracts';
import { inspectSourceDrift } from './source-drift';
import {
  CANONICAL_PHASES,
  humanizeLifecycleId,
  normalizeSsdlcContractJson,
  projectLegacyLifecycleRecordCompatibility,
  projectLifecyclePlanCompatibility,
  type EvaluatedStatus,
  type LifecyclePlan,
  type LifecycleProfile,
  type PhaseDisposition,
  type PhaseId,
  type ReleaseSubject,
} from './ssdlc-contracts';
import {
  PHASE_STATUS_RANK,
  aggregatePhaseEvaluations,
  evaluatePortfolio,
  type LifecycleEvaluation,
  type LifecycleEvaluationRunState,
  type PhaseEvaluation,
} from './ssdlc-phase-evaluator';
import { MISSION_STAGE_BY_PHASE, type MissionStage } from '../ssdlc/schema/control-schema';
import { classifySSDLCLiveness, type SSDLCLivenessReport } from './ssdlc-liveness';
import { getSpecPlanCompilationState, type SpecPlanCompilationState } from './ssdlc-plan-service';
import { inspectApprovedSpecPasses } from './ssdlc-pass-reconciler';
import { getNormalizedEvidenceById } from './ssdlc-evidence';
import { isHardDenyGate } from './ssdlc-decisions';
import {
  deriveCoverageByPhase,
  engineeringCanonMetadataFromSpec,
  resolveEngineeringCanonCoverage,
  type EngineeringCanonCoverage,
  type SpecCoverageByPhase,
} from './engineering-canon';
import { SkillRegistry } from './skill-registry';
import { lifecycleSourceLens, projectLifecycleSourceMaterial } from './lifecycle-source-material';
import { buildFeatureAssuranceMapInput } from './feature-assurance-map';
import {
  digestLifecycleReconciliationState,
  lifecycleReconciliationIdentityMatches,
  loadLifecycleReconciliationIdentities,
} from './lifecycle-reconciliation-watermarks';

export const LIFECYCLE_PORTFOLIO_MAX_SPECS = 500;
export const LIFECYCLE_EVALUATION_EVIDENCE_LIMIT = 500;
export const LIFECYCLE_EVALUATION_DECISION_LIMIT = 200;
const LIFECYCLE_EVALUATION_TOTAL_EVIDENCE_LIMIT = 5_000;
const LIFECYCLE_EVALUATION_TOTAL_DECISION_LIMIT = 2_000;
export const LIFECYCLE_TRACEABILITY_LIMIT = 200;
const LIFECYCLE_SPEC_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
const SPEC_STATUSES = ['pending', 'approved', 'completed', 'rejected'] as const;
const SORTS = ['current_view', 'updated_desc', 'title_asc', 'risk_desc', 'readiness_desc', 'owner_asc'] as const;
const DISPOSITIONS = ['required', 'deferred', 'not_applicable'] as const;
const EVALUATED_STATUSES = [
  'not_started', 'in_progress', 'blocked', 'awaiting_approval', 'passed', 'deferred', 'not_applicable', 'stale',
] as const;
const PRE_EXECUTION_PHASES: Partial<Record<PhaseId, true>> = {
  planning: true,
  requirements: true,
  design: true,
};
const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

interface LifecycleReadDb {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
}

const DEFAULT_READ_DB: LifecycleReadDb = { query, queryOne };

function clientReadDb(client: PoolClient): LifecycleReadDb {
  return {
    query: async <T>(sql: string, params?: unknown[]) => (await client.query(sql, params)).rows as T[],
    queryOne: async <T>(sql: string, params?: unknown[]) => (await client.query(sql, params)).rows[0] as T | undefined,
  };
}

async function withLifecycleReadSnapshot<T>(
  workspaceIdInput: string,
  read: (db: LifecycleReadDb, client: PoolClient) => Promise<T>,
): Promise<T> {
  const workspaceId = assertWorkspaceId(workspaceIdInput);
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    return read(clientReadDb(client), client);
  });
}

function assertWorkspaceId(workspaceIdInput: string): string {
  const workspaceId = text(workspaceIdInput, 'workspaceId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(workspaceId)) {
    throw new ValidationError('workspaceId must be a stable workspace identifier', { field: 'workspaceId' });
  }
  return workspaceId;
}

interface WorkspaceRow { id: string; path: string; label: string }
interface CandidateRow {
  spec_slug: string;
  title: string | null;
  spec_status: string | null;
  generated_at: Date | string | null;
  content_json: Record<string, unknown> | null;
  plan_db_id: string | null;
  spec_version: string | null;
  compiler_version: string | null;
  normalized_input_hash: string | null;
  plan_json: unknown;
  provenance_json: Record<string, unknown> | null;
  plan_created_at: Date | string | null;
  plan_updated_at: Date | string | null;
  plan_is_current: boolean | null;
  owner_id: string | null;
  owner_label: string | null;
}
interface EvidenceRow {
  id: string;
  spec_slug: string;
  spec_version: string | null;
  revision: string | null;
  compiled_plan_id: string | null;
  run_id: number | null;
  story_id: string | null;
  phase_id: string | null;
  gate_id: string | null;
  source_type: string;
  source_system: string;
  source_idempotency_key: string;
  subject_type: ReleaseSubject['type'];
  subject_value: string;
  phase_subject_type: ReleaseSubject['type'] | null;
  phase_subject_value: string | null;
  release_identity: Record<string, unknown> | null;
  classification: string;
  evidence_status: string;
  trust_level: string;
  confidence: number;
  excerpt: string | null;
  metadata: Record<string, unknown> | null;
  observed_at: Date | string;
  created_at: Date | string;
  revision_mismatch: boolean;
  lineage_verified: boolean;
  high_water_mark: string;
}
interface DecisionRow {
  id: string;
  spec_slug: string;
  spec_version: string | null;
  run_id: number | null;
  story_id: string | null;
  phase_id: string;
  gate_id: string | null;
  decision_type: string;
  rationale: string;
  evidence_gap: string | null;
  subject_type: 'commit_sha' | 'artifact_digest' | null;
  subject_value: string | null;
  policy_version: string;
  policy_reference: string;
  compiled_plan_id: string | null;
  plan_id: string | null;
  principal_type: string;
  principal_id: string;
  principal_display_label: string;
  created_at: Date | string;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  high_water_mark: string;
}
interface RunRow {
  spec_slug: string;
  id: number;
  status: string;
  pid: number | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  queue_position: number | null;
  trigger_type: string;
  agent_type: string;
  passed_stories: number;
  failed_stories: number;
  total_stories: number;
  learn_closeout_status: 'not_started' | 'generated' | 'blocked';
  learn_closeout_blocker: Record<string, unknown> | null;
  learn_closeout_attempted_at: Date | string | null;
  learn_candidate_count: number;
  learn_candidate_ids: unknown;
  learn_source_evidence_count: number;
  development_results: DevelopmentStoryResultRow[];
  development_integrations: DevelopmentIntegrationRow[];
  development_latest_event: DevelopmentLifecycleEventRow | null;
  development_reviews: DevelopmentReviewRow[];
}
interface DevelopmentStoryResultRow {
  id: number;
  story_id: string;
  status: string;
  retries: number;
  started_at: Date | string;
  finished_at: Date | string | null;
  elapsed_seconds: number | null;
  model_used: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
}
interface DevelopmentIntegrationRow {
  story_id: string;
  attempt: number;
  integration_order: number;
  state: string;
  source_commit: string;
  source_base_commit: string;
  resulting_head: string | null;
  failure_reason: string | null;
}
interface DevelopmentLifecycleEventRow {
  event_type: string;
  story_id: string | null;
}
interface DevelopmentReviewRow {
  story_id: string;
  validation_status: 'passed' | 'blocked';
  manifest_json: Record<string, unknown> | string;
}
export interface DevelopmentExecutionProjection {
  run: {
    id: string;
    status: string;
    agentType: string;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  activityStatus: 'not_started' | 'in_progress' | 'blocked' | 'completed';
  currentStoryId: string | null;
  stories: {
    total: number;
    passed: number;
    failed: number;
    items: Array<{
      storyId: string;
      status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'retrying';
      attempts: number;
      elapsedSeconds: number | null;
      modelUsed: string | null;
      commitSha: string | null;
      integrationState: string | null;
      resultingHead: string | null;
      failureReason: string | null;
    }>;
  };
  source: {
    worktreePath: string | null;
    branch: string | null;
    baseCommit: string | null;
    resultingHead: string | null;
    dirty: boolean | null;
  };
  changes: {
    commits: number;
    additions: number | null;
    deletions: number | null;
    files: Array<{ path: string; change: 'added' | 'modified' | 'deleted' | 'renamed' }>;
  };
  verification: Record<'hostReview' | 'unit' | 'typecheck' | 'build' | 'security' | 'secrets' | 'dependencies', {
    status: 'passed' | 'failed' | 'pending' | 'missing';
    evidence: string | null;
  }>;
  integration: {
    finalized: number;
    failed: number;
    expected: number;
    conflicted: number;
    resultingHead: string | null;
  };
}
interface LearnCandidateRow {
  id: number;
  spec_slug: string;
  status: string;
  category: string | null;
  confidence: string | null;
  provenance: Record<string, unknown> | string | null;
  security_sensitive: boolean;
  default_retrieval_eligible: boolean;
  created_at: Date | string;
}
export type LifecycleDeliveryStatus = 'unknown' | 'in_progress' | 'failed' | 'completed' | 'operator_attested' | 'superseded';
export type LifecycleAssuranceStatus = 'not_evaluated' | 'partial' | 'complete' | 'stale' | 'blocked';
export interface LifecycleReconciliationGap { code?: string; message?: string; stageId?: string }

interface ReconciliationProjectionRow {
  spec_slug: string;
  spec_revision_hash: string;
  compiled_plan_id: string | null;
  result_hash: string;
  reconciliation_watermarks: unknown;
  delivery_status: LifecycleDeliveryStatus;
  assurance_status: LifecycleAssuranceStatus;
  unresolved_gaps: LifecycleReconciliationGap[];
  operator_attestation: Record<string, unknown> | null;
  created_at: Date | string;
  freshness_current: boolean;
}

export interface LifecyclePortfolioFilters {
  search?: string;
  status?: typeof EVALUATED_STATUSES[number] | 'needs_compilation';
  specStatus?: typeof SPEC_STATUSES[number];
  phase?: PhaseId;
  stage?: MissionStage;
  risk?: typeof RISK_LEVELS[number];
  owner?: string;
  blocked?: boolean;
  disposition?: typeof DISPOSITIONS[number];
  sort: typeof SORTS[number];
  expectedSnapshotId?: string;
}
export type LifecycleExecutionStatus = 'not_started' | 'blocked' | 'ready' | 'queued' | 'running' | 'completed' | 'failed';
export type LifecycleDependencyStatus = 'ready' | 'waiting' | 'blocked';

export interface LifecycleAssuranceProjection {
  status: LifecycleAssuranceStatus;
  passedControls: number | null;
  totalControls: number | null;
  coverage: number | null;
  pendingPolicyApprovals: number;
  pendingHumanApprovals: number;
  rationale: string;
}

export interface LifecycleDeliveryProjection {
  status: LifecycleDeliveryStatus;
  rationale: string;
  reconciledAt: string | null;
}

export interface LifecycleReconciliationProjection {
  resultHash: string;
  assuranceStatus: LifecycleAssuranceStatus;
  unresolvedGaps: LifecycleReconciliationGap[];
  operatorAttested: boolean;
  createdAt: string;
}

export interface LifecycleReadinessProjection {
  execution: {
    status: LifecycleExecutionStatus;
    runId: number | null;
    rationale: string;
  };
  assurance: LifecycleAssuranceProjection;
  delivery: LifecycleDeliveryProjection & {
    reconciliation: LifecycleReconciliationProjection | null;
  };
}


export interface LifecyclePortfolioProjectionItem {
  specId: string;
  title: string;
  specStatus: string;
  state: SpecPlanCompilationState['status'];
  overallStatus: EvaluatedStatus | 'needs_compilation';
  risk: typeof RISK_LEVELS[number] | null;
  owner: { id: string; label: string } | null;
  storySummary: { total: number; passed: number | null; failed: number | null };
  currentPhaseId: PhaseId | null;
  blocked: boolean;
  blockers: Array<{ phaseId: PhaseId; reason: string }>;
  liveness: SSDLCLivenessReport | null;
  currentRevision: { specVersion: string | null; inputHash: string; planVersion: number } | null;
  phases: Array<{
    phaseId: PhaseId;
    displayName: string;
    status: EvaluatedStatus | 'unassessed';
    ownStatus: EvaluatedStatus | 'unassessed';
    dependencyStatus: LifecycleDependencyStatus;
    disposition: PhaseDisposition['disposition'] | null;
    gateProgress: { passed: number | null; required: number | null };
    rationale: string | null;
    blocker: string | null;
    nextSafeAction: string | null;
    learn?: unknown;
  }>;
  delivery: LifecycleDeliveryProjection;
  assurance: LifecycleAssuranceProjection;
  readiness: LifecycleReadinessProjection;
  reconciliation: LifecycleReconciliationProjection | null;
  snapshotId?: string;
  evidenceHighWaterMark?: string;
  decisionHighWaterMark?: string;
  updatedAt: string | null;
  recompileHint?: { safe: true; method: 'POST'; href: string };
}

export interface LifecyclePortfolioInput extends LifecyclePortfolioFilters {
  workspaceId: string;
  pagination: PaginationParams;
  candidateSpecIds?: string[];
}

export interface LifecycleSpecInput {
  workspaceId: string;
  specId: string;
  expectedSnapshotId?: string;
}

export interface LifecyclePhaseInput extends LifecycleSpecInput {
  phaseId: PhaseId;
  evidencePagination: PaginationParams;
}

interface EvaluationBundle {
  candidate: CandidateRow;
  plan: LifecyclePlan;
  evidenceRows: EvidenceRow[];
  decisionRows: DecisionRow[];
  evaluation: LifecycleEvaluation;
  evidenceHighWaterMark: string;
  decisionHighWaterMark: string;
  run: ReturnType<typeof runContext>;
  runRow: RunRow | undefined;
  learn: ReturnType<typeof learnSummary>;
  risk: typeof RISK_LEVELS[number] | null;
  owner: { id: string; label: string } | null;
  planState: SpecPlanCompilationState['status'];
}

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`${field} is required`, { field });
  const normalized = value.trim();
  if (normalized.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  return normalized;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Read only the exact frozen bundle persisted in this spec revision; legacy refs are not expanded. */
function persistedSourceBundle(candidate: CandidateRow): SourceBundleV1 | undefined {
  const contextUsed = record(candidate.content_json?.contextUsed);
  const verification = record(record(contextUsed.meta).sourceVerification);
  const parsed = SourceBundleV1Schema.safeParse(verification.sourceBundle);
  return parsed.success ? parsed.data : undefined;
}

function bounded<T>(items: readonly T[], limit = LIFECYCLE_TRACEABILITY_LIMIT): { items: T[]; total: number; truncated: boolean } {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}

function snapshotHash(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function stableEvaluationTime(): Date {
  // A minute bucket keeps one snapshot stable across a UI request burst while
  // still forcing refreshes when time-based decision expiry can change state.
  return new Date(Math.floor(Date.now() / 60_000) * 60_000);
}

async function workspace(workspaceIdInput: string, db: LifecycleReadDb = DEFAULT_READ_DB): Promise<WorkspaceRow> {
  const workspaceId = assertWorkspaceId(workspaceIdInput);
  const row = await db.queryOne<WorkspaceRow>('SELECT id, path, label FROM workspaces WHERE id = $1', [workspaceId]);
  if (!row) throw new NotFoundError('Workspace', workspaceId);
  return row;
}

function discoveredSpecFile(
  filePath: string,
  specSlug: string,
  status: 'pending' | 'approved',
  strict: boolean,
  workspacePath: string,
): { specSlug: string; title: string; status: string; generatedAt: string | null; content: Record<string, unknown> } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const realWorkspace = fs.realpathSync(workspacePath);
    const realFile = fs.realpathSync(filePath);
    if (realFile !== realWorkspace && !realFile.startsWith(`${realWorkspace}${path.sep}`)) {
      if (!strict) return null;
      throw new UnprocessableError(
        'Lifecycle spec does not resolve inside the selected workspace',
        'LIFECYCLE_SPEC_PATH_INVALID',
        {
          specId: specSlug,
          remediation: 'Replace the external spec link with canonical bytes inside the workspace spec directory.',
        },
      );
    }
    if (stat.size > LIFECYCLE_SPEC_DOCUMENT_MAX_BYTES) {
      if (!strict) return null;
      throw new UnprocessableError(
        'Lifecycle spec document exceeds the safe read bound',
        'LIFECYCLE_SPEC_TOO_LARGE',
        {
          specId: specSlug,
          maximumBytes: LIFECYCLE_SPEC_DOCUMENT_MAX_BYTES,
          remediation: 'Reduce the canonical spec document below the maximum size, then retry the exact lifecycle read.',
        },
      );
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Spec document root must be an object');
    }
    const content = parsed as Record<string, unknown>;
    return {
      specSlug,
      title: typeof content.title === 'string' ? content.title : specSlug,
      status,
      generatedAt: typeof content.generatedAt === 'string' ? content.generatedAt : null,
      content,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof UnprocessableError) throw error;
    if (!strict) return null;
    throw new UnprocessableError(
      'Lifecycle spec document is malformed and cannot be evaluated',
      'LIFECYCLE_SPEC_MALFORMED',
      {
        specId: specSlug,
        remediation: 'Repair the canonical spec JSON object, then retry the exact lifecycle read.',
      },
    );
  }
}

function discoverWorkspaceSpecs(
  workspacePath: string,
  selectedSpecIds?: ReadonlySet<string>,
): Array<{ specSlug: string; title: string; status: string; generatedAt: string | null; content: Record<string, unknown> }> {
  const discovered = new Map<string, { specSlug: string; title: string; status: string; generatedAt: string | null; content: Record<string, unknown> }>();
  if (selectedSpecIds) {
    for (const specSlug of [...selectedSpecIds].sort()) {
      for (const status of ['pending', 'approved'] as const) {
        const file = discoveredSpecFile(
          path.join(workspacePath, 'forge', 'specs', status, `${specSlug}.json`),
          specSlug,
          status,
          true,
          workspacePath,
        );
        if (file) discovered.set(specSlug, file);
      }
    }
    return [...discovered.values()];
  }
  for (const status of ['pending', 'approved'] as const) {
    const directory = path.join(workspacePath, 'forge', 'specs', status);
    let names: string[] = [];
    try { names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort(); } catch { continue; }
    for (const name of names) {
      if (discovered.size >= LIFECYCLE_PORTFOLIO_MAX_SPECS + 1) break;
      const specSlug = name.slice(0, -5);
      const file = discoveredSpecFile(path.join(directory, name), specSlug, status, false, workspacePath);
      if (file) discovered.set(specSlug, file);
    }
  }
  return [...discovered.values()];
}

async function loadCandidates(
  ws: WorkspaceRow,
  search?: string,
  db: LifecycleReadDb = DEFAULT_READ_DB,
  candidateSpecIds?: string[],
): Promise<CandidateRow[]> {
  const selectedCandidateSpecIds = candidateSpecIds ? [...new Set(candidateSpecIds)] : undefined;
  if (selectedCandidateSpecIds && selectedCandidateSpecIds.length > LIFECYCLE_PORTFOLIO_MAX_SPECS) {
    throw new ConflictError('Lifecycle candidate selection exceeds the bounded local view', {
      type: 'candidate_selection_too_large',
      maximumSpecs: LIFECYCLE_PORTFOLIO_MAX_SPECS,
      requestedSpecs: selectedCandidateSpecIds.length,
      remediation: 'Request a smaller explicit candidateSpecIds page.',
    });
  }
  if (selectedCandidateSpecIds?.some((specId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(specId))) {
    throw new ValidationError('candidateSpecIds must contain stable spec slugs', { field: 'candidateSpecIds' });
  }
  const rows = await db.query<CandidateRow>(`
    WITH indexed AS (
      SELECT s.spec_slug, s.spec_title AS title, s.status AS spec_status, s.generated_at
      FROM spec_search_index s
      WHERE s.workspace_id = $1
        AND ($2::text IS NULL OR s.search_vector @@ websearch_to_tsquery('english', $2))
        AND ($3::text[] IS NULL OR s.spec_slug = ANY($3::text[]))
    ), plan_only AS (
      SELECT DISTINCT ON (p.spec_slug)
             p.spec_slug, p.spec_slug AS title, NULL::text AS spec_status, p.created_at AS generated_at
      FROM ssdlc_compiled_plans p
      WHERE p.workspace_id = $1
        AND NOT EXISTS (SELECT 1 FROM indexed i WHERE i.spec_slug = p.spec_slug)
        AND ($2::text IS NULL OR p.spec_slug ILIKE '%' || $2 || '%')
        AND ($3::text[] IS NULL OR p.spec_slug = ANY($3::text[]))
      ORDER BY p.spec_slug, p.is_current DESC, p.created_at DESC, p.id DESC
    ), candidates AS (
      SELECT * FROM indexed UNION ALL SELECT * FROM plan_only
    )
    SELECT c.spec_slug, c.title, c.spec_status, c.generated_at,
           sv.content_json,
           p.id::text AS plan_db_id, p.spec_version, p.compiler_version,
           p.normalized_input_hash, p.plan_json, p.provenance_json,
           p.created_at AS plan_created_at, p.updated_at AS plan_updated_at,
           p.is_current AS plan_is_current,
           u.id AS owner_id, COALESCE(u.display_name, u.email) AS owner_label
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT content_json FROM spec_versions
      WHERE workspace_id = $1 AND spec_slug = c.spec_slug
      ORDER BY version DESC, id DESC LIMIT 1
    ) sv ON TRUE
    LEFT JOIN LATERAL (
      SELECT * FROM ssdlc_compiled_plans
      WHERE workspace_id = $1 AND spec_slug = c.spec_slug
      ORDER BY is_current DESC, created_at DESC, id DESC LIMIT 1
    ) p ON TRUE
    LEFT JOIN spec_assignments sa
      ON sa.workspace_id = $1 AND sa.spec_id = c.spec_slug AND sa.story_id = ''
    LEFT JOIN users u ON u.id = sa.assignee_id
    ORDER BY c.spec_slug
    LIMIT $4
  `, [ws.id, search ?? null, selectedCandidateSpecIds ?? null, LIFECYCLE_PORTFOLIO_MAX_SPECS + 1]);

  const bySlug = new Map(rows.map((row) => [row.spec_slug, row]));
  const selectedSpecIds = selectedCandidateSpecIds ? new Set(selectedCandidateSpecIds) : null;
  for (const file of discoverWorkspaceSpecs(ws.path, selectedSpecIds ?? undefined)) {
    if (search && !JSON.stringify(file.content).toLocaleLowerCase().includes(search.toLocaleLowerCase())) continue;
    const existing = bySlug.get(file.specSlug);
    if (existing) {
      // The canonical workspace document is the current subject. Database
      // versions remain historical inputs and never override these exact bytes.
      existing.content_json = file.content;
      continue;
    }
    bySlug.set(file.specSlug, {
      spec_slug: file.specSlug,
      title: file.title,
      spec_status: file.status,
      generated_at: file.generatedAt,
      content_json: file.content,
      plan_db_id: null,
      spec_version: null,
      compiler_version: null,
      normalized_input_hash: null,
      plan_json: null,
      provenance_json: null,
      plan_created_at: null,
      plan_updated_at: null,
      plan_is_current: null,
      owner_id: null,
      owner_label: null,
    });
  }
  const candidates = [...bySlug.values()].sort((a, b) => a.spec_slug.localeCompare(b.spec_slug));
  if (candidates.length > LIFECYCLE_PORTFOLIO_MAX_SPECS) {
    throw new ConflictError('Lifecycle portfolio exceeds the bounded local view', {
      type: 'narrow_filters_required',
      maximumSpecs: LIFECYCLE_PORTFOLIO_MAX_SPECS,
    });
  }
  return candidates;
}

async function loadEvidence(specSlugs: string[], workspaceId: string, db: LifecycleReadDb = DEFAULT_READ_DB): Promise<EvidenceRow[]> {
  if (specSlugs.length === 0) return [];
  const rows = await db.query<EvidenceRow & { bounded_rank: number }>(`
    WITH source_rows AS (
      SELECT e.id::text, e.spec_slug, e.spec_version, e.revision, e.compiled_plan_id::text,
             e.run_id, e.story_id, e.phase_id, e.gate_id,
             e.source_type, e.source_system, e.source_idempotency_key,
             e.subject_type, e.subject_value, e.phase_subject_type, e.phase_subject_value,
             e.release_identity, e.classification, e.evidence_status, e.trust_level,
             e.confidence, e.excerpt, e.metadata, e.observed_at, e.created_at,
             e.revision_mismatch, e.lineage_verified,
             MAX(e.id) OVER (PARTITION BY e.spec_slug)::text AS high_water_mark,
             ROW_NUMBER() OVER (
               PARTITION BY e.spec_slug, e.gate_id, e.source_type, e.source_system,
                            e.subject_type, e.subject_value, e.phase_subject_type, e.phase_subject_value,
                            e.classification, COALESCE(e.metadata->'details'->'evidenceRequirementIds', '[]'::jsonb)
               ORDER BY e.observed_at DESC, e.id DESC
             ) AS source_rank
      FROM ssdlc_lifecycle_evidence e
      WHERE e.workspace_id = $1 AND e.spec_slug = ANY($2::text[])
    ), effective AS (
      SELECT source_rows.*,
             ROW_NUMBER() OVER (
               PARTITION BY source_rows.spec_slug
               ORDER BY source_rows.observed_at DESC, source_rows.id::bigint DESC
             ) AS bounded_rank
      FROM source_rows
      WHERE source_rank = 1
    )
    SELECT *
    FROM effective
    WHERE bounded_rank <= $3
    ORDER BY spec_slug, observed_at DESC, id::bigint DESC
    LIMIT $4
  `, [
    workspaceId,
    specSlugs,
    LIFECYCLE_EVALUATION_EVIDENCE_LIMIT + 1,
    LIFECYCLE_EVALUATION_TOTAL_EVIDENCE_LIMIT + 1,
  ]);
  if (rows.length > LIFECYCLE_EVALUATION_TOTAL_EVIDENCE_LIMIT) {
    throw new ConflictError('Lifecycle evidence exceeds the bounded workspace evaluation set', {
      type: 'lifecycle_workspace_evidence_bound_exceeded',
      maximumEffectiveEvidence: LIFECYCLE_EVALUATION_TOTAL_EVIDENCE_LIMIT,
      remediation: 'Narrow the portfolio search or provide an explicit candidateSpecIds page before retrying.',
    });
  }
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.spec_slug, (counts.get(row.spec_slug) ?? 0) + 1);
  for (const specId of specSlugs) {
    if ((counts.get(specId) ?? 0) > LIFECYCLE_EVALUATION_EVIDENCE_LIMIT) {
      throw new ConflictError('Lifecycle evidence exceeds the deterministic evaluation bound', {
        type: 'lifecycle_evidence_bound_exceeded',
        specId,
        maximumEffectiveEvidence: LIFECYCLE_EVALUATION_EVIDENCE_LIMIT,
        remediation: 'Materialize an effective-evidence identity index while preserving every immutable evidence row, then retry.',
      });
    }
  }
  return rows;
}

async function loadDecisions(specSlugs: string[], workspaceId: string, db: LifecycleReadDb = DEFAULT_READ_DB): Promise<DecisionRow[]> {
  if (specSlugs.length === 0) return [];
  const rows = await db.query<DecisionRow & { bounded_rank: number }>(`
    SELECT * FROM (
      SELECT d.id::text, d.spec_slug, d.spec_version, d.run_id, d.story_id, d.phase_id, d.gate_id,
             d.decision_type, d.rationale, d.evidence_gap, d.subject_type, d.subject_value,
             d.policy_version, d.policy_reference, d.compiled_plan_id::text, d.plan_id,
             d.principal_type, d.principal_id, d.principal_display_label,
             d.created_at, d.expires_at, d.revoked_at,
             (MAX(d.id) OVER (PARTITION BY d.spec_slug))::text || ':' ||
             (EXTRACT(EPOCH FROM MAX(COALESCE(d.revoked_at, d.created_at)) OVER (PARTITION BY d.spec_slug)) * 1000)::bigint::text
               AS high_water_mark,
             ROW_NUMBER() OVER (PARTITION BY d.spec_slug ORDER BY d.created_at DESC, d.id DESC) AS bounded_rank
      FROM ssdlc_decisions d
      WHERE d.workspace_id = $1 AND d.spec_slug = ANY($2::text[])
    ) bounded
    WHERE bounded_rank <= $3
    ORDER BY spec_slug, created_at DESC, id::bigint DESC
    LIMIT $4
  `, [
    workspaceId,
    specSlugs,
    LIFECYCLE_EVALUATION_DECISION_LIMIT + 1,
    LIFECYCLE_EVALUATION_TOTAL_DECISION_LIMIT + 1,
  ]);
  if (rows.length > LIFECYCLE_EVALUATION_TOTAL_DECISION_LIMIT) {
    throw new ConflictError('Lifecycle decisions exceed the bounded workspace evaluation set', {
      type: 'lifecycle_workspace_decision_bound_exceeded',
      maximumDecisions: LIFECYCLE_EVALUATION_TOTAL_DECISION_LIMIT,
      remediation: 'Narrow the portfolio search or provide an explicit candidateSpecIds page before retrying.',
    });
  }
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.spec_slug, (counts.get(row.spec_slug) ?? 0) + 1);
  for (const specId of specSlugs) {
    if ((counts.get(specId) ?? 0) > LIFECYCLE_EVALUATION_DECISION_LIMIT) {
      throw new ConflictError('Lifecycle decisions exceed the deterministic evaluation bound', {
        type: 'lifecycle_decision_bound_exceeded',
        specId,
        maximumDecisions: LIFECYCLE_EVALUATION_DECISION_LIMIT,
        remediation: 'Materialize an effective-decision identity index while preserving every immutable decision and revocation fact, then retry.',
      });
    }
  }
  return rows;
}

async function loadLearnCandidates(specSlugs: string[], workspaceId: string, db: LifecycleReadDb = DEFAULT_READ_DB): Promise<Map<string, LearnCandidateRow[]>> {
  if (specSlugs.length === 0) return new Map();
  const rows = await db.query<LearnCandidateRow>(`
    SELECT * FROM (
      SELECT mc.id, mc.provenance->>'specId' AS spec_slug, mc.status, mc.category, mc.confidence,
             mc.provenance, mc.security_sensitive, mc.default_retrieval_eligible, mc.created_at,
             ROW_NUMBER() OVER (PARTITION BY mc.provenance->>'specId' ORDER BY mc.created_at DESC, mc.id DESC) AS bounded_rank
        FROM memory_candidates mc
       WHERE mc.workspace_id = $1
         AND mc.provenance->>'kind' = 'lifecycle_closeout'
         AND mc.provenance->>'specId' = ANY($2::text[])
    ) bounded WHERE bounded_rank <= 200
    ORDER BY spec_slug, created_at DESC, id DESC
  `, [workspaceId, specSlugs]);
  return new Map(specSlugs.map((slug) => [slug, rows.filter((row) => row.spec_slug === slug)]));
}

async function loadRuns(specSlugs: string[], workspaceId: string, db: LifecycleReadDb = DEFAULT_READ_DB): Promise<Map<string, RunRow>> {
  if (specSlugs.length === 0) return new Map();
  const rows = await db.query<RunRow>(`
    SELECT DISTINCT ON (regexp_replace(spec_path, '^.*/|\\.json$', '', 'g'))
           regexp_replace(spec_path, '^.*/|\\.json$', '', 'g') AS spec_slug,
           id, status, pid, started_at, finished_at, queue_position, trigger_type, agent_type,
           learn_closeout_status, learn_closeout_blocker, learn_closeout_attempted_at,
           learn_candidate_count, learn_candidate_ids, learn_source_evidence_count,
           (SELECT COUNT(*)::int FROM story_results sr WHERE sr.run_id = pipeline_runs.id AND sr.status = 'pass') AS passed_stories,
           (SELECT COUNT(*)::int FROM story_results sr WHERE sr.run_id = pipeline_runs.id AND sr.status IN ('fail', 'timeout')) AS failed_stories,
           (SELECT COUNT(*)::int FROM story_results sr WHERE sr.run_id = pipeline_runs.id) AS total_stories,
           COALESCE((
             SELECT jsonb_agg(to_jsonb(result) ORDER BY result.id)
             FROM (
               SELECT DISTINCT ON (story_id)
                      id, story_id, status, retries, started_at, finished_at, elapsed_seconds,
                      model_used, worktree_path, worktree_branch
               FROM story_results
               WHERE run_id = pipeline_runs.id
               ORDER BY story_id, id DESC
             ) result
           ), '[]'::jsonb) AS development_results,
           COALESCE((
             SELECT jsonb_agg(to_jsonb(integration) ORDER BY integration.integration_order)
             FROM (
               SELECT DISTINCT ON (story_id)
                      story_id, attempt, integration_order, state, source_commit,
                      source_base_commit, resulting_head, failure_reason
               FROM story_integration_ledger
               WHERE run_id = pipeline_runs.id
               ORDER BY story_id, attempt DESC
             ) integration
           ), '[]'::jsonb) AS development_integrations,
           COALESCE((
             SELECT jsonb_agg(to_jsonb(review) ORDER BY review.story_id)
             FROM (
               SELECT DISTINCT ON (story_id)
                      story_id, validation_status, manifest_json
               FROM local_review_bundles
               WHERE run_id = pipeline_runs.id
               ORDER BY story_id, attempt DESC
             ) review
           ), '[]'::jsonb) AS development_reviews,
           (
             SELECT jsonb_build_object('event_type', event_type, 'story_id', story_id)
             FROM wal_events
             WHERE canonical_run_id = pipeline_runs.id
               AND event_type IN ('story_started', 'story_passed', 'story_failed', 'story_timeout', 'story_timed_out')
             ORDER BY id DESC
             LIMIT 1
           ) AS development_latest_event
    FROM pipeline_runs
    WHERE workspace_id = $1
      AND regexp_replace(spec_path, '^.*/|\\.json$', '', 'g') = ANY($2::text[])
    ORDER BY regexp_replace(spec_path, '^.*/|\\.json$', '', 'g'), id DESC
  `, [workspaceId, specSlugs]);
  return new Map(rows.map((row) => [row.spec_slug, row]));
}

function evidenceSubject(row: Pick<EvidenceRow,
  'subject_type' | 'subject_value' | 'phase_subject_type' | 'phase_subject_value'>): ReleaseSubject {
  if (row.phase_subject_type && row.phase_subject_value) return { type: row.phase_subject_type, value: row.phase_subject_value } as ReleaseSubject;
  return { type: row.subject_type, value: row.subject_value } as ReleaseSubject;
}
function evidenceLineage(row: Pick<EvidenceRow, 'release_identity'>): Record<string, string> {
  const release = record(row.release_identity);
  return Object.fromEntries([
    'commitSha', 'artifactDigest', 'deploymentId', 'artifactCommitSha', 'deploymentArtifactDigest',
  ].flatMap((key) => typeof release[key] === 'string' ? [[key, release[key] as string]] : []));
}

export interface ReleaseIdentitySelectorEvidence {
  source_type: string;
  subject_type: ReleaseSubject['type'];
  evidence_status: string;
  trust_level: string;
  revision_mismatch: boolean;
  lineage_verified: boolean;
}

export interface ReleaseIdentityPrecedenceEvidence extends ReleaseIdentitySelectorEvidence {
  subject_value: string;
  phase_subject_type: ReleaseSubject['type'] | null;
  phase_subject_value: string | null;
  release_identity: Record<string, unknown> | null;
}

function canObserveActiveReleaseIdentity(row: ReleaseIdentitySelectorEvidence): boolean {
  if (row.revision_mismatch) return false;
  if (row.trust_level !== 'host_observed' && row.trust_level !== 'provider_verified') return false;
  if (row.subject_type === 'commit_sha') {
    return ['story_commit', 'github_check', 'wal_validation'].includes(row.source_type);
  }
  if (row.subject_type === 'artifact_digest') {
    return row.lineage_verified && ['github_check', 'staging_result'].includes(row.source_type);
  }
  if (row.subject_type === 'deployment_id') {
    return row.lineage_verified && row.source_type === 'deployment_proof';
  }
  return false;
}

/** Only authoritative successful observations may select the active release identity. */
export function canSelectActiveReleaseIdentity(row: ReleaseIdentitySelectorEvidence): boolean {
  return row.evidence_status === 'passed' && canObserveActiveReleaseIdentity(row);
}

/**
 * Evidence must be newest-first. The newest current authoritative observation
 * for each release subject type wins even when it failed; older passes cannot
 * resurrect authority. Downstream subjects must also extend the selected
 * commit/artifact lineage.
 */
export function selectActiveReleaseIdentities(evidence: readonly ReleaseIdentityPrecedenceEvidence[]): {
  subjects: Partial<Record<ReleaseSubject['type'], ReleaseSubject>>;
  lineage: NonNullable<LifecycleEvaluationRunState['releaseLineage']>;
} {
  const subjects: Partial<Record<ReleaseSubject['type'], ReleaseSubject>> = {};
  const lineage: NonNullable<LifecycleEvaluationRunState['releaseLineage']> = {};
  const newest: Partial<Record<ReleaseSubject['type'], ReleaseIdentityPrecedenceEvidence>> = {};
  for (const row of evidence) {
    if (canObserveActiveReleaseIdentity(row) && !newest[row.subject_type]) newest[row.subject_type] = row;
  }
  for (const subjectType of ['commit_sha', 'artifact_digest', 'deployment_id'] as const) {
    const row = newest[subjectType];
    if (!row || !canSelectActiveReleaseIdentity(row)) continue;
    const release = evidenceLineage(row);
    const subject = evidenceSubject(row);
    if (subject.type === 'artifact_digest' && lineage.commitSha
      && release.commitSha !== lineage.commitSha) continue;
    if (subject.type === 'deployment_id' && (
      (lineage.commitSha && release.commitSha !== lineage.commitSha)
      || (lineage.artifactDigest && release.artifactDigest !== lineage.artifactDigest)
    )) continue;
    if (release.commitSha) lineage.commitSha = release.commitSha;
    if (release.artifactDigest) lineage.artifactDigest = release.artifactDigest;
    if (release.deploymentId) lineage.deploymentId = release.deploymentId;
    subjects[subject.type] = subject;
  }
  return { subjects, lineage };
}

function activeSubjects(plan: LifecyclePlan, provenance: Record<string, unknown>, evidence: EvidenceRow[]): {
  activeReleaseSubject: ReleaseSubject;
  activeSubjects: LifecycleEvaluationRunState['activeSubjects'];
  releaseLineage: LifecycleEvaluationRunState['releaseLineage'];
} {
  const specHash = typeof provenance.specHash === 'string' && HASH_PATTERN.test(provenance.specHash)
    ? provenance.specHash
    : plan.inputHash;
  const subjects: NonNullable<LifecycleEvaluationRunState['activeSubjects']> = {
    spec_hash: { type: 'spec_hash', value: specHash },
  };
  const selected = selectActiveReleaseIdentities(evidence.filter((row) => {
    const contractIdentity = lifecycleEvidenceContractIdentity(row.metadata);
    return contractIdentity.policyVersion === plan.policyVersion
      && (!contractIdentity.compilerVersion || contractIdentity.compilerVersion === plan.compilerVersion);
  }));
  Object.assign(subjects, selected.subjects);
  return { activeReleaseSubject: subjects.spec_hash!, activeSubjects: subjects, releaseLineage: selected.lineage };
}

/** Missing/malformed legacy metadata never inherits the current plan identity. */
export function lifecycleEvidenceContractIdentity(metadata: unknown): {
  policyVersion?: string;
  compilerVersion?: string;
} {
  const details = record(record(metadata).details);
  return {
    ...(typeof details.policyVersion === 'string' ? { policyVersion: details.policyVersion } : {}),
    ...(typeof details.compilerVersion === 'string' ? { compilerVersion: details.compilerVersion } : {}),
  };
}

function evaluatorEvidence(row: EvidenceRow, _plan: LifecyclePlan): Record<string, unknown> {
  const details = record(record(row.metadata).details);
  return projectLegacyLifecycleRecordCompatibility({
    evidenceId: row.id,
    ...(row.gate_id ? { gateId: row.gate_id } : {}),
    source: `${row.source_type}:${row.source_system}`,
    collectedAt: iso(row.observed_at),
    subjectRevision: evidenceSubject(row),
    ...lifecycleEvidenceContractIdentity(row.metadata),
    status: row.evidence_status,
    classification: row.classification,
    trustLevel: row.trust_level,
    evidenceRequirementIds: Array.isArray(details.evidenceRequirementIds)
      ? details.evidenceRequirementIds.filter((item): item is string => typeof item === 'string')
      : [],
    dependencyReferences: Array.isArray(details.dependencyReferences)
      ? details.dependencyReferences.filter((item): item is string => typeof item === 'string')
      : [],
    ...(row.lineage_verified ? { releaseLineage: evidenceLineage(row) } : {}),
    sequence: row.id,
  }) as Record<string, unknown>;
}


function evaluatorDecision(row: DecisionRow, activeReleaseSubject: ReleaseSubject, compiledPlanId: string | null): Record<string, unknown> {
  return projectLegacyLifecycleRecordCompatibility({
    decisionId: row.id,
    phaseId: row.phase_id,
    ...(row.gate_id ? { gateId: row.gate_id } : {}),
    decisionType: row.decision_type,
    outcome: row.revoked_at ? 'rejected' : 'approved',
    subjectRevision: row.subject_type && row.subject_value
      ? { type: row.subject_type, value: row.subject_value }
      : activeReleaseSubject,
    policyVersion: row.policy_version,
    ...(row.decision_type === 'policy_approval'
      ? { planId: row.compiled_plan_id === compiledPlanId ? row.plan_id ?? undefined : undefined }
      : {}),
    decidedAt: iso(row.created_at),
    ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
    rationale: row.rationale,
    provenance: {
      principalType: row.principal_type,
      principalId: row.principal_id,
      displayLabel: row.principal_display_label,
    },
  }) as Record<string, unknown>;
}

function learnSummary(row: RunRow | undefined, candidates: LearnCandidateRow[]) {
  const selectedIds = new Set(asArray(row?.learn_candidate_ids).filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id)));
  const scopedCandidates = row?.learn_closeout_status === 'generated'
    ? candidates.filter((candidate) => selectedIds.has(candidate.id))
    : [];
  const parsed = scopedCandidates.map((candidate) => {
    const provenance = record(candidate.provenance);
    const release = record(provenance.releaseSubject);
    return {
      id: candidate.id,
      status: candidate.status,
      category: candidate.category,
      confidence: candidate.confidence,
      securitySensitive: candidate.security_sensitive,
      defaultRetrievalEligible: candidate.default_retrieval_eligible,
      createdAt: iso(candidate.created_at),
      provenance: {
        workspaceId: typeof provenance.workspaceId === 'string' ? provenance.workspaceId : null,
        specId: typeof provenance.specId === 'string' ? provenance.specId : null,
        runId: typeof provenance.runId === 'number' ? provenance.runId : null,
        storyId: typeof provenance.storyId === 'string' ? provenance.storyId : null,
        commitSha: typeof provenance.commitSha === 'string' ? provenance.commitSha : null,
        releaseSubject: typeof release.type === 'string' && typeof release.value === 'string' ? { type: release.type, value: release.value } : null,
        sourceEvidenceIds: asArray(provenance.sourceEvidenceIds).filter((id): id is string => typeof id === 'string').slice(0, 16),
        sourceDecisionIds: asArray(provenance.sourceDecisionIds).filter((id): id is string => typeof id === 'string').slice(0, 16),
        deduplicationKey: typeof provenance.deduplicationKey === 'string' ? provenance.deduplicationKey : null,
      },
    };
  });
  const reviewStates = parsed.reduce<Record<string, number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  const blockerRecord = record(row?.learn_closeout_blocker);
  const generationState = row?.learn_closeout_status ?? 'not_started';
  const blocker = generationState === 'blocked' || parsed.length === 0
    ? {
      code: typeof blockerRecord.code === 'string' ? blockerRecord.code : parsed.length === 0 ? 'no_reviewable_candidates' : 'generation_blocked',
      message: typeof blockerRecord.message === 'string' ? blockerRecord.message : parsed.length === 0
        ? 'No provenance-linked reviewable Learn candidate has been generated.'
        : 'Learn closeout generation is blocked.',
      retryable: blockerRecord.retryable !== false,
    }
    : null;
  const unresolved = parsed.filter((item) => item.status === 'pending' || item.status === 'review_required').length;
  return {
    requiredCandidateCount: 1,
    candidateCount: parsed.length,
    sourceEvidenceCount: Number(row?.learn_source_evidence_count ?? 0),
    reviewStates,
    generation: {
      state: generationState,
      attemptedAt: iso(row?.learn_closeout_attempted_at),
      blocker,
    },
    candidates: bounded(parsed, 25),
    nextAction: blocker
      ? 'Retry Learn closeout after resolving the reported evidence blocker.'
      : unresolved > 0
        ? `Review ${unresolved} provenance-linked candidate${unresolved === 1 ? '' : 's'}.`
        : 'Inspect the reviewed candidate evidence chain.',
  };
}

function runContext(row: RunRow | undefined, evidence: EvidenceRow[], workspaceId: string): null | {
  id: number;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  queuePosition: number | null;
  triggerType: string;
  agentType: string;
  stories: { total: number; passed: number; failed: number };
  liveness: SSDLCLivenessReport;
} {
  if (!row) return null;
  const activities = evidence.filter((item) => item.run_id === row.id).slice(0, 16).map((item) => ({
    source: 'database' as const,
    reference: `lifecycle-evidence:${item.id}`,
    observedAt: iso(item.observed_at),
    available: true,
    meaningful: item.evidence_status !== 'unknown',
    detail: `${item.source_type} ${item.evidence_status}`,
  }));
  const liveness = classifySSDLCLiveness({
    runId: row.id,
    workspaceId,
    dbStatus: row.status,
    startedAt: iso(row.started_at) ?? new Date(0).toISOString(),
    finishedAt: iso(row.finished_at),
    process: { available: false, alive: null, owned: null, pid: row.pid },
    activities,
    completion: {
      available: false,
      packetPresent: false,
      packetValidated: false,
      allStoriesTerminal: false,
      truncated: false,
      observedAt: null,
      reference: `pipeline-run:${row.id}`,
    },
    blockers: evidence.filter((item) => item.run_id === row.id && [
      'story_caused_failure', 'environment_credential_blocker',
    ].includes(item.evidence_status)).slice(0, 8).map((item) => ({
      text: item.excerpt ?? item.evidence_status,
      code: item.evidence_status,
      observedAt: iso(item.observed_at),
      evidenceReference: `lifecycle-evidence:${item.id}`,
    })),
  });
  return {
    id: row.id,
    status: row.status,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    queuePosition: row.queue_position,
    triggerType: row.trigger_type,
    agentType: row.agent_type,
    stories: { total: row.total_stories, passed: row.passed_stories, failed: row.failed_stories },
    liveness,
  };
}

function overallStatus(evaluation: LifecycleEvaluation): EvaluatedStatus {
  const included = evaluation.phases.filter((phase) => !phase.excluded);
  if (included.length === 0) return 'not_applicable';
  for (const status of ['stale', 'blocked', 'awaiting_approval', 'in_progress'] as const) {
    if (included.some((phase) => phase.status === status)) return status;
  }
  return included.every((phase) => phase.status === 'passed') ? 'passed' : 'not_started';
}

function planRisk(candidate: CandidateRow): typeof RISK_LEVELS[number] | null {
  const assuranceProfile = record(candidate.provenance_json?.assuranceProfile);
  const assuranceRisk = record(assuranceProfile.riskProfile).level;
  if (assuranceRisk === 'none') return null;
  if (RISK_LEVELS.includes(assuranceRisk as typeof RISK_LEVELS[number])) return assuranceRisk as typeof RISK_LEVELS[number];
  const value = candidate.provenance_json?.riskLevel;
  return RISK_LEVELS.includes(value as typeof RISK_LEVELS[number]) ? value as typeof RISK_LEVELS[number] : null;
}

function storyCount(candidate: CandidateRow, plan?: LifecyclePlan): number {
  if (plan) return plan.storyReferences.length;
  const content = record(candidate.content_json);
  return asArray(content.userStories ?? content.stories).length;
}

function candidateTitle(candidate: CandidateRow): string {
  const content = record(candidate.content_json);
  return typeof content.title === 'string' ? content.title : candidate.title ?? candidate.spec_slug;
}

function reduceEvaluatedStatus(statuses: readonly EvaluatedStatus[]): EvaluatedStatus {
  return statuses.reduce<EvaluatedStatus>((strongest, status) =>
    PHASE_STATUS_RANK[status] < PHASE_STATUS_RANK[strongest] ? status : strongest,
  'not_started');
}

export function projectLifecyclePhaseStatuses(
  evaluation: Pick<LifecycleEvaluation, 'phases'>,
  phase: PhaseEvaluation,
): { ownStatus: EvaluatedStatus; dependencyStatus: LifecycleDependencyStatus } {
  const ownGateIds = new Set(phase.gates.map((gate) => gate.gateId));
  const upstreamGateIds = new Set(phase.dependencies.flatMap((dependency) =>
    dependency.startsWith('gate:') && !ownGateIds.has(dependency.slice(5)) ? [dependency.slice(5)] : []));
  const upstreamStatuses = evaluation.phases.flatMap((candidate) =>
    candidate.gates.filter((gate) => upstreamGateIds.has(gate.gateId)).map((gate) => gate.status));
  const dependencyStatus: LifecycleDependencyStatus = upstreamStatuses.some((status) => status === 'blocked' || status === 'stale')
    ? 'blocked'
    : upstreamStatuses.some((status) => status !== 'passed')
      ? 'waiting'
      : 'ready';
  return {
    ownStatus: phase.excluded ? phase.status : reduceEvaluatedStatus(phase.gates.map((gate) => gate.status)),
    dependencyStatus,
  };
}

export function pendingLifecycleApprovalGates(
  plan: Pick<LifecyclePlan, 'gates'>,
  evaluation: Pick<LifecycleEvaluation, 'phases'>,
): { policyGateIds: string[]; humanGateIds: string[]; total: number } {
  const unresolvedGateIds = new Set(evaluation.phases.flatMap((phase) =>
    phase.excluded ? [] : phase.gates.filter((gate) => gate.status === 'awaiting_approval').map((gate) => gate.gateId)));
  const policyGateIds = [...new Set(plan.gates.filter((gate) =>
    unresolvedGateIds.has(gate.gateId) && gate.approvalRequirement === 'policy').map((gate) => gate.gateId))].sort();
  const humanGateIds = [...new Set(plan.gates.filter((gate) =>
    unresolvedGateIds.has(gate.gateId) && gate.approvalRequirement === 'human').map((gate) => gate.gateId))].sort();
  return { policyGateIds, humanGateIds, total: policyGateIds.length + humanGateIds.length };
}

export function projectLifecycleExecution(
  run: { id: number; status: string } | null,
  entryPhases: ReadonlyArray<{ phaseId: PhaseId; excluded: boolean; ownStatus: EvaluatedStatus; dependencyStatus: LifecycleDependencyStatus }>,
): LifecycleReadinessProjection['execution'] {
  if (run) {
    const normalized = run.status.toLowerCase();
    const status: LifecycleExecutionStatus = ['done', 'completed', 'succeeded', 'success'].includes(normalized) ? 'completed'
      : ['failed', 'partial_failure', 'cancelled', 'canceled', 'error'].includes(normalized) ? 'failed'
        : normalized === 'running' ? 'running'
          : ['queued', 'pending'].includes(normalized) ? 'queued'
            : ['blocked', 'paused'].includes(normalized) ? 'blocked'
              : normalized === 'ready' ? 'ready'
                : normalized === 'not_started' ? 'not_started'
                  : 'blocked';
    const rationale = status === 'completed'
      ? `Persisted run ${run.id} completed.`
      : status === 'failed'
        ? `Persisted run ${run.id} ended with status ${run.status}.`
        : status === 'blocked' && !['blocked', 'paused'].includes(normalized)
          ? `Persisted run ${run.id} has unsupported status ${run.status}; execution is blocked pending inspection.`
          : `Persisted run ${run.id} is ${status.replace(/_/g, ' ')}.`;
    return { status, runId: run.id, rationale };
  }
  const required = entryPhases.filter((phase) => !phase.excluded);
  const blocked = required.find((phase) =>
    phase.dependencyStatus === 'blocked' || ['blocked', 'stale', 'awaiting_approval'].includes(phase.ownStatus));
  if (blocked) {
    return {
      status: 'blocked',
      runId: null,
      rationale: `Execution is blocked by the ${blocked.phaseId} entry phase (${blocked.ownStatus.replace(/_/g, ' ')}).`,
    };
  }
  if (required.every((phase) => phase.ownStatus === 'passed' && phase.dependencyStatus === 'ready')) {
    return { status: 'ready', runId: null, rationale: 'All required pre-execution entry controls are satisfied.' };
  }
  return { status: 'not_started', runId: null, rationale: 'No run exists and one or more pre-execution entry controls remain unevaluated.' };
}

function projectLifecycleAssurance(bundle: Pick<EvaluationBundle, 'plan' | 'planState' | 'evaluation'>): LifecycleAssuranceProjection {
  const pending = pendingLifecycleApprovalGates(bundle.plan, bundle.evaluation);
  const staleControl = bundle.evaluation.phases.some((phase) =>
    !phase.excluded && phase.gates.some((gate) => gate.status === 'stale'));
  const blockedControl = bundle.evaluation.phases.some((phase) =>
    !phase.excluded && phase.gates.some((gate) => gate.status === 'blocked'));
  const status: LifecycleAssuranceProjection['status'] = bundle.planState !== 'current' || staleControl ? 'stale'
    : blockedControl ? 'blocked'
      : bundle.evaluation.counts.completionRate === 1 ? 'complete'
        : 'partial';
  const rationale = status === 'stale'
    ? 'The compiled lifecycle plan does not match the current spec revision.'
    : status === 'blocked'
      ? 'One or more applicable controls are blocked by current evaluated evidence.'
      : status === 'complete'
        ? 'Every applicable control is satisfied.'
        : pending.humanGateIds.length > 0
          ? `${pending.humanGateIds.length} unique human approval gate${pending.humanGateIds.length === 1 ? '' : 's'} remain unresolved.`
          : pending.policyGateIds.length > 0
            ? `${pending.policyGateIds.length} unique policy approval gate${pending.policyGateIds.length === 1 ? '' : 's'} remain unresolved.`
            : 'One or more applicable controls lack current satisfying evidence.';
  return {
    status,
    passedControls: bundle.evaluation.counts.passed,
    totalControls: bundle.evaluation.counts.denominator,
    coverage: bundle.evaluation.counts.denominator > 0
      ? bundle.evaluation.counts.passed / bundle.evaluation.counts.denominator
      : null,
    pendingPolicyApprovals: pending.policyGateIds.length,
    pendingHumanApprovals: pending.humanGateIds.length,
    rationale,
  };
}

/**
 * A running code-change pipeline is observable development activity, but it
 * does not satisfy a development gate by itself. Keep the evaluated gate
 * truth intact while preventing the read model from presenting active
 * implementation as "not started".
 */
export function projectLifecyclePhaseActivity(
  phaseId: PhaseId,
  evaluatedStatus: EvaluatedStatus,
  run: Pick<RunRow, 'id' | 'status'> | null | undefined,
): EvaluatedStatus {
  if (phaseId !== 'development' || evaluatedStatus !== 'not_started' || !run) return evaluatedStatus;
  if (run.status === 'running' || run.status === 'queued') return 'in_progress';
  if (run.status === 'failed' || run.status === 'partial_failure' || run.status === 'cancelled') return 'blocked';
  return evaluatedStatus;
}

function phaseCells(
  evaluation: LifecycleEvaluation,
  learn?: ReturnType<typeof learnSummary>,
  run?: Pick<RunRow, 'id' | 'status'>,
) {
  return CANONICAL_PHASES.map((canonical) => {
    const phase = evaluation.phases.find((item) => item.phaseId === canonical.id)!;
    const projected = projectLifecyclePhaseStatuses(evaluation, phase);
    const activityStatus = projectLifecyclePhaseActivity(canonical.id, phase.status, run);
    const learnMissing = canonical.id === 'maintenance' && (!learn || learn.candidateCount < learn.requiredCandidateCount);
    const learnBlocked = canonical.id === 'maintenance' && learn?.generation.state === 'blocked';
    return {
      phaseId: canonical.id,
      displayName: canonical.displayName,
      status: learnBlocked ? 'blocked' as const : learnMissing ? 'not_started' as const : activityStatus,
      activityStatus: learnBlocked ? 'blocked' as const : learnMissing ? 'not_started' as const : activityStatus,
      ownStatus: learnBlocked ? 'blocked' as const : learnMissing ? 'not_started' as const : projected.ownStatus,
      dependencyStatus: projected.dependencyStatus,
      disposition: phase.disposition.disposition,
      gateProgress: { passed: phase.counts.passed, required: phase.counts.total },
      rationale: phase.disposition.rationale,
      blocker: learnBlocked || learnMissing ? learn?.generation.blocker?.message ?? 'A reviewable Learn candidate is required.' : phase.blockerReason ?? null,
      nextSafeAction: canonical.id === 'maintenance' && learn ? learn.nextAction : phase.nextSafeAction ?? phase.nextUnmetGate?.nextSafeAction ?? null,
      ...(canonical.id === 'maintenance' && learn ? { learn } : {}),
    };
  });
}

function refreshRequired(expected: string | undefined, current: string, marks: { evidence: string; decision: string }): void {
  if (!expected || expected === current) return;
  throw new ConflictError('Lifecycle evaluation snapshot is stale; refresh before acting', {
    type: 'refresh_required',
    requestedSnapshotId: expected,
    currentSnapshotId: current,
    evidenceHighWaterMark: marks.evidence,
    decisionHighWaterMark: marks.decision,
  });
}

async function buildBundles(
  ws: WorkspaceRow,
  candidates: CandidateRow[],
  expectedSnapshotId?: string,
  db: LifecycleReadDb = DEFAULT_READ_DB,
): Promise<{
  bundles: EvaluationBundle[];
  evidenceHighWaterMark: string;
  decisionHighWaterMark: string;
  snapshotSetId: string;
}> {
  const planned = candidates.flatMap((candidate) => {
    if (candidate.plan_json === null) return [];
    try {
      return [{ candidate, plan: projectLifecyclePlanCompatibility(candidate.plan_json) }];
    } catch {
      return [];
    }
  });
  const specSlugs = candidates.map((item) => item.spec_slug);
  const [allEvidence, allDecisions, runs, learnCandidates] = await Promise.all([
    loadEvidence(specSlugs, ws.id, db),
    loadDecisions(specSlugs, ws.id, db),
    loadRuns(specSlugs, ws.id, db),
    loadLearnCandidates(specSlugs, ws.id, db),
  ]);
  const evidenceBySpec = new Map(specSlugs.map((slug) => [slug, allEvidence.filter((row) => row.spec_slug === slug)]));
  const decisionsBySpec = new Map(specSlugs.map((slug) => [slug, allDecisions.filter((row) => row.spec_slug === slug)]));
  const now = stableEvaluationTime();
  const entries = planned.map(({ candidate, plan }) => {
    const evidenceRows = evidenceBySpec.get(candidate.spec_slug) ?? [];
    const decisionRows = decisionsBySpec.get(candidate.spec_slug) ?? [];
    const subjects = activeSubjects(plan, candidate.provenance_json ?? {}, evidenceRows);
    const evidenceHighWaterMark = `evidence:${evidenceRows[0]?.high_water_mark ?? '0'}`;
    const decisionHighWaterMark = `decision:${decisionRows[0]?.high_water_mark ?? '0'}`;
    const runState: LifecycleEvaluationRunState = {
      ...subjects,
      evidenceHighWaterMark,
      decisionHighWaterMark,
    };
    return {
      candidate,
      plan,
      evidenceRows,
      decisionRows,
      runState,
      evaluatorEvidence: evidenceRows.filter((row) => !row.revision_mismatch && row.gate_id)
        .map((row) => evaluatorEvidence(row, plan)),
      evaluatorDecisions: decisionRows.map((row) => evaluatorDecision(row, subjects.activeReleaseSubject, candidate.plan_db_id)),
      evidenceHighWaterMark,
      decisionHighWaterMark,
    };
  });
  const portfolio = evaluatePortfolio(entries.map((entry) => ({
    plan: entry.plan,
    evidence: entry.evaluatorEvidence,
    decisions: entry.evaluatorDecisions,
    runState: entry.runState,
  })), now);
  const bundles = entries.map((entry, index): EvaluationBundle => {
    const candidate = entry.candidate;
    const runRow = runs.get(candidate.spec_slug);
    return {
      candidate,
      plan: entry.plan,
      evidenceRows: entry.evidenceRows,
      decisionRows: entry.decisionRows,
      evaluation: portfolio.evaluations[index],
      evidenceHighWaterMark: entry.evidenceHighWaterMark,
      decisionHighWaterMark: entry.decisionHighWaterMark,
      run: runContext(runRow, entry.evidenceRows, ws.id),
      runRow,
      learn: learnSummary(runRow, learnCandidates.get(candidate.spec_slug) ?? []),
      risk: planRisk(candidate),
      owner: candidate.owner_id ? { id: candidate.owner_id, label: candidate.owner_label ?? candidate.owner_id } : null,
      planState: candidate.plan_is_current ? 'current' : 'stale',
    };
  });
  const evidenceHighWaterMark = `evidence:${Math.max(0, ...allEvidence.map((row) => Number(row.high_water_mark) || 0))}`;
  const decisionHighWaterMark = `decision:${Math.max(0, ...allDecisions.map((row) => Number(row.high_water_mark) || 0))}`;
  refreshRequired(expectedSnapshotId, portfolio.snapshotSetId, { evidence: evidenceHighWaterMark, decision: decisionHighWaterMark });
  return { bundles, evidenceHighWaterMark, decisionHighWaterMark, snapshotSetId: portfolio.snapshotSetId };
}

function missingPlanItem(candidate: CandidateRow): LifecyclePortfolioProjectionItem {
  const delivery: LifecycleDeliveryProjection = {
    status: 'unknown',
    rationale: 'No exact-revision reconciliation receipt proves delivery state.',
    reconciledAt: null,
  };
  const assurance: LifecycleAssuranceProjection = {
    status: 'not_evaluated',
    passedControls: null,
    totalControls: null,
    coverage: null,
    pendingPolicyApprovals: 0,
    pendingHumanApprovals: 0,
    rationale: 'No current lifecycle plan exists for this exact spec revision.',
  };
  const reconciliation = null;
  return {
    specId: candidate.spec_slug,
    title: candidateTitle(candidate),
    specStatus: candidate.spec_status ?? 'unknown',
    state: 'needs_compilation',
    overallStatus: 'needs_compilation',
    risk: null,
    owner: candidate.owner_id ? { id: candidate.owner_id, label: candidate.owner_label ?? candidate.owner_id } : null,
    storySummary: { total: storyCount(candidate), passed: null, failed: null },
    currentPhaseId: null,
    blocked: false,
    blockers: [],
    liveness: null,
    currentRevision: null,
    delivery,
    assurance,
    readiness: {
      execution: {
        status: 'blocked',
        runId: null,
        rationale: 'Execution is blocked until a lifecycle plan is compiled for the current spec revision.',
      },
      assurance,
      delivery: { ...delivery, reconciliation },
    },
    reconciliation,
    phases: CANONICAL_PHASES.map((phase) => ({
      phaseId: phase.id,
      displayName: phase.displayName,
      status: 'unassessed',
      ownStatus: 'unassessed',
      dependencyStatus: 'waiting',
      disposition: null,
      gateProgress: { passed: null, required: null },
      rationale: null,
      blocker: null,
      nextSafeAction: 'Compile the lifecycle plan.',
    })),
    updatedAt: iso(candidate.generated_at),
    recompileHint: {
      safe: true,
      method: 'POST',
      href: `/api/specs/${encodeURIComponent(candidate.spec_slug)}/lifecycle/compile`,
    },
  };
}
function bundleItem(bundle: EvaluationBundle): LifecyclePortfolioProjectionItem {
  const evaluation = bundle.evaluation;
  const status = bundle.planState !== 'current' ? 'stale' : overallStatus(evaluation);
  const blockers = evaluation.phases.filter((phase) => phase.blockerReason).map((phase) => ({
    phaseId: phase.phaseId,
    reason: phase.blockerReason!,
  })).sort((a, b) => a.phaseId.localeCompare(b.phaseId));
  const phases = phaseCells(evaluation, bundle.learn, bundle.run ?? undefined);
  const assurance = projectLifecycleAssurance(bundle);
  const delivery: LifecycleDeliveryProjection = {
    status: bundle.run?.status === 'running' || bundle.run?.status === 'queued' ? 'in_progress'
      : bundle.run?.status === 'failed' || bundle.run?.status === 'partial_failure' ? 'failed'
        : 'unknown',
    rationale: bundle.run?.status === 'done'
      ? 'The latest run completed, but delivery integration requires an exact-revision reconciliation receipt.'
      : bundle.run
        ? `Latest run status: ${bundle.run.status}.`
        : 'No run evidence is available.',
    reconciledAt: null,
  };
  const reconciliation = null;
  const execution = projectLifecycleExecution(
    bundle.run ? { id: bundle.run.id, status: bundle.run.status } : null,
    phases.filter((phase) => PRE_EXECUTION_PHASES[phase.phaseId]).map((phase) => ({
      phaseId: phase.phaseId,
      excluded: phase.disposition !== 'required',
      ownStatus: phase.ownStatus as EvaluatedStatus,
      dependencyStatus: phase.dependencyStatus,
    })),
  );
  return {
    specId: bundle.candidate.spec_slug,
    title: candidateTitle(bundle.candidate),
    specStatus: bundle.candidate.spec_status ?? 'unknown',
    state: bundle.planState,
    overallStatus: status,
    risk: bundle.risk,
    owner: bundle.owner,
    storySummary: {
      total: bundle.plan.storyReferences.length,
      passed: bundle.run?.stories.passed ?? 0,
      failed: bundle.run?.stories.failed ?? 0,
    },
    currentPhaseId: evaluation.phases.find((phase) => !phase.excluded && phase.status !== 'passed')?.phaseId ?? 'maintenance',
    blocked: blockers.length > 0 || bundle.run?.liveness.state === 'blocked',
    blockers,
    liveness: bundle.run?.liveness ?? null,
    currentRevision: {
      specVersion: bundle.candidate.spec_version,
      inputHash: bundle.plan.inputHash,
      planVersion: bundle.plan.planVersion,
    },
    phases,
    snapshotId: evaluation.snapshot.snapshotId,
    evidenceHighWaterMark: bundle.evidenceHighWaterMark,
    decisionHighWaterMark: bundle.decisionHighWaterMark,
    updatedAt: iso(bundle.candidate.plan_updated_at ?? bundle.candidate.generated_at),
    delivery,
    assurance,
    readiness: {
      execution,
      assurance,
      delivery: { ...delivery, reconciliation },
    },
    reconciliation,
  };
}

function matchesPortfolio(item: LifecyclePortfolioProjectionItem, filters: LifecyclePortfolioFilters): boolean {
  if (filters.status && item.overallStatus !== filters.status) return false;
  if (filters.specStatus && item.specStatus !== filters.specStatus) return false;
  if (filters.risk && item.risk !== filters.risk) return false;
  if (filters.owner && item.owner?.id !== filters.owner) return false;
  if (filters.blocked !== undefined && item.blocked !== filters.blocked) return false;
  if (filters.phase && item.currentPhaseId !== filters.phase) return false;
  if (filters.stage && (!item.currentPhaseId || MISSION_STAGE_BY_PHASE[item.currentPhaseId] !== filters.stage)) return false;
  if (filters.disposition && !item.phases.some((phase) => phase.disposition === filters.disposition)) return false;
  return true;
}

export function candidateSpecHash(
  candidate: Pick<CandidateRow, 'content_json' | 'provenance_json'>,
): string | null {
  if (!candidate.content_json) return null;
  return `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(candidate.content_json)).digest('hex')}`;
}

function approvedSpecDocument(workspacePath: string, specId: string): Record<string, unknown> | null {
  const approvedRoot = path.resolve(workspacePath, 'forge', 'specs', 'approved');
  const specPath = path.resolve(approvedRoot, `${specId}.json`);
  if (!specPath.startsWith(`${approvedRoot}${path.sep}`)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function loadLatestReconciliations(
  workspaceId: string,
  workspacePath: string,
  candidates: CandidateRow[],
  db: LifecycleReadDb,
  client: PoolClient,
): Promise<ReconciliationProjectionRow[]> {
  const exactRevisions = candidates.flatMap((candidate) => {
    const revisionHash = candidateSpecHash(candidate);
    return revisionHash ? [{ specId: candidate.spec_slug, revisionHash }] : [];
  });
  if (exactRevisions.length === 0) return [];
  const receipts = await db.query<Omit<ReconciliationProjectionRow, 'freshness_current'>>(`
    WITH exact_revisions(spec_slug, spec_revision_hash) AS (
      SELECT * FROM unnest($2::text[], $3::text[])
    )
    SELECT DISTINCT ON (receipt.spec_slug)
           receipt.spec_slug, receipt.spec_revision_hash, receipt.compiled_plan_id::text,
           receipt.reconciliation_watermarks, receipt.result_hash, receipt.delivery_status,
           receipt.assurance_status, receipt.unresolved_gaps,
           COALESCE(receipt.operator_attestation, (
             SELECT attested.operator_attestation
             FROM ssdlc_reconciliation_receipts attested
             WHERE attested.workspace_id = receipt.workspace_id
               AND attested.spec_slug = receipt.spec_slug
               AND attested.spec_revision_hash = receipt.spec_revision_hash
               AND attested.operator_attestation IS NOT NULL
             ORDER BY attested.created_at DESC, attested.id DESC
             LIMIT 1
           )) AS operator_attestation,
           receipt.created_at
    FROM exact_revisions exact
    JOIN ssdlc_reconciliation_receipts receipt
      ON receipt.spec_slug = exact.spec_slug
     AND receipt.spec_revision_hash = exact.spec_revision_hash
    WHERE receipt.workspace_id = $1
    ORDER BY receipt.spec_slug, receipt.created_at DESC, receipt.id DESC
  `, [
    workspaceId,
    exactRevisions.map((item) => item.specId),
    exactRevisions.map((item) => item.revisionHash),
  ]);
  const currentIdentities = await loadLifecycleReconciliationIdentities(
    client,
    workspaceId,
    receipts.map((receipt) => receipt.spec_slug),
  );
  return receipts.map((receipt) => {
    const databaseIdentity = currentIdentities.get(receipt.spec_slug);
    const document = approvedSpecDocument(workspacePath, receipt.spec_slug);
    const currentIdentity = databaseIdentity && document ? {
      ...databaseIdentity,
      watermarks: {
        ...databaseIdentity.watermarks,
        mutationState: digestLifecycleReconciliationState({
          databaseMutationState: databaseIdentity.watermarks.mutationState,
          approvedSpecDocument: document,
        }),
      },
    } : null;
    return {
      ...receipt,
      freshness_current: lifecycleReconciliationIdentityMatches({
        compiledPlanId: receipt.compiled_plan_id,
        watermarks: receipt.reconciliation_watermarks,
      }, currentIdentity),
    };
  });
}

function withReconciliation(
  item: LifecyclePortfolioProjectionItem,
  candidate: CandidateRow,
  receipt: ReconciliationProjectionRow | undefined,
): LifecyclePortfolioProjectionItem {
  if (!receipt || receipt.spec_revision_hash !== candidateSpecHash(candidate)) return item;
  const operatorAttested = receipt.operator_attestation !== null;
  const reconciledAt = iso(receipt.created_at);
  if (!reconciledAt) return item;
  if (!receipt.freshness_current) {
    const reconciliation: LifecycleReconciliationProjection = {
      resultHash: receipt.result_hash,
      assuranceStatus: 'stale',
      unresolvedGaps: [
        ...receipt.unresolved_gaps,
        {
          code: 'RECONCILIATION_INPUTS_CHANGED',
          message: 'The compiled plan or a reconciliation high-water mark changed after this receipt was recorded.',
        },
      ],
      operatorAttested,
      createdAt: reconciledAt,
    };
    const delivery: LifecycleDeliveryProjection = {
      status: 'superseded',
      rationale: 'The exact-revision reconciliation receipt is stale because its authoritative inputs changed.',
      reconciledAt,
    };
    return {
      ...item,
      delivery,
      reconciliation,
      readiness: {
        ...item.readiness,
        delivery: { ...delivery, reconciliation },
      },
    };
  }
  const delivery: LifecycleDeliveryProjection = {
    status: receipt.delivery_status,
    rationale: operatorAttested
      ? 'Exact-revision delivery completion is operator-attested; assurance remains independently evaluated.'
      : `Exact-revision delivery reconciliation classified delivery as ${receipt.delivery_status.replace(/_/g, ' ')}.`,
    reconciledAt,
  };
  const reconciliation: LifecycleReconciliationProjection = {
    resultHash: receipt.result_hash,
    assuranceStatus: receipt.assurance_status,
    unresolvedGaps: receipt.unresolved_gaps,
    operatorAttested,
    createdAt: reconciledAt,
  };
  return {
    ...item,
    delivery,
    reconciliation,
    readiness: {
      ...item.readiness,
      delivery: { ...delivery, reconciliation },
    },
  };
}

async function countRecentPhaseTransitions(
  workspaceId: string,
  specIds: string[],
  db: LifecycleReadDb = DEFAULT_READ_DB,
): Promise<number> {
  if (specIds.length === 0) return 0;
  const row = await db.queryOne<{ total: number }>(`
    SELECT COUNT(*)::int AS total
    FROM wal_events
    WHERE workspace_id = $1
      AND spec_id = ANY($2::text[])
      AND event_type = 'lifecycle_changed'
      AND ts >= NOW() - INTERVAL '24 hours'
      AND NULLIF(payload->>'phaseId', '') IS NOT NULL
  `, [workspaceId, specIds]);
  return row?.total ?? 0;
}

function sortPortfolio(items: LifecyclePortfolioProjectionItem[], sort: LifecyclePortfolioFilters['sort']) {
  const tie = (a: typeof items[number], b: typeof items[number]) => a.specId.localeCompare(b.specId);
  return items.sort((a, b) => {
    switch (sort) {
      case 'title_asc': return a.title.localeCompare(b.title) || tie(a, b);
      case 'risk_desc': return (RISK_RANK[b.risk ?? ''] ?? -1) - (RISK_RANK[a.risk ?? ''] ?? -1) || tie(a, b);
      case 'readiness_desc': {
        const left = a.assurance.coverage ?? -1;
        const right = b.assurance.coverage ?? -1;
        return right - left || tie(a, b);
      }
      case 'owner_asc': return (a.owner?.label ?? '\uffff').localeCompare(b.owner?.label ?? '\uffff') || tie(a, b);
      case 'updated_desc': return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || tie(a, b);
      case 'current_view':
      default:
        return Number(b.blocked) - Number(a.blocked)
          || Number(b.overallStatus === 'in_progress') - Number(a.overallStatus === 'in_progress')
          || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
          || tie(a, b);
    }
  });
}

export async function getLifecyclePortfolio(input: LifecyclePortfolioInput) {
  return withLifecycleReadSnapshot(input.workspaceId, async (db, client) => {
  const ws = await workspace(input.workspaceId, db);
  const candidates = await loadCandidates(ws, input.search, db, input.candidateSpecIds);
  const [built, reconciliations] = await Promise.all([
    buildBundles(ws, candidates, input.expectedSnapshotId, db),
    loadLatestReconciliations(ws.id, ws.path, candidates, db, client),
  ]);
  const bySpec = new Map(built.bundles.map((bundle) => [bundle.candidate.spec_slug, bundle]));
  const reconciliationBySpec = new Map(reconciliations.map((receipt) => [receipt.spec_slug, receipt]));
  const allItems = sortPortfolio(candidates.map((candidate) => {
    const bundle = bySpec.get(candidate.spec_slug);
    const item = bundle ? bundleItem(bundle) : missingPlanItem(candidate);
    return withReconciliation(item, candidate, reconciliationBySpec.get(candidate.spec_slug));
  }).filter((item) => matchesPortfolio(item, input)), input.sort);
  const page = paginateArray(allItems, input.pagination, { cursorKey: (item) => item.specId });
  const visibleSpecIds = new Set(allItems.map((item) => item.specId));
  const visibleBundles = built.bundles.filter((bundle) => visibleSpecIds.has(bundle.candidate.spec_slug));
  const phaseCounts = aggregatePhaseEvaluations(visibleBundles.flatMap((bundle) => bundle.evaluation.phases));
  const recentPhaseTransitions = await countRecentPhaseTransitions(ws.id, [...visibleSpecIds], db);
  const missingGates = visibleBundles.reduce((total, bundle) => total + bundle.evaluation.phases.reduce(
    (phaseTotal, phase) => phaseTotal + (phase.excluded ? 0 : phase.gates.filter((gate) => gate.status !== 'passed').length),
    0,
  ), 0);
  // Readiness blockers are the traceability blockers a spec drawer shows; they are
  // distinct from lifecycle-blocked status (item.blocked) and from missing gates.
  const specsWithBlockers = visibleBundles.filter((bundle) =>
    traceability(bundle.plan, bundle.evaluation, bundle.evidenceRows, bundle.candidate.spec_version).blockers.total > 0,
  ).length;
  // The stage profile that compiled the visible plans (single general-sdlc-7
  // profile today). The newest plan wins; null when no compiled plan is visible
  // so the UI falls back to its bundled projection.
  const newestPlan = visibleBundles.reduce<LifecyclePlan | null>(
    (best, bundle) => (best === null || bundle.plan.compiledAt > best.compiledAt ? bundle.plan : best),
    null,
  );
  const stageProfile: LifecycleProfile | null = newestPlan?.profile ?? null;
  return {
    ...page,
    workspace: { id: ws.id, label: ws.label },
    phaseOrder: CANONICAL_PHASES,
    stageProfile,
    snapshotId: built.snapshotSetId,
    evidenceHighWaterMark: built.evidenceHighWaterMark,
    decisionHighWaterMark: built.decisionHighWaterMark,
    kpis: {
      specs: allItems.length,
      activeSpecs: allItems.filter((item) => item.specStatus !== 'completed' && item.specStatus !== 'rejected').length,
      evaluatedSpecs: visibleBundles.length,
      needsCompilation: allItems.filter((item) => item.state === 'needs_compilation').length,
      blockedSpecs: allItems.filter((item) => item.blocked).length,
      deliveredSpecs: allItems.filter((item) => item.delivery.status === 'completed' || item.delivery.status === 'operator_attested').length,
      inProgressSpecs: allItems.filter((item) => item.delivery.status === 'in_progress').length,
      needsReconciliation: allItems.filter((item) =>
        item.readiness.execution.status === 'completed'
        && (item.reconciliation === null || item.reconciliation.unresolvedGaps.length > 0)).length,
      assuranceComplete: allItems.filter((item) => item.assurance.status === 'complete').length,
      missingGates,
      specsWithBlockers,
      readyForQa: allItems.filter((item) => item.state === 'current' && !item.blocked && item.currentPhaseId === 'testing').length,
      waitingApprovals: allItems.reduce(
        (total, item) => total + item.assurance.pendingPolicyApprovals + item.assurance.pendingHumanApprovals,
        0,
      ),
      recentPhaseTransitions,
      stories: allItems.reduce((sum, item) => sum + item.storySummary.total, 0),
      phases: phaseCounts,
    },
  };
  });
}

async function loadOne(
  input: LifecycleSpecInput,
  db?: LifecycleReadDb,
): Promise<{ ws: WorkspaceRow; candidate: CandidateRow; bundle: EvaluationBundle | null; marks: { evidence: string; decision: string }; snapshotId: string }> {
  if (!db) return withLifecycleReadSnapshot(input.workspaceId, (snapshotDb) => loadOne(input, snapshotDb));
  const ws = await workspace(input.workspaceId, db);
  const specId = text(input.specId, 'specId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(specId)) {
    throw new ValidationError('specId must be a stable spec slug', { field: 'specId' });
  }
  const candidates = await loadCandidates(ws, undefined, db, [specId]);
  const candidate = candidates[0];
  if (!candidate) throw new NotFoundError('Lifecycle spec', specId);
  const built = await buildBundles(ws, [candidate], undefined, db);
  const bundle = built.bundles[0] ?? null;
  if (bundle) {
    try {
      bundle.planState = (await getSpecPlanCompilationState({
        workspaceId: ws.id,
        workspacePath: ws.path,
        specSlug: candidate.spec_slug,
      })).status;
    } catch {
      // Historical plan content remains inspectable if source-state probing fails.
    }
  }
  const snapshotId = bundle?.evaluation.snapshot.snapshotId ?? snapshotHash({
    workspaceId: ws.id,
    specId,
    state: 'needs_compilation',
    evidenceHighWaterMark: built.evidenceHighWaterMark,
    decisionHighWaterMark: built.decisionHighWaterMark,
  });
  refreshRequired(input.expectedSnapshotId, snapshotId, {
    evidence: built.evidenceHighWaterMark,
    decision: built.decisionHighWaterMark,
  });
  return {
    ws,
    candidate,
    bundle,
    marks: { evidence: built.evidenceHighWaterMark, decision: built.decisionHighWaterMark },
    snapshotId,
  };
}

type TraceabilityBlockerKind = 'requirement_to_story' | 'story_to_gate' | 'gate_to_evidence' | 'revision' | 'subject_coherence';

interface TraceabilityBlocker {
  kind: TraceabilityBlockerKind;
  requirementReference: string | null;
  storyReference: string | null;
  gateId: string | null;
  message: string;
  remediation: string;
}

function traceabilityBlocker(
  kind: TraceabilityBlockerKind,
  references: Pick<TraceabilityBlocker, 'requirementReference' | 'storyReference' | 'gateId'>,
  message: string,
  remediation: string,
): TraceabilityBlocker {
  return { kind, ...references, message, remediation };
}

function releaseBinding(row: EvidenceRow): { commitSha: string | null; artifactDigest: string | null; deploymentId: string | null } {
  const release = evidenceLineage(row);
  const subject = evidenceSubject(row);
  return {
    commitSha: release.commitSha ?? (subject.type === 'commit_sha' ? subject.value : null),
    artifactDigest: release.artifactDigest ?? (subject.type === 'artifact_digest' ? subject.value : null),
    deploymentId: release.deploymentId ?? (subject.type === 'deployment_id' ? subject.value : null),
  };
}

function traceability(plan: LifecyclePlan, evaluation: LifecycleEvaluation, evidenceRows: EvidenceRow[], specVersion: string | null) {
  const validEvidenceIds = new Set(evaluation.phases.flatMap((phase) => phase.evidence)
    .filter((item) => item.valid && item.satisfiesGate && item.evidenceId)
    .map((item) => item.evidenceId!));
  const blockers: TraceabilityBlocker[] = [];
  const gates = [...plan.gates].sort((a, b) => a.gateId.localeCompare(b.gateId)).map((gate) => {
    const phase = evaluation.phases.find((candidate) => candidate.phaseId === gate.phaseId);
    const evaluatedGate = phase?.gates.find((item) => item.gateId === gate.gateId);
    const gateEvidence = phase
      ? evidenceRows.filter((row) => row.gate_id === gate.gateId).map((row) => evidenceSummary(row, phase))
      : [];
    return {
      gateId: gate.gateId,
      phaseId: gate.phaseId,
      title: gate.title,
      status: evaluatedGate?.status ?? 'not_started',
      subjectRevisionRequirement: gate.subjectRevisionRequirement,
      evidenceRequirementIds: [...gate.evidenceRequirementIds].sort(),
      exactSubject: evaluatedGate?.expectedSubjectRevision ?? null,
      evidenceIds: [...(evaluatedGate?.evidenceIds ?? [])].sort(compareNumericIdsDesc),
      decisionIds: [...(evaluatedGate?.decisionIds ?? [])].sort(compareNumericIdsDesc),
      currentEvidence: gateEvidence.filter((item) => item.currentRevision),
      historicalEvidence: gateEvidence.filter((item) => !item.currentRevision),
    };
  });
  const gatesById = new Map(gates.map((gate) => [gate.gateId, gate]));
  const gateEvidenceBlockers = new Map<string, { gate: (typeof gates)[number]; requirements: Set<string> }>();
  const requirements = [...plan.requirementMappings]
    .sort((a, b) => a.requirementReference.localeCompare(b.requirementReference))
    .map((mapping) => {
      const stories = mapping.targetReferences.filter((target) => target.type === 'story').map((target) => target.reference).sort();
      const decisions = mapping.targetReferences.filter((target) => target.type === 'architecture_decision').map((target) => target.reference).sort();
      const mappedGates = mapping.gateIds.map((gateId) => gatesById.get(gateId)).filter((gate): gate is NonNullable<typeof gate> => Boolean(gate));
      const rowBlockers: TraceabilityBlocker[] = [];
      if (stories.length === 0) {
        rowBlockers.push(traceabilityBlocker('requirement_to_story', {
          requirementReference: mapping.requirementReference, storyReference: null, gateId: null,
        }, `Requirement ${mapping.requirementReference} has no mapped implementation story.`, `Map ${mapping.requirementReference} to at least one story in the lifecycle plan, then recompile the plan.`));
      }
      for (const story of stories) {
        if (mappedGates.length === 0) rowBlockers.push(traceabilityBlocker('story_to_gate', {
          requirementReference: mapping.requirementReference, storyReference: story, gateId: null,
        }, `Story ${story} has no required gate through requirement ${mapping.requirementReference}.`, `Add at least one gate mapping for ${mapping.requirementReference} covering ${story}, then recompile the plan.`));
      }
      for (const gate of mappedGates) {
        if (gate.currentEvidence.length === 0) {
          const existing = gateEvidenceBlockers.get(gate.gateId);
          if (existing) existing.requirements.add(mapping.requirementReference);
          else gateEvidenceBlockers.set(gate.gateId, { gate, requirements: new Set([mapping.requirementReference]) });
        }
      }
      blockers.push(...rowBlockers);
      return {
        requirementReference: mapping.requirementReference,
        stories,
        decisions,
        gateIds: [...mapping.gateIds].sort(),
        evidenceRequirementIds: [...mapping.evidenceRequirementIds].sort(),
        gates: mappedGates,
        blockers: rowBlockers,
      };
    });
  const endToEnd = requirements.flatMap((requirement) => requirement.stories.flatMap((storyReference) =>
    requirement.gates.map((gate) => ({
      requirementReference: requirement.requirementReference,
      storyReference,
      gateId: gate.gateId,
      phaseId: gate.phaseId,
      status: gate.status,
      exactSubject: gate.exactSubject,
      evidenceIds: gate.evidenceIds,
      decisionIds: gate.decisionIds,
    }))));
  for (const { gate, requirements } of gateEvidenceBlockers.values()) {
    const gateLabel = humanizeLifecycleId(gate.gateId);
    const evidenceLabels = gate.evidenceRequirementIds.map(humanizeLifecycleId);
    const mapped = [...requirements].sort();
    const mappedSummary = mapped.length === 0 ? '' : ` (mapped from ${mapped.length} requirement${mapped.length === 1 ? '' : 's'})`;
    blockers.push(traceabilityBlocker('gate_to_evidence', {
      requirementReference: null, storyReference: null, gateId: gate.gateId,
    }, `The ${gateLabel} gate has no eligible evidence for the bound revision.`,
    `Collect ${evidenceLabels.join(' and ')} evidence for the ${gateLabel} gate${mappedSummary}, then re-evaluate.`));
  }

  const evaluatedRevisionMismatches = new Set(evaluation.phases.flatMap((phase) => phase.evidence)
    .filter((item) => item.evidenceId && item.invalidReasons.includes('subject_revision_mismatch'))
    .map((item) => item.evidenceId!));
  const currentRows = evidenceRows.filter((row) => !row.revision_mismatch && !evaluatedRevisionMismatches.has(row.id));
  const lineageValues = currentRows.reduce((result, row) => {
    const binding = releaseBinding(row);
    result.commitSha ??= binding.commitSha;
    result.artifactDigest ??= binding.artifactDigest;
    result.deploymentId ??= binding.deploymentId;
    return result;
  }, { commitSha: null, artifactDigest: null, deploymentId: null } as { commitSha: string | null; artifactDigest: string | null; deploymentId: string | null });
  const acceptedSubjectTypes = new Set(plan.gates.flatMap((gate) => gate.acceptedSubjectTypes));
  const lineage = [
    { type: 'spec_hash' as const, status: 'available' as const, value: plan.inputHash },
    { type: 'commit_sha' as const, status: lineageValues.commitSha ? 'available' as const : acceptedSubjectTypes.has('commit_sha') ? 'absent' as const : 'not_applicable' as const, value: lineageValues.commitSha },
    { type: 'artifact_digest' as const, status: lineageValues.artifactDigest ? 'available' as const : acceptedSubjectTypes.has('artifact_digest') ? 'absent' as const : 'not_applicable' as const, value: lineageValues.artifactDigest },
    { type: 'deployment_id' as const, status: lineageValues.deploymentId ? 'available' as const : acceptedSubjectTypes.has('deployment_id') ? 'absent' as const : 'not_applicable' as const, value: lineageValues.deploymentId },
  ];
  for (const node of lineage) {
    if (node.status === 'absent') blockers.push(traceabilityBlocker('revision', {
      requirementReference: null, storyReference: null, gateId: null,
    }, `The active ${humanizeLifecycleId(node.type)} lineage link is absent.`, `Collect current-revision evidence that binds the ${humanizeLifecycleId(node.type)} without inventing an identifier.`));
  }

  const activeGateRows = currentRows.filter((row) => validEvidenceIds.has(row.id));
  const coherenceBindings = (['qa', 'merge', 'production'] as const).map((phaseId) => {
    const row = activeGateRows.find((candidate) => candidate.phase_id === phaseId && candidate.evidence_status === 'passed');
    return { phaseId, ...(row ? releaseBinding(row) : { commitSha: null, artifactDigest: null, deploymentId: null }) };
  });
  const coherenceMismatch = (['commitSha', 'artifactDigest'] as const).some((field) =>
    new Set(coherenceBindings.map((binding) => binding[field]).filter((value): value is string => Boolean(value))).size > 1);
  if (coherenceMismatch) blockers.push(traceabilityBlocker('subject_coherence', {
    requirementReference: null, storyReference: null, gateId: null,
  }, 'QA, merge, and production evidence do not bind to the same immutable commit/image.', 'Re-run the mismatched downstream gate against the active commit and artifact digest, then record replacement evidence; retain prior evidence as history.'));

  return {
    requirements: bounded(requirements),
    stories: bounded([...plan.storyReferences].sort()),
    architectureDecisions: bounded([...plan.architectureDecisionReferences].sort()),
    gates: bounded(gates),
    endToEnd: bounded(endToEnd),
    blockers: bounded(blockers),
    boundRevision: { specVersion, inputHash: plan.inputHash, planId: plan.planId, planVersion: plan.planVersion },
    subjectLineage: lineage,
    downstreamCoherence: {
      status: coherenceMismatch ? 'mismatch' as const : coherenceBindings.some((binding) => binding.commitSha || binding.artifactDigest)
        ? 'consistent' as const : 'insufficient_evidence' as const,
      bindings: coherenceBindings,
    },
    graphContext: { mode: 'relational' as const, relatedEvidenceLabels: [] as string[] },
    evidence: {
      total: evidenceRows.length,
      validForCurrentRevision: evidenceRows.filter((row) => validEvidenceIds.has(row.id)).length,
      stale: evidenceRows.filter((row) => row.revision_mismatch || !validEvidenceIds.has(row.id)).length,
      boundedAt: LIFECYCLE_EVALUATION_EVIDENCE_LIMIT,
    },
  };
}

/** Read the engineering-canon request metadata from the persisted spec (approved first, then pending). */
function specCanonMetadata(workspacePath: string, specId: string): Record<string, unknown> {
  for (const location of ['approved', 'pending']) {
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(workspacePath, 'forge', 'specs', location, `${specId}.json`), 'utf8')) as Record<string, unknown>;
      return engineeringCanonMetadataFromSpec(spec);
    } catch { /* try the other canonical persistence location */ }
  }
  return {};
}

async function resolveLifecycleCanonCoverage(workspaceId: string, workspacePath: string, specId: string) {
  const metadata = specCanonMetadata(workspacePath, specId);

  // Never project the persisted engineeringCanonCoverage field: it is writable
  // spec data and therefore cannot attest receipt identity, evidence, authority,
  // promotion, or N/A. Re-resolve and validate against the current bounded input.
  const registry = await new SkillRegistry().discover(workspacePath, workspaceId);
  return resolveEngineeringCanonCoverage({
    workspacePath,
    workspaceId,
    specId,
    metadata,
    skills: registry.getAll(),
  });
}

export interface LifecycleReconciliationSnapshot {
  state: string;
  plan: {
    databaseId: string | null;
    version: number;
    inputHash: string;
  } | null;
  profile: LifecycleProfile | null;
  provenance: Record<string, unknown>;
  overallReadiness: { counts: { total: number; passed: number } | null };
  phaseTimeline: Array<{
    phaseId: PhaseId;
    status: string;
    gateProgress: { passed: number; required: number };
  }>;
}

/**
 * Transaction-bound lifecycle state used by reconciliation. Callers own the
 * transaction so preview identity and receipt persistence can share one
 * database snapshot without opening a nested managed transaction.
 */
export async function getLifecycleReconciliationSnapshot(
  input: LifecycleSpecInput,
  client: PoolClient,
): Promise<LifecycleReconciliationSnapshot> {
  const loaded = await loadOne(input, clientReadDb(client));
  if (!loaded.bundle) {
    return {
      state: 'needs_compilation',
      plan: null,
      profile: null,
      provenance: {},
      overallReadiness: { counts: null },
      phaseTimeline: [],
    };
  }
  const bundle = loaded.bundle;
  return {
    state: bundle.planState,
    plan: {
      databaseId: bundle.candidate.plan_db_id,
      version: bundle.plan.planVersion,
      inputHash: bundle.plan.inputHash,
    },
    profile: { ...bundle.plan.profile },
    provenance: bundle.candidate.provenance_json ?? {},
    overallReadiness: {
      counts: {
        total: bundle.evaluation.counts.total,
        passed: bundle.evaluation.counts.passed,
      },
    },
    phaseTimeline: phaseCells(bundle.evaluation, bundle.learn, bundle.run ?? undefined).map((phase) => ({
      phaseId: phase.phaseId,
      status: phase.status,
      gateProgress: phase.gateProgress,
    })),
  };
}

export async function getLifecycleCompiledPlan(input: LifecycleSpecInput) {
  const { projectEcoCompiledPlan } = await import('./eco-provider-read');
  return withLifecycleReadSnapshot(input.workspaceId, async (db) => {
    const loaded = await loadOne(input, db);
    if (!loaded.bundle || loaded.bundle.planState !== 'current') {
      throw new ConflictError('No current validated compiled lifecycle plan');
    }
    return projectEcoCompiledPlan({
      workspaceId: loaded.ws.id,
      specId: loaded.candidate.spec_slug,
      providerSpecVersion: loaded.candidate.spec_version!,
      snapshotId: loaded.bundle.evaluation.snapshot.snapshotId,
      plan: loaded.bundle.plan,
    });
  });
}

export async function getLifecycleSpec(input: LifecycleSpecInput) {
  const { loaded, latestReconciliation } = await withLifecycleReadSnapshot(input.workspaceId, async (db, client) => {
    const loaded = await loadOne(input, db);
    const [latestReconciliation] = await loadLatestReconciliations(
      loaded.ws.id,
      loaded.ws.path,
      [loaded.candidate],
      db,
      client,
    );
    return { loaded, latestReconciliation };
  });
  const engineeringCanonCoverage = await resolveLifecycleCanonCoverage(
    loaded.ws.id,
    loaded.ws.path,
    loaded.candidate.spec_slug,
  );
  const sourceBundle = persistedSourceBundle(loaded.candidate);
  // Re-probe the immutable refs on every Mission detail read. The report is a
  // live observation only: neither the persisted bundle nor spec content is
  // replaced when local bytes differ.
  const sourceContext = sourceBundle
    ? await inspectSourceDrift(sourceBundle, { workspaceRoot: loaded.ws.path })
    : undefined;
  if (!loaded.bundle) {
    const missing = withReconciliation(
      missingPlanItem(loaded.candidate),
      loaded.candidate,
      latestReconciliation,
    );
    return {
      ...missing,
      workspaceId: loaded.ws.id,
      plan: null,
      profile: null,
      provenance: null,
      sourceBundle,
      sourceContext,
      overallReadiness: { ready: null, completionRate: null, counts: null },
      phaseTimeline: missing.phases,
      traceability: {
        requirements: bounded([]),
        stories: bounded([]),
        architectureDecisions: bounded([]),
        gates: bounded([]),
        endToEnd: bounded([]),
        blockers: bounded([]),
        evidence: {
          total: 0,
          validForCurrentRevision: 0,
          stale: 0,
          boundedAt: LIFECYCLE_EVALUATION_EVIDENCE_LIMIT,
        },
      },
      currentRun: null,
      engineeringCanonCoverage,
      evaluationSnapshot: {
        snapshotId: loaded.snapshotId,
        evidenceHighWaterMark: loaded.marks.evidence,
        decisionHighWaterMark: loaded.marks.decision,
      },
      snapshotId: loaded.snapshotId,
      evidenceHighWaterMark: loaded.marks.evidence,
      decisionHighWaterMark: loaded.marks.decision,
    };
  }
  const bundle = loaded.bundle;
  const approvedSpecPath = `forge/specs/approved/${bundle.candidate.spec_slug}.json`;
  const reconciliationReport = fs.existsSync(path.join(loaded.ws.path, approvedSpecPath))
    ? await inspectApprovedSpecPasses({
      workspaceId: loaded.ws.id,
      workspacePath: loaded.ws.path,
      specPath: approvedSpecPath,
    })
    : null;
  const reconciliation = reconciliationReport ? {
    specRevision: reconciliationReport.specRevision,
    blocking: reconciliationReport.blocking,
    repairedStoryIds: reconciliationReport.repairedStoryIds,
    stories: bounded(reconciliationReport.stories),
  } : null;
  const portfolioItem = withReconciliation(bundleItem(bundle), bundle.candidate, latestReconciliation);
  return {
    workspaceId: loaded.ws.id,
    specId: bundle.candidate.spec_slug,
    title: candidateTitle(bundle.candidate),
    state: bundle.planState,
    stale: bundle.planState !== 'current',
    plan: {
      id: bundle.plan.planId,
      databaseId: bundle.candidate.plan_db_id,
      version: bundle.plan.planVersion,
      specVersion: bundle.candidate.spec_version,
      schemaVersion: bundle.plan.schemaVersion,
      compilerVersion: bundle.plan.compilerVersion,
      policyVersion: bundle.plan.policyVersion,
      inputHash: bundle.plan.inputHash,
      compiledAt: bundle.plan.compiledAt,
    },
    profile: { ...bundle.plan.profile },
    provenance: bundle.candidate.provenance_json ?? {},
    sourceBundle,
    sourceContext,
    overallReadiness: {
      ready: bundle.evaluation.counts.completionRate === 1 && !bundle.evaluation.refetchRequired,
      status: bundle.planState !== 'current' ? 'stale' : overallStatus(bundle.evaluation),
      completionRate: bundle.evaluation.counts.completionRate,
      counts: bundle.evaluation.counts,
    },
    delivery: portfolioItem.delivery,
    assurance: portfolioItem.assurance,
    reconciliation: portfolioItem.reconciliation,
    readiness: portfolioItem.readiness,
    phaseTimeline: phaseCells(bundle.evaluation, bundle.learn, bundle.run ?? undefined),
    traceability: {
      ...traceability(bundle.plan, bundle.evaluation, bundle.evidenceRows, bundle.candidate.spec_version),
      storyReconciliation: reconciliation,
    },
    assuranceMapInput: buildFeatureAssuranceMapInput({
      specId: bundle.candidate.spec_slug,
      title: candidateTitle(bundle.candidate),
      specRevision: bundle.candidate.spec_version,
      compiledPlanId: bundle.candidate.plan_db_id,
      plan: bundle.plan,
      content: bundle.candidate.content_json,
      evidenceRows: bundle.evidenceRows,
      decisionRows: bundle.decisionRows,
    }),
    currentRun: bundle.run ? { ...bundle.run, storyReconciliation: reconciliation } : null,
    engineeringCanonCoverage,
    evaluationSnapshot: bundle.evaluation.snapshot,
    snapshotId: bundle.evaluation.snapshot.snapshotId,
    evidenceHighWaterMark: bundle.evidenceHighWaterMark,
    decisionHighWaterMark: bundle.decisionHighWaterMark,
  };
}

/**
 * US-011: per-phase compiled engineering-canon coverage for the advisory phase
 * advisor. Read-only projection — it is never persisted as lifecycle evidence
 * and never feeds gates or evaluation.
 */
export async function getLifecycleCoverageByPhase(input: LifecycleSpecInput & { phaseId: PhaseId }): Promise<{
  coverage: EngineeringCanonCoverage;
  phase: SpecCoverageByPhase['phases'][PhaseId];
}> {
  const loaded = await loadOne(input);
  const coverage = await resolveLifecycleCanonCoverage(loaded.ws.id, loaded.ws.path, loaded.candidate.spec_slug);
  const metadata = specCanonMetadata(loaded.ws.path, loaded.candidate.spec_slug);
  return {
    coverage,
    phase: deriveCoverageByPhase(coverage, metadata).phases[input.phaseId],
  };
}

function mappedForPhase(plan: LifecyclePlan, phaseId: PhaseId) {
  const gateIds = new Set(plan.gates.filter((gate) => gate.phaseId === phaseId).map((gate) => gate.gateId));
  const mappings = plan.requirementMappings.filter((mapping) => mapping.gateIds.some((gateId) => gateIds.has(gateId)));
  return {
    requirements: bounded([...new Set(mappings.map((mapping) => mapping.requirementReference))].sort()),
    stories: bounded([...new Set(mappings.flatMap((mapping) => mapping.targetReferences)
      .filter((target) => target.type === 'story').map((target) => target.reference))].sort()),
    decisions: bounded([...new Set(mappings.flatMap((mapping) => mapping.targetReferences)
      .filter((target) => target.type === 'architecture_decision').map((target) => target.reference))].sort()),
  };
}

export function projectDevelopmentExecutionSnapshot(input: {
  storyReferences: readonly string[];
  run: Pick<NonNullable<ReturnType<typeof runContext>>, 'id' | 'status' | 'agentType' | 'startedAt' | 'finishedAt'> | null | undefined;
  results: DevelopmentStoryResultRow[];
  integrations: DevelopmentIntegrationRow[];
  latestEvent: DevelopmentLifecycleEventRow | null;
  reviews?: DevelopmentReviewRow[];
}): DevelopmentExecutionProjection {
  const run = input.run;
  if (!run) {
    return {
      run: null,
      activityStatus: 'not_started',
      currentStoryId: null,
      stories: { total: input.storyReferences.length, passed: 0, failed: 0, items: input.storyReferences.map((storyId) => ({
        storyId,
        status: 'pending',
        attempts: 0,
        elapsedSeconds: null,
        modelUsed: null,
        commitSha: null,
        integrationState: null,
        resultingHead: null,
        failureReason: null,
      })) },
      source: { worktreePath: null, branch: null, baseCommit: null, resultingHead: null, dirty: null },
      changes: { commits: 0, additions: null, deletions: null, files: [] },
      verification: {
        hostReview: { status: 'missing', evidence: null },
        unit: { status: 'missing', evidence: null },
        typecheck: { status: 'missing', evidence: null },
        build: { status: 'missing', evidence: null },
        security: { status: 'missing', evidence: null },
        secrets: { status: 'missing', evidence: null },
        dependencies: { status: 'missing', evidence: null },
      },
      integration: { finalized: 0, failed: 0, expected: input.storyReferences.length, conflicted: 0, resultingHead: null },
    };
  }
  const resultByStory = new Map(input.results.map((result) => [result.story_id, result]));
  const integrationByStory = new Map(input.integrations.map((integration) => [integration.story_id, integration]));
  const currentStoryId = run.status === 'running' && input.latestEvent?.event_type === 'story_started'
    ? input.latestEvent.story_id
    : null;
  const storyIds = [...new Set([
    ...input.storyReferences,
    ...input.results.map((result) => result.story_id),
    ...input.integrations.map((integration) => integration.story_id),
  ])].sort();
  const items: DevelopmentExecutionProjection['stories']['items'] = storyIds.map((storyId) => {
    const result = resultByStory.get(storyId);
    const integration = integrationByStory.get(storyId);
    const status: DevelopmentExecutionProjection['stories']['items'][number]['status'] = currentStoryId === storyId
      ? 'running'
      : result?.status === 'pass'
        ? 'passed'
        : result?.status === 'fail' || result?.status === 'timeout'
          ? 'failed'
          : result?.status === 'skip' || result?.status === 'excluded'
            ? 'skipped'
            : result?.status === 'retry'
              ? 'retrying'
              : 'pending';
    return {
      storyId,
      status,
      attempts: result ? result.retries + 1 : 0,
      elapsedSeconds: result?.elapsed_seconds ?? null,
      modelUsed: result?.model_used ?? null,
      commitSha: integration?.source_commit ?? null,
      integrationState: integration?.state ?? null,
      resultingHead: integration?.resulting_head ?? null,
      failureReason: integration?.failure_reason ?? null,
    };
  });
  const latestResult = [...input.results].sort((left, right) => right.id - left.id)[0];
  const orderedIntegrations = [...input.integrations].sort((left, right) => left.integration_order - right.integration_order);
  const resultingHead = [...orderedIntegrations].reverse().find((item) => item.resulting_head)?.resulting_head ?? null;
  const baseCommit = orderedIntegrations[0]?.source_base_commit ?? null;
  const reviews = input.reviews ?? [];
  const changedFiles = new Map<string, { path: string; change: 'added' | 'modified' | 'deleted' | 'renamed' }>();
  const receiptGates: string[] = [];
  for (const review of reviews) {
    const manifest = typeof review.manifest_json === 'string'
      ? record(JSON.parse(review.manifest_json) as unknown)
      : record(review.manifest_json);
    const files = Array.isArray(manifest.changedFiles) ? manifest.changedFiles : [];
    for (const value of files) {
      const file = record(value);
      if (typeof file.path !== 'string' || !['added', 'modified', 'deleted', 'renamed'].includes(String(file.change))) continue;
      changedFiles.set(file.path, { path: file.path, change: file.change as 'added' | 'modified' | 'deleted' | 'renamed' });
    }
    const validation = record(manifest.validation);
    const receipts = Array.isArray(validation.receipts) ? validation.receipts : [];
    for (const value of receipts) {
      const receipt = record(value);
      if (typeof receipt.gate === 'string' && receipt.revoked !== true) receiptGates.push(receipt.gate.toLowerCase());
    }
  }
  const reviewBlocked = reviews.some((review) => review.validation_status === 'blocked');
  const hostReviewStatus = reviewBlocked ? 'failed' : reviews.length > 0 ? 'passed' : run.status === 'running' ? 'pending' : 'missing';
  const receiptVerification = (patterns: RegExp[]) => {
    const count = receiptGates.filter((gate) => patterns.some((pattern) => pattern.test(gate))).length;
    return count > 0
      ? { status: 'passed' as const, evidence: `${count} host-observed validation receipt${count === 1 ? '' : 's'}` }
      : { status: 'missing' as const, evidence: null };
  };
  return {
    run: {
      id: String(run.id),
      status: run.status,
      agentType: run.agentType,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    activityStatus: run.status === 'running' || run.status === 'queued'
      ? 'in_progress'
      : run.status === 'done'
        ? 'completed'
        : run.status === 'failed' || run.status === 'partial_failure' || run.status === 'cancelled'
          ? 'blocked'
          : 'not_started',
    currentStoryId,
    stories: {
      total: storyIds.length,
      passed: items.filter((item) => item.status === 'passed').length,
      failed: items.filter((item) => item.status === 'failed').length,
      items,
    },
    source: {
      worktreePath: latestResult?.worktree_path ?? null,
      branch: latestResult?.worktree_branch ?? null,
      baseCommit,
      resultingHead,
      dirty: null,
    },
    changes: {
      commits: new Set(input.integrations.map((item) => item.source_commit).filter(Boolean)).size,
      additions: null,
      deletions: null,
      files: [...changedFiles.values()].sort((left, right) => left.path.localeCompare(right.path)),
    },
    verification: {
      hostReview: {
        status: hostReviewStatus,
        evidence: reviews.length > 0 ? `${reviews.length} canonical local-review bundle${reviews.length === 1 ? '' : 's'}` : null,
      },
      unit: receiptVerification([/unit/]),
      typecheck: receiptVerification([/type.?check/, /typescript/]),
      build: receiptVerification([/build/, /compil/]),
      security: receiptVerification([/security/, /secure/, /sast/]),
      secrets: receiptVerification([/secret/]),
      dependencies: receiptVerification([/dependenc/, /supply.?chain/]),
    },
    integration: {
      finalized: input.integrations.filter((item) => item.state === 'finalized').length,
      failed: input.integrations.filter((item) => item.state === 'failed').length,
      expected: storyIds.length,
      conflicted: input.integrations.filter((item) => item.state === 'conflicted' || item.state === 'failed').length,
      resultingHead,
    },
  };
}

function loadDevelopmentExecution(
  plan: LifecyclePlan,
  run: ReturnType<typeof runContext>,
  runRow: RunRow | undefined,
): DevelopmentExecutionProjection {
  return projectDevelopmentExecutionSnapshot({
    storyReferences: plan.storyReferences,
    run,
    results: runRow?.development_results ?? [],
    integrations: runRow?.development_integrations ?? [],
    reviews: runRow?.development_reviews ?? [],
    latestEvent: runRow?.development_latest_event ?? null,
  });
}

function compareNumericIdsDesc(left: string, right: string): number {
  if (left.length !== right.length) return right.length - left.length;
  return right.localeCompare(left);
}

function evidenceSummary(row: EvidenceRow, phase: PhaseEvaluation) {
  const evaluated = phase.evidence.find((item) => item.evidenceId === row.id);
  return {
    id: row.id,
    evidenceType: row.source_type,
    sourceSystem: row.source_system,
    sourceEventId: row.source_idempotency_key,
    status: row.evidence_status,
    trustLevel: row.trust_level,
    confidence: row.confidence,
    observedAt: iso(row.observed_at),
    subject: evidenceSubject(row),
    gateId: row.gate_id,
    storyId: row.story_id,
    runId: row.run_id,
    currentRevision: Boolean(evaluated?.valid && evaluated.satisfiesGate && !row.revision_mismatch),
    stale: row.revision_mismatch || Boolean(evaluated && !evaluated.valid),
    invalidReasons: evaluated?.invalidReasons ?? (row.revision_mismatch ? ['subject_revision_mismatch'] : []),
  };
}

function permittedActions(phase: PhaseEvaluation, stalePlan: boolean): string[] {
  if (stalePlan || phase.status === 'stale') return ['inspect_evidence', 'recompile_plan'];
  if (phase.status === 'blocked') return ['inspect_evidence', 'retry_smallest_scope', 'reopen_disposition'];
  if (phase.status === 'awaiting_approval') return ['inspect_evidence', 'request_approval'];
  if (phase.status === 'not_started' || phase.status === 'in_progress') return ['inspect_evidence', 'run_phase'];
  if (phase.status === 'passed') return ['inspect_evidence'];
  return ['inspect_evidence', 'reopen_disposition'];
}

function phaseActionGuidance(phase: PhaseEvaluation, stalePlan: boolean) {
  const action = stalePlan
    ? 'Recompile the lifecycle plan before acting on phase state.'
    : phase.nextSafeAction ?? phase.nextUnmetGate?.nextSafeAction ?? 'No action is required for this phase.';
  const rationale = stalePlan
    ? 'The compiled lifecycle plan does not match the current spec revision, so downstream phase evidence cannot be acted on safely.'
    : phase.blockerReason
      ?? (phase.nextUnmetGate
        ? `The ${humanizeLifecycleId(phase.nextUnmetGate.gateId)} gate is ${phase.nextUnmetGate.status.replace(/_/g, ' ')} in the current bounded evaluation snapshot.`
        : `The current bounded evaluation classified this phase as ${phase.status.replace(/_/g, ' ')} with ${phase.counts.passed} of ${phase.counts.total} required gates passed.`);
  return {
    action,
    rationale,
    confidence: phase.snapshotChanged || phase.refetchRequired ? 0.5 : 0.95,
    classifier: 'phase_evaluator' as const,
  };
}

export async function getLifecyclePhase(input: LifecyclePhaseInput) {
  const loaded = await loadOne(input);
  const sourceLens = lifecycleSourceLens(input.phaseId);
  const sourceMaterial = sourceLens
    ? await projectLifecycleSourceMaterial({
      workspacePath: loaded.ws.path,
      workspaceId: loaded.ws.id,
      specId: loaded.candidate.spec_slug,
      specTitle: loaded.candidate.title,
      specContent: loaded.candidate.content_json,
      lens: sourceLens,
    })
    : null;
  if (!loaded.bundle) {
    return {
      workspaceId: loaded.ws.id,
      specId: loaded.candidate.spec_slug,
      phaseId: input.phaseId,
      state: 'needs_compilation',
      status: 'not_started',
      ownStatus: 'not_started',
      dependencyStatus: 'waiting',
      whyRequired: null,
      mappedRequirements: bounded([]),
      mappedDecisions: bounded([]),
      mappedStories: bounded([]),
      governedDecisions: bounded([]),
      requiredGates: bounded([]),
      evidence: paginateArray([], input.evidencePagination),
      blocker: null,
      nextSafeAction: 'Compile the lifecycle plan.',
      nextSafeActionGuidance: {
        action: 'Compile the lifecycle plan.',
        rationale: 'No current compiled lifecycle plan exists for this spec revision.',
        confidence: 1,
        classifier: 'plan_state' as const,
      },
      permittedActions: ['recompile_plan'],
      recompileHint: missingPlanItem(loaded.candidate).recompileHint,
      evaluationSnapshot: {
        snapshotId: loaded.snapshotId,
        evidenceHighWaterMark: loaded.marks.evidence,
        decisionHighWaterMark: loaded.marks.decision,
      },
      snapshotId: loaded.snapshotId,
      evidenceHighWaterMark: loaded.marks.evidence,
      decisionHighWaterMark: loaded.marks.decision,
      ...(sourceMaterial ? { sourceMaterial } : {}),
    };
  }
  const bundle = loaded.bundle;
  const phase = bundle.evaluation.phases.find((item) => item.phaseId === input.phaseId);
  if (!phase) throw new NotFoundError('Lifecycle phase', input.phaseId);
  const projectedStatus = projectLifecyclePhaseStatuses(bundle.evaluation, phase);
  const mapped = mappedForPhase(bundle.plan, input.phaseId);
  const gates = bundle.plan.gates.filter((gate) => gate.phaseId === input.phaseId)
    .sort((a, b) => a.gateId.localeCompare(b.gateId)).map((gate) => {
      const evaluation = phase.gates.find((item) => item.gateId === gate.gateId);
      return {
        ...gate,
        hardDeny: isHardDenyGate(gate),
        authorizedApprovers: ['local_admin', 'authenticated_admin', 'hermes_delegated'],
        evaluation: evaluation ? {
          status: evaluation.status,
          rationale: evaluation.rationale,
          blockerReason: evaluation.blockerReason ?? null,
          nextSafeAction: evaluation.nextSafeAction ?? null,
          evidenceCount: evaluation.evidenceIds.length,
          decisionCount: evaluation.decisionIds.length,
        } : null,
      };
    });
  const evidence = bundle.evidenceRows.filter((row) => row.phase_id === input.phaseId)
    .sort((a, b) => (iso(b.observed_at) ?? '').localeCompare(iso(a.observed_at) ?? '') || compareNumericIdsDesc(a.id, b.id))
    .map((row) => evidenceSummary(row, phase));
  const developmentExecution = input.phaseId === 'development'
    ? loadDevelopmentExecution(bundle.plan, bundle.run, bundle.runRow)
    : undefined;
  return {
    workspaceId: loaded.ws.id,
    specId: bundle.candidate.spec_slug,
    phaseId: input.phaseId,
    state: bundle.planState,
    status: bundle.planState !== 'current'
      ? 'stale'
      : projectLifecyclePhaseActivity(input.phaseId, phase.status, bundle.run),
    activityStatus: bundle.planState !== 'current'
      ? 'stale'
      : projectLifecyclePhaseActivity(input.phaseId, phase.status, bundle.run),
    ownStatus: projectedStatus.ownStatus,
    dependencyStatus: projectedStatus.dependencyStatus,
    disposition: phase.disposition.disposition,
    whyRequired: phase.disposition.rationale,
    mappedRequirements: mapped.requirements,
    mappedDecisions: mapped.decisions,
    mappedStories: mapped.stories,
    governedDecisions: bounded(bundle.decisionRows.filter((row) => row.phase_id === input.phaseId).map((row) => ({
      id: row.id,
      gateId: row.gate_id,
      storyId: row.story_id,
      decisionType: row.decision_type,
      rationale: row.rationale,
      evidenceGap: row.evidence_gap,
      actor: { id: row.principal_id, label: row.principal_display_label, type: row.principal_type },
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      revokedAt: iso(row.revoked_at),
    }))),
    requiredGates: bounded(gates),
    evidence: paginateArray(evidence, input.evidencePagination, { cursorKey: (item) => item.id }),
    blocker: phase.blockerReason ? { gateId: phase.blockerGateId ?? null, reason: phase.blockerReason } : null,
    nextSafeAction: bundle.planState !== 'current'
      ? 'Recompile the lifecycle plan before acting on phase state.'
      : phase.nextSafeAction ?? phase.nextUnmetGate?.nextSafeAction ?? null,
    nextSafeActionGuidance: phaseActionGuidance(phase, bundle.planState !== 'current'),
    permittedActions: permittedActions(phase, bundle.planState !== 'current'),
    ...(input.phaseId === 'maintenance' ? { learn: bundle.learn } : {}),
    ...(developmentExecution ? { developmentExecution } : {}),
    evaluationSnapshot: bundle.evaluation.snapshot,
    snapshotId: bundle.evaluation.snapshot.snapshotId,
    evidenceHighWaterMark: bundle.evidenceHighWaterMark,
    decisionHighWaterMark: bundle.decisionHighWaterMark,
    ...(sourceMaterial ? { sourceMaterial } : {}),
  };
}

export interface LifecycleRawReferenceDescriptor {
  available: boolean;
  accessTier: 'auth';
  allowed: boolean;
  kind: 'run' | 'log' | 'pty' | 'github' | 'gitreins' | 'unknown';
  label: string;
  reference: string | null;
  href: string | null;
  external: boolean;
  rawPayloadIncluded: false;
}

/** Convert an immutable source reference into an allowlisted existing UI/provider destination. */
export function describeLifecycleRawReference(evidence: {
  rawReference: string | null;
  source: { type: string; system: string };
  scope: { runId: number | null };
}): LifecycleRawReferenceDescriptor {
  const reference = evidence.rawReference;
  const base = {
    available: reference !== null,
    accessTier: 'auth' as const,
    reference,
    rawPayloadIncluded: false as const,
  };
  if (!reference) return { ...base, allowed: false, kind: 'unknown', label: 'No raw reference', href: null, external: false };
  const runReference = reference.match(/^(?:run-output-chunks|run|pty):(\d+)(?:\?.*)?$/);
  const runId = runReference ? Number(runReference[1]) : evidence.scope.runId;
  if (runId && Number.isSafeInteger(runId) && runId > 0 && (
    runReference || reference.startsWith('wal-events:') || reference.startsWith('/') || reference.includes('.log')
  )) {
    const kind = reference.startsWith('pty:') ? 'pty' as const : reference.includes('.log') ? 'log' as const : 'run' as const;
    return { ...base, allowed: true, kind, label: kind === 'pty' ? 'Open authorized run PTY' : kind === 'log' ? 'Open authorized run log' : 'Open authorized run', href: `/runs/${runId}`, external: false };
  }
  if (evidence.source.type === 'github_check') {
    try {
      const url = new URL(reference);
      if (url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname === 'api.github.com')) {
        return { ...base, allowed: true, kind: 'github', label: 'Open GitHub check', href: url.toString(), external: true };
      }
    } catch { /* non-URL GitHub references remain copy-only */ }
  }
  if (evidence.source.type === 'gitreins_judgment' && /^(?:gitreins|hermes):[A-Za-z0-9._:/?#=&-]+$/.test(reference)) {
    return { ...base, allowed: true, kind: 'gitreins', label: 'Open GitReins reference', href: null, external: false };
  }
  return { ...base, allowed: false, kind: 'unknown', label: 'Reference is copy-only', href: null, external: false };
}

export async function getLifecycleEvidence(input: { workspaceId: string; evidenceId: string; expectedSnapshotId?: string }) {
  const ws = await workspace(input.workspaceId);
  const evidenceId = text(input.evidenceId, 'evidenceId', 32);
  if (!/^\d+$/.test(evidenceId) || evidenceId === '0') throw new ValidationError('evidenceId must be a positive integer', { field: 'evidenceId' });
  const evidence = await getNormalizedEvidenceById(ws.id, evidenceId);
  // Evidence inspection is evaluated against the same immutable snapshot as the
  // matrix/spec/phase caller. A changed ledger returns refresh_required rather
  // than silently replacing the item under audit.
  const loaded = await loadOne({
    workspaceId: ws.id,
    specId: evidence.scope.specSlug,
    expectedSnapshotId: input.expectedSnapshotId,
  });
  const evidenceHighWaterMark = loaded.marks.evidence;
  const decisionHighWaterMark = loaded.marks.decision;
  const snapshotId = loaded.snapshotId;
  const expiresAt = typeof evidence.details.expiresAt === 'string' ? evidence.details.expiresAt : null;
  const environment = typeof evidence.details.environment === 'string' ? evidence.details.environment : null;
  const evaluatedEvidence = loaded.bundle?.evaluation.phases
    .flatMap((phase) => phase.evidence)
    .find((item) => item.evidenceId === evidence.id);
  const invalidReasons = evaluatedEvidence?.invalidReasons ?? (evidence.revisionMismatch ? ['subject_revision_mismatch'] : []);
  const revisionMismatch = evidence.revisionMismatch || invalidReasons.includes('subject_revision_mismatch');
  const eligibleForActiveGate = Boolean(evaluatedEvidence?.valid && evaluatedEvidence.satisfiesGate && !revisionMismatch);
  return {
    id: evidence.id,
    workspaceId: evidence.scope.workspaceId,
    specId: evidence.scope.specSlug,
    scope: evidence.scope,
    source: evidence.source,
    observedAt: evidence.observedAt,
    createdAt: iso(evidence.createdAt),
    subject: evidence.subject,
    phaseSubject: evidence.phaseSubject,
    releaseIdentity: evidence.releaseIdentity,
    classification: evidence.classification,
    status: evidence.status,
    trustLevel: evidence.trustLevel,
    confidence: evidence.confidence,
    excerpt: evidence.excerpt,
    actor: evidence.actor,
    rationale: evidence.rationale,
    expiresAt,
    environment,
    redactionState: 'normalized_redacted' as const,
    details: evidence.details,
    provenanceChain: evidence.provenanceChain,
    revisionMismatch,
    eligibleForActiveGate,
    invalidReasons,
    lineageVerified: evidence.lineageVerified,
    payloadHash: evidence.payloadHash,
    sourcePayloadHash: evidence.sourcePayloadHash,
    snapshotId,
    evidenceHighWaterMark,
    decisionHighWaterMark,
    rawReference: describeLifecycleRawReference(evidence),
  };
}

export function assertLifecyclePortfolioFilters(filters: Record<string, unknown>): LifecyclePortfolioFilters {
  const result: LifecyclePortfolioFilters = { sort: 'current_view' };
  if (filters.search !== undefined) result.search = text(filters.search, 'search', 200);
  if (filters.status !== undefined) {
    const status = text(filters.status, 'status');
    if (![...EVALUATED_STATUSES, 'needs_compilation'].includes(status as never)) throw new ValidationError('Invalid lifecycle status filter', { field: 'status' });
    result.status = status as LifecyclePortfolioFilters['status'];
  }
  if (filters.specStatus !== undefined) {
    const status = text(filters.specStatus, 'specStatus');
    if (!SPEC_STATUSES.includes(status as typeof SPEC_STATUSES[number])) throw new ValidationError('Invalid specStatus filter', { field: 'specStatus' });
    result.specStatus = status as typeof SPEC_STATUSES[number];
  }
  if (filters.phase !== undefined) {
    const phase = text(filters.phase, 'phase');
    if (!CANONICAL_PHASES.some((item) => item.id === phase)) throw new ValidationError('Invalid lifecycle phase filter', { field: 'phase' });
    result.phase = phase as PhaseId;
  }
  if (filters.stage !== undefined) {
    const stage = text(filters.stage, 'stage');
    if (!Object.values(MISSION_STAGE_BY_PHASE).includes(stage as MissionStage)) {
      throw new ValidationError('Invalid lifecycle stage filter', { field: 'stage' });
    }
    result.stage = stage as MissionStage;
  }
  if (filters.risk !== undefined) {
    const risk = text(filters.risk, 'risk');
    if (!RISK_LEVELS.includes(risk as typeof RISK_LEVELS[number])) throw new ValidationError('Invalid lifecycle risk filter', { field: 'risk' });
    result.risk = risk as typeof RISK_LEVELS[number];
  }
  if (filters.owner !== undefined) result.owner = text(filters.owner, 'owner');
  if (filters.blocked !== undefined) {
    if (filters.blocked !== 'true' && filters.blocked !== 'false') throw new ValidationError('blocked must be true or false', { field: 'blocked' });
    result.blocked = filters.blocked === 'true';
  }
  if (filters.disposition !== undefined) {
    const disposition = text(filters.disposition, 'disposition');
    if (!DISPOSITIONS.includes(disposition as typeof DISPOSITIONS[number])) throw new ValidationError('Invalid disposition filter', { field: 'disposition' });
    result.disposition = disposition as typeof DISPOSITIONS[number];
  }
  if (filters.sort !== undefined) {
    const sort = text(filters.sort, 'sort');
    if (!SORTS.includes(sort as typeof SORTS[number])) throw new ValidationError('Invalid lifecycle sort', { field: 'sort' });
    result.sort = sort as typeof SORTS[number];
  }
  if (filters.snapshotId !== undefined) {
    const snapshotId = text(filters.snapshotId, 'snapshotId', 71);
    if (!HASH_PATTERN.test(snapshotId)) throw new ValidationError('snapshotId must be a sha256 identity', { field: 'snapshotId' });
    result.expectedSnapshotId = snapshotId;
  }
  return result;
}

export function assertPhaseId(value: unknown): PhaseId {
  const phaseId = text(value, 'phaseId', 32);
  if (!CANONICAL_PHASES.some((phase) => phase.id === phaseId)) throw new ValidationError('Invalid lifecycle phaseId', { field: 'phaseId' });
  return phaseId as PhaseId;
}

export function assertSnapshotId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const snapshotId = text(value, 'snapshotId', 71);
  if (!HASH_PATTERN.test(snapshotId)) throw new ValidationError('snapshotId must be a sha256 identity', { field: 'snapshotId' });
  return snapshotId;
}
