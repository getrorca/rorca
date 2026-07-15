/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute, query, queryOne } from '../db/index';
import {
  DEFAULT_CAPTURE_POLICY,
  formatRedactionDiagnostics,
  normalizeCapturePolicyMode,
  type CanonicalCapturePolicyMode,
  type CaptureSafetyReport,
  type RedactionDiagnostics,
} from './context-safety';

export type ContextCaptureAuditEventType = 'install' | 'uninstall' | 'pause' | 'resume' | 'policy_update' | 'capture_submitted' | 'capture_suppressed';

export type ContextCaptureControlState = {
  workspaceId: string;
  policyMode: CanonicalCapturePolicyMode;
  paused: boolean;
  redactionPolicyVersion: string;
  activeIntegrations: Record<string, unknown>;
  ignoredPaths: string[];
  lastCapturedEvent: {
    occurredAt: string | null;
    eventType: string | null;
    integrationId: string | null;
    redactionDiagnostics: RedactionDiagnostics;
  };
};

type SettingsRow = {
  workspace_id: string;
  policy_mode: string;
  paused: boolean;
  redaction_policy_version: string;
  active_integrations: unknown;
  ignored_paths: unknown;
  last_event_at: string | null;
  last_event_type: string | null;
  last_integration_id: string | null;
  last_redaction_summary: unknown;
};

type AuditRow = {
  id: string;
  workspace_id: string | null;
  event_type: ContextCaptureAuditEventType;
  integration_id: string;
  occurred_at: string;
  redaction_summary: unknown;
  regulated_flags: string[] | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function rowToState(row: SettingsRow, workspaceId: string): ContextCaptureControlState {
  const diagnostics = formatRedactionDiagnostics(asRecord(row.last_redaction_summary));
  return {
    workspaceId,
    policyMode: normalizeCapturePolicyMode(row.policy_mode, 'off'),
    paused: Boolean(row.paused),
    redactionPolicyVersion: row.redaction_policy_version || DEFAULT_CAPTURE_POLICY.version,
    activeIntegrations: asRecord(row.active_integrations),
    ignoredPaths: asStringArray(row.ignored_paths),
    lastCapturedEvent: {
      occurredAt: row.last_event_at,
      eventType: row.last_event_type,
      integrationId: row.last_integration_id,
      redactionDiagnostics: diagnostics,
    },
  };
}

export function defaultContextCaptureControlState(workspaceId: string): ContextCaptureControlState {
  return {
    workspaceId,
    policyMode: 'off',
    paused: false,
    redactionPolicyVersion: DEFAULT_CAPTURE_POLICY.version,
    activeIntegrations: {},
    ignoredPaths: [],
    lastCapturedEvent: {
      occurredAt: null,
      eventType: null,
      integrationId: null,
      redactionDiagnostics: formatRedactionDiagnostics(),
    },
  };
}

export async function getContextCaptureControlState(workspaceId: string): Promise<ContextCaptureControlState> {
  const row = await queryOne<SettingsRow>(
    `SELECT workspace_id, policy_mode, paused, redaction_policy_version, active_integrations, ignored_paths,
            last_event_at::text AS last_event_at, last_event_type, last_integration_id, last_redaction_summary
       FROM context_capture_settings
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (!row) return defaultContextCaptureControlState(workspaceId);
  return rowToState(row, workspaceId);
}

export async function upsertContextCaptureControlState(input: {
  workspaceId: string;
  policyMode?: CanonicalCapturePolicyMode;
  paused?: boolean;
  activeIntegrations?: Record<string, unknown>;
  ignoredPaths?: string[];
}): Promise<ContextCaptureControlState> {
  const current = await getContextCaptureControlState(input.workspaceId);
  const policyMode = input.policyMode ?? current.policyMode;
  const paused = input.paused ?? current.paused;
  const activeIntegrations = input.activeIntegrations ?? current.activeIntegrations;
  const ignoredPaths = input.ignoredPaths ?? current.ignoredPaths;
  await execute(
    `INSERT INTO context_capture_settings (workspace_id, policy_mode, paused, redaction_policy_version, active_integrations, ignored_paths, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, NOW())
     ON CONFLICT (workspace_id) DO UPDATE SET
       policy_mode = EXCLUDED.policy_mode,
       paused = EXCLUDED.paused,
       redaction_policy_version = EXCLUDED.redaction_policy_version,
       active_integrations = EXCLUDED.active_integrations,
       ignored_paths = EXCLUDED.ignored_paths,
       updated_at = NOW()`,
    [input.workspaceId, policyMode, paused, DEFAULT_CAPTURE_POLICY.version, JSON.stringify(activeIntegrations), JSON.stringify(ignoredPaths)],
  );
  return getContextCaptureControlState(input.workspaceId);
}

export async function appendContextCaptureAudit(input: {
  workspaceId: string;
  eventType: ContextCaptureAuditEventType;
  integrationId: string;
  safety?: Partial<CaptureSafetyReport>;
}): Promise<void> {
  const diagnostics = formatRedactionDiagnostics(input.safety ?? {});
  await execute(
    `INSERT INTO context_capture_audit_log (workspace_id, event_type, integration_id, redaction_summary, regulated_flags)
     VALUES ($1, $2, $3, $4::jsonb, $5::text[])`,
    [input.workspaceId, input.eventType, input.integrationId, JSON.stringify(diagnostics), diagnostics.regulatedDomainFlags],
  );
}

export async function recordContextCaptureSubmission(input: {
  workspaceId: string;
  eventType: 'capture_submitted' | 'capture_suppressed';
  integrationId: string;
  payloadEventType?: string | null;
  safety?: Partial<CaptureSafetyReport>;
}): Promise<void> {
  const diagnostics = formatRedactionDiagnostics(input.safety ?? {});
  await appendContextCaptureAudit({ workspaceId: input.workspaceId, eventType: input.eventType, integrationId: input.integrationId, safety: input.safety });
  await execute(
    `INSERT INTO context_capture_settings (workspace_id, policy_mode, paused, redaction_policy_version, last_event_at, last_event_type, last_integration_id, last_redaction_summary)
     VALUES ($1, 'off', false, $2, NOW(), $3, $4, $5::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET
       last_event_at = NOW(),
       last_event_type = EXCLUDED.last_event_type,
       last_integration_id = EXCLUDED.last_integration_id,
       last_redaction_summary = EXCLUDED.last_redaction_summary,
       updated_at = NOW()`,
    [input.workspaceId, DEFAULT_CAPTURE_POLICY.version, input.payloadEventType ?? input.eventType, input.integrationId, JSON.stringify(diagnostics)],
  );
}

export async function listContextCaptureAudit(workspaceId: string, limit = 50): Promise<Array<{
  id: string;
  workspaceId: string | null;
  eventType: ContextCaptureAuditEventType;
  integrationId: string;
  occurredAt: string;
  redactionDiagnostics: RedactionDiagnostics;
  regulatedFlags: string[];
}>> {
  const rows = await query<AuditRow>(
    `SELECT id::text, workspace_id, event_type, integration_id, occurred_at::text, redaction_summary, regulated_flags
       FROM context_capture_audit_log
      WHERE workspace_id = $1
      ORDER BY occurred_at DESC, id DESC
      LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    integrationId: row.integration_id,
    occurredAt: row.occurred_at,
    redactionDiagnostics: formatRedactionDiagnostics(asRecord(row.redaction_summary)),
    regulatedFlags: row.regulated_flags ?? [],
  }));
}

export type ContextCaptureQueueMetrics = {
  available: boolean;
  depth: number;
  created: number;
  retry: number;
  active: number;
  failed: number;
  completed: number;
  oldestPendingAt: string | null;
  lastCompletedAt: string | null;
};

export type ContextCaptureMonitoring = {
  generatedAt: string;
  windowHours: number;
  queues: {
    capture: ContextCaptureQueueMetrics;
    distillation: ContextCaptureQueueMetrics;
    recentFailures: Array<{ id: string; queue: 'context:capture' | 'context:distill'; failedAt: string | null; retryCount: number }>;
  };
  distillation: {
    available: boolean;
    total: number;
    pending: number;
    skipped: number;
    candidates: number;
    autoApproved: number;
    errors: number;
    activeErrors: number;
    acceptedHistoricalErrors: number;
    lastAttemptedAt: string | null;
    lastErrorAt: string | null;
    lastActiveErrorAt: string | null;
    acceptedBaseline: {
      id: 'brownfield_candidate_payload_compatibility';
      migrationVersion: number;
      appliedAt: string;
      errorClass: 'schema_error';
    } | null;
    recentErrors: Array<{
      eventId: string;
      eventType: string | null;
      attemptedAt: string | null;
      errorClass: string;
      disposition: 'active' | 'accepted_historical';
    }>;
  };
  audit: {
    available: boolean;
    events: number;
    submitted: number;
    suppressed: number;
    redactions: number;
    ignoredPaths: number;
    truncated: number;
    regulatedEvents: number;
    lastAuditAt: string | null;
  };
  worker: {
    status: 'ok' | 'stale' | 'not_running' | 'unknown';
    pid: number | null;
    lastSeen: string | null;
    ageSeconds: number | null;
  };
};

const emptyQueueMetrics = (): ContextCaptureQueueMetrics => ({
  available: false,
  depth: 0,
  created: 0,
  retry: 0,
  active: 0,
  failed: 0,
  completed: 0,
  oldestPendingAt: null,
  lastCompletedAt: null,
});

const BROWNFIELD_CANDIDATE_COMPATIBILITY_MIGRATION = 20260714150000;
const BROWNFIELD_MISSING_CANDIDATE_PAYLOAD_ERROR = 'column "payload" of relation "memory_candidates" does not exist';

function classifyDistillationError(message: string): string {
  const value = message.toLowerCase();
  if (value.includes('column') || value.includes('relation') || value.includes('schema')) return 'schema_error';
  if (value.includes('constraint') || value.includes('violates')) return 'constraint_error';
  if (value.includes('invalid') || value.includes('validation')) return 'validation_error';
  if (value.includes('timeout')) return 'timeout';
  return 'processing_error';
}

export async function getContextCaptureMonitoring(workspaceId: string, windowHours = 24): Promise<ContextCaptureMonitoring> {
  const boundedWindowHours = Math.min(Math.max(Math.trunc(windowHours), 1), 24 * 30);
  const capture = emptyQueueMetrics();
  const distillationQueue = emptyQueueMetrics();
  const recentFailures: ContextCaptureMonitoring['queues']['recentFailures'] = [];

  try {
    const rows = await query<{
      name: 'context:capture' | 'context:distill';
      state: string;
      count: string;
      oldest_pending_at: string | null;
      last_completed_at: string | null;
    }>(
      `WITH relevant_jobs AS (
         SELECT id, name, state::text, data, retry_count, created_on, completed_on, completed_on AS terminal_at
           FROM pgboss.job
          WHERE name IN ('context:capture', 'context:distill')
         UNION ALL
         SELECT id, name, state::text, data, retry_count, created_on, completed_on, COALESCE(completed_on, archived_on) AS terminal_at
           FROM pgboss.archive
          WHERE name IN ('context:capture', 'context:distill')
            AND archived_on >= NOW() - ($2::int * INTERVAL '1 hour')
       )
       SELECT name, state, COUNT(*)::text AS count,
              MIN(created_on) FILTER (WHERE state IN ('created', 'retry', 'active'))::text AS oldest_pending_at,
              MAX(terminal_at) FILTER (WHERE state = 'completed')::text AS last_completed_at
         FROM relevant_jobs
        WHERE COALESCE(data->>'workspaceId', data->'data'->>'workspaceId') = $1
        GROUP BY name, state`,
      [workspaceId, boundedWindowHours],
    );
    capture.available = true;
    distillationQueue.available = true;
    for (const row of rows) {
      const target = row.name === 'context:capture' ? capture : distillationQueue;
      const count = Number(row.count || 0);
      if (row.state === 'created') target.created += count;
      else if (row.state === 'retry') target.retry += count;
      else if (row.state === 'active') target.active += count;
      else if (row.state === 'failed') target.failed += count;
      else if (row.state === 'completed') target.completed += count;
      if (row.oldest_pending_at && (!target.oldestPendingAt || row.oldest_pending_at < target.oldestPendingAt)) target.oldestPendingAt = row.oldest_pending_at;
      if (row.last_completed_at && (!target.lastCompletedAt || row.last_completed_at > target.lastCompletedAt)) target.lastCompletedAt = row.last_completed_at;
    }
    capture.depth = capture.created + capture.retry + capture.active;
    distillationQueue.depth = distillationQueue.created + distillationQueue.retry + distillationQueue.active;

    const failureRows = await query<{ id: string; name: 'context:capture' | 'context:distill'; failed_at: string | null; retry_count: number }>(
      `WITH failed_jobs AS (
         SELECT id, name, state::text, data, retry_count, COALESCE(completed_on, created_on) AS failed_at
           FROM pgboss.job
          WHERE name IN ('context:capture', 'context:distill') AND state = 'failed'
         UNION ALL
         SELECT id, name, state::text, data, retry_count, COALESCE(completed_on, archived_on) AS failed_at
           FROM pgboss.archive
          WHERE name IN ('context:capture', 'context:distill')
            AND state = 'failed'
            AND archived_on >= NOW() - ($2::int * INTERVAL '1 hour')
       )
       SELECT id::text, name, failed_at::text, retry_count
         FROM failed_jobs
        WHERE COALESCE(data->>'workspaceId', data->'data'->>'workspaceId') = $1
        ORDER BY failed_at DESC NULLS LAST
        LIMIT 20`,
      [workspaceId, boundedWindowHours],
    );
    recentFailures.push(...failureRows.map((row) => ({ id: row.id, queue: row.name, failedAt: row.failed_at, retryCount: row.retry_count })));
  } catch {
    // pg-boss may not be initialised yet. Preserve explicit availability=false.
  }

  const distillation: ContextCaptureMonitoring['distillation'] = {
    available: false,
    total: 0,
    pending: 0,
    skipped: 0,
    candidates: 0,
    autoApproved: 0,
    errors: 0,
    activeErrors: 0,
    acceptedHistoricalErrors: 0,
    lastAttemptedAt: null,
    lastErrorAt: null,
    lastActiveErrorAt: null,
    acceptedBaseline: null,
    recentErrors: [],
  };
  try {
    const row = await queryOne<{
      total: string;
      pending: string;
      skipped: string;
      candidates: string;
      auto_approved: string;
      errors: string;
      active_errors: string;
      accepted_historical_errors: string;
      last_attempted_at: string | null;
      last_error_at: string | null;
      last_active_error_at: string | null;
      accepted_baseline_applied_at: string | null;
    }>(
      `WITH accepted_baseline AS (
         SELECT sm.applied_at
           FROM public.schema_migrations sm
          WHERE sm.version = $2::bigint
            AND EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema = 'rorca'
                 AND table_name = 'memory_candidates'
                 AND column_name = 'dedupe_key'
            )
       ), event_outcomes AS (
         SELECT ce.distillation_status, ce.distillation_attempted_at,
                COALESCE(
                  ce.distillation_error = $3
                  AND ce.distillation_attempted_at <= (SELECT applied_at FROM accepted_baseline),
                  false
                ) AS accepted_historical_error
           FROM context_events ce
          WHERE ce.workspace_id = $1
       )
       SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE distillation_status IS NULL)::text AS pending,
              COUNT(*) FILTER (WHERE distillation_status = 'skipped')::text AS skipped,
              COUNT(*) FILTER (WHERE distillation_status = 'candidate')::text AS candidates,
              COUNT(*) FILTER (WHERE distillation_status = 'auto_approved')::text AS auto_approved,
              COUNT(*) FILTER (WHERE distillation_status = 'error')::text AS errors,
              COUNT(*) FILTER (WHERE distillation_status = 'error' AND NOT accepted_historical_error)::text AS active_errors,
              COUNT(*) FILTER (WHERE distillation_status = 'error' AND accepted_historical_error)::text AS accepted_historical_errors,
              MAX(distillation_attempted_at)::text AS last_attempted_at,
              MAX(distillation_attempted_at) FILTER (WHERE distillation_status = 'error')::text AS last_error_at,
              MAX(distillation_attempted_at) FILTER (WHERE distillation_status = 'error' AND NOT accepted_historical_error)::text AS last_active_error_at,
              (SELECT applied_at::text FROM accepted_baseline) AS accepted_baseline_applied_at
         FROM event_outcomes`,
      [workspaceId, BROWNFIELD_CANDIDATE_COMPATIBILITY_MIGRATION, BROWNFIELD_MISSING_CANDIDATE_PAYLOAD_ERROR],
    );
    if (row) {
      distillation.available = true;
      distillation.total = Number(row.total || 0);
      distillation.pending = Number(row.pending || 0);
      distillation.skipped = Number(row.skipped || 0);
      distillation.candidates = Number(row.candidates || 0);
      distillation.autoApproved = Number(row.auto_approved || 0);
      distillation.errors = Number(row.errors || 0);
      distillation.activeErrors = Number(row.active_errors || 0);
      distillation.acceptedHistoricalErrors = Number(row.accepted_historical_errors || 0);
      distillation.lastAttemptedAt = row.last_attempted_at;
      distillation.lastErrorAt = row.last_error_at;
      distillation.lastActiveErrorAt = row.last_active_error_at;
      distillation.acceptedBaseline = row.accepted_baseline_applied_at ? {
        id: 'brownfield_candidate_payload_compatibility',
        migrationVersion: BROWNFIELD_CANDIDATE_COMPATIBILITY_MIGRATION,
        appliedAt: row.accepted_baseline_applied_at,
        errorClass: 'schema_error',
      } : null;
    }
    const errorRows = await query<{
      id: string;
      event_type: string | null;
      attempted_at: string | null;
      distillation_error: string | null;
      accepted_historical: boolean;
    }>(
      `WITH accepted_baseline AS (
         SELECT sm.applied_at
           FROM public.schema_migrations sm
          WHERE sm.version = $2::bigint
            AND EXISTS (
              SELECT 1
                FROM information_schema.columns
               WHERE table_schema = 'rorca'
                 AND table_name = 'memory_candidates'
                 AND column_name = 'dedupe_key'
            )
       )
       SELECT ce.id::text, ce.event_type, ce.distillation_attempted_at::text AS attempted_at, ce.distillation_error,
              COALESCE(
                ce.distillation_error = $3
                AND ce.distillation_attempted_at <= (SELECT applied_at FROM accepted_baseline),
                false
              ) AS accepted_historical
         FROM context_events ce
        WHERE ce.workspace_id = $1 AND ce.distillation_status = 'error'
        ORDER BY ce.distillation_attempted_at DESC NULLS LAST, ce.id DESC
        LIMIT 20`,
      [workspaceId, BROWNFIELD_CANDIDATE_COMPATIBILITY_MIGRATION, BROWNFIELD_MISSING_CANDIDATE_PAYLOAD_ERROR],
    );
    distillation.recentErrors = errorRows.map((errorRow) => ({
      eventId: errorRow.id,
      eventType: errorRow.event_type,
      attemptedAt: errorRow.attempted_at,
      errorClass: classifyDistillationError(errorRow.distillation_error ?? ''),
      disposition: errorRow.accepted_historical ? 'accepted_historical' : 'active',
    }));
  } catch {
    // Capture migrations may not be applied yet. Preserve explicit availability=false.
  }

  const audit: ContextCaptureMonitoring['audit'] = {
    available: false,
    events: 0,
    submitted: 0,
    suppressed: 0,
    redactions: 0,
    ignoredPaths: 0,
    truncated: 0,
    regulatedEvents: 0,
    lastAuditAt: null,
  };
  try {
    const row = await queryOne<{
      events: string;
      submitted: string;
      suppressed: string;
      redactions: string;
      ignored_paths: string;
      truncated: string;
      regulated_events: string;
      last_audit_at: string | null;
    }>(
      `SELECT COUNT(*)::text AS events,
              COUNT(*) FILTER (WHERE event_type = 'capture_submitted')::text AS submitted,
              COUNT(*) FILTER (WHERE event_type = 'capture_suppressed')::text AS suppressed,
              COALESCE(SUM((redaction_summary->>'redactionCount')::int), 0)::text AS redactions,
              COALESCE(SUM((redaction_summary->>'ignoredPathCount')::int), 0)::text AS ignored_paths,
              COUNT(*) FILTER (WHERE COALESCE((redaction_summary->>'truncated')::boolean, false))::text AS truncated,
              COUNT(*) FILTER (WHERE COALESCE(array_length(regulated_flags, 1), 0) > 0)::text AS regulated_events,
              MAX(occurred_at)::text AS last_audit_at
         FROM context_capture_audit_log
        WHERE workspace_id = $1
          AND occurred_at >= NOW() - ($2::int * INTERVAL '1 hour')`,
      [workspaceId, boundedWindowHours],
    );
    if (row) {
      audit.available = true;
      audit.events = Number(row.events || 0);
      audit.submitted = Number(row.submitted || 0);
      audit.suppressed = Number(row.suppressed || 0);
      audit.redactions = Number(row.redactions || 0);
      audit.ignoredPaths = Number(row.ignored_paths || 0);
      audit.truncated = Number(row.truncated || 0);
      audit.regulatedEvents = Number(row.regulated_events || 0);
      audit.lastAuditAt = row.last_audit_at;
    }
  } catch {
    // Capture audit migrations may not be applied yet. Preserve availability=false.
  }

  let worker: ContextCaptureMonitoring['worker'] = { status: 'not_running', pid: null, lastSeen: null, ageSeconds: null };
  try {
    const row = await queryOne<{ pid: number | null; last_seen: string }>(
      `SELECT pid, last_seen::text FROM worker_heartbeat ORDER BY last_seen DESC LIMIT 1`,
    );
    if (row) {
      const lastSeenMs = new Date(row.last_seen).getTime();
      if (Number.isFinite(lastSeenMs)) {
        const ageSeconds = Math.max(0, Math.round((Date.now() - lastSeenMs) / 1000));
        worker = { status: ageSeconds > 90 ? 'stale' : 'ok', pid: row.pid, lastSeen: row.last_seen, ageSeconds };
      } else {
        worker = { status: 'unknown', pid: row.pid, lastSeen: row.last_seen, ageSeconds: null };
      }
    }
  } catch {
    worker = { status: 'unknown', pid: null, lastSeen: null, ageSeconds: null };
  }

  return {
    generatedAt: new Date().toISOString(),
    windowHours: boundedWindowHours,
    queues: { capture, distillation: distillationQueue, recentFailures },
    distillation,
    audit,
    worker,
  };
}

export async function getContextCaptureQueueDepth(workspaceId: string): Promise<number> {
  try {
    const row = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM pgboss.job
        WHERE name = 'context:capture'
          AND (data->>'workspaceId' = $1 OR data->'data'->>'workspaceId' = $1)
          AND state IN ('created', 'retry', 'active')`,
      [workspaceId],
    );
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}
