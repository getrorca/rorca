/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * run-watchdog.ts — unattended run-level auto-heal for repairable terminal failures.
 *
 * Story-level retries are automatic; a whole-run failure is terminal by design
 * (operator-gated). For unattended overnight execution, this watchdog performs
 * the SAME governed retry an operator would: retry preview -> exact packet ->
 * execute, through the canonical API. It never bypasses a gate — it is the
 * configured operator automation.
 *
 * Guards:
 * - Only repairable failure classes: story timeouts, engine interruption,
 *   egress/transport failures. Never retries policy denials, sandbox refusals,
 *   or protected runs.
 * - Max 1 auto-retry per run (tracked in a local state file).
 * - Only runs newer than 12h, only failed runs, only runs with a spec path.
 * - Dry-run mode for operators: DRY_RUN=1 logs what would retry.
 *
 * Env:
 *   RORCA_WATCHDOG_ENABLED=1            (required)
 *   RORCA_API_BASE (default http://127.0.0.1:3030)
 *   RORCA_WATCHDOG_POLL_SECONDS (default 120)
 *   RORCA_WATCHDOG_MAX_RETRIES (default 1)
 *   DRY_RUN=1                          (optional, logs only)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ENABLED = String(process.env.RORCA_WATCHDOG_ENABLED ?? '').trim().toLowerCase();
if (!['1', 'true', 'yes'].includes(ENABLED)) {
  console.log('[run-watchdog] disabled (RORCA_WATCHDOG_ENABLED not set) — exiting');
  process.exit(0);
}

const API_BASE = process.env.RORCA_API_BASE ?? 'http://127.0.0.1:3030';
const POLL_SECONDS = Math.max(30, parseInt(process.env.RORCA_WATCHDOG_POLL_SECONDS ?? '120', 10));
const MAX_RETRIES = Math.max(1, parseInt(process.env.RORCA_WATCHDOG_MAX_RETRIES ?? '1', 10));
const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN ?? '').trim().toLowerCase());
const STATE_FILE = process.env.RORCA_WATCHDOG_STATE_FILE ?? path.join(os.tmpdir(), 'rorca-run-watchdog-state.json');

const REPAIRABLE = [
  'timeout',
  'engine_interrupted',
  'engine_exit_observed',
  'egress',
  'dispatch',
];

function classify(summary: string): boolean {
  const text = summary.toLowerCase();
  // Explicit non-repairable classes never match a repairable substring.
  if (/(policy|sandbox|not_qualified|unsupported|denied|forbidden|invalid)/.test(text)) return false;
  return REPAIRABLE.some((token) => text.includes(token));
}

interface State { retried: Record<string, number>; }

function loadState(): State {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State; } catch { return { retried: {} }; }
}
function saveState(state: State): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function api(pathname: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function listFailedRuns(): Promise<Array<{ id: number; spec_path: string; workspace_id: string; summary: string }>> {
  // The runs list endpoint is workspace-scoped; scan workspaces for failed runs.
  const workspaces = await api('/api/workspaces');
  const items = (workspaces.body as { items?: Array<{ id: string }> })?.items ?? [];
  const runs: Array<{ id: number; spec_path: string; workspace_id: string; summary: string }> = [];
  for (const workspace of items) {
    const list = await api(`/api/pipeline/runs?workspaceId=${encodeURIComponent(workspace.id)}&limit=20`);
    const rows = (list.body as { runs?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>) ?? [];
    const array = Array.isArray(rows) ? rows : (rows as { runs?: Array<Record<string, unknown>> }).runs ?? [];
    for (const row of array) {
      const status = String(row.status ?? '');
      if (status !== 'failed') continue;
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const specPath = String(row.spec_path ?? '');
      if (!specPath) continue;
      const finishedAt = String(row.finished_at ?? '');
      if (finishedAt && Date.now() - new Date(finishedAt).getTime() > 12 * 3600_000) continue;
      runs.push({
        id,
        spec_path: specPath,
        workspace_id: workspace.id,
        summary: String((row as Record<string, unknown>).summary ?? row.lifecycle_diagnostics ?? ''),
      });
    }
  }
  return runs;
}

async function retryRun(runId: number, _workspaceId: string): Promise<string> {
  const previewResponse = await api(`/api/pipeline/runs/${runId}/retry`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `watchdog-retry-${runId}-${Date.now()}` },
    body: JSON.stringify({}),
  });
  const preview = previewResponse.body as {
    preview?: Record<string, unknown>; previewIdentity?: Record<string, unknown>; error?: string;
  };
  if (previewResponse.status !== 200 || !preview.preview || !preview.previewIdentity) {
    return `preview_failed:${String(preview.error ?? previewResponse.status)}`;
  }
  if (preview.preview.requiresApproval === true) {
    return 'preview_requires_operator_approval';
  }
  const execute = await api(`/api/pipeline/runs/${runId}/retry`, {
    method: 'POST',
    headers: { 'Idempotency-Key': `watchdog-execute-${runId}-${Date.now()}` },
    body: JSON.stringify({
      previewHash: preview.preview.previewHash,
      approvedPreview: preview.preview,
      previewIdentity: preview.previewIdentity,
    }),
  });
  const executed = execute.body as { retryRunId?: number; error?: string; ok?: boolean };
  if (execute.status !== 200 || executed.ok !== true) {
    return `execute_failed:${String(executed.error ?? execute.status)}`;
  }
  return `retried:${executed.retryRunId ?? '?'}`;
}

async function tick(): Promise<void> {
  const state = loadState();
  try {
    const failed = await listFailedRuns();
    for (const run of failed) {
      const attempts = state.retried[String(run.id)] ?? 0;
      if (attempts >= MAX_RETRIES) continue;
      if (!classify(run.summary)) {
        console.log(`[run-watchdog] run ${run.id} not repairable: ${run.summary.slice(0, 120)}`);
        continue;
      }
      if (DRY_RUN) {
        console.log(`[run-watchdog][dry-run] would retry run ${run.id} (${run.spec_path})`);
        continue;
      }
      console.log(`[run-watchdog] auto-retrying run ${run.id} (attempt ${attempts + 1}/${MAX_RETRIES})`);
      const outcome = await retryRun(run.id, run.workspace_id);
      state.retried[String(run.id)] = attempts + 1;
      console.log(`[run-watchdog] run ${run.id} -> ${outcome}`);
    }
    saveState(state);
  } catch (error) {
    console.error(`[run-watchdog] tick failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  console.log(`[run-watchdog] started (poll ${POLL_SECONDS}s, max retries ${MAX_RETRIES}, dry-run ${DRY_RUN})`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await tick();
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, POLL_SECONDS * 1000);
    await promise;
  }
}

void main();
