#!/usr/bin/env node
// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTIONS = new Set(['render', 'install', 'status', 'uninstall']);

function usage(code = 0) {
  console.log(`Usage: node scripts/manage-always-on-monitor.mjs <action> [options]

Actions: render, install, status, uninstall
Options:
  --workspace-id <id>    Workspace id (default: rorca)
  --root <path>          Rorca checkout (default: this checkout)
  --api-base-url <url>   Loopback Rorca API (default: http://127.0.0.1:3030)
  --interval <seconds>   Schedule interval, 60-3600 (default: 300)
  --plist-dir <path>     LaunchAgent output directory (for review/tests)
  --dry-run              Print intended launchctl/filesystem changes only

render writes and validates the plist but never loads it. install is idempotent
and reloads only this exact label. uninstall unloads and removes only this exact
artifact. No external alert delivery is configured; the job writes the v1 local
status and privacy-safe local alert event spool.`);
  process.exit(code);
}

function command(program, args, allowFailure = false) {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  if (result.error && !allowFailure) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error('managed_monitor_command_failed');
  return result;
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function plistArray(values) {
  return values.map((value) => `    <string>${xml(value)}</string>`).join('\n');
}

function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') usage();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const options = {
    action: argv[0],
    root,
    workspaceId: 'rorca',
    apiBaseUrl: 'http://127.0.0.1:3030',
    interval: 300,
    plistDir: path.join(os.homedir(), 'Library', 'LaunchAgents'),
    dryRun: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace-id') options.workspaceId = argv[++index] || '';
    else if (arg === '--root') options.root = path.resolve(argv[++index] || '');
    else if (arg === '--api-base-url') options.apiBaseUrl = (argv[++index] || '').replace(/\/$/, '');
    else if (arg === '--interval') options.interval = Number(argv[++index]);
    else if (arg === '--plist-dir') options.plistDir = path.resolve(argv[++index] || '');
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') usage();
    else throw new Error('invalid_arguments');
  }
  if (!ACTIONS.has(options.action)) throw new Error('invalid_action');
  if (!/^[a-zA-Z0-9._-]+$/.test(options.workspaceId)) throw new Error('invalid_workspace_id');
  if (!Number.isInteger(options.interval) || options.interval < 60 || options.interval > 3600) throw new Error('invalid_interval');
  const api = new URL(options.apiBaseUrl);
  if (api.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)) throw new Error('api_must_be_loopback_http');
  return options;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'rorca';
}

function config(options) {
  const checkoutSlug = slug(path.basename(options.root));
  const label = `com.rorca.monitor.${checkoutSlug}.${slug(options.workspaceId)}`;
  const monitor = path.join(options.root, 'scripts', 'monitor-always-on-context.mjs');
  const serviceDir = path.join(options.root, '.rorca', 'services');
  const file = path.join(options.plistDir, `${label}.plist`);
  const args = [
    process.execPath,
    monitor,
    '--workspace-id', options.workspaceId,
    '--root', options.root,
    '--api-base-url', options.apiBaseUrl,
    '--status-file', path.join(serviceDir, 'always-on-monitor-status.json'),
    '--alert-sink', 'local-file',
    '--alert-events-file', path.join(serviceDir, 'always-on-alerts.ndjson'),
    '--rotate-logs',
    '--require-managed-schedule',
    '--json',
  ];
  return {
    label,
    target: `gui/${process.getuid()}/${label}`,
    file,
    monitor,
    serviceDir,
    stdoutLog: path.join(serviceDir, 'always-on-monitor.ndjson'),
    stderrLog: path.join(serviceDir, 'always-on-monitor.stderr.log'),
    args,
  };
}

function renderPlist(value, options) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(value.label)}</string>
  <key>ProgramArguments</key>
  <array>
${plistArray(value.args)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(options.root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${options.interval}</integer>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(value.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(value.stderrLog)}</string>
</dict>
</plist>
`;
}

function loaded(value) {
  return command('launchctl', ['print', value.target], true).status === 0;
}

function writeArtifact(value, options) {
  if (!existsSync(value.monitor)) throw new Error('monitor_entrypoint_missing');
  const content = renderPlist(value, options);
  if (options.dryRun) {
    console.log(`[dry-run] write ${value.file}`);
    return;
  }
  mkdirSync(path.dirname(value.file), { recursive: true });
  mkdirSync(value.serviceDir, { recursive: true });
  const temporary = `${value.file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o644 });
  renameSync(temporary, value.file);
  command('plutil', ['-lint', value.file]);
}

function ownedArtifact(value) {
  if (!existsSync(value.file)) return false;
  const content = readFileSync(value.file, 'utf8');
  return content.includes(`<string>${xml(value.label)}</string>`) && content.includes(`<string>${xml(value.monitor)}</string>`);
}

function printStatus(value) {
  const isLoaded = loaded(value);
  const output = isLoaded ? command('launchctl', ['print', value.target], true).stdout || '' : '';
  const state = output.match(/^\s*state = (.+)$/m)?.[1]?.trim() || (isLoaded ? 'unknown' : 'not-loaded');
  console.log(JSON.stringify({
    label: value.label,
    installed: ownedArtifact(value),
    loaded: isLoaded,
    state,
    plist: value.file,
    statusFile: path.join(value.serviceDir, 'always-on-monitor-status.json'),
    alertEventsFile: path.join(value.serviceDir, 'always-on-alerts.ndjson'),
  }, null, 2));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const value = config(options);

  if (options.action === 'render') return writeArtifact(value, options);
  if (process.platform !== 'darwin') throw new Error('launchd_required');
  if (options.action === 'status') return printStatus(value);

  if (options.action === 'install') {
    writeArtifact(value, options);
    if (options.dryRun) {
      console.log(`[dry-run] reload ${value.target}`);
      return;
    }
    if (loaded(value)) command('launchctl', ['bootout', value.target]);
    command('launchctl', ['bootstrap', `gui/${process.getuid()}`, value.file]);
    command('launchctl', ['kickstart', value.target]);
    return;
  }

  if (!ownedArtifact(value) && existsSync(value.file)) throw new Error('refusing_to_remove_unowned_artifact');
  if (options.dryRun) {
    console.log(`[dry-run] unload ${value.target}; remove ${value.file}`);
    return;
  }
  if (loaded(value)) command('launchctl', ['bootout', value.target]);
  if (ownedArtifact(value)) rmSync(value.file);
}

main().catch((error) => {
  const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'managed_monitor_error';
  console.error(`[managed-monitor] ${code}`);
  process.exitCode = 1;
});
