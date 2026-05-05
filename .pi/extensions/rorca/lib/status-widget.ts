/// <reference types="node" />
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

type ExtensionAPI = {
  ui?: UiApi;
};

type UiApi = {
  setStatus?: (id: string, status: string) => void;
  setWidget?: (id: string, widget: unknown) => void;
};

type WalEvent = {
  ts?: string;
  event_type?: string;
};

type WalResponse = {
  items?: WalEvent[];
};

type SpecsResponse = {
  items?: unknown[];
  specs?: unknown[];
  total?: number;
};

type ActiveRunState = {
  runId: number | null;
  specId: string | null;
  totalStories: number;
  passedStories: number;
  model: string | null;
};

const STATUS_ID = "rorca";
const WIDGET_ID = "rorca-status";
const NORMAL_INTERVAL_MS = 5000;
const FALLBACK_INTERVAL_MS = 10000;
const REQUEST_TIMEOUT_MS = 3000;

type RenderState = {
  statusLine: string;
};

function readDefaultToken(): string | undefined {
  const tokenPath = join(homedir(), ".rorca", "mcp-token");
  if (!existsSync(tokenPath)) {
    return undefined;
  }

  const token = readFileSync(tokenPath, "utf8").trim();
  return token || undefined;
}

function timeAgo(ts: string): string {
  const elapsedMs = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) {
    return "< 1m";
  }

  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `${elapsedHours}h ago`;
}

export class StatusWidget {
  private readonly pi: ExtensionAPI;
  private readonly baseUrl: string;
  private readonly token?: string;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private fallbackMode = false;
  private workspaceName: string | null = null;
  private lastEvents: string[] = [];
  private lastPendingCount = 0;
  private activeRun: ActiveRunState = {
    runId: null,
    specId: null,
    totalStories: 0,
    passedStories: 0,
    model: null,
  };

  constructor(pi: ExtensionAPI, baseUrl: string, token?: string) {
    this.pi = pi;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token?.trim() || readDefaultToken();
    this.workspaceName = this.resolveWorkspaceName();
  }

  start(): void {
    if (process.env.RORCA_TUI_DISABLE === "true") {
      return;
    }

    this.pushStatus({ statusLine: "Rorca: Connecting..." });
    this.resetInterval(this.fallbackMode ? FALLBACK_INTERVAL_MS : NORMAL_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (process.env.RORCA_TUI_DISABLE === "true") {
      return;
    }

    const ui = this.getUi();
    if (this.fallbackMode || typeof ui?.setStatus !== "function") {
      process.stderr.write("[rorca] Rorca: Disconnected\n");
      return;
    }

    try {
      ui.setStatus(STATUS_ID, "Rorca: Disconnected");
    } catch {
      process.stderr.write("[rorca] Rorca: Disconnected\n");
    }
  }

  setActiveRun(
    runId: number | null,
    specId: string | null,
    totalStories: number,
    passedStories: number,
    model: string | null,
  ): void {
    this.activeRun = {
      runId,
      specId,
      totalStories,
      passedStories,
      model,
    };
  }

  private resolveWorkspaceName(): string | null {
    const explicitName = process.env.RORCA_WORKSPACE_NAME?.trim();
    if (explicitName) {
      return explicitName;
    }

    const explicitLabel = process.env.RORCA_WORKSPACE_LABEL?.trim();
    if (explicitLabel) {
      return explicitLabel;
    }

    const workspacePath = process.env.RORCA_WORKSPACE_PATH?.trim();
    if (workspacePath) {
      return basename(workspacePath);
    }

    return process.env.RORCA_WORKSPACE_ID?.trim() || null;
  }

  private getUi(): UiApi | null {
    const candidate = (this.pi as { ui?: UiApi }).ui;
    return candidate ?? null;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    return headers;
  }

  private resetInterval(delayMs: number): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }

    this.intervalId = setInterval(() => {
      void this.tick();
    }, delayMs);
  }

  private activateFallback(statusLine: string): void {
    if (this.fallbackMode) {
      return;
    }

    this.fallbackMode = true;
    if (this.intervalId) {
      this.resetInterval(FALLBACK_INTERVAL_MS);
    }
    process.stderr.write(`[rorca] ${statusLine}\n`);
  }

  private buildRenderState(statusLine: string): RenderState {
    return {
      statusLine,
    };
  }

  private pushWidget(renderState: RenderState): void {
    const ui = this.getUi();
    if (typeof ui?.setWidget !== "function") {
      return;
    }

    try {
      ui.setWidget(WIDGET_ID, {
        type: "text",
        content: renderState.statusLine,
      });
    } catch {
      // Widget rendering is opportunistic. Status-only mode is still valid.
    }
  }

  private pushStatus(renderState: RenderState): void {
    this.pushWidget(renderState);

    if (this.fallbackMode) {
      process.stderr.write(`[rorca] ${renderState.statusLine}\n`);
      return;
    }

    const ui = this.getUi();
    if (typeof ui?.setStatus !== "function") {
      this.activateFallback(renderState.statusLine);
      return;
    }

    try {
      ui.setStatus(STATUS_ID, renderState.statusLine);
    } catch {
      this.activateFallback(renderState.statusLine);
      return;
    }
  }

  private async tick(): Promise<void> {
    try {
      const walEvents = await this.fetchWalEvents();
      if (walEvents) {
        this.lastEvents = walEvents;
      }

      let statusLine = "";
      const lastEvent = this.lastEvents[0] ?? "no events";

      if (this.activeRun.runId !== null) {
        statusLine = `Rorca: ${this.activeRun.specId ?? "run"} | ${this.activeRun.passedStories}/${this.activeRun.totalStories} | ${this.activeRun.model || "auto"} | ${lastEvent}`;
      } else {
        const pendingCount = await this.fetchPendingCount();
        if (typeof pendingCount === "number") {
          this.lastPendingCount = pendingCount;
        }
        statusLine = `Rorca: Idle — ${this.lastPendingCount} pending | ${lastEvent}`;
      }

      this.pushStatus(this.buildRenderState(statusLine));
    } catch {
      // The widget is best-effort. Never throw from the polling loop.
    }
  }

  private async fetchWalEvents(): Promise<string[] | null> {
    const response = await this.fetchJson<WalResponse>("/api/wal?limit=3&orderBy=desc");
    if (!response) {
      return null;
    }

    const items = Array.isArray(response?.items) ? response.items : [];

    return items
      .slice(0, 3)
      .map((event) => {
        const eventType = event.event_type || "event";
        const timestamp = event.ts ? timeAgo(event.ts) : "< 1m";
        return `${eventType} (${timestamp})`;
      });
  }

  private async fetchPendingCount(): Promise<number | null> {
    const response = await this.fetchJson<SpecsResponse>("/api/specs?status=pending&limit=1");
    if (!response) {
      return null;
    }

    if (typeof response.total === "number") {
      return response.total;
    }

    if (Array.isArray(response.items)) {
      return response.items.length;
    }

    if (Array.isArray(response.specs)) {
      return response.specs.length;
    }

    return null;
  }

  private async fetchJson<T>(pathname: string): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}${pathname}`, {
        headers: this.buildHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export { timeAgo };
