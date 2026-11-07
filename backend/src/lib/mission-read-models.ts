/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { query, queryOne } from '../db/index';
import { NotFoundError, ValidationError } from './errors';
import {
  ActionEnvelopeV1Schema,
  DeliveryCaseSummaryV1Schema,
  MISSION_CONTRACT_VERSIONS,
  RunControlProjectionV1Schema,
  SourceContextDriftV1Schema,
  type ActionEnvelopeV1,
  type DeliveryCaseSummaryV1,
  type EntityRefV1,
  type OperationalStatePacketV1,
  type PermittedActionV1,
  type RunControlProjectionV1,
} from './mission-contracts';
import { getLifecyclePortfolio, getLifecycleSpec } from './ssdlc-lifecycle-read';

const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SPEC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ATTENTION = 100;
const ATTENTION_CANDIDATE_OVERFETCH = 3;
const MAX_ATTENTION_CANDIDATES = MAX_ATTENTION * ATTENTION_CANDIDATE_OVERFETCH;
const OBSERVATION_STALE_SECONDS = 900;

type Priority = ActionEnvelopeV1['priority'];
type LifecyclePortfolio = Awaited<ReturnType<typeof getLifecyclePortfolio>>;
type LifecycleItem = LifecyclePortfolio['items'][number];
type LifecycleDetail = Awaited<ReturnType<typeof getLifecycleSpec>>;
type LifecyclePhase = LifecycleDetail['phaseTimeline'][number];

function assertWorkspaceId(value: unknown): string {
  if (typeof value !== 'string' || !WORKSPACE_PATTERN.test(value)) throw new ValidationError('workspaceId is invalid', { field: 'workspaceId' });
  return value;
}

function assertSpecId(value: unknown): string {
  if (typeof value !== 'string' || !SPEC_PATTERN.test(value)) throw new ValidationError('specId must be a stable spec slug', { field: 'specId' });
  return value;
}

function assertRunId(value: unknown): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new ValidationError('runId must be a positive integer', { field: 'runId' });
  return parsed;
}

function iso(value: unknown, fallback: string): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function entity(workspaceId: string, kind: EntityRefV1['kind'], id: string, label: string, revision?: EntityRefV1['revision'], parent?: EntityRefV1['parent']): EntityRefV1 {
  return { schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef, workspaceId, kind, id, label: label.slice(0, 160), ...(revision ? { revision } : {}), ...(parent ? { parent } : {}) };
}

function freshness(observedAt: string, now: string): OperationalStatePacketV1['freshness'] {
  const age = Date.parse(now) - Date.parse(observedAt);
  if (!Number.isFinite(age)) return 'unknown';
  if (age <= OBSERVATION_STALE_SECONDS * 1000) return 'fresh';
  if (age <= OBSERVATION_STALE_SECONDS * 4 * 1000) return 'aging';
  return 'stale';
}

function packet(input: {
  observedAt: string; now: string; outcome?: OperationalStatePacketV1['outcome']; liveness?: OperationalStatePacketV1['liveness'];
  risk?: OperationalStatePacketV1['risk']; confidence?: OperationalStatePacketV1['confidence']; authority?: OperationalStatePacketV1['authority'];
  sourceId: string; sourceLabel: string; consequence: string; action: PermittedActionV1; blocker?: { code: string; message: string; remediation: string };
}): OperationalStatePacketV1 {
  const currentFreshness = freshness(input.observedAt, input.now);
  return {
    schemaVersion: MISSION_CONTRACT_VERSIONS.operationalStatePacket,
    outcome: input.outcome ?? 'unknown', liveness: input.liveness ?? 'unknown', risk: input.risk ?? 'unknown',
    confidence: input.confidence ?? 'medium', freshness: currentFreshness, authority: input.authority ?? 'derived',
    observedAt: input.observedAt, source: { kind: 'backend', id: input.sourceId, label: input.sourceLabel },
    ...(input.blocker ? { blocker: input.blocker } : {}), consequence: input.consequence,
    nextSafeAction: { actionId: input.action.actionId, label: input.action.label, rationale: input.consequence, requiresApproval: input.action.requiresApproval, authority: input.action.authority, href: input.action.href },
  };
}

function viewAction(actionId: string, label: string, href: string, authority: PermittedActionV1['authority'] = 'user'): PermittedActionV1 {
  return { actionId, kind: 'view', label, requiresApproval: false, authority, href };
}

function attentionPriority(item: LifecycleItem): Priority {
  if (item.risk === 'critical' || item.risk === 'high') return 'safety';
  if (Array.isArray(item.phases) && item.phases.some((phase) => phase.status === 'awaiting_approval')) return 'decision';
  if (item.blocked || item.overallStatus === 'blocked' || ['failed', 'stalled'].includes(item.liveness?.state ?? '')) return 'blocked';
  if (item.state === 'current' && !item.blocked && ['qa', 'release', 'learn'].includes(item.currentPhaseId ?? '')) return 'ready';
  return 'informational';
}

const PRIORITY_RANK: Record<Priority, number> = { safety: 0, decision: 1, blocked: 2, ready: 3, informational: 4 };

function itemLiveness(value: unknown): OperationalStatePacketV1['liveness'] {
  const state = typeof value === 'object' && value !== null && 'state' in value ? String(value.state ?? '') : '';
  if (state === 'active') return 'running';
  if (['queued', 'running', 'paused', 'stalled', 'completed'].includes(state)) return state as OperationalStatePacketV1['liveness'];
  if (state === 'blocked') return 'stalled';
  return 'unknown';
}

function itemOutcome(item: LifecycleItem): OperationalStatePacketV1['outcome'] {
  if (item.overallStatus === 'passed' || item.specStatus === 'completed') return 'succeeded';
  if (item.overallStatus === 'blocked' || (item.storySummary?.failed ?? 0) > 0) return 'failed';
  if (item.state === 'needs_compilation') return 'not_available';
  return 'pending';
}
interface OperationalAttentionSignals {
  dlq_count: number;
  dlq_oldest_at: Date | string | null;
  knowledge_count: number;
  knowledge_oldest_at: Date | string | null;
  drift_score: number | null;
  drift_violations: number;
  drift_created_at: Date | string | null;
  worker_last_seen: Date | string | null;
}

interface AttentionCandidateRow {
  spec_slug: string;
}

async function loadAttentionCandidateSpecIds(workspaceId: string): Promise<string[]> {
  const rows = await query<AttentionCandidateRow>(`
    WITH indexed_candidates AS (
      SELECT DISTINCT ON (s.spec_slug)
             s.spec_slug, s.generated_at AS updated_at
      FROM spec_search_index s
      WHERE s.workspace_id = $1
      ORDER BY s.spec_slug, s.generated_at DESC NULLS LAST, s.id DESC
    ), candidate_specs AS (
      SELECT * FROM indexed_candidates
      UNION ALL
      SELECT p.spec_slug, MAX(p.updated_at) AS updated_at
      FROM ssdlc_compiled_plans p
      WHERE p.workspace_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM indexed_candidates indexed
          WHERE indexed.spec_slug = p.spec_slug
        )
      GROUP BY p.spec_slug
    )
    SELECT candidate.spec_slug
    FROM candidate_specs candidate
    LEFT JOIN LATERAL (
      SELECT p.provenance_json, p.plan_json, p.is_current, p.updated_at
      FROM ssdlc_compiled_plans p
      WHERE p.workspace_id = $1 AND p.spec_slug = candidate.spec_slug
      ORDER BY p.is_current DESC, p.created_at DESC, p.id DESC
      LIMIT 1
    ) plan ON TRUE
    LEFT JOIN LATERAL (
      SELECT r.status
      FROM pipeline_runs r
      WHERE r.workspace_id = $1
        AND regexp_replace(r.spec_path, '^.*/|\\.json$', '', 'g') = candidate.spec_slug
      ORDER BY r.id DESC
      LIMIT 1
    ) run ON TRUE
    ORDER BY
      CASE
        WHEN plan.provenance_json->>'riskLevel' IN ('critical', 'high') THEN 0
        WHEN jsonb_path_exists(COALESCE(plan.plan_json, '{}'::jsonb), '$.gates[*] ? (@.approvalRequirement == "human")') THEN 1
        WHEN run.status IN ('failed', 'partial_failure', 'stalled') OR EXISTS (
          SELECT 1
          FROM ssdlc_lifecycle_evidence evidence
          WHERE evidence.workspace_id = $1
            AND evidence.spec_slug = candidate.spec_slug
            AND evidence.evidence_status IN (
              'failed', 'story_caused_failure', 'environment_credential_blocker'
            )
        ) THEN 2
        WHEN run.status IN ('queued', 'starting', 'running') THEN 3
        WHEN plan.is_current AND EXISTS (
          SELECT 1
          FROM spec_search_index indexed
          WHERE indexed.workspace_id = $1
            AND indexed.spec_slug = candidate.spec_slug
            AND indexed.status = 'approved'
        ) THEN 4
        ELSE 5
      END,
      COALESCE(plan.updated_at, candidate.updated_at) ASC NULLS FIRST,
      candidate.spec_slug ASC
    LIMIT $2
  `, [workspaceId, MAX_ATTENTION_CANDIDATES]);
  return rows.slice(0, MAX_ATTENTION_CANDIDATES).map((row) => row.spec_slug);
}

async function loadOperationalAttentionSignals(workspaceId: string): Promise<OperationalAttentionSignals | undefined> {
  return queryOne<OperationalAttentionSignals>(`
    SELECT
      (SELECT COUNT(*)::int FROM webhook_dlq WHERE workspace_id=$1 AND resolved_at IS NULL) AS dlq_count,
      (SELECT MIN(created_at) FROM webhook_dlq WHERE workspace_id=$1 AND resolved_at IS NULL) AS dlq_oldest_at,
      (SELECT COUNT(*)::int FROM memory_candidates WHERE workspace_id=$1 AND review_status IN ('pending','revisit')) AS knowledge_count,
      (SELECT MIN(created_at) FROM memory_candidates WHERE workspace_id=$1 AND review_status IN ('pending','revisit')) AS knowledge_oldest_at,
      (SELECT score FROM drift_reports WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1) AS drift_score,
      (SELECT CASE WHEN jsonb_typeof(violations_json)='array' THEN jsonb_array_length(violations_json) ELSE 0 END FROM drift_reports WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1) AS drift_violations,
      (SELECT created_at FROM drift_reports WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1) AS drift_created_at,
      (SELECT MAX(last_seen) FROM worker_heartbeat) AS worker_last_seen
  `, [workspaceId]);
}

function operationalAttentionItems(workspaceId: string, generatedAt: string, signals: OperationalAttentionSignals | undefined): ActionEnvelopeV1[] {
  if (!signals) return [];
  const definitions: Array<{
    include: boolean; id: string; kind: EntityRefV1['kind']; label: string; priority: Priority; whyNow: string;
    consequence: string; observedAt: string; href: string; outcome: OperationalStatePacketV1['outcome'];
    liveness: OperationalStatePacketV1['liveness']; risk: OperationalStatePacketV1['risk']; source: string;
  }> = [
    { include: signals.dlq_count > 0, id: 'webhook-dlq', kind: 'evidence', label: `${signals.dlq_count} unresolved webhook deliveries`, priority: 'safety', whyNow: 'Provider delivery failures are waiting in the authoritative dead-letter queue.', consequence: 'External delivery state may be incomplete until an operator resolves the failed deliveries.', observedAt: iso(signals.dlq_oldest_at, generatedAt), href: '/diagnostics', outcome: 'failed', liveness: 'stalled', risk: 'high', source: 'webhook-dlq' },
    { include: signals.knowledge_count > 0, id: 'knowledge-review', kind: 'knowledge', label: `${signals.knowledge_count} knowledge candidates need review`, priority: 'decision', whyNow: 'Captured knowledge is pending a human review decision.', consequence: 'Pending candidates remain excluded from approved retrieval until reviewed.', observedAt: iso(signals.knowledge_oldest_at, generatedAt), href: `/context-candidates?workspaceId=${encodeURIComponent(workspaceId)}`, outcome: 'pending', liveness: 'not_started', risk: 'unknown', source: 'memory-candidates' },
    { include: signals.drift_violations > 0, id: 'workspace-drift', kind: 'insight', label: `${signals.drift_violations} workspace drift findings`, priority: (signals.drift_score ?? 100) < 80 ? 'safety' : 'blocked', whyNow: 'The latest server-authored drift report contains convention violations.', consequence: 'Unresolved drift can make subsequent delivery work inconsistent with workspace conventions.', observedAt: iso(signals.drift_created_at, generatedAt), href: `/workspaces/${encodeURIComponent(workspaceId)}/drift`, outcome: 'partial', liveness: 'completed', risk: (signals.drift_score ?? 100) < 80 ? 'high' : 'medium', source: 'drift-report' },
    { include: signals.worker_last_seen === null || freshness(iso(signals.worker_last_seen, generatedAt), generatedAt) === 'stale', id: 'worker-health', kind: 'workspace', label: 'Execution worker health unavailable', priority: 'blocked', whyNow: signals.worker_last_seen === null ? 'No authoritative worker heartbeat is available.' : 'The authoritative worker heartbeat is stale.', consequence: 'Queued or active work may not advance while worker liveness is unknown.', observedAt: iso(signals.worker_last_seen, generatedAt), href: '/health', outcome: 'not_available', liveness: 'unknown', risk: 'high', source: 'worker-heartbeat' },
  ];
  return definitions.filter((definition) => definition.include).map((definition) => {
    const actionId = `attention:${definition.id}:view`;
    const action = viewAction(actionId, 'View authoritative details', definition.href);
    const observedFreshness = freshness(definition.observedAt, generatedAt);
    return ActionEnvelopeV1Schema.parse({
      schemaVersion: MISSION_CONTRACT_VERSIONS.actionEnvelope, actionId, workspaceId,
      entity: entity(workspaceId, definition.kind, definition.id, definition.label),
      priority: definition.priority, whyNow: definition.whyNow,
      state: packet({ observedAt: definition.observedAt, now: generatedAt, outcome: definition.outcome, liveness: definition.liveness, risk: definition.risk, confidence: 'high', authority: 'authoritative', sourceId: definition.source, sourceLabel: definition.label, consequence: definition.consequence, action }),
      owner: { kind: 'system', id: 'rorca-backend', label: 'Rorca backend' },
      createdAt: definition.observedAt, freshness: observedFreshness, permittedAction: action,
    });
  });
}

export async function getWorkspaceAttention(workspaceIdInput: unknown, now = new Date()): Promise<{ items: ActionEnvelopeV1[]; generatedAt: string }> {
  const workspaceId = assertWorkspaceId(workspaceIdInput);
  const generatedAt = now.toISOString();
  const [candidateSpecIds, operationalSignals] = await Promise.all([
    loadAttentionCandidateSpecIds(workspaceId),
    loadOperationalAttentionSignals(workspaceId),
  ]);
  const portfolio = await getLifecyclePortfolio({
    workspaceId,
    candidateSpecIds,
    sort: 'current_view',
    pagination: { limit: MAX_ATTENTION_CANDIDATES, offset: 0, cursor: null, usedCursor: false },
  });
  const lifecycleItems = (portfolio.items as LifecycleItem[]).map((item) => {
    const priority = attentionPriority(item);
    const actionId = `attention:${item.specId}:${priority}`;
    const action = viewAction(actionId, priority === 'decision' ? 'Open decision' : 'View delivery case', `/delivery-cases/${encodeURIComponent(item.specId)}`);
    const observedAt = iso(item.updatedAt, generatedAt);
    const blockers = Array.isArray(item.blockers) ? item.blockers : [];
    const blocker = blockers[0] ? { code: `lifecycle.${String(blockers[0].phaseId ?? 'blocked')}`, message: String(blockers[0].reason ?? 'Lifecycle work is blocked').slice(0, 2000), remediation: 'Open the delivery case and resolve the authoritative lifecycle blocker.' } : undefined;
    const whyNow = priority === 'safety' ? 'A high-severity governance or safety risk requires attention.'
      : priority === 'decision' ? 'An authoritative lifecycle phase is waiting for a human decision.'
      : priority === 'blocked' ? 'Delivery work is blocked, failed, or has stalled.'
      : priority === 'ready' ? 'Authoritative lifecycle checks indicate this case is ready to advance.'
      : item.state === 'needs_compilation' ? 'Lifecycle readiness is unavailable until the plan is compiled.' : 'This case is active and has no higher-priority server-known condition.';
    const consequence = priority === 'informational' ? 'No mutation is authorized by this read projection.' : 'Delay may prevent the delivery case from advancing safely.';
    const itemSnapshotId = 'snapshotId' in item ? item.snapshotId : undefined;
    const revision = item.currentRevision?.specVersion ? { kind: 'spec_version' as const, value: String(item.currentRevision.specVersion) } : itemSnapshotId ? { kind: 'snapshot' as const, value: String(itemSnapshotId) } : undefined;
    return ActionEnvelopeV1Schema.parse({
      schemaVersion: MISSION_CONTRACT_VERSIONS.actionEnvelope, actionId, workspaceId,
      entity: entity(workspaceId, 'spec', String(item.specId), String(item.title ?? item.specId), revision),
      priority, whyNow,
      state: packet({ observedAt, now: generatedAt, outcome: itemOutcome(item), liveness: itemLiveness(item.liveness), risk: item.risk ?? 'unknown', authority: 'derived', sourceId: String(itemSnapshotId ?? `portfolio:${workspaceId}`), sourceLabel: 'Lifecycle readiness projection', consequence, action, blocker }),
      owner: item.owner?.id ? { kind: 'user', id: String(item.owner.id), label: String(item.owner.label ?? item.owner.id).slice(0, 160) } : { kind: 'unassigned', label: 'Unassigned' },
      createdAt: observedAt, freshness: freshness(observedAt, generatedAt), permittedAction: action,
    });
  });
  const items = [...operationalAttentionItems(workspaceId, generatedAt, operationalSignals), ...lifecycleItems]
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt.localeCompare(b.createdAt) || a.actionId.localeCompare(b.actionId))
    .slice(0, MAX_ATTENTION);
  return { items, generatedAt };
}

const STAGES = ['planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance'] as const;

function lifecycleStatus(detail: LifecycleDetail): DeliveryCaseSummaryV1['lifecycle']['state'] {
  if (detail.overallReadiness.status === 'passed') return 'completed';
  if (detail.currentRun?.status === 'cancelled') return 'cancelled';
  if (detail.currentRun?.status === 'paused') return 'paused';
  if (detail.plan) return 'active';
  return 'draft';
}

function runStatus(detail: LifecycleDetail): DeliveryCaseSummaryV1['run']['state'] {
  const state = String(detail.currentRun?.liveness?.state ?? detail.currentRun?.status ?? '');
  if (state === 'running' || state === 'active') return 'running';
  if (state === 'queued') return 'queued';
  if (state === 'blocked' || state === 'stalled') return 'blocked';
  if (state === 'failed' || state === 'partial_failure') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'done' || state === 'completed') return 'completed';
  return detail.currentRun ? 'unknown' : 'not_scheduled';
}

function projectIntentSourceBundle(bundle: NonNullable<LifecycleDetail['sourceBundle']>): NonNullable<DeliveryCaseSummaryV1['sourceBundle']> {
  const source = ({ sourceId, title, sourceVersion, contentHash, selectedSections }: typeof bundle.includedSources[number]) =>
    ({ sourceId, title, sourceVersion, contentHash, selectedSections });
  return {
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    compiledAt: bundle.compiledAt,
    includedSources: bundle.includedSources.map(source),
    excludedSources: bundle.excludedSources.map((item) => ({ source: source(item.source), reason: item.reason })),
    citations: bundle.citations.map(({ citationId, sourceId, section, excerptHash, rationale }) =>
      ({ citationId, sourceId, section, excerptHash, rationale })),
    conflicts: bundle.conflicts.map(({ conflictId, sourceIds, summary, resolution }) =>
      ({ conflictId, sourceIds, summary, resolution })),
  };
}

function projectedSourceDrift(detail: LifecycleDetail): DeliveryCaseSummaryV1['sourceContext'] {
  const report = detail.sourceContext;
  if (!report) return undefined;
  // The live report contains backend-only schema/source-kind fields. Project an
  // explicit allow-list so filesystem observations cannot broaden the API.
  const parsed = SourceContextDriftV1Schema.safeParse({
    contextState: report.contextState,
    stale: report.stale,
    bundleHash: report.bundleHash,
    checkedAt: report.checkedAt,
    sources: report.sources.map(({ sourceId, locator, state, oldHash, newHash, detail: sourceDetail }) =>
      ({ sourceId, locator, state, oldHash, newHash, detail: sourceDetail })),
  });
  return parsed.success ? parsed.data : undefined;
}

export async function getDeliveryCaseSummary(workspaceIdInput: unknown, specIdInput: unknown, now = new Date()): Promise<DeliveryCaseSummaryV1> {
  const workspaceId = assertWorkspaceId(workspaceIdInput);
  const specId = assertSpecId(specIdInput);
  const projectedAt = now.toISOString();
  const detail = await getLifecycleSpec({ workspaceId, specId }) as LifecycleDetail;
  const snapshotId = String(detail.snapshotId);
  const specRevision = detail.plan?.specVersion ? { kind: 'spec_version' as const, value: String(detail.plan.specVersion) } : { kind: 'snapshot' as const, value: snapshotId };
  const missionRef = entity(workspaceId, 'mission', `delivery:${specId}`, String(detail.title ?? specId), { kind: 'snapshot', value: snapshotId });
  const specRef = entity(workspaceId, 'spec', specId, String(detail.title ?? specId), specRevision, { workspaceId, kind: 'mission', id: missionRef.id, revision: missionRef.revision, label: missionRef.label });
  const phaseById = new Map((detail.phaseTimeline ?? []).map((phase) => [String(phase.phaseId), phase]));
  const stagePhase: Record<typeof STAGES[number], string[]> = { planning: ['intake'], requirements: ['requirements'], design: ['architecture'], development: ['implementation'], testing: ['validation', 'security', 'qa'], deployment: ['staging', 'merge', 'production'], maintenance: ['learn'] };
  const observedAt = iso(detail.plan?.compiledAt ?? detail.currentRun?.startedAt, projectedAt);
  const actionId = `delivery-case:${specId}:view`;
  const action = viewAction(actionId, 'View lifecycle evidence', `/lifecycle/specs/${encodeURIComponent(specId)}`);
  const stages = Object.fromEntries(STAGES.map((stage) => {
    const phases = stagePhase[stage].map((id) => phaseById.get(id)).filter((phase): phase is LifecyclePhase => phase !== undefined);
    const blocked = phases.some((phase) => ['blocked', 'stale'].includes(phase.status));
    const passed = phases.length > 0 && phases.every((phase) => ['passed', 'not_applicable'].includes(phase.status));
    const state = packet({ observedAt, now: projectedAt, outcome: passed ? 'succeeded' : blocked ? 'failed' : phases.length ? 'pending' : 'unknown', liveness: passed ? 'completed' : blocked ? 'stalled' : phases.length ? 'not_started' : 'unknown', risk: blocked ? 'high' : passed ? 'none' : 'unknown', authority: 'derived', sourceId: snapshotId, sourceLabel: 'Exact lifecycle snapshot', consequence: blocked ? 'This projected delivery stage cannot safely advance.' : 'This stage is a read-only projection over canonical lifecycle phases.', action });
    return [stage, { label: stage[0].toUpperCase() + stage.slice(1), summary: blocked ? 'Blocked by authoritative lifecycle evidence or gates.' : passed ? 'Canonical lifecycle checks passed.' : phases.length ? 'Canonical lifecycle checks are pending.' : 'Lifecycle state is unavailable.', state, updatedAt: observedAt, entity: specRef }];
  })) as DeliveryCaseSummaryV1['stages'];
  const phaseCount = (detail.phaseTimeline ?? []).length;
  const passedCount = (detail.phaseTimeline ?? []).filter((phase) => ['passed', 'not_applicable'].includes(phase.status)).length;
  const awaiting = (detail.phaseTimeline ?? []).filter((phase) => phase.status === 'awaiting_approval').length;
  const runState = runStatus(detail);
  const runId = detail.currentRun?.id;
  const caseConsequence = ('stale' in detail && detail.stale) ? 'The lifecycle projection is stale and must not authorize advancement.' : 'This projection grants no mutation authority.';
  const caseState = packet({ observedAt, now: projectedAt, outcome: detail.overallReadiness.status === 'passed' ? 'succeeded' : detail.overallReadiness.ready ? 'partial' : 'pending', liveness: itemLiveness(detail.currentRun?.liveness), risk: ('stale' in detail && detail.stale) ? 'high' : detail.overallReadiness.ready ? 'none' : 'unknown', authority: 'derived', sourceId: snapshotId, sourceLabel: 'Exact lifecycle snapshot', consequence: caseConsequence, action });
  const sourceContext = projectedSourceDrift(detail);
  const caseAttention = ActionEnvelopeV1Schema.parse({
    schemaVersion: MISSION_CONTRACT_VERSIONS.actionEnvelope, actionId, workspaceId, entity: specRef, mission: missionRef,
    priority: awaiting > 0 ? 'decision' : ('stale' in detail && detail.stale) ? 'blocked' : detail.overallReadiness.ready ? 'ready' : 'informational',
    whyNow: awaiting > 0 ? 'The exact lifecycle snapshot is waiting for a human decision.' : 'Inspect the exact lifecycle snapshot and current delivery evidence.',
    state: caseState, owner: { kind: 'unassigned', label: 'Unassigned' }, createdAt: observedAt,
    freshness: freshness(observedAt, projectedAt), permittedAction: action,
  });
  const result = {
    schemaVersion: MISSION_CONTRACT_VERSIONS.deliveryCaseSummary, workspaceId, mission: missionRef, spec: specRef, stages,
    review: { state: awaiting ? 'in_review' : detail.plan ? 'approved' : 'unknown', requiredDecisions: awaiting, unresolvedDecisions: awaiting },
    readiness: { state: detail.overallReadiness.ready ? 'ready' : detail.overallReadiness.status === 'stale' ? 'at_risk' : detail.plan ? 'not_ready' : 'unknown', completedChecks: passedCount, totalChecks: phaseCount },
    lifecycle: { state: lifecycleStatus(detail), currentStage: STAGES.find((stage) => stages[stage].state.outcome !== 'succeeded') ?? 'maintenance' },
    run: { state: runState, ...(runId ? { run: entity(workspaceId, 'run', String(runId), `Run ${runId}`, undefined, { workspaceId, kind: 'spec', id: specId, revision: specRevision, label: specRef.label }) } : {}) },
    release: { state: stages.deployment.state.outcome === 'succeeded' ? 'released' : stages.deployment.state.outcome === 'failed' ? 'failed' : 'not_started' },
    ...(detail.sourceBundle ? { sourceBundle: projectIntentSourceBundle(detail.sourceBundle) } : {}),
    ...(sourceContext ? { sourceContext } : {}),
    state: caseState,
    actions: [caseAttention], projectedAt,
  };
  return DeliveryCaseSummaryV1Schema.parse(result);
}

interface RunRow {
  id: number; spec_path: string; status: string; started_at: Date | string; finished_at: Date | string | null; agent: string | null; agent_model: string | null;
  total_input_tokens: number | null; total_output_tokens: number | null; total_cost_usd: number | null; expected_story_ids: string[] | null;
  stories: Array<{ story_id: string; status: string; started_at: string | null; finished_at: string | null; model_used: string | null; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null }> | null;
}

export async function getRunControlProjection(workspaceIdInput: unknown, specIdInput: unknown, runIdInput: unknown, now = new Date()): Promise<RunControlProjectionV1> {
  const workspaceId = assertWorkspaceId(workspaceIdInput); const specId = assertSpecId(specIdInput); const runId = assertRunId(runIdInput); const projectedAt = now.toISOString();
  const detailPromise = getLifecycleSpec({ workspaceId, specId }) as Promise<LifecycleDetail>;
  const runPromise = queryOne<RunRow>(`SELECT r.id,r.spec_path,r.status,r.started_at,r.finished_at,r.agent,r.agent_model,r.total_input_tokens,r.total_output_tokens,r.total_cost_usd,r.expected_story_ids,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('story_id',s.story_id,'status',s.status,'started_at',s.started_at,'finished_at',s.finished_at,'model_used',s.model_used,'input_tokens',s.input_tokens,'output_tokens',s.output_tokens,'cost_usd',s.cost_usd) ORDER BY s.id) FROM (SELECT * FROM story_results WHERE run_id=r.id ORDER BY id LIMIT 500) s),'[]'::jsonb) AS stories
    FROM pipeline_runs r WHERE r.id=$1 AND r.workspace_id=$2 LIMIT 1`, [runId, workspaceId]);
  const [detail, run] = await Promise.all([detailPromise, runPromise]);
  if (!run || !run.spec_path.endsWith(`/${specId}.json`)) throw new NotFoundError('Run', String(runId));
  const snapshotId = String(detail.snapshotId); const specRevision = detail.plan?.specVersion ? { kind: 'spec_version' as const, value: String(detail.plan.specVersion) } : { kind: 'snapshot' as const, value: snapshotId };
  const mission = entity(workspaceId, 'mission', `delivery:${specId}`, String(detail.title ?? specId), { kind: 'snapshot', value: snapshotId });
  const spec = entity(workspaceId, 'spec', specId, String(detail.title ?? specId), specRevision);
  const runRef = entity(workspaceId, 'run', String(run.id), `Run ${run.id}`, undefined, { workspaceId, kind: 'spec', id: specId, revision: specRevision, label: spec.label });
  const rows = Array.isArray(run.stories) ? run.stories.slice(0, 500) : [];
  const storyIds = [...new Set([...(run.expected_story_ids ?? []), ...rows.map((row) => row.story_id)])].slice(0, 500);
  const stories = storyIds.map((id) => entity(workspaceId, 'story', id, id, undefined, { workspaceId, kind: 'spec', id: specId, revision: specRevision, label: spec.label }));
  const statusLiveness: OperationalStatePacketV1['liveness'] = run.status === 'running' ? 'running' : run.status === 'queued' ? 'queued' : run.status === 'paused' ? 'paused' : ['done', 'failed', 'partial_failure', 'cancelled'].includes(run.status) ? 'completed' : 'unknown';
  const outcome: OperationalStatePacketV1['outcome'] = run.status === 'done' ? 'succeeded' : ['failed', 'partial_failure'].includes(run.status) ? 'failed' : run.status === 'cancelled' ? 'cancelled' : 'pending';
  const observedAt = iso(run.finished_at ?? run.started_at, projectedAt); const view = viewAction(`run:${runId}:view`, 'View run evidence', `/runs/${runId}`);
  const state = packet({ observedAt, now: projectedAt, outcome, liveness: statusLiveness, risk: outcome === 'failed' ? 'high' : outcome === 'succeeded' ? 'none' : 'unknown', authority: 'authoritative', sourceId: `pipeline-run:${runId}`, sourceLabel: 'Pipeline run record', consequence: statusLiveness === 'unknown' ? 'Run health is unknown; this projection must not authorize control.' : 'Control actions require a separate server-authorized mutation endpoint.', action: view });
  const lanes = rows.slice(0, 64).map((row, index) => ({ laneId: `${runId}:${row.story_id}:${index}`, label: row.story_id, agent: run.agent ?? 'unknown', ...(row.model_used ?? run.agent_model ? { model: String(row.model_used ?? run.agent_model) } : {}), story: stories.find((item) => item.id === row.story_id), state: packet({ observedAt: iso(row.finished_at ?? row.started_at, observedAt), now: projectedAt, outcome: row.status === 'pass' ? 'succeeded' : ['fail', 'timeout'].includes(row.status) ? 'failed' : row.status === 'skip' ? 'not_available' : 'pending', liveness: row.finished_at ? 'completed' : run.status === 'running' ? 'running' : 'unknown', risk: ['fail', 'timeout'].includes(row.status) ? 'high' : 'unknown', authority: 'authoritative', sourceId: `story-result:${runId}:${row.story_id}`, sourceLabel: 'Story result', consequence: 'Story state is bounded semantic metadata; verbose process output is excluded.', action: view }), ...(row.started_at ? { startedAt: iso(row.started_at, observedAt) } : {}), ...(row.finished_at ? { completedAt: iso(row.finished_at, observedAt) } : {}) }));
  const inputTokens = run.total_input_tokens ?? (rows.every((r) => r.input_tokens !== null) ? rows.reduce((sum, r) => sum + Number(r.input_tokens), 0) : null);
  const outputTokens = run.total_output_tokens ?? (rows.every((r) => r.output_tokens !== null) ? rows.reduce((sum, r) => sum + Number(r.output_tokens), 0) : null);
  const totalTokens = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  const newest = rows.map((row) => row.finished_at ?? row.started_at).filter(Boolean).map((value) => iso(value, observedAt)).sort().at(-1);
  return RunControlProjectionV1Schema.parse({ schemaVersion: MISSION_CONTRACT_VERSIONS.runControlProjection, workspaceId, run: runRef, mission, spec, stories, state,
    waves: lanes.length ? [{ waveId: `${runId}:wave:0`, label: 'Execution', ordinal: 0, state, lanes }] : [],
    costTokens: { currency: 'USD', estimatedCost: null, actualCost: run.total_cost_usd ?? null, inputTokens, outputTokens, totalTokens },
    evidenceFreshness: { state: freshness(newest ?? observedAt, projectedAt), observedAt: projectedAt, ...(newest ? { newestEvidenceAt: newest } : {}), staleAfterSeconds: OBSERVATION_STALE_SECONDS, evidenceCount: rows.length },
    permittedActions: [view], projectedAt });
}
