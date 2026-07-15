/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Runtime compatibility probes for interactive PTY CLIs.  This deliberately
 * only invokes `--version` and `--help`: probes never start an agent session,
 * touch credentials, or change a CLI's configuration.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentType } from './config';

export const PTY_CLI_PROBE_TIMEOUT_MS = 3_000;
const PTY_CLI_CACHE_TTL_MS = 30_000;

export type PtyCliCapability =
  | 'permissionBypass'
  | 'model'
  | 'thinkingBudget'
  | 'effort'
  | 'mcpConfig'
  | 'attach'
  | 'askForApproval'
  | 'noAltScreen'
  | 'textMode'
  | 'noExtensions'
  | 'tools'
  | 'appendSystemPrompt'
  | 'extension'
  | 'provider'
  | 'thinking'
  | 'skill';

export interface PtyCliProbeResult {
  args: string[];
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  output: string;
}

export interface PtyCliDiagnostic {
  code: 'binary_not_found' | 'version_probe_failed' | 'help_probe_failed' | 'unsupported_capability';
  message: string;
  action: string;
}

export interface PtyCliCompatibility {
  agentType: AgentType;
  checkedAt: string;
  binaryPath: string | null;
  version: string | null;
  ready: boolean;
  interactive: boolean;
  capabilities: Record<PtyCliCapability, boolean>;
  probes: {
    version: PtyCliProbeResult | null;
    help: PtyCliProbeResult | null;
  };
  diagnostics: PtyCliDiagnostic[];
}

export interface PtyCliProbeOptions {
  /** Test-only environment override. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  timeoutMs?: number;
}

const ENV_KEY: Record<AgentType, string> = {
  claude: 'CLAUDE_BIN',
  opencode: 'OPENCODE_BIN',
  codex: 'CODEX_BIN',
  pi: 'PI_BIN',
};

const COMMAND: Record<AgentType, string> = {
  claude: 'claude',
  opencode: 'opencode',
  codex: 'codex',
  pi: 'pi',
};

const CAPABILITY_FLAG: Record<AgentType, Partial<Record<PtyCliCapability, string>>> = {
  claude: {
    permissionBypass: '--dangerously-skip-permissions',
    model: '--model',
    thinkingBudget: '--thinking-budget',
    effort: '--effort',
    mcpConfig: '--mcp-config',
  },
  opencode: { attach: '--attach', model: '--model' },
  codex: {
    askForApproval: '--ask-for-approval',
    noAltScreen: '--no-alt-screen',
    model: '--model',
  },
  pi: {
    textMode: '--mode',
    noExtensions: '--no-extensions',
    tools: '--tools',
    appendSystemPrompt: '--append-system-prompt',
    extension: '--extension',
    provider: '--provider',
    model: '--model',
    thinking: '--thinking',
    skill: '--skill',
  },
};

const ALL_CAPABILITIES: PtyCliCapability[] = [
  'permissionBypass', 'model', 'thinkingBudget', 'effort', 'mcpConfig',
  'attach', 'askForApproval', 'noAltScreen', 'textMode', 'noExtensions',
  'tools', 'appendSystemPrompt', 'extension', 'provider', 'thinking', 'skill',
];

const cache = new Map<AgentType, { at: number; result: PtyCliCompatibility }>();

function emptyCapabilities(): Record<PtyCliCapability, boolean> {
  return Object.fromEntries(ALL_CAPABILITIES.map((name) => [name, false])) as Record<PtyCliCapability, boolean>;
}

function resolveBinary(agentType: AgentType, env: NodeJS.ProcessEnv): string | null {
  const requested = env[ENV_KEY[agentType]]?.trim() || COMMAND[agentType];
  const candidates = requested.includes(path.sep)
    ? [requested]
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, requested));

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue scanning PATH. Do not shell out with caller-controlled input.
    }
  }
  return null;
}

function trimOutput(value: unknown): string {
  // Diagnostics are surfaced through health; retain a useful bounded excerpt,
  // never a full CLI help page (which may enumerate local configuration).
  return String(value ?? '').replace(/\0/g, '').slice(0, 512).trim();
}

interface InternalPtyCliProbeResult extends PtyCliProbeResult {
  /** Full bounded process output, used only for local capability parsing. */
  rawOutput: string;
}

function toPublicProbe({ rawOutput: _rawOutput, ...probe }: InternalPtyCliProbeResult): PtyCliProbeResult {
  return probe;
}

function runProbe(binaryPath: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): InternalPtyCliProbeResult {
  try {
    const result = spawnSync(binaryPath, args, {
      cwd: osSafeCwd(),
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const rawOutput = String(`${result.stdout ?? ''}\n${result.stderr ?? ''}`).replace(/\0/g, '').slice(0, 64 * 1024);
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
    return {
      args,
      ok: result.status === 0 && !result.error,
      timedOut,
      exitCode: result.status,
      output: trimOutput(rawOutput),
      rawOutput,
    };
  } catch (error) {
    const rawOutput = String(error instanceof Error ? error.message : error);
    return { args, ok: false, timedOut: false, exitCode: null, output: trimOutput(rawOutput), rawOutput };
  }
}

function osSafeCwd(): string {
  try { return process.cwd(); } catch { return path.parse(process.execPath).root; }
}

function parseVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ?? null;
}

function outputAdvertisesFlag(helpOutput: string, flag: string): boolean {
  // `--model=<id>` and `--model <id>` are both legitimate help renderings.
  return new RegExp(`(^|[\\s,])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s=,])`, 'm').test(helpOutput);
}

/** Probe one CLI synchronously, with short bounded non-interactive commands. */
export function probePtyCliCompatibility(agentType: AgentType, opts: PtyCliProbeOptions = {}): PtyCliCompatibility {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? PTY_CLI_PROBE_TIMEOUT_MS;
  const cached = cache.get(agentType);
  if (!opts.force && env === process.env && cached && Date.now() - cached.at < PTY_CLI_CACHE_TTL_MS) return cached.result;

  const checkedAt = new Date().toISOString();
  const binaryPath = resolveBinary(agentType, env);
  const capabilities = emptyCapabilities();
  const diagnostics: PtyCliDiagnostic[] = [];
  if (!binaryPath) {
    const result: PtyCliCompatibility = {
      agentType, checkedAt, binaryPath: null, version: null, ready: false, interactive: false, capabilities,
      probes: { version: null, help: null },
      diagnostics: [{
        code: 'binary_not_found',
        message: `Could not find the ${agentType} CLI on PATH or via ${ENV_KEY[agentType]}.`,
        action: `Install/configure ${agentType}, or set ${ENV_KEY[agentType]} to its executable path.`,
      }],
    };
    if (env === process.env) cache.set(agentType, { at: Date.now(), result });
    return result;
  }

  const version = runProbe(binaryPath, ['--version'], env, timeoutMs);
  const help = runProbe(binaryPath, ['--help'], env, timeoutMs);
  if (!version.ok) diagnostics.push({
    code: 'version_probe_failed',
    message: `${agentType} at ${binaryPath} did not complete --version${version.timedOut ? ` within ${timeoutMs}ms` : ''}.`,
    action: 'Verify this is the real CLI executable and that its wrapper/runtime is available.',
  });
  if (!help.ok) diagnostics.push({
    code: 'help_probe_failed',
    message: `${agentType} at ${binaryPath} did not complete --help${help.timedOut ? ` within ${timeoutMs}ms` : ''}.`,
    action: 'Repair or update the CLI, then retry; Rorca will not launch an unverified interactive session.',
  });

  if (help.ok) {
    for (const [capability, flag] of Object.entries(CAPABILITY_FLAG[agentType]) as Array<[PtyCliCapability, string]>) {
      capabilities[capability] = outputAdvertisesFlag(help.rawOutput, flag);
    }
  }

  const result: PtyCliCompatibility = {
    agentType,
    checkedAt,
    binaryPath,
    version: version.ok ? parseVersion(version.output) : null,
    ready: version.ok && help.ok,
    interactive: version.ok && help.ok,
    capabilities,
    probes: { version: toPublicProbe(version), help: toPublicProbe(help) },
    diagnostics,
  };
  if (env === process.env) cache.set(agentType, { at: Date.now(), result });
  return result;
}

export function getPtyCliCompatibility(): Record<AgentType, PtyCliCompatibility> {
  return {
    claude: probePtyCliCompatibility('claude'),
    opencode: probePtyCliCompatibility('opencode'),
    codex: probePtyCliCompatibility('codex'),
    pi: probePtyCliCompatibility('pi'),
  };
}

export class PtyCliCompatibilityError extends Error {
  readonly diagnostic: PtyCliDiagnostic;
  readonly compatibility: PtyCliCompatibility;

  constructor(compatibility: PtyCliCompatibility, diagnostic: PtyCliDiagnostic) {
    super(`PTY_CLI_INCOMPATIBLE [${compatibility.agentType}/${diagnostic.code}]: ${diagnostic.message} ${diagnostic.action}`);
    this.name = 'PtyCliCompatibilityError';
    this.compatibility = compatibility;
    this.diagnostic = diagnostic;
  }
}

export function assertPtyCliCompatible(
  agentType: AgentType,
  required: PtyCliCapability[] = [],
  compatibility = probePtyCliCompatibility(agentType),
): PtyCliCompatibility {
  const baseDiagnostic = compatibility.diagnostics[0];
  if (compatibility.agentType !== agentType) {
    throw new PtyCliCompatibilityError(compatibility, {
      code: 'help_probe_failed',
      message: `Compatibility result for ${compatibility.agentType} cannot launch ${agentType}.`,
      action: 'Re-probe the selected adapter before building its PTY command.',
    });
  }
  if (!compatibility.ready || !compatibility.interactive || !compatibility.binaryPath) {
    throw new PtyCliCompatibilityError(compatibility, baseDiagnostic ?? {
      code: 'help_probe_failed',
      message: `${agentType} did not verify interactive PTY readiness.`,
      action: 'Run the CLI --version and --help manually, repair it, then retry.',
    });
  }
  for (const capability of required) {
    if (!compatibility.capabilities[capability]) {
      throw new PtyCliCompatibilityError(compatibility, {
        code: 'unsupported_capability',
        message: `${agentType} ${compatibility.version ?? '(unknown version)'} does not advertise ${CAPABILITY_FLAG[agentType][capability] ?? capability}.`,
        action: 'Upgrade/configure this CLI or remove the requested PTY feature. Do not add an unverified flag manually.',
      });
    }
  }
  return compatibility;
}

export function resetPtyCliCompatibilityCacheForTests(): void {
  cache.clear();
}
