#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiClient, inspectMcpToken, resolveWorkspace, type CaptureFetch, type CaptureApiClient, type ResolvedWorkspace } from "./api.js";
import { resolveCaptureConfig, type CaptureConfig, type CaptureConfigValues, type CaptureMode } from "./config.js";
import { buildCaptureStatus, formatStatusText, MVP_COMMANDS } from "./status.js";

export const HELP_TEXT = `rorca-capture — API-only context capture sidecar for Rorca

Usage:
  rorca-capture <command> [options]
  rorca capture <command> [options]   # thin alias that shells out to rorca-capture

MVP commands:
  remember <text>        Store a manual memory through POST /api/memory
  ingest-commit [hash]   Send one commit ingestion request through the Rorca API
  ingest-git             Request git context ingestion through the Rorca API
  install-hooks          Install local git hooks that call rorca-capture
  daemon                 Run the sidecar daemon contract (MVP status heartbeat)
  status                 Print resolved config, workspace, queue, token, and safety state

Configuration discovery order:
  1. Env vars: RORCA_API_URL, RORCA_WORKSPACE_ID, RORCA_QUEUE_PATH
  2. <git-root>/.rorca/config.json
  3. <git-root>/.rorca/capture.json
  4. Auto-detect git root + default API http://localhost:3030 (local/vm only)

Global options:
  --api-url <url>        Override Rorca API URL for this invocation
  --workspace-id <id>    Override workspace ID for this invocation
  --repo-path <path>     Override repository path for this invocation
  --queue-path <path>    Override local queue path for this invocation
  --mode <local|vm|ci>   Set capture mode
  --ci                   Force CI mode; missing config is a hard error
  --json                 Emit JSON where supported
  -h, --help             Show this help

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

    const runtime = await resolveRuntime(parsed, deps);

    if (parsed.command === "remember") {
      await runRemember(parsed.rest, runtime);
      io.stdout.write("Memory captured through Rorca API.\n");
      return 0;
    }

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
    if (arg === "--api-url") {
      overrides.apiUrl = requireValue(argv, ++index, arg);
      continue;
    }
    if (arg === "--workspace-id") {
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

async function runRemember(args: string[], runtime: Runtime): Promise<void> {
  const title = readOption(args, "--title") ?? "Manual context capture";
  const category = readOption(args, "--category") ?? "Decision";
  const context = readOption(args, "--context") ?? "Captured by rorca-capture sidecar.";
  const source = readOption(args, "--source") ?? "rorca-capture";
  const text = positionalArgs(args).join(" ").trim();
  const rule = readOption(args, "--rule") ?? text;

  if (!rule) {
    throw new Error("remember requires text or --rule.");
  }

  await runtime.client.post("/api/memory", {
    workspaceId: runtime.workspace.id,
    category,
    title,
    rule,
    context,
    source,
    sourceType: "mcp",
  });
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
  if (error && typeof error === "object" && "toJSON" in error && typeof error.toJSON === "function") {
    const json = error.toJSON() as { error?: string; code?: string };
    return json.code ? `${json.code}: ${json.error ?? "Unknown error"}` : json.error ?? "Unknown error";
  }
  return error instanceof Error ? error.message : String(error);
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
