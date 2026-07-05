#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { formatCaptureBootstrapHumanReport, runCaptureBootstrap, runCaptureTeardown } from '../packages/rorca-pi-extension/extensions/rorca/capture-bootstrap.js';
import { buildShellCaptureEvent, enqueueShellCaptureEvent, postShellCaptureEvent, readCaptureIgnorePatterns } from '../packages/rorca-pi-extension/extensions/rorca/capture-shell.js';
import { readCaptureServiceStatus, runCaptureServiceLifecycle, runManagedCaptureDaemon } from '../packages/rorca-pi-extension/extensions/rorca/capture-service.js';

function parseArgs(argv) {
  const options = { alwaysOn: false, dryRun: false, json: false, uninstall: false, workspaceId: undefined, cwd: process.cwd(), exitCode: undefined, once: false, phase: 'end', command: '', policyMode: process.env.RORCA_CAPTURE_POLICY || 'metadata-only', customAgentPatterns: (process.env.RORCA_CAPTURE_AGENT_PATTERNS || '').split(',').filter(Boolean), sourceSystem: undefined, toolName: undefined, sessionId: undefined, message: undefined, category: 'Decision', title: undefined, rule: undefined, context: undefined, sourceRef: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--always-on') options.alwaysOn = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--uninstall' || arg === '--teardown') options.uninstall = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--workspace-id') options.workspaceId = argv[++i];
    else if (arg === '--cwd') options.cwd = argv[++i] || process.cwd();
    else if (arg === '--exit-code') options.exitCode = Number(argv[++i] || '0');
    else if (arg === '--duration-ms') options.durationMs = Number(argv[++i] || '0');
    else if (arg === '--phase') options.phase = argv[++i] || 'end';
    else if (arg === '--command') options.command = argv[++i] || '';
    else if (arg === '--policy') options.policyMode = argv[++i] || options.policyMode;
    else if (arg === '--agent-pattern') options.customAgentPatterns.push(argv[++i] || '');
    else if (arg === '--scan-interval-ms') options.scanIntervalMs = Number(argv[++i]);
    else if (arg === '--max-commits-per-scan') options.maxCommitsPerScan = Number(argv[++i]);
    else if (arg === '--max-concurrency') options.maxConcurrency = Number(argv[++i]);
    else if (arg === '--queue-warn-size') options.queueWarnSize = Number(argv[++i]);
    else if (arg === '--queue-max-size') options.queueMaxSize = Number(argv[++i]);
    else if (arg === '--api-base-url') options.apiBaseUrl = argv[++i];
    else if (arg === '--source-system') options.sourceSystem = argv[++i];
    else if (arg === '--tool-name') options.toolName = argv[++i];
    else if (arg === '--session-id') options.sessionId = argv[++i];
    else if (arg === '--message') options.message = argv[++i];
    else if (arg === '--category') options.category = argv[++i] || options.category;
    else if (arg === '--title') options.title = argv[++i];
    else if (arg === '--rule') options.rule = argv[++i];
    else if (arg === '--context') options.context = argv[++i];
    else if (arg === '--source') options.sourceRef = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else positional.push(arg);
  }
  return { options, positional };
}

function printHelp() {
  console.log(`Usage: rorca-capture setup --always-on [--dry-run] [--json] [--workspace-id <id>]\n       rorca-capture setup --uninstall [--dry-run] [--json]\n       rorca-capture service <install|start|stop|restart|status|uninstall> --workspace-id <id> [--cwd <dir>] [--dry-run] [--json]\n       rorca-capture emit shell --workspace-id <id> [--cwd <dir>] [--phase start|end] [--command <cmd>] [--exit-code <n>] [--duration-ms <n>] [--policy metadata-only|command-summary|off] [--agent-pattern <regex>]\n       rorca-capture remember --workspace-id <id> --source-system <pi|claude_code|codex|opencode|shell|ide|daemon> --tool-name <name> --session-id <id> --message <summary> [--category <name>] [--title <title>] [--rule <rule>] [--context <context>] [--source <ref>]\n       rorca-capture daemon --workspace-id <id> [--cwd <dir>] [--once]\n\nExplicitly bootstraps and runs reversible, API-only always-on context capture helpers. Service lifecycle changes should be restarted after Rorca updates.`);
}

function findQueuePath(startDir) {
  let current = path.resolve(startDir || process.cwd());
  for (;;) {
    const candidate = path.join(current, '.rorca', 'capture', 'queue');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return path.join(path.resolve(startDir || process.cwd()), '.rorca', 'capture', 'queue');
    current = parent;
  }
}

function findWorkspacePath(startDir) {
  let current = path.resolve(startDir || process.cwd());
  for (;;) {
    if (existsSync(path.join(current, '.rorca-captureignore')) || existsSync(path.join(current, '.git')) || existsSync(path.join(current, '.rorca'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir || process.cwd());
    current = parent;
  }
}

function readGitInfo(cwd) {
  const run = (args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 ? String(result.stdout || '').trim() : null;
  };
  return {
    gitBranch: run(['rev-parse', '--abbrev-ref', 'HEAD']),
    gitSha: run(['rev-parse', 'HEAD']),
  };
}

function appendQueueEvent(queuePath, event) {
  mkdirSync(queuePath, { recursive: true });
  const source = typeof event.source === 'string' ? event.source : 'capture';
  writeFileSync(path.join(queuePath, `${source}.ndjson`), `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
}

async function runSetup(options) {
  if (options.uninstall) {
    const teardown = runCaptureTeardown({ dryRun: Boolean(options.dryRun), cwd: options.cwd, env: process.env });
    console.log(JSON.stringify(teardown, null, 2));
    return teardown.ok ? 0 : 1;
  }

  const report = await runCaptureBootstrap({
    alwaysOn: Boolean(options.alwaysOn),
    dryRun: Boolean(options.dryRun),
    workspaceId: options.workspaceId,
    cwd: options.cwd,
  });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatCaptureBootstrapHumanReport(report));
    console.log('');
    console.log('JSON report:');
    console.log(JSON.stringify(report, null, 2));
  }

  return report.ok ? 0 : 1;
}

function buildRememberEvent(options) {
  if (!options.workspaceId) throw new Error('--workspace-id is required.');
  if (!options.sourceSystem) throw new Error('--source-system is required.');
  if (!options.toolName) throw new Error('--tool-name is required.');
  if (!options.sessionId) throw new Error('--session-id is required.');
  const message = String(options.message || options.rule || options.context || '').trim();
  if (!message) throw new Error('--message is required unless --rule or --context is provided.');
  const sourceSystem = String(options.sourceSystem);
  const toolName = String(options.toolName);
  const sessionId = String(options.sessionId);
  return {
    workspaceId: options.workspaceId,
    source: sourceSystem === 'pi' || sourceSystem === 'claude_code' ? 'mcpSlashCommand' : 'shellIntegration',
    occurredAt: new Date().toISOString(),
    policyMode: 'explicit-transcript-import',
    payload: {
      source_system: sourceSystem,
      tool_name: toolName,
      session_id: sessionId,
      eventType: 'agent_memory',
      category: options.category || 'Decision',
      title: options.title || `${toolName} remembered context`,
      rule: options.rule || message,
      context: options.context || message,
      source: options.sourceRef || `${sourceSystem}:${sessionId}`,
      summary: message,
    },
  };
}

async function postRememberEvent(options, event) {
  const apiBaseUrl = options.apiBaseUrl || process.env.RORCA_CAPTURE_API_URL || 'http://127.0.0.1:3030';
  try {
    const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/api/context-capture/events`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function runRemember(options) {
  const event = buildRememberEvent(options);
  const posted = await postRememberEvent(options, event);
  if (!posted) appendQueueEvent(findQueuePath(options.cwd), { ...event, queuedAt: new Date().toISOString() });
  if (options.json) console.log(JSON.stringify({ ok: true, posted, queued: !posted, event }, null, 2));
  else console.log(posted ? 'Rorca capture memory submitted.' : 'Rorca capture memory queued for daemon flush.');
  return 0;
}

async function runEmit(positional, options) {
  const source = positional[1];
  if (source !== 'shell') {
    console.error('Only `rorca-capture emit shell` is supported.');
    return 1;
  }
  if (!options.workspaceId) {
    console.error('--workspace-id is required.');
    return 1;
  }
  const cwd = path.resolve(options.cwd || process.cwd());
  const workspacePath = findWorkspacePath(cwd);
  const git = readGitInfo(cwd);
  const event = buildShellCaptureEvent({
    workspaceId: options.workspaceId,
    workspacePath,
    cwd,
    command: String(options.command || ''),
    phase: options.phase === 'start' ? 'start' : 'end',
    exitCode: Number.isFinite(options.exitCode) ? options.exitCode : null,
    durationMs: Number.isFinite(options.durationMs) ? options.durationMs : null,
    gitBranch: git.gitBranch,
    gitSha: git.gitSha,
    policyMode: options.policyMode,
    captureIgnorePatterns: readCaptureIgnorePatterns(workspacePath),
    customAgentPatterns: options.customAgentPatterns.filter(Boolean),
  });
  if (!event) return 0;
  const posted = await postShellCaptureEvent({ apiBaseUrl: options.apiBaseUrl || process.env.RORCA_CAPTURE_API_URL || 'http://127.0.0.1:3030', event });
  if (!posted) enqueueShellCaptureEvent(findQueuePath(cwd), event);
  return 0;
}

function workspaceFromOptions(options) {
  if (!options.workspaceId) {
    throw new Error('--workspace-id is required.');
  }
  return { id: options.workspaceId, label: options.workspaceId, path: path.resolve(options.cwd || process.cwd()) };
}

function serviceConfigFromOptions(options) {
  return {
    scanIntervalMs: Number.isFinite(options.scanIntervalMs) ? options.scanIntervalMs : undefined,
    maxCommitsPerScan: Number.isFinite(options.maxCommitsPerScan) ? options.maxCommitsPerScan : undefined,
    maxConcurrency: Number.isFinite(options.maxConcurrency) ? options.maxConcurrency : undefined,
    queueWarnSize: Number.isFinite(options.queueWarnSize) ? options.queueWarnSize : undefined,
    queueMaxSize: Number.isFinite(options.queueMaxSize) ? options.queueMaxSize : undefined,
    apiBaseUrl: options.apiBaseUrl,
  };
}

async function runDaemon(options) {
  const workspace = workspaceFromOptions(options);
  await runManagedCaptureDaemon({ workspace, config: serviceConfigFromOptions(options), once: options.once });
  return options.once ? 0 : undefined;
}

function runService(positional, options) {
  const action = positional[1];
  const allowed = new Set(['install', 'start', 'stop', 'restart', 'status', 'uninstall']);
  if (!allowed.has(action)) {
    console.error('Usage: rorca-capture service <install|start|stop|restart|status|uninstall> --workspace-id <id>');
    return 1;
  }
  const workspace = workspaceFromOptions(options);
  const result = action === 'status'
    ? { ok: true, status: readCaptureServiceStatus(workspace, { config: serviceConfigFromOptions(options) }) }
    : runCaptureServiceLifecycle({ action, workspace, config: serviceConfigFromOptions(options), dryRun: options.dryRun, command: process.argv[1] });
  if (options.json || action === 'status') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.message || `service ${action}: ok`);
    if (result.serviceFile) console.log(`Service file: ${result.serviceFile}`);
  }
  return result.ok ? 0 : 1;
}

const { options, positional } = parseArgs(process.argv.slice(2));
if (options.help || positional.length === 0) {
  printHelp();
  process.exit(options.help ? 0 : 1);
}

try {
  let code;
  if (positional[0] === 'setup') code = await runSetup(options);
  else if (positional[0] === 'service') code = runService(positional, options);
  else if (positional[0] === 'emit') code = await runEmit(positional, options);
  else if (positional[0] === 'remember') code = await runRemember(options);
  else if (positional[0] === 'daemon') code = await runDaemon(options);
  else {
    printHelp();
    code = 1;
  }
  if (typeof code === 'number') process.exit(code);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
