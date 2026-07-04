import type { CaptureConfig } from "./config.js";
import type { ResolvedWorkspace, TokenStatus } from "./api.js";
import { CONTEXT_SAFETY_CONTRACT_VERSION, DEFAULT_CONTEXT_IGNORE_PATHS } from "./context-safety.js";

export const MVP_COMMANDS = ["remember", "ingest-commit", "ingest-git", "install-hooks", "daemon", "status", "flush"] as const;

export type CaptureApiReachabilityStatus = {
  reachable: boolean | null;
  checkedAt?: string;
  statusCode?: number;
  error?: string;
  skipped?: boolean;
};

export type CaptureQueueStatus = {
  path: string;
  depth: number;
};

export type CaptureCursorStatus = {
  path?: string;
  lastReconciledSha: string | null;
  updatedAt?: string;
};

export type CaptureHookStatus = {
  path: string;
  installed: boolean;
  managed: boolean;
  mode?: "best-effort" | "strict" | "unmanaged";
};

export type CaptureDaemonHealthStatus = {
  workerId: string | null;
  pid: number | null;
  running: boolean;
  hostname?: string;
  lastSeen?: string;
  stale: boolean;
  statusPath?: string;
  consecutiveErrorCount: number;
  backoff: {
    active: boolean;
    nextRetryAt?: string;
    delayMs?: number;
  };
  lastScan?: Record<string, unknown>;
  lastFlush?: Record<string, unknown>;
  lastError?: string;
};

export type CaptureOperationalStatus = {
  apiReachability: CaptureApiReachabilityStatus;
  queue: CaptureQueueStatus;
  cursor: CaptureCursorStatus;
  hook: CaptureHookStatus;
  daemon: CaptureDaemonHealthStatus;
};

export type CaptureStatus = {
  ok: boolean;
  apiOnly: true;
  apiUrl: string;
  repoPath: string;
  workspaceId: string | null;
  workspaceResolvedBy: "config" | "path" | "unresolved";
  queuePath: string;
  mode: CaptureConfig["mode"];
  ignore: {
    pathCount: number;
    builtInPathCount: number;
    userPathCount: number;
    maxFileBytes: number;
    maxEventBytes: number;
    captureIgnorePath?: string;
  };
  redaction: {
    enabled: boolean;
    patternCount: number;
    replacement: string;
  };
  operatorAutoApprove: boolean;
  token: TokenStatus;
  commands: typeof MVP_COMMANDS[number][];
  safetyContract: string;
  operational?: CaptureOperationalStatus;
  errors: string[];
};

export function buildCaptureStatus(input: {
  config: CaptureConfig;
  workspace?: ResolvedWorkspace | null;
  token: TokenStatus;
  errors?: string[];
  operational?: CaptureOperationalStatus;
}): CaptureStatus {
  const errors = input.errors ?? [];
  return {
    ok: errors.length === 0 && input.token.exists && input.token.modeOk && Boolean(input.workspace?.id ?? input.config.workspaceId),
    apiOnly: true,
    apiUrl: input.config.apiUrl,
    repoPath: input.config.repoPath,
    workspaceId: input.workspace?.id ?? input.config.workspaceId ?? null,
    workspaceResolvedBy: input.workspace?.resolvedBy ?? (input.config.workspaceId ? "config" : "unresolved"),
    queuePath: input.config.queuePath,
    mode: input.config.mode,
    ignore: {
      pathCount: input.config.ignore.paths.length,
      builtInPathCount: DEFAULT_CONTEXT_IGNORE_PATHS.length,
      userPathCount: Math.max(0, input.config.ignore.paths.length - DEFAULT_CONTEXT_IGNORE_PATHS.length),
      maxFileBytes: input.config.ignore.maxFileBytes,
      maxEventBytes: input.config.ignore.maxEventBytes,
      ...(input.config.configFiles.captureIgnore ? { captureIgnorePath: input.config.configFiles.captureIgnore } : {}),
    },
    redaction: {
      enabled: input.config.redaction.enabled,
      patternCount: input.config.redaction.patterns.length,
      replacement: input.config.redaction.replacement,
    },
    operatorAutoApprove: input.config.operatorAutoApprove,
    token: input.token,
    commands: [...MVP_COMMANDS],
    safetyContract: CONTEXT_SAFETY_CONTRACT_VERSION,
    ...(input.operational ? { operational: input.operational } : {}),
    errors,
  };
}

export function formatStatusText(status: CaptureStatus): string {
  const lines = [
    "Rorca Capture Status",
    `OK: ${status.ok ? "yes" : "no"}`,
    `Mode: ${status.mode}`,
    `API URL: ${status.apiUrl}`,
    `Repo path: ${status.repoPath}`,
    `Workspace: ${status.workspaceId ?? "unresolved"} (${status.workspaceResolvedBy})`,
    `Queue path: ${status.queuePath}`,
    `Ignore: ${status.ignore.pathCount} paths (${status.ignore.builtInPathCount} built-in, ${status.ignore.userPathCount} user), max file ${status.ignore.maxFileBytes} bytes, max event ${status.ignore.maxEventBytes} bytes`,
    ...(status.ignore.captureIgnorePath ? [`Capture ignore: ${status.ignore.captureIgnorePath}`] : []),
    `Redaction: ${status.redaction.enabled ? "enabled" : "disabled"} (${status.redaction.patternCount} patterns)`,
    `Operator auto-approve: ${status.operatorAutoApprove ? "enabled" : "disabled"}`,
    `MCP token: ${status.token.exists ? status.token.path : "missing"}${status.token.mode ? ` (mode ${status.token.mode})` : ""}`,
    `API-only: ${status.apiOnly ? "yes — writes use POST /api/... with Authorization: Bearer ~/.rorca/mcp-token" : "no"}`,
    `Safety contract: ${status.safetyContract}`,
    `Commands: ${status.commands.join(", ")}`,
  ];

  if (status.operational) {
    const api = status.operational.apiReachability;
    const daemon = status.operational.daemon;
    const cursor = status.operational.cursor;
    const hook = status.operational.hook;
    lines.push(
      `API reachability: ${api.reachable === null ? "unknown" : api.reachable ? "reachable" : "unreachable"}${api.statusCode ? ` (HTTP ${api.statusCode})` : ""}${api.skipped ? " (skipped)" : ""}`,
      `Queue depth: ${status.operational.queue.depth}`,
      `Cursor: ${cursor.lastReconciledSha ?? "none"}${cursor.path ? ` (${cursor.path})` : ""}`,
      `Hook state: ${hook.installed ? (hook.managed ? `managed${hook.mode ? `/${hook.mode}` : ""}` : "unmanaged") : "not installed"}`,
      `Daemon: ${daemon.running ? "running" : "stopped"}${daemon.pid ? ` pid=${daemon.pid}` : ""}${daemon.stale ? " stale" : ""}`,
      `Daemon last seen: ${daemon.lastSeen ?? "never"}`,
      `Daemon errors: consecutive=${daemon.consecutiveErrorCount}${daemon.backoff.active && daemon.backoff.nextRetryAt ? `, backoff until ${daemon.backoff.nextRetryAt}` : ""}`,
      `Last scan: ${formatOperationalTime(daemon.lastScan, "finishedAt")}`,
      `Last flush: ${formatOperationalTime(daemon.lastFlush, "finishedAt")}`,
      `Last error: ${daemon.lastError ?? api.error ?? "none"}`,
    );
  }

  if (status.operational?.apiReachability.error && status.operational.apiReachability.reachable === false) {
    lines.push(`API reachability error: ${status.operational.apiReachability.error}`);
  }

  if (status.errors.length > 0) {
    lines.push("Errors:");
    for (const error of status.errors) {
      lines.push(`- ${error}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function formatOperationalTime(value: Record<string, unknown> | undefined, key: string): string {
  if (!value) return "never";
  const item = value[key];
  return typeof item === "string" && item.length > 0 ? item : "never";
}
