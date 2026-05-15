/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
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

export interface GenerateSpecParams extends ApiOptions {
  brief: string;
  workspaceId: string;
  model?: string;
  templateId?: string;
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

export function approveSpec(
  specId: string,
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ ok: true; approvedPath: string }> {
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
