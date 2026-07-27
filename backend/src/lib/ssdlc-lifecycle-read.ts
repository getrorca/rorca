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
import { ConflictError, NotFoundError, ValidationError } from './errors';
import { paginateArray, type PaginationParams } from './paginate';
import {
  CANONICAL_PHASES,
  LifecyclePlanSchema,
  type EvaluatedStatus,
  type LifecyclePlan,
  type PhaseId,
  type ReleaseSubject,
} from './ssdlc-contracts';
import {
  aggregatePhaseEvaluations,
  evaluatePortfolio,
  type LifecycleEvaluation,
  type LifecycleEvaluationRunState,
  type PhaseEvaluation,
} from './ssdlc-phase-evaluator';
import { classifySSDLCLiveness, type SSDLCLivenessReport } from './ssdlc-liveness';
import { getSpecPlanCompilationState, type SpecPlanCompilationState } from './ssdlc-plan-service';
import { inspectApprovedSpecPasses } from './ssdlc-pass-reconciler';
import { getNormalizedEvidenceById } from './ssdlc-evidence';
import { isHardDenyGate } from './ssdlc-decisions';
import { engineeringCanonMetadataFromSpec, resolveEngineeringCanonCoverage } from './engineering-canon';
import { SkillRegistry } from './skill-registry';

export const LIFECYCLE_PORTFOLIO_MAX_SPECS = 500;
export const LIFECYCLE_EVALUATION_EVIDENCE_LIMIT = 500;
export const LIFECYCLE_EVALUATION_DECISION_LIMIT = 200;
export const LIFECYCLE_TRACEABILITY_LIMIT = 200;

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
const SPEC_STATUSES = ['pending', 'approved', 'completed', 'rejected'] as const;
const SORTS = ['current_view', 'updated_desc', 'title_asc', 'risk_desc', 'readiness_desc', 'owner_asc'] as const;
const DISPOSITIONS = ['required', 'deferred', 'not_applicable'] as const;
const EVALUATED_STATUSES = [
  'not_started', 'in_progress', 'blocked', 'awaiting_approval', 'passed', 'deferred', 'not_applicable', 'stale',
] as const;
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

async function withLifecycleReadSnapshot<T>(read: (db: LifecycleReadDb) => Promise<T>): Promise<T> {
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return read(clientReadDb(client));
  });
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

export interface LifecyclePortfolioFilters {
  search?: string;
  status?: typeof EVALUATED_STATUSES[number] | 'needs_compilation';
  specStatus?: typeof SPEC_STATUSES[number];
  phase?: PhaseId;
  risk?: typeof RISK_LEVELS[number];
  owner?: string;
  blocked?: boolean;
  disposition?: typeof DISPOSITIONS[number];
  sort: typeof SORTS[number];
  expectedSnapshotId?: string;
}

export interface LifecyclePortfolioInput extends LifecyclePortfolioFilters {
  workspaceId: string;
  pagination: PaginationParams;
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
  learn: ReturnType<typeof learnSummary>;
  risk: typeof RISK_LEVELS[number];
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
  const workspaceId = text(workspaceIdInput, 'workspaceId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(workspaceId)) {
    throw new ValidationError('workspaceId must be a stable workspace identifier', { field: 'workspaceId' });
  }
  const row = await db.queryOne<WorkspaceRow>('SELECT id, path, label FROM workspaces WHERE id = $1', [workspaceId]);
  if (!row) throw new NotFoundError('Workspace', workspaceId);
  return row;
}

function discoverWorkspaceSpecs(workspacePath: string): Array<{ specSlug: string; title: string; status: string; generatedAt: string | null; content: Record<string, unknown> }> {
  const discovered = new Map<string, { specSlug: string; title: string; status: string; generatedAt: string | null; content: Record<string, unknown> }>();
  for (const status of ['pending', 'approved'] as const) {
    const directory = path.join(workspacePath, 'forge', 'specs', status);
    let names: string[] = [];
    try { names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort(); } catch { continue; }
    for (const name of names) {
      if (discovered.size >= LIFECYCLE_PORTFOLIO_MAX_SPECS + 1) break;
      const specSlug = name.slice(0, -5);
      try {
        const content = record(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
        discovered.set(specSlug, {
          specSlug,
          title: typeof content.title === 'string' ? content.title : specSlug,
          status,
          generatedAt: typeof content.generatedAt === 'string' ? content.generatedAt : null,
          content,
        });
      } catch {
        // An unreadable spec is omitted just as it is from the canonical specs list.
      }
    }
  }
  return [...discovered.values()];
}

async function loadCandidates(ws: WorkspaceRow, search?: string, db: LifecycleReadDb = DEFAULT_READ_DB): Promise<CandidateRow[]> {
  const rows = await db.query<CandidateRow>(`
    WITH indexed AS (
      SELECT s.spec_slug, s.spec_title AS title, s.status AS spec_status, s.generated_at
      FROM spec_search_index s
      WHERE s.workspace_id = $1
        AND ($2::text IS NULL OR s.search_vector @@ websearch_to_tsquery('english', $2))
    ), plan_only AS (
      SELECT DISTINCT ON (p.spec_slug)
             p.spec_slug, p.spec_slug AS title, NULL::text AS spec_status, p.created_at AS generated_at
      FROM ssdlc_compiled_plans p
      WHERE p.workspace_id = $1
        AND NOT EXISTS (SELECT 1 FROM indexed i WHERE i.spec_slug = p.spec_slug)
        AND ($2::text IS NULL OR p.spec_slug ILIKE '%' || $2 || '%')
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
    LIMIT $3
  `, [ws.id, search ?? null, LIFECYCLE_PORTFOLIO_MAX_SPECS + 1]);

  const bySlug = new Map(rows.map((row) => [row.spec_slug, row]));
  for (const file of discoverWorkspaceSpecs(ws.path)) {
    if (search && !JSON.stringify(file.content).toLocaleLowerCase().includes(search.toLocaleLowerCase())) continue;
    const existing = bySlug.get(file.specSlug);
    if (existing) {
      if (!existing.content_json) existing.content_json = file.content;
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
  return await db.query<EvidenceRow>(`
    SELECT * FROM (
      SELECT e.id::text, e.spec_slug, e.run_id, e.story_id, e.phase_id, e.gate_id,
             e.source_type, e.source_system, e.source_idempotency_key,
             e.subject_type, e.subject_value, e.phase_subject_type, e.phase_subject_value,
             e.release_identity, e.classification, e.evidence_status, e.trust_level,
             e.confidence, e.excerpt, e.metadata, e.observed_at, e.created_at,
             e.revision_mismatch, e.lineage_verified,
             MAX(e.id) OVER (PARTITION BY e.spec_slug)::text AS high_water_mark,
             ROW_NUMBER() OVER (PARTITION BY e.spec_slug ORDER BY e.observed_at DESC, e.id DESC) AS bounded_rank
      FROM ssdlc_lifecycle_evidence e
      WHERE e.workspace_id = $1 AND e.spec_slug = ANY($2::text[])
    ) bounded
    WHERE bounded_rank <= $3
    ORDER BY spec_slug, observed_at DESC, id::bigint DESC
  `, [workspaceId, specSlugs, LIFECYCLE_EVALUATION_EVIDENCE_LIMIT]);
}

async function loadDecisions(specSlugs: string[], workspaceId: string, db: LifecycleReadDb = DEFAULT_READ_DB): Promise<DecisionRow[]> {
  if (specSlugs.length === 0) return [];
  return await db.query<DecisionRow>(`
    SELECT * FROM (
      SELECT d.id::text, d.spec_slug, d.run_id, d.story_id, d.phase_id, d.gate_id,
             d.decision_type, d.rationale, d.evidence_gap, d.subject_type, d.subject_value,
             d.policy_version, d.principal_type, d.principal_id, d.principal_display_label,
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
  `, [workspaceId, specSlugs, LIFECYCLE_EVALUATION_DECISION_LIMIT]);
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
           (SELECT COUNT(*)::int FROM story_results sr WHERE sr.run_id = pipeline_runs.id) AS total_stories
    FROM pipeline_runs
    WHERE workspace_id = $1
      AND regexp_replace(spec_path, '^.*/|\\.json$', '', 'g') = ANY($2::text[])
    ORDER BY regexp_replace(spec_path, '^.*/|\\.json$', '', 'g'), id DESC
  `, [workspaceId, specSlugs]);
  return new Map(rows.map((row) => [row.spec_slug, row]));
}

function evidenceSubject(row: EvidenceRow): ReleaseSubject {
  if (row.phase_subject_type && row.phase_subject_value) return { type: row.phase_subject_type, value: row.phase_subject_value } as ReleaseSubject;
  return { type: row.subject_type, value: row.subject_value } as ReleaseSubject;
}

function evidenceLineage(row: EvidenceRow): Record<string, string> {
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

/** Only authoritative successful observations may select the active release identity. */
export function canSelectActiveReleaseIdentity(row: ReleaseIdentitySelectorEvidence): boolean {
  if (row.evidence_status !== 'passed' || row.revision_mismatch) return false;
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
  const lineage: NonNullable<LifecycleEvaluationRunState['releaseLineage']> = {};
  for (const row of evidence) {
    if (!canSelectActiveReleaseIdentity(row)) continue;
    const release = evidenceLineage(row);
    if (!lineage.commitSha && release.commitSha) lineage.commitSha = release.commitSha;
    if (!lineage.artifactDigest && release.artifactDigest) lineage.artifactDigest = release.artifactDigest;
    if (!lineage.deploymentId && release.deploymentId) lineage.deploymentId = release.deploymentId;
    const subject = evidenceSubject(row);
    if (!subjects[subject.type]) (subjects as Record<string, ReleaseSubject>)[subject.type] = subject;
  }
  return { activeReleaseSubject: subjects.spec_hash!, activeSubjects: subjects, releaseLineage: lineage };
}

function evaluatorEvidence(row: EvidenceRow, plan: LifecyclePlan): Record<string, unknown> {
  const details = record(record(row.metadata).details);
  return {
    evidenceId: row.id,
    gateId: row.gate_id ?? '',
    source: `${row.source_type}:${row.source_system}`,
    collectedAt: iso(row.observed_at),
    subjectRevision: evidenceSubject(row),
    policyVersion: typeof details.policyVersion === 'string' ? details.policyVersion : plan.policyVersion,
    compilerVersion: typeof details.compilerVersion === 'string' ? details.compilerVersion : plan.compilerVersion,
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
  };
}

function evaluatorDecision(row: DecisionRow, activeReleaseSubject: ReleaseSubject): Record<string, unknown> {
  return {
    decisionId: row.id,
    phaseId: row.phase_id,
    ...(row.gate_id ? { gateId: row.gate_id } : {}),
    decisionType: row.decision_type,
    outcome: row.revoked_at ? 'rejected' : 'approved',
    subjectRevision: row.subject_type && row.subject_value
      ? { type: row.subject_type, value: row.subject_value }
      : activeReleaseSubject,
    policyVersion: row.policy_version,
    decidedAt: iso(row.created_at),
    ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}),
    ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}),
    rationale: row.rationale,
    provenance: {
      principalType: row.principal_type,
      principalId: row.principal_id,
      displayLabel: row.principal_display_label,
    },
  };
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

function planRisk(candidate: CandidateRow): typeof RISK_LEVELS[number] {
  const value = candidate.provenance_json?.riskLevel;
  return RISK_LEVELS.includes(value as typeof RISK_LEVELS[number]) ? value as typeof RISK_LEVELS[number] : 'low';
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

function phaseCells(evaluation: LifecycleEvaluation, learn?: ReturnType<typeof learnSummary>) {
  return CANONICAL_PHASES.map((canonical) => {
    const phase = evaluation.phases.find((item) => item.phaseId === canonical.id)!;
    const learnMissing = canonical.id === 'learn' && (!learn || learn.candidateCount < learn.requiredCandidateCount);
    const learnBlocked = canonical.id === 'learn' && learn?.generation.state === 'blocked';
    return {
      phaseId: canonical.id,
      displayName: canonical.displayName,
      status: learnBlocked ? 'blocked' as const : learnMissing ? 'not_started' as const : phase.status,
      disposition: phase.disposition.disposition,
      gateProgress: { passed: phase.counts.passed, required: phase.counts.total },
      rationale: phase.disposition.rationale,
      blocker: learnBlocked || learnMissing ? learn?.generation.blocker?.message ?? 'A reviewable Learn candidate is required.' : phase.blockerReason ?? null,
      nextSafeAction: canonical.id === 'learn' && learn ? learn.nextAction : phase.nextSafeAction ?? phase.nextUnmetGate?.nextSafeAction ?? null,
      ...(canonical.id === 'learn' && learn ? { learn } : {}),
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
    const parsed = LifecyclePlanSchema.safeParse(candidate.plan_json);
    return parsed.success ? [{ candidate, plan: parsed.data }] : [];
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
      evaluatorDecisions: decisionRows.map((row) => evaluatorDecision(row, subjects.activeReleaseSubject)),
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
    return {
      candidate,
      plan: entry.plan,
      evidenceRows: entry.evidenceRows,
      decisionRows: entry.decisionRows,
      evaluation: portfolio.evaluations[index],
      evidenceHighWaterMark: entry.evidenceHighWaterMark,
      decisionHighWaterMark: entry.decisionHighWaterMark,
      run: runContext(runs.get(candidate.spec_slug), entry.evidenceRows, ws.id),
      learn: learnSummary(runs.get(candidate.spec_slug), learnCandidates.get(candidate.spec_slug) ?? []),
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

function missingPlanItem(candidate: CandidateRow) {
  return {
    specId: candidate.spec_slug,
    title: candidateTitle(candidate),
    specStatus: candidate.spec_status ?? 'unknown',
    state: 'needs_compilation' as const,
    overallStatus: 'needs_compilation' as const,
    risk: 'low' as const,
    owner: candidate.owner_id ? { id: candidate.owner_id, label: candidate.owner_label ?? candidate.owner_id } : null,
    storySummary: { total: storyCount(candidate), passed: 0, failed: 0 },
    currentPhaseId: 'intake' as const,
    blocked: false,
    blockers: [],
    liveness: null,
    currentRevision: null,
    phases: CANONICAL_PHASES.map((phase) => ({
      phaseId: phase.id,
      displayName: phase.displayName,
      status: 'not_started' as const,
      disposition: null,
      gateProgress: { passed: 0, required: 0 },
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

function bundleItem(bundle: EvaluationBundle) {
  const evaluation = bundle.evaluation;
  const status = bundle.planState !== 'current' ? 'stale' : overallStatus(evaluation);
  const blockers = evaluation.phases.filter((phase) => phase.blockerReason).map((phase) => ({
    phaseId: phase.phaseId,
    reason: phase.blockerReason!,
  })).sort((a, b) => a.phaseId.localeCompare(b.phaseId));
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
    currentPhaseId: evaluation.phases.find((phase) => !phase.excluded && phase.status !== 'passed')?.phaseId ?? 'learn',
    blocked: blockers.length > 0 || bundle.run?.liveness.state === 'blocked',
    blockers,
    liveness: bundle.run?.liveness ?? null,
    currentRevision: {
      specVersion: bundle.candidate.spec_version,
      inputHash: bundle.plan.inputHash,
      planVersion: bundle.plan.planVersion,
    },
    phases: phaseCells(evaluation, bundle.learn),
    snapshotId: evaluation.snapshot.snapshotId,
    evidenceHighWaterMark: bundle.evidenceHighWaterMark,
    decisionHighWaterMark: bundle.decisionHighWaterMark,
    updatedAt: iso(bundle.candidate.plan_updated_at ?? bundle.candidate.generated_at),
  };
}

function matchesPortfolio(item: ReturnType<typeof bundleItem> | ReturnType<typeof missingPlanItem>, filters: LifecyclePortfolioFilters): boolean {
  if (filters.status && item.overallStatus !== filters.status) return false;
  if (filters.specStatus && item.specStatus !== filters.specStatus) return false;
  if (filters.risk && item.risk !== filters.risk) return false;
  if (filters.owner && item.owner?.id !== filters.owner) return false;
  if (filters.blocked !== undefined && item.blocked !== filters.blocked) return false;
  if (filters.phase && item.currentPhaseId !== filters.phase) return false;
  if (filters.disposition && !item.phases.some((phase) => phase.disposition === filters.disposition)) return false;
  return true;
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

function sortPortfolio(items: Array<ReturnType<typeof bundleItem> | ReturnType<typeof missingPlanItem>>, sort: LifecyclePortfolioFilters['sort']) {
  const tie = (a: typeof items[number], b: typeof items[number]) => a.specId.localeCompare(b.specId);
  return items.sort((a, b) => {
    switch (sort) {
      case 'title_asc': return a.title.localeCompare(b.title) || tie(a, b);
      case 'risk_desc': return RISK_RANK[b.risk] - RISK_RANK[a.risk] || tie(a, b);
      case 'readiness_desc': {
        const left = 'currentRevision' in a && a.currentRevision ? a.phases.filter((phase) => phase.status === 'passed').length : 0;
        const right = 'currentRevision' in b && b.currentRevision ? b.phases.filter((phase) => phase.status === 'passed').length : 0;
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
  return withLifecycleReadSnapshot(async (db) => {
  const ws = await workspace(input.workspaceId, db);
  const candidates = await loadCandidates(ws, input.search, db);
  const built = await buildBundles(ws, candidates, input.expectedSnapshotId, db);
  const bySpec = new Map(built.bundles.map((bundle) => [bundle.candidate.spec_slug, bundle]));
  const allItems = sortPortfolio(candidates.map((candidate) => {
    const bundle = bySpec.get(candidate.spec_slug);
    return bundle ? bundleItem(bundle) : missingPlanItem(candidate);
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
  return {
    ...page,
    workspace: { id: ws.id, label: ws.label },
    phaseOrder: CANONICAL_PHASES,
    snapshotId: built.snapshotSetId,
    evidenceHighWaterMark: built.evidenceHighWaterMark,
    decisionHighWaterMark: built.decisionHighWaterMark,
    kpis: {
      specs: allItems.length,
      activeSpecs: allItems.filter((item) => item.specStatus !== 'completed' && item.specStatus !== 'rejected').length,
      evaluatedSpecs: visibleBundles.length,
      needsCompilation: allItems.filter((item) => item.state === 'needs_compilation').length,
      blockedSpecs: allItems.filter((item) => item.blocked).length,
      missingGates,
      readyForQa: allItems.filter((item) => item.state === 'current' && !item.blocked && item.currentPhaseId === 'qa').length,
      waitingApprovals: allItems.reduce(
        (total, item) => total + item.phases.filter((phase) => phase.status === 'awaiting_approval').length,
        0,
      ),
      recentPhaseTransitions,
      stories: allItems.reduce((sum, item) => sum + item.storySummary.total, 0),
      phases: phaseCounts,
    },
  };
  });
}

async function loadOne(input: LifecycleSpecInput): Promise<{ ws: WorkspaceRow; candidate: CandidateRow; bundle: EvaluationBundle | null; marks: { evidence: string; decision: string }; snapshotId: string }> {
  return withLifecycleReadSnapshot(async (db) => {
  const ws = await workspace(input.workspaceId, db);
  const specId = text(input.specId, 'specId', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(specId)) {
    throw new ValidationError('specId must be a stable spec slug', { field: 'specId' });
  }
  const candidates = await loadCandidates(ws, undefined, db);
  const candidate = candidates.find((item) => item.spec_slug === specId);
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
  });
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
      currentEvidence: gateEvidence.filter((item) => item.currentRevision),
      historicalEvidence: gateEvidence.filter((item) => !item.currentRevision),
    };
  });
  const gatesById = new Map(gates.map((gate) => [gate.gateId, gate]));
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
        if (gate.currentEvidence.length === 0) rowBlockers.push(traceabilityBlocker('gate_to_evidence', {
          requirementReference: mapping.requirementReference, storyReference: null, gateId: gate.gateId,
        }, `Gate ${gate.gateId} has no eligible evidence for the bound revision.`, `Collect ${gate.evidenceRequirementIds.join(', ')} evidence for ${gate.gateId} on the bound immutable subject, then re-evaluate.`));
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
    }, `The active ${node.type} lineage link is absent.`, `Collect current-revision evidence that binds the ${node.type} without inventing an identifier.`));
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

async function resolveLifecycleCanonCoverage(workspaceId: string, workspacePath: string, specId: string) {
  let metadata: Record<string, unknown> = {};
  for (const location of ['approved', 'pending']) {
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(workspacePath, 'forge', 'specs', location, `${specId}.json`), 'utf8')) as Record<string, unknown>;
      metadata = engineeringCanonMetadataFromSpec(spec);
      break;
    } catch { /* try the other canonical persistence location */ }
  }

  // Never project the persisted engineeringCanonCoverage field: it is writable
  // spec data and therefore cannot attest receipt identity, evidence, authority,
  // promotion, or N/A. Re-resolve and validate against the current bounded input.
  const registry = await new SkillRegistry().discover(workspacePath);
  return resolveEngineeringCanonCoverage({
    workspacePath,
    workspaceId,
    specId,
    metadata,
    skills: registry.getAll(),
  });
}

export async function getLifecycleSpec(input: LifecycleSpecInput) {
  const loaded = await loadOne(input);
  const engineeringCanonCoverage = await resolveLifecycleCanonCoverage(loaded.ws.id, loaded.ws.path, loaded.candidate.spec_slug);
  if (!loaded.bundle) {
    const missing = missingPlanItem(loaded.candidate);
    return {
      ...missing,
      workspaceId: loaded.ws.id,
      plan: null,
      provenance: null,
      overallReadiness: { ready: false, completionRate: 0, counts: null },
      phaseTimeline: missing.phases,
      traceability: { requirements: bounded([]), stories: bounded([]), architectureDecisions: bounded([]), gates: bounded([]), evidence: { total: 0, validForCurrentRevision: 0, stale: 0, boundedAt: LIFECYCLE_EVALUATION_EVIDENCE_LIMIT } },
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
    provenance: bundle.candidate.provenance_json ?? {},
    overallReadiness: {
      ready: bundle.evaluation.counts.completionRate === 1 && !bundle.evaluation.refetchRequired,
      status: bundle.planState !== 'current' ? 'stale' : overallStatus(bundle.evaluation),
      completionRate: bundle.evaluation.counts.completionRate,
      counts: bundle.evaluation.counts,
    },
    phaseTimeline: phaseCells(bundle.evaluation, bundle.learn),
    traceability: {
      ...traceability(bundle.plan, bundle.evaluation, bundle.evidenceRows, bundle.candidate.spec_version),
      storyReconciliation: reconciliation,
    },
    currentRun: bundle.run ? { ...bundle.run, storyReconciliation: reconciliation } : null,
    engineeringCanonCoverage,
    evaluationSnapshot: bundle.evaluation.snapshot,
    snapshotId: bundle.evaluation.snapshot.snapshotId,
    evidenceHighWaterMark: bundle.evidenceHighWaterMark,
    decisionHighWaterMark: bundle.decisionHighWaterMark,
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
        ? `Gate ${phase.nextUnmetGate.gateId} is ${phase.nextUnmetGate.status.replace(/_/g, ' ')} in the current bounded evaluation snapshot.`
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
  if (!loaded.bundle) {
    return {
      workspaceId: loaded.ws.id,
      specId: loaded.candidate.spec_slug,
      phaseId: input.phaseId,
      state: 'needs_compilation',
      status: 'not_started',
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
    };
  }
  const bundle = loaded.bundle;
  const phase = bundle.evaluation.phases.find((item) => item.phaseId === input.phaseId);
  if (!phase) throw new NotFoundError('Lifecycle phase', input.phaseId);
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
  return {
    workspaceId: loaded.ws.id,
    specId: bundle.candidate.spec_slug,
    phaseId: input.phaseId,
    state: bundle.planState,
    status: bundle.planState !== 'current' ? 'stale' : phase.status,
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
    ...(input.phaseId === 'learn' ? { learn: bundle.learn } : {}),
    evaluationSnapshot: bundle.evaluation.snapshot,
    snapshotId: bundle.evaluation.snapshot.snapshotId,
    evidenceHighWaterMark: bundle.evidenceHighWaterMark,
    decisionHighWaterMark: bundle.decisionHighWaterMark,
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
