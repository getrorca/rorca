/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedWorkspace } from './api.js';
import { normalizeCaptureApiUrl } from './config.js';
import { assertSecureParent, atomicWriteFileSecure, readSecureFile } from './secure-fs.js';
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
    let current: string;
    try { current = readSecureFile(filePath); } catch { return 'degraded'; }
    if (current === content) {
      const needsModeRepair = executable && process.platform !== 'win32' && (lstatSync(filePath).mode & 0o111) !== 0o111;
      if (needsModeRepair && !dryRun) chmodSync(filePath, 0o755);
      return needsModeRepair && !dryRun ? 'installed' : 'skipped';
    }
    if (!current.includes(MANAGED_SENTINEL)) return 'degraded';
  }
  if (!dryRun) atomicWriteFileSecure(filePath, content, { mode: executable ? 0o755 : 0o600 });
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
  const { workspace, policyMode } = input;
  const apiUrl = normalizeCaptureApiUrl(input.apiUrl);
  const dryRun = input.dryRun === true;
  const captureDir = path.join(workspace.path, '.rorca', 'capture');
  const queuePath = path.join(workspace.path, '.rorca-capture-queue.jsonl');
  const installed: string[] = [];
  const skipped: string[] = [];
  const degraded: Array<{ path: string; reason: string }> = [];
  if (!dryRun) {
    mkdirSync(captureDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(captureDir, 0o700);
    assertSecureParent(path.join(captureDir, 'state'));
  }

  const files: Array<{ path: string; content: string; executable?: boolean }> = [
    {
      path: path.join(captureDir, 'policy.json'),
      content: managedJson({ policyMode, paused: false, policyVersion: '2026-07-ucc-007', updatedAt: new Date().toISOString() }),
    },
    {
      path: path.join(captureDir, 'sidecar.json'),
      content: managedJson({ workspaceId: workspace.id, workspacePath: workspace.path, apiUrl, endpoint: '/api/context-capture/events', apiOnly: true, policyMode, queuePath, sources: ['repoDaemon', 'gitHook', 'shellIntegration', 'vscodeExtension', 'agentAdapter', 'mcpSlashCommand', 'ciPrIngestion', 'externalImport'] }),
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
  files.push({ path: ignorePath, content: managedText('node_modules/\ndist/\nbuild/\n.env\n.env.*\n*.pem\n*.key\n.rorca-capture-queue.jsonl\n') });
  const manifestPath = path.join(captureDir, 'uninstall.json');
  files.push({ path: manifestPath, content: managedJson({
    workspaceId: workspace.id,
    removes: files.map((file) => file.path),
    preserves: [queuePath, path.join(captureDir, 'state.json'), path.join(captureDir, 'status.json'), path.join(captureDir, 'service.log')],
  }) });

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
    try { policyMode = parseCapturePolicyMode((JSON.parse(readSecureFile(filePath)) as { policyMode?: string }).policyMode); } catch { /* use safe default */ }
  }
  atomicWriteFileSecure(filePath, managedJson({ policyMode, paused, policyVersion: '2026-07-ucc-007', updatedAt: new Date().toISOString() }), { mode: 0o600 });
}

export function teardownAlwaysOnCapture(workspacePath: string, options: { dryRun?: boolean; all?: boolean } = {}): { removed: string[]; skipped: string[] } {
  const manifestPath = path.join(workspacePath, '.rorca', 'capture', 'uninstall.json');
  const removed: string[] = [];
  const skipped: string[] = [];
  if (!existsSync(manifestPath)) return { removed, skipped: [manifestPath] };
  const manifest = JSON.parse(readSecureFile(manifestPath)) as { rorcaManaged?: string; removes?: unknown };
  if (manifest.rorcaManaged !== MANAGED_SENTINEL || !Array.isArray(manifest.removes)) throw new Error('Refusing teardown: invalid managed uninstall manifest.');
  const paths = manifest.removes.filter((item): item is string => typeof item === 'string');
  paths.push(manifestPath);
  for (const candidate of [...new Set(paths)].sort((a, b) => b.length - a.length)) {
    const resolved = path.resolve(candidate);
    const relative = path.relative(path.resolve(workspacePath), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(resolved)) { skipped.push(resolved); continue; }
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) { skipped.push(resolved); continue; }
    if (stat.isFile() && resolved !== manifestPath && !readSecureFile(resolved).includes(MANAGED_SENTINEL)) { skipped.push(resolved); continue; }
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

export type CaptureServicePaths = { serviceDir: string; serviceFile: string; taskRegistrationFile?: string; label: string };
export type CaptureServiceRunner = (command: string, args: string[], options: { cwd: string; stdio: 'pipe' }) => { error?: Error; status: number | null };

type ServiceRenderInput = { workspace: ResolvedWorkspace; command: string; apiUrl?: string; nodePath?: string; homeDir?: string; paths?: CaptureServicePaths };

export function resolveCaptureServicePaths(workspace: ResolvedWorkspace, platform: NodeJS.Platform = process.platform, homeDir = os.homedir()): CaptureServicePaths {
  const label = platform === 'darwin' ? `com.rorca.capture.${workspace.id}` : `rorca-capture-${workspace.id}`;
  const serviceDir = platform === 'darwin'
    ? path.join(homeDir, 'Library', 'LaunchAgents')
    : platform === 'linux'
      ? path.join(homeDir, '.config', 'systemd', 'user')
      : path.join(workspace.path, '.rorca', 'capture', 'service');
  const serviceFile = path.join(serviceDir, platform === 'darwin' ? `${label}.plist` : platform === 'linux' ? `${label}.service` : `${label}.ps1`);
  return { serviceDir, serviceFile, label, ...(platform === 'win32' ? { taskRegistrationFile: path.join(serviceDir, `register-${label}-task.ps1`) } : {}) };
}

export function renderLaunchdPlist(input: ServiceRenderInput): string {
  const paths = input.paths ?? resolveCaptureServicePaths(input.workspace, 'darwin', input.homeDir);
  const args = [input.nodePath ?? process.execPath, input.command, 'daemon', '--workspace', input.workspace.id, '--repo-path', input.workspace.path];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xmlEscape(paths.label)}</string>\n<key>ProgramArguments</key><array>${args.map((item) => `<string>${xmlEscape(item)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xmlEscape(input.workspace.path)}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>\n</dict></plist>\n`;
}

export function renderSystemdUserService(input: ServiceRenderInput): string {
  const apiUrl = normalizeCaptureApiUrl(input.apiUrl ?? 'http://127.0.0.1:3030');
  const command = [input.nodePath ?? process.execPath, input.command, 'daemon', '--workspace', input.workspace.id, '--repo-path', input.workspace.path].map(systemdQuote).join(' ');
  return managedText(`[Unit]\nDescription=Rorca always-on context capture for ${systemdText(input.workspace.id)}\n[Service]\nType=simple\nWorkingDirectory=${systemdQuote(input.workspace.path)}\nExecStart=${command}\nRestart=on-failure\nRestartSec=10\nEnvironment=${systemdQuote(`RORCA_API_URL=${apiUrl}`)}\n[Install]\nWantedBy=default.target\n`);
}

export function renderWindowsFallbackScript(input: ServiceRenderInput): string {
  return managedText(`Set-Location -LiteralPath ${psQuote(input.workspace.path)}\n& ${psQuote(input.nodePath ?? process.execPath)} ${psQuote(input.command)} daemon --workspace ${psQuote(input.workspace.id)} --repo-path ${psQuote(input.workspace.path)}\n`);
}

export function renderWindowsTaskSchedulerRegistration(input: { workspace: ResolvedWorkspace; serviceFile: string; powershellPath?: string }): string {
  const taskName = `Rorca Capture ${systemdText(input.workspace.id)}`;
  return `# ${MANAGED_SENTINEL} | operator action required\n# Review, then run explicitly. Rendering does not register a task.\n$ScriptPath = ${psQuote(input.serviceFile)}\n$Action = New-ScheduledTaskAction -Execute ${psQuote(input.powershellPath ?? 'pwsh.exe')} -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $ScriptPath.Replace('"', '\\"') + '"')\n$Trigger = New-ScheduledTaskTrigger -AtLogOn\nRegister-ScheduledTask -TaskName ${psQuote(taskName)} -Action $Action -Trigger $Trigger -Description 'Rorca always-on context capture'\n`;
}

export function renderCaptureService(platform: NodeJS.Platform, input: ServiceRenderInput): { path: string; content: string; label: string; taskRegistrationFile?: string } {
  const paths = input.paths ?? resolveCaptureServicePaths(input.workspace, platform, input.homeDir);
  const content = platform === 'darwin' ? renderLaunchdPlist({ ...input, paths }) : platform === 'linux' ? renderSystemdUserService({ ...input, paths }) : renderWindowsFallbackScript({ ...input, paths });
  return { path: paths.serviceFile, content, label: paths.label, ...(paths.taskRegistrationFile ? { taskRegistrationFile: paths.taskRegistrationFile } : {}) };
}

export function runCaptureServiceAction(input: ServiceRenderInput & { action: CaptureServiceAction; dryRun?: boolean; platform?: NodeJS.Platform; runner?: CaptureServiceRunner }): Record<string, unknown> {
  const platform = input.platform ?? process.platform;
  const service = renderCaptureService(platform, input);
  const commands: string[] = [];
  const runner = input.runner ?? ((command: string, args: string[], options: { cwd: string; stdio: 'pipe' }) => spawnSync(command, args, options));
  const run = (command: string, args: string[], allowFailure = false) => {
    commands.push([command, ...args].join(' '));
    if (input.dryRun) return;
    const result = runner(command, args, { cwd: input.workspace.path, stdio: 'pipe' });
    if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`${command} ${args.join(' ')} failed`);
  };
  if (input.action === 'status') return { ok: true, action: input.action, platform, serviceFile: service.path, installed: existsSync(service.path), commands };
  if (input.action === 'install') {
    if (!input.dryRun) {
      atomicWriteFileSecure(service.path, service.content, { mode: 0o600 });
      if (platform === 'win32' && service.taskRegistrationFile) atomicWriteFileSecure(service.taskRegistrationFile, renderWindowsTaskSchedulerRegistration({ workspace: input.workspace, serviceFile: service.path }), { mode: 0o600 });
    }
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
    if (!input.dryRun) { rmSync(service.path, { force: true }); if (service.taskRegistrationFile) rmSync(service.taskRegistrationFile, { force: true }); }
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

function xmlEscape(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function systemdText(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('Service values must not contain NUL or newlines.');
  return value.replace(/%/g, '%%');
}
function systemdQuote(value: string): string {
  const safe = systemdText(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return /[\s'"\\%]/.test(value) ? `"${safe}"` : safe;
}
function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function fishQuote(value: string): string { return `'${value.replace(/'/g, `\\'`)}'`; }
function psQuote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
