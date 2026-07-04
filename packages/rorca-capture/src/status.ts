import type { CaptureConfig } from "./config.js";
import type { ResolvedWorkspace, TokenStatus } from "./api.js";
import { CONTEXT_SAFETY_CONTRACT_VERSION } from "./context-safety.js";

export const MVP_COMMANDS = ["remember", "ingest-commit", "ingest-git", "install-hooks", "daemon", "status"] as const;

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
    maxFileBytes: number;
    maxEventBytes: number;
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
  errors: string[];
};

export function buildCaptureStatus(input: {
  config: CaptureConfig;
  workspace?: ResolvedWorkspace | null;
  token: TokenStatus;
  errors?: string[];
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
      maxFileBytes: input.config.ignore.maxFileBytes,
      maxEventBytes: input.config.ignore.maxEventBytes,
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
    `Ignore: ${status.ignore.pathCount} paths, max file ${status.ignore.maxFileBytes} bytes, max event ${status.ignore.maxEventBytes} bytes`,
    `Redaction: ${status.redaction.enabled ? "enabled" : "disabled"} (${status.redaction.patternCount} patterns)`,
    `Operator auto-approve: ${status.operatorAutoApprove ? "enabled" : "disabled"}`,
    `MCP token: ${status.token.exists ? status.token.path : "missing"}${status.token.mode ? ` (mode ${status.token.mode})` : ""}`,
    `API-only: ${status.apiOnly ? "yes — writes use POST /api/... with Authorization: Bearer ~/.rorca/mcp-token" : "no"}`,
    `Safety contract: ${status.safetyContract}`,
    `Commands: ${status.commands.join(", ")}`,
  ];

  if (status.errors.length > 0) {
    lines.push("Errors:");
    for (const error of status.errors) {
      lines.push(`- ${error}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
