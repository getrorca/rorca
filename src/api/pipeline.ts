/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import {
  ExecutionReceiptV1Schema,
  type EffectiveExecutionOptionsV1,
  type EntityRefV1,
  type ExecutionReceiptV1,
} from '../../shared/contracts/mission';
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
  agentOverride?: 'omp' | 'pi' | 'claude' | 'opencode' | 'codex';
  autoWorktree?: boolean;
  autoMerge?: boolean;
  mergeStrategy?: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
  dryRun?: boolean;
  storyId?: string;
  forceSequential?: boolean;
  orchestrationMode?: 'sequential' | 'wave-parallel';
  parallelism?: number;
  qualificationReceiptId?: string;
  rolloutCohort?: string;
  includeGraph?: boolean;
  terminal_mode?: TerminalMode;
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  reasoning?: { enabled: boolean; effort?: string };
  executionEnvironment?: string;
  queue?: boolean;
  forceRerun?: boolean;
  rerunFromScratch?: boolean;
  idempotencyKey?: string;
  preview?: ExecutionPreviewV1;
}

export interface ExecutionPreviewV1 {
  schemaVersion: 'rorca.execution-preview.v1';
  previewHash: string;
  expiresAt: string;
  workspaceId: string;
  spec: EntityRefV1;
  specHash: string;
  effectiveOptions: EffectiveExecutionOptionsV1;
  scheduling: 'run' | 'queue';
}

export interface CapabilityWarning {
  storyId: string;
  storyTitle: string;
  engine: string;
  missingTools: string[];
  warnings: string[];
}

type TriggerTerminalFields = {
  agentType?: PipelineRun['agentType'];
  agentModel?: PipelineRun['agentModel'];
  terminalMode?: TerminalMode;
  terminal_mode?: TerminalMode;
  lifecyclePhase?: PipelineRun['lifecyclePhase'];
  lifecycle_phase?: PipelineRun['lifecycle_phase'];
};

export type TriggerResponse =
  | ({ ok?: true; queued?: boolean; runId: number; receipt: ExecutionReceiptV1; worktreePath?: string; branchName?: string; position: number; queuePosition?: number; capabilityWarnings?: CapabilityWarning[]; capabilityMismatchMode?: string; specReadiness?: SpecReadinessPayload } & TriggerTerminalFields)
  | { dryRun: true; estimate: unknown }
  | { conflict: true; activeRunId: number };

/** Every accepted dispatch receipt identifies the exact run operators should inspect. */
export function triggerReceiptRunId(response: TriggerResponse): number | null {
  if ('receipt' in response) {
    const runId = Number(response.receipt.returnedEntity.id);
    return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
  }
  if ('activeRunId' in response && typeof response.activeRunId === 'number') return response.activeRunId;
  return null;
}

function callerIdempotencyKey(workspaceId: string, previewHash: string): string {
  const storageKey = `rorca:execution-idempotency:${workspaceId}:${previewHash}`;
  try {
    const existing = globalThis.sessionStorage?.getItem(storageKey);
    if (existing) return existing;
  } catch {
    // Storage can be unavailable in hardened browser contexts. The key remains
    // stable for the current call and explicit callers may always supply one.
  }
  const created = `mission-trigger:${workspaceId}:${globalThis.crypto.randomUUID()}`;
  try {
    globalThis.sessionStorage?.setItem(storageKey, created);
  } catch {
    // Dispatch remains available when browser storage is unavailable.
  }
  return created;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function triggerPipeline(p: TriggerParams): Promise<TriggerResponse> {
  if (p.dryRun) {
    return apiFetch('/api/pipeline/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        specPath: p.specPath,
        workspaceId: p.workspaceId,
        agentOverride: p.agentOverride,
        dryRun: true,
        effortLevel: p.effortLevel,
        thinkingEnabled: p.thinkingEnabled,
        thinkingBudget: p.thinkingBudget,
        reasoning: p.reasoning,
        executionEnvironment: p.executionEnvironment,
      }),
      signal: p.signal,
    });
  }

  const preview = p.preview ?? (await preflightCheck({
    specPath: p.specPath,
    workspaceId: p.workspaceId,
    agentOverride: p.agentOverride,
    autoWorktree: p.autoWorktree,
    autoMerge: p.autoMerge,
    mergeStrategy: p.mergeStrategy,
    storyId: p.storyId,
    forceSequential: p.forceSequential,
    orchestrationMode: p.orchestrationMode,
    parallelism: p.parallelism,
    includeGraph: p.includeGraph,
    terminal_mode: p.terminal_mode,
    effortLevel: p.effortLevel,
    reasoning: p.reasoning,
    executionEnvironment: p.executionEnvironment,
    queue: p.queue,
    signal: p.signal,
  })).preview;
  const idempotencyKey = p.idempotencyKey ?? callerIdempotencyKey(p.workspaceId, preview.previewHash);
  const response = await apiFetch<unknown>('/api/pipeline/trigger', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify({
      specPath: p.specPath,
      workspaceId: p.workspaceId,
      agentOverride: p.agentOverride,
      autoWorktree: p.autoWorktree ?? true,
      autoMerge: p.autoMerge ?? false,
      mergeStrategy: p.mergeStrategy ?? 'branch-only',
      storyId: p.storyId,
      forceSequential: p.forceSequential,
      orchestrationMode: p.orchestrationMode,
      parallelism: p.parallelism,
      qualificationReceiptId: p.qualificationReceiptId,
      rolloutCohort: p.rolloutCohort,
      includeGraph: p.includeGraph,
      terminal_mode: p.terminal_mode ?? 'ansi-html',
      effortLevel: p.effortLevel,
      thinkingEnabled: p.thinkingEnabled,
      thinkingBudget: p.thinkingBudget,
      reasoning: p.reasoning,
      executionEnvironment: p.executionEnvironment,
      queue: p.queue,
      forceRerun: p.forceRerun,
      rerunFromScratch: p.rerunFromScratch,
      idempotencyKey,
      previewHash: preview.previewHash,
      previewExpiresAt: preview.expiresAt,
    }),
    signal: p.signal,
  });
  if (!isRecord(response)) throw new Error('Pipeline trigger returned an invalid response');
  if ('conflict' in response) return response as TriggerResponse;
  const receipt = ExecutionReceiptV1Schema.parse(response.receipt);
  if (
    receipt.idempotencyKey !== idempotencyKey
    || receipt.previewHash !== preview.previewHash
    || receipt.workspaceId !== p.workspaceId
    || receipt.scheduling !== (p.queue === true ? 'queue' : 'run')
  ) {
    throw new Error('Pipeline trigger receipt does not match the requested preview binding');
  }
  const position = typeof response.position === 'number'
    ? response.position
    : typeof response.queuePosition === 'number'
      ? response.queuePosition
      : 0;
  return { ...response, receipt, position } as TriggerResponse;
}

// ─── Preflight ────────────────────────────────────────────────────────────────

export interface PreflightResponse {
  compatible: boolean;
  mismatchMode: 'warn' | 'reroute' | 'block';
  engine: string;
  stories: CapabilityWarning[];
  preview: ExecutionPreviewV1;
}

export type PreflightParams = Omit<TriggerParams, 'dryRun' | 'idempotencyKey' | 'preview' | 'forceRerun' | 'rerunFromScratch'>;

export function preflightCheck(p: PreflightParams): Promise<PreflightResponse> {
  return apiFetch('/api/pipeline/preflight', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      specPath: p.specPath,
      workspaceId: p.workspaceId,
      agentOverride: p.agentOverride,
      autoWorktree: p.autoWorktree ?? true,
      autoMerge: p.autoMerge ?? false,
      mergeStrategy: p.mergeStrategy ?? 'branch-only',
      queue: p.queue,
      orchestrationMode: p.orchestrationMode,
      parallelism: p.parallelism,
      forceSequential: p.forceSequential,
      storyId: p.storyId,
      includeGraph: p.includeGraph,
      terminal_mode: p.terminal_mode ?? 'ansi-html',
      effortLevel: p.effortLevel,
      reasoning: p.reasoning,
      executionEnvironment: p.executionEnvironment,
    }),
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

export interface RetryPreviewPacket {
  previewHash: string;
  requiresApproval: boolean;
  forceSequential: boolean;
  scope: Record<'requested' | 'requiredDependency' | 'copiedPassed' | 'skipped' | 'executable' | 'remaining' | 'excluded', Array<{ storyId: string; reasonCode: string }>>;
  [key: string]: unknown;
}

export interface RetryPreviewIdentity {
  schemaVersion: 'retry-preview-identity.v1';
  previewHash: string;
  originalRunId: number;
  expiresAt: string;
  signature: string;
}

export interface RetryPreviewResponse {
  ok: true;
  preview: RetryPreviewPacket;
  previewIdentity: RetryPreviewIdentity;
  worktreePreflight: { classification: string; ok: boolean; detail?: string } | null;
}

export interface RetryRunRequest {
  storyIds?: string[];
  forceSequential?: boolean;
}

export function previewRetry(runId: number, body?: RetryRunRequest, opts?: ApiOptions): Promise<RetryPreviewResponse> {
  return apiFetch(`/api/pipeline/runs/${runId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body ?? {}), safeMode: true }),
    signal: opts?.signal,
  });
}

export async function retryRun(
  runId: number,
  body?: RetryRunRequest,
  opts?: ApiOptions,
): Promise<{ ok: true; runId: number; originalRunId: number; retriedStories: Array<{ storyId: string; attempt: number }>; copiedStories: string[] }> {
  const preview = await previewRetry(runId, body, opts);
  if (preview.preview.requiresApproval) throw new Error('Retry requires explicit operator approval');
  return apiFetch(`/api/pipeline/runs/${runId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(body?.storyIds ? { storyIds: body.storyIds } : {}),
      safeMode: true,
      forceSequential: preview.preview.forceSequential,
      previewHash: preview.preview.previewHash,
      approvedPreview: preview.preview,
      previewIdentity: preview.previewIdentity,
    }),
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
