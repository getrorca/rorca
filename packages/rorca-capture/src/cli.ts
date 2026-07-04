#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CaptureNetworkError,
  createApiClient,
  createCaptureClient,
  formatCaptureError,
  inspectMcpToken,
  resolveWorkspace,
  type CaptureFetch,
  type CaptureApiClient,
  type CaptureFlushResult,
  type ResolvedWorkspace,
} from "./api.js";
import { resolveCaptureConfig, type CaptureConfig, type CaptureConfigValues, type CaptureMode } from "./config.js";
import { buildCaptureStatus, formatStatusText, MVP_COMMANDS } from "./status.js";
import {
  CONTEXT_SAFETY_CONTRACT_VERSION,
  enforceContextSizeLimit,
  hashContextContent,
  normalizeContextPath,
  redactContextText,
  shouldCapturePath,
} from "./context-safety.js";

export const HELP_TEXT = `rorca-capture — API-only context capture sidecar for Rorca

Usage:
  rorca-capture <command> [options]
  rorca capture <command> [options]   # thin alias that shells out to rorca-capture

MVP commands:
  remember <text>        Create a pending manual memory candidate through POST /api/memory/candidates
  ingest-commit [hash]   Send one commit ingestion request through the Rorca API
  ingest-git             Request git context ingestion through the Rorca API
  install-hooks          Install local git hooks that call rorca-capture
  daemon                 Run the sidecar daemon contract (MVP status heartbeat)
  status                 Print resolved config, workspace, queue, token, and safety state
  flush                  Replay the local .rorca-capture-queue.jsonl queue safely

Configuration discovery order:
  1. Env vars: RORCA_API_URL, RORCA_WORKSPACE_ID, RORCA_QUEUE_PATH
  2. <git-root>/.rorca/config.json
  3. <git-root>/.rorca/capture.json
  4. Auto-detect git root + default API http://localhost:3030 (local/vm only)

Global options:
  --api-url <url>        Override Rorca API URL for this invocation
  --workspace-id <id>    Override workspace ID for this invocation
  --workspace <id>       Alias for --workspace-id
  --repo-path <path>     Override repository path for this invocation
  --queue-path <path>    Override local queue path for this invocation
  --mode <local|vm|ci>   Set capture mode
  --approve              For remember: approve after submit only when capture config permits operator auto-approval
  --force                For flush: retry entries even when nextRetryAt is in the future or retryable=false
  --ci                   Force CI mode; missing config is a hard error
  --json                 Emit JSON where supported
  -h, --help             Show this help

Remember options:
  --category <name>      Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha
  --title <title>        Candidate title
  --files <paths>        Comma-separated related workspace files (validated before API calls)
  --source <ref>         Explicit source ref for source-key idempotency
  --confidence <level>   high|medium|low
  --trust <tier>         agent_observation|working_note|engineering_decision|approved_policy|verified_fact

API/auth contract:
  rorca-capture never opens a PostgreSQL connection and never reads DATABASE_URL.
  All Rorca writes use POST /api/... with Authorization: Bearer $(cat ~/.rorca/mcp-token).
`;

type CliIO = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

type CliDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: CaptureFetch;
  tokenPath?: string;
  gitRoot?: string | null;
  io?: CliIO;
};

type ParsedArgs = {
  command: string | null;
  rest: string[];
  help: boolean;
  json: boolean;
  ci: boolean;
  overrides: CaptureConfigValues;
};

type Runtime = {
  config: CaptureConfig;
  client: CaptureApiClient;
  workspace: ResolvedWorkspace;
};

const REMEMBER_ENDPOINT = "/api/memory/candidates";
const REMEMBER_SOURCE_SYSTEM = "rorca-capture";
const MEMORY_CANDIDATE_CATEGORIES = ["Architecture", "Convention", "Bug Fix", "Decision", "Pattern", "Gotcha"] as const;
const MEMORY_CANDIDATE_CONFIDENCES = ["high", "medium", "low"] as const;
const CONTEXT_TRUST_TIERS = [
  "agent_observation",
  "working_note",
  "engineering_decision",
  "approved_policy",
  "verified_fact",
] as const;

type MemoryCandidateCategory = typeof MEMORY_CANDIDATE_CATEGORIES[number];
type MemoryCandidateConfidence = typeof MEMORY_CANDIDATE_CONFIDENCES[number];
type ContextTrustTier = typeof CONTEXT_TRUST_TIERS[number];

type RememberOptions = {
  text: string;
  title?: string;
  category: MemoryCandidateCategory;
  context: string;
  rule: string;
  files: string[];
  sourceRef?: string;
  confidence: MemoryCandidateConfidence;
  trustTier: ContextTrustTier;
  approve: boolean;
};

type RememberPayload = {
  workspaceId: string;
  eventType: "manual_cli_note";
  sourceSystem: typeof REMEMBER_SOURCE_SYSTEM;
  sourceRef?: string;
  actor: "local-operator";
  suggestedCategory: MemoryCandidateCategory;
  title: string;
  rule: string;
  context: string;
  relatedFiles: string[];
  confidence: MemoryCandidateConfidence;
  trustTier: ContextTrustTier;
  idempotencyKey: string;
  provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
  requiresReview: true;
};

type RememberApiResponse = {
  candidate?: {
    id?: string;
    reviewStatus?: string;
  };
  created?: boolean;
  idempotent?: boolean;
};

type RememberApproveResponse = {
  candidate?: {
    id?: string;
    reviewStatus?: string;
  };
  approved?: boolean;
  alreadyApproved?: boolean;
};

type RememberResult =
  | { status: "submitted"; candidateId: string | null; created: boolean; idempotent: boolean; approved: boolean; alreadyApproved: boolean; approvalQueued: boolean }
  | { status: "queued"; queuePath: string; idempotencyKey: string; approveRequested: boolean; duplicate: boolean };

export async function runCli(argv = process.argv.slice(2), deps: CliDeps = {}): Promise<number> {
  const io = deps.io ?? { stdout: process.stdout, stderr: process.stderr };
  const parsed = parseArgs(argv);

  if (parsed.help || !parsed.command) {
    io.stdout.write(HELP_TEXT);
    return 0;
  }

  if (!MVP_COMMANDS.includes(parsed.command as typeof MVP_COMMANDS[number])) {
    io.stderr.write(`Unknown rorca-capture command: ${parsed.command}\nRun \"rorca-capture --help\" for usage.\n`);
    return 1;
  }

  try {
    if (parsed.command === "status") {
      return await runStatus(parsed, deps, io);
    }

    if (parsed.command === "install-hooks") {
      const config = resolveCaptureConfig({
        cwd: deps.cwd,
        env: deps.env,
        ci: parsed.ci,
        overrides: parsed.overrides,
        gitRoot: deps.gitRoot,
      });
      installHooks(config);
      io.stdout.write(`Installed rorca-capture git hooks in ${path.join(config.repoPath, ".git", "hooks")}\n`);
      return 0;
    }

    if (parsed.command === "daemon") {
      const statusCode = await runStatus(parsed, deps, io);
      io.stdout.write("Daemon MVP: status heartbeat complete; long-running watcher is reserved for the next implementation slice.\n");
      return statusCode;
    }

    if (parsed.command === "flush") {
      const result = await runFlush(parsed, deps);
      io.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatFlushResult(result));
      return result.failed === 0 ? 0 : 1;
    }

    if (parsed.command === "remember") {
      const result = await runRemember(parsed.rest, parsed, deps);
      io.stdout.write(formatRememberResult(result));
      return 0;
    }

    const runtime = await resolveRuntime(parsed, deps);

    if (parsed.command === "ingest-git") {
      await runtime.client.post(`/api/workspaces/${encodeURIComponent(runtime.workspace.id)}/hydrate`, {
        types: ["git"],
        source: "rorca-capture",
      });
      io.stdout.write("Git ingestion requested through Rorca API.\n");
      return 0;
    }

    if (parsed.command === "ingest-commit") {
      const commit = readOption(parsed.rest, "--commit") ?? firstNonFlag(parsed.rest) ?? "HEAD";
      await runtime.client.post(`/api/workspaces/${encodeURIComponent(runtime.workspace.id)}/hydrate`, {
        types: ["git"],
        commit,
        source: "rorca-capture",
      });
      io.stdout.write(`Commit ingestion requested through Rorca API: ${commit}\n`);
      return 0;
    }

    return 0;
  } catch (error) {
    io.stderr.write(`${formatError(error)}\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const rest: string[] = [];
  const overrides: CaptureConfigValues = {};
  let command: string | null = null;
  let help = false;
  let json = false;
  let ci = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--ci") {
      ci = true;
      overrides.mode = "ci";
      continue;
    }
    if (arg === "--force") {
      rest.push(arg);
      continue;
    }
    if (arg === "--api-url") {
      overrides.apiUrl = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--workspace-id" || arg === "--workspace") {
      overrides.workspaceId = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--repo-path" || arg === "--repo") {
      overrides.repoPath = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--queue-path") {
      overrides.queuePath = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--mode") {
      overrides.mode = requireValue(argv, ++index, arg) as CaptureMode;
      continue;
    }

    if (!command) {
      command = arg;
    } else {
      rest.push(arg);
    }
  }

  return { command, rest, help, json, ci, overrides };
}

async function runStatus(parsed: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const errors: string[] = [];
  const config = resolveCaptureConfig({
    cwd: deps.cwd,
    env: deps.env,
    ci: parsed.ci,
    overrides: parsed.overrides,
    gitRoot: deps.gitRoot,
  });
  const token = inspectMcpToken(deps.tokenPath);
  let workspace: ResolvedWorkspace | null = null;

  if (!token.exists) {
    errors.push("MCP Bearer token missing at ~/.rorca/mcp-token");
  } else if (!token.modeOk) {
    errors.push(`MCP Bearer token mode ${token.mode ?? "unknown"}; expected 600`);
  } else {
    try {
      const client = createApiClient(config, { tokenPath: deps.tokenPath, fetchImpl: deps.fetchImpl });
      workspace = await resolveWorkspace(config, client);
    } catch (error) {
      errors.push(formatError(error));
    }
  }

  const status = buildCaptureStatus({ config, workspace, token, errors });
  io.stdout.write(parsed.json ? `${JSON.stringify(status, null, 2)}\n` : formatStatusText(status));
  return status.ok ? 0 : 1;
}

async function resolveRuntime(parsed: ParsedArgs, deps: CliDeps): Promise<Runtime> {
  const config = resolveCaptureConfig({
    cwd: deps.cwd,
    env: deps.env,
    ci: parsed.ci,
    overrides: parsed.overrides,
    gitRoot: deps.gitRoot,
  });
  const client = createApiClient(config, { tokenPath: deps.tokenPath, fetchImpl: deps.fetchImpl });
  const workspace = await resolveWorkspace(config, client);
  return { config, client, workspace };
}

async function runFlush(parsed: ParsedArgs, deps: CliDeps): Promise<CaptureFlushResult> {
  const config = resolveCaptureConfig({
    cwd: deps.cwd,
    env: deps.env,
    ci: parsed.ci,
    overrides: parsed.overrides,
    gitRoot: deps.gitRoot,
  });
  const client = createCaptureClient(config, { tokenPath: deps.tokenPath, fetchImpl: deps.fetchImpl });
  return await client.flushQueue({ force: parsed.rest.includes("--force") });
}

async function runRemember(args: string[], parsed: ParsedArgs, deps: CliDeps): Promise<RememberResult> {
  const options = parseRememberArgs(args);
  const config = resolveCaptureConfig({
    cwd: deps.cwd,
    env: deps.env,
    ci: parsed.ci,
    overrides: parsed.overrides,
    gitRoot: deps.gitRoot,
  });

  if (options.approve && !config.operatorAutoApprove) {
    throw new Error("--approve requires operatorAutoApprove=true in .rorca/capture.json or RORCA_CAPTURE_OPERATOR_AUTO_APPROVE=true.");
  }

  const relatedFiles = validateRelatedFiles(options.files, config);
  const client = createCaptureClient(config, { tokenPath: deps.tokenPath, fetchImpl: deps.fetchImpl });
  const workspace = await resolveRememberWorkspace(config, client);
  const payload = buildRememberPayload(options, config, workspace.id, relatedFiles);
  const approvalPayload = {
    workspaceId: workspace.id,
    reviewer: "local-operator",
    source: options.sourceRef ?? `rorca-capture:${payload.idempotencyKey}`,
  };

  const submission = await client.submitCandidate<RememberApiResponse>(payload, {
    endpoint: REMEMBER_ENDPOINT,
    approvalEndpointBase: REMEMBER_ENDPOINT,
    approve: options.approve,
    approvalPayload,
    eventType: payload.eventType,
  });

  if (submission.status === "queued") {
    return {
      status: "queued",
      queuePath: submission.queuePath,
      idempotencyKey: payload.idempotencyKey,
      approveRequested: options.approve,
      duplicate: submission.duplicate,
    };
  }

  const response = submission.response;
  const approval = submission.approval as RememberApproveResponse | undefined;
  const candidateId = response.candidate?.id ?? null;

  return {
    status: "submitted",
    candidateId,
    created: response.created !== false,
    idempotent: response.idempotent === true,
    approved: approval?.approved === true,
    alreadyApproved: approval?.alreadyApproved === true,
    approvalQueued: Boolean(submission.approvalQueued),
  };
}

async function resolveRememberWorkspace(config: CaptureConfig, client: CaptureApiClient): Promise<ResolvedWorkspace> {
  try {
    return await resolveWorkspace(config, client);
  } catch (error) {
    if (isOfflineError(error) && config.workspaceId) {
      return {
        id: config.workspaceId,
        path: config.repoPath,
        resolvedBy: "config",
      };
    }
    if (isOfflineError(error)) {
      throw new Error("Rorca API is unreachable and no workspace ID is configured; pass --workspace <id> to queue offline.");
    }
    throw error;
  }
}

function parseRememberArgs(args: string[]): RememberOptions {
  const textParts: string[] = [];
  const files: string[] = [];
  let title: string | undefined;
  let category = "Decision";
  let context = "Captured by rorca-capture sidecar.";
  let rule: string | undefined;
  let sourceRef: string | undefined;
  let confidence = "low";
  let trustTier = "agent_observation";
  let approve = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--approve") {
      approve = true;
      continue;
    }
    if (arg === "--title") {
      title = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--category") {
      category = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--context") {
      context = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--rule") {
      rule = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--source" || arg === "--source-ref") {
      sourceRef = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--confidence") {
      confidence = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--trust" || arg === "--trust-tier") {
      trustTier = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--files" || arg === "--related-files" || arg === "--file") {
      files.push(...splitFiles(requireValue(args, ++index, arg)));
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown remember option: ${arg}`);
    }
    textParts.push(arg);
  }

  const text = textParts.join(" ").trim();
  const resolvedRule = (rule ?? text).trim();
  if (!resolvedRule) {
    throw new Error("remember requires text or --rule.");
  }

  return {
    text,
    ...(title?.trim() ? { title: title.trim() } : {}),
    category: validateEnum(category, MEMORY_CANDIDATE_CATEGORIES, "category"),
    context,
    rule: resolvedRule,
    files,
    ...(sourceRef?.trim() ? { sourceRef: sourceRef.trim() } : {}),
    confidence: validateEnum(confidence, MEMORY_CANDIDATE_CONFIDENCES, "confidence"),
    trustTier: validateEnum(trustTier, CONTEXT_TRUST_TIERS, "trust tier"),
    approve,
  };
}

function buildRememberPayload(options: RememberOptions, config: CaptureConfig, workspaceId: string, relatedFiles: string[]): RememberPayload {
  const rule = redactContextText(options.rule, config.redaction).trim();
  const context = redactContextText(options.context, config.redaction).trim();
  const title = redactContextText(options.title ?? deriveRememberTitle(rule), config.redaction).trim();
  const eventBytes = Buffer.byteLength(JSON.stringify({ title, rule, context, relatedFiles }), "utf8");
  if (!enforceContextSizeLimit(eventBytes, config.ignore, "event")) {
    throw new Error("Remember payload exceeds capture event size limit.");
  }
  const contentHash = hashStable({
    suggestedCategory: options.category,
    title,
    rule,
    context,
    relatedFiles,
  });
  const sourceHash = options.sourceRef
    ? hashStable({ sourceSystem: REMEMBER_SOURCE_SYSTEM, sourceRef: options.sourceRef })
    : undefined;
  const idempotencyMode = options.sourceRef ? "source" : "content";
  const idempotencyKey = options.sourceRef
    ? `memory-candidate:${workspaceId}:source:${sourceHash}`
    : `memory-candidate:${workspaceId}:content:${contentHash}`;

  return {
    workspaceId,
    eventType: "manual_cli_note",
    sourceSystem: REMEMBER_SOURCE_SYSTEM,
    ...(options.sourceRef ? { sourceRef: options.sourceRef } : {}),
    actor: "local-operator",
    suggestedCategory: options.category,
    title,
    rule,
    context,
    relatedFiles,
    confidence: options.confidence,
    trustTier: options.trustTier,
    idempotencyKey,
    provenance: {
      command: "rorca-capture remember",
      sourceSystem: REMEMBER_SOURCE_SYSTEM,
      safetyContract: CONTEXT_SAFETY_CONTRACT_VERSION,
      redactionEnabled: config.redaction.enabled,
      relatedFileValidation: "context-safety",
    },
    metadata: {
      contentHash,
      idempotencyMode,
      approveRequested: options.approve,
      operatorAutoApprove: config.operatorAutoApprove,
      ...(sourceHash ? { sourceHash } : {}),
      textBytes: Buffer.byteLength(options.text || options.rule, "utf8"),
    },
    requiresReview: true,
  };
}

function validateRelatedFiles(files: string[], config: CaptureConfig): string[] {
  const unique = new Set<string>();
  for (const file of files) {
    const raw = file.trim();
    if (!raw) continue;
    const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(config.repoPath, raw);
    const repoRoot = path.resolve(config.repoPath);
    const relative = path.relative(repoRoot, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Related file must stay inside workspace: ${raw}`);
    }
    if (!existsSync(absolute)) {
      throw new Error(`Related file not found: ${raw}`);
    }
    const stats = statSync(absolute);
    if (!stats.isFile()) {
      throw new Error(`Related path is not a file: ${raw}`);
    }
    const normalized = normalizeContextPath(relative);
    if (!shouldCapturePath(normalized, config.ignore)) {
      throw new Error(`Related file is ignored by capture safety rules: ${normalized}`);
    }
    if (!enforceContextSizeLimit(stats.size, config.ignore, "file")) {
      throw new Error(`Related file exceeds capture size limit: ${normalized}`);
    }
    unique.add(normalized);
  }
  return [...unique];
}

function formatRememberResult(result: RememberResult): string {
  if (result.status === "queued") {
    const action = result.duplicate ? "already queued" : "queued";
    return `Rorca API unreachable or unavailable; ${action} memory candidate at ${result.queuePath} (${result.idempotencyKey}).\n`;
  }
  const pieces = [
    result.idempotent ? "Memory candidate already captured" : "Memory candidate submitted",
    result.candidateId ? `id=${result.candidateId}` : null,
    result.approvalQueued ? "approval queued" : result.approved ? (result.alreadyApproved ? "already approved" : "approved") : "pending",
  ].filter(Boolean);
  return `${pieces.join("; ")}\n`;
}

function formatFlushResult(result: CaptureFlushResult): string {
  const lines = [
    `Capture queue flush complete: submitted=${result.submitted}, failed=${result.failed}, skipped=${result.skipped}, remaining=${result.remaining}`,
    `Queue path: ${result.queuePath}`,
  ];
  for (const failure of result.failures) {
    lines.push(`- ${failure.key}: ${failure.message}${failure.retryable ? "" : " (not retryable without --force)"}`);
  }
  return `${lines.join("\n")}\n`;
}

function splitFiles(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function validateEnum<T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  if (allowed.includes(value)) return value as T[number];
  throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
}

function deriveRememberTitle(rule: string): string {
  const normalized = rule.replace(/\s+/g, " ").trim();
  if (normalized.length <= 80) return normalized || "Manual context capture";
  return `${normalized.slice(0, 77).trim()}...`;
}

function hashStable(value: unknown): string {
  return hashContextContent(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isOfflineError(error: unknown): boolean {
  return error instanceof CaptureNetworkError;
}

function installHooks(config: CaptureConfig): void {
  const hooksDir = path.join(config.repoPath, ".git", "hooks");
  if (!existsSync(path.join(config.repoPath, ".git"))) {
    throw new Error(`Cannot install hooks: ${config.repoPath} does not contain a .git directory.`);
  }
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = path.join(hooksDir, "post-commit");
  const hook = `#!/bin/sh\n# Installed by rorca-capture. Thin local hook; all Rorca writes go through the API.\nif command -v rorca-capture >/dev/null 2>&1; then\n  rorca-capture ingest-commit HEAD --repo-path \"${config.repoPath.replace(/"/g, '\\"')}\" >/dev/null 2>&1 || true\nfi\n`;
  writeFileSync(hookPath, hook, "utf8");
  chmodSync(hookPath, 0o755);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function readOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function firstNonFlag(args: string[]): string | undefined {
  return positionalArgs(args)[0];
}

function positionalArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function formatError(error: unknown): string {
  return formatCaptureError(error);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = fileURLToPath(import.meta.url);
if (entryPath === currentPath) {
  runCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
