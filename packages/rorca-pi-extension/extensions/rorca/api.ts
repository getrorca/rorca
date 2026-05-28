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
} from "./types.js";

export class RorcaApiClient {
  readonly baseUrl: string;

  constructor(baseUrl: string = process.env.RORCA_PI_API_URL || "http://127.0.0.1:3030") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
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

  async fetchJson<T>(pathname: string, init?: RequestInit, timeoutMs: number = 30_000): Promise<T> {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
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
