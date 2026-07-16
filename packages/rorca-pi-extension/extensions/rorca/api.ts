/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type {
  ForgeSpecResponse,
  GenerateSpecResponse,
  GeneratedSpecStatus,
  HealthResponse,
  PaginatedResponse,
  PiModel,
  PipelineRunDetailResponse,
  PipelineRunSummary,
  RetryRunResponse,
  SpecDetail,
  TriggerPipelineResponse,
  Workspace,
  WorkspaceContextRoutingResponse,
} from "./types.js";

export type MemoryCandidateInput = {
  workspace_id: string;
  source_system: string;
  category: string;
  title: string;
  rule: string;
  context?: string;
  related_files: string[];
  confidence: 'high' | 'medium' | 'low';
  trust_tier: 'authoritative' | 'trusted' | 'community' | 'unverified';
  source_ref?: string;
  idempotency_key: string;
};

export class RorcaApiClient {
  readonly baseUrl: string;
  readonly defaultHeaders: Record<string, string>;

  constructor(
    baseUrl: string = process.env.RORCA_PI_API_URL || "http://127.0.0.1:3030",
    options: { headers?: Record<string, string> } = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.defaultHeaders = { ...(options.headers ?? {}) };
  }

  async getHealth(): Promise<HealthResponse> {
    return this.fetchJson<HealthResponse>("/api/health", undefined, 10_000);
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const response = await this.fetchJson<PaginatedResponse<Workspace>>("/api/workspaces");
    return response.items;
  }

  async resolveWorkspace(workspaceId?: string, chooseWorkspace?: (workspaces: Workspace[]) => Promise<string | undefined>): Promise<Workspace> {
    const explicit = workspaceId || process.env.RORCA_PI_WORKSPACE_ID;
    const workspaces = await this.listWorkspaces();
    if (workspaces.length === 0) {
      throw new Error("No workspaces registered. Add one in Rorca first.");
    }

    if (explicit) {
      const match = workspaces.find((workspace) => workspace.id === explicit || workspace.label === explicit);
      if (!match) {
        throw new Error(`Workspace \"${explicit}\" not found.`);
      }
      return match;
    }

    if (workspaces.length === 1) return workspaces[0];

    if (chooseWorkspace) {
      const selected = await chooseWorkspace(workspaces);
      if (selected) {
        const match = workspaces.find((workspace) => workspace.id === selected || workspace.label === selected);
        if (match) return match;
      }
    }

    return workspaces[0];
  }

  async generateSpec(workspaceId: string, brief: string): Promise<GenerateSpecResponse> {
    return this.fetchJson<GenerateSpecResponse>("/api/specs/generate", {
      method: "POST",
      body: JSON.stringify({ workspaceId, brief, agentOverride: "pi" }),
    }, 120_000);
  }

  async forgeSpec(input: {
    workspaceId: string;
    brief: string;
    model?: string;
    storyCount?: number;
  }): Promise<ForgeSpecResponse> {
    return this.fetchJson<ForgeSpecResponse>("/api/specs/forge", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: input.workspaceId,
        brief: input.brief,
        agentOverride: "pi",
        ...(input.model ? { model: input.model } : {}),
        ...(typeof input.storyCount === "number" ? { storyCount: input.storyCount } : {}),
      }),
    }, 120_000);
  }

  async waitForGeneratedSpec(jobId: string): Promise<GeneratedSpecStatus> {
    for (;;) {
      const status = await this.fetchJson<GeneratedSpecStatus>(`/api/specs/generate/job/${encodeURIComponent(jobId)}`);
      if (status.status === "done") return status;
      if (status.status === "failed") {
        throw new Error(status.error || "Spec generation failed.");
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  async getSpec(specSlug: string, workspaceId: string): Promise<SpecDetail> {
    return this.fetchJson<SpecDetail>(`/api/specs/${encodeURIComponent(specSlug)}?workspaceId=${encodeURIComponent(workspaceId)}`);
  }

  /**
   * CTM-006: Fetch the canonical workspace-context routing decision so run/quick-run
   * dispatch can warn when the workspace is context blind before launching.
   */
  async getContextRouting(workspaceId: string): Promise<WorkspaceContextRoutingResponse["routing"]> {
    const response = await this.fetchJson<WorkspaceContextRoutingResponse>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/context-routing`,
    );
    return response.routing;
  }

  async getPiModels(): Promise<PiModel[]> {
    const response = await this.fetchJson<{ models: PiModel[] }>("/api/config/pi-models");
    return Array.isArray(response.models) ? response.models : [];
  }

  async approveSpec(specSlug: string, workspaceId: string): Promise<void> {
    await this.fetchJson(`/api/specs/${encodeURIComponent(specSlug)}/approve`, {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    });
  }

  async triggerRun(input: {
    specSlug: string;
    workspaceId: string;
    storyId?: string;
    queue?: boolean;
    model?: string;
    includeGraph?: boolean;
    forceSequential?: boolean;
  }): Promise<TriggerPipelineResponse> {
    return this.fetchJson<TriggerPipelineResponse>("/api/pipeline/trigger", {
      method: "POST",
      body: JSON.stringify({
        specPath: `forge/specs/approved/${input.specSlug}.json`,
        workspaceId: input.workspaceId,
        storyId: input.storyId,
        queue: Boolean(input.queue),
        agentOverride: "pi",
        includeGraph: input.includeGraph ?? true,
        ...(input.model ? { modelOverride: input.model } : {}),
        ...(input.forceSequential ? { forceSequential: true } : {}),
      }),
    }, 60_000);
  }

  /**
   * CTM-008: Trigger retroactive context enrichment for a spec. Returns only the
   * lightweight retrieval metadata (method + story count) — never raw blobs — so
   * callers stay trace-safe.
   */
  async enrichSpec(specSlug: string, workspaceId: string): Promise<{ retrievalMethod: string; storiesEnriched: number }> {
    const response = await this.fetchJson<{ retrieval_method?: string; storiesEnriched?: number }>(
      `/api/specs/${encodeURIComponent(specSlug)}/enrich`,
      {
        method: "POST",
        body: JSON.stringify({ workspaceId }),
      },
      600_000,
    );
    return {
      retrievalMethod: response.retrieval_method ?? "direction-only",
      storiesEnriched: response.storiesEnriched ?? 0,
    };
  }

  async getRun(runId: number): Promise<PipelineRunDetailResponse> {
    return this.fetchJson<PipelineRunDetailResponse>(`/api/pipeline/runs/${runId}`);
  }

  async listRuns(workspaceId: string, limit: number = 10): Promise<PipelineRunSummary[]> {
    const response = await this.fetchJson<PaginatedResponse<PipelineRunSummary>>(`/api/pipeline/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`);
    return response.items;
  }

  async retryRun(runId: number, storyIds: string[] = [], options?: { forceSequential?: boolean }): Promise<RetryRunResponse> {
    const body: Record<string, unknown> = {};
    if (storyIds.length > 0) body.storyIds = storyIds;
    if (options?.forceSequential) body.forceSequential = true;
    return this.fetchJson<RetryRunResponse>(`/api/pipeline/runs/${runId}/retry`, {
      method: "POST",
      body: JSON.stringify(body),
    }, 60_000);
  }

  /**
   * Submit a memory candidate to the review queue (pending status).
   * Uses the candidates ingestion API with idempotency.
   */
  async submitCandidate(input: MemoryCandidateInput): Promise<{ id: string; created: boolean }> {
    const response = await this.fetchJson<{
      id: string;
      created_at: string;
      updated_at: string;
    }>("/api/candidates", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const created = Math.abs(
      new Date(response.updated_at).getTime() - new Date(response.created_at).getTime(),
    ) < 1000;
    return { id: response.id, created };
  }

  /**
   * Save a memory entry directly (approved/permanent).
   * Uses the memory API (skip review gate).
   */
  async saveMemory(input: {
    workspaceId: string;
    category: string;
    title: string;
    rule: string;
    context?: string;
    source?: string;
    sourceType?: string;
    relatedFiles?: string[];
  }): Promise<{ total: number }> {
    return this.fetchJson<{ total: number }>("/api/memory", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async configureCapturePolicy(input: { workspaceId: string; policyMode: string; activeIntegrations?: Record<string, unknown>; ignoredPaths?: string[] }): Promise<unknown> {
    return this.fetchJson(`/api/context-capture/${encodeURIComponent(input.workspaceId)}/policy`, {
      method: "PATCH",
      body: JSON.stringify({ policyMode: input.policyMode, activeIntegrations: input.activeIntegrations, ignoredPaths: input.ignoredPaths }),
    });
  }

  async fetchJson<T>(pathname: string, init?: RequestInit, timeoutMs: number = 30_000): Promise<T> {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...this.defaultHeaders,
        ...(init?.headers || {}),
      },
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) as unknown : undefined;

    if (!response.ok) {
      const message = extractApiErrorMessage(response.status, data);
      throw new Error(message);
    }

    return data as T;
  }
}

export function extractApiErrorMessage(status: number, payload: unknown): string {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const message = obj.message ?? obj.error ?? obj.reason;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return `Rorca API request failed (${status})`;
}
