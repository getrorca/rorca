export class RorcaApiClient {
    baseUrl;
    defaultHeaders;
    constructor(baseUrl = process.env.RORCA_PI_API_URL || "http://127.0.0.1:3030", options = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.defaultHeaders = options.headers ?? {};
    }
    async getHealth() {
        return this.fetchJson("/api/health", undefined, 10_000);
    }
    async listWorkspaces() {
        const response = await this.fetchJson("/api/workspaces");
        return response.items;
    }
    async resolveWorkspace(workspaceId, chooseWorkspace) {
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
        if (workspaces.length === 1)
            return workspaces[0];
        if (chooseWorkspace) {
            const selected = await chooseWorkspace(workspaces);
            if (selected) {
                const match = workspaces.find((workspace) => workspace.id === selected || workspace.label === selected);
                if (match)
                    return match;
            }
        }
        return workspaces[0];
    }
    async generateSpec(workspaceId, brief) {
        return this.fetchJson("/api/specs/generate", {
            method: "POST",
            body: JSON.stringify({ workspaceId, brief, agentOverride: "pi" }),
        }, 120_000);
    }
    async forgeSpec(input) {
        return this.fetchJson("/api/specs/forge", {
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
    async waitForGeneratedSpec(jobId) {
        for (;;) {
            const status = await this.fetchJson(`/api/specs/generate/job/${encodeURIComponent(jobId)}`);
            if (status.status === "done")
                return status;
            if (status.status === "failed") {
                throw new Error(status.error || "Spec generation failed.");
            }
            await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
    }
    async getSpec(specSlug, workspaceId) {
        return this.fetchJson(`/api/specs/${encodeURIComponent(specSlug)}?workspaceId=${encodeURIComponent(workspaceId)}`);
    }
    /**
     * CTM-006: Fetch the canonical workspace-context routing decision so run/quick-run
     * dispatch can warn when the workspace is context blind before launching.
     */
    async getContextRouting(workspaceId) {
        const response = await this.fetchJson(`/api/workspaces/${encodeURIComponent(workspaceId)}/context-routing`);
        return response.routing;
    }
    async getPiModels() {
        const response = await this.fetchJson("/api/config/pi-models");
        return Array.isArray(response.models) ? response.models : [];
    }
    async approveSpec(specSlug, workspaceId) {
        await this.fetchJson(`/api/specs/${encodeURIComponent(specSlug)}/approve`, {
            method: "POST",
            body: JSON.stringify({ workspaceId }),
        });
    }
    async triggerRun(input) {
        return this.fetchJson("/api/pipeline/trigger", {
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
    async enrichSpec(specSlug, workspaceId) {
        const response = await this.fetchJson(`/api/specs/${encodeURIComponent(specSlug)}/enrich`, {
            method: "POST",
            body: JSON.stringify({ workspaceId }),
        }, 600_000);
        return {
            retrievalMethod: response.retrieval_method ?? "direction-only",
            storiesEnriched: response.storiesEnriched ?? 0,
        };
    }
    async getRun(runId) {
        return this.fetchJson(`/api/pipeline/runs/${runId}`);
    }
    async listRuns(workspaceId, limit = 10) {
        const response = await this.fetchJson(`/api/pipeline/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`);
        return response.items;
    }
    async retryRun(runId, storyIds = [], options) {
        const body = {};
        if (storyIds.length > 0)
            body.storyIds = storyIds;
        if (options?.forceSequential)
            body.forceSequential = true;
        return this.fetchJson(`/api/pipeline/runs/${runId}/retry`, {
            method: "POST",
            body: JSON.stringify(body),
        }, 60_000);
    }
    async verifyCaptureBootstrap(input) {
        return this.fetchJson("/api/context-capture/bootstrap/verify", {
            method: "POST",
            body: JSON.stringify(input),
        });
    }
    async configureCapturePolicy(input) {
        return this.fetchJson(`/api/context-capture/${encodeURIComponent(input.workspaceId)}/policy`, {
            method: "PATCH",
            body: JSON.stringify({ policyMode: input.policyMode, activeIntegrations: input.activeIntegrations, ignoredPaths: input.ignoredPaths }),
        });
    }
    async getCaptureStatus(workspaceId) {
        return this.fetchJson(`/api/context-capture/${encodeURIComponent(workspaceId)}/status`);
    }
    async setCapturePaused(workspaceId, paused) {
        return this.fetchJson(`/api/context-capture/${encodeURIComponent(workspaceId)}/${paused ? "pause" : "resume"}`, { method: "POST" });
    }
    async uninstallCapture(workspaceId) {
        return this.fetchJson(`/api/context-capture/${encodeURIComponent(workspaceId)}/uninstall`, { method: "POST" });
    }
    async fetchJson(pathname, init, timeoutMs = 30_000) {
        const response = await fetch(`${this.baseUrl}${pathname}`, {
            ...init,
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
                Accept: "application/json",
                ...this.defaultHeaders,
                ...(init?.body ? { "Content-Type": "application/json" } : {}),
                ...(init?.headers || {}),
            },
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : undefined;
        if (!response.ok) {
            const message = extractApiErrorMessage(response.status, data);
            throw new Error(message);
        }
        return data;
    }
}
export function extractApiErrorMessage(status, payload) {
    if (payload && typeof payload === "object") {
        const obj = payload;
        const message = obj.message ?? obj.error ?? obj.reason;
        if (typeof message === "string" && message.trim()) {
            return message;
        }
    }
    return `Rorca API request failed (${status})`;
}
