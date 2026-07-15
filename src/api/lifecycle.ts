/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type {
  LifecycleDecisionMutationResult,
  LifecycleDecisionState,
  LifecycleEvidenceDetail,
  LifecycleEvidenceListItem,
  LifecycleMutationResult,
  LifecyclePaginated,
  LifecyclePaginationRequest,
  LifecyclePhaseId,
  LifecyclePhaseResponse,
  LifecyclePortfolioFilters,
  LifecyclePortfolioResponse,
  LifecycleSpecResponse,
  RecordLifecycleDecisionInput,
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
