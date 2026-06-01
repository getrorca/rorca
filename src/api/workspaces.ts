/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type {
  ApiOptions,
  PaginatedResponse,
  Workspace,
  PipelineConfig,
  WorkspaceStats,
  EnvVar,
  AgentHook,
} from './types';

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function listWorkspaces(opts?: ApiOptions): Promise<PaginatedResponse<Workspace>> {
  return apiFetch('/api/workspaces', { signal: opts?.signal });
}

export function getWorkspace(
  id: string,
  opts?: ApiOptions,
): Promise<{ workspace: Workspace }> {
  return apiFetch(`/api/workspaces/${id}`, { signal: opts?.signal });
}

export function createWorkspace(
  body: { label: string; path: string; domains?: string[] },
  opts?: ApiOptions,
): Promise<{ workspace: Workspace }> {
  return apiFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

export function updateWorkspace(
  id: string,
  patch: Partial<Pick<Workspace, 'label' | 'path' | 'domains'>>,
  opts?: ApiOptions,
): Promise<{ workspace: Workspace }> {
  return apiFetch(`/api/workspaces/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: opts?.signal,
  });
}

export function deleteWorkspace(
  id: string,
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch(`/api/workspaces/${id}`, {
    method: 'DELETE',
    signal: opts?.signal,
  });
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export function getStats(
  id: string,
  opts?: ApiOptions,
): Promise<WorkspaceStats> {
  return apiFetch(`/api/workspaces/${id}/stats`, { signal: opts?.signal });
}

// ─── Pipeline Config ──────────────────────────────────────────────────────────

export function getPipelineConfig(
  id: string,
  opts?: ApiOptions,
): Promise<{ config: PipelineConfig }> {
  return apiFetch(`/api/workspaces/${id}/pipeline-config`, { signal: opts?.signal });
}

export function updatePipelineConfig(
  id: string,
  config: Partial<PipelineConfig>,
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch(`/api/workspaces/${id}/pipeline-config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
    signal: opts?.signal,
  });
}

// ─── Environment Variables ────────────────────────────────────────────────────

export function listEnvVars(
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ envVars: EnvVar[] }> {
  return apiFetch(`/api/workspaces/${workspaceId}/env-vars`, { signal: opts?.signal });
}

export function createEnvVar(
  workspaceId: string,
  body: { key: string; value: string; isSecret?: boolean },
  opts?: ApiOptions,
): Promise<EnvVar> {
  return apiFetch(`/api/workspaces/${workspaceId}/env-vars`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

export function updateEnvVar(
  workspaceId: string,
  key: string,
  body: { value: string; isSecret?: boolean },
  opts?: ApiOptions,
): Promise<EnvVar> {
  return apiFetch(`/api/workspaces/${workspaceId}/env-vars/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

export function deleteEnvVar(
  workspaceId: string,
  key: string,
  opts?: ApiOptions,
): Promise<void> {
  return apiFetch(`/api/workspaces/${workspaceId}/env-vars/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    signal: opts?.signal,
  });
}

// ─── Agent Hooks ──────────────────────────────────────────────────────────────

export function listAgentHooks(
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ hooks: AgentHook[] }> {
  return apiFetch(`/api/workspaces/${workspaceId}/agent-hooks`, { signal: opts?.signal });
}

export function createAgentHook(
  workspaceId: string,
  body: { event: string; command: string },
  opts?: ApiOptions,
): Promise<{ hook: AgentHook }> {
  return apiFetch(`/api/workspaces/${workspaceId}/agent-hooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

export function updateAgentHook(
  workspaceId: string,
  hookId: number,
  patch: Partial<AgentHook>,
  opts?: ApiOptions,
): Promise<{ hook: AgentHook }> {
  return apiFetch(`/api/workspaces/${workspaceId}/agent-hooks/${hookId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: opts?.signal,
  });
}

export function deleteAgentHook(
  workspaceId: string,
  hookId: number,
  opts?: ApiOptions,
): Promise<void> {
  return apiFetch(`/api/workspaces/${workspaceId}/agent-hooks/${hookId}`, {
    method: 'DELETE',
    signal: opts?.signal,
  });
}

// ─── Context ──────────────────────────────────────────────────────────────────

export function getContext(
  id: string,
  opts?: ApiOptions,
): Promise<{ schemaSnapshot: string; schemaTableCount: number; gitMemory: string }> {
  return apiFetch(`/api/workspaces/${id}/context`, { signal: opts?.signal });
}

export function hydrateContext(
  id: string,
  opts?: ApiOptions,
): Promise<Record<string, unknown>> {
  return apiFetch(`/api/workspaces/${id}/hydrate`, {
    method: 'POST',
    signal: opts?.signal,
  });
}

export function listFiles(
  id: string,
  opts?: ApiOptions,
): Promise<{ files: string[] }> {
  return apiFetch(`/api/workspaces/${id}/files`, { signal: opts?.signal });
}
