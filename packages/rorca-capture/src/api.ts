import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CaptureConfig } from "./config.js";
import { buildCaptureStatus, type CaptureStatus } from "./status.js";
import {
  enqueueCaptureQueueEntry,
  normalizeCapturePayloadForDisk,
  readCaptureQueue,
  sanitizeCaptureErrorMessage,
  updateCaptureQueueEntryFailure,
  writeCaptureQueueAtomic,
  type CaptureQueueEntry,
  type CaptureQueueOperation,
  type EnqueueCaptureQueueResult,
  type JsonObject,
  type JsonValue,
} from "./queue.js";

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

export type CaptureSubmitOptions = {
  queueOnFailure?: boolean;
  eventType?: string;
  contentFingerprint?: string;
};

export type CandidateSubmitOptions = CaptureSubmitOptions & {
  endpoint?: string;
  approve?: boolean;
  approvalEndpointBase?: string;
  approvalPayload?: Record<string, unknown>;
};

export type CandidateApprovalOptions = CaptureSubmitOptions & {
  endpointBase?: string;
};

export type CaptureSubmissionResult<T> =
  | { status: "submitted"; response: T; approval?: unknown; approvalQueued?: EnqueueCaptureQueueResult }
  | { status: "queued"; queuePath: string; entry: CaptureQueueEntry; duplicate: boolean };

export type CaptureFlushResult = {
  queuePath: string;
  submitted: number;
  failed: number;
  skipped: number;
  remaining: number;
  failures: Array<{ key: string; retryable: boolean; message: string }>;
};

export type ReusableCaptureClient = CaptureApiClient & {
  checkStatus(): Promise<CaptureStatus>;
  submitContextEvent<T = unknown>(payload: Record<string, unknown>, options?: CaptureSubmitOptions): Promise<CaptureSubmissionResult<T>>;
  submitCandidate<T = unknown>(payload: Record<string, unknown>, options?: CandidateSubmitOptions): Promise<CaptureSubmissionResult<T>>;
  approveCandidate<T = unknown>(candidateId: string | number, payload?: Record<string, unknown>, options?: CandidateApprovalOptions): Promise<CaptureSubmissionResult<T>>;
  flushQueue(options?: { force?: boolean; queuePath?: string; now?: Date }): Promise<CaptureFlushResult>;
};

export class CaptureApiError extends Error {
  readonly code?: string;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode: number, code?: string, details?: Record<string, unknown>) {
    super(sanitizeCaptureErrorMessage(message));
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

export class CaptureNetworkError extends Error {
  readonly code = "RORCA_UNREACHABLE";
  readonly statusCode = 0;
  readonly apiUrl: string;

  constructor(apiUrl: string, cause?: unknown) {
    const reason = cause instanceof Error && cause.message ? ` (${sanitizeCaptureErrorMessage(cause.message)})` : "";
    super(`Rorca API is unreachable at ${apiUrl}${reason}.`);
    this.name = "CaptureNetworkError";
    this.apiUrl = apiUrl;
  }

  toJSON(): { error: string; code: string; details: { apiUrl: string } } {
    return { error: this.message, code: this.code, details: { apiUrl: this.apiUrl } };
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
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${pathname}`, {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new CaptureNetworkError(baseUrl, error);
    }

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

export function createCaptureClient(config: CaptureConfig, options: {
  token?: string;
  tokenPath?: string;
  fetchImpl?: CaptureFetch;
} = {}): ReusableCaptureClient {
  const api = createApiClient(config, options);

  return {
    get: api.get,
    post<T>(pathname: string, body: unknown) {
      return api.post<T>(pathname, normalizeSubmissionPayload(config, body));
    },
    checkStatus() {
      return checkCaptureStatus(config, options);
    },
    submitContextEvent<T = unknown>(payload: Record<string, unknown>, submitOptions: CaptureSubmitOptions = {}) {
      return submitWithQueue<T>(config, api, "context-event", "/api/context-events", payload, submitOptions);
    },
    submitCandidate<T = unknown>(payload: Record<string, unknown>, submitOptions: CandidateSubmitOptions = {}) {
      return submitCandidateWithOptionalApproval<T>(config, api, payload, submitOptions);
    },
    approveCandidate<T = unknown>(candidateId: string | number, payload: Record<string, unknown> = {}, submitOptions: CandidateApprovalOptions = {}) {
      const endpointBase = submitOptions.endpointBase ?? "/api/context-candidates";
      const endpoint = `${endpointBase}/${encodeURIComponent(String(candidateId))}/approve`;
      return submitWithQueue<T>(config, api, "candidate-approval", endpoint, payload, {
        ...submitOptions,
        eventType: submitOptions.eventType ?? "candidate_approval",
      });
    },
    flushQueue(options = {}) {
      return flushCaptureQueue(config, api, options);
    },
  };
}

export async function checkCaptureStatus(config: CaptureConfig, options: {
  token?: string;
  tokenPath?: string;
  fetchImpl?: CaptureFetch;
} = {}): Promise<CaptureStatus> {
  const errors: string[] = [];
  const token = options.token
    ? { path: "(provided)", exists: true, modeOk: true }
    : inspectMcpToken(options.tokenPath);
  let workspace: ResolvedWorkspace | null = null;

  if (!token.exists) {
    errors.push("MCP Bearer token missing at ~/.rorca/mcp-token");
  } else if (!token.modeOk) {
    errors.push(`MCP Bearer token mode ${token.mode ?? "unknown"}; expected 600`);
  } else {
    try {
      workspace = await resolveWorkspace(config, createApiClient(config, options));
    } catch (error) {
      errors.push(formatCaptureError(error));
    }
  }

  return buildCaptureStatus({ config, workspace, token, errors });
}

export async function flushCaptureQueue(
  config: CaptureConfig,
  client: CaptureApiClient,
  options: { force?: boolean; queuePath?: string; now?: Date } = {},
): Promise<CaptureFlushResult> {
  const queuePath = options.queuePath ?? config.queuePath;
  let pending = readCaptureQueue(queuePath);
  const failures: CaptureFlushResult["failures"] = [];
  let submitted = 0;
  let failed = 0;
  let skipped = 0;

  for (const queuedEntry of [...pending]) {
    const current = pending.find((entry) => entry.key === queuedEntry.key);
    if (!current) continue;

    if (!shouldAttemptQueueEntry(current, options)) {
      skipped += 1;
      continue;
    }

    try {
      await submitQueueEntry(client, current);
      pending = pending.filter((entry) => entry.key !== current.key);
      writeCaptureQueueAtomic(queuePath, pending);
      submitted += 1;
    } catch (error) {
      const retryable = isRetryableFlushError(error);
      const updated = updateCaptureQueueEntryFailure({ entry: current, error, retryable, now: options.now });
      pending = pending.map((entry) => entry.key === current.key ? updated : entry);
      writeCaptureQueueAtomic(queuePath, pending);
      failed += 1;
      failures.push({ key: current.key, retryable, message: updated.lastError ?? "Unknown capture queue error" });
    }
  }

  return { queuePath, submitted, failed, skipped, remaining: pending.length, failures };
}

export function formatCaptureError(error: unknown): string {
  if (error && typeof error === "object" && "toJSON" in error && typeof error.toJSON === "function") {
    const json = error.toJSON() as { error?: string; code?: string };
    const message = sanitizeCaptureErrorMessage(json.error ?? "Unknown error");
    return json.code ? `${json.code}: ${message}` : message;
  }
  return sanitizeCaptureErrorMessage(error);
}

async function submitWithQueue<T>(
  config: CaptureConfig,
  client: CaptureApiClient,
  operation: CaptureQueueOperation,
  endpoint: string,
  payload: Record<string, unknown>,
  options: CaptureSubmitOptions = {},
): Promise<CaptureSubmissionResult<T>> {
  const safePayload = normalizeSubmissionPayload(config, payload);
  try {
    const response = await client.post<T>(endpoint, safePayload);
    return { status: "submitted", response };
  } catch (error) {
    if (shouldQueueOnSubmitError(error, options)) {
      const queued = enqueueCaptureQueueEntry(config.queuePath, config, {
        operation,
        endpoint,
        payload: safePayload,
        eventType: options.eventType,
        contentFingerprint: options.contentFingerprint,
      });
      return { status: "queued", queuePath: config.queuePath, entry: queued.entry, duplicate: queued.duplicate };
    }
    throw error;
  }
}

async function submitCandidateWithOptionalApproval<T>(
  config: CaptureConfig,
  client: CaptureApiClient,
  payload: Record<string, unknown>,
  options: CandidateSubmitOptions = {},
): Promise<CaptureSubmissionResult<T>> {
  const endpoint = options.endpoint ?? "/api/context-candidates";
  const approvalEndpointBase = options.approvalEndpointBase ?? endpoint;
  const safePayload = normalizeSubmissionPayload(config, payload);
  const approvalPayload = normalizeSubmissionPayload(config, options.approvalPayload ?? defaultApprovalPayload(safePayload));

  try {
    const response = await client.post<T>(endpoint, safePayload);
    if (!options.approve) return { status: "submitted", response };

    const candidateId = extractCandidateId(response);
    if (!candidateId) {
      throw new CaptureApiError("Rorca API did not return a candidate id to approve.", 502, "MISSING_CANDIDATE_ID");
    }

    try {
      const approval = await client.post(`${approvalEndpointBase}/${encodeURIComponent(candidateId)}/approve`, approvalPayload);
      return { status: "submitted", response, approval };
    } catch (approvalError) {
      if (shouldQueueOnSubmitError(approvalError, options)) {
        const approvalQueued = enqueueCaptureQueueEntry(config.queuePath, config, {
          operation: "candidate-approval",
          endpoint: `${approvalEndpointBase}/${encodeURIComponent(candidateId)}/approve`,
          payload: approvalPayload,
          eventType: "candidate_approval",
        });
        return { status: "submitted", response, approvalQueued };
      }
      throw approvalError;
    }
  } catch (error) {
    if (shouldQueueOnSubmitError(error, options)) {
      const queued = enqueueCaptureQueueEntry(config.queuePath, config, {
        operation: endpoint.includes("/memory/candidates") ? "memory-candidate" : "context-candidate",
        endpoint,
        payload: safePayload,
        eventType: options.eventType,
        contentFingerprint: options.contentFingerprint,
        ...(options.approve ? { approval: { endpointBase: approvalEndpointBase, payload: approvalPayload as JsonObject } } : {}),
      });
      return { status: "queued", queuePath: config.queuePath, entry: queued.entry, duplicate: queued.duplicate };
    }
    throw error;
  }
}

async function submitQueueEntry(client: CaptureApiClient, entry: CaptureQueueEntry): Promise<void> {
  const response = await client.post(entry.endpoint, entry.payload);
  if (!entry.approval) return;

  const candidateId = extractCandidateId(response);
  if (!candidateId) {
    throw new CaptureApiError("Rorca API did not return a candidate id to approve.", 502, "MISSING_CANDIDATE_ID");
  }
  await client.post(`${entry.approval.endpointBase}/${encodeURIComponent(candidateId)}/approve`, entry.approval.payload ?? {});
}

function shouldQueueOnSubmitError(error: unknown, options: CaptureSubmitOptions): boolean {
  if (options.queueOnFailure === false) return false;
  if (error instanceof CaptureNetworkError) return true;
  if (error instanceof CaptureApiError) {
    if (error.code === "MISSING_CANDIDATE_ID") return false;
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return false;
}

function isRetryableFlushError(error: unknown): boolean {
  if (error instanceof CaptureNetworkError) return true;
  if (error instanceof CaptureApiError) {
    if (error.code === "MISSING_CANDIDATE_ID") return false;
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  return true;
}

function shouldAttemptQueueEntry(entry: CaptureQueueEntry, options: { force?: boolean; now?: Date }): boolean {
  if (entry.retryable === false && !options.force) return false;
  if (!entry.nextRetryAt || options.force) return true;
  const retryAt = Date.parse(entry.nextRetryAt);
  if (Number.isNaN(retryAt)) return true;
  return retryAt <= (options.now ?? new Date()).getTime();
}

function extractCandidateId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const candidate = (response as { candidate?: unknown }).candidate;
  if (!candidate || typeof candidate !== "object") return null;
  const id = (candidate as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

function normalizeSubmissionPayload(config: CaptureConfig, payload: unknown): Record<string, unknown> {
  const normalized = normalizeCapturePayloadForDisk(payload, config);
  return isJsonObject(normalized) ? normalized : {};
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultApprovalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof payload.workspaceId === "string" ? { workspaceId: payload.workspaceId } : {}),
    reviewer: "local-operator",
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
