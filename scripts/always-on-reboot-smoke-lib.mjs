import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const ACTIONS = new Set(['preflight', 'arm', 'status', 'disarm', 'post-login', 'reboot-now']);
const DEFAULT_TIMEOUT_SECONDS = 180;
const STATE_VERSION = 2;
const TERMINAL_PHASES = new Set(['completed', 'failed']);
const DISARMABLE_PHASES = new Set(['arming', 'armed', 'completed', 'failed']);

export function createProductionRuntime(scriptPath) {
  return {
    kind: 'production',
    scriptPath: path.resolve(scriptPath),
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    home: os.homedir(),
    execPath: process.execPath,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    now: () => new Date(),
    uuid: () => randomUUID(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    run: (command, args, options = {}) => spawnSync(command, args, {
      cwd: options.cwd,
      encoding: options.encoding === null ? null : 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: options.timeout,
      stdio: options.stdio,
    }),
    stdout: (message) => console.log(message),
  };
}

export function usageText() {
  return `Usage: node scripts/always-on-reboot-smoke.mjs <action> [options]

Actions:
  preflight   Run and durably record the fail-closed readiness/safety gate
  arm         Snapshot dirty work, pass the gate twice, and install an arm-ID-bound one-shot LaunchAgent
  status      Show durable state, lock metadata, and the latest result
  disarm      Arm-ID-guarded cleanup; REFUSES while rebooting or post-login
  post-login  Internal arm-ID-bound one-shot action invoked by launchd after login
  reboot-now  DESTRUCTIVE: transition to rebooting and request a real reboot

Options:
  --root <path>               Rorca checkout (default: this checkout)
  --workspace-id <id>        Capture workspace (default: rorca)
  --port <number>             Backend port (default: 3030)
  --timeout-seconds <number>  Post-login settle deadline (default: 180)
  --arm-id <id>               Required by disarm, post-login, and reboot-now
  --confirm-reboot            Separate explicit consent required by reboot-now

DANGER: reboot-now invokes /usr/bin/sudo /sbin/shutdown -r now on production
runtime. Arming is not reboot consent. Review status and evidence, then type the
arm-ID-bound reboot command yourself in an interactive macOS Terminal.

Evidence and durable state are preserved under .rorca/services/reboot-smoke/.
There is no ordinary force-disarm path for rebooting/post-login states.`;
}

export function parseArgs(argv, runtime) {
  if (argv[0] === '--help' || argv[0] === '-h') return { help: true };
  const options = {
    action: argv[0],
    root: path.resolve(path.dirname(runtime.scriptPath), '..'),
    workspaceId: 'rorca',
    port: 3030,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    confirmReboot: false,
    armId: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index] || '');
    else if (arg === '--workspace-id') options.workspaceId = argv[++index] || '';
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--timeout-seconds') options.timeoutSeconds = Number(argv[++index]);
    else if (arg === '--arm-id') options.armId = argv[++index] || '';
    else if (arg === '--confirm-reboot') options.confirmReboot = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!ACTIONS.has(options.action)) throw new Error(`Unknown action: ${options.action || '(none)'}`);
  if (!options.workspaceId) throw new Error('--workspace-id must not be empty');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('--port must be a valid TCP port');
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 30 || options.timeoutSeconds > 900) {
    throw new Error('--timeout-seconds must be an integer from 30 to 900');
  }
  if (options.armId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(options.armId)) {
    throw new Error('--arm-id has an invalid format');
  }
  if (['disarm', 'post-login', 'reboot-now'].includes(options.action) && !options.armId) {
    throw new Error(`${options.action} requires --arm-id from the exact armed operation`);
  }
  return options;
}

export function pathsFor(options, runtime) {
  const slug = path.basename(options.root).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'rorca';
  const label = `com.rorca.login-smoke.${slug}`;
  const evidenceDir = path.join(options.root, '.rorca', 'services', 'reboot-smoke');
  return {
    slug,
    label,
    target: `gui/${runtime.uid}/${label}`,
    evidenceDir,
    backupsDir: path.join(evidenceDir, 'backups'),
    state: path.join(evidenceDir, 'state.json'),
    transitions: path.join(evidenceDir, 'state-transitions.ndjson'),
    lockDir: path.join(evidenceDir, 'operation.lock'),
    lockOwner: path.join(evidenceDir, 'operation.lock', 'owner.json'),
    staleLocksDir: path.join(evidenceDir, 'stale-locks'),
    arm: path.join(evidenceDir, 'armed.json'),
    latestPreflight: path.join(evidenceDir, 'preflight-latest.json'),
    latestPostLogin: path.join(evidenceDir, 'post-login-latest.json'),
    attempts: path.join(evidenceDir, 'post-login-attempts.ndjson'),
    commands: path.join(evidenceDir, 'commands.log'),
    rebootCommand: path.join(evidenceDir, 'REBOOT-COMMAND.txt'),
    stdout: path.join(evidenceDir, 'post-login.launchd.stdout.log'),
    stderr: path.join(evidenceDir, 'post-login.launchd.stderr.log'),
    plist: path.join(runtime.home, 'Library', 'LaunchAgents', `${label}.plist`),
  };
}

function iso(runtime) {
  return runtime.now().toISOString();
}

function ensureDir(directory) {
  mkdirSync(directory, { recursive: true });
}

function syncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function durableWrite(file, content, mode = 0o600, runtime = { uuid: randomUUID }) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${runtime.uuid()}`;
  const fd = openSync(temporary, 'w', mode);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, mode);
  renameSync(temporary, file);
  syncDirectory(path.dirname(file));
}

function durableJson(file, value, mode, runtime) {
  durableWrite(file, `${JSON.stringify(value, null, 2)}\n`, mode ?? 0o600, runtime);
}

function durableAppend(file, content) {
  ensureDir(path.dirname(file));
  const fd = openSync(file, 'a', 0o600);
  try {
    appendFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(path.dirname(file));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function commandFailure(command, args, result) {
  const detail = result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
  return `${command} ${args.join(' ')} failed: ${String(detail).trim()}`;
}

function requireCommand(runtime, command, args, options = {}) {
  const result = runtime.run(command, args, options);
  if (result.status !== 0 || result.error) throw new Error(commandFailure(command, args, result));
  return result;
}

function appendCommand(paths, action, command, runtime) {
  durableAppend(paths.commands, `${iso(runtime)}\t${action}\t${command}\n`);
}

function ensureHost(options, runtime) {
  if (runtime.platform !== 'darwin') throw new Error('this reboot/login smoke helper is macOS-only');
  if (!existsSync(path.join(options.root, 'scripts', 'verify-always-on-login-readiness.mjs'))) {
    throw new Error(`readiness verifier is missing under ${options.root}`);
  }
  if (path.resolve(runtime.scriptPath) !== path.resolve(options.root, 'scripts', 'always-on-reboot-smoke.mjs')) {
    throw new Error('run the reboot-smoke script from the checkout selected by --root');
  }
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

function safePath(runtime) {
  return Array.from(new Set([
    path.dirname(runtime.execPath),
    path.join(runtime.home, '.pi', 'agent', 'bin'),
    path.join(runtime.home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ])).join(':');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function exactOperatorCommand(action, options, armId, extra = '') {
  const args = [
    'node',
    'scripts/always-on-reboot-smoke.mjs',
    action,
    '--root', shellQuote(options.root),
    '--workspace-id', shellQuote(options.workspaceId),
    '--port', String(options.port),
    '--timeout-seconds', String(options.timeoutSeconds),
    '--arm-id', shellQuote(armId),
  ];
  if (extra) args.push(extra);
  return args.join(' ');
}

export function renderPlist(options, paths, armId, runtime) {
  const args = [
    runtime.execPath,
    runtime.scriptPath,
    'post-login',
    '--root', options.root,
    '--workspace-id', options.workspaceId,
    '--port', String(options.port),
    '--timeout-seconds', String(options.timeoutSeconds),
    '--arm-id', armId,
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
    <string>${xml(runtime.home)}</string>
    <key>PATH</key>
    <string>${xml(safePath(runtime))}</string>
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

function parseJsonOutput(result, description) {
  if (result.status !== 0 && !result.stdout) throw new Error(`${description}: ${result.stderr || result.error?.message || `exit ${result.status}`}`);
  try {
    return JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw new Error(`${description} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function bootSession(runtime) {
  const result = requireCommand(runtime, '/usr/sbin/sysctl', ['-n', 'kern.boottime']);
  const raw = result.stdout.trim();
  const seconds = Number(raw.match(/sec\s*=\s*(\d+)/)?.[1]);
  if (!Number.isFinite(seconds)) throw new Error(`unable to parse kern.boottime: ${raw}`);
  return { raw, epochMs: seconds * 1000 };
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

function runVerifier(options, runtime) {
  const args = verifierCommand(options);
  const result = runtime.run(runtime.execPath, args, { cwd: options.root, timeout: 30_000 });
  const report = parseJsonOutput(result, 'login readiness verifier');
  return { command: [runtime.execPath, ...args], exitCode: result.status, report };
}

function executionProcesses(runtime) {
  const result = requireCommand(runtime, '/bin/ps', ['-axo', 'pid=,ppid=,command=']);
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

function launchdSnapshot(label, paths, runtime) {
  const result = runtime.run('/bin/launchctl', ['print', paths.target]);
  const output = result.stdout || '';
  return {
    label,
    target: paths.target,
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

function preflight(options, paths, runtime, phase = 'preflight') {
  const verifier = runVerifier(options, runtime);
  const engines = executionProcesses(runtime);
  const report = {
    ok: verifier.report.ok === true && engines.length === 0,
    phase,
    checkedAt: iso(runtime),
    root: options.root,
    workspaceId: options.workspaceId,
    port: options.port,
    bootSession: bootSession(runtime),
    verifier: verifier.report,
    executionProcesses: engines,
    services: serviceLabels(options).map((label) => launchdSnapshot(label, { ...paths, target: `gui/${runtime.uid}/${label}` }, runtime)),
    logs: logSnapshot(options),
    commands: {
      verifier: verifier.command,
      executionProcessAudit: ['/bin/ps', '-axo', 'pid=,ppid=,command='],
    },
  };
  const id = `${iso(runtime).replace(/[:.]/g, '-')}-${phase}-${runtime.uuid()}`;
  const file = path.join(paths.evidenceDir, `${id}.json`);
  durableJson(file, report, 0o600, runtime);
  durableJson(paths.latestPreflight, { ...report, evidenceFile: file }, 0o600, runtime);
  appendCommand(paths, phase, verifier.command.join(' '), runtime);
  if (!report.ok) {
    const failures = verifier.report.checks?.filter((check) => !check.ok).map((check) => `[${check.scope}] ${check.name}`) || [];
    if (engines.length > 0) failures.push(`execution processes: ${engines.map(({ pid }) => pid).join(', ')}`);
    throw new Error(`preflight failed closed: ${failures.join('; ') || 'readiness verifier was not ready'}`);
  }
  return { report, file };
}

function gitBuffer(root, args, runtime) {
  const result = runtime.run('/usr/bin/git', args, { cwd: root, encoding: null });
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

function snapshotDirtyWork(options, paths, id, runtime) {
  const snapshotDir = path.join(paths.backupsDir, id);
  ensureDir(snapshotDir);
  const statusBefore = gitBuffer(options.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], runtime);
  const tracked = nulList(gitBuffer(options.root, ['diff', '--name-only', '-z', 'HEAD', '--'], runtime));
  const untracked = nulList(gitBuffer(options.root, ['ls-files', '--others', '--exclude-standard', '-z'], runtime));
  const manifest = [];
  for (const relative of tracked) copySnapshotEntry(options.root, path.join(snapshotDir, 'tracked-working-tree'), relative, manifest, 'tracked');
  for (const relative of untracked) copySnapshotEntry(options.root, path.join(snapshotDir, 'untracked'), relative, manifest, 'untracked');
  durableWrite(path.join(snapshotDir, 'status-before.z'), statusBefore, 0o600, runtime);
  durableWrite(path.join(snapshotDir, 'index-stage.z'), gitBuffer(options.root, ['ls-files', '--stage', '-z'], runtime), 0o600, runtime);
  const head = gitBuffer(options.root, ['rev-parse', 'HEAD'], runtime).toString('utf8').trim();
  const statusAfter = gitBuffer(options.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], runtime);
  durableWrite(path.join(snapshotDir, 'status-after.z'), statusAfter, 0o600, runtime);
  const consistent = statusBefore.equals(statusAfter);
  const summary = {
    createdAt: iso(runtime),
    root: options.root,
    head,
    consistent,
    trackedEntryCount: tracked.length,
    untrackedEntryCount: untracked.length,
    restoreNote: 'Use the recorded HEAD/index-stage plus tracked-working-tree, untracked, and deleted manifest entries. Do not apply restoration destructively without a separate backup.',
    manifest,
  };
  durableJson(path.join(snapshotDir, 'manifest.json'), summary, 0o600, runtime);
  if (!consistent) throw new Error(`dirty work changed during snapshot; evidence was preserved at ${snapshotDir}, but arming was refused`);
  return { snapshotDir, head, trackedEntryCount: tracked.length, untrackedEntryCount: untracked.length };
}

export function readState(paths) {
  if (!existsSync(paths.state)) {
    return { version: STATE_VERSION, revision: 0, phase: 'idle', armId: null, updatedAt: null, history: [] };
  }
  const state = readJson(paths.state);
  if (state.version !== STATE_VERSION || !Number.isInteger(state.revision) || typeof state.phase !== 'string') {
    throw new Error(`invalid durable reboot-smoke state: ${paths.state}`);
  }
  return state;
}

function transition(paths, runtime, { from, to, armId, newArm = false, reason, detail }) {
  const current = readState(paths);
  const allowed = Array.isArray(from) ? from : [from];
  if (!allowed.includes(current.phase)) {
    throw new Error(`state transition refused: expected ${allowed.join('|')}, found ${current.phase}`);
  }
  if (!newArm && current.armId !== armId) {
    throw new Error(`state transition refused: arm ID ${armId} does not match durable arm ${current.armId || '(none)'}`);
  }
  if (newArm && (!armId || !(current.phase === 'idle' || TERMINAL_PHASES.has(current.phase)))) {
    throw new Error(`new arm transition refused from ${current.phase}`);
  }
  const at = iso(runtime);
  const event = {
    version: STATE_VERSION,
    revision: current.revision + 1,
    at,
    from: current.phase,
    to,
    armId,
    reason,
    ...(detail ? { detail } : {}),
  };
  const next = {
    version: STATE_VERSION,
    revision: event.revision,
    phase: to,
    armId,
    updatedAt: at,
    history: [...(Array.isArray(current.history) ? current.history : []), event],
  };
  durableJson(paths.state, next, 0o600, runtime);
  durableAppend(paths.transitions, `${JSON.stringify(event)}\n`);
  return next;
}

function lockDescription(paths) {
  if (!existsSync(paths.lockDir)) return null;
  if (!existsSync(paths.lockOwner)) return { valid: false, error: 'lock directory exists without an owner record' };
  try {
    return { valid: true, ...readJson(paths.lockOwner) };
  } catch (error) {
    return { valid: false, error: `invalid lock owner record: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function archivePriorBootLock(options, paths, runtime, expectedArmId, currentBoot) {
  const owner = lockDescription(paths);
  if (!owner?.valid) throw new Error(`operation lock is ambiguous and will not be overridden: ${paths.lockDir}`);
  const state = readState(paths);
  if (options.action !== 'post-login' || state.phase !== 'rebooting' || state.armId !== expectedArmId || owner.armId !== expectedArmId) {
    throw new Error(`operation lock held by ${owner.action || 'unknown'} for arm ${owner.armId || '(none)'}; refusing takeover`);
  }
  if (owner.bootSession?.epochMs === currentBoot.epochMs) {
    throw new Error(`same-boot operation lock held by ${owner.action || 'unknown'} (pid ${owner.pid || 'unknown'}); refusing silent stale-lock override`);
  }
  ensureDir(paths.staleLocksDir);
  const archive = path.join(paths.staleLocksDir, `${iso(runtime).replace(/[:.]/g, '-')}-${owner.token}`);
  try {
    renameSync(paths.lockDir, archive);
  } catch (error) {
    throw new Error(`prior-boot lock changed during takeover; retry refused: ${error instanceof Error ? error.message : String(error)}`);
  }
  syncDirectory(paths.evidenceDir);
  syncDirectory(paths.staleLocksDir);
  appendCommand(paths, 'post-login-lock-takeover', `archived prior-boot lock at ${archive}`, runtime);
}

function acquireLock(options, paths, runtime, armId) {
  ensureDir(paths.evidenceDir);
  const currentBoot = bootSession(runtime);
  const token = runtime.uuid();
  const owner = {
    version: 1,
    token,
    action: options.action,
    armId,
    pid: process.pid,
    acquiredAt: iso(runtime),
    bootSession: currentBoot,
  };
  try {
    mkdirSync(paths.lockDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (options.action !== 'post-login') {
      const existing = lockDescription(paths);
      throw new Error(`exclusive operation lock is held; refusing ${options.action}: ${JSON.stringify(existing)}`);
    }
    archivePriorBootLock(options, paths, runtime, armId, currentBoot);
    try {
      mkdirSync(paths.lockDir, { mode: 0o700 });
    } catch (retryError) {
      throw new Error(`could not acquire lock after prior-boot archive; refusing: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
    }
  }
  try {
    durableJson(paths.lockOwner, owner, 0o600, runtime);
  } catch (error) {
    // The ownerless directory is intentionally retained. Silently deleting an
    // ambiguous lock could override a process that acquired it concurrently.
    throw new Error(`lock owner record could not be made durable; ambiguous lock retained: ${error instanceof Error ? error.message : String(error)}`);
  }
  return owner;
}

function releaseLock(paths, owner) {
  const current = lockDescription(paths);
  if (!current?.valid || current.token !== owner.token) {
    throw new Error('operation lock ownership changed; refusing to delete another process lock');
  }
  rmSync(paths.lockDir, { recursive: true });
  syncDirectory(paths.evidenceDir);
}

async function withLock(options, paths, runtime, armId, operation) {
  const owner = acquireLock(options, paths, runtime, armId);
  let operationError;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      releaseLock(paths, owner);
    } catch (releaseError) {
      if (!operationError) throw releaseError;
      runtime.stdout(`[rorca-reboot-smoke] WARNING: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
    }
  }
}

function markerForArm(paths, armId) {
  if (!existsSync(paths.arm)) throw new Error(`arm marker is missing: ${paths.arm}`);
  const marker = readJson(paths.arm);
  if (marker.id !== armId) throw new Error(`arm marker belongs to ${marker.id || '(invalid)'}, not ${armId}`);
  return marker;
}

function validateMarkerOptions(marker, options) {
  if (marker.root !== options.root || marker.workspaceId !== options.workspaceId || marker.port !== options.port || marker.timeoutSeconds !== options.timeoutSeconds) {
    throw new Error('armed marker does not match the exact operation arguments');
  }
}

function assertPlistForArm(options, paths, armId, runtime) {
  if (!existsSync(paths.plist)) throw new Error(`arm-ID-bound plist is missing: ${paths.plist}`);
  const expected = renderPlist(options, paths, armId, runtime);
  const actual = readFileSync(paths.plist, 'utf8');
  if (actual !== expected) throw new Error(`plist content does not exactly match arm ${armId}; refusing`);
  return expected;
}

function assertBundle(options, paths, armId, runtime, expectedPhases) {
  const state = readState(paths);
  if (!expectedPhases.includes(state.phase) || state.armId !== armId) {
    throw new Error(`durable state is ${state.phase}/${state.armId || '(none)'}, not ${expectedPhases.join('|')}/${armId}`);
  }
  const marker = markerForArm(paths, armId);
  validateMarkerOptions(marker, options);
  assertPlistForArm(options, paths, armId, runtime);
  return { state, marker };
}

function removeMarkerForArm(paths, armId) {
  if (!existsSync(paths.arm)) return false;
  markerForArm(paths, armId);
  rmSync(paths.arm);
  syncDirectory(path.dirname(paths.arm));
  return true;
}

function removePlistForArm(options, paths, armId, runtime) {
  if (!existsSync(paths.plist)) return false;
  assertPlistForArm(options, paths, armId, runtime);
  rmSync(paths.plist);
  syncDirectory(path.dirname(paths.plist));
  return true;
}

function installOneShot(options, paths, armId, runtime) {
  ensureDir(paths.evidenceDir);
  ensureDir(path.dirname(paths.plist));
  if (existsSync(paths.plist)) throw new Error(`refusing to replace existing plist: ${paths.plist}`);
  const rendered = renderPlist(options, paths, armId, runtime);
  durableWrite(paths.plist, rendered, 0o644, runtime);
  const lint = runtime.run('/usr/bin/plutil', ['-lint', paths.plist]);
  if (lint.status !== 0 || lint.error) {
    removePlistForArm(options, paths, armId, runtime);
    throw new Error(commandFailure('/usr/bin/plutil', ['-lint', paths.plist], lint));
  }
}

function syncFilesystem(runtime) {
  requireCommand(runtime, '/bin/sync', []);
}

async function arm(options, paths, runtime, armId) {
  return withLock(options, paths, runtime, armId, async () => {
    const current = readState(paths);
    if (!(current.phase === 'idle' || TERMINAL_PHASES.has(current.phase))) {
      throw new Error(`cannot arm while durable state is ${current.phase} for ${current.armId || '(none)'}`);
    }
    if (existsSync(paths.arm) || existsSync(paths.plist)) {
      throw new Error('prior marker/plist remains; inspect status and disarm its exact arm ID before arming');
    }
    const oneShot = launchdSnapshot(paths.label, paths, runtime);
    if (oneShot.loaded) throw new Error(`one-shot job is already loaded (${paths.target}); refusing to replace it`);
    transition(paths, runtime, { from: current.phase, to: 'arming', armId, newArm: true, reason: 'arm-started' });
    try {
      const initial = preflight(options, paths, runtime, 'arm-initial');
      const snapshot = snapshotDirtyWork(options, paths, armId, runtime);
      const final = preflight(options, paths, runtime, 'arm-final');
      const marker = {
        version: STATE_VERSION,
        id: armId,
        armedAt: iso(runtime),
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
      durableJson(paths.arm, marker, 0o600, runtime);
      installOneShot(options, paths, armId, runtime);
      const command = exactOperatorCommand('reboot-now', options, armId, '--confirm-reboot');
      durableWrite(paths.rebootCommand, `${command}\n`, 0o600, runtime);
      appendCommand(paths, 'arm', command, runtime);
      syncFilesystem(runtime);
      transition(paths, runtime, { from: 'arming', to: 'armed', armId, reason: 'arm-bundle-durable' });
      syncFilesystem(runtime);
      const output = {
        ok: true,
        phase: 'armed',
        armId,
        marker: paths.arm,
        oneShotPlist: paths.plist,
        evidenceDir: paths.evidenceDir,
        dirtyWorkSnapshot: snapshot.snapshotDir,
        humanRebootCommand: command,
        humanDisarmCommand: exactOperatorCommand('disarm', options, armId),
      };
      runtime.stdout(JSON.stringify(output, null, 2));
      return output;
    } catch (error) {
      const failedState = readState(paths);
      if (failedState.armId === armId && ['arming', 'armed'].includes(failedState.phase)) {
        transition(paths, runtime, { from: failedState.phase, to: 'failed', armId, reason: 'arm-failed', detail: String(error?.message || error) });
      }
      removePlistForArm(options, paths, armId, runtime);
      removeMarkerForArm(paths, armId);
      throw error;
    }
  });
}

async function disarm(options, paths, runtime) {
  return withLock(options, paths, runtime, options.armId, async () => {
    const state = readState(paths);
    if (state.armId !== options.armId) {
      throw new Error(`disarm arm ID ${options.armId} does not match durable arm ${state.armId || '(none)'}`);
    }
    if (state.phase === 'rebooting' || state.phase === 'post-login') {
      throw new Error(`disarm is forbidden while state is ${state.phase}; there is no force flag. Preserve evidence and allow exact-arm post-login recovery`);
    }
    if (!DISARMABLE_PHASES.has(state.phase)) throw new Error(`disarm is not valid from ${state.phase}`);
    if (existsSync(paths.arm)) {
      const marker = markerForArm(paths, options.armId);
      validateMarkerOptions(marker, options);
    }
    if (existsSync(paths.plist)) assertPlistForArm(options, paths, options.armId, runtime);
    const loaded = launchdSnapshot(paths.label, paths, runtime);
    if (loaded.loaded) requireCommand(runtime, '/bin/launchctl', ['bootout', paths.target]);
    removePlistForArm(options, paths, options.armId, runtime);
    removeMarkerForArm(paths, options.armId);
    let finalPhase = state.phase;
    if (state.phase === 'arming' || state.phase === 'armed') {
      transition(paths, runtime, { from: state.phase, to: 'failed', armId: options.armId, reason: 'operator-disarmed' });
      finalPhase = 'failed';
    }
    appendCommand(paths, 'disarm', `arm ${options.armId}: launchctl bootout if loaded; compare-and-remove marker/plist`, runtime);
    syncFilesystem(runtime);
    const output = { ok: true, phase: finalPhase, armId: options.armId, evidencePreservedAt: paths.evidenceDir };
    runtime.stdout(JSON.stringify(output, null, 2));
    return output;
  });
}

function status(paths, runtime) {
  const state = readState(paths);
  const marker = existsSync(paths.arm) ? readJson(paths.arm) : null;
  const latest = existsSync(paths.latestPostLogin) ? readJson(paths.latestPostLogin) : null;
  const output = {
    ok: true,
    state,
    armed: state.phase === 'armed',
    marker,
    operationLock: lockDescription(paths),
    oneShotPlist: { file: paths.plist, installed: existsSync(paths.plist), ...launchdSnapshot(paths.label, paths, runtime) },
    latestPostLogin: latest,
    evidenceDir: paths.evidenceDir,
  };
  runtime.stdout(JSON.stringify(output, null, 2));
  return output;
}

function postLoginSnapshot(options, armMarker, paths, runtime) {
  const verifier = runVerifier(options, runtime);
  const boot = bootSession(runtime);
  const services = serviceLabels(options).map((label) => launchdSnapshot(label, { ...paths, target: `gui/${runtime.uid}/${label}` }, runtime));
  const logs = logSnapshot(options);
  const rebootObserved = boot.epochMs !== armMarker.preRebootBootSession.epochMs;
  const servicesRunning = services.every((service) => service.loaded && service.state === 'running' && Number.isInteger(service.pid));
  const logsFresh = ['backendStdout', 'workerStdout', 'capture']
    .every((name) => logs[name].exists && Number(logs[name].mtimeMs) >= boot.epochMs - 1000);
  return {
    checkedAt: iso(runtime),
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

async function postLogin(options, paths, runtime) {
  return withLock(options, paths, runtime, options.armId, async () => {
    const { marker } = assertBundle(options, paths, options.armId, runtime, ['rebooting']);
    transition(paths, runtime, { from: 'rebooting', to: 'post-login', armId: options.armId, reason: 'exact-arm-post-login-started' });
    appendCommand(paths, 'post-login', `${runtime.execPath} ${runtime.scriptPath} post-login --arm-id ${options.armId}`, runtime);
    try {
      const deadline = runtime.now().getTime() + marker.timeoutSeconds * 1000;
      let attempt = 0;
      let current;
      do {
        attempt += 1;
        current = postLoginSnapshot(options, marker, paths, runtime);
        durableAppend(paths.attempts, `${JSON.stringify({ armId: marker.id, attempt, ...current })}\n`);
        if (current.ok || !current.rebootObserved) break;
        await runtime.sleep(5_000);
      } while (runtime.now().getTime() < deadline);

      const result = {
        ok: current?.ok === true,
        armId: marker.id,
        armedAt: marker.armedAt,
        completedAt: iso(runtime),
        attempts: attempt,
        expectation: marker.expectation,
        preRebootBootSession: marker.preRebootBootSession,
        preRebootServices: marker.preRebootServices,
        dirtyWorkSnapshot: marker.dirtyWorkSnapshot,
        ...current,
      };
      const resultFile = path.join(paths.evidenceDir, `post-login-${marker.id}.json`);
      durableJson(resultFile, result, 0o600, runtime);
      durableJson(paths.latestPostLogin, { ...result, evidenceFile: resultFile }, 0o600, runtime);
      const finalPhase = result.ok ? 'completed' : 'failed';
      const completion = path.join(paths.evidenceDir, `${finalPhase}-${marker.id}.json`);
      durableJson(completion, { ...marker, resultFile, resultOk: result.ok, completedAt: result.completedAt }, 0o600, runtime);
      transition(paths, runtime, { from: 'post-login', to: finalPhase, armId: marker.id, reason: result.ok ? 'post-login-passed' : 'post-login-failed' });
      removeMarkerForArm(paths, marker.id);
      removePlistForArm(options, paths, marker.id, runtime);
      syncFilesystem(runtime);
      runtime.stdout(`Always-On post-login reboot smoke ${result.ok ? 'PASSED' : 'FAILED'}: ${resultFile}`);
      return { ...result, exitCode: result.ok ? 0 : 1, resultFile };
    } catch (error) {
      const current = readState(paths);
      if (current.phase === 'post-login' && current.armId === options.armId) {
        transition(paths, runtime, { from: 'post-login', to: 'failed', armId: options.armId, reason: 'post-login-error', detail: String(error?.message || error) });
      }
      throw error;
    }
  });
}

async function rebootNow(options, paths, runtime) {
  if (!options.confirmReboot) throw new Error('reboot-now requires separate explicit --confirm-reboot consent');
  if (!runtime.stdinIsTTY || !runtime.stdoutIsTTY) {
    throw new Error('reboot-now is interactive-only; run the exact arm-ID-bound command manually in a normal macOS Terminal');
  }
  return withLock(options, paths, runtime, options.armId, async () => {
    assertBundle(options, paths, options.armId, runtime, ['armed']);
    const gate = preflight(options, paths, runtime, 'immediate-pre-reboot');
    // Re-read every durable/artifact component after the potentially long gate.
    assertBundle(options, paths, options.armId, runtime, ['armed']);
    transition(paths, runtime, { from: 'armed', to: 'rebooting', armId: options.armId, reason: 'shutdown-request-about-to-run' });
    const evidence = {
      ok: true,
      checkedAt: iso(runtime),
      armId: options.armId,
      durablePhase: 'rebooting',
      preflight: gate.file,
      command: ['/usr/bin/sudo', '/sbin/shutdown', '-r', 'now'],
    };
    durableJson(path.join(paths.evidenceDir, `immediate-pre-reboot-${options.armId}.json`), evidence, 0o600, runtime);
    durableJson(path.join(paths.evidenceDir, 'immediate-pre-reboot.json'), evidence, 0o600, runtime);
    appendCommand(paths, 'reboot-now', `${options.armId}\t/usr/bin/sudo /sbin/shutdown -r now`, runtime);
    syncFilesystem(runtime);
    runtime.stdout(`DESTRUCTIVE REBOOT CONSENT ACCEPTED for arm ${options.armId}. Durable state is rebooting; requesting reboot...`);
    const reboot = runtime.run('/usr/bin/sudo', ['/sbin/shutdown', '-r', 'now'], { stdio: 'inherit' });
    if (reboot.status !== 0 || reboot.error) {
      transition(paths, runtime, { from: 'rebooting', to: 'failed', armId: options.armId, reason: 'shutdown-command-failed', detail: commandFailure('/usr/bin/sudo', ['/sbin/shutdown', '-r', 'now'], reboot) });
      throw new Error(commandFailure('/usr/bin/sudo', ['/sbin/shutdown', '-r', 'now'], reboot));
    }
    return { ok: true, phase: 'rebooting', armId: options.armId };
  });
}

export async function execute(argv, runtime) {
  if (!runtime || typeof runtime.run !== 'function') throw new Error('an explicit runtime is required');
  const options = parseArgs(argv, runtime);
  if (options.help) {
    runtime.stdout(usageText());
    return { ok: true, exitCode: 0 };
  }
  const paths = pathsFor(options, runtime);
  ensureHost(options, runtime);
  ensureDir(paths.evidenceDir);

  if (options.action === 'status') return status(paths, runtime);
  if (options.action === 'arm') {
    const armId = `${iso(runtime).replace(/[:.]/g, '-')}-${runtime.uuid()}`;
    return arm(options, paths, runtime, armId);
  }
  if (options.action === 'post-login') return postLogin(options, paths, runtime);
  if (options.action === 'disarm') return disarm(options, paths, runtime);
  if (options.action === 'reboot-now') return rebootNow(options, paths, runtime);
  if (options.action === 'preflight') {
    return withLock(options, paths, runtime, null, async () => {
      const result = preflight(options, paths, runtime);
      const output = { ok: true, evidenceFile: result.file };
      runtime.stdout(JSON.stringify(output, null, 2));
      return output;
    });
  }
  throw new Error(`internal action dispatch error for ${options.action}`);
}
