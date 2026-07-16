/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Read-only operational projection for Lifecycle rollout and health. This
 * module reports existing plan/evidence/WAL state; it never compiles a plan,
 * retries work, probes an external provider, or changes Specs/Runs state.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execute, query, queryOne } from '../db/index';
import { AppError, ConflictError, NotFoundError, ValidationError } from './errors';
import { logger } from './logger';
import { CANONICAL_PHASES } from './ssdlc-contracts';
import { getLifecyclePortfolio } from './ssdlc-lifecycle-read';

const MAX_ROLLOUT_SPECS = 500;
const MAX_FAILURES = 50;
const BACKFILL_PAGE_LIMIT = 20;
const ADAPTERS = [
  'story_results',
  'story_commits',
  'wal_validation',
  'github_checks',
  'completion_signals',
  'run_output_reference',
  'run_finished_subscriber',
] as const;

interface WorkspaceRow { id: string; path: string; label: string }
interface PlanRow { spec_slug: string; has_current: boolean; has_historical: boolean }
interface FailureRow { spec_slug: string; reason_code: string; retryable: boolean; created_at: Date | string }
interface WalCountsRow {
  adapter_errors: number;
  evidence_conflicts: number;
  stale_preview_denials: number;
  evaluator_errors: number;
  phase_transitions: number;
  backfill_pages: number;
}
interface AdapterErrorRow { adapter: string; error_count: number; last_error_at: Date | string }
interface CountRow { total: number }

function validateWorkspaceId(value: string): string {
  const workspaceId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(workspaceId)) {
    throw new ValidationError('workspaceId must be a stable workspace identifier', { field: 'workspaceId' });
  }
  return workspaceId;
}

function discoverSpecSlugs(workspacePath: string): string[] {
  const slugs = new Set<string>();
  for (const status of ['pending', 'approved']) {
    const directory = path.join(workspacePath, 'forge', 'specs', status);
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) slugs.add(entry.name.slice(0, -5));
        if (slugs.size > MAX_ROLLOUT_SPECS) {
          throw new ConflictError('Lifecycle rollout exceeds the bounded operational view', {
            type: 'narrow_rollout_required',
            maximumSpecs: MAX_ROLLOUT_SPECS,
          });
        }
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Missing or unreadable partitions are represented as no discoverable specs.
    }
  }
  return [...slugs].sort();
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** Audit unexpected evaluator failures without recording request/evidence payloads. */
export async function recordLifecycleEvaluatorError(input: {
  workspaceId?: string;
  specId?: string;
  operation: string;
  error: unknown;
}): Promise<void> {
  if (input.error instanceof AppError) return;
  logger.warn({ err: input.error, workspaceId: input.workspaceId, specId: input.specId, operation: input.operation }, '[lifecycle] evaluator read failed');
  if (!input.workspaceId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(input.workspaceId)) return;
  try {
    await execute(`
      INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
      VALUES ('ssdlc_lifecycle_evaluator_error', $1, $2, 'lifecycle-api', $3::jsonb)
    `, [
      input.workspaceId,
      input.specId ?? null,
      JSON.stringify({
        operation: input.operation,
        errorType: input.error instanceof Error ? input.error.name : 'UnknownError',
        retryable: true,
        observedAt: new Date().toISOString(),
      }),
    ]);
  } catch (auditError) {
    logger.warn({ err: auditError, operation: input.operation }, '[lifecycle] failed to audit evaluator error');
  }
}

export async function getLifecycleOperationsReport(input: { workspaceId: string }) {
  const workspaceId = validateWorkspaceId(input.workspaceId);
  const workspace = await queryOne<WorkspaceRow>('SELECT id, path, label FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) throw new NotFoundError('Workspace', workspaceId);

  const specSlugs = discoverSpecSlugs(workspace.path);
  const [plans, failures, recentCompilerErrors, walCounts, adapterErrors, portfolio] = await Promise.all([
    specSlugs.length === 0 ? Promise.resolve([] as PlanRow[]) : query<PlanRow>(`
      SELECT spec_slug,
             BOOL_OR(is_current) AS has_current,
             BOOL_OR(NOT is_current) AS has_historical
      FROM ssdlc_compiled_plans
      WHERE workspace_id = $1 AND spec_slug = ANY($2::text[])
      GROUP BY spec_slug
    `, [workspaceId, specSlugs]),
    query<FailureRow>(`
      SELECT spec_slug, reason_code, retryable, created_at
      FROM ssdlc_plan_readiness_reasons
      WHERE workspace_id = $1 AND resolved_at IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `, [workspaceId, MAX_FAILURES]),
    queryOne<CountRow>(`
      SELECT COUNT(*)::int AS total
      FROM ssdlc_plan_readiness_reasons
      WHERE workspace_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
    `, [workspaceId]),
    queryOne<WalCountsRow>(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'ssdlc_evidence_adapter_error')::int AS adapter_errors,
        COUNT(*) FILTER (WHERE event_type = 'ssdlc_evidence_source_conflict')::int AS evidence_conflicts,
        COUNT(*) FILTER (WHERE event_type IN ('ssdlc_retry_preview_denied', 'retry_scope_mismatch'))::int AS stale_preview_denials,
        COUNT(*) FILTER (WHERE event_type = 'ssdlc_lifecycle_evaluator_error')::int AS evaluator_errors,
        COUNT(*) FILTER (WHERE event_type = 'lifecycle_changed' AND NULLIF(payload->>'phaseId', '') IS NOT NULL)::int AS phase_transitions,
        COUNT(*) FILTER (WHERE event_type = 'lifecycle_changed' AND payload->>'changeKind' = 'plans_backfilled')::int AS backfill_pages
      FROM wal_events
      WHERE workspace_id = $1 AND ts >= NOW() - INTERVAL '24 hours'
    `, [workspaceId]),
    query<AdapterErrorRow>(`
      SELECT COALESCE(NULLIF(payload->>'adapter', ''), 'unknown') AS adapter,
             COUNT(*)::int AS error_count,
             MAX(ts) AS last_error_at
      FROM wal_events
      WHERE workspace_id = $1
        AND event_type = 'ssdlc_evidence_adapter_error'
        AND ts >= NOW() - INTERVAL '24 hours'
      GROUP BY COALESCE(NULLIF(payload->>'adapter', ''), 'unknown')
      ORDER BY adapter
    `, [workspaceId]),
    getLifecyclePortfolio({
      workspaceId,
      sort: 'current_view',
      pagination: { limit: 100, offset: 0, cursor: null, usedCursor: false },
    }),
  ]);

  const plansBySpec = new Map(plans.map((plan) => [plan.spec_slug, plan]));
  const failureBySpec = new Map(failures.map((failure) => [failure.spec_slug, failure]));
  const states = specSlugs.map((specSlug) => {
    const plan = plansBySpec.get(specSlug);
    if (plan?.has_current) return { specSlug, state: 'current' as const };
    if (failureBySpec.has(specSlug)) return { specSlug, state: 'compilation_failed' as const };
    if (plan?.has_historical) return { specSlug, state: 'stale' as const };
    return { specSlug, state: 'needs_compilation' as const };
  });
  const stateCount = (state: typeof states[number]['state']) => states.filter((item) => item.state === state).length;
  const current = stateCount('current');
  const stale = stateCount('stale');
  const compilationFailed = stateCount('compilation_failed');
  const needsCompilation = stateCount('needs_compilation');
  const total = states.length;
  const errorByAdapter = new Map(adapterErrors.map((row) => [row.adapter, row]));
  const observedAdapters = [...new Set([...ADAPTERS, ...adapterErrors.map((row) => row.adapter)])].sort();
  const kpis = portfolio.kpis;
  const blockedPhases = CANONICAL_PHASES.map((phase) => ({
    phaseId: phase.id,
    count: portfolio.items.reduce((count, item) => {
      const cell = item.phases.find((candidate) => candidate.phaseId === phase.id);
      return count + (cell && ['blocked', 'stale', 'awaiting_approval'].includes(cell.status) ? 1 : 0);
    }, 0),
  })).filter((phase) => phase.count > 0);

  const retryableActions = states
    .filter((item) => item.state !== 'current')
    .slice(0, MAX_FAILURES)
    .map((item) => ({
      kind: item.state === 'compilation_failed' ? 'retry_compile' : item.state === 'stale' ? 'recompile_stale_plan' : 'compile_missing_plan',
      specId: item.specSlug,
      method: 'POST' as const,
      path: `/api/lifecycle/specs/${encodeURIComponent(item.specSlug)}/recompile`,
      requiresIdempotencyKey: true,
    }));

  return {
    schemaVersion: 'lifecycle-operations.v1' as const,
    generatedAt: new Date().toISOString(),
    window: '24h' as const,
    workspace: { id: workspace.id, label: workspace.label },
    safety: {
      readOnly: true,
      adapterFailuresAffectSpecsOrRuns: false,
      maximumSpecs: MAX_ROLLOUT_SPECS,
      backfillPageLimit: BACKFILL_PAGE_LIMIT,
    },
    rollout: {
      planCoverage: {
        total,
        current,
        stale,
        compilationFailed,
        needsCompilation,
        percentCurrent: total === 0 ? 100 : Math.round((current / total) * 10_000) / 100,
      },
      backfillProgress: {
        processed: current + compilationFailed,
        remaining: stale + needsCompilation,
        pagesObservedLast24h: number(walCounts?.backfill_pages),
        complete: total === current,
        nextSpecId: states.find((item) => item.state !== 'current')?.specSlug ?? null,
      },
      compileFailures: failures.map((failure) => ({
        specId: failure.spec_slug,
        code: failure.reason_code,
        retryable: failure.retryable,
        observedAt: iso(failure.created_at),
      })),
      stalePlans: states.filter((item) => item.state === 'stale').map((item) => item.specSlug),
      blockedPhases: {
        items: blockedPhases,
        inspectedSpecs: portfolio.items.length,
        truncated: portfolio.total > portfolio.items.length,
      },
      blockedSpecs: number(kpis.blockedSpecs),
      retryableActions,
    },
    health: {
      status: number(recentCompilerErrors?.total) > 0
        || number(walCounts?.evaluator_errors) > 0
        || number(walCounts?.adapter_errors) > 0
        || number(walCounts?.evidence_conflicts) > 0
        ? 'degraded'
        : 'healthy',
      counters: {
        compilerErrors: number(recentCompilerErrors?.total),
        evaluatorErrors: number(walCounts?.evaluator_errors),
        evidenceConflicts: number(walCounts?.evidence_conflicts),
        stalePreviewDenials: number(walCounts?.stale_preview_denials),
        phaseTransitions: number(walCounts?.phase_transitions),
        adapterErrors: number(walCounts?.adapter_errors),
      },
      adapters: observedAdapters.map((adapter) => {
        const error = errorByAdapter.get(adapter);
        return {
          adapter,
          availability: error ? 'degraded' as const : 'available' as const,
          errorsLast24h: number(error?.error_count),
          lastErrorAt: error ? iso(error.last_error_at) : null,
        };
      }),
      payloadPolicy: 'counts_and_identifiers_only' as const,
    },
  };
}
