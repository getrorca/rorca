/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedWorkspace } from './api.js';
import {
  analyzeContextSafety,
  hashContextContent,
  loadContextCaptureIgnoreFile,
  redactContextText,
  safeNormalizeWorkspaceRelativePath,
  shouldCapturePath,
} from './context-safety.js';

export const CAPTURE_POLICY_MODES = ['off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full'] as const;
export type CapturePolicyMode = typeof CAPTURE_POLICY_MODES[number];
export type CaptureServiceAction = 'install' | 'start' | 'stop' | 'restart' | 'status' | 'uninstall';

const MANAGED_SENTINEL = 'rorca-managed: always-on-context/v1';
const SHELL_BLOCK_START = '# >>> rorca-capture always-on (managed) >>>';
const SHELL_BLOCK_END = '# <<< rorca-capture always-on (managed) <<<';

export function parseCapturePolicyMode(value: unknown): CapturePolicyMode {
  if (CAPTURE_POLICY_MODES.includes(value as CapturePolicyMode)) return value as CapturePolicyMode;
  throw new Error(`Capture policy must be one of: ${CAPTURE_POLICY_MODES.join(', ')}.`);
}

export type AlwaysOnSetupResult = {
  ok: boolean;
  dryRun: boolean;
  workspaceId: string;
  policyMode: CapturePolicyMode;
  installed: string[];
  skipped: string[];
  degraded: Array<{ path: string; reason: string }>;
  captureDir: string;
};

function managedJson(value: Record<string, unknown>): string {
  return `${JSON.stringify({ rorcaManaged: MANAGED_SENTINEL, ...value }, null, 2)}\n`;
}

function managedText(body: string): string {
  return `# ${MANAGED_SENTINEL}\n${body}`;
}

function writeManaged(filePath: string, content: string, dryRun: boolean, executable = false): 'installed' | 'skipped' | 'degraded' {
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, 'utf8');
    if (current === content) return 'skipped';
    if (!current.includes(MANAGED_SENTINEL)) return 'degraded';
  }
  if (!dryRun) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, { encoding: 'utf8', mode: executable ? 0o755 : 0o600 });
    if (executable) chmodSync(filePath, 0o755);
  }
  return 'installed';
}

function adapterConfig(tool: 'pi' | 'claude-code' | 'codex' | 'opencode', workspace: ResolvedWorkspace, apiUrl: string): string {
  const sourceSystem = tool === 'claude-code' ? 'claude_code' : tool;
  return managedJson({
    adapter: tool,
    workspaceId: workspace.id,
    endpoint: '/api/context-capture/events',
    apiUrl,
    tokenFile: '~/.rorca/mcp-token',
    tokenPolicy: 'path only; never persist bearer values',
    metadata: { source_system: sourceSystem, tool_name: tool, session_id: `\${${tool.toUpperCase().replace('-', '_')}_SESSION_ID:-manual}` },
    rememberCommand: `rorca-capture remember --workspace ${workspace.id} --source ${sourceSystem}:manual`,
  });
}

function wrapperScript(tool: 'codex' | 'opencode', workspace: ResolvedWorkspace, policyMode: CapturePolicyMode): string {
  const envName = tool === 'codex' ? 'RORCA_CODEX_BIN' : 'RORCA_OPENCODE_BIN';
  return managedText(`set +e\nTOOL_BIN="\${${envName}:-$(command -v ${tool} 2>/dev/null)}"\nif [ -z "$TOOL_BIN" ] || [ ! -x "$TOOL_BIN" ]; then\n  echo "Rorca ${tool} adapter: native binary not found; use shell capture or rorca-capture remember." >&2\n  exit 127\nfi\nrorca-capture emit shell --phase start --workspace ${shellQuote(workspace.id)} --repo-path ${shellQuote(workspace.path)} --policy ${shellQuote(policyMode)} --command "${tool} $*" >/dev/null 2>&1 || true\n"$TOOL_BIN" "$@"\nCODE=$?\nrorca-capture emit shell --phase end --workspace ${shellQuote(workspace.id)} --repo-path ${shellQuote(workspace.path)} --policy ${shellQuote(policyMode)} --command "${tool} $*" --exit-code "$CODE" >/dev/null 2>&1 || true\nexit "$CODE"\n`);
}

function shellSnippet(shell: 'zsh' | 'bash' | 'fish' | 'powershell', workspace: ResolvedWorkspace, policyMode: CapturePolicyMode, apiUrl: string): string {
  if (shell === 'fish') {
    return `${SHELL_BLOCK_START}\nset -gx RORCA_CAPTURE_WORKSPACE_ID ${fishQuote(workspace.id)}\nset -gx RORCA_CAPTURE_POLICY ${fishQuote(policyMode)}\nset -gx RORCA_API_URL ${fishQuote(apiUrl)}\nfunction __rorca_capture_preexec --on-event fish_preexec\n  command rorca-capture emit shell --phase start --workspace $RORCA_CAPTURE_WORKSPACE_ID --repo-path ${fishQuote(workspace.path)} --policy $RORCA_CAPTURE_POLICY --command "$argv" >/dev/null 2>&1; or true\nend\n${SHELL_BLOCK_END}\n`;
  }
  if (shell === 'powershell') {
    return `${SHELL_BLOCK_START}\n$env:RORCA_CAPTURE_WORKSPACE_ID = ${psQuote(workspace.id)}\n$env:RORCA_CAPTURE_POLICY = ${psQuote(policyMode)}\n# Use rorca-capture emit shell from an explicit PowerShell prompt hook.\n${SHELL_BLOCK_END}\n`;
  }
  return `${SHELL_BLOCK_START}\nexport RORCA_CAPTURE_WORKSPACE_ID=${shellQuote(workspace.id)}\nexport RORCA_CAPTURE_POLICY=${shellQuote(policyMode)}\n__rorca_capture_started_at=0\n__rorca_capture_command=""\n__rorca_capture_start() { __rorca_capture_command="$1"; __rorca_capture_started_at="$(date +%s 2>/dev/null || echo 0)"; command rorca-capture emit shell --phase start --workspace "$RORCA_CAPTURE_WORKSPACE_ID" --repo-path ${shellQuote(workspace.path)} --policy "$RORCA_CAPTURE_POLICY" --command "$1" >/dev/null 2>&1 || true; }\n__rorca_capture_end() { local code="$?"; command rorca-capture emit shell --phase end --workspace "$RORCA_CAPTURE_WORKSPACE_ID" --repo-path ${shellQuote(workspace.path)} --policy "$RORCA_CAPTURE_POLICY" --command "$__rorca_capture_command" --exit-code "$code" >/dev/null 2>&1 || true; return "$code"; }\n${shell === 'zsh' ? 'preexec() { __rorca_capture_start "$1"; }\nprecmd() { __rorca_capture_end; }' : 'trap \'__rorca_capture_start "$BASH_COMMAND"\' DEBUG\nPROMPT_COMMAND="__rorca_capture_end${PROMPT_COMMAND:+;$PROMPT_COMMAND}"'}\n${SHELL_BLOCK_END}\n`;
}

export function setupAlwaysOnCapture(input: {
  workspace: ResolvedWorkspace;
  apiUrl: string;
  policyMode: CapturePolicyMode;
  dryRun?: boolean;
}): AlwaysOnSetupResult {
  const { workspace, apiUrl, policyMode } = input;
  const dryRun = input.dryRun === true;
  const captureDir = path.join(workspace.path, '.rorca', 'capture');
  const queueDir = path.join(captureDir, 'queue');
  const installed: string[] = [];
  const skipped: string[] = [];
  const degraded: Array<{ path: string; reason: string }> = [];
  if (!dryRun) mkdirSync(queueDir, { recursive: true });

  const files: Array<{ path: string; content: string; executable?: boolean }> = [
    {
      path: path.join(captureDir, 'policy.json'),
      content: managedJson({ policyMode, paused: false, policyVersion: '2026-07-ucc-007', updatedAt: new Date().toISOString() }),
    },
    {
      path: path.join(captureDir, 'sidecar.json'),
      content: managedJson({ workspaceId: workspace.id, workspacePath: workspace.path, apiUrl, endpoint: '/api/context-capture/events', apiOnly: true, policyMode, queuePath: queueDir, sources: ['repoDaemon', 'gitHook', 'shellIntegration', 'vscodeExtension', 'agentAdapter', 'mcpSlashCommand', 'ciPrIngestion', 'externalImport'] }),
    },
    {
      path: path.join(captureDir, 'redaction.json'),
      content: managedJson({ policyVersion: '2026-07-ucc-007', rawContentDefault: 'metadata+hash', hashAlgorithm: 'sha256' }),
    },
    {
      path: path.join(workspace.path, '.vscode', 'rorca-capture-adapter.json'),
      content: managedJson({ workspaceId: workspace.id, adapter: 'vscode-compatible', endpoint: '/api/context-capture/events', chatPanels: 'explicit-export-only', fallbackSources: ['repoDaemon', 'gitHook', 'shellIntegration'] }),
    },
    {
      path: path.join(workspace.path, '.pi', 'extensions', 'rorca', 'capture-command.json'),
      content: adapterConfig('pi', workspace, apiUrl),
    },
    { path: path.join(captureDir, 'adapters', 'claude-code.json'), content: adapterConfig('claude-code', workspace, apiUrl) },
    { path: path.join(captureDir, 'adapters', 'codex.json'), content: adapterConfig('codex', workspace, apiUrl) },
    { path: path.join(captureDir, 'adapters', 'opencode.json'), content: adapterConfig('opencode', workspace, apiUrl) },
    { path: path.join(captureDir, 'adapters', 'rorca-codex-wrapper.sh'), content: wrapperScript('codex', workspace, policyMode), executable: true },
    { path: path.join(captureDir, 'adapters', 'rorca-opencode-wrapper.sh'), content: wrapperScript('opencode', workspace, policyMode), executable: true },
    { path: path.join(captureDir, 'shell', 'rorca-capture.zsh.sh'), content: shellSnippet('zsh', workspace, policyMode, apiUrl) },
    { path: path.join(captureDir, 'shell', 'rorca-capture.bash.sh'), content: shellSnippet('bash', workspace, policyMode, apiUrl) },
    { path: path.join(captureDir, 'shell', 'rorca-capture.fish.fish'), content: shellSnippet('fish', workspace, policyMode, apiUrl) },
    { path: path.join(captureDir, 'shell', 'rorca-capture.powershell.ps1'), content: shellSnippet('powershell', workspace, policyMode, apiUrl) },
  ];

  const ignorePath = path.join(workspace.path, '.rorca-captureignore');
  files.push({ path: ignorePath, content: managedText('node_modules/\ndist/\nbuild/\n.env\n.env.*\n*.pem\n*.key\n.rorca/capture/queue/\n') });
  const manifestPath = path.join(captureDir, 'uninstall.json');
  files.push({ path: manifestPath, content: managedJson({ workspaceId: workspace.id, removes: files.map((file) => file.path), queuePath: queueDir }) });

  for (const file of files) {
    const outcome = writeManaged(file.path, file.content, dryRun, file.executable);
    if (outcome === 'installed') installed.push(file.path);
    else if (outcome === 'skipped') skipped.push(file.path);
    else degraded.push({ path: file.path, reason: 'existing_non_rorca_managed_file' });
  }
  return { ok: degraded.length === 0, dryRun, workspaceId: workspace.id, policyMode, installed, skipped, degraded, captureDir };
}

export function updateLocalCapturePause(workspacePath: string, paused: boolean): void {
  const filePath = path.join(workspacePath, '.rorca', 'capture', 'policy.json');
  let policyMode: CapturePolicyMode = 'metadata-only';
  if (existsSync(filePath)) {
    try { policyMode = parseCapturePolicyMode((JSON.parse(readFileSync(filePath, 'utf8')) as { policyMode?: string }).policyMode); } catch { /* use safe default */ }
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, managedJson({ policyMode, paused, policyVersion: '2026-07-ucc-007', updatedAt: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 });
}

export function teardownAlwaysOnCapture(workspacePath: string, options: { dryRun?: boolean; all?: boolean } = {}): { removed: string[]; skipped: string[] } {
  const manifestPath = path.join(workspacePath, '.rorca', 'capture', 'uninstall.json');
  const removed: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(manifestPath)) return { removed, skipped: [manifestPath] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { rorcaManaged?: string; removes?: unknown; queuePath?: string };
  if (manifest.rorcaManaged !== MANAGED_SENTINEL || !Array.isArray(manifest.removes)) throw new Error('Refusing teardown: invalid managed uninstall manifest.');
  const paths = manifest.removes.filter((item): item is string => typeof item === 'string');
  if (options.all && manifest.queuePath) paths.push(manifest.queuePath);
  paths.push(manifestPath);
  for (const candidate of [...new Set(paths)].sort((a, b) => b.length - a.length)) {
    const resolved = path.resolve(candidate);
    const relative = path.relative(path.resolve(workspacePath), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(resolved)) { skipped.push(resolved); continue; }
    const stat = statSync(resolved);
    if (stat.isFile() && resolved !== manifestPath && !readFileSync(resolved, 'utf8').includes(MANAGED_SENTINEL)) { skipped.push(resolved); continue; }
    if (!options.dryRun) rmSync(resolved, { recursive: stat.isDirectory(), force: true });
    removed.push(resolved);
  }
  return { removed, skipped };
}

export function buildShellCaptureEnvelope(input: {
  workspace: ResolvedWorkspace;
  command: string;
  phase: 'start' | 'end';
  policyMode: CapturePolicyMode;
  exitCode?: number | null;
  durationMs?: number | null;
  occurredAt?: string;
  sessionId?: string;
}): Record<string, unknown> | null {
  if (input.policyMode === 'off') return null;
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const command = redactContextText(input.command, {});
  const safety = analyzeContextSafety(input.command, {});
  const commandHash = `sha256:${hashContextContent(input.command)}`;
  const eventId = `shell:${hashContextContent(`${input.workspace.id}|${occurredAt}|${input.phase}|${commandHash}`).slice(0, 24)}`;
  const payload = {
    eventType: 'shell_command',
    source_system: 'shell',
    tool_name: 'shell',
    session_id: input.sessionId ?? process.env.RORCA_CAPTURE_SESSION_ID ?? 'shell',
    phase: input.phase,
    policyMode: input.policyMode,
    command_summary: input.policyMode === 'metadata-only' ? null : command,
    command_hash: commandHash,
    cwd: input.workspace.path,
    exit_code: input.exitCode ?? null,
    duration_ms: input.durationMs ?? null,
    regulated_signals: safety.regulatedDomain ? safety.findings.filter((item) => item.category === 'regulated-domain').map((item) => item.name) : [],
  };
  return { id: eventId, workspaceId: input.workspace.id, source: 'shellIntegration', occurredAt, policyMode: input.policyMode, payload };
}

export function renderCaptureService(platform: NodeJS.Platform, input: { workspace: ResolvedWorkspace; command: string; apiUrl: string }): { path: string; content: string; label: string } {
  const label = platform === 'darwin' ? `com.rorca.capture.${input.workspace.id}` : `rorca-capture-${input.workspace.id}`;
  const args = `daemon --workspace ${shellQuote(input.workspace.id)} --repo-path ${shellQuote(input.workspace.path)}`;
  if (platform === 'darwin') {
    const filePath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${input.command}</string><string>daemon</string><string>--workspace</string><string>${input.workspace.id}</string><string>--repo-path</string><string>${input.workspace.path}</string></array>\n<key>WorkingDirectory</key><string>${input.workspace.path}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>\n</dict></plist>\n`;
    return { path: filePath, content, label };
  }
  const filePath = platform === 'linux'
    ? path.join(os.homedir(), '.config', 'systemd', 'user', `${label}.service`)
    : path.join(input.workspace.path, '.rorca', 'capture', 'service', `${label}.ps1`);
  const content = platform === 'linux'
    ? managedText(`[Unit]\nDescription=Rorca always-on context capture\n[Service]\nType=simple\nWorkingDirectory=${input.workspace.path}\nExecStart=${input.command} ${args}\nRestart=on-failure\nRestartSec=10\nEnvironment=RORCA_API_URL=${input.apiUrl}\n[Install]\nWantedBy=default.target\n`)
    : managedText(`Set-Location -LiteralPath ${psQuote(input.workspace.path)}\n& ${psQuote(input.command)} daemon --workspace ${psQuote(input.workspace.id)} --repo-path ${psQuote(input.workspace.path)}\n`);
  return { path: filePath, content, label };
}

export function runCaptureServiceAction(input: { action: CaptureServiceAction; workspace: ResolvedWorkspace; command: string; apiUrl: string; dryRun?: boolean; platform?: NodeJS.Platform }): Record<string, unknown> {
  const platform = input.platform ?? process.platform;
  const service = renderCaptureService(platform, input);
  const commands: string[] = [];
  const run = (command: string, args: string[], allowFailure = false) => {
    commands.push([command, ...args].join(' '));
    if (input.dryRun) return;
    const result = spawnSync(command, args, { cwd: input.workspace.path, stdio: 'pipe' });
    if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`${command} ${args.join(' ')} failed`);
  };
  if (input.action === 'status') return { ok: true, action: input.action, platform, serviceFile: service.path, installed: existsSync(service.path), commands };
  if (input.action === 'install') {
    if (!input.dryRun) { mkdirSync(path.dirname(service.path), { recursive: true }); writeFileSync(service.path, service.content, 'utf8'); }
    if (platform === 'darwin') { const domain = `gui/${process.getuid?.() ?? 501}`; run('launchctl', ['bootout', `${domain}/${service.label}`], true); run('launchctl', ['bootstrap', domain, service.path]); run('launchctl', ['kickstart', '-k', `${domain}/${service.label}`]); }
    else if (platform === 'linux') { run('systemctl', ['--user', 'daemon-reload']); run('systemctl', ['--user', 'enable', '--now', service.label]); }
  } else if (input.action === 'start' || input.action === 'restart') {
    if (platform === 'darwin') run('launchctl', ['kickstart', ...(input.action === 'restart' ? ['-k'] : []), `gui/${process.getuid?.() ?? 501}/${service.label}`]);
    else if (platform === 'linux') run('systemctl', ['--user', input.action, service.label]);
  } else if (input.action === 'stop') {
    if (platform === 'darwin') run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${service.label}`], true);
    else if (platform === 'linux') run('systemctl', ['--user', 'stop', service.label]);
  } else if (input.action === 'uninstall') {
    if (platform === 'darwin') run('launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${service.label}`], true);
    else if (platform === 'linux') { run('systemctl', ['--user', 'disable', '--now', service.label], true); run('systemctl', ['--user', 'daemon-reload']); }
    if (!input.dryRun) rmSync(service.path, { force: true });
  }
  return { ok: true, action: input.action, platform, serviceFile: service.path, commands, dryRun: input.dryRun === true };
}

export function validateRelatedCaptureFiles(workspacePath: string, files: string[]): string[] {
  const ignore = loadContextCaptureIgnoreFile(workspacePath);
  return files.map((file) => {
    const normalized = safeNormalizeWorkspaceRelativePath(workspacePath, file);
    if (!shouldCapturePath(normalized, { paths: ignore?.patterns ?? [] })) throw new Error(`Related file is ignored: ${normalized}`);
    return normalized;
  });
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function fishQuote(value: string): string { return `'${value.replace(/'/g, `\\'`)}'`; }
function psQuote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
