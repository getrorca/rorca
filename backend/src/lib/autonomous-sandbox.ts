/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Capability boundary for every autonomous/model-controlled subprocess: Linux bwrap or worker-issued Darwin Seatbelt. */

import * as crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTONOMOUS_GIT_VIEW_ENV,
  assertNoSharedGitHardlinkAliases,
  assertReachableLocalGitObjectDirectoriesUnchanged,
  createAutonomousGitViewFromEnv,
} from './autonomous-git-state';
import {
  AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV,
  AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV,
  AUTONOMOUS_EGRESS_OPERATION_ID_ENV,
  AUTONOMOUS_EGRESS_RUN_ID_ENV,
  assertAutonomousModelEgressBinding,
  assertAutonomousModelEgressRunBinding,
  closeAutonomousModelEgress,
  createAutonomousModelEgressOperationIdentity,
  ensureAutonomousModelEgress,
  type AutonomousModelEgressOperationIdentity,
} from './autonomous-model-egress';
import {
  ORDINARY_LOCAL_PI_PROFILE_ENV,
  assertOrdinaryLocalPiRuntimeProfile,
  type OrdinaryLocalPiRuntimeProfile,
} from './ordinary-local-pi-profile';
import { copyPiModelState } from './pi-model-state';
import { copyOmpModelState } from './omp-model-state';

export type AutonomousIsolationPosture = 'linux-bwrap' | 'local-dev';

export interface AutonomousSandboxLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  isolated: boolean;
}

export interface AutonomousSandboxOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Explicit model process: permits model keys only with the confined broker. */
  modelCredentials?: boolean;
  /** Exact host-owned identity for a non-pipeline model operation. */
  modelEgressIdentity?: AutonomousModelEgressOperationIdentity;
}

export interface AutonomousModelSandboxLaunch extends AutonomousSandboxLaunch {
  readonly modelEgressIdentity: AutonomousModelEgressOperationIdentity;
  readonly modelEgressSocket: string;
  /** Idempotently closes only this operation's broker. */
  closeModelEgress(): Promise<void>;
}

export interface AutonomousBoundaryPreflightOptions {
  cwd: string;
  providerCapable: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runProbe?: boolean;
}

const SAFE_PRODUCTION_ENV_KEYS = new Set([
  'PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM',
  'NO_COLOR', 'FORCE_COLOR', 'CI', 'TZ', 'DEVELOPER_DIR',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1',
  'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'GCM_INTERACTIVE', 'GH_CONFIG_DIR',
  'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY',
  // Non-secret app build flags (e.g. ALLOW_DUMMY_AUTH_ENV for CI builds).
  'ALLOW_DUMMY_AUTH_ENV',
  'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_DEFAULT_PLUGINS',
  'RORCA_AUTONOMOUS_COMMAND_GUARD', 'RORCA_AUTONOMOUS_WORKSPACE_ROOT',
  'RORCA_EVENT', 'RORCA_HOOK_TYPE', 'RORCA_RUN_ID', 'RORCA_STORY_ID',
  // Managed-executor launch evidence metadata (non-secret request identity)
  'RORCA_PROCESS_ROLE', 'RORCA_WORKSPACE_ID',
  'RORCA_MANAGED_REQUEST_HASH', 'RORCA_MANAGED_ATTEMPT_ID', 'RORCA_MANAGED_GENERATION',
  'RORCA_MANAGED_LEASE_ID', 'RORCA_MANAGED_FENCING_TOKEN',
  'RORCA_ALLOW_BACKEND_JEST', 'RORCA_AUTONOMOUS_BACKEND_JEST_DATABASE_URL',
  'RORCA_AUTONOMOUS_BACKEND_JEST_PGHOST', 'RORCA_AUTONOMOUS_BACKEND_JEST_PGPORT',
  'RORCA_AUTONOMOUS_BACKEND_JEST_PGUSER', 'RORCA_AUTONOMOUS_BACKEND_JEST_PGPASSWORD',
  'RORCA_AUTONOMOUS_BACKEND_JEST_PGDATABASE',
  // Invocation-owned test-database lane: the engine provisions one nonce-owned
  // PostgreSQL cluster per run and Jest inside the sandbox re-resolves the
  // exact lease through these variables (state + owner identity + TMPDIR for
  // the identical realpath). The URL is also what the command guard auto-routes
  // backend Jest commands to.
  'TMPDIR', 'RORCA_JEST_INVOCATION_ID', 'RORCA_JEST_STATE_FILE',
  'RORCA_JEST_OWNER_PID', 'RORCA_TEST_DATABASE_URL',
]);

const MODEL_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY',
]);
const DEFAULT_TOOL_ROOTS = ['/usr', '/bin', '/lib', '/lib64'];
const SANDBOX_EGRESS_SOCKET = '/run/rorca-egress/proxy.sock';
const LINUX_SANDBOX_PROXY_URL = 'http://127.0.0.1:3128';
const DARWIN_RELAY_PORT_TOKEN = '__RORCA_DARWIN_RELAY_PORT__';
const ORDINARY_LOCAL_PI_RUNTIME_PREFIX = 'rorca-ordinary-local-pi-runtime-';
const activeOrdinaryLocalPiRuntimeRoots = new Set<string>();
let ordinaryLocalPiExitCleanupRegistered = false;

// Linux has a private network namespace per bwrap launch, so its fixed inner
// port cannot collide across runs. Darwin has no network namespace: its trusted
// host wrapper binds port 0 atomically and freezes the resulting per-launch
// endpoint into the exact Seatbelt policy before starting model-controlled code.
const EGRESS_RELAY_SCRIPT = String.raw`
const net=require('net'),cp=require('child_process');
const socket=process.argv[1],command=process.argv[2],args=JSON.parse(process.argv[3]);
const relay=net.createServer(client=>{const upstream=net.connect({path:socket});client.pipe(upstream);upstream.pipe(client);upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy())});
relay.listen(3128,'127.0.0.1',()=>{const child=cp.spawn(command,args,{stdio:'inherit',env:process.env});for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));child.on('error',()=>process.exit(127));child.on('exit',(code,signal)=>{relay.close();if(signal)process.kill(process.pid,signal);else process.exit(code??1)})});`;
const DARWIN_EGRESS_RELAY_SUPERVISOR = String.raw`
const net=require('net'),cp=require('child_process');
const socket=process.argv[1],profileTemplate=process.argv[2],portToken=process.argv[3],command=process.argv[4],args=JSON.parse(process.argv[5]);
let child;
const relay=net.createServer(client=>{const upstream=net.connect({path:socket});client.pipe(upstream);upstream.pipe(client);upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy())});
const close=(code,signal)=>{try{relay.close()}catch{}if(signal)process.kill(process.pid,signal);else process.exit(code??1)};
for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child?child.kill(signal):close(1,signal));
relay.on('error',()=>process.exit(126));
relay.listen(0,'127.0.0.1',()=>{const address=relay.address();if(!address||typeof address==='string'||!Number.isSafeInteger(address.port))process.exit(126);const port=String(address.port);const profile=profileTemplate.split(portToken).join(port);if(profile.includes(portToken))process.exit(126);const proxy='http://127.0.0.1:'+port;const env={...process.env,HTTP_PROXY:proxy,HTTPS_PROXY:proxy,ALL_PROXY:proxy,NO_PROXY:'127.0.0.1,localhost'};delete env.RORCA_AUTONOMOUS_EGRESS_SOCKET;child=cp.spawn('/usr/bin/sandbox-exec',['-p',profile,command,...args],{stdio:'inherit',env});child.on('error',()=>close(127));child.on('exit',(code,signal)=>close(code,signal))});`;
const BOUNDARY_PROBE_SUPERVISOR = String.raw`
const cp=require('child_process');
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk});
process.stdin.on('end',()=>{let launch;try{launch=JSON.parse(input)}catch{process.exit(126)}const child=cp.spawnSync(launch.command,launch.args,{cwd:launch.cwd,env:launch.env,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:15000});if(child.error)process.exit(125);if(child.signal)process.exit(124);if(child.status!==0&&child.stderr)process.stderr.write(String(child.stderr).slice(-4096));process.exit(child.status??123)});`;
const FORBIDDEN_TOOL_ROOTS = ['/', '/root', '/home', '/etc', '/proc', '/sys', '/dev', '/run', '/var/run'];
const MERGED_USR_ALIASES = new Map<string, string>([
  ['/bin', 'usr/bin'], ['/sbin', 'usr/sbin'], ['/lib', 'usr/lib'],
  ['/lib64', 'usr/lib64'], ['/lib32', 'usr/lib32'], ['/libx32', 'usr/libx32'],
]);
let successfulProbeKey: string | null = null;

function configuredPosture(env: NodeJS.ProcessEnv = process.env): AutonomousIsolationPosture {
  const value = String(env.RORCA_AUTONOMOUS_ISOLATION ?? '').trim();
  if (value === 'linux-bwrap' || value === 'local-dev') return value;
  throw new Error('RORCA_AUTONOMOUS_ISOLATION must explicitly be linux-bwrap or local-dev; raw autonomous execution is forbidden');
}

function linuxSandboxLauncherBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.RORCA_BWRAP_BIN ?? '/usr/local/bin/rorca-sandbox-launcher').trim();
  if (!path.isAbsolute(configured)) throw new Error('RORCA_BWRAP_BIN must name an absolute trusted sandbox launcher');
  return configured;
}

function realExisting(value: string): string | null {
  try { return fs.realpathSync(value); } catch { return null; }
}

function assertSafeToolRoot(root: string): string {
  const real = realExisting(root);
  if (!real || !path.isAbsolute(real)) throw new Error(`Autonomous tool root is unavailable: ${root}`);
  if (FORBIDDEN_TOOL_ROOTS.includes(real)) throw new Error(`Autonomous tool root is over-broad: ${real}`);
  const stat = fs.statSync(real);
  if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || stat.uid !== 0) {
    throw new Error(`Autonomous tool root must be root-owned and not group/world writable: ${real}`);
  }
  return real;
}

function toolRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = String(env.RORCA_AUTONOMOUS_TOOL_ROOTS ?? '').trim();
  const roots = configured
    ? configured.split(':').filter(Boolean)
    : DEFAULT_TOOL_ROOTS.filter(root => realExisting(root) !== null);
  return [...new Set(roots.map(assertSafeToolRoot))];
}

function within(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveExecutable(command: string, env: Record<string, string>, roots: readonly string[]): string {
  const candidates = path.isAbsolute(command)
    ? [command]
    : String(env.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    const real = realExisting(candidate);
    if (!real || !roots.some(root => within(real, root))) continue;
    try {
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch { /* continue */ }
  }
  throw new Error(`Autonomous executable is unavailable outside approved tool roots: ${command}`);
}

function safeProductionEnv(
  input: Record<string, string>,
  modelCredentials = false,
  configureLinuxProxy = modelCredentials,
  cwd?: string,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if ((SAFE_PRODUCTION_ENV_KEYS.has(key)
      // Vite-style app env (VITE_*) is public-by-convention: it is bundled
      // into the client build, so passing it into the sandboxed agent and
      // validation gates leaks nothing and fixes build gates that require
      // e.g. VITE_API_URL.
      || key.startsWith('VITE_')
      || (modelCredentials && MODEL_ENV_KEYS.has(key))) && value !== undefined) {
      selected[key] = value;
    }
  }
  selected.PATH = '/usr/local/bin:/usr/bin:/bin';
  selected.HOME = '/home/rorca-agent';
  selected.TMPDIR = '/tmp';
  selected.XDG_CONFIG_HOME = '/home/rorca-agent/.config';
  selected.XDG_CACHE_HOME = '/home/rorca-agent/.cache';
  selected.GIT_CONFIG_NOSYSTEM = '1';
  selected.GIT_CONFIG_GLOBAL = '/dev/null';
  selected.GIT_TERMINAL_PROMPT = '0';
  selected.GIT_ASKPASS = '/bin/false';
  selected.GIT_SSH_COMMAND = '/bin/false';
  selected.GCM_INTERACTIVE = 'Never';
  selected.GH_CONFIG_DIR = '/home/rorca-agent/.config/gh';
  if (configureLinuxProxy && input.RORCA_AUTONOMOUS_EGRESS_SOCKET) {
    selected.HTTP_PROXY = LINUX_SANDBOX_PROXY_URL;
    selected.HTTPS_PROXY = LINUX_SANDBOX_PROXY_URL;
    selected.ALL_PROXY = LINUX_SANDBOX_PROXY_URL;
    selected.NO_PROXY = '';
    selected.RORCA_AUTONOMOUS_EGRESS_SOCKET = SANDBOX_EGRESS_SOCKET;
  }
  if (cwd) {
    const gitView = createAutonomousGitViewFromEnv(cwd, input);
    if (gitView) {
      selected.GIT_DIR = gitView.gitDir;
      selected.GIT_WORK_TREE = gitView.worktreePath;
      selected[AUTONOMOUS_GIT_VIEW_ENV] = gitView.gitDir;
    }
  }
  return selected;
}

/**
 * The Darwin ordinary-local profile is intentionally not a generic raw-host
 * fallback. It is issued only by the worker after the exact ordinary-branch
 * or bounded-TaskManifest checks and keeps the same credential stripping and
 * command-guard environment as the Linux launch, then executes inside a scoped
 * Seatbelt policy. Its operator-selected Pi runtime and the minimum Pi
 * model-auth files are copied into a worker-owned private run root outside the
 * reusable/model-writable worktree; GitHub/SSH/provider-control credentials and
 * shared caches/configuration remain absent.
 */
function ordinaryLocalGuardDirs(input: Record<string, string>): string[] {
  // macOS exposes both /var and /private/var spellings. Compare canonical
  // paths, otherwise the host-created guard directory is omitted from the
  // Seatbelt allowlist and every guarded package-manager command fails EPERM.
  const temporaryRoot = realExisting(os.tmpdir()) ?? path.resolve(os.tmpdir());
  const guardPrefix = `${temporaryRoot}${path.sep}rorca-autonomous-guard-`;
  return String(input.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => realExisting(entry))
    .filter((entry): entry is string => entry !== null && entry.startsWith(guardPrefix));
}

function realTemporaryRoot(): string {
  return fs.realpathSync(os.tmpdir());
}

function assertOrdinaryLocalPiRuntimeRoot(runtimeRoot: string, requirePrivateMode = true): string {
  if (!path.isAbsolute(runtimeRoot)) throw new Error('Darwin Pi runtime root must be absolute');
  const temporaryRoot = realTemporaryRoot();
  const resolved = path.resolve(runtimeRoot);
  if (path.dirname(resolved) !== temporaryRoot
    || !path.basename(resolved).startsWith(ORDINARY_LOCAL_PI_RUNTIME_PREFIX)) {
    throw new Error('Darwin Pi runtime root is outside the trusted temporary namespace');
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Darwin Pi runtime root must be a non-symbolic directory');
  }
  if (requirePrivateMode && (stat.mode & 0o077) !== 0) {
    throw new Error('Darwin Pi runtime root must remain private');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Darwin Pi runtime root has an unexpected owner');
  }
  const real = fs.realpathSync(resolved);
  if (real !== resolved) throw new Error('Darwin Pi runtime root changed identity');
  return real;
}

function ensurePrivateRuntimeDirectory(runtimeRoot: string, directory: string): string {
  const relative = path.relative(runtimeRoot, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Darwin Pi runtime directory escaped its worker-owned root');
  }
  let current = runtimeRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Darwin Pi runtime directory contains a symbolic or non-directory component');
      }
    } else {
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  const real = fs.realpathSync(current);
  if (!within(real, runtimeRoot)) throw new Error('Darwin Pi runtime directory escaped its worker-owned root');
  return real;
}

/** Allocate state before engine spawn so its cleanup identity is worker-owned. */
export function createOrdinaryLocalPiRuntimeState(runId: number): string {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Darwin Pi runtime requires a valid run id');
  const runtimeRoot = fs.mkdtempSync(path.join(realTemporaryRoot(), `${ORDINARY_LOCAL_PI_RUNTIME_PREFIX}${runId}-`));
  fs.chmodSync(runtimeRoot, 0o700);
  const real = assertOrdinaryLocalPiRuntimeRoot(runtimeRoot);
  activeOrdinaryLocalPiRuntimeRoots.add(real);
  if (!ordinaryLocalPiExitCleanupRegistered) {
    ordinaryLocalPiExitCleanupRegistered = true;
    process.once('exit', () => {
      for (const root of [...activeOrdinaryLocalPiRuntimeRoots]) {
        try { removeOrdinaryLocalPiRuntimeState(root); } catch { /* process exit is best-effort */ }
      }
    });
  }
  return real;
}

function realGitBinDirectory(env: Record<string, string>): string | null {
  const candidates = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of candidates) {
    const candidate = path.join(dir, 'git');
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      return path.dirname(fs.realpathSync(candidate));
    } catch {
      // Keep scanning for the first real git executable on the worker PATH.
    }
  }
  return null;
}

function safeOrdinaryLocalPiEnv(
  input: Record<string, string>,
  profile: OrdinaryLocalPiRuntimeProfile,
  cwd: string,
  modelCredentials: boolean,
): Record<string, string> {
  const selected = safeProductionEnv(input, modelCredentials, false, cwd);
  const hostHome = input.HOME && path.isAbsolute(input.HOME) ? input.HOME : os.homedir();
  const worktree = fs.realpathSync(cwd);
  if (worktree !== fs.realpathSync(profile.worktreePath)) {
    throw new Error('Darwin Pi runtime worktree changed identity');
  }
  const runtimeRoot = assertOrdinaryLocalPiRuntimeRoot(profile.runtimeRoot);
  const home = ensurePrivateRuntimeDirectory(runtimeRoot, path.join(runtimeRoot, 'home'));
  const agentDir = ensurePrivateRuntimeDirectory(runtimeRoot, path.join(runtimeRoot, 'agent'));
  const tmpdir = ensurePrivateRuntimeDirectory(runtimeRoot, path.join(runtimeRoot, 'tmp'));
  const cacheDir = ensurePrivateRuntimeDirectory(runtimeRoot, path.join(runtimeRoot, 'cache'));
  copyPiModelState(path.join(hostHome, '.pi', 'agent'), agentDir);
  // omp resolves its agent/profile state from the coding-agent dir and
  // XDG_CONFIG_HOME, which point at the private runtime root — seed them with
  // the host omp configuration, model catalog, and profile auth so the
  // sandboxed omp lane authenticates exactly like the host.
  copyOmpModelState(hostHome, agentDir, runtimeRoot);
  const guardDirs = ordinaryLocalGuardDirs(input);
  // PI_BIN can be Pi's JavaScript entrypoint rather than a native launcher.
  // In that case its directory does not contain `node`, so `/usr/local/bin`
  // previously won PATH resolution and could select a Rosetta/x64 Node against
  // arm64 dependencies. Always put the trusted worker Node runtime first.
  const nodeRuntimeBin = path.dirname(fs.realpathSync(process.execPath));
  selected.HOME = home;
  selected.TMPDIR = tmpdir;
  selected.XDG_CONFIG_HOME = path.join(runtimeRoot, 'config');
  // macOS /usr/bin/git (and other CLT shims) unconditionally open an xcrun
  // tool cache in the host per-user temp, which the Seatbelt profile denies.
  // The CommandLineTools tree ships the real binaries; resolving them first
  // keeps every git/python3/clang invocation shim-free.
  const commandLineToolsBin = '/Library/Developer/CommandLineTools/usr/bin';
  selected.PATH = [...new Set([
    ...guardDirs,
    nodeRuntimeBin,
    path.dirname(profile.piBinPath),
    ...(fs.existsSync(commandLineToolsBin) ? [commandLineToolsBin] : []),
    // Prefer the worker's real git over the /usr/bin xcrun shim. The shim
    // writes its tool cache to Darwin's global per-user temp, which is outside
    // the Seatbelt profile and fails every git command with EPERM. Homebrew is
    // admitted read-only by the profile below.
    ...(realGitBinDirectory(input) ? [realGitBinDirectory(input)!] : []),
    '/opt/homebrew/bin',
    '/usr/local/bin', '/usr/bin', '/bin',
  ])].join(path.delimiter);
  if (fs.existsSync(commandLineToolsBin)) selected.DEVELOPER_DIR = path.dirname(path.dirname(commandLineToolsBin));
  selected.XDG_CACHE_HOME = cacheDir;
  selected.npm_config_cache = path.join(cacheDir, 'npm');
  selected.GH_CONFIG_DIR = path.join(runtimeRoot, 'config', 'gh');
  selected.PI_CODING_AGENT_DIR = agentDir;
  selected.PI_CODING_AGENT_SESSION_DIR = path.join(runtimeRoot, 'sessions');
  if (modelCredentials) {
    // OMP inherits Pi's environment contract. PI_OFFLINE prevents its
    // OpenAI/Codex WebSocket from ever opening, even through the broker.
    delete selected.PI_OFFLINE;
  } else {
    selected.PI_OFFLINE = '1';
  }
  selected.PI_SKIP_VERSION_CHECK = '1';
  selected.PI_TELEMETRY = '0';
  selected.PI_BIN = profile.piBinPath;
  selected[ORDINARY_LOCAL_PI_PROFILE_ENV] = input[ORDINARY_LOCAL_PI_PROFILE_ENV]!;
  if (modelCredentials) {
    const authorityHash = input[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV];
    if (!authorityHash) throw new Error('Darwin Pi model credentials require immutable run egress identity');
    const exactSocket = assertAutonomousModelEgressRunBinding(input, {
      runId: profile.runId,
      authorityHash,
    }, 'darwin-local-pi');
    selected.RORCA_AUTONOMOUS_EGRESS_SOCKET = exactSocket;
    // The trusted Darwin relay supervisor atomically allocates a collision-safe
    // loopback endpoint and sets proxy variables only on the sandboxed child.
  } else {
    delete selected.HTTP_PROXY;
    delete selected.HTTPS_PROXY;
    delete selected.ALL_PROXY;
    delete selected.NO_PROXY;
    delete selected.RORCA_AUTONOMOUS_EGRESS_SOCKET;
  }
  return selected;
}

function absoluteGitPath(cwd: string, flag: '--absolute-git-dir' | '--git-common-dir'): string | null {
  try {
    const value = execFileSync('git', ['-C', cwd, 'rev-parse', flag], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
    }).trim();
    return fs.realpathSync(path.isAbsolute(value) ? value : path.resolve(cwd, value));
  } catch {
    return null;
  }
}

function sharedGitReadOnlyPaths(cwd: string, sharedObjectDirs: readonly string[]): string[] {
  const gitDir = absoluteGitPath(cwd, '--absolute-git-dir');
  const commonDir = absoluteGitPath(cwd, '--git-common-dir');
  return [...new Set([
    gitDir,
    commonDir,
    ...sharedObjectDirs,
  ].filter((value): value is string => value !== null))];
}

function assertRepositoryConfigHasNoEmbeddedCredential(gitRoot: string): void {
  const config = path.join(gitRoot, 'config');
  if (!fs.existsSync(config)) return;
  const content = fs.readFileSync(config, 'utf8');
  if (/https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(content)
    || /(?:gh[pousr]_|github_pat_|x-access-token)[A-Za-z0-9_.-]{8,}/i.test(content)) {
    throw new Error('Repository Git config contains an embedded credential and cannot enter autonomous isolation');
  }
}

function mountParentDirs(args: string[], destination: string, coveredRoots: readonly string[]): void {
  let current = path.dirname(destination);
  const pending: string[] = [];
  while (current !== path.dirname(current) && !coveredRoots.some(root => within(current, root))) {
    pending.push(current);
    current = path.dirname(current);
  }
  for (const dir of pending.reverse()) args.push('--dir', dir);
}

function addBind(
  args: string[],
  source: string,
  destination: string,
  readOnly: boolean,
  coveredRoots: string[],
  forceOvermount = false,
): void {
  if (!forceOvermount && coveredRoots.some(root => within(destination, root))) return;
  mountParentDirs(args, destination, coveredRoots);
  args.push(readOnly ? '--ro-bind' : '--bind', source, destination);
  if (!forceOvermount) coveredRoots.push(destination);
}

function addMergedUsrAliases(args: string[], roots: readonly string[]): void {
  for (const [alias, expectedTarget] of MERGED_USR_ALIASES) {
    try {
      if (!fs.lstatSync(alias).isSymbolicLink() || fs.readlinkSync(alias) !== expectedTarget) continue;
      const resolved = fs.realpathSync(alias);
      if (roots.some(root => within(resolved, root))) args.push('--symlink', expectedTarget, alias);
    } catch { /* absent on this distribution */ }
  }
}

function workspaceCredentialPaths(cwd: string): string[] {
  const candidates: string[] = [];
  const stack = [cwd];
  let visited = 0;
  const sensitiveDirectoryNames = new Set(['.ssh', '.aws']);
  const sensitiveFileNames = new Set(['.npmrc', '.netrc', '.pypirc']);
  const sensitiveSuffixes = [
    '.config/gh', '.config/gcloud',
    '.claude/.credentials.json', '.claude/settings.local.json',
    '.codex/auth.json', '.pi/agent/auth.json',
  ];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > 250_000) throw new Error('Autonomous credential scan exceeded its bounded workspace inventory');
      const candidate = path.join(directory, entry.name);
      const relative = path.relative(cwd, candidate).split(path.sep).join('/');
      const envFile = /^\.env(?:\..+)?$/.test(entry.name)
        && !/\.(?:example|sample|template)$/.test(entry.name);
      const sensitive = envFile || sensitiveFileNames.has(entry.name)
        || sensitiveDirectoryNames.has(entry.name)
        || sensitiveSuffixes.some(suffix => relative === suffix || relative.endsWith(`/${suffix}`));
      if (sensitive) {
        candidates.push(candidate);
        continue;
      }
      // Git metadata is separately excluded by the sandbox mount plan. Every
      // other subtree is inventoried; credential-shaped files in build output
      // or dependencies are not trusted merely because of their directory name.
      if (entry.isDirectory() && entry.name !== '.git') stack.push(candidate);
    }
  }
  return [...new Set(candidates)];
}

function maskWorkspaceCredentialFiles(args: string[], cwd: string): void {
  for (const candidate of workspaceCredentialPaths(cwd)) {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error('Autonomous workspace credential/archive path cannot be a symbolic link');
    if (stat.isDirectory()) args.push('--tmpfs', candidate);
    else args.push('--ro-bind', os.devNull, candidate);
  }
}

function seatbeltString(value: string): string {
  return JSON.stringify(value);
}

function seatbeltSubpaths(paths: readonly string[]): string {
  return paths.map(value => `(subpath ${seatbeltString(value)})`).join(' ');
}

function seatbeltLiterals(paths: readonly string[]): string {
  return paths.map(value => `(literal ${seatbeltString(value)})`).join(' ');
}

function pathAncestors(value: string): string[] {
  const ancestors: string[] = [];
  let current = path.resolve(value);
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

function nearestRuntimePackage(realEntrypoint: string, allowedNames: ReadonlySet<string>): string | null {
  let current = path.dirname(realEntrypoint);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest) && fs.statSync(manifest).isFile()) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: unknown };
        if (typeof packageJson.name === 'string' && allowedNames.has(packageJson.name)) return current;
      } catch {
        // A malformed ancestor manifest never broadens executable authority.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function localPiRuntimePaths(piBinPath: string): { roots: string[]; files: string[] } {
  const launcher = path.resolve(piBinPath);
  const launcherDir = path.dirname(launcher);
  const files = [launcher, fs.realpathSync(launcher), fs.realpathSync(process.execPath)];
  // Autonomous validation commonly invokes exact Node/npm/npx shims from the
  // same selected installation. Admit those files and npm's own package only;
  // never expose the sibling bin directory or global node_modules wholesale.
  for (const tool of ['node', 'npm', 'npx']) {
    const candidate = path.join(launcherDir, tool);
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    files.push(path.resolve(candidate), fs.realpathSync(candidate));
  }
  const packageNames = new Set([
    '@earendil-works/pi-coding-agent',
    '@mariozechner/pi-coding-agent',
    'npm',
  ]);
  const roots = files
    .map(value => nearestRuntimePackage(fs.realpathSync(value), packageNames))
    .filter((value): value is string => value !== null);
  // The worker Node runtime directory (bin + lib): the interpreter's dynamic
  // libraries must be readable for the pi/npm launchers to exec inside the
  // seatbelt — a bare binary file admission is not enough.
  roots.push(path.dirname(path.dirname(fs.realpathSync(process.execPath))));
  return {
    roots: [...new Set(roots.map(value => path.resolve(value)))],
    files: [...new Set(files)],
  };
}

/**
 * Build the macOS Seatbelt policy for the worker-issued ordinary Pi profile.
 * This is intentionally a restrictive profile, not a raw-host fallback: it
 * permits only the isolated worktree, related Git metadata, selected Pi state,
 * the explicit Pi runtime, and (when needed) loopback access to the exact-host
 * model egress broker. Direct outbound traffic remains denied. Credential-shaped
 * files in the worktree remain denied even though the worktree is writable.
 */
export function buildDarwinOrdinaryLocalPiSeatbeltProfile(
  cwd: string,
  profile: { piBinPath: string; workspacePath?: string },
  env: Record<string, string>,
  explicitResourcePaths: readonly string[] = [],
): string {
  const worktree = fs.realpathSync(cwd);
  const sharedObjectDirs = assertNoSharedGitHardlinkAliases(worktree);
  const home = env.HOME;
  const configuredTmpdir = env.TMPDIR;
  if (!home || !path.isAbsolute(home) || !configuredTmpdir || !path.isAbsolute(configuredTmpdir)) {
    throw new Error('ordinary local Pi Seatbelt environment is incomplete');
  }
  const tmpdir = fs.realpathSync(configuredTmpdir);
  const gitRoots = sharedGitReadOnlyPaths(worktree, sharedObjectDirs);
  for (const gitRoot of gitRoots) assertRepositoryConfigHasNoEmbeddedCredential(gitRoot);
  const privateGitRoot = env.GIT_DIR ? fs.realpathSync(env.GIT_DIR) : null;
  if (!privateGitRoot) throw new Error('ordinary local Pi Seatbelt profile requires run-private Git state');

  const runtimePaths = localPiRuntimePaths(profile.piBinPath);
  const runtimeRoots = runtimePaths.roots;
  const guardDirs = ordinaryLocalGuardDirs(env);
  // macOS command runners can consult this root-owned shell selector even
  // when `/bin/sh` itself is readable. Permit only this literal selector—never
  // the enclosing writable /private/var tree—to keep xcrun/npm shell launches
  // from emitting spurious EPERM diagnostics.
  const systemShellSelectors = process.platform === 'darwin' && fs.existsSync('/private/var/select/sh')
    ? ['/private/var/select/sh']
    : [];
  const configuredEgressSocket = env.RORCA_AUTONOMOUS_EGRESS_SOCKET;
  // Production preparation already requires a real Unix socket. The fallback
  // keeps this pure policy builder usable for deterministic string fixtures.
  const egressSocket = configuredEgressSocket
    ? (realExisting(configuredEgressSocket) ?? path.resolve(configuredEgressSocket))
    : undefined;
  const resources = [...new Set(explicitResourcePaths.map((value) => fs.realpathSync(value)))];
  const resourceRoots = resources.filter((value) => fs.statSync(value).isDirectory());
  const resourceFiles = [...new Set([
    ...runtimePaths.files,
    fs.realpathSync(process.execPath),
    ...resources.filter((value) => fs.statSync(value).isFile()),
  ])];
  // The git worktree shares no dependencies with the main checkout, but the
  // agent must run the project's own toolchain (tsc/jest/vitest) to validate
  // stories. Admit only the workspace node_modules trees read-only — never the
  // workspace itself, which may hold credentials.
  const workspaceNodeModules = (profile.workspacePath
    ? [
        path.join(profile.workspacePath, 'node_modules'),
        path.join(profile.workspacePath, 'backend', 'node_modules'),
        path.join(profile.workspacePath, 'shared', 'node_modules'),
      ]
    : []).filter((value) => {
      try { return fs.statSync(value).isDirectory(); } catch { return false; }
    });
  const runtimeRoot = fs.realpathSync(path.dirname(tmpdir));
  const readableRoots = [...new Set([
    '/usr', '/bin', '/System', '/Library',
    // Homebrew git and its libexec live outside /usr; the real binary is
    // required so the child never falls back to the /usr/bin xcrun shim.
    '/opt/homebrew',
    worktree, runtimeRoot,
    ...runtimeRoots,
    ...guardDirs,
    ...resourceRoots,
    ...workspaceNodeModules,
    ...gitRoots,
    privateGitRoot,
  ].map(value => path.resolve(value)))];
  const writableRoots = [...new Set([
    worktree, runtimeRoot, privateGitRoot,
  ].map(value => path.resolve(value)))];
  // Node resolves an entrypoint through every ancestor. Permit metadata-only
  // traversal of those ancestors without granting their file contents.
  const metadataRoots = [...new Set([
    home,
    ...readableRoots,
    ...systemShellSelectors,
    ...resourceFiles,
  ].flatMap(pathAncestors))];
  const credentialDenyRules = workspaceCredentialPaths(worktree).map((candidate) => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error('Autonomous workspace credential/archive path cannot be a symbolic link');
    const filter = stat.isDirectory()
      ? `(subpath ${seatbeltString(candidate)})`
      : `(literal ${seatbeltString(candidate)})`;
    return `(deny file-read* file-write* file-map-executable ${filter})`;
  });

  const localApiPort = String(env.PORT ?? '3030').trim() || '3030';
  const networkRules = [
    ...(egressSocket
      ? [`(allow network-outbound (remote ip "localhost:${DARWIN_RELAY_PORT_TOKEN}"))`]
      : []),
    // The isolated agent must reach the local Rorca control-plane API directly;
    // NO_PROXY exempts loopback from the broker so these requests are never
    // classified as model egress.
    `(allow network-outbound (remote ip "localhost:${localApiPort}"))`,
  ];

  // The invocation-owned test-database lane: Jest inside the sandbox re-reads
  // the exact lease (state + owner.lease) and connects to the cluster's Unix
  // socket, both under the invocation root. The root is admitted read/write —
  // it is a disposable per-run cluster, never the canonical database. The
  // process-info allowance lets the sandboxed Jest observe the host lease
  // owner's exact process-start identity (/bin/ps), which system.sb denies by
  // default; without it the nonce-scoped owner verification always fails.
  const invocationRoot = env.RORCA_JEST_STATE_FILE
    ? path.dirname(fs.realpathSync(env.RORCA_JEST_STATE_FILE))
    : null;
  if (invocationRoot) {
    readableRoots.push(invocationRoot);
    writableRoots.push(invocationRoot);
  }
  const gitControlWriteDeny = `(deny file-write* ${seatbeltSubpaths(gitRoots)} (literal ${seatbeltString(path.join(worktree, '.git'))}))`;
  const seatbeltProfile = [
    '(version 1)',
    '(import "system.sb")',
    '(allow process-exec process-fork)',
    // Interactive CLIs must set terminal attributes (TIOCSETA/TIOCSETAW) on
    // their inherited PTY. This does not grant access to open any device: the
    // independent file read/write denies below still govern /dev paths.
    '(allow file-ioctl (subpath "/dev"))',
    '(deny network*)',
    ...networkRules,
    '(deny file-read*)',
    `(allow file-read-metadata file-test-existence ${seatbeltLiterals(metadataRoots)})`,
    `(allow file-read* ${seatbeltSubpaths(readableRoots)} ${seatbeltLiterals(resourceFiles)})`,
    `(allow file-map-executable ${seatbeltSubpaths(readableRoots)} ${seatbeltLiterals(resourceFiles)})`,
    `(allow file-read* ${seatbeltSubpaths(readableRoots)})`,
    `(allow file-map-executable ${seatbeltSubpaths(readableRoots)})`,
    ...(systemShellSelectors.length > 0 ? [
      `(allow file-read* ${seatbeltLiterals(systemShellSelectors)})`,
      `(allow file-map-executable ${seatbeltLiterals(systemShellSelectors)})`,
    ] : []),
    '(deny file-write*)',
    `(allow file-write* ${seatbeltSubpaths(writableRoots)})`,
    // A child may unset GIT_DIR or invoke /usr/bin/git directly. Explicit deny
    // rules keep the linked/common Git control plane and worktree pointer host-owned.
    gitControlWriteDeny,
    ...credentialDenyRules,
  ].join('\n');
  assertReachableLocalGitObjectDirectoriesUnchanged(worktree, sharedObjectDirs);
  return seatbeltProfile;
}

function assertWorkspaceSeparatedFromTrustedRuntime(cwd: string, roots: readonly string[]): void {
  if (roots.some(root => within(cwd, root))) {
    throw new Error('Autonomous worktree overlaps a read-only tool root');
  }
  // In source this module is backend/src/lib; in the image it is
  // backend/dist/lib. In both cases two parents identify the trusted backend
  // installation, which must never be writable through the worktree bind.
  const trustedBackend = fs.realpathSync(path.resolve(__dirname, '..', '..'));
  if (within(cwd, trustedBackend) || within(trustedBackend, cwd)) {
    throw new Error('Autonomous worktree overlaps the trusted engine installation');
  }
}

function buildBwrapArgs(options: AutonomousSandboxOptions, executable: string, roots: readonly string[]): string[] {
  const cwd = fs.realpathSync(options.cwd);
  assertWorkspaceSeparatedFromTrustedRuntime(cwd, roots);
  const sharedObjectDirs = assertNoSharedGitHardlinkAliases(cwd);
  const innerEnv = safeProductionEnv(options.env, options.modelCredentials === true, options.modelCredentials === true, cwd);
  const args = [
    '--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL',
    '--hostname', 'rorca-autonomous',
    '--clearenv',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/home', '--dir', '/home/rorca-agent',
  ];
  addMergedUsrAliases(args, roots);
  const covered: string[] = [];
  for (const root of roots) addBind(args, root, root, true, covered);
  addBind(args, cwd, cwd, false, covered);
  const sharedGitPaths = new Set(sharedGitReadOnlyPaths(cwd, sharedObjectDirs));
  for (const gitPath of sharedGitPaths) {
    assertRepositoryConfigHasNoEmbeddedCredential(gitPath);
    // Force a read-only overmount even when the repository metadata is nested
    // below the writable worktree bind (ordinary repository, not linked worktree).
    addBind(args, gitPath, gitPath, true, covered, true);
  }
  const worktreeGitPointer = path.join(cwd, '.git');
  if (fs.existsSync(worktreeGitPointer)
    && ![...sharedGitPaths].some(gitPath => path.resolve(gitPath) === path.resolve(worktreeGitPointer))) {
    addBind(args, worktreeGitPointer, worktreeGitPointer, true, covered, true);
  }
  if (innerEnv.GIT_DIR) {
    addBind(args, fs.realpathSync(innerEnv.GIT_DIR), fs.realpathSync(innerEnv.GIT_DIR), false, covered);
  }
  const bwrapInvocationRoot = innerEnv.RORCA_JEST_STATE_FILE
    ? path.dirname(fs.realpathSync(innerEnv.RORCA_JEST_STATE_FILE))
    : null;
  if (bwrapInvocationRoot) {
    // The invocation-owned test cluster must stay reachable inside the
    // private bwrap namespace (its /tmp is a fresh tmpfs). Read/write bind:
    // the socket connect and lease re-read happen inside the container.
    addBind(args, bwrapInvocationRoot, bwrapInvocationRoot, false, covered);
  }
  maskWorkspaceCredentialFiles(args, cwd);
  const egressSocket = options.modelCredentials ? options.env.RORCA_AUTONOMOUS_EGRESS_SOCKET : undefined;
  if (options.modelCredentials && !egressSocket) {
    throw new Error('Autonomous model credentials require the confined egress broker');
  }
  if (options.modelEgressIdentity) {
    assertAutonomousModelEgressBinding(options.env, options.modelEgressIdentity, 'linux-bwrap');
  }
  if (egressSocket) {
    const realSocket = fs.realpathSync(egressSocket);
    if (!fs.statSync(realSocket).isSocket()) throw new Error('Autonomous model egress endpoint is not a Unix socket');
    addBind(args, realSocket, SANDBOX_EGRESS_SOCKET, true, covered);
  }
  for (const [key, value] of Object.entries(innerEnv).sort(([a], [b]) => a.localeCompare(b))) {
    args.push('--setenv', key, value);
  }
  if (egressSocket) {
    const node = ['/usr/local/bin/node', '/usr/bin/node'].map(realExisting)
      .find((value): value is string => value !== null && roots.some(root => within(value, root)));
    if (!node) throw new Error('Autonomous egress relay requires an approved absolute Node executable');
    args.push('--chdir', cwd, '--', node, '-e', EGRESS_RELAY_SCRIPT,
      SANDBOX_EGRESS_SOCKET, executable, JSON.stringify(options.args));
  } else {
    args.push('--chdir', cwd, '--', executable, ...options.args);
  }
  assertReachableLocalGitObjectDirectoriesUnchanged(cwd, sharedObjectDirs);
  return args;
}

export function buildLinuxSandboxArgumentsForTests(
  options: AutonomousSandboxOptions,
  executable: string,
  roots: readonly string[],
): string[] {
  return buildBwrapArgs(options, executable, roots);
}

export function sanitizeAutonomousSandboxEnvForTests(
  input: Record<string, string>,
  modelCredentials = false,
): Record<string, string> {
  return safeProductionEnv(input, modelCredentials);
}

/** Build one launch that cannot see the trusted ancestor namespace/filesystem/network. */
export function prepareAutonomousSandboxLaunch(options: AutonomousSandboxOptions): AutonomousSandboxLaunch {
  // This marker is created only by worker.ts after it revalidates the immutable
  // run envelope. It is deliberately unavailable to API-side model launchers
  // and every Linux/RB-02 qualification path; TaskManifest use additionally
  // requires the runtime marker's exact worker-validated PR posture.
  const ordinaryLocalProfile = assertOrdinaryLocalPiRuntimeProfile(options.cwd, options.env);
  if (ordinaryLocalProfile) {
    const cwd = fs.realpathSync(options.cwd);
    const env = safeOrdinaryLocalPiEnv(options.env, ordinaryLocalProfile, cwd, options.modelCredentials === true);
    const commandRealPath = path.isAbsolute(options.command)
      ? fs.realpathSync(options.command)
      : null;
    const externalCommand = commandRealPath && !within(commandRealPath, cwd)
      ? commandRealPath
      : null;
    if (externalCommand) fs.accessSync(externalCommand, fs.constants.X_OK);
    // OMP's compiled launcher resolves bundled installation metadata relative
    // to <formula>/bin/omp before rendering its composer. Admit that immutable
    // versioned formula root read-only; exact-file access alone makes the real
    // OMP binary exit after its Bun warning without reaching PTY readiness.
    const externalCommandReadRoot = externalCommand && path.basename(externalCommand) === 'omp'
      ? path.dirname(path.dirname(externalCommand))
      : null;
    const explicitResourcePaths = [
      // The ordinary-local profile may govern a Pi-compatible managed shim,
      // not only the frozen Pi entrypoint. Generic launchers receive exact-file
      // access; the OMP formula root above is the sole bundled-runtime case.
      ...(externalCommand ? [externalCommand] : []),
      ...(externalCommandReadRoot ? [externalCommandReadRoot] : []),
      ...options.args.flatMap((value, index, args) => {
        if (!['--extension', '--skill', '--prompt-template', '--theme'].includes(args[index - 1] ?? '')) return [];
        if (!path.isAbsolute(value) || within(path.resolve(value), cwd) || !fs.existsSync(value)) return [];
        return [value];
      }),
    ];
    const seatbelt = buildDarwinOrdinaryLocalPiSeatbeltProfile(
      cwd,
      ordinaryLocalProfile,
      env,
      explicitResourcePaths,
    );
    // Seatbelt execvp can refuse a writable-worktree symlink even when its exact
    // immutable target is admitted. Execute the already revalidated real Pi
    // entrypoint; argv and package/resource authority remain unchanged.
    const sandboxCommand = path.resolve(options.command) === path.resolve(ordinaryLocalProfile.piBinPath)
      ? ordinaryLocalProfile.piRealPath
      // OMP is commonly installed through a Homebrew/npm symlink. Execute the
      // exact target admitted above so a mutable launcher path cannot drift
      // between Seatbelt policy construction and exec.
      : externalCommand ?? options.command;
    if (options.modelCredentials === true) {
      return {
        command: fs.realpathSync(process.execPath),
        args: [
          '-e', DARWIN_EGRESS_RELAY_SUPERVISOR,
          env.RORCA_AUTONOMOUS_EGRESS_SOCKET, seatbelt, DARWIN_RELAY_PORT_TOKEN,
          sandboxCommand, JSON.stringify(options.args),
        ],
        cwd,
        env,
        isolated: true,
      };
    }
    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-p', seatbelt, sandboxCommand, ...options.args],
      cwd,
      env,
      isolated: true,
    };
  }

  configuredPosture();
  const cwd = fs.realpathSync(options.cwd);
  if (process.platform !== 'linux') throw new Error('linux-bwrap autonomous isolation requires Linux');
  const roots = toolRoots();
  const executable = resolveExecutable(options.command, options.env, roots);
  const env = safeProductionEnv(options.env, options.modelCredentials === true);
  return {
    command: linuxSandboxLauncherBinary(),
    args: buildBwrapArgs(options, executable, roots),
    cwd,
    // The launcher itself receives no worker/engine secret either. `--clearenv`
    // independently reconstructs the still smaller environment inside.
    env,
    isolated: true,
  };
}

function runBoundaryProbe(cwd: string, env: NodeJS.ProcessEnv): void {
  const sentinelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sandbox-credential-'));
  const sentinel = path.join(sentinelRoot, 'credentials');
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sandbox-worktree-'));
  const workspaceCredential = path.join(probeRoot, '.env');
  const nestedCredential = path.join(probeRoot, 'node_modules', 'fixture', '.env.local');
  fs.mkdirSync(path.dirname(nestedCredential), { recursive: true });
  fs.writeFileSync(sentinel, 'must-not-be-readable', { mode: 0o600 });
  fs.writeFileSync(workspaceCredential, 'must-not-be-readable', { mode: 0o600 });
  fs.writeFileSync(nestedCredential, 'must-not-be-readable', { mode: 0o600 });
  execFileSync('git', ['init', '--quiet'], {
    cwd: probeRoot,
    stdio: 'ignore',
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  const script = String.raw`
const fs=require('fs'),net=require('net'),cp=require('child_process');
const sentinel=process.argv[1],workspaceCredential=process.argv[2],nestedCredential=process.argv[3],tools=JSON.parse(process.argv[4]);
const ancestorMarker=Buffer.from('RORCA_ANCESTOR_SECRET_PROBE=');
for(const pid of fs.readdirSync('/proc').filter(v=>/^\d+$/.test(v))){try{if(fs.readFileSync('/proc/'+pid+'/environ').includes(ancestorMarker))process.exit(41)}catch{}}
try{fs.readFileSync(sentinel);process.exit(42)}catch{}
try{fs.readFileSync(workspaceCredential);process.exit(45)}catch{}
try{fs.readFileSync(nestedCredential);process.exit(46)}catch{}
for(const tool of tools){const r=cp.spawnSync(tool,['--version'],{encoding:'utf8'});if(r.status!==0)process.exit(43)}
function denied(host,port){return new Promise((resolve,reject)=>{const s=net.connect({host,port});const t=setTimeout(()=>{s.destroy();reject(new Error('socket timeout'))},500);s.once('connect',()=>{clearTimeout(t);s.destroy();reject(new Error('socket connected'))});s.once('error',()=>{clearTimeout(t);resolve()})})}
Promise.all([denied('127.0.0.1',3030),denied('198.51.100.1',443)]).then(()=>process.exit(0),()=>process.exit(44));`;
  try {
    const roots = toolRoots(env);
    const requiredCandidates: Record<string, string[]> = {
      node: ['/usr/local/bin/node', '/usr/bin/node'],
      python3: ['/usr/local/bin/python3', '/usr/bin/python3'],
      git: ['/usr/local/bin/git', '/usr/bin/git'],
      gh: ['/usr/local/bin/gh', '/usr/bin/gh'],
      npm: ['/usr/local/bin/npm', '/usr/bin/npm'],
      npx: ['/usr/local/bin/npx', '/usr/bin/npx'],
    };
    const tools = Object.entries(requiredCandidates).map(([name, candidates]) => {
      const tool = candidates.map(realExisting).find((value): value is string => value !== null
        && roots.some(root => within(value, root)));
      if (!tool) throw new Error(`sandbox probe requires approved absolute ${name}`);
      return tool;
    });
    const node = tools[0];
    const probeArgs = ['-e', script, sentinel, workspaceCredential, nestedCredential, JSON.stringify(tools)];
    const launch = prepareAutonomousSandboxLaunch({
      command: node,
      args: probeArgs,
      cwd: probeRoot,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });
    const runThroughMarkedSupervisor = (candidate: AutonomousSandboxLaunch): ReturnType<typeof spawnSync> => {
      const marker = `rorca-ancestor-secret-${crypto.randomBytes(24).toString('hex')}`;
      return spawnSync(process.execPath, ['-e', BOUNDARY_PROBE_SUPERVISOR], {
        env: { ...launch.env, RORCA_ANCESTOR_SECRET_PROBE: marker },
        input: JSON.stringify(candidate),
        encoding: 'utf8', timeout: 20_000,
      });
    };
    // Sensitivity deliberately has neither PID nor user isolation. The exact
    // child probe and sanitized environment must see its marked supervisor;
    // only after that proves exit 41 do we trust the canonical Linux launcher result.
    const sensitivity = runThroughMarkedSupervisor({
      command: node, args: probeArgs, cwd: probeRoot, env: launch.env, isolated: false,
    });
    if (sensitivity.status !== 41) {
      throw new Error(`autonomous sandbox PID-isolation sensitivity probe expected ancestor visibility exit 41, got ${sensitivity.status ?? sensitivity.signal ?? 'unknown'}`);
    }
    const result = runThroughMarkedSupervisor(launch);
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ''}`.trim().slice(-4096);
      throw new Error(`autonomous sandbox capability probe failed (${result.status ?? result.signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`);
    }
  } finally {
    fs.rmSync(sentinelRoot, { recursive: true, force: true });
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

/** Fail before a run becomes running or gains any release-eligible result. */
export function assertAutonomousExecutionBoundary(options: AutonomousBoundaryPreflightOptions): void {
  const env = options.env ?? process.env;
  const posture = configuredPosture(env);
  // local-dev is an explicit opt-in for single-user local development hosts
  // (e.g. macOS) where no bwrap launcher exists. Production remains fail-closed:
  // linux-bwrap on Linux only, and any other value still throws above.
  if (posture === 'local-dev') return;
  if ((options.platform ?? process.platform) !== 'linux') throw new Error('linux-bwrap autonomous isolation requires Linux');
  const binary = linuxSandboxLauncherBinary(env);
  fs.accessSync(binary, fs.constants.X_OK);
  assertWorkspaceSeparatedFromTrustedRuntime(fs.realpathSync(options.cwd), toolRoots(env));
  const key = `${binary}\0${fs.realpathSync(options.cwd)}\0${String(env.RORCA_AUTONOMOUS_TOOL_ROOTS ?? '')}`;
  if (options.runProbe !== false && successfulProbeKey !== key) {
    runBoundaryProbe(options.cwd, env);
    successfulProbeKey = key;
  }
}

/**
 * Prepare a model/tool launcher only after the same namespace probe and exact-host
 * CONNECT broker used by the canonical worker. The broker is trusted transport,
 * not an orchestrator, and exposes no DB/vault/provider/control-plane operation.
 */
export async function prepareAutonomousModelSandboxLaunch(
  options: AutonomousSandboxOptions,
): Promise<AutonomousModelSandboxLaunch> {
  assertAutonomousExecutionBoundary({ cwd: options.cwd, providerCapable: true });
  const isolation = process.env.RORCA_AUTONOMOUS_ISOLATION;
  if (isolation === 'local-dev') {
    // Explicit local single-user dev posture: direct spawn, no bwrap launcher
    // and no egress broker. Identity is still minted for receipt parity.
    const identity = options.modelEgressIdentity ?? createAutonomousModelEgressOperationIdentity({
      executable: options.command,
      argv: [...options.args],
      cwd: fs.realpathSync(options.cwd),
      isolation,
      allowedHosts: String(process.env.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS ?? ''),
    });
    return {
      command: options.command,
      args: [...options.args],
      cwd: options.cwd,
      env: { ...options.env },
      isolated: false,
      modelEgressIdentity: identity,
      modelEgressSocket: '',
      closeModelEgress: async () => undefined,
    };
  }
  if (isolation !== 'linux-bwrap') {
    throw new Error('Non-pipeline model operations require linux-bwrap or local-dev isolation');
  }
  const identity = options.modelEgressIdentity ?? createAutonomousModelEgressOperationIdentity({
    executable: options.command,
    argv: [...options.args],
    cwd: fs.realpathSync(options.cwd),
    isolation,
    allowedHosts: String(process.env.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS ?? ''),
  });
  const brokerEnv: NodeJS.ProcessEnv = { ...process.env };
  delete brokerEnv.RORCA_AUTONOMOUS_EGRESS_SOCKET;
  delete brokerEnv[AUTONOMOUS_EGRESS_RUN_ID_ENV];
  delete brokerEnv[AUTONOMOUS_EGRESS_OPERATION_ID_ENV];
  delete brokerEnv[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV];
  delete brokerEnv[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV];

  let closePromise: Promise<void> | null = null;
  const closeModelEgress = (): Promise<void> => {
    closePromise ??= closeAutonomousModelEgress(identity);
    return closePromise;
  };
  try {
    const egressSocket = await ensureAutonomousModelEgress(brokerEnv, 'linux-bwrap', identity);
    if (!egressSocket) throw new Error('Autonomous model egress broker is unavailable');
    const operationEnv: Record<string, string> = {
      ...options.env,
      RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: brokerEnv.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS!,
      RORCA_AUTONOMOUS_EGRESS_SOCKET: egressSocket,
      [AUTONOMOUS_EGRESS_OPERATION_ID_ENV]: brokerEnv[AUTONOMOUS_EGRESS_OPERATION_ID_ENV]!,
      [AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV]: brokerEnv[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV]!,
      [AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV]: brokerEnv[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV]!,
    };
    delete operationEnv[AUTONOMOUS_EGRESS_RUN_ID_ENV];
    const launch = prepareAutonomousSandboxLaunch({
      ...options,
      modelCredentials: true,
      modelEgressIdentity: identity,
      env: operationEnv,
    });
    return {
      ...launch,
      modelEgressIdentity: identity,
      modelEgressSocket: egressSocket,
      closeModelEgress,
    };
  } catch (error) {
    await closeModelEgress();
    throw error;
  }
}

export function removeOrdinaryLocalPiRuntimeState(runtimeRoot: string): void {
  let trustedRoot: string;
  try { trustedRoot = assertOrdinaryLocalPiRuntimeRoot(runtimeRoot, false); } catch { return; }
  // The exact root is a direct child of the real OS temporary directory, so
  // there is no model-writable intermediate component. A substituted final
  // symlink is rejected above rather than followed.
  fs.rmSync(trustedRoot, { recursive: true, force: true });
  activeOrdinaryLocalPiRuntimeRoots.delete(trustedRoot);
}

/** Remove credential snapshots left by SIGKILL/host loss before new jobs poll.
 * `isRunLive` protects roots owned by runs that are still `running` in the DB —
 * required in parallel-worker mode, where another worker's live run owns a
 * root this process cannot see in its own active set. */
export function sweepStaleOrdinaryLocalPiRuntimeState(
  candidates?: readonly string[],
  isRunLive?: (runId: number) => boolean,
): number {
  const temporaryRoot = realTemporaryRoot();
  const roots = candidates ?? fs.readdirSync(temporaryRoot)
    .filter(name => name.startsWith(ORDINARY_LOCAL_PI_RUNTIME_PREFIX))
    .map(name => path.join(temporaryRoot, name));
  let removed = 0;
  for (const candidate of roots) {
    if (path.dirname(path.resolve(candidate)) !== temporaryRoot
      || !path.basename(candidate).startsWith(ORDINARY_LOCAL_PI_RUNTIME_PREFIX)) continue;
    if (activeOrdinaryLocalPiRuntimeRoots.has(candidate)) continue;
    // Roots are named `rorca-ordinary-local-pi-runtime-<runId>-<nonce>`.
    // Never delete a root whose run is still live in the DB.
    if (isRunLive) {
      const runIdText = path.basename(candidate)
        .slice(ORDINARY_LOCAL_PI_RUNTIME_PREFIX.length)
        .split('-')[0];
      const runId = Number(runIdText);
      if (Number.isSafeInteger(runId) && runId > 0 && isRunLive(runId)) continue;
    }
    try {
      const trustedRoot = assertOrdinaryLocalPiRuntimeRoot(candidate, false);
      fs.rmSync(trustedRoot, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Never follow or recursively remove an attacker-substituted entry.
    }
  }
  return removed;
}

export function resetAutonomousSandboxProbeForTests(): void {
  successfulProbeKey = null;
}
