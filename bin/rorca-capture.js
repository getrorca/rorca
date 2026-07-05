#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatCaptureBootstrapHumanReport, runCaptureBootstrap } from '../packages/rorca-pi-extension/extensions/rorca/capture-bootstrap.js';
import { readCaptureServiceStatus, runCaptureServiceLifecycle, runManagedCaptureDaemon } from '../packages/rorca-pi-extension/extensions/rorca/capture-service.js';

function parseArgs(argv) {
  const options = { alwaysOn: false, dryRun: false, json: false, workspaceId: undefined, cwd: process.cwd(), exitCode: undefined, once: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--always-on') options.alwaysOn = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--once') options.once = true;
    else if (arg === '--workspace-id') options.workspaceId = argv[++i];
    else if (arg === '--cwd') options.cwd = argv[++i] || process.cwd();
    else if (arg === '--exit-code') options.exitCode = Number(argv[++i] || '0');
    else if (arg === '--scan-interval-ms') options.scanIntervalMs = Number(argv[++i]);
    else if (arg === '--max-commits-per-scan') options.maxCommitsPerScan = Number(argv[++i]);
    else if (arg === '--max-concurrency') options.maxConcurrency = Number(argv[++i]);
    else if (arg === '--queue-warn-size') options.queueWarnSize = Number(argv[++i]);
    else if (arg === '--queue-max-size') options.queueMaxSize = Number(argv[++i]);
    else if (arg === '--api-base-url') options.apiBaseUrl = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else positional.push(arg);
  }
  return { options, positional };
}

function printHelp() {
  console.log(`Usage: rorca-capture setup --always-on [--dry-run] [--json] [--workspace-id <id>]\n       rorca-capture service <install|start|stop|restart|status|uninstall> --workspace-id <id> [--cwd <dir>] [--dry-run] [--json]\n       rorca-capture emit shell --workspace-id <id> [--cwd <dir>] [--exit-code <n>]\n       rorca-capture daemon --workspace-id <id> [--cwd <dir>] [--once]\n\nExplicitly bootstraps and runs reversible, API-only always-on context capture helpers. Service lifecycle changes should be restarted after Rorca updates.`);
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

function appendQueueEvent(queuePath, event) {
  mkdirSync(queuePath, { recursive: true });
  const source = typeof event.source === 'string' ? event.source : 'capture';
  writeFileSync(path.join(queuePath, `${source}.ndjson`), `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
}

async function runSetup(options) {
  const report = await runCaptureBootstrap({
    alwaysOn: Boolean(options.alwaysOn),
    dryRun: Boolean(options.dryRun),
    workspaceId: options.workspaceId,
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

function runEmit(positional, options) {
  const source = positional[1];
  if (source !== 'shell') {
    console.error('Only `rorca-capture emit shell` is supported.');
    return 1;
  }
  if (!options.workspaceId) {
    console.error('--workspace-id is required.');
    return 1;
  }
  appendQueueEvent(findQueuePath(options.cwd), {
    source: 'shellIntegration',
    workspaceId: options.workspaceId,
    cwd: path.resolve(options.cwd || process.cwd()),
    exitCode: Number.isFinite(options.exitCode) ? options.exitCode : 0,
    occurredAt: new Date().toISOString(),
  });
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
  else if (positional[0] === 'emit') code = runEmit(positional, options);
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
