/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * run-findings.ts — US-009: Run findings feed-forward (Rorca operational authority)
 *
 * At run completion, derives a structured findings record — decisions made,
 * deviations from spec, discovered risks, and new conventions — from the same
 * persisted evidence the story-result derivation uses (story_results, WAL
 * events, run memories). Findings are persisted with the run as CAPTURE
 * CANDIDATES: they feed the existing run memory synthesis path (surfacing in
 * L2/L3/MEMORY.md on the next run) and are visible for explicit Genesis
 * capture, but nothing in this module — or anywhere else — auto-promotes them.
 *
 * Derivation is deterministic and idempotent: re-running it on the same run
 * produces the same finding keys and inserts nothing new.
 */

import { query, queryOne, execute } from '../db/index';
import { broadcastAll } from './sse-hub';
import { logger } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export const RUN_FINDING_KINDS = ['decision', 'deviation', 'risk', 'convention'] as const;
export type RunFindingKind = (typeof RUN_FINDING_KINDS)[number];

export const RUN_FINDING_STATUSES = ['capture_candidate', 'captured', 'dismissed'] as const;
export type RunFindingStatus = (typeof RUN_FINDING_STATUSES)[number];

/** A single evidence reference backing a finding (bounded, stable identity). */
export interface RunFindingEvidence {
  /** Evidence source kind, e.g. wal_event | story_result | memory | run_status. */
  kind: string;
  /** Stable reference into the evidence source, e.g. wal:story_failed:US-001. */
  reference: string;
  /** Optional short detail (bounded). */
  detail?: string;
}

/** Structured finding derived from a completed run. */
export interface RunFinding {
  findingKey: string;
  kind: RunFindingKind;
  title: string;
  detail: string;
  evidence: RunFindingEvidence[];
}

/** Finding as persisted with the run. */
export interface PersistedRunFinding extends RunFinding {
  id: number;
  status: RunFindingStatus;
  capturedAt: string | null;
  createdAt: string;
}

export const RUN_FINDINGS_SCHEMA_VERSION = 'rorca.run-findings.v1' as const;

export interface DeriveRunFindingsResult {
  ok: boolean;
  findings: RunFinding[];
  inserted: number;
  error?: string;
}

// ─── Evidence row shapes ────────────────────────────────────────────────────

interface PipelineRunRow {
  id: number;
  workspace_id: string;
  status: string;
}

interface StoryResultRow {
  story_id: string;
  status: string;
  retries: number;
}

interface WalEventRow {
  id: number;
  event_type: string;
  story_id: string | null;
  payload: string | null;
}

interface RunMemoryRow {
  id: number;
  category: string;
  content: string;
}

// ─── Derivation ─────────────────────────────────────────────────────────────

/** Run_finished reasons that indicate an operational hazard worth remembering. */
const RUN_LEVEL_RISK_REASONS: Record<string, true> = {
  worker_crash_recovery: true,
  state_reconciliation: true,
  orphan_sweep: true,
  pre_run_hook_failed: true,
  wave_parallel_policy_denied: true,
};

/** Memory categories that map directly onto finding kinds. */
const MEMORY_CATEGORY_TO_FINDING_KIND: Record<string, RunFindingKind> = {
  Decision: 'decision',
  Convention: 'convention',
};

function safePayload(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function boundString(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, max);
}

/**
 * Deterministically derive structured findings for a completed run from
 * persisted evidence only. Never calls an LLM and never promotes anything.
 */
export async function deriveRunFindings(
  runId: number,
  workspaceId: string,
): Promise<RunFinding[]> {
  const run = await queryOne<PipelineRunRow>(
    'SELECT id, workspace_id, status FROM pipeline_runs WHERE id = $1',
    [runId],
  );
  if (!run || run.workspace_id !== workspaceId) return [];

  const findings: RunFinding[] = [];

  // ── Story-level deviations ─────────────────────────────────────────────
  const storyResults = await query<StoryResultRow>(
    `SELECT story_id, status, retries FROM story_results WHERE run_id = $1 ORDER BY id ASC`,
    [runId],
  );

  const failedStories = storyResults.filter(
    (story) => story.status === 'fail' || story.status === 'timeout',
  );
  if (failedStories.length > 0) {
    const failedEvents = await query<WalEventRow>(
      `SELECT id, event_type, story_id, payload FROM wal_events
        WHERE workspace_id = $1 AND event_type = 'story_failed'
          AND payload LIKE $2
        ORDER BY id ASC LIMIT 200`,
      [workspaceId, `%"run_id":${runId}%`],
    );
    const reasonByStory = new Map<string, string>();
    for (const event of failedEvents) {
      if (!event.story_id || reasonByStory.has(event.story_id)) continue;
      const payload = safePayload(event.payload);
      const reason = boundString(payload?.reason, 120);
      reasonByStory.set(event.story_id, reason || 'unknown');
    }
    for (const story of failedStories) {
      const reason = reasonByStory.get(story.story_id) ?? 'unknown';
      findings.push({
        findingKey: `deviation:story:${story.story_id}`,
        kind: 'deviation',
        title: `Story ${story.story_id} deviated from spec (${story.status})`,
        detail: `Story ${story.story_id} ended with status '${story.status}' instead of 'pass' (reason: ${reason}).`,
        evidence: [
          { kind: 'story_result', reference: `story_result:${story.story_id}`, detail: story.status },
          { kind: 'wal_event', reference: `wal:story_failed:${story.story_id}`, detail: reason },
        ],
      });
    }
  }

  // Skipped stories are deviations too (blocked or excluded from execution).
  const skippedStories = storyResults.filter((story) => story.status === 'skip' || story.status === 'excluded');
  for (const story of skippedStories) {
    findings.push({
      findingKey: `deviation:skip:${story.story_id}`,
      kind: 'deviation',
      title: `Story ${story.story_id} was skipped (${story.status})`,
      detail: `Story ${story.story_id} was not executed to completion (status '${story.status}').`,
      evidence: [{ kind: 'story_result', reference: `story_result:${story.story_id}`, detail: story.status }],
    });
  }

  // ── Run-level deviation when the run itself did not complete cleanly ───
  if (run.status !== 'done' && run.status !== 'cancelled') {
    findings.push({
      findingKey: `deviation:run:${run.status}`,
      kind: 'deviation',
      title: `Run ended with status '${run.status}' instead of 'done'`,
      detail: `The run closed with status '${run.status}'; story-level findings capture the per-story deviations.`,
      evidence: [{ kind: 'run_status', reference: `run:${runId}`, detail: run.status }],
    });
  }

  // ── Risks from operational evidence ────────────────────────────────────
  const walEvents = await query<WalEventRow>(
    `SELECT id, event_type, story_id, payload FROM wal_events
      WHERE workspace_id = $1 AND payload LIKE $2
      ORDER BY id ASC LIMIT 300`,
    [workspaceId, `%"run_id":${runId}%`],
  );

  for (const event of walEvents) {
    if (event.event_type === 'story_escalated') {
      const payload = safePayload(event.payload);
      const fromModel = boundString(payload?.fromModel, 80);
      const toModel = boundString(payload?.toModel, 80);
      if (fromModel && toModel) {
        findings.push({
          findingKey: `risk:escalation:wal:${event.id}`,
          kind: 'risk',
          title: `Model escalation ${fromModel} -> ${toModel} for ${event.story_id ?? 'unknown'}`,
          detail: `Story ${event.story_id ?? 'unknown'} required escalation from ${fromModel} to ${toModel}.`,
          evidence: [{ kind: 'wal_event', reference: `wal:${event.id}`, detail: `${fromModel} -> ${toModel}` }],
        });
      }
    } else if (event.event_type === 'run_finished') {
      const payload = safePayload(event.payload);
      const reason = boundString(payload?.reason, 120);
      const status = boundString(payload?.status, 40);
      if (reason && RUN_LEVEL_RISK_REASONS[reason]) {
        findings.push({
          findingKey: `risk:run_finished:${reason}`,
          kind: 'risk',
          title: `Run closed through recovery path (${reason})`,
          detail: `run_finished was emitted with reason '${reason}' (status '${status || run.status}') — an operational hazard for future runs.`,
          evidence: [{ kind: 'wal_event', reference: `wal:${event.id}`, detail: reason }],
        });
      }
    }
  }

  // Flaky stories (passed only after retries) are a discovered risk.
  const flakyStories = storyResults.filter((story) => story.status === 'pass' && story.retries > 0);
  for (const story of flakyStories) {
    findings.push({
      findingKey: `risk:flaky:${story.story_id}`,
      kind: 'risk',
      title: `Story ${story.story_id} passed only after ${story.retries} retr${story.retries === 1 ? 'y' : 'ies'}`,
      detail: `Story ${story.story_id} eventually passed after ${story.retries} retries — flaky execution is a risk for future runs.`,
      evidence: [
        { kind: 'story_result', reference: `story_result:${story.story_id}`, detail: `retries=${story.retries}` },
      ],
    });
  }

  // ── Decisions and conventions captured as run memories ─────────────────
  const runMemories = await query<RunMemoryRow>(
    `SELECT id, category, content FROM memories
      WHERE source_run_id = $1 AND deleted_at IS NULL
        AND category IN ('Decision', 'Convention')
      ORDER BY id ASC LIMIT 100`,
    [runId],
  );
  for (const memory of runMemories) {
    const kind = MEMORY_CATEGORY_TO_FINDING_KIND[memory.category];
    if (!kind) continue;
    const content = memory.content.length > 500 ? `${memory.content.slice(0, 499)}…` : memory.content;
    const title = content.split('\n')[0].slice(0, 140) || `${memory.category} captured during the run`;
    findings.push({
      findingKey: `${kind}:memory:${memory.id}`,
      kind,
      title: `${memory.category}: ${title}`,
      detail: content,
      evidence: [{ kind: 'memory', reference: `memory:${memory.id}`, detail: memory.category }],
    });
  }

  return findings;
}

// ─── Persistence ────────────────────────────────────────────────────────────

/**
 * Persist findings with the run. Idempotent: finding keys are stable, so
 * re-deriving the same run inserts nothing. Status is always left as the
 * default 'capture_candidate' — nothing in this path captures or promotes.
 */
export async function persistRunFindings(
  runId: number,
  workspaceId: string,
  findings: RunFinding[],
): Promise<number> {
  if (findings.length === 0) return 0;
  const result = await execute(
    `INSERT INTO run_findings (run_id, workspace_id, finding_key, kind, title, detail, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (run_id, finding_key) DO NOTHING`,
    findings.map((finding) => [
      runId,
      workspaceId,
      finding.findingKey,
      finding.kind,
      finding.title,
      finding.detail,
      JSON.stringify(finding.evidence),
    ]),
  );
  return result.rowCount;
}

/**
 * Load the findings persisted with a run (capture candidates and any
 * explicitly captured/dismissed rows), oldest first.
 */
export async function loadRunFindings(
  runId: number,
  workspaceId: string,
): Promise<PersistedRunFinding[]> {
  const rows = await query<{
    id: number;
    finding_key: string;
    kind: RunFindingKind;
    title: string;
    detail: string;
    evidence: Array<{ kind: string; reference: string; detail?: string }>;
    status: RunFindingStatus;
    captured_at: string | Date | null;
    created_at: string | Date;
  }>(
    `SELECT id, finding_key, kind, title, detail, evidence, status, captured_at, created_at
       FROM run_findings
      WHERE run_id = $1 AND workspace_id = $2
      ORDER BY id ASC LIMIT 500`,
    [runId, workspaceId],
  );
  return rows.map((row) => ({
    id: row.id,
    findingKey: row.finding_key,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
    status: row.status,
    capturedAt: row.captured_at ? new Date(row.captured_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/**
 * Derive + persist findings for a completed run and emit a bounded
 * `run_findings` WAL event. The event is emitted only when new rows were
 * actually inserted, keeping re-derivation silent.
 */
export async function deriveAndPersistRunFindings(
  runId: number,
  workspaceId: string,
): Promise<DeriveRunFindingsResult> {
  const findings = await deriveRunFindings(runId, workspaceId);
  const inserted = await persistRunFindings(runId, workspaceId, findings);
  if (inserted > 0) {
    const payload = JSON.stringify({
      run_id: runId,
      workspace_id: workspaceId,
      finding_count: findings.length,
      inserted,
      status: 'capture_candidate',
    });
    const walRow = await queryOne<{ id: number }>(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_findings', $1, $2) RETURNING id`,
      [workspaceId, payload],
    ).catch(() => undefined);
    if (walRow) {
      broadcastAll({
        id: walRow.id,
        ts: new Date().toISOString(),
        event_type: 'run_findings',
        workspace_id: workspaceId,
        spec_id: null,
        story_id: null,
        actor: 'system',
        payload,
      });
    }
  }
  return { ok: true, findings, inserted };
}

/**
 * Non-fatal wrapper for the worker closeout path. Run findings are
 * non-authoritative: a failure here must never regress a durable terminal
 * decision, so every error is caught and reported instead of thrown.
 */
export async function tryDeriveAndPersistRunFindings(
  runId: number,
  workspaceId: string,
): Promise<DeriveRunFindingsResult> {
  try {
    return await deriveAndPersistRunFindings(runId, workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[run-findings] Derivation failed for run #${runId}: ${message}`);
    return { ok: false, findings: [], inserted: 0, error: message };
  }
}
