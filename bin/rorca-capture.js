#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatCaptureBootstrapHumanReport, runCaptureBootstrap } from '../packages/rorca-pi-extension/extensions/rorca/capture-bootstrap.js';

function parseArgs(argv) {
  const options = { alwaysOn: false, dryRun: false, json: false, workspaceId: undefined, cwd: process.cwd(), exitCode: undefined };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--always-on') options.alwaysOn = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--workspace-id') options.workspaceId = argv[++i];
    else if (arg === '--cwd') options.cwd = argv[++i] || process.cwd();
    else if (arg === '--exit-code') options.exitCode = Number(argv[++i] || '0');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else positional.push(arg);
  }
  return { options, positional };
}

function printHelp() {
  console.log(`Usage: rorca-capture setup --always-on [--dry-run] [--json] [--workspace-id <id>]\n       rorca-capture emit shell --workspace-id <id> [--cwd <dir>] [--exit-code <n>]\n       rorca-capture daemon --workspace-id <id>\n\nExplicitly bootstraps and runs reversible, API-only always-on context capture helpers.`);
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

function runDaemon(options) {
  if (!options.workspaceId) {
    console.error('--workspace-id is required.');
    return 1;
  }
  const queuePath = findQueuePath(process.cwd());
  appendQueueEvent(queuePath, {
    source: 'repoDaemon',
    workspaceId: options.workspaceId,
    cwd: process.cwd(),
    event: 'daemon-started',
    occurredAt: new Date().toISOString(),
  });
  setInterval(() => {
    appendQueueEvent(queuePath, {
      source: 'repoDaemon',
      workspaceId: options.workspaceId,
      cwd: process.cwd(),
      event: 'heartbeat',
      occurredAt: new Date().toISOString(),
    });
  }, 60_000);
  return undefined;
}

const { options, positional } = parseArgs(process.argv.slice(2));
if (options.help || positional.length === 0) {
  printHelp();
  process.exit(options.help ? 0 : 1);
}

try {
  let code;
  if (positional[0] === 'setup') code = await runSetup(options);
  else if (positional[0] === 'emit') code = runEmit(positional, options);
  else if (positional[0] === 'daemon') code = runDaemon(options);
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
