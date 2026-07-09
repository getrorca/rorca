#!/usr/bin/env node

/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CaptureApiError,
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
  type ReusableCaptureClient,
} from "./api.js";
import { resolveCaptureConfig, type CaptureConfig, type CaptureConfigValues, type CaptureMode } from "./config.js";
import { buildCaptureStatus, formatStatusText, MVP_COMMANDS } from "./status.js";
import {
  DEFAULT_DAEMON_INTERVAL_MS,
  DEFAULT_DAEMON_MAX_COMMITS_PER_SCAN,
  DEFAULT_DAEMON_MAX_CONCURRENT_SUBMISSIONS,
  buildOperationalStatus,
  runCaptureDaemon,
  runDaemonScanOnce,
  stopCaptureDaemon,
  type CaptureDaemonAction,
} from "./daemon.js";
import {
  CONTEXT_SAFETY_CONTRACT_VERSION,
  analyzeContextSafety,
  enforceContextSizeLimit,
  hashContextContent,
  normalizeContextPath,
  redactContextText,
  shouldCapturePath,
} from "./context-safety.js";
import {
  buildGitCommitContextEvent,
  extractLastRorcaRunFinishedAt,
  readGitCommit,
  resolveGitRange,
  resolveGitRangeSinceTimestamp,
  type BuiltGitCommitEvent,
  type LastRorcaRunPointer,
} from "./git-ingest.js";
import {
  PR_INGEST_ENDPOINT,
  buildPrMemoryCandidatePayload,
  isPrIngestDuplicateResponse,
  parsePrIngestInput,
} from "./pr-ingest.js";
import {
  DUCKBRAIN_IMPORT_ENDPOINT,
  DUCKBRAIN_IMPORT_EVENT_TYPE,
  importDuckBrainJsonlFile,
  isDuckBrainImportDuplicateResponse,
  type DuckBrainImportSummary,
} from "./duckbrain-import.js";

export const HELP_TEXT = `rorca-capture — API-only context capture sidecar for Rorca

Usage:
  rorca-capture <command> [options]
  rorca capture <command> [options]   # thin alias that shells out to rorca-capture

MVP commands:
  remember <text>        Create a pending manual memory candidate through POST /api/memory/candidates
  import-duckbrain <path> Import selected DuckBrain JSONL memories as pending memory candidates
  ingest-pr              CI mode: submit a pending PR merge/release/hotfix memory candidate
  ingest-commit [hash]   Send one commit ingestion request through the Rorca API
  ingest-git             Request git context ingestion through the Rorca API
  install-hooks          Install/update local git hooks that call rorca-capture; pass --uninstall to remove them
  daemon                 Reconcile git commits in daemon mode; use --scan-once, --status, or --stop for operator control
  status                 Print resolved config, workspace, queue, daemon, API reachability, token, and safety state
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
  --strict               For install-hooks: fail the hook when Rorca capture cannot complete
  --uninstall            For install-hooks: remove the managed hook and restore any prior hook
  --dry-run              For import/ingest/daemon commands: inspect inputs without API writes, queue changes, or cursor advancement
  --ci                   Force CI mode; missing config is a hard error
  --json                 Emit JSON where supported
  -h, --help             Show this help

Daemon options:
  --scan-once            Run one reconciliation scan and exit
  --status               Print daemon status without starting the daemon
  --stop                 Stop the recorded daemon PID and mark status stopped
  --interval <seconds>   Scan interval for foreground daemon mode (default 30)
  --interval-ms <ms>     Scan interval in milliseconds
  --max-commits-per-scan <n>  Bound commits scanned per interval (default 50)
  --max-concurrency <n>  Bound concurrent API submissions (default 2)

PR ingest options (input precedence: flags > JSON file > environment variables):
  --input <path>         Read PR metadata JSON (alias: --json-file, --metadata-file)
  --provider <name>      VCS provider (e.g. github, gitlab)
  --repo <owner/name>    Repository identifier
  --pr-number <number>   Pull request number
  --pr-url <url>         Pull request URL
  --merge-sha <sha>      Merge commit SHA (used with CI run id for UUIDv5 idempotency)
  --author <name>        PR author/login
  --title <title>        PR title
  --body <text>          PR body/description (redacted before submission)
  --changed-files <csv>  Comma- or newline-separated changed files validated by context-safety
  --ci-run-id <id>       CI run id (required; used with merge SHA for deterministic UUIDv5 idempotency)
  --ci-run-url <url>     CI run URL
  --ci-provider <name>   CI provider (defaults from provider/env when omitted)
  --ci-workflow <name>   CI workflow/pipeline name
  --ci-job <name>        CI job name
  --event-kind <kind>    pr_merge|release|hotfix (stored in metadata; candidate eventType remains pr_merge)

Git ingest options:
  --commit <sha>         For ingest-commit: explicit commit ref (default positional or HEAD)
  --since <ref>          For ingest-git: scan <ref>..HEAD, or use last-rorca-run

Remember options:
  --category <name>      Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha
  --title <title>        Candidate title
  --files <paths>        Comma-separated related workspace files (validated before API calls)
  --source <ref>         Explicit source ref for source-key idempotency
  --confidence <level>   high|medium|low
  --trust <tier>         agent_observation|working_note|engineering_decision|approved_policy|verified_fact

DuckBrain import options:
  --path <path>          JSONL file path (alternative to positional path)
  --filter <query>       Import only matching records; supports namespace:, key:, tag:, content:, metadata:
  --namespace <value>    Alias for --filter namespace:<value>
  --key <value>          Alias for --filter key:<value>
  --tag <value>          Alias for --filter tag:<value>

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
  dryRun: boolean;
  ci: boolean;
  strict: boolean;
  uninstallHooks: boolean;
  overrides: CaptureConfigValues;
};

type Runtime = {
  config: CaptureConfig;
  client: CaptureApiClient;
  workspace: ResolvedWorkspace;
};

type IngestRuntime = {
  config: CaptureConfig;
  client: ReusableCaptureClient;
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
  securitySensitive: boolean;
  regulatedDomain: boolean;
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

type PrIngestApiResponse = {
  candidate?: {
    id?: string | number;
    reviewStatus?: string;
  };
  created?: boolean;
  idempotent?: boolean;
};

type DuckBrainImportApiResponse = {
  candidate?: {
    id?: string | number;
    reviewStatus?: string;
  };
  created?: boolean;
  idempotent?: boolean;
};

type DuckBrainImportCliOptions = {
  path: string;
  filters: string[];
};

type PrIngestStatus = "submitted" | "queued" | "duplicate" | "dry-run";

type PrIngestResult = {
  command: "ingest-pr";
  workspaceId: string;
  repoPath: string;
  dryRun: boolean;
  status: PrIngestStatus;
  candidateId?: string | null;
  created?: boolean;
  idempotent?: boolean;
  queuePath?: string;
  idempotencyKey: string;
  sourceRef: string;
  pr: {
    provider: string;
    repo: string;
    number: number;
    mergeSha: string;
    url?: string;
  };
  ci: {
    provider: string;
    runId: string;
    runUrl?: string;
    workflow?: string;
    job?: string;
  };
  relatedFiles: string[];
  ignoredFiles: Array<{ path: string; reason: string }>;
  contentHash: string;
  securitySensitive: boolean;
  regulatedDomain: boolean;
  pendingReview: true;
  requiresReview: true;
};

type GitIngestItemStatus = "submitted" | "queued" | "duplicate" | "skipped-noise" | "dry-run";

type GitIngestItemResult = {
  sha: string;
  shortSha: string;
  subject: string;
  status: GitIngestItemStatus;
  idempotencyKey: string;
  relatedFiles: string[];
  candidateCount: number;
  noiseReason?: string;
  queuePath?: string;
  eventId?: string | null;
};

type GitIngestResult = {
  command: "ingest-commit" | "ingest-git";
  workspaceId: string;
  repoPath: string;
  dryRun: boolean;
  since?: string;
  resolvedSince?: string;
  total: number;
  planned: number;
  submitted: number;
  queued: number;
  skippedNoise: number;
  duplicate: number;
  candidatesSubmitted: number;
  candidatesQueued: number;
  candidatesDuplicate: number;
  items: GitIngestItemResult[];
};

type GitIngestOptions = {
  dryRun: boolean;
};

type DaemonCliOptions = {
  action: CaptureDaemonAction;
  intervalMs: number;
  maxCommitsPerScan: number;
  maxConcurrentSubmissions: number;
};

type ContextEventApiResponse = {
  event?: {
    id?: string | number;
  };
  created?: boolean;
  idempotent?: boolean;
};

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
      return await runInstallHooks(parsed, deps, io);
    }

    if (parsed.command === "daemon") {
      return await runDaemonCommand(parsed, deps, io);
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

    if (parsed.command === "import-duckbrain") {
      const result = await runImportDuckBrain(parsed, deps);
      io.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatDuckBrainImportResult(result));
      return 0;
    }

    if (parsed.command === "ingest-pr") {
      const result = await runIngestPr(parsed, deps);
      io.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatPrIngestResult(result));
      return result.status === "duplicate" ? 2 : 0;
    }

    if (parsed.command === "ingest-git") {
      const result = await runIngestGit(parsed, deps);
      io.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatGitIngestResult(result));
      return 0;
    }

    if (parsed.command === "ingest-commit") {
      const result = await runIngestCommit(parsed, deps);
      io.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatGitIngestResult(result));
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
  let dryRun = false;
  let ci = false;
  let strict = false;
  let uninstallHooks = false;

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
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--ci") {
      ci = true;
      overrides.mode = "ci";
      continue;
    }
    if (arg === "--strict") {
      strict = true;
      continue;
    }
    if (arg === "--uninstall") {
      uninstallHooks = true;
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
    if (arg === "--repo-path") {
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

  return { command, rest, help, json, dryRun, ci, strict, uninstallHooks, overrides };
}

function resolveCliTokenPath(deps: CliDeps): string | undefined {
  const env = deps.env ?? process.env;
  return deps.tokenPath ?? env.RORCA_MCP_TOKEN_PATH;
}

function resolveCliHomeDir(deps: CliDeps): string | undefined {
  return (deps.env ?? process.env).HOME;
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
  const tokenPath = resolveCliTokenPath(deps);
  const token = inspectMcpToken(tokenPath);
  let workspace: ResolvedWorkspace | null = null;

  if (!token.exists) {
    errors.push("MCP Bearer token missing at ~/.rorca/mcp-token");
  } else if (!token.modeOk) {
    errors.push(`MCP Bearer token mode ${token.mode ?? "unknown"}; expected 600`);
  } else {
    try {
      const client = createApiClient(config, { tokenPath, fetchImpl: deps.fetchImpl });
      workspace = await resolveWorkspace(config, client);
    } catch (error) {
      errors.push(formatError(error));
    }
  }

  const operational = await buildOperationalStatus({
    config,
    workspaceId: workspace?.id ?? config.workspaceId ?? null,
    fetchImpl: deps.fetchImpl,
    dryRun: parsed.dryRun,
    homeDir: resolveCliHomeDir(deps),
  });
  const status = buildCaptureStatus({ config, workspace, token, operational, errors });
  io.stdout.write(parsed.json ? `${JSON.stringify(status, null, 2)}\n` : formatStatusText(status));
  return status.ok ? 0 : 1;
}

async function runInstallHooks(parsed: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const runtime = await resolveRuntime(parsed, deps);
  if (parsed.uninstallHooks) {
    const result = uninstallHooks(runtime.workspace);
    const action = result.restored ? "restored previous hook" : "removed managed hook";
    io.stdout.write(`Uninstalled rorca-capture post-commit hook in ${path.dirname(result.hookPath)} (${action}).\n`);
    return 0;
  }

  const result = installHooks(runtime.config, runtime.workspace, { strict: parsed.strict });
  const mode = parsed.strict ? "strict" : "best-effort";
  io.stdout.write(`Installed rorca-capture post-commit hook in ${path.dirname(result.hookPath)} (${mode}).\n`);
  if (parsed.strict) {
    io.stderr.write("Warning: strict rorca-capture hook mode enabled; commits will fail if Rorca capture is unreachable or exits non-zero.\n");
  }
  return 0;
}

async function resolveRuntime(parsed: ParsedArgs, deps: CliDeps): Promise<Runtime> {
  const config = resolveCaptureConfig({
    cwd: deps.cwd,
    env: deps.env,
    ci: parsed.ci,
    overrides: parsed.overrides,
    gitRoot: deps.gitRoot,
  });
  const client = createApiClient(config, { tokenPath: resolveCliTokenPath(deps), fetchImpl: deps.fetchImpl });
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
  const client = createCaptureClient(config, { tokenPath: resolveCliTokenPath(deps), fetchImpl: deps.fetchImpl });
  return await client.flushQueue({ force: parsed.rest.includes("--force") });
}

async function runDaemonCommand(parsed: ParsedArgs, deps: CliDeps, io: CliIO): Promise<number> {
  const daemonOptions = parseDaemonArgs(parsed.rest);
  const config = resolveCaptureConfig({
    cwd: deps.cwd,
    env: deps.env,
    ci: parsed.ci,
    overrides: parsed.overrides,
    gitRoot: deps.gitRoot,
  });
  const homeDir = resolveCliHomeDir(deps);

  if (daemonOptions.action === "status") {
    const operational = await buildOperationalStatus({
      config,
      workspaceId: config.workspaceId ?? null,
      fetchImpl: deps.fetchImpl,
      dryRun: parsed.dryRun,
      homeDir,
    });
    io.stdout.write(parsed.json ? `${JSON.stringify(operational, null, 2)}\n` : formatDaemonStatusText(config, operational));
    return 0;
  }

  if (daemonOptions.action === "stop") {
    const workspaceId = config.workspaceId;
    if (!workspaceId) {
      throw new Error("daemon --stop requires --workspace <id> or RORCA_WORKSPACE_ID so the PID file can be located.");
    }
    const result = stopCaptureDaemon(workspaceId, homeDir);
    io.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.message}\nStatus path: ${result.statusPath}\n`);
    return 0;
  }

  if (daemonOptions.action === "scan-once") {
    const result = await runDaemonScanOnce({
      config,
      tokenPath: resolveCliTokenPath(deps),
      fetchImpl: deps.fetchImpl,
      dryRun: parsed.dryRun,
      intervalMs: daemonOptions.intervalMs,
      maxCommitsPerScan: daemonOptions.maxCommitsPerScan,
      maxConcurrentSubmissions: daemonOptions.maxConcurrentSubmissions,
      homeDir,
    });
    io.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatDaemonScanResult(result));
    return result.scan.failed === 0 ? 0 : 1;
  }

  await runCaptureDaemon({
    config,
    tokenPath: resolveCliTokenPath(deps),
    fetchImpl: deps.fetchImpl,
    dryRun: parsed.dryRun,
    intervalMs: daemonOptions.intervalMs,
    maxCommitsPerScan: daemonOptions.maxCommitsPerScan,
    maxConcurrentSubmissions: daemonOptions.maxConcurrentSubmissions,
    homeDir,
    logger: (entry) => io.stderr.write(`${JSON.stringify(entry)}\n`),
  });
  return 0;
}

function parseDaemonArgs(args: string[]): DaemonCliOptions {
  let action: CaptureDaemonAction = "run";
  let intervalMs = DEFAULT_DAEMON_INTERVAL_MS;
  let maxCommitsPerScan = DEFAULT_DAEMON_MAX_COMMITS_PER_SCAN;
  let maxConcurrentSubmissions = DEFAULT_DAEMON_MAX_CONCURRENT_SUBMISSIONS;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scan-once" || arg === "--once") {
      action = "scan-once";
      continue;
    }
    if (arg === "--status") {
      action = "status";
      continue;
    }
    if (arg === "--stop") {
      action = "stop";
      continue;
    }
    if (arg === "--start") {
      action = "run";
      continue;
    }
    if (arg === "--interval") {
      intervalMs = parsePositiveInt(requireValue(args, ++index, arg), arg) * 1000;
      continue;
    }
    if (arg === "--interval-ms") {
      intervalMs = parsePositiveInt(requireValue(args, ++index, arg), arg);
      continue;
    }
    if (arg === "--max-commits-per-scan" || arg === "--max-commits") {
      maxCommitsPerScan = parsePositiveInt(requireValue(args, ++index, arg), arg);
      continue;
    }
    if (arg === "--max-concurrency" || arg === "--max-concurrent-submissions") {
      maxConcurrentSubmissions = parsePositiveInt(requireValue(args, ++index, arg), arg);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown daemon option: ${arg}`);
    }
    throw new Error(`Unexpected daemon argument: ${arg}`);
  }

  return { action, intervalMs, maxCommitsPerScan, maxConcurrentSubmissions };
}

function formatDaemonStatusText(config: CaptureConfig, status: Awaited<ReturnType<typeof buildOperationalStatus>>): string {
  const daemon = status.daemon;
  const api = status.apiReachability;
  return [
    "Rorca Capture Daemon Status",
    `API URL: ${config.apiUrl}`,
    `API reachability: ${api.reachable === null ? "unknown" : api.reachable ? "reachable" : "unreachable"}${api.statusCode ? ` (HTTP ${api.statusCode})` : ""}${api.skipped ? " (skipped)" : ""}`,
    `Queue path: ${status.queue.path}`,
    `Queue depth: ${status.queue.depth}`,
    `Cursor: ${status.cursor.lastReconciledSha ?? "none"}${status.cursor.path ? ` (${status.cursor.path})` : ""}`,
    `Hook state: ${status.hook.installed ? (status.hook.managed ? `managed/${status.hook.mode ?? "unknown"}` : "unmanaged") : "not installed"}`,
    `Daemon: ${daemon.running ? "running" : "stopped"}${daemon.pid ? ` pid=${daemon.pid}` : ""}${daemon.stale ? " stale" : ""}`,
    `Daemon worker_id: ${daemon.workerId ?? "unresolved"}`,
    `Daemon last_seen: ${daemon.lastSeen ?? "never"}`,
    `Consecutive errors: ${daemon.consecutiveErrorCount}`,
    `Backoff: ${daemon.backoff.active ? `active until ${daemon.backoff.nextRetryAt ?? "unknown"}` : "inactive"}`,
    `Last scan: ${daemon.lastScan && typeof daemon.lastScan.finishedAt === "string" ? daemon.lastScan.finishedAt : "never"}`,
    `Last flush: ${daemon.lastFlush && typeof daemon.lastFlush.finishedAt === "string" ? daemon.lastFlush.finishedAt : "never"}`,
    `Last error: ${daemon.lastError ?? api.error ?? "none"}`,
  ].join("\n") + "\n";
}

function formatDaemonScanResult(result: Awaited<ReturnType<typeof runDaemonScanOnce>>): string {
  const scan = result.scan;
  const lines = [
    `Daemon scan complete: submitted=${scan.submitted}, queued=${scan.queued}, duplicate=${scan.duplicate}, skipped-noise=${scan.skippedNoise}, dry-run=${scan.dryRun}, failed=${scan.failed}, planned=${scan.planned}`,
    `Workspace: ${result.workspaceId}`,
    `Cursor: ${result.cursorAfter ?? "none"}`,
    `Queue depth: ${result.queueDepth}`,
    `API reachability: ${result.apiReachability.reachable === null ? "unknown" : result.apiReachability.reachable ? "reachable" : "unreachable"}`,
    `Status path: ${result.statusPath}`,
  ];
  if (result.flush) {
    lines.push(`Flush: submitted=${result.flush.submitted}, failed=${result.flush.failed}, skipped=${result.flush.skipped}, remaining=${result.flush.remaining}`);
  }
  if (result.lastError) {
    lines.push(`Last error: ${result.lastError}`);
  }
  return `${lines.join("\n")}\n`;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return parsed;
}

async function runIngestPr(parsed: ParsedArgs, deps: CliDeps): Promise<PrIngestResult> {
  const input = parsePrIngestInput(parsed.rest, deps.env ?? process.env);
  const runtime = await resolveIngestRuntime(parsed, deps, { allowDryRunWithoutApi: true });
  const built = buildPrMemoryCandidatePayload(input, runtime.config, runtime.workspace.id);
  const base = buildPrIngestResultBase(runtime, built, parsed.dryRun);

  if (parsed.dryRun) {
    return { ...base, status: "dry-run" };
  }

  try {
    const submission = await runtime.client.submitCandidate<PrIngestApiResponse>(built.payload, {
      endpoint: PR_INGEST_ENDPOINT,
      eventType: built.payload.eventType,
      contentFingerprint: built.contentHash,
    });

    if (submission.status === "queued") {
      return {
        ...base,
        status: submission.duplicate ? "duplicate" : "queued",
        queuePath: submission.queuePath,
        idempotent: submission.duplicate,
      };
    }

    const response = submission.response;
    if (isPrIngestDuplicateResponse(response)) {
      return {
        ...base,
        status: "duplicate",
        candidateId: extractPrCandidateId(response),
        created: response.created !== false,
        idempotent: true,
      };
    }

    return {
      ...base,
      status: "submitted",
      candidateId: extractPrCandidateId(response),
      created: response.created !== false,
      idempotent: response.idempotent === true,
    };
  } catch (error) {
    if (error instanceof CaptureApiError && error.statusCode === 409) {
      return {
        ...base,
        status: "duplicate",
        created: false,
        idempotent: true,
      };
    }
    throw error;
  }
}

function buildPrIngestResultBase(
  runtime: IngestRuntime,
  built: ReturnType<typeof buildPrMemoryCandidatePayload>,
  dryRun: boolean,
): Omit<PrIngestResult, "status" | "candidateId" | "created" | "idempotent" | "queuePath"> {
  return {
    command: "ingest-pr",
    workspaceId: runtime.workspace.id,
    repoPath: runtime.config.repoPath,
    dryRun,
    idempotencyKey: built.idempotencyKey,
    sourceRef: built.payload.sourceRef,
    pr: {
      provider: built.input.provider,
      repo: built.input.repo,
      number: built.input.prNumber,
      mergeSha: built.input.mergeSha,
      ...(built.input.prUrl ? { url: built.input.prUrl } : {}),
    },
    ci: {
      provider: built.input.ci.provider,
      runId: built.input.ci.runId,
      ...(built.input.ci.runUrl ? { runUrl: built.input.ci.runUrl } : {}),
      ...(built.input.ci.workflow ? { workflow: built.input.ci.workflow } : {}),
      ...(built.input.ci.job ? { job: built.input.ci.job } : {}),
    },
    relatedFiles: built.relatedFiles,
    ignoredFiles: built.changedFiles
      .filter((file) => !file.captured)
      .map((file) => ({ path: file.path, reason: file.ignoredReason ?? "path-ignored" })),
    contentHash: built.contentHash,
    securitySensitive: built.payload.securitySensitive,
    regulatedDomain: built.payload.regulatedDomain,
    pendingReview: true,
    requiresReview: true,
  };
}

function extractPrCandidateId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const candidate = (response as { candidate?: unknown }).candidate;
  if (!candidate || typeof candidate !== "object") return null;
  const id = (candidate as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
}

function formatPrIngestResult(result: PrIngestResult): string {
  const prefix = result.status === "dry-run"
    ? "Dry-run PR ingestion"
    : result.status === "queued"
      ? "Queued PR ingestion"
      : result.status === "duplicate"
        ? "Duplicate PR ingestion"
        : "PR ingestion";
  const candidate = result.candidateId ? `, candidate=${result.candidateId}` : "";
  const queue = result.queuePath ? `, queue=${result.queuePath}` : "";
  return `${prefix}: status=${result.status}, workspace=${result.workspaceId}, pr=${result.pr.provider}/${result.pr.repo}#${result.pr.number}, merge=${result.pr.mergeSha}, ci=${result.ci.provider}/${result.ci.runId}, related-files=${result.relatedFiles.length}, ignored-files=${result.ignoredFiles.length}, pending-review=yes, idempotency=${result.idempotencyKey}${candidate}${queue}\n`;
}

async function runIngestCommit(parsed: ParsedArgs, deps: CliDeps): Promise<GitIngestResult> {
  const commitRef = parseIngestCommitRef(parsed.rest);
  const runtime = await resolveIngestRuntime(parsed, deps, { allowDryRunWithoutApi: true });
  const item = await ingestCommitRef(runtime, commitRef, { dryRun: parsed.dryRun });
  return buildGitIngestResult("ingest-commit", runtime, parsed.dryRun, [item]);
}

async function runIngestGit(parsed: ParsedArgs, deps: CliDeps): Promise<GitIngestResult> {
  const since = parseIngestGitSince(parsed.rest);
  const runtime = await resolveIngestRuntime(parsed, deps, { allowDryRunWithoutApi: since !== "last-rorca-run" });
  let refs: string[];
  let resolvedSince: string | undefined;

  if (since === "last-rorca-run") {
    const pointer = await runtime.client.get<LastRorcaRunPointer>(
      `/api/workspaces/${encodeURIComponent(runtime.workspace.id)}/capture/last-rorca-run`,
    );
    const finishedAt = extractLastRorcaRunFinishedAt(pointer);
    if (!finishedAt) {
      throw new Error(`No completed Rorca pipeline run found for workspace '${runtime.workspace.id}'. Run a pipeline successfully first or pass --since <git-ref>.`);
    }
    const range = resolveGitRangeSinceTimestamp(runtime.config.repoPath, finishedAt);
    refs = range.shas;
    resolvedSince = range.baseRef ?? `timestamp:${finishedAt}`;
  } else {
    refs = resolveGitRange(runtime.config.repoPath, since);
    resolvedSince = since;
  }

  const items: GitIngestItemResult[] = [];
  for (const ref of refs) {
    items.push(await ingestCommitRef(runtime, ref, { dryRun: parsed.dryRun }));
  }
  return buildGitIngestResult("ingest-git", runtime, parsed.dryRun, items, since, resolvedSince);
}

async function resolveIngestRuntime(
  parsed: ParsedArgs,
  deps: CliDeps,
  options: { allowDryRunWithoutApi?: boolean } = {},
): Promise<IngestRuntime> {
  const config = resolveCaptureConfig({
    cwd: deps.cwd,
    env: deps.env,
    ci: parsed.ci,
    overrides: parsed.overrides,
    gitRoot: deps.gitRoot,
  });

  if (parsed.dryRun && options.allowDryRunWithoutApi && config.workspaceId) {
    return {
      config,
      client: undefined as unknown as ReusableCaptureClient,
      workspace: {
        id: config.workspaceId,
        path: config.repoPath,
        resolvedBy: "config",
      },
    };
  }

  const client = createCaptureClient(config, { tokenPath: resolveCliTokenPath(deps), fetchImpl: deps.fetchImpl });
  const workspace = await resolveIngestWorkspace(config, client);
  return { config, client, workspace };
}

async function resolveIngestWorkspace(config: CaptureConfig, client: Pick<CaptureApiClient, "get">): Promise<ResolvedWorkspace> {
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

async function ingestCommitRef(
  runtime: IngestRuntime,
  commitRef: string,
  options: GitIngestOptions,
): Promise<GitIngestItemResult> {
  const commit = readGitCommit(runtime.config, commitRef);
  const built = buildGitCommitContextEvent(runtime.config, runtime.workspace, commit);
  const base = gitItemBase(built);

  if (built.noisy) {
    return {
      ...base,
      status: "skipped-noise",
      noiseReason: built.noiseReason ?? "all-changed-paths-ignored",
    };
  }

  if (options.dryRun) {
    return { ...base, status: "dry-run" };
  }

  const submission = await runtime.client.submitContextEvent<ContextEventApiResponse>(built.payload, {
    eventType: "git_commit",
    contentFingerprint: built.contentHash,
  });

  if (submission.status === "queued") {
    return {
      ...base,
      status: submission.duplicate ? "duplicate" : "queued",
      queuePath: submission.queuePath,
    };
  }

  const response = submission.response;
  if (response.created === false || response.idempotent === true) {
    return {
      ...base,
      status: "duplicate",
      eventId: response.event?.id == null ? null : String(response.event.id),
    };
  }

  return {
    ...base,
    status: "submitted",
    eventId: response.event?.id == null ? null : String(response.event.id),
  };
}

function gitItemBase(built: BuiltGitCommitEvent): Omit<GitIngestItemResult, "status" | "noiseReason" | "queuePath" | "eventId"> {
  return {
    sha: built.commit.sha,
    shortSha: built.commit.shortSha,
    subject: built.commit.subject,
    idempotencyKey: built.idempotencyKey,
    relatedFiles: built.commit.relatedFiles,
    candidateCount: 0,
  };
}

function buildGitIngestResult(
  command: "ingest-commit" | "ingest-git",
  runtime: IngestRuntime,
  dryRun: boolean,
  items: GitIngestItemResult[],
  since?: string,
  resolvedSince?: string,
): GitIngestResult {
  return {
    command,
    workspaceId: runtime.workspace.id,
    repoPath: runtime.config.repoPath,
    dryRun,
    ...(since ? { since } : {}),
    ...(resolvedSince ? { resolvedSince } : {}),
    total: items.length,
    planned: items.filter((item) => item.status !== "skipped-noise").length,
    submitted: items.filter((item) => item.status === "submitted").length,
    queued: items.filter((item) => item.status === "queued").length,
    skippedNoise: items.filter((item) => item.status === "skipped-noise").length,
    duplicate: items.filter((item) => item.status === "duplicate").length,
    candidatesSubmitted: 0,
    candidatesQueued: 0,
    candidatesDuplicate: 0,
    items,
  };
}

function parseIngestCommitRef(args: string[]): string {
  const positionals: string[] = [];
  let commit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--commit") {
      commit = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--since") {
      throw new Error("ingest-commit does not accept --since; pass a commit ref or --commit <ref>.");
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown ingest-commit option: ${arg}`);
    }
    positionals.push(arg);
  }
  if (positionals.length > 1) {
    throw new Error("ingest-commit accepts at most one commit ref.");
  }
  return commit ?? positionals[0] ?? "HEAD";
}

function parseIngestGitSince(args: string[]): string {
  let since: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--since") {
      since = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--commit") {
      throw new Error("ingest-git does not accept --commit; use ingest-commit <ref>.");
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown ingest-git option: ${arg}`);
    }
    throw new Error(`Unexpected ingest-git argument: ${arg}`);
  }
  if (!since) {
    throw new Error("ingest-git requires --since <ref> (or --since last-rorca-run).");
  }
  return since;
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
  const client = createCaptureClient(config, { tokenPath: resolveCliTokenPath(deps), fetchImpl: deps.fetchImpl });
  const workspace = await resolveRememberWorkspace(config, client);
  const payload = buildRememberPayload(options, config, workspace.id, relatedFiles);
  if (options.approve && payload.regulatedDomain) {
    throw new Error("Regulated-domain memory candidates require explicit human review and cannot be auto-approved by rorca-capture.");
  }
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

async function runImportDuckBrain(parsed: ParsedArgs, deps: CliDeps): Promise<DuckBrainImportSummary> {
  const options = parseDuckBrainImportArgs(parsed.rest);
  const config = resolveCaptureConfig({
    cwd: deps.cwd,
    env: deps.env,
    ci: parsed.ci,
    overrides: parsed.overrides,
    gitRoot: deps.gitRoot,
  });

  if (parsed.dryRun) {
    return importDuckBrainJsonlFile(options.path, {
      workspaceId: config.workspaceId ?? "dry-run",
      config,
      dryRun: true,
      filters: options.filters,
    });
  }

  const client = createCaptureClient(config, { tokenPath: resolveCliTokenPath(deps), fetchImpl: deps.fetchImpl });
  const workspace = await resolveRememberWorkspace(config, client);

  return importDuckBrainJsonlFile(options.path, {
    workspaceId: workspace.id,
    config,
    filters: options.filters,
    submitCandidate: async (payload) => {
      const submission = await client.submitCandidate<DuckBrainImportApiResponse>(payload, {
        endpoint: DUCKBRAIN_IMPORT_ENDPOINT,
        eventType: DUCKBRAIN_IMPORT_EVENT_TYPE,
        contentFingerprint: String(payload.metadata.entryHash ?? payload.idempotencyKey),
      });

      if (submission.status === "queued") {
        return submission.duplicate
          ? { status: "duplicate", queuePath: submission.queuePath }
          : { status: "queued", queuePath: submission.queuePath };
      }

      const candidateId = extractDuckBrainCandidateId(submission.response);
      if (isDuckBrainImportDuplicateResponse(submission.response)) {
        return { status: "duplicate", candidateId };
      }
      return { status: "imported", candidateId };
    },
  });
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

function parseDuckBrainImportArgs(args: string[]): DuckBrainImportCliOptions {
  const filters: string[] = [];
  const positionals: string[] = [];
  let inputPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--path") {
      inputPath = requireValue(args, ++index, arg);
      continue;
    }
    if (arg === "--filter") {
      filters.push(requireValue(args, ++index, arg));
      continue;
    }
    if (arg === "--namespace") {
      filters.push(`namespace:${requireValue(args, ++index, arg)}`);
      continue;
    }
    if (arg === "--key") {
      filters.push(`key:${requireValue(args, ++index, arg)}`);
      continue;
    }
    if (arg === "--tag") {
      filters.push(`tag:${requireValue(args, ++index, arg)}`);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown import-duckbrain option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (positionals.length > 1) {
    throw new Error("import-duckbrain accepts exactly one JSONL path.");
  }
  if (inputPath && positionals.length > 0) {
    throw new Error("import-duckbrain accepts a positional path or --path, not both.");
  }
  const resolvedPath = inputPath ?? positionals[0];
  if (!resolvedPath?.trim()) {
    throw new Error("import-duckbrain requires a DuckBrain JSONL path.");
  }

  return { path: resolvedPath, filters };
}

function buildRememberPayload(options: RememberOptions, config: CaptureConfig, workspaceId: string, relatedFiles: string[]): RememberPayload {
  const rawTitle = options.title ?? deriveRememberTitle(options.rule);
  const safety = analyzeContextSafety({ title: rawTitle, rule: options.rule, context: options.context, relatedFiles }, config.redaction);
  const rule = redactContextText(options.rule, config.redaction).trim();
  const context = redactContextText(options.context, config.redaction).trim();
  const title = redactContextText(rawTitle, config.redaction).trim();
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
      safety: {
        contractVersion: CONTEXT_SAFETY_CONTRACT_VERSION,
        securitySensitive: safety.securitySensitive,
        regulatedDomain: safety.regulatedDomain,
        requiresReview: true,
        findings: safety.findings,
      },
    },
    securitySensitive: safety.securitySensitive,
    regulatedDomain: safety.regulatedDomain,
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

function formatGitIngestResult(result: GitIngestResult): string {
  if (result.command === "ingest-commit") {
    const item = result.items[0];
    if (!item) return "No commit found to ingest.\n";
    if (item.status === "dry-run") {
      return `Dry run: would submit git commit ${item.shortSha} (${item.relatedFiles.length} files, ${item.idempotencyKey}).\n`;
    }
    if (item.status === "skipped-noise") {
      return `Skipped noisy git commit ${item.shortSha}: ${item.noiseReason ?? "noise"}.\n`;
    }
    if (item.status === "duplicate") {
      return `Git commit already captured: ${item.shortSha}.\n`;
    }
    if (item.status === "queued") {
      return `Rorca API unreachable or unavailable; queued git commit ${item.shortSha} at ${item.queuePath} (${item.idempotencyKey}).\n`;
    }
    return `Git commit captured: ${item.shortSha}.\n`;
  }

  const prefix = result.dryRun ? "Dry-run git ingestion" : "Git ingestion";
  return `${prefix} complete: submitted=${result.submitted}, queued=${result.queued}, skipped-noise=${result.skippedNoise}, duplicate=${result.duplicate}, total=${result.total}, candidates-submitted=${result.candidatesSubmitted}, candidates-queued=${result.candidatesQueued}, candidates-duplicate=${result.candidatesDuplicate}\n`;
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

function formatDuckBrainImportResult(result: DuckBrainImportSummary): string {
  const prefix = result.dryRun ? "Dry-run DuckBrain import" : "DuckBrain import";
  const lines = [
    `${prefix} complete: imported=${result.imported}, queued=${result.queued}, duplicate=${result.duplicate}, skipped=${result.skipped}, total=${result.total}`,
  ];

  for (const reason of result.reasons) {
    lines.push(`Warning line ${reason.line}: ${reason.code} — ${reason.message}`);
  }

  return `${lines.join("\n")}\n`;
}

function extractDuckBrainCandidateId(response: DuckBrainImportApiResponse): string | null {
  const id = response.candidate?.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
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

type HookInstallOptions = {
  strict: boolean;
};

type HookInstallResult = {
  hookPath: string;
  backupPath?: string;
  restored?: boolean;
};

const RORCA_HOOK_SENTINEL = "# RORCA MANAGED HOOK";
const RORCA_PREV_HOOK_PREFIX = "# RORCA_PREV_HOOK:";
const RORCA_PREV_HOOK_RELATIVE = "./post-commit.pre-rorca";
const RORCA_LEGACY_HOOK_MARKER = "# Installed by rorca-capture.";

function installHooks(config: CaptureConfig, workspace: ResolvedWorkspace, options: HookInstallOptions): HookInstallResult {
  const { repoPath, hooksDir, hookPath, backupPath } = resolveHookPaths(workspace);
  mkdirSync(hooksDir, { recursive: true });

  let previousHookRelative: string | undefined;
  if (existsSync(hookPath)) {
    const current = readFileSync(hookPath, "utf8");
    if (isManagedHook(current)) {
      previousHookRelative = parsePreviousHookRelative(current) ?? (existsSync(backupPath) ? RORCA_PREV_HOOK_RELATIVE : undefined);
    } else if (isLegacyRorcaHook(current)) {
      previousHookRelative = existsSync(backupPath) ? RORCA_PREV_HOOK_RELATIVE : undefined;
    } else {
      if (existsSync(backupPath)) {
        throw new Error(`Cannot preserve existing hook because backup already exists: ${backupPath}`);
      }
      renameSync(hookPath, backupPath);
      chmodSync(backupPath, 0o755);
      previousHookRelative = RORCA_PREV_HOOK_RELATIVE;
    }
  }

  const hook = buildPostCommitHook({
    apiUrl: config.apiUrl,
    repoPath,
    workspaceId: workspace.id,
    strict: options.strict,
    previousHookRelative,
  });
  writeFileSync(hookPath, hook, "utf8");
  chmodSync(hookPath, 0o755);
  return { hookPath, ...(previousHookRelative ? { backupPath } : {}) };
}

function uninstallHooks(workspace: ResolvedWorkspace): HookInstallResult {
  const { hookPath, backupPath, hooksDir } = resolveHookPaths(workspace);
  if (!existsSync(hookPath)) {
    return { hookPath, restored: false };
  }

  const current = readFileSync(hookPath, "utf8");
  if (!isManagedHook(current) && !isLegacyRorcaHook(current)) {
    throw new Error(`Refusing to uninstall unmanaged post-commit hook: ${hookPath}`);
  }

  const previousHookRelative = parsePreviousHookRelative(current) ?? (existsSync(backupPath) ? RORCA_PREV_HOOK_RELATIVE : undefined);
  const previousHookPath = previousHookRelative ? resolvePreviousHookPath(hooksDir, previousHookRelative) : undefined;
  if (previousHookPath && existsSync(previousHookPath)) {
    rmSync(hookPath, { force: true });
    renameSync(previousHookPath, hookPath);
    chmodSync(hookPath, 0o755);
    return { hookPath, backupPath: previousHookPath, restored: true };
  }

  rmSync(hookPath, { force: true });
  return { hookPath, restored: false };
}

function resolveHookPaths(workspace: ResolvedWorkspace): { repoPath: string; hooksDir: string; hookPath: string; backupPath: string } {
  if (!path.isAbsolute(workspace.path)) {
    throw new Error(`Workspace path must be absolute to install hooks safely: ${workspace.path}`);
  }
  const repoPath = workspace.path;
  const gitDir = path.join(repoPath, ".git");
  if (!existsSync(gitDir)) {
    throw new Error(`Cannot install hooks: workspace '${workspace.id}' path does not contain a .git directory (${gitDir}).`);
  }
  const hooksDir = path.join(repoPath, ".git", "hooks");
  return {
    repoPath,
    hooksDir,
    hookPath: path.join(hooksDir, "post-commit"),
    backupPath: path.join(hooksDir, "post-commit.pre-rorca"),
  };
}

function buildPostCommitHook(input: {
  apiUrl: string;
  repoPath: string;
  workspaceId: string;
  strict: boolean;
  previousHookRelative?: string;
}): string {
  const previousHookComment = input.previousHookRelative ?? "";
  const previousHookBlock = input.previousHookRelative ? `\nPREV_HOOK="$HOOK_DIR/post-commit.pre-rorca"\nif [ -x "$PREV_HOOK" ]; then\n  "$PREV_HOOK" "$@"\n  RORCA_PREV_STATUS=$?\n  if [ "$RORCA_PREV_STATUS" -ne 0 ]; then\n    exit "$RORCA_PREV_STATUS"\n  fi\nfi\n` : "";
  const ingestCommand = `RORCA_MCP_TOKEN_PATH="$RORCA_TOKEN_PATH" rorca-capture ingest-commit HEAD --repo-path ${shellQuote(input.repoPath)} --workspace ${shellQuote(input.workspaceId)} --api-url ${shellQuote(input.apiUrl)} >/dev/null 2>&1${input.strict ? "" : " || true"}`;
  const missingCommandBlock = input.strict
    ? "  echo 'rorca-capture not found; strict Rorca hook failing.' >&2\n  exit 127"
    : "  true";

  return `#!/bin/sh\n${RORCA_HOOK_SENTINEL}\n${RORCA_PREV_HOOK_PREFIX} ${previousHookComment}\n# RORCA_HOOK_MODE: ${input.strict ? "strict" : "best-effort"}\n# Thin local hook; all Rorca writes go through the API. Never embed MCP token values here.\n\nHOOK_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nRORCA_TOKEN_PATH="\${RORCA_MCP_TOKEN_PATH:-$HOME/.rorca/mcp-token}"\n# rorca-capture reads $RORCA_TOKEN_PATH at execution time; token values are not passed on argv or written to logs.\n${previousHookBlock}\nif command -v rorca-capture >/dev/null 2>&1; then\n  ${ingestCommand}\nelse\n${missingCommandBlock}\nfi\n`;
}

function isManagedHook(contents: string): boolean {
  return contents.includes(RORCA_HOOK_SENTINEL);
}

function isLegacyRorcaHook(contents: string): boolean {
  return contents.includes(RORCA_LEGACY_HOOK_MARKER) && contents.includes("rorca-capture ingest-commit");
}

function parsePreviousHookRelative(contents: string): string | undefined {
  const line = contents.split(/\r?\n/).find((item) => item.startsWith(RORCA_PREV_HOOK_PREFIX));
  if (!line) return undefined;
  const value = line.slice(RORCA_PREV_HOOK_PREFIX.length).trim();
  return value.length > 0 ? value : undefined;
}

function resolvePreviousHookPath(hooksDir: string, previousHookRelative: string): string {
  if (path.isAbsolute(previousHookRelative)) {
    throw new Error(`Invalid managed hook metadata: previous hook path must be relative (${previousHookRelative}).`);
  }
  const resolved = path.resolve(hooksDir, previousHookRelative);
  const relative = path.relative(hooksDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid managed hook metadata: previous hook path escapes hooks directory (${previousHookRelative}).`);
  }
  return resolved;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
