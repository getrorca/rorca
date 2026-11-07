/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type {
  LifecycleAdviceResponse,
  LifecycleDecisionMutationResult,
  LifecycleDecisionState,
  LifecycleEvidenceDetail,
  LifecycleEvidenceListItem,
  LifecycleMutationResult,
  LifecyclePaginated,
  LifecycleRetryDispatchResult,
  LifecycleRetryPreviewResponse,
  LifecyclePaginationRequest,
  LifecyclePhaseId,
  LifecycleSourceArtifactAction,
  LifecycleSourceArtifactOpenResult,
  LifecycleSourceArtifactPreview,
  LifecyclePhaseResponse,
  LifecyclePortfolioFilters,
  LifecyclePortfolioResponse,
  LifecycleSpecResponse,
  RecordLifecycleDecisionInput,
  PreStagingQualificationPreview,
  PreStagingQualificationReceipt,
} from '../types/lifecycle';

export interface LifecycleRequestOptions {
  signal?: AbortSignal;
  silent?: boolean;
}

function queryPath(path: string, values: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function requestInit(options?: LifecycleRequestOptions): RequestInit & { silent?: boolean } {
  return { signal: options?.signal, silent: options?.silent };
}

export function getLifecyclePortfolio(
  workspaceId: string,
  filters: LifecyclePortfolioFilters,
  pagination: LifecyclePaginationRequest = {},
  options?: LifecycleRequestOptions,
): Promise<LifecyclePortfolioResponse> {
  return apiFetch<LifecyclePortfolioResponse>(queryPath('/api/lifecycle', {
    workspaceId,
    search: filters.search,
    status: filters.status,
    specStatus: filters.specStatus,
    phase: filters.phase,
    risk: filters.risk,
    owner: filters.owner,
    blocked: filters.blocked,
    disposition: filters.disposition,
    sort: filters.sort,
    page: pagination.page,
    limit: pagination.limit,
    cursor: pagination.cursor,
  }), requestInit(options));
}

export function getLifecycleSpec(
  workspaceId: string,
  specId: string,
  snapshotId?: string,
  options?: LifecycleRequestOptions,
): Promise<LifecycleSpecResponse> {
  return apiFetch<LifecycleSpecResponse>(queryPath(`/api/lifecycle/specs/${encodeURIComponent(specId)}`, {
    workspaceId,
    snapshotId,
  }), requestInit(options));
}

export function getLifecyclePhase(
  workspaceId: string,
  specId: string,
  phaseId: LifecyclePhaseId,
  pagination: LifecyclePaginationRequest = {},
  snapshotId?: string,
  options?: LifecycleRequestOptions,
): Promise<LifecyclePhaseResponse> {
  return apiFetch<LifecyclePhaseResponse>(queryPath(
    `/api/lifecycle/specs/${encodeURIComponent(specId)}/phases/${encodeURIComponent(phaseId)}`,
    { workspaceId, snapshotId, page: pagination.page, limit: pagination.limit, cursor: pagination.cursor },
  ), requestInit(options));
}

export function openLifecycleSourceArtifact(
  workspaceId: string,
  specId: string,
  relativePath: string,
  action: LifecycleSourceArtifactAction,
  line?: number | null,
  column?: number | null,
  options?: LifecycleRequestOptions,
): Promise<LifecycleSourceArtifactOpenResult> {
  return apiFetch<LifecycleSourceArtifactOpenResult>(queryPath(
    `/api/lifecycle/specs/${encodeURIComponent(specId)}/source-artifacts/open`,
    { workspaceId },
  ), {
    ...requestInit(options),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath, action, line: line ?? null, column: column ?? null }),
  });
}

export function getLifecycleSourceArtifactContent(
  workspaceId: string,
  specId: string,
  relativePath: string,
  startLine?: number | null,
  endLine?: number | null,
  options?: LifecycleRequestOptions,
): Promise<LifecycleSourceArtifactPreview> {
  return apiFetch<LifecycleSourceArtifactPreview>(queryPath(
    `/api/lifecycle/specs/${encodeURIComponent(specId)}/source-artifacts/content`,
    { workspaceId, relativePath, startLine, endLine },
  ), requestInit(options));
}

export function getLifecycleEvidence(
  workspaceId: string,
  evidenceId: string,
  snapshotId?: string,
  options?: LifecycleRequestOptions,
): Promise<LifecycleEvidenceDetail> {
  return apiFetch<LifecycleEvidenceDetail>(queryPath(`/api/lifecycle/evidence/${encodeURIComponent(evidenceId)}`, {
    workspaceId,
    snapshotId,
  }), requestInit(options));
}

export function listLifecycleEvidence(
  workspaceId: string,
  filters: { specSlug?: string; runId?: number; storyId?: string; phaseId?: LifecyclePhaseId; gateId?: string },
  pagination: Pick<LifecyclePaginationRequest, 'limit' | 'cursor'> = {},
  options?: LifecycleRequestOptions,
): Promise<LifecyclePaginated<LifecycleEvidenceListItem>> {
  return apiFetch<LifecyclePaginated<LifecycleEvidenceListItem>>(queryPath('/api/lifecycle/evidence', {
    workspaceId,
    ...filters,
    ...pagination,
  }), requestInit(options));
}

/**
 * US-011: request advisory "what's missing" suggestions for one phase. The
 * server returns `advisory: true` and never persists the suggestions.
 */
export function getLifecyclePhaseAdvice(
  workspaceId: string,
  specId: string,
  phaseId: LifecyclePhaseId,
  storyId?: string | null,
  options?: LifecycleRequestOptions,
): Promise<LifecycleAdviceResponse> {
  return apiFetch<LifecycleAdviceResponse>(
    queryPath(`/api/lifecycle/specs/${encodeURIComponent(specId)}/advice`, { workspaceId }),
    {
      ...requestInit(options),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phaseId, ...(storyId ? { storyId } : {}) }),
    },
  );
}

function mutationInit(idempotencyKey: string, body: unknown, options?: LifecycleRequestOptions): RequestInit & { silent?: boolean } {
  return {
    method: 'POST',
    signal: options?.signal,
    silent: options?.silent,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  };
}

export function recompileLifecycleSpec(
  workspaceId: string,
  specId: string,
  idempotencyKey: string,
  expectedSaveGeneration?: number | null,
  options?: LifecycleRequestOptions,
): Promise<LifecycleMutationResult> {
  return apiFetch<LifecycleMutationResult>(
    `/api/lifecycle/specs/${encodeURIComponent(specId)}/recompile`,
    mutationInit(idempotencyKey, { workspaceId, expectedSaveGeneration }, options),
  );
}

export function previewLifecycleRetry(
  workspaceId: string,
  runId: number,
  storyIds?: string[],
  options?: LifecycleRequestOptions,
): Promise<LifecycleRetryPreviewResponse> {
  return apiFetch<LifecycleRetryPreviewResponse>(
    `/api/lifecycle/runs/${runId}/retry-preview`,
    mutationInit(`preview-only-${runId}`, { workspaceId, ...(storyIds ? { storyIds } : {}) }, options),
  );
}

export function dispatchLifecycleRetry(
  workspaceId: string,
  runId: number,
  preview: LifecycleRetryPreviewResponse,
  idempotencyKey: string,
  options?: LifecycleRequestOptions,
): Promise<LifecycleRetryDispatchResult> {
  return apiFetch<LifecycleRetryDispatchResult>(
    `/api/lifecycle/runs/${runId}/retry-dispatch`,
    mutationInit(idempotencyKey, {
      workspaceId,
      previewHash: preview.preview.previewHash,
      approvedPreview: preview.preview,
      previewIdentity: preview.previewIdentity,
    }, options),
  );
}

export function getLifecycleDecisionState(
  workspaceId: string,
  specSlug: string,
  phaseId: LifecyclePhaseId,
  gateId?: string,
  options?: LifecycleRequestOptions,
): Promise<LifecycleDecisionState> {
  return apiFetch<LifecycleDecisionState>(queryPath('/api/lifecycle/decisions/state', {
    workspaceId, specSlug, phaseId, gateId,
  }), requestInit(options));
}

export function recordLifecycleDecision(
  input: RecordLifecycleDecisionInput,
  idempotencyKey: string,
  options?: LifecycleRequestOptions,
): Promise<LifecycleDecisionMutationResult> {
  return apiFetch<LifecycleDecisionMutationResult>(
    '/api/lifecycle/decisions',
    mutationInit(idempotencyKey, input, options),
  );
}

export function revokeLifecycleDecision(
  workspaceId: string,
  decisionId: string,
  rationale: string,
  idempotencyKey: string,
  options?: LifecycleRequestOptions,
): Promise<LifecycleDecisionMutationResult> {
  return apiFetch<LifecycleDecisionMutationResult>(
    `/api/lifecycle/decisions/${encodeURIComponent(decisionId)}/revoke`,
    mutationInit(idempotencyKey, { workspaceId, rationale }, options),
  );
}

export function getPreStagingQualificationPreview(
  workspaceId: string,
  specId: string,
  runId?: number,
  options?: LifecycleRequestOptions,
): Promise<PreStagingQualificationPreview> {
  return apiFetch<PreStagingQualificationPreview>(queryPath(
    `/api/lifecycle/specs/${encodeURIComponent(specId)}/pre-staging-qualification/preview`,
    { workspaceId, runId },
  ), requestInit(options));
}

export function runPreStagingQualification(
  workspaceId: string,
  specId: string,
  previewHash: string,
  idempotencyKey: string,
  runId?: number,
  options?: LifecycleRequestOptions,
): Promise<PreStagingQualificationReceipt> {
  return apiFetch<PreStagingQualificationReceipt>(
    `/api/lifecycle/specs/${encodeURIComponent(specId)}/pre-staging-qualification/run`,
    mutationInit(idempotencyKey, { workspaceId, previewHash, runId }, options),
  );
}

export function listPreStagingQualifications(
  workspaceId: string,
  specId: string,
  limit = 5,
  options?: LifecycleRequestOptions,
): Promise<{ items: PreStagingQualificationReceipt[] }> {
  return apiFetch<{ items: PreStagingQualificationReceipt[] }>(queryPath(
    `/api/lifecycle/specs/${encodeURIComponent(specId)}/pre-staging-qualifications`,
    { workspaceId, limit },
  ), requestInit(options));
}
