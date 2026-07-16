/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type { SpecReadinessPayload } from '../lib/specReadiness';
import {
  normalizePipelineRunDetailResponse,
  normalizePipelineRunListResponse,
  type RunEngineWireFields,
} from './run-dto';
import type {
  ApiOptions,
  PaginatedResponse,
  PipelineRun,
  StoryResult,
} from './types';

// ─── Trigger ──────────────────────────────────────────────────────────────────

export type TerminalMode = NonNullable<PipelineRun['terminal_mode']>;

export interface TriggerParams extends ApiOptions {
  specPath: string;
  workspaceId: string;
  autoWorktree?: boolean;
  autoMerge?: boolean;
  mergeStrategy?: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
  dryRun?: boolean;
  storyId?: string;
  forceSequential?: boolean;
  terminal_mode?: TerminalMode;
}

export interface CapabilityWarning {
  storyId: string;
  storyTitle: string;
  engine: string;
  missingTools: string[];
  warnings: string[];
}

type TriggerTerminalFields = {
  terminalMode?: TerminalMode;
  terminal_mode?: TerminalMode;
};

export type TriggerResponse =
  | ({ ok: true; runId: number; worktreePath?: string; branchName?: string; capabilityWarnings?: CapabilityWarning[]; capabilityMismatchMode?: string; specReadiness?: SpecReadinessPayload } & TriggerTerminalFields)
  | { dryRun: true; estimate: unknown }
  | { conflict: true; activeRunId: number }
  | ({ queued: true; runId: number; position: number; queuePosition?: number; specReadiness?: SpecReadinessPayload } & TriggerTerminalFields);

export function triggerPipeline(p: TriggerParams): Promise<TriggerResponse> {
  return apiFetch('/api/pipeline/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      specPath: p.specPath,
      workspaceId: p.workspaceId,
      autoWorktree: p.autoWorktree,
      autoMerge: p.autoMerge,
      mergeStrategy: p.mergeStrategy,
      dryRun: p.dryRun,
      storyId: p.storyId,
      forceSequential: p.forceSequential,
      terminal_mode: p.terminal_mode,
    }),
    signal: p.signal,
  });
}

// ─── Preflight ────────────────────────────────────────────────────────────────

export interface PreflightResponse {
  compatible: boolean;
  mismatchMode: 'warn' | 'reroute' | 'block';
  engine: string;
  stories: CapabilityWarning[];
}

export function preflightCheck(p: { specPath: string; workspaceId: string; signal?: AbortSignal }): Promise<PreflightResponse> {
  return apiFetch('/api/pipeline/preflight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ specPath: p.specPath, workspaceId: p.workspaceId }),
    signal: p.signal,
  });
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export interface ListRunsParams extends ApiOptions {
  workspaceId: string;
  limit?: number;
  cursor?: string;
}

type PipelineRunWire = Omit<PipelineRun, 'agentType' | 'agentModel'> & RunEngineWireFields;

export async function listRuns(p: ListRunsParams): Promise<PaginatedResponse<PipelineRun>> {
  const qs = new URLSearchParams({ workspaceId: p.workspaceId });
  if (p.limit) qs.set('limit', String(p.limit));
  if (p.cursor) qs.set('cursor', p.cursor);
  const response = await apiFetch<PaginatedResponse<PipelineRunWire>>(`/api/pipeline/runs?${qs}`, { signal: p.signal });
  return normalizePipelineRunListResponse(response);
}

export async function getRun(
  runId: number,
  opts?: ApiOptions,
): Promise<{ run: PipelineRun; stories: StoryResult[] }> {
  const response = await apiFetch<RunEngineWireFields & { run: PipelineRunWire; stories: StoryResult[] }>(
    `/api/pipeline/runs/${runId}`,
    { signal: opts?.signal },
  );
  return normalizePipelineRunDetailResponse(response);
}

export function pauseRun(
  runId: number,
  opts?: ApiOptions,
): Promise<{ ok: true; runId: number; status: 'paused' }> {
  return apiFetch(`/api/pipeline/runs/${runId}/pause`, {
    method: 'POST',
    signal: opts?.signal,
  });
}

export function resumeRun(
  runId: number,
  opts?: ApiOptions,
): Promise<{ ok: true; runId: number; status: 'running' }> {
  return apiFetch(`/api/pipeline/runs/${runId}/resume`, {
    method: 'POST',
    signal: opts?.signal,
  });
}

export function retryRun(
  runId: number,
  body?: { storyIds?: string[]; workspaceId?: string },
  opts?: ApiOptions,
): Promise<{ ok: true; runId: number; originalRunId: number; retriedStories: string[]; copiedStories: string[] }> {
  return apiFetch(`/api/pipeline/runs/${runId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: opts?.signal,
  });
}

export function injectContext(
  runId: number,
  context: string,
  opts?: ApiOptions,
): Promise<{ ok: true; runId: number; status: 'running' }> {
  return apiFetch(`/api/pipeline/runs/${runId}/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context }),
    signal: opts?.signal,
  });
}

export function cancelRun(
  runId: number,
  opts?: ApiOptions,
): Promise<{ ok: true; runId: number; status: 'cancelled' }> {
  return apiFetch(`/api/pipeline/runs/${runId}/cancel`, {
    method: 'POST',
    signal: opts?.signal,
  });
}

export function deleteRun(
  runId: number,
  opts?: ApiOptions,
): Promise<{ ok: true; runId: number }> {
  return apiFetch(`/api/pipeline/runs/${runId}`, {
    method: 'DELETE',
    signal: opts?.signal,
  });
}

// ─── Compare runs ─────────────────────────────────────────────────────────────

export interface CompareRunsParams extends ApiOptions {
  run1: number;
  run2: number;
}

export function compareRuns(
  p: CompareRunsParams,
): Promise<{
  run1: PipelineRun;
  run2: PipelineRun;
  stories: unknown[];
  summary: { run1PassRate: number; run2PassRate: number };
}> {
  return apiFetch(`/api/pipeline/runs/compare?run1=${p.run1}&run2=${p.run2}`, {
    signal: p.signal,
  });
}

// ─── Story output ─────────────────────────────────────────────────────────────

export interface StoryOutput {
  storyId: string;
  runId: number;
  status: string;
  retries: number;
  failureReason: string | null;
  failureAttempts: number | null;
  blockedBy: string[] | null;
  output: string[];
  lineCount: number;
}

export function fetchStoryOutput(
  runId: number,
  storyId: string,
  lines?: number,
  opts?: ApiOptions,
): Promise<StoryOutput> {
  const qs = lines ? `?lines=${lines}` : '';
  return apiFetch(`/api/pipeline/runs/${runId}/stories/${storyId}/output${qs}`, {
    signal: opts?.signal,
  });
}

// ─── DLQ ──────────────────────────────────────────────────────────────────────

export interface DlqEntry {
  jobId: string;
  lastError: string | null;
  attempts: number;
  failedAt: string;
  originalPayload: unknown;
}

export function getRunDlq(
  runId: number,
  opts?: ApiOptions,
): Promise<DlqEntry> {
  return apiFetch(`/api/pipeline/runs/${runId}/dlq`, { signal: opts?.signal, silent: true });
}

export function retryRunFromDlq(
  runId: number,
  opts?: ApiOptions,
): Promise<{ ok: true; runId: number; originalRunId: number; jobId: string }> {
  return apiFetch(`/api/pipeline/runs/${runId}/dlq/retry`, {
    method: 'POST',
    signal: opts?.signal,
  });
}

// ─── Token tracking ───────────────────────────────────────────────────────────

export function reportStoryTokens(
  runId: number,
  storyId: string,
  tokens: { inputTokens: number; outputTokens: number },
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch(`/api/pipeline/runs/${runId}/stories/${storyId}/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokens),
    signal: opts?.signal,
  });
}
