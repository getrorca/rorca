#!/usr/bin/env node
/**
 * Production-safe pre/post reboot smoke orchestration for the local macOS
 * Always-On Context launchd stack. Reboot is deliberately interactive-only.
 */
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  fsyncSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const ACTIONS = new Set(['preflight', 'arm', 'status', 'disarm', 'post-login', 'reboot-now']);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_TIMEOUT_SECONDS = 180;

function usage(exitCode = 0) {
  console.log(`Usage: node scripts/always-on-reboot-smoke.mjs <action> [options]

Actions:
  preflight   Run and durably record the fail-closed readiness/safety gate
  arm         Snapshot dirty work, pass the gate twice, and install a marker-gated one-shot LaunchAgent
  status      Show armed state and the latest durable result
  disarm      Remove only the one-shot marker/LaunchAgent; preserve all evidence
  post-login  Internal one-shot action invoked by launchd after login
  reboot-now  Re-run the gate, sync evidence, and reboot (interactive TTY + --confirm-reboot required)

Options:
  --root <path>               Rorca checkout (default: this checkout)
  --workspace-id <id>        Capture workspace (default: rorca)
  --port <number>             Backend port (default: 3030)
  --timeout-seconds <number>  Post-login settle deadline (default: 180)
  --confirm-reboot            Required only for the interactive reboot-now action

Evidence is preserved under .rorca/services/reboot-smoke/. The arm action does
not bootstrap the one-shot job in the current login session; macOS loads it at
the next login. No action deletes capture queues or modifies managed services.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  if (argv[0] === '--help' || argv[0] === '-h') usage();
  const options = {
    action: argv[0],
    root: path.resolve(path.dirname(SCRIPT_PATH), '..'),
    workspaceId: 'rorca',
    port: 3030,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    confirmReboot: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index] || '');
    else if (arg === '--workspace-id') options.workspaceId = argv[++index] || '';
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--timeout-seconds') options.timeoutSeconds = Number(argv[++index]);
    else if (arg === '--confirm-reboot') options.confirmReboot = true;
    else if (arg === '--help' || arg === '-h') usage();
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!ACTIONS.has(options.action)) throw new Error(`Unknown action: ${options.action || '(none)'}`);
  if (!options.workspaceId) throw new Error('--workspace-id must not be empty');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port must be a valid TCP port');
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 30 || options.timeoutSeconds > 900) {
    throw new Error('--timeout-seconds must be an integer from 30 to 900');
  }
  return options;
}

function pathsFor(options) {
  const slug = path.basename(options.root).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'rorca';
  const label = `com.rorca.login-smoke.${slug}`;
  const evidenceDir = path.join(options.root, '.rorca', 'services', 'reboot-smoke');
  return {
    slug,
    label,
    target: `gui/${process.getuid?.()}/${label}`,
    evidenceDir,
    backupsDir: path.join(evidenceDir, 'backups'),
    arm: path.join(evidenceDir, 'armed.json'),
    latestPreflight: path.join(evidenceDir, 'preflight-latest.json'),
    latestPostLogin: path.join(evidenceDir, 'post-login-latest.json'),
    attempts: path.join(evidenceDir, 'post-login-attempts.ndjson'),
    commands: path.join(evidenceDir, 'commands.log'),
    rebootCommand: path.join(evidenceDir, 'REBOOT-COMMAND.txt'),
    stdout: path.join(evidenceDir, 'post-login.launchd.stdout.log'),
    stderr: path.join(evidenceDir, 'post-login.launchd.stderr.log'),
    plist: path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding === null ? null : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout,
    stdio: options.stdio,
  });
}

function commandFailure(command, args, result) {
  const detail = result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
  return `${command} ${args.join(' ')} failed: ${String(detail).trim()}`;
}

function requireCommand(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0 || result.error) throw new Error(commandFailure(command, args, result));
  return result;
}

function ensureHost(options) {
  if (process.platform !== 'darwin') throw new Error('this reboot/login smoke helper is macOS-only');
  if (!existsSync(path.join(options.root, 'scripts', 'verify-always-on-login-readiness.mjs'))) {
    throw new Error(`readiness verifier is missing under ${options.root}`);
  }
  if (path.resolve(SCRIPT_PATH) !== path.resolve(options.root, 'scripts', path.basename(SCRIPT_PATH))) {
    throw new Error('run the reboot-smoke script from the checkout selected by --root');
  }
}

function ensureDir(directory) {
  mkdirSync(directory, { recursive: true });
}

function durableWrite(file, content, mode = 0o600) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, 'w', mode);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, mode);
  renameSync(temporary, file);
  const directoryFd = openSync(path.dirname(file), 'r');
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function durableJson(file, value, mode = 0o600) {
  durableWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function appendCommand(paths, action, command) {
  ensureDir(paths.evidenceDir);
  appendFileSync(paths.commands, `${new Date().toISOString()}\t${action}\t${command}\n`, { mode: 0o600 });
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistArray(values) {
  return values.map((value) => `    <string>${xml(value)}</string>`).join('\n');
}

function safePath() {
  const home = os.homedir();
  return Array.from(new Set([
    path.dirname(process.execPath),
    path.join(home, '.pi', 'agent', 'bin'),
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])).join(':');
}

function renderPlist(options, paths) {
  const args = [
    process.execPath,
    SCRIPT_PATH,
    'post-login',
    '--root', options.root,
    '--workspace-id', options.workspaceId,
    '--port', String(options.port),
    '--timeout-seconds', String(options.timeoutSeconds),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(paths.label)}</string>
  <key>ProgramArguments</key>
  <array>
${plistArray(args)}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(options.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(os.homedir())}</string>
    <key>PATH</key>
    <string>${xml(safePath())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderr)}</string>
</dict>
</plist>
`;
}

function bootSession() {
  const result = requireCommand('/usr/sbin/sysctl', ['-n', 'kern.boottime']);
  const raw = result.stdout.trim();
  const seconds = Number(raw.match(/sec\s*=\s*(\d+)/)?.[1]);
  if (!Number.isFinite(seconds)) throw new Error(`unable to parse kern.boottime: ${raw}`);
  return { raw, epochMs: seconds * 1000 };
}

function parseJsonOutput(result, description) {
  if (result.status !== 0 && !result.stdout) throw new Error(`${description}: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
  try {
    return JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw new Error(`${description} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function verifierCommand(options) {
  return [
    path.join(options.root, 'scripts', 'verify-always-on-login-readiness.mjs'),
    '--root', options.root,
    '--workspace-id', options.workspaceId,
    '--port', String(options.port),
    '--json',
  ];
}

function runVerifier(options) {
  const args = verifierCommand(options);
  const result = run(process.execPath, args, { cwd: options.root, timeout: 30_000 });
  const report = parseJsonOutput(result, 'login readiness verifier');
  return { command: [process.execPath, ...args], exitCode: result.status, report };
}

function executionProcesses() {
  const result = requireCommand('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) return [];
    const pid = Number(match[1]);
    const command = match[3];
    return /(?:execution-engine(?:-entrypoint)?(?:\.js|\.ts)?|run-loop\.sh)(?:\s|$)/.test(command) && pid !== process.pid
      ? [{ pid, ppid: Number(match[2]), command }]
      : [];
  });
}

function launchdSnapshot(label) {
  const target = `gui/${process.getuid()}/${label}`;
  const result = run('/bin/launchctl', ['print', target]);
  const output = result.stdout || '';
  return {
    label,
    target,
    loaded: result.status === 0,
    state: output.match(/^\s*state = (.+)$/m)?.[1]?.trim() || 'not-loaded',
    pid: Number(output.match(/^\s*pid = (\d+)$/m)?.[1]) || null,
    runs: Number(output.match(/^\s*runs = (\d+)$/m)?.[1]) || null,
  };
}

function serviceLabels(options) {
  const slug = path.basename(options.root).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'rorca';
  return [`com.rorca.backend.${slug}`, `com.rorca.worker.${slug}`, `com.rorca.capture.${options.workspaceId}`];
}

function serviceLogs(options) {
  return {
    backendStdout: path.join(options.root, '.rorca', 'services', 'backend.stdout.log'),
    backendStderr: path.join(options.root, '.rorca', 'services', 'backend.stderr.log'),
    workerStdout: path.join(options.root, '.rorca', 'services', 'worker.stdout.log'),
    workerStderr: path.join(options.root, '.rorca', 'services', 'worker.stderr.log'),
    capture: path.join(options.root, '.rorca', 'capture', 'service.log'),
  };
}

function logSnapshot(options) {
  return Object.fromEntries(Object.entries(serviceLogs(options)).map(([name, file]) => {
    if (!existsSync(file)) return [name, { file, exists: false, size: null, mtime: null, mtimeMs: null }];
    const stat = statSync(file);
    return [name, { file, exists: true, size: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs }];
  }));
}

function preflight(options, paths, phase = 'preflight') {
  const verifier = runVerifier(options);
  const engines = executionProcesses();
  const report = {
    ok: verifier.report.ok === true && engines.length === 0,
    phase,
    checkedAt: new Date().toISOString(),
    root: options.root,
    workspaceId: options.workspaceId,
    port: options.port,
    bootSession: bootSession(),
    verifier: verifier.report,
    executionProcesses: engines,
    services: serviceLabels(options).map(launchdSnapshot),
    logs: logSnapshot(options),
    commands: {
      verifier: verifier.command,
      executionProcessAudit: ['/bin/ps', '-axo', 'pid=,ppid=,command='],
    },
  };
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${phase}`;
  const file = path.join(paths.evidenceDir, `${id}.json`);
  durableJson(file, report);
  durableJson(paths.latestPreflight, { ...report, evidenceFile: file });
  appendCommand(paths, phase, verifier.command.join(' '));
  if (!report.ok) {
    const failures = verifier.report.checks?.filter((check) => !check.ok).map((check) => `[${check.scope}] ${check.name}`) || [];
    if (engines.length > 0) failures.push(`execution processes: ${engines.map(({ pid }) => pid).join(', ')}`);
    throw new Error(`preflight failed closed: ${failures.join('; ') || 'readiness verifier was not ready'}`);
  }
  return { report, file };
}

function gitBuffer(root, args) {
  const result = run('/usr/bin/git', args, { cwd: root, encoding: null });
  if (result.status !== 0 || result.error) {
    const textResult = { ...result, stdout: result.stdout?.toString(), stderr: result.stderr?.toString() };
    throw new Error(commandFailure('/usr/bin/git', args, textResult));
  }
  return result.stdout || Buffer.alloc(0);
}

function nulList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function copySnapshotEntry(root, destinationRoot, relative, manifest, category) {
  const source = path.resolve(root, relative);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!source.startsWith(rootPrefix)) throw new Error(`unsafe snapshot path: ${relative}`);
  if (!existsSync(source)) {
    manifest.push({ category, path: relative, state: 'deleted' });
    return;
  }
  const destination = path.join(destinationRoot, relative);
  ensureDir(path.dirname(destination));
  const sourceStat = lstatSync(source);
  if (sourceStat.isSymbolicLink()) {
    const target = readlinkSync(source);
    symlinkSync(target, destination);
    manifest.push({ category, path: relative, state: 'present', type: 'symlink', target });
    return;
  }
  if (!sourceStat.isFile()) throw new Error(`snapshot entry is not a regular file or symlink: ${relative}`);
  copyFileSync(source, destination);
  chmodSync(destination, sourceStat.mode & 0o777);
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
  manifest.push({ category, path: relative, state: 'present', type: 'file', mode: sourceStat.mode & 0o777, size: sourceStat.size, sha256: hash });
}

function snapshotDirtyWork(options, paths, id) {
  const snapshotDir = path.join(paths.backupsDir, id);
  ensureDir(snapshotDir);
  const statusBefore = gitBuffer(options.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const tracked = nulList(gitBuffer(options.root, ['diff', '--name-only', '-z', 'HEAD', '--']));
  const untracked = nulList(gitBuffer(options.root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const manifest = [];
  for (const relative of tracked) copySnapshotEntry(options.root, path.join(snapshotDir, 'tracked-working-tree'), relative, manifest, 'tracked');
  for (const relative of untracked) copySnapshotEntry(options.root, path.join(snapshotDir, 'untracked'), relative, manifest, 'untracked');
  durableWrite(path.join(snapshotDir, 'status-before.z'), statusBefore);
  durableWrite(path.join(snapshotDir, 'index-stage.z'), gitBuffer(options.root, ['ls-files', '--stage', '-z']));
  const head = gitBuffer(options.root, ['rev-parse', 'HEAD']).toString('utf8').trim();
  const statusAfter = gitBuffer(options.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  durableWrite(path.join(snapshotDir, 'status-after.z'), statusAfter);
  const consistent = statusBefore.equals(statusAfter);
  const summary = {
    createdAt: new Date().toISOString(),
    root: options.root,
    head,
    consistent,
    trackedEntryCount: tracked.length,
    untrackedEntryCount: untracked.length,
    restoreNote: 'Use the recorded HEAD/index-stage plus tracked-working-tree, untracked, and deleted manifest entries. Do not apply restoration destructively without a separate backup.',
    manifest,
  };
  durableJson(path.join(snapshotDir, 'manifest.json'), summary);
  if (!consistent) throw new Error(`dirty work changed during snapshot; evidence was preserved at ${snapshotDir}, but arming was refused`);
  return { snapshotDir, head, trackedEntryCount: tracked.length, untrackedEntryCount: untracked.length };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function installOneShot(options, paths) {
  ensureDir(paths.evidenceDir);
  ensureDir(path.dirname(paths.plist));
  durableWrite(paths.plist, renderPlist(options, paths), 0o644);
  const lint = run('/usr/bin/plutil', ['-lint', paths.plist]);
  if (lint.status !== 0) {
    rmSync(paths.plist, { force: true });
    throw new Error(commandFailure('/usr/bin/plutil', ['-lint', paths.plist], lint));
  }
}

function syncFilesystem() {
  requireCommand('/bin/sync', []);
}

function arm(options, paths) {
  if (existsSync(paths.arm)) throw new Error(`a reboot smoke is already armed: ${paths.arm}`);
  const oneShot = launchdSnapshot(paths.label);
  if (oneShot.loaded) throw new Error(`one-shot job is already loaded (${paths.target}); run disarm before arming a new smoke`);
  const initial = preflight(options, paths, 'arm-initial');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const snapshot = snapshotDirtyWork(options, paths, id);
  const final = preflight(options, paths, 'arm-final');
  const marker = {
    version: 1,
    id,
    armedAt: new Date().toISOString(),
    expectation: 'reboot',
    root: options.root,
    workspaceId: options.workspaceId,
    port: options.port,
    timeoutSeconds: options.timeoutSeconds,
    preRebootBootSession: final.report.bootSession,
    preRebootServices: final.report.services,
    initialPreflight: initial.file,
    finalPreflight: final.file,
    dirtyWorkSnapshot: snapshot,
    postLoginResult: paths.latestPostLogin,
  };
  durableJson(paths.arm, marker);
  installOneShot(options, paths);
  const command = `node scripts/always-on-reboot-smoke.mjs reboot-now --confirm-reboot`;
  durableWrite(paths.rebootCommand, `${command}\n`);
  appendCommand(paths, 'arm', command);
  syncFilesystem();
  console.log(JSON.stringify({ ok: true, armed: true, marker: paths.arm, oneShotPlist: paths.plist, evidenceDir: paths.evidenceDir, dirtyWorkSnapshot: snapshot.snapshotDir, humanRebootCommand: command }, null, 2));
}

function disarm(paths) {
  const loaded = launchdSnapshot(paths.label);
  if (loaded.loaded) requireCommand('/bin/launchctl', ['bootout', paths.target]);
  rmSync(paths.plist, { force: true });
  rmSync(paths.arm, { force: true });
  appendCommand(paths, 'disarm', `launchctl bootout ${paths.target}; remove marker and ${paths.plist}`);
  syncFilesystem();
  console.log(JSON.stringify({ ok: true, armed: false, evidencePreservedAt: paths.evidenceDir }, null, 2));
}

function status(paths) {
  const armed = existsSync(paths.arm) ? readJson(paths.arm) : null;
  const latest = existsSync(paths.latestPostLogin) ? readJson(paths.latestPostLogin) : null;
  console.log(JSON.stringify({
    ok: true,
    armed: Boolean(armed),
    marker: armed,
    oneShotPlist: { file: paths.plist, installed: existsSync(paths.plist), ...launchdSnapshot(paths.label) },
    latestPostLogin: latest,
    evidenceDir: paths.evidenceDir,
  }, null, 2));
}

function postLoginSnapshot(options, armMarker) {
  const verifier = runVerifier(options);
  const boot = bootSession();
  const services = serviceLabels(options).map(launchdSnapshot);
  const logs = logSnapshot(options);
  const rebootObserved = boot.epochMs !== armMarker.preRebootBootSession.epochMs;
  const servicesRunning = services.every((service) => service.loaded && service.state === 'running' && Number.isInteger(service.pid));
  // Successful services are not required to write stderr. Require the three
  // positive-activity logs that prove each layer did work after this boot.
  const logsFresh = ['backendStdout', 'workerStdout', 'capture']
    .every((name) => logs[name].exists && Number(logs[name].mtimeMs) >= boot.epochMs - 1000);
  return {
    checkedAt: new Date().toISOString(),
    bootSession: boot,
    rebootObserved,
    readiness: verifier.report,
    services,
    logs,
    servicesRunning,
    logsFresh,
    ok: rebootObserved && verifier.report.ok === true && servicesRunning && logsFresh,
  };
}

async function postLogin(options, paths) {
  if (!existsSync(paths.arm)) return;
  const marker = readJson(paths.arm);
  if (marker.root !== options.root || marker.workspaceId !== options.workspaceId || marker.port !== options.port) {
    throw new Error('armed marker does not match the one-shot LaunchAgent arguments');
  }
  appendCommand(paths, 'post-login', [process.execPath, SCRIPT_PATH, ...process.argv.slice(2)].join(' '));
  const deadline = Date.now() + marker.timeoutSeconds * 1000;
  let attempt = 0;
  let current;
  do {
    attempt += 1;
    current = postLoginSnapshot(options, marker);
    appendFileSync(paths.attempts, `${JSON.stringify({ armId: marker.id, attempt, ...current })}\n`, { mode: 0o600 });
    if (current.ok) break;
    // A login without reboot cannot satisfy a reboot-armed smoke. Fail quickly
    // rather than pretending a same-boot logout proved reboot persistence.
    if (!current.rebootObserved) break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  } while (Date.now() < deadline);

  const result = {
    ok: current?.ok === true,
    armId: marker.id,
    armedAt: marker.armedAt,
    completedAt: new Date().toISOString(),
    attempts: attempt,
    expectation: marker.expectation,
    preRebootBootSession: marker.preRebootBootSession,
    preRebootServices: marker.preRebootServices,
    dirtyWorkSnapshot: marker.dirtyWorkSnapshot,
    ...current,
  };
  const resultFile = path.join(paths.evidenceDir, `post-login-${marker.id}.json`);
  durableJson(resultFile, result);
  durableJson(paths.latestPostLogin, { ...result, evidenceFile: resultFile });
  const completion = path.join(paths.evidenceDir, `${result.ok ? 'completed' : 'failed'}-${marker.id}.json`);
  durableJson(completion, { ...marker, resultFile, resultOk: result.ok, completedAt: result.completedAt });
  rmSync(paths.arm, { force: true });
  // This plist belongs only to the smoke. Removing it prevents future logins
  // from running a no-op job; the currently loaded job can exit normally.
  rmSync(paths.plist, { force: true });
  syncFilesystem();
  console.log(`Always-On post-login reboot smoke ${result.ok ? 'PASSED' : 'FAILED'}: ${resultFile}`);
  process.exitCode = result.ok ? 0 : 1;
}

function rebootNow(options, paths) {
  if (!options.confirmReboot) throw new Error('reboot-now requires --confirm-reboot');
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('reboot-now is interactive-only; run it manually in a normal macOS Terminal after reviewing the evidence');
  }
  if (!existsSync(paths.arm) || !existsSync(paths.plist)) throw new Error('reboot smoke is not armed; run the arm action first');
  const marker = readJson(paths.arm);
  const gate = preflight(options, paths, 'immediate-pre-reboot');
  const evidence = {
    ok: true,
    checkedAt: new Date().toISOString(),
    armId: marker.id,
    preflight: gate.file,
    command: ['/usr/bin/sudo', '/sbin/shutdown', '-r', 'now'],
  };
  durableJson(path.join(paths.evidenceDir, 'immediate-pre-reboot.json'), evidence);
  appendCommand(paths, 'reboot-now', '/usr/bin/sudo /sbin/shutdown -r now');
  syncFilesystem();
  console.log(`Final gate passed. Evidence is synced under ${paths.evidenceDir}. Requesting reboot...`);
  const reboot = spawnSync('/usr/bin/sudo', ['/sbin/shutdown', '-r', 'now'], { stdio: 'inherit' });
  if (reboot.status !== 0 || reboot.error) throw new Error(commandFailure('/usr/bin/sudo', ['/sbin/shutdown', '-r', 'now'], reboot));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = pathsFor(options);
  ensureHost(options);
  ensureDir(paths.evidenceDir);
  if (options.action === 'preflight') {
    const result = preflight(options, paths);
    console.log(JSON.stringify({ ok: true, evidenceFile: result.file }, null, 2));
  } else if (options.action === 'arm') arm(options, paths);
  else if (options.action === 'status') status(paths);
  else if (options.action === 'disarm') disarm(paths);
  else if (options.action === 'post-login') await postLogin(options, paths);
  else if (options.action === 'reboot-now') rebootNow(options, paths);
}

main().catch((error) => {
  console.error(`[rorca-reboot-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
