/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch, BASE_URL } from '../lib/apiFetch';
import type { SpecReadinessPayload } from '../lib/specReadiness';
import type {
  SpecReadinessInspectionPayload,
  SpecWorkflowInspectionPayload,
  WorkflowStageKey,
} from '../lib/specWorkflow';
import type {
  ApiOptions,
  PaginatedResponse,
  ArchiveSpec,
  SpecDetail,
  SpecVersion,
  SpecDiff,
  Story,
  StoryComment,
  DependencyNode,
  DependencyEdge,
} from './types';

// ─── List / Search ────────────────────────────────────────────────────────────

export interface ListSpecsParams extends ApiOptions {
  workspaceId: string;
  status?: 'pending' | 'approved' | 'all';
  limit?: number;
  cursor?: string;
}

export function listSpecs(p: ListSpecsParams): Promise<PaginatedResponse<ArchiveSpec>> {
  const qs = new URLSearchParams({ workspaceId: p.workspaceId });
  if (p.status) qs.set('status', p.status);
  if (p.limit) qs.set('limit', String(p.limit));
  if (p.cursor) qs.set('cursor', p.cursor);
  return apiFetch(`/api/specs?${qs}`, { signal: p.signal });
}

export interface SearchArchiveParams extends ApiOptions {
  workspaceId: string;
  q?: string;
  status?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
}

export function searchArchive(p: SearchArchiveParams): Promise<PaginatedResponse<ArchiveSpec>> {
  const qs = new URLSearchParams({ workspaceId: p.workspaceId });
  if (p.q) qs.set('q', p.q);
  if (p.status) qs.set('status', p.status);
  if (p.tag) qs.set('tag', p.tag);
  if (p.limit) qs.set('limit', String(p.limit));
  if (p.cursor) qs.set('cursor', p.cursor);
  return apiFetch(`/api/specs/archive?${qs}`, { signal: p.signal });
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function getSpec(
  specId: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<SpecDetail> {
  return apiFetch(`/api/specs/${specId}?workspaceId=${workspaceId}`, { signal: opts?.signal });
}

export function getSpecWorkflow(
  specId: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<SpecWorkflowInspectionPayload> {
  return apiFetch(`/api/specs/${specId}/workflow?workspaceId=${workspaceId}`, { signal: opts?.signal });
}

export function getSpecReadinessInspection(
  specId: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<SpecReadinessInspectionPayload> {
  return apiFetch(`/api/specs/${specId}/readiness?workspaceId=${workspaceId}`, { signal: opts?.signal });
}

export interface RetrySpecWorkflowStageResult {
  requestedStageKey: WorkflowStageKey;
  requestedPolicy?: unknown;
  reasonCodes: string[];
  workflow?: SpecWorkflowInspectionPayload;
  readiness?: SpecReadinessInspectionPayload;
  actions: Array<Record<string, unknown>>;
}

export function retrySpecWorkflowStage(
  specId: string,
  stageKey: WorkflowStageKey,
  body: {
    workspaceId: string;
    dryRun?: boolean;
    policyPresetId?: string;
    postSavePolicy?: unknown;
  },
  opts?: ApiOptions,
): Promise<RetrySpecWorkflowStageResult> {
  return apiFetch(`/api/specs/${specId}/workflow/stages/${stageKey}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

export interface CreateSpecParams extends ApiOptions {
  workspaceId: string;
  title: string;
  stories: Story[];
  slug?: string;
  brief?: string;
  specBrief?: string;
  storyPrefix?: string;
  overwrite?: boolean;
  source?: string;
  diagrams?: Record<string, { mermaid: string; ascii: string }>;
  mermaidDiagram?: string;
  model?: string;
  contextUsed?: unknown;
  contextSummary?: Record<string, unknown>;
  reasoning?: { enabled: boolean; effort?: string };
  postSave?: boolean | string | Record<string, unknown>;
  policyPresetId?: string;
  postSavePolicy?: unknown;
}

export interface CreateSpecResult {
  id: string;
  slug: string;
  title: string;
  status: 'pending';
  source: string;
  stories: Story[];
  postSave: {
    enrich: boolean;
    matchSkills: boolean;
    memorySynthesis: boolean;
  };
  postSavePolicy: Record<string, unknown>;
  requestedPolicy?: unknown;
  workflow: {
    engine: 'spec-post-save-v1';
    runId: number;
    status: string;
    saveGeneration: number | null;
  };
  contextSummary?: Record<string, unknown>;
}

export function createSpec(
  p: CreateSpecParams,
): Promise<CreateSpecResult> {
  return apiFetch('/api/specs/persist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: p.workspaceId,
      title: p.title,
      stories: p.stories,
      slug: p.slug,
      brief: p.brief,
      specBrief: p.specBrief,
      storyPrefix: p.storyPrefix,
      overwrite: p.overwrite,
      source: p.source,
      diagrams: p.diagrams,
      mermaidDiagram: p.mermaidDiagram,
      model: p.model,
      contextUsed: p.contextUsed,
      contextSummary: p.contextSummary,
      reasoning: p.reasoning,
      postSave: p.postSave,
      policyPresetId: p.policyPresetId,
      postSavePolicy: p.postSavePolicy,
    }),
    signal: p.signal,
  });
}

export const persistSpec = createSpec;

export interface GenerateSpecParams extends ApiOptions {
  brief: string;
  workspaceId: string;
  model?: string;
  templateId?: string;
}

export interface ForgeSpecParams extends ApiOptions {
  brief: string;
  workspaceId: string;
  model?: string;
  templateId?: string;
  title?: string;
  storyCount?: number;
  agentOverride?: 'claude' | 'opencode' | 'codex' | 'pi';
  reasoning?: { enabled: boolean; effort?: string };
  postSave?: { enrich?: boolean; matchSkills?: boolean; memorySynthesis?: boolean };
}

export interface ForgeSpecResult {
  slug: string;
  title: string;
  stories: Story[];
  provider?: string;
  model?: string | null;
  contextUsed?: unknown;
  contextSummary?: unknown;
}

export interface ForgeBatchSpecItem {
  brief: string;
  workspaceId: string;
  title?: string;
  templateId?: string;
  model?: string;
  storyCount?: number;
  domain?: string;
  agentOverride?: 'claude' | 'opencode' | 'codex' | 'pi';
  reasoning?: { enabled: boolean; effort?: string };
  postSave?: { enrich?: boolean; matchSkills?: boolean; memorySynthesis?: boolean };
}

export interface ForgeBatchSpecResult {
  batchId: string;
  briefCount: number;
}

export interface SpecGenerationContextParams extends ApiOptions {
  brief: string;
  workspaceId: string;
  model?: string;
  templateId?: string;
  title?: string;
  storyCount?: number;
  agentOverride?: 'claude' | 'opencode' | 'codex' | 'pi';
  reasoning?: { enabled: boolean; effort?: string };
}

export function generateSpec(
  p: GenerateSpecParams,
): Promise<{ slug: string; title: string; stories: Story[] }> {
  return apiFetch('/api/specs/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief: p.brief,
      workspaceId: p.workspaceId,
      model: p.model,
      templateId: p.templateId,
      agentOverride: 'pi',
    }),
    signal: p.signal,
  });
}

export function forgeSpec(p: ForgeSpecParams): Promise<ForgeSpecResult> {
  return apiFetch('/api/specs/forge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief: p.brief,
      workspaceId: p.workspaceId,
      model: p.model,
      templateId: p.templateId,
      title: p.title,
      storyCount: p.storyCount,
      agentOverride: p.agentOverride,
      reasoning: p.reasoning,
      postSave: p.postSave,
    }),
    signal: p.signal,
  });
}

export function getSpecGenerationContext(p: SpecGenerationContextParams): Promise<Record<string, unknown>> {
  return apiFetch('/api/specs/generation-context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief: p.brief,
      workspaceId: p.workspaceId,
      model: p.model,
      templateId: p.templateId,
      title: p.title,
      storyCount: p.storyCount,
      agentOverride: p.agentOverride,
      reasoning: p.reasoning,
    }),
    signal: p.signal,
  });
}

// ─── Context Preview (US-023) ────────────────────────────────────────────────

export interface ContextPreviewParams extends ApiOptions {
  brief: string;
  workspaceId: string;
  model?: string;
  templateId?: string;
}

export interface ContextPreviewSection {
  key: string;
  section: string;
  label: string;
  reason: string;
  tokenEstimate: number;
  present: boolean;
  details?: string[];
}

export interface ContextPreviewGraphInfo {
  available: boolean;
  vertexCount: number;
  edgeCount: number;
  isStale: boolean;
  staleReason: string | null;
  gitSha: string | null;
  hydratedAt: string | null;
}

export interface ContextPreviewHydrationInfo {
  hint: 'hydrate' | 'rehydrate' | 'wait' | 'configure_hilo' | 'none';
  message: string | null;
  currentStatus: string | null;
}

export interface ContextPreviewResult {
  workspaceId: string;
  brief: string;
  sections: Record<string, ContextPreviewSection[]>;
  totalTokens: number;
  tokenBudget: number;
  modelContextWindow: number;
  warnings: string[];
  graphFreshness: ContextPreviewGraphInfo;
  hydrationAction: ContextPreviewHydrationInfo;
  loadedAt: string;
}

/**
 * Fetch a context preview for a spec brief before generation.
 * Calls the generation-context endpoint to get direction layers, skills,
 * memory, graph, and file information, then enriches it with hydration status.
 */
export function getContextPreview(p: ContextPreviewParams): Promise<ContextPreviewResult> {
  return apiFetch<ContextPreviewResult>('/api/specs/context-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      brief: p.brief,
      workspaceId: p.workspaceId,
      model: p.model,
      templateId: p.templateId,
    }),
    signal: p.signal,
  });
}

export function forgeSpecBatch(items: ForgeBatchSpecItem[], opts?: ApiOptions): Promise<ForgeBatchSpecResult> {
  return apiFetch('/api/specs/forge/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ briefs: items }),
    signal: opts?.signal,
  });
}

export function getForgeBatchStreamUrl(batchId: string): string {
  return `${BASE_URL}/api/specs/forge/batch/${encodeURIComponent(batchId)}/stream`;
}

export function approveSpec(
  specId: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ ok: true; approvedPath: string; readiness: SpecReadinessPayload }> {
  return apiFetch(`/api/specs/${specId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
    signal: opts?.signal,
  });
}

export function rejectSpec(
  specId: string,
  workspaceId: string,
  reason?: string,
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch(`/api/specs/${specId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, reason }),
    signal: opts?.signal,
  });
}

export function addStories(
  specId: string,
  body: { brief: string; workspaceId: string },
  opts?: ApiOptions,
): Promise<{ ok: true; addedCount: number; stories: Story[] }> {
  return apiFetch(`/api/specs/${specId}/add-stories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

// ─── Reviews ──────────────────────────────────────────────────────────────────

export function requestReview(
  specId: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ ok: true; reviewStatus: string }> {
  return apiFetch(`/api/specs/${specId}/request-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
    signal: opts?.signal,
  });
}

export function submitReview(
  specId: string,
  body: { workspaceId: string; decision: string; comment?: string },
  opts?: ApiOptions,
): Promise<{ ok: true; reviewStatus: string }> {
  return apiFetch(`/api/specs/${specId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

// ─── Stories ──────────────────────────────────────────────────────────────────

export function updateStory(
  specId: string,
  storyId: string,
  patch: Partial<Story> & { workspaceId: string },
  opts?: ApiOptions,
): Promise<{ ok: true; story: Story }> {
  return apiFetch(`/api/specs/${specId}/stories/${storyId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: opts?.signal,
  });
}

export function deleteStory(
  specId: string,
  storyId: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ ok: true; deletedStory: string; version: number; remainingCount: number }> {
  return apiFetch(`/api/specs/${specId}/stories/${storyId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
    signal: opts?.signal,
  });
}

// ─── Versions ─────────────────────────────────────────────────────────────────

export function listVersions(
  specId: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ versions: SpecVersion[] }> {
  return apiFetch(`/api/specs/${specId}/versions?workspaceId=${workspaceId}`, {
    signal: opts?.signal,
  });
}

export function diffVersions(
  specId: string,
  v1: number,
  v2: number,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<SpecDiff> {
  return apiFetch(
    `/api/specs/${specId}/diff?v1=${v1}&v2=${v2}&workspaceId=${workspaceId}`,
    { signal: opts?.signal },
  );
}

export function restoreVersion(
  specId: string,
  version: number,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ ok: true; newVersion: number; restoredFromVersion: number }> {
  return apiFetch(`/api/specs/${specId}/versions/${version}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
    signal: opts?.signal,
  });
}

// ─── Dependency Graph ─────────────────────────────────────────────────────────

export function getGraph(
  specId: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ nodes: DependencyNode[]; edges: DependencyEdge[]; parallelGroups: string[][] }> {
  return apiFetch(`/api/specs/${specId}/graph?workspaceId=${workspaceId}`, {
    signal: opts?.signal,
  });
}

export function applyDependencies(
  specId: string,
  body: { workspaceId: string; dependencies: Array<{ from: string; to: string }> },
  opts?: ApiOptions,
): Promise<{ ok: true; appliedCount: number }> {
  return apiFetch(`/api/specs/${specId}/apply-dependencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

// ─── Comments ─────────────────────────────────────────────────────────────────

export function listComments(
  specId: string,
  storyId: string,
  opts?: ApiOptions,
): Promise<{ comments: StoryComment[] }> {
  return apiFetch(`/api/specs/${specId}/stories/${storyId}/comments`, {
    signal: opts?.signal,
  });
}

export function createComment(
  specId: string,
  storyId: string,
  body: { body: string },
  opts?: ApiOptions,
): Promise<{ ok: true; comment: StoryComment }> {
  return apiFetch(`/api/specs/${specId}/stories/${storyId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

export function resolveComment(
  specId: string,
  storyId: string,
  commentId: number,
  opts?: ApiOptions,
): Promise<{ ok: true; comment: StoryComment }> {
  return apiFetch(`/api/specs/${specId}/stories/${storyId}/comments/${commentId}/resolve`, {
    method: 'POST',
    signal: opts?.signal,
  });
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

export function addTag(
  specId: string,
  tag: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ tags: string[] }> {
  return apiFetch(`/api/specs/${specId}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, workspaceId }),
    signal: opts?.signal,
  });
}

export function removeTag(
  specId: string,
  tag: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ tags: string[] }> {
  return apiFetch(`/api/specs/${specId}/tags/${encodeURIComponent(tag)}?workspaceId=${workspaceId}`, {
    method: 'DELETE',
    signal: opts?.signal,
  });
}

export function autocompleteTags(
  query: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ tags: Array<{ name: string; count: number }> }> {
  const qs = new URLSearchParams({ q: query, workspaceId });
  return apiFetch(`/api/specs/tags/autocomplete?${qs}`, { signal: opts?.signal });
}

// ─── Fork ─────────────────────────────────────────────────────────────────────

export function forkSpec(
  specId: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ ok: true; forkId: string; forkedFrom: string }> {
  return apiFetch(`/api/specs/${specId}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
    signal: opts?.signal,
  });
}
