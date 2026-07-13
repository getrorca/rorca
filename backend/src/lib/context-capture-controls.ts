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

export async function drainContextCaptureQueue(workspaceId: string): Promise<number> {
  try {
    const result = await execute(
      `DELETE FROM pgboss.job
        WHERE name = 'context:capture'
          AND (data->>'workspaceId' = $1 OR data->'data'->>'workspaceId' = $1)
          AND state IN ('created', 'retry')`,
      [workspaceId],
    );
    return result.rowCount;
  } catch {
    return 0;
  }
}
