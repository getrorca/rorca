import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CaptureConfig } from "./config.js";

export const MCP_TOKEN_RELATIVE_PATH = ".rorca/mcp-token";

export type Workspace = {
  id: string;
  label?: string;
  path: string;
};

export type PaginatedWorkspaces = {
  items: Workspace[];
  total?: number;
};

export type TokenStatus = {
  path: string;
  exists: boolean;
  mode?: string;
  modeOk: boolean;
};

export type ResolvedWorkspace = {
  id: string;
  path: string;
  label?: string;
  resolvedBy: "config" | "path";
};

export type CaptureFetch = typeof fetch;

export type CaptureApiClient = {
  get<T>(pathname: string): Promise<T>;
  post<T>(pathname: string, body: unknown): Promise<T>;
};

export class CaptureApiError extends Error {
  readonly code?: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CaptureApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toJSON(): { error: string; code?: string; details?: Record<string, unknown> } {
    return {
      error: this.message,
      ...(this.code ? { code: this.code } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class CaptureNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CaptureNotFoundError";
    this.details = details;
  }

  toJSON(): { error: string; code: string; details?: Record<string, unknown> } {
    return {
      error: this.message,
      code: this.code,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function getDefaultMcpTokenPath(home = homedir()): string {
  return path.join(home, MCP_TOKEN_RELATIVE_PATH);
}

export function inspectMcpToken(tokenPath = getDefaultMcpTokenPath()): TokenStatus {
  if (!existsSync(tokenPath)) {
    return { path: tokenPath, exists: false, modeOk: false };
  }

  if (process.platform === "win32") {
    return { path: tokenPath, exists: true, modeOk: true };
  }

  const mode = (statSync(tokenPath).mode & 0o777).toString(8).padStart(3, "0");
  return { path: tokenPath, exists: true, mode, modeOk: mode === "600" };
}

export function readMcpToken(tokenPath = getDefaultMcpTokenPath()): string {
  const status = inspectMcpToken(tokenPath);
  if (!status.exists) {
    throw new CaptureApiError("MCP Bearer token file not found at ~/.rorca/mcp-token.", 401, "AUTH_ERROR", {
      tokenPath,
    });
  }
  if (!status.modeOk) {
    throw new CaptureApiError("MCP Bearer token file must have mode 0600.", 401, "AUTH_ERROR", {
      tokenPath,
      mode: status.mode,
    });
  }
  return readFileSync(tokenPath, "utf8").trim();
}

export function createApiClient(config: Pick<CaptureConfig, "apiUrl">, options: {
  token?: string;
  tokenPath?: string;
  fetchImpl?: CaptureFetch;
} = {}): CaptureApiClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = options.token ?? readMcpToken(options.tokenPath);
  const baseUrl = config.apiUrl.replace(/\/$/, "");

  async function request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      const text = await response.text();
      let message = text || `HTTP ${response.status}`;
      let code: string | undefined;
      let details: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(text) as { error?: string; code?: string; details?: Record<string, unknown> };
        message = parsed.error || message;
        code = parsed.code;
        details = parsed.details;
      } catch {
        // Keep raw response text.
      }
      throw new CaptureApiError(message, response.status, code, details);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return await response.json() as T;
  }

  return {
    get<T>(pathname: string) {
      return request<T>(pathname);
    },
    post<T>(pathname: string, body: unknown) {
      return request<T>(pathname, { method: "POST", body: JSON.stringify(body) });
    },
  };
}

export async function fetchWorkspaces(client: Pick<CaptureApiClient, "get">): Promise<Workspace[]> {
  const response = await client.get<PaginatedWorkspaces | Workspace[]>("/api/workspaces");
  if (Array.isArray(response)) return response;
  return Array.isArray(response.items) ? response.items : [];
}

export async function resolveWorkspace(
  config: Pick<CaptureConfig, "workspaceId" | "repoPath">,
  client: Pick<CaptureApiClient, "get">,
): Promise<ResolvedWorkspace> {
  const workspaces = await fetchWorkspaces(client);
  const repoPath = normalizeFsPath(config.repoPath);

  if (config.workspaceId) {
    const workspace = workspaces.find((item) => item.id === config.workspaceId);
    if (!workspace) {
      throw new CaptureNotFoundError(`Workspace '${config.workspaceId}' not found`, {
        workspaceId: config.workspaceId,
        repoPath: config.repoPath,
      });
    }
    return {
      id: workspace.id,
      path: workspace.path,
      label: workspace.label,
      resolvedBy: "config",
    };
  }

  const workspace = workspaces.find((item) => normalizeFsPath(item.path) === repoPath);
  if (!workspace) {
    throw new CaptureNotFoundError("Workspace not found", {
      repoPath: config.repoPath,
      hint: "Register this repository in Rorca or set RORCA_WORKSPACE_ID to an existing workspace.",
    });
  }

  return {
    id: workspace.id,
    path: workspace.path,
    label: workspace.label,
    resolvedBy: "path",
  };
}

export function normalizeFsPath(input: string): string {
  return path.resolve(input).replace(/\\/g, "/");
}
