#!/usr/bin/env node
/**
 * Fail-closed, read-only audit for the macOS Always-On Context login stack.
 * It never loads, stops, restarts, or signals a service.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const options = {
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    workspaceId: 'rorca',
    port: 3030,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index] || '');
    else if (arg === '--workspace-id') options.workspaceId = argv[++index] || '';
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/verify-always-on-login-readiness.mjs [--root <path>] [--workspace-id <id>] [--port <n>] [--json]');
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.workspaceId || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('workspace ID and port must be valid');
  }
  return options;
}

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

function readPlist(file) {
  const result = run('plutil', ['-convert', 'json', '-o', '-', file]);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'plutil failed').trim());
  return JSON.parse(result.stdout);
}

function pushCheck(checks, scope, name, ok, detail) {
  checks.push({ scope, name, ok: Boolean(ok), detail });
}

function pidCwd(pid) {
  const result = run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  return (result.stdout || '').split('\n').find((line) => line.startsWith('n'))?.slice(1) || null;
}

function pidCommand(pid) {
  return (run('ps', ['-p', String(pid), '-o', 'command=']).stdout || '').trim();
}

function listenerPids(port) {
  return (run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).stdout || '').split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}

function writableParent(file) {
  try {
    accessSync(path.dirname(file), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function expectedServices(options) {
  const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const backendDir = path.join(options.root, 'backend');
  const node = process.execPath;
  return [
    {
      name: 'backend',
      label: `com.rorca.backend.${path.basename(options.root).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
      plist: path.join(launchAgents, `com.rorca.backend.${path.basename(options.root).toLowerCase().replace(/[^a-z0-9-]/g, '-')}.plist`),
      cwd: backendDir,
      args: [node, path.join(backendDir, 'node_modules', '.bin', 'tsx'), 'src/server.ts'],
      stdout: path.join(options.root, '.rorca', 'services', 'backend.stdout.log'),
      stderr: path.join(options.root, '.rorca', 'services', 'backend.stderr.log'),
      keepAlivePath: path.join(backendDir, 'src', 'server.ts'),
      env: { HOME: os.homedir(), PORT: String(options.port), RORCA_BIND_HOST: '127.0.0.1' },
    },
    {
      name: 'worker',
      label: `com.rorca.worker.${path.basename(options.root).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`,
      plist: path.join(launchAgents, `com.rorca.worker.${path.basename(options.root).toLowerCase().replace(/[^a-z0-9-]/g, '-')}.plist`),
      cwd: backendDir,
      args: [node, path.join(backendDir, 'node_modules', '.bin', 'tsx'), 'src/worker.ts'],
      stdout: path.join(options.root, '.rorca', 'services', 'worker.stdout.log'),
      stderr: path.join(options.root, '.rorca', 'services', 'worker.stderr.log'),
      keepAlivePath: path.join(backendDir, 'src', 'worker.ts'),
      env: { HOME: os.homedir(), PORT: String(options.port), RORCA_BIND_HOST: '127.0.0.1' },
    },
    {
      name: 'capture',
      label: `com.rorca.capture.${options.workspaceId}`,
      plist: path.join(launchAgents, `com.rorca.capture.${options.workspaceId}.plist`),
      cwd: options.root,
      args: [node, path.join(options.root, 'bin', 'rorca-capture.js'), 'daemon', '--workspace-id', options.workspaceId, '--cwd', options.root],
      stdout: path.join(options.root, '.rorca', 'capture', 'service.log'),
      stderr: path.join(options.root, '.rorca', 'capture', 'service.log'),
      keepAlivePath: path.join(options.root, 'bin', 'rorca-capture.js'),
      env: { HOME: os.homedir(), RORCA_CAPTURE_API_URL: `http://127.0.0.1:${options.port}` },
    },
  ];
}

async function audit(options) {
  const checks = [];
  if (process.platform !== 'darwin') {
    pushCheck(checks, 'host', 'macOS launchd host', false, `platform=${process.platform}`);
    return checks;
  }

  const uid = process.getuid();
  for (const service of expectedServices(options)) {
    const lint = run('plutil', ['-lint', service.plist]);
    pushCheck(checks, service.name, 'plist exists and passes plutil', existsSync(service.plist) && lint.status === 0, service.plist);
    if (!existsSync(service.plist) || lint.status !== 0) continue;

    let plist;
    try {
      plist = readPlist(service.plist);
    } catch (error) {
      pushCheck(checks, service.name, 'plist JSON inspection', false, error instanceof Error ? error.message : String(error));
      continue;
    }
    const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
    pushCheck(checks, service.name, 'label', plist.Label === service.label, String(plist.Label));
    pushCheck(checks, service.name, 'absolute executable and arguments', service.args.every((value, index) => args[index] === value), args.join(' '));
    pushCheck(checks, service.name, 'working directory', plist.WorkingDirectory === service.cwd && existsSync(service.cwd), String(plist.WorkingDirectory));
    pushCheck(checks, service.name, 'RunAtLoad', plist.RunAtLoad === true, String(plist.RunAtLoad));
    pushCheck(checks, service.name, 'entrypoint KeepAlive demand', plist.KeepAlive?.PathState?.[service.keepAlivePath] === true && existsSync(service.keepAlivePath), JSON.stringify(plist.KeepAlive));
    pushCheck(checks, service.name, '10 second throttle', plist.ThrottleInterval === 10, String(plist.ThrottleInterval));
    pushCheck(checks, service.name, 'background process type', plist.ProcessType === 'Background', String(plist.ProcessType));
    pushCheck(checks, service.name, 'stdout path and writable directory', plist.StandardOutPath === service.stdout && writableParent(service.stdout), String(plist.StandardOutPath));
    pushCheck(checks, service.name, 'stderr path and writable directory', plist.StandardErrorPath === service.stderr && writableParent(service.stderr), String(plist.StandardErrorPath));
    const environment = plist.EnvironmentVariables || {};
    for (const [key, value] of Object.entries(service.env)) {
      pushCheck(checks, service.name, `environment ${key}`, environment[key] === value, environment[key] == null ? 'missing' : 'configured');
    }
    const pathEntries = String(environment.PATH || '').split(':');
    pushCheck(checks, service.name, 'environment PATH', pathEntries.includes(path.dirname(process.execPath)) && pathEntries.includes('/usr/bin') && pathEntries.includes('/bin'), environment.PATH ? `${pathEntries.length} entries` : 'missing');

    const target = `gui/${uid}/${service.label}`;
    const printed = run('launchctl', ['print', target]);
    pushCheck(checks, service.name, 'launchctl job loaded', printed.status === 0, target);
    if (printed.status === 0) {
      const output = printed.stdout || '';
      const state = output.match(/^\s*state = (.+)$/m)?.[1]?.trim() || 'unknown';
      pushCheck(checks, service.name, 'launchctl state running', state === 'running', state);
      const loadedDefinitionValues = [
        service.cwd,
        service.args[0],
        service.stdout,
        service.stderr,
        environment.PATH,
        ...Object.values(service.env),
        ...Object.keys(plist.KeepAlive?.PathState || {}),
      ].filter(Boolean);
      pushCheck(checks, service.name, 'loaded job matches installed cwd/program/logs/environment/keepalive', loadedDefinitionValues.every((value) => output.includes(String(value))), 'launchctl print');
    }
  }

  try {
    const response = await fetch(`http://127.0.0.1:${options.port}/api/health`, { signal: AbortSignal.timeout(5_000) });
    const health = await response.json();
    pushCheck(checks, 'backend', 'health endpoint reachable', response.ok, `HTTP ${response.status}`);
    pushCheck(checks, 'backend', 'database connected', health.db_connected === true, String(health.db_connected));
    pushCheck(checks, 'backend', 'no active pipeline runs', Number(health.active_runs) === 0, String(health.active_runs));
    const backendDir = path.join(options.root, 'backend');
    const listeners = listenerPids(options.port);
    const ownedListeners = listeners.filter((pid) => pidCwd(pid) === backendDir && pidCommand(pid).includes('src/server.ts'));
    pushCheck(checks, 'backend', 'listener owned by this checkout', listeners.length === 1 && ownedListeners.length === 1, JSON.stringify({ listeners, ownedListeners }));
    const workerPid = health.components?.worker?.activePid;
    pushCheck(checks, 'worker', 'heartbeat healthy', health.components?.worker?.status === 'ok' && Number.isInteger(workerPid), JSON.stringify({ status: health.components?.worker?.status, pid: workerPid, lastHeartbeat: health.components?.worker?.lastHeartbeat }));
    pushCheck(checks, 'worker', 'heartbeat process owned by this checkout', Number.isInteger(workerPid) && pidCwd(workerPid) === backendDir && pidCommand(workerPid).includes('src/worker.ts'), JSON.stringify({ pid: workerPid, cwd: Number.isInteger(workerPid) ? pidCwd(workerPid) : null }));
    const heartbeatAge = Date.now() - Date.parse(health.components?.worker?.lastHeartbeat || '');
    pushCheck(checks, 'worker', 'heartbeat fresh', Number.isFinite(heartbeatAge) && heartbeatAge >= 0 && heartbeatAge <= 90_000, Number.isFinite(heartbeatAge) ? `${Math.round(heartbeatAge / 1000)}s` : 'missing');
  } catch (error) {
    pushCheck(checks, 'backend', 'health endpoint reachable', false, error instanceof Error ? error.message : String(error));
  }

  const capture = run(process.execPath, [path.join(options.root, 'bin', 'rorca-capture.js'), 'service', 'status', '--workspace-id', options.workspaceId, '--cwd', options.root]);
  try {
    const parsed = JSON.parse(capture.stdout || '{}');
    const status = parsed.status;
    pushCheck(checks, 'capture', 'durable service status', capture.status === 0 && status?.processHealth?.running === true, JSON.stringify(status?.processHealth));
    pushCheck(checks, 'capture', 'policy enabled and unpaused', status?.capturePolicy?.policyMode !== 'off' && status?.capturePolicy?.paused === false, JSON.stringify({ mode: status?.capturePolicy?.policyMode, paused: status?.capturePolicy?.paused }));
    pushCheck(checks, 'capture', 'queue drained without backoff', status?.queueDepth === 0 && status?.backoffMs === 0, JSON.stringify({ queueDepth: status?.queueDepth, backoffMs: status?.backoffMs }));
    const seenAge = Date.now() - Date.parse(status?.last_seen || '');
    pushCheck(checks, 'capture', 'last_seen fresh', Number.isFinite(seenAge) && seenAge >= 0 && seenAge <= 130_000, Number.isFinite(seenAge) ? `${Math.round(seenAge / 1000)}s` : 'missing');
  } catch (error) {
    pushCheck(checks, 'capture', 'durable service status', false, error instanceof Error ? error.message : String(error));
  }
  return checks;
}

const options = parseArgs(process.argv.slice(2));
const checks = await audit(options);
const failures = checks.filter((check) => !check.ok);
const report = {
  ok: failures.length === 0,
  checkedAt: new Date().toISOString(),
  root: options.root,
  workspaceId: options.workspaceId,
  checks,
  failureCount: failures.length,
};
if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} [${check.scope}] ${check.name}: ${check.detail}`);
  console.log(`\nAlways-On login readiness: ${report.ok ? 'READY' : `NOT READY (${failures.length} failed checks)`}`);
}
process.exitCode = report.ok ? 0 : 1;
