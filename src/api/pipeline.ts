import { apiFetch } from '../lib/apiFetch';
import type {
  ApiOptions,
  PaginatedResponse,
  PipelineRun,
  StoryResult,
} from './types';

// ─── Trigger ──────────────────────────────────────────────────────────────────

export interface TriggerParams extends ApiOptions {
  specPath: string;
  workspaceId: string;
  autoWorktree?: boolean;
  dryRun?: boolean;
  storyId?: string;
}

export type TriggerResponse =
  | { ok: true; runId: number; worktreePath?: string; branchName?: string }
  | { dryRun: true; estimate: unknown }
  | { conflict: true; activeRunId: number };

export function triggerPipeline(p: TriggerParams): Promise<TriggerResponse> {
  return apiFetch('/api/pipeline/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      specPath: p.specPath,
      workspaceId: p.workspaceId,
      autoWorktree: p.autoWorktree,
      dryRun: p.dryRun,
      storyId: p.storyId,
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

export function listRuns(p: ListRunsParams): Promise<PaginatedResponse<PipelineRun>> {
  const qs = new URLSearchParams({ workspaceId: p.workspaceId });
  if (p.limit) qs.set('limit', String(p.limit));
  if (p.cursor) qs.set('cursor', p.cursor);
  return apiFetch(`/api/pipeline/runs?${qs}`, { signal: p.signal });
}

export function getRun(
  runId: number,
  opts?: ApiOptions,
): Promise<{ run: PipelineRun; stories: StoryResult[] }> {
  return apiFetch(`/api/pipeline/runs/${runId}`, { signal: opts?.signal });
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
