import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { DEFAULT_CAPTURE_POLICY, detectAgentBinary as detectCanonicalAgentBinary, hashCaptureContent, isCaptureIgnoredPath, redactCommandText, sanitizeCapturePayload } from "../../../../backend/src/lib/context-safety";
import type { Workspace } from "./types.js";

export type CaptureShell = "zsh" | "bash" | "fish" | "powershell";
export type CapturePolicyMode = "off" | "metadata-only" | "command-summary" | "explicit-transcript-import";
export type ShellCapturePhase = "start" | "end";

export const SHELL_BLOCK_START = "# >>> rorca-capture always-on (managed) >>>";
export const SHELL_BLOCK_END = "# <<< rorca-capture always-on (managed) <<<";
export const SUPPORTED_CAPTURE_SHELLS: CaptureShell[] = ["zsh", "bash", "fish", "powershell"];
export const BUILTIN_AGENT_BINARIES = ["claude", "codex", "opencode", "pi", "aider", "cursor"] as const;

export type AgentDetection = {
  recognized: boolean;
  binary: typeof BUILTIN_AGENT_BINARIES[number] | "custom" | "unknown";
  matchedPattern?: string;
};

export type ShellCaptureEvent = {
  id: string;
  workspaceId: string;
  source: "shellIntegration";
  occurredAt: string;
  payload: {
    eventType: "cli_command" | "shell_command" | "agent_cli_session";
    payload_schema_version: "2026-07-ucc-007.v1";
    source_system: "shell";
    tool_name: string;
    session_id: string;
    host_application: string | null;
    workspace_id: string;
    repo_path_hash: string;
    source_identity: {
      source_system: "shell";
      tool_name: string;
      host_application: string | null;
      session_id: string;
      workspace_id: string;
      repo_path_hash: string;
    };
    phase: ShellCapturePhase;
    policyMode: CapturePolicyMode;
    command_summary: string | null;
    command_hash: string;
    cwd: string | null;
    exit_code: number | null;
    duration_ms: number | null;
    git_branch: string | null;
    git_sha: string | null;
    related_files: Array<{ path: string; role: "mentioned" | null; hash: string | null }>;
    capture_policy: { policy_version: string; mode: CapturePolicyMode; raw_content: "metadata" | "summary" | "explicit" | "off" };
    trust_tier: "local";
    idempotency_key: string;
    provenance: { capture_source: "shellIntegration"; source_event_id: string; adapter_version: string | null; emitted_at: string; received_at: null; local_only: true };
    agent: AgentDetection;
    regulated_signals: string[];
  };
  safety: { contextSafetyModule: "backend/src/lib/context-safety.ts"; policyVersion: string; redactionCount: number; ignoredPathCount: number; truncated: boolean; hashAlgorithm: "sha256"; contentHash: string };
};

export type BuildShellCaptureEventInput = {
  workspaceId: string;
  workspacePath: string;
  command: string;
  cwd: string;
  phase?: ShellCapturePhase;
  exitCode?: number | null;
  durationMs?: number | null;
  occurredAt?: string;
  policyMode?: CapturePolicyMode;
  customAgentPatterns?: string[];
  captureIgnorePatterns?: string[];
  sessionId?: string;
  gitBranch?: string | null;
  gitSha?: string | null;
};

const POLICY_VERSION = DEFAULT_CAPTURE_POLICY.version;
const PAYLOAD_SCHEMA_VERSION = "2026-07-ucc-007.v1";

export function normalizeCaptureShell(value: string | undefined): CaptureShell | undefined {
  const base = path.basename(value || "").toLowerCase();
  if (base === "zsh") return "zsh";
  if (base === "bash" || base === "sh") return "bash";
  if (base === "fish") return "fish";
  if (base === "pwsh" || base === "powershell" || base === "powershell.exe") return "powershell";
  return undefined;
}

export function shellStartupFile(shell: CaptureShell, homeDir: string): string {
  if (shell === "zsh") return path.join(homeDir, ".zshrc");
  if (shell === "bash") return path.join(homeDir, ".bashrc");
  if (shell === "fish") return path.join(homeDir, ".config", "fish", "config.fish");
  return path.join(homeDir, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
}

export function renderShellSnippet(shell: CaptureShell, input: { workspace: Workspace; command?: string; policyMode?: CapturePolicyMode; apiBaseUrl?: string }): string {
  const command = input.command ?? "rorca-capture";
  const policy = input.policyMode ?? "command-summary";
  const apiBaseUrl = input.apiBaseUrl ?? "http://127.0.0.1:3030";
  if (shell === "fish") {
    return `${SHELL_BLOCK_START}\nset -gx RORCA_CAPTURE_WORKSPACE_ID ${fishQuote(input.workspace.id)}\nset -gx RORCA_CAPTURE_WORKSPACE_PATH ${fishQuote(input.workspace.path)}\nset -gx RORCA_CAPTURE_POLICY ${fishQuote(policy)}\nset -gx RORCA_CAPTURE_API_URL ${fishQuote(apiBaseUrl)}\nset -gx __rorca_capture_command \"\"\nset -gx __rorca_capture_started_at 0\nfunction __rorca_capture_preexec --on-event fish_preexec\n  set -gx __rorca_capture_command $argv\n  set -gx __rorca_capture_started_at (date +%s 2>/dev/null; or echo 0)\n  command ${command} emit shell --phase start --workspace-id $RORCA_CAPTURE_WORKSPACE_ID --cwd (pwd) --command "$argv" --policy $RORCA_CAPTURE_POLICY --api-base-url $RORCA_CAPTURE_API_URL >/dev/null 2>&1; or true\nend\nfunction __rorca_capture_postexec --on-event fish_postexec\n  set -l code $status\n  set -l now (date +%s 2>/dev/null; or echo 0)\n  set -l duration_ms (math "($now - $__rorca_capture_started_at) * 1000" 2>/dev/null; or echo 0)\n  command ${command} emit shell --phase end --workspace-id $RORCA_CAPTURE_WORKSPACE_ID --cwd (pwd) --command "$__rorca_capture_command" --exit-code $code --duration-ms $duration_ms --policy $RORCA_CAPTURE_POLICY --api-base-url $RORCA_CAPTURE_API_URL >/dev/null 2>&1; or true\nend\n${SHELL_BLOCK_END}\n`;
  }
  if (shell === "powershell") {
    return `${SHELL_BLOCK_START}\n$env:RORCA_CAPTURE_WORKSPACE_ID = ${psQuote(input.workspace.id)}\n$env:RORCA_CAPTURE_WORKSPACE_PATH = ${psQuote(input.workspace.path)}\n$env:RORCA_CAPTURE_POLICY = ${psQuote(policy)}\n$env:RORCA_CAPTURE_API_URL = ${psQuote(apiBaseUrl)}\n$global:RorcaCaptureLastCommand = $null\n$global:RorcaCaptureStartedAtMs = 0\nSet-PSDebug -Off\nfunction global:prompt {\n  $code = if ($?) { 0 } else { 1 }\n  if ($global:RorcaCaptureLastCommand) { $duration = [Math]::Max(0, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $global:RorcaCaptureStartedAtMs); & ${psQuote(command)} emit shell --phase end --workspace-id $env:RORCA_CAPTURE_WORKSPACE_ID --cwd (Get-Location).Path --command $global:RorcaCaptureLastCommand --exit-code $code --duration-ms $duration --policy $env:RORCA_CAPTURE_POLICY --api-base-url $env:RORCA_CAPTURE_API_URL *> $null }\n  $history = Get-History -Count 1\n  if ($history) { $global:RorcaCaptureLastCommand = $history.CommandLine; $global:RorcaCaptureStartedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); & ${psQuote(command)} emit shell --phase start --workspace-id $env:RORCA_CAPTURE_WORKSPACE_ID --cwd (Get-Location).Path --command $global:RorcaCaptureLastCommand --policy $env:RORCA_CAPTURE_POLICY --api-base-url $env:RORCA_CAPTURE_API_URL *> $null }\n  return \"PS $($executionContext.SessionState.Path.CurrentLocation)> \"\n}\n${SHELL_BLOCK_END}\n`;
  }
  const hook = shell === "zsh" ? "preexec" : "DEBUG trap";
  return `${SHELL_BLOCK_START}\nexport RORCA_CAPTURE_WORKSPACE_ID=${shQuote(input.workspace.id)}\nexport RORCA_CAPTURE_WORKSPACE_PATH=${shQuote(input.workspace.path)}\nexport RORCA_CAPTURE_POLICY=${shQuote(policy)}\nexport RORCA_CAPTURE_API_URL=${shQuote(apiBaseUrl)}\n__rorca_capture_last_command=\"\"\n__rorca_capture_started_at=0\n__rorca_capture_emit_start() {\n  __rorca_capture_last_command=\"$1\"\n  __rorca_capture_started_at=\"$(date +%s 2>/dev/null || echo 0)\"\n  command ${command} emit shell --phase start --workspace-id \"$RORCA_CAPTURE_WORKSPACE_ID\" --cwd \"$PWD\" --command \"$1\" --policy \"$RORCA_CAPTURE_POLICY\" --api-base-url \"$RORCA_CAPTURE_API_URL\" >/dev/null 2>&1 || true\n}\n__rorca_capture_emit_end() {\n  local code=\"$?\"\n  local now duration_ms\n  now=\"$(date +%s 2>/dev/null || echo 0)\"\n  duration_ms=$(( (now - __rorca_capture_started_at) * 1000 ))\n  command ${command} emit shell --phase end --workspace-id \"$RORCA_CAPTURE_WORKSPACE_ID\" --cwd \"$PWD\" --command \"$__rorca_capture_last_command\" --exit-code \"$code\" --duration-ms \"$duration_ms\" --policy \"$RORCA_CAPTURE_POLICY\" --api-base-url \"$RORCA_CAPTURE_API_URL\" >/dev/null 2>&1 || true\n  return \"$code\"\n}\n# ${hook}\n${shell === "zsh" ? "preexec() { __rorca_capture_emit_start \"$1\"; }\nprecmd() { __rorca_capture_emit_end; }" : "trap '__rorca_capture_emit_start \"$BASH_COMMAND\"' DEBUG\nPROMPT_COMMAND=\"__rorca_capture_emit_end${PROMPT_COMMAND:+;$PROMPT_COMMAND}\""}\n${SHELL_BLOCK_END}\n`;
}

export function managedSourceBlock(shell: CaptureShell, snippetPath: string): string {
  const body = shell === "fish"
    ? `source ${fishQuote(snippetPath)}`
    : shell === "powershell"
      ? `. ${psQuote(snippetPath)}`
      : `. ${shQuote(snippetPath)}`;
  return `${SHELL_BLOCK_START}\n# Rorca command metadata capture; remove with rorca-capture setup --uninstall.\n${body}\n${SHELL_BLOCK_END}\n`;
}

export function installManagedShellBlock(filePath: string, block: string, dryRun = false): "installed" | "skipped" | "would-install" {
  const current = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  if (current.includes(SHELL_BLOCK_START) && current.includes(SHELL_BLOCK_END)) return "skipped";
  if (dryRun) return "would-install";
  mkdirSync(path.dirname(filePath), { recursive: true });
  const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
  writeFileSync(filePath, `${prefix}${prefix ? "\n" : ""}${block}`, "utf8");
  return "installed";
}

export function uninstallManagedShellBlock(filePath: string, dryRun = false): "removed" | "skipped" | "would-remove" {
  if (!existsSync(filePath)) return "skipped";
  const current = readFileSync(filePath, "utf8");
  const next = current.replace(new RegExp(`\\n?${escapeRegex(SHELL_BLOCK_START)}[\\s\\S]*?${escapeRegex(SHELL_BLOCK_END)}\\n?`, "g"), "\n").replace(/\n{3,}/g, "\n\n");
  if (next === current) return "skipped";
  if (dryRun) return "would-remove";
  writeFileSync(filePath, next, "utf8");
  return "removed";
}

export function readCaptureIgnorePatterns(workspacePath: string): string[] {
  const file = path.join(workspacePath, ".rorca-captureignore");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

export function detectAgentBinary(command: string, customPatterns: string[] = []): AgentDetection {
  return detectCanonicalAgentBinary(command, customPatterns) as AgentDetection;
}

export function buildShellCaptureEvent(input: BuildShellCaptureEventInput): ShellCaptureEvent | null {
  const policyMode = input.policyMode ?? "metadata-only";
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const ignorePatterns = input.captureIgnorePatterns ?? readCaptureIgnorePatterns(input.workspacePath);
  if (policyMode === "off" || isCaptureIgnoredPath(input.cwd, input.workspacePath, ignorePatterns)) return null;
  const redacted = redactCommandText(input.command, { workspacePath: input.workspacePath, captureIgnorePatterns: ignorePatterns });
  const agent = detectAgentBinary(input.command, input.customAgentPatterns);
  const phase = input.phase ?? "end";
  const sessionId = input.sessionId ?? process.env.RORCA_CAPTURE_SESSION_ID ?? "shell";
  const toolName = agent.recognized ? agent.binary : "shell";
  const repoPathHash = `sha256:${sha256(path.resolve(input.workspacePath))}`;
  const commandHash = hashCaptureContent(input.command);
  const eventId = `shell:${sha256(`${input.workspaceId}|${occurredAt}|${phase}|${input.command}|${input.exitCode ?? ""}`).slice(0, 24)}`;
  const rawContent = policyMode === "explicit-transcript-import" ? "explicit" : policyMode === "command-summary" ? "summary" : "metadata";
  const idempotencyKey = `sha256:${sha256(JSON.stringify([agent.recognized ? "agent_cli_session" : "cli_command", "shell", sessionId, input.workspaceId, occurredAt, phase, commandHash, input.exitCode ?? null]))}`;
  const payload: ShellCaptureEvent["payload"] = {
    eventType: agent.recognized ? "agent_cli_session" : "cli_command",
    payload_schema_version: PAYLOAD_SCHEMA_VERSION,
    source_system: "shell",
    tool_name: toolName,
    session_id: sessionId,
    host_application: null,
    workspace_id: input.workspaceId,
    repo_path_hash: repoPathHash,
    source_identity: {
      source_system: "shell",
      tool_name: toolName,
      host_application: null,
      session_id: sessionId,
      workspace_id: input.workspaceId,
      repo_path_hash: repoPathHash,
    },
    phase,
    policyMode,
    command_summary: policyMode === "metadata-only" ? null : redacted.text,
    command_hash: commandHash,
    cwd: input.cwd && isCaptureIgnoredPath(input.cwd, input.workspacePath, ignorePatterns) ? "[REDACTED_PATH]" : input.cwd,
    exit_code: Number.isFinite(input.exitCode ?? NaN) ? Number(input.exitCode) : null,
    duration_ms: Number.isFinite(input.durationMs ?? NaN) ? Number(input.durationMs) : null,
    git_branch: input.gitBranch ?? null,
    git_sha: input.gitSha ?? null,
    related_files: [],
    capture_policy: { policy_version: POLICY_VERSION, mode: policyMode, raw_content: rawContent },
    trust_tier: "local",
    idempotency_key: idempotencyKey,
    provenance: { capture_source: "shellIntegration", source_event_id: eventId, adapter_version: null, emitted_at: occurredAt, received_at: null, local_only: true },
    agent,
    regulated_signals: redacted.regulatedSignals,
  };
  const sanitized = sanitizeCapturePayload(payload);
  return {
    id: eventId,
    workspaceId: input.workspaceId,
    source: "shellIntegration",
    occurredAt,
    payload,
    safety: {
      ...sanitized.safety,
      redactionCount: sanitized.safety.redactionCount + redacted.redactionCount,
      ignoredPathCount: sanitized.safety.ignoredPathCount + redacted.ignoredPathCount,
      truncated: sanitized.safety.truncated || redacted.truncated,
    },
  };
}

export function enqueueShellCaptureEvent(queuePath: string, event: ShellCaptureEvent): void {
  mkdirSync(queuePath, { recursive: true });
  const file = path.join(queuePath, "offline.ndjson");
  writeFileSync(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
}

export async function postShellCaptureEvent(input: { apiBaseUrl: string; event: ShellCaptureEvent; fetchImpl?: typeof fetch }): Promise<boolean> {
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${input.apiBaseUrl.replace(/\/$/, "")}/api/context-capture/events`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: input.event.workspaceId, source: input.event.source, occurredAt: input.event.occurredAt, policyMode: input.event.payload.policyMode, payload: input.event.payload }),
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function appendQueuedEvent(queuePath: string, event: ShellCaptureEvent): void {
  enqueueShellCaptureEvent(queuePath, event);
}

export function rewriteQueuedEvents(queuePath: string, events: ShellCaptureEvent[]): void {
  mkdirSync(queuePath, { recursive: true });
  const file = path.join(queuePath, "offline.ndjson");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""), "utf8");
  renameSync(tmp, file);
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fishQuote(value: string): string {
  return `'${value.replace(/'/g, `\\'`)}'`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
