#!/usr/bin/env node
/**
 * Install and operate the local launchd services that keep Rorca's Express API
 * and pg-boss worker alive. This intentionally manages only processes from
 * this checkout; it never kills an unknown listener or worker.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { assertRestartSafeHealth } from './lib/restart-safety.mjs';

const DEFAULT_PORT = 3030;
const ACTIONS = new Set(['render', 'install', 'start', 'stop', 'restart', 'status', 'uninstall']);
const SERVICES = ['backend', 'worker'];

function usage(exitCode = 0) {
  console.log(`Usage: node scripts/rorca-managed-services.mjs <action> [options]

Actions: render, install, start, stop, restart, status, uninstall
Options:
  --service <backend|worker|all>  Service selection (default: all)
  --root <path>                   Rorca checkout (default: this checkout)
  --port <number>                 Backend port (default: 3030)
  --take-over                     Gracefully replace verified manual services
  --dry-run                       Print the intended changes only

install/start refuse to replace an existing process by default. --take-over
requires a healthy Rorca API with zero active pipeline runs and only signals
verified processes whose command belongs to this checkout. The frontend and
capture LaunchAgent are deliberately not managed here.`);
  process.exit(exitCode);
}

function fail(message) {
  console.error(`[rorca-services] ${message}`);
  process.exitCode = 1;
}

function command(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error && !allowFailure) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function plistArray(values, indent = '    ') {
  return values.map((value) => `${indent}<string>${xml(value)}</string>`).join('\n');
}

function plistEnvironment(values) {
  return Object.entries(values).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') usage();
  const result = { action: argv[0], service: 'all', root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), port: DEFAULT_PORT, takeOver: false, dryRun: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--service') result.service = argv[++i] || '';
    else if (arg === '--root') result.root = path.resolve(argv[++i] || '');
    else if (arg === '--port') result.port = Number(argv[++i]);
    else if (arg === '--take-over') result.takeOver = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--help' || arg === '-h') usage();
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!ACTIONS.has(result.action)) throw new Error(`Unknown action: ${result.action || '(none)'}`);
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error('--port must be a valid TCP port');
  if (!['all', ...SERVICES].includes(result.service)) throw new Error('--service must be backend, worker, or all');
  if (result.takeOver && !['install', 'start', 'restart'].includes(result.action)) throw new Error('--take-over is valid only with install, start, or restart');
  return result;
}

function projectSlug(root) {
  return path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'rorca';
}

function serviceConfig(kind, options) {
  const label = `com.rorca.${kind}.${projectSlug(options.root)}`;
  const backendDir = path.join(options.root, 'backend');
  const logDir = path.join(options.root, '.rorca', 'services');
  const homeDir = os.homedir();
  const safePath = Array.from(new Set([
    path.dirname(process.execPath),
    path.join(homeDir, '.pi', 'agent', 'bin'),
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    '/Applications/cmux.app/Contents/Resources/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])).join(':');
  const environment = {
    HOME: homeDir,
    PATH: safePath,
    NODE_ENV: process.env.NODE_ENV || 'development',
    PORT: String(options.port),
    RORCA_BIND_HOST: '127.0.0.1',
  };
  return {
    kind,
    label,
    target: `gui/${process.getuid()}/${label}`,
    file: path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
    backendDir,
    logDir,
    outLog: path.join(logDir, `${kind}.stdout.log`),
    errLog: path.join(logDir, `${kind}.stderr.log`),
    environment,
    entryPath: path.join(backendDir, 'src', kind === 'backend' ? 'server.ts' : 'worker.ts'),
    programArguments: [process.execPath, path.join(backendDir, 'node_modules', '.bin', 'tsx'), `src/${kind === 'backend' ? 'server' : 'worker'}.ts`],
  };
}

function renderPlist(config) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
${plistArray(config.programArguments, '    ')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(config.backendDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${plistEnvironment(config.environment)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>PathState</key>
    <dict>
      <key>${xml(config.entryPath)}</key>
      <true/>
    </dict>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(config.outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(config.errLog)}</string>
</dict>
</plist>
`;
}

function selectedConfigs(options) {
  return (options.service === 'all' ? SERVICES : [options.service]).map((kind) => serviceConfig(kind, options));
}

function loaded(config) {
  return command('launchctl', ['print', config.target], { allowFailure: true }).status === 0;
}

function launchdState(config) {
  const output = command('launchctl', ['print', config.target], { allowFailure: true }).stdout || '';
  return output.match(/^\s*state = (.+)$/m)?.[1]?.trim() || 'not-loaded';
}

function listenerPids(port) {
  const result = command('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { allowFailure: true });
  return (result.stdout || '').split(/\s+/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function commandForPid(pid) {
  return (command('ps', ['-p', String(pid), '-o', 'command='], { allowFailure: true }).stdout || '').trim();
}

function cwdForPid(pid) {
  const output = command('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { allowFailure: true }).stdout || '';
  const cwd = output.split('\n').find((line) => line.startsWith('n'))?.slice(1);
  return cwd ? path.resolve(cwd) : null;
}

function workerPids() {
  const output = command('ps', ['-axo', 'pid=,command='], { allowFailure: true }).stdout || '';
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}

function isVerifiedManualProcess(kind, pid, options) {
  const value = commandForPid(pid);
  const backendDir = path.join(options.root, 'backend');
  const entry = kind === 'backend' ? 'src/server.ts' : 'src/worker.ts';
  // The tsx executable can come from this checkout while the actual source
  // process runs in another worktree with a relative entrypoint. Require the
  // kernel-reported cwd as well as the command so take-over cannot signal a
  // sibling checkout by mistake.
  return cwdForPid(pid) === backendDir && value.includes(entry);
}

function manualPids(kind, options) {
  if (kind === 'backend') return listenerPids(options.port).filter((pid) => isVerifiedManualProcess(kind, pid, options));
  const candidates = workerPids()
    .filter(({ pid, command: value }) => value.includes('src/worker.ts') && cwdForPid(pid) === path.join(options.root, 'backend'));
  // tsx launches a small wrapper plus this preflight Node process. Signal the
  // latter so worker.ts can drain pg-boss and remove its heartbeat itself.
  const gracefulChildren = candidates.filter(({ command: value }) => value.includes('/tsx/dist/preflight.cjs'));
  return (gracefulChildren.length > 0 ? gracefulChildren : candidates).map(({ pid }) => pid);
}

function unexpectedConflict(kind, options) {
  if (kind !== 'backend') return false;
  const all = listenerPids(options.port);
  const verified = new Set(manualPids(kind, options));
  return all.some((pid) => !verified.has(pid));
}

async function verifyTakeoverSafe(options) {
  if (options.dryRun) {
    console.log(`[dry-run] require http://127.0.0.1:${options.port}/api/health with active_runs: 0 before take-over`);
    return;
  }
  const response = await fetch(`http://127.0.0.1:${options.port}/api/health`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
  if (!response) throw new Error(`refusing take-over: http://127.0.0.1:${options.port}/api/health is unreachable`);
  const health = await response.json().catch(() => null);
  // The health route intentionally returns 503 while migrations are pending.
  // Worker startup is what applies those migrations, so a blanket response.ok
  // requirement deadlocks the safe handoff. Require the two takeover safety
  // facts directly: a connected database and independently confirmed zero runs.
  assertRestartSafeHealth(health);
}

async function terminateVerified(kind, options) {
  const pids = manualPids(kind, options);
  if (pids.length === 0) return;
  if (!options.takeOver) throw new Error(`${kind} is already running from this checkout (PIDs ${pids.join(', ')}); rerun with --take-over after reviewing active work`);
  if (!options.takeOverVerified) await verifyTakeoverSafe(options);
  console.log(`[rorca-services] graceful take-over of ${kind} PID(s): ${pids.join(', ')}`);
  if (options.dryRun) return;
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const remaining = manualPids(kind, options);
    if (remaining.length === 0) return;
    await sleep(250);
  }
  throw new Error(`${kind} did not stop within 30 seconds; it was not force-killed`);
}

function ensureFiles(config, dryRun) {
  if (!existsSync(config.backendDir)) throw new Error(`backend directory not found: ${config.backendDir}`);
  if (!existsSync(config.entryPath)) throw new Error(`service entrypoint not found: ${config.entryPath}`);
  if (!existsSync(config.programArguments[1])) throw new Error(`tsx runtime not found: ${config.programArguments[1]} (run npm install first)`);
  if (dryRun) {
    console.log(`[dry-run] write ${config.file}`);
    return;
  }
  mkdirSync(path.dirname(config.file), { recursive: true });
  mkdirSync(config.logDir, { recursive: true });
  writeFileSync(config.file, renderPlist(config), { mode: 0o644 });
  const validation = command('plutil', ['-lint', config.file], { allowFailure: true });
  if (validation.status !== 0) throw new Error(`generated plist is invalid: ${(validation.stderr || validation.stdout || '').trim()}`);
}

async function start(config, options) {
  if (unexpectedConflict(config.kind, options)) {
    throw new Error(`port ${options.port} is owned by a non-Rorca process; refusing to replace it`);
  }
  await terminateVerified(config.kind, options);
  if (options.dryRun) {
    console.log(`[dry-run] ${loaded(config) ? 'launchctl kickstart' : 'launchctl bootstrap + kickstart'} ${config.target}`);
    return;
  }
  if (loaded(config)) {
    if (launchdState(config) !== 'running') command('launchctl', ['kickstart', config.target]);
  } else {
    command('launchctl', ['bootstrap', `gui/${process.getuid()}`, config.file]);
    // A manual bootstrap can leave a RunAtLoad job pended until a demand
    // event. Kickstart makes installation deterministic without waiting for
    // a login/reboot (the capture service has the same launchd behavior).
    command('launchctl', ['kickstart', '-k', config.target]);
  }
}

function stop(config, options) {
  if (!loaded(config)) {
    console.log(`[rorca-services] ${config.kind} is not loaded`);
    return;
  }
  // PathState keepalive is deliberately persistent while the checkout exists.
  // Bootout is the only deterministic operator stop; killing the process would
  // correctly cause launchd to replace it.
  if (options.dryRun) console.log(`[dry-run] launchctl bootout ${config.target}`);
  else command('launchctl', ['bootout', config.target]);
}

function serviceStatus(config, options) {
  const isLoaded = loaded(config);
  const result = isLoaded ? command('launchctl', ['print', config.target], { allowFailure: true }) : null;
  const state = result?.stdout?.match(/^\s*state = (.+)$/m)?.[1]?.trim() || (isLoaded ? 'unknown' : 'not-loaded');
  const manual = manualPids(config.kind, options);
  console.log(JSON.stringify({
    service: config.kind,
    label: config.label,
    loaded: isLoaded,
    state,
    plist: config.file,
    cwd: config.backendDir,
    stdoutLog: config.outLog,
    stderrLog: config.errLog,
    checkoutProcessPids: manual,
    ...(config.kind === 'backend' ? { port: options.port, listenerPids: listenerPids(options.port) } : {}),
  }, null, 2));
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('this launchd helper is macOS-only; it makes no changes on other platforms');
  const options = parseArgs(process.argv.slice(2));
  const configs = selectedConfigs(options);
  if (options.action === 'status') return configs.forEach((config) => serviceStatus(config, options));
  if (options.action === 'render') {
    for (const config of configs) ensureFiles(config, options.dryRun);
    return;
  }
  // Check safety before terminating the backend. A worker handoff performed
  // after a successful backend restart must not need the old API to still be
  // listening for this same, already-approved takeover.
  if (options.takeOver && ['install', 'start', 'restart'].includes(options.action)) {
    await verifyTakeoverSafe(options);
    options.takeOverVerified = true;
  }
  if (options.action === 'install') {
    for (const config of configs) ensureFiles(config, options.dryRun);
    for (const config of configs) {
      if (unexpectedConflict(config.kind, options)) {
        throw new Error(`port ${options.port} is owned by a non-Rorca process; refusing to replace it`);
      }
      // Reload an existing in-memory definition so plist updates are effective
      // immediately. A running managed job still requires explicit --take-over
      // and the global zero-active-run gate above.
      if (loaded(config)) {
        if (launchdState(config) === 'running' && !options.takeOver) {
          throw new Error(`${config.kind} is already launchd-managed; rerun install with --take-over to reload its definition`);
        }
        if (options.dryRun) console.log(`[dry-run] launchctl bootout ${config.target}`);
        else command('launchctl', ['bootout', config.target]);
      }
      await start(config, options);
    }
    return;
  }
  if (options.action === 'start') return Promise.all(configs.map((config) => start(config, options)));
  if (options.action === 'restart') {
    await verifyTakeoverSafe(options);
    for (const config of configs) {
      if (!loaded(config) || launchdState(config) !== 'running') {
        await start(config, options);
        continue;
      }
      if (options.dryRun) {
        console.log(`[dry-run] launchctl bootout ${config.target}; wait; launchctl bootstrap gui/${process.getuid()} ${config.file}; launchctl kickstart -k ${config.target}`);
        continue;
      }
      // Bootout sends a graceful termination while removing persistent
      // PathState demand, so launchd cannot race the drain by replacing the
      // process. Bootstrap then reloads the current on-disk definition.
      command('launchctl', ['bootout', config.target]);
      const deadline = Date.now() + 35_000;
      while (Date.now() < deadline && manualPids(config.kind, options).length > 0) await sleep(250);
      if (manualPids(config.kind, options).length > 0) throw new Error(`${config.kind} did not stop within 35 seconds; it was not force-killed`);
      command('launchctl', ['bootstrap', `gui/${process.getuid()}`, config.file]);
      command('launchctl', ['kickstart', '-k', config.target]);
    }
    return;
  }
  if (options.action === 'stop') return configs.forEach((config) => stop(config, options));
  if (options.action === 'uninstall') {
    for (const config of configs) {
      if (loaded(config)) {
        if (options.dryRun) console.log(`[dry-run] launchctl bootout ${config.target}`);
        else command('launchctl', ['bootout', config.target]);
      }
      if (existsSync(config.file)) {
        if (options.dryRun) console.log(`[dry-run] remove ${config.file}`);
        else rmSync(config.file);
      }
    }
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
