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
import { ensureAutonomousModelEgress } from './autonomous-model-egress';
import {
  ORDINARY_LOCAL_PI_PROFILE_ENV,
  assertOrdinaryLocalPiRuntimeProfile,
} from './ordinary-local-pi-profile';

export type AutonomousIsolationPosture = 'linux-bwrap';

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
  'NO_COLOR', 'FORCE_COLOR', 'CI', 'TZ',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1',
  'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'GCM_INTERACTIVE', 'GH_CONFIG_DIR',
  'RORCA_AUTONOMOUS_COMMAND_GUARD', 'RORCA_AUTONOMOUS_WORKSPACE_ROOT',
  'RORCA_EVENT', 'RORCA_HOOK_TYPE', 'RORCA_RUN_ID', 'RORCA_STORY_ID',
  'RORCA_ALLOW_BACKEND_JEST', 'RORCA_AUTONOMOUS_BACKEND_JEST_DATABASE_URL',
  'RORCA_AUTONOMOUS_BACKEND_JEST_PGHOST', 'RORCA_AUTONOMOUS_BACKEND_JEST_PGPORT',
  'RORCA_AUTONOMOUS_BACKEND_JEST_PGUSER', 'RORCA_AUTONOMOUS_BACKEND_JEST_PGPASSWORD',
  'RORCA_AUTONOMOUS_BACKEND_JEST_PGDATABASE',
]);

const MODEL_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY',
]);
const DEFAULT_TOOL_ROOTS = ['/usr', '/bin', '/lib', '/lib64'];
const SANDBOX_EGRESS_SOCKET = '/run/rorca-egress/proxy.sock';
const SANDBOX_PROXY_URL = 'http://127.0.0.1:3128';
const EGRESS_RELAY_SCRIPT = String.raw`
const net=require('net'),cp=require('child_process');
const socket=process.argv[1],command=process.argv[2],args=JSON.parse(process.argv[3]);
const relay=net.createServer(client=>{const upstream=net.connect({path:socket});client.pipe(upstream);upstream.pipe(client);upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy())});
relay.listen(3128,'127.0.0.1',()=>{const child=cp.spawn(command,args,{stdio:'inherit',env:process.env});for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));child.on('error',()=>process.exit(127));child.on('exit',(code,signal)=>{relay.close();if(signal)process.kill(process.pid,signal);else process.exit(code??1)})});`;
const BOUNDARY_PROBE_SUPERVISOR = String.raw`
const cp=require('child_process');
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk});
process.stdin.on('end',()=>{let launch;try{launch=JSON.parse(input)}catch{process.exit(126)}const child=cp.spawnSync(launch.command,launch.args,{cwd:launch.cwd,env:launch.env,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:15000});if(child.error)process.exit(125);if(child.signal)process.exit(124);process.exit(child.status??123)});`;
const FORBIDDEN_TOOL_ROOTS = ['/', '/root', '/home', '/etc', '/proc', '/sys', '/dev', '/run', '/var/run'];
let successfulProbeKey: string | null = null;

function configuredPosture(env: NodeJS.ProcessEnv = process.env): AutonomousIsolationPosture {
  const value = String(env.RORCA_AUTONOMOUS_ISOLATION ?? '').trim();
  if (value === 'linux-bwrap') return value;
  throw new Error('RORCA_AUTONOMOUS_ISOLATION must explicitly be linux-bwrap; raw local-dev autonomous execution is forbidden');
}

function bwrapBinary(env: NodeJS.ProcessEnv = process.env): string {
  const configured = String(env.RORCA_BWRAP_BIN ?? '/usr/bin/bwrap').trim();
  if (!path.isAbsolute(configured)) throw new Error('RORCA_BWRAP_BIN must be an absolute path');
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

function safeProductionEnv(input: Record<string, string>, modelCredentials = false): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if ((SAFE_PRODUCTION_ENV_KEYS.has(key) || (modelCredentials && MODEL_ENV_KEYS.has(key))) && value !== undefined) {
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
  if (modelCredentials && input.RORCA_AUTONOMOUS_EGRESS_SOCKET) {
    selected.HTTP_PROXY = SANDBOX_PROXY_URL;
    selected.HTTPS_PROXY = SANDBOX_PROXY_URL;
    selected.ALL_PROXY = SANDBOX_PROXY_URL;
    selected.NO_PROXY = '';
    selected.RORCA_AUTONOMOUS_EGRESS_SOCKET = SANDBOX_EGRESS_SOCKET;
  }
  return selected;
}

/**
 * The Darwin ordinary-local profile is intentionally not a generic raw-host
 * fallback. It is issued only by the worker after frozen local-only checks and
 * keeps the same credential stripping and command-guard environment as the
 * Linux launch, then executes inside a scoped Seatbelt policy. Its
 * operator-selected Pi runtime/Home are retained solely for local Pi
 * authentication; GitHub/SSH/provider-control credentials are absent.
 */
function ordinaryLocalGuardDirs(input: Record<string, string>): string[] {
  const guardPrefix = `${path.resolve(os.tmpdir())}${path.sep}rorca-autonomous-guard-`;
  return String(input.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => path.resolve(entry).startsWith(guardPrefix))
    .map((entry) => realExisting(entry))
    .filter((entry): entry is string => entry !== null);
}

function safeOrdinaryLocalPiEnv(
  input: Record<string, string>,
  profile: { piBinPath: string },
  cwd: string,
  modelCredentials: boolean,
): Record<string, string> {
  const selected = safeProductionEnv(input, modelCredentials);
  const home = input.HOME && path.isAbsolute(input.HOME) ? input.HOME : os.homedir();
  const tmpdir = path.join(fs.realpathSync(cwd), '.rorca', 'ordinary-local-pi-tmp');
  fs.mkdirSync(tmpdir, { recursive: true, mode: 0o700 });
  const guardDirs = ordinaryLocalGuardDirs(input);
  selected.PATH = [...new Set([
    ...guardDirs,
    path.dirname(profile.piBinPath),
    '/usr/local/bin', '/usr/bin', '/bin',
  ])].join(path.delimiter);
  selected.HOME = home;
  selected.TMPDIR = tmpdir;
  selected.XDG_CONFIG_HOME = path.join(home, '.config');
  selected.XDG_CACHE_HOME = path.join(home, '.cache');
  selected.npm_config_cache = path.join(home, '.cache', 'npm');
  selected.PI_BIN = profile.piBinPath;
  selected[ORDINARY_LOCAL_PI_PROFILE_ENV] = input[ORDINARY_LOCAL_PI_PROFILE_ENV]!;
  // The local profile never receives the Linux egress socket/proxy. It is
  // branch-only/no-send authority, not a release-delivery profile.
  delete selected.HTTP_PROXY;
  delete selected.HTTPS_PROXY;
  delete selected.ALL_PROXY;
  delete selected.NO_PROXY;
  delete selected.RORCA_AUTONOMOUS_EGRESS_SOCKET;
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

function addBind(args: string[], source: string, destination: string, readOnly: boolean, coveredRoots: string[]): void {
  if (coveredRoots.some(root => within(destination, root))) return;
  mountParentDirs(args, destination, coveredRoots);
  args.push(readOnly ? '--ro-bind' : '--bind', source, destination);
  coveredRoots.push(destination);
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

function localPiRuntimeRoots(piBinPath: string): string[] {
  const launcherDir = path.dirname(piBinPath);
  const roots = [launcherDir];
  // Global npm/pnpm shims (npx, npm, and the Pi launcher) commonly share the
  // same Node installation. Allow that installation's module directory, not a
  // broad user-home ancestor, so ordinary local validation commands can run.
  const globalNodeModules = path.resolve(launcherDir, '..', 'lib', 'node_modules');
  if (fs.existsSync(globalNodeModules) && fs.statSync(globalNodeModules).isDirectory()) {
    roots.push(globalNodeModules);
  }
  let current = path.dirname(fs.realpathSync(piBinPath));
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json'))) {
      roots.push(current);
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // A custom executable does not earn a broad ancestor directory merely
  // because it has no Node package boundary; its own binary directory is all
  // the Seatbelt profile needs to grant.
  return [...new Set(roots.map(value => path.resolve(value)))];
}

/**
 * Build the macOS Seatbelt policy for the worker-issued ordinary Pi profile.
 * This is intentionally a restrictive profile, not a raw-host fallback: it
 * permits only the isolated worktree, related Git metadata, selected Pi state,
 * the explicit Pi runtime, and outbound model traffic. Credential-shaped files
 * in the worktree remain denied even though the worktree is writable.
 */
export function buildDarwinOrdinaryLocalPiSeatbeltProfile(
  cwd: string,
  profile: { piBinPath: string },
  env: Record<string, string>,
): string {
  const worktree = fs.realpathSync(cwd);
  const home = env.HOME;
  const configuredTmpdir = env.TMPDIR;
  if (!home || !path.isAbsolute(home) || !configuredTmpdir || !path.isAbsolute(configuredTmpdir)) {
    throw new Error('ordinary local Pi Seatbelt environment is incomplete');
  }
  const tmpdir = fs.realpathSync(configuredTmpdir);
  const gitRoots = [...new Set([
    absoluteGitPath(worktree, '--absolute-git-dir'),
    absoluteGitPath(worktree, '--git-common-dir'),
  ].filter((value): value is string => value !== null))];
  for (const gitRoot of gitRoots) assertRepositoryConfigHasNoEmbeddedCredential(gitRoot);

  const runtimeRoots = localPiRuntimeRoots(profile.piBinPath);
  const guardDirs = ordinaryLocalGuardDirs(env);
  const readableRoots = [...new Set([
    '/usr', '/bin', '/System', '/Library',
    worktree, tmpdir,
    ...runtimeRoots,
    ...guardDirs,
    path.join(home, '.pi'),
    path.join(home, '.config'),
    path.join(home, '.cache'),
    ...gitRoots,
  ].map(value => path.resolve(value)))];
  const writableRoots = [...new Set([
    worktree, tmpdir,
    path.join(home, '.pi', 'agent'),
    path.join(home, '.cache'),
    ...gitRoots,
  ].map(value => path.resolve(value)))];
  // Node resolves an entrypoint through every ancestor. Permit metadata-only
  // traversal of those ancestors without granting their file contents.
  const metadataRoots = [...new Set([home, ...readableRoots].flatMap(pathAncestors))];
  const credentialDenyRules = workspaceCredentialPaths(worktree).map((candidate) => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error('Autonomous workspace credential/archive path cannot be a symbolic link');
    const filter = stat.isDirectory()
      ? `(subpath ${seatbeltString(candidate)})`
      : `(literal ${seatbeltString(candidate)})`;
    return `(deny file-read* file-write* file-map-executable ${filter})`;
  });

  return [
    '(version 1)',
    '(import "system.sb")',
    '(allow process-exec process-fork)',
    '(deny network-inbound)',
    '(allow network-outbound)',
    '(deny file-read*)',
    `(allow file-read-metadata file-test-existence ${seatbeltLiterals(metadataRoots)})`,
    `(allow file-read* ${seatbeltSubpaths(readableRoots)})`,
    `(allow file-map-executable ${seatbeltSubpaths(readableRoots)})`,
    '(deny file-write*)',
    `(allow file-write* ${seatbeltSubpaths(writableRoots)})`,
    ...credentialDenyRules,
  ].join('\n');
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
  const args = [
    '--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL',
    '--hostname', 'rorca-autonomous',
    '--clearenv',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--dir', '/home', '--dir', '/home/rorca-agent',
  ];
  const covered: string[] = [];
  for (const root of roots) addBind(args, root, root, true, covered);
  addBind(args, cwd, cwd, false, covered);
  for (const gitPath of new Set([
    absoluteGitPath(cwd, '--absolute-git-dir'), absoluteGitPath(cwd, '--git-common-dir'),
  ].filter((value): value is string => value !== null))) {
    assertRepositoryConfigHasNoEmbeddedCredential(gitPath);
    addBind(args, gitPath, gitPath, false, covered);
    const config = path.join(gitPath, 'config');
    if (fs.existsSync(config)) args.push('--ro-bind', config, config);
  }
  maskWorkspaceCredentialFiles(args, cwd);
  const innerEnv = safeProductionEnv(options.env, options.modelCredentials === true);
  const egressSocket = options.modelCredentials ? options.env.RORCA_AUTONOMOUS_EGRESS_SOCKET : undefined;
  if (options.modelCredentials && !egressSocket) {
    throw new Error('Autonomous model credentials require the confined egress broker');
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
  // local-only run envelope. It is deliberately unavailable to API-side model
  // launchers, TaskManifest delivery, and every Linux/RB-02 qualification path.
  const ordinaryLocalProfile = assertOrdinaryLocalPiRuntimeProfile(options.cwd, options.env);
  if (ordinaryLocalProfile) {
    const cwd = fs.realpathSync(options.cwd);
    const env = safeOrdinaryLocalPiEnv(options.env, ordinaryLocalProfile, cwd, options.modelCredentials === true);
    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-p', buildDarwinOrdinaryLocalPiSeatbeltProfile(cwd, ordinaryLocalProfile, env), options.command, ...options.args],
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
    command: bwrapBinary(),
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
    // only after that proves exit 41 do we trust the canonical bwrap result.
    const sensitivity = runThroughMarkedSupervisor({
      command: node, args: probeArgs, cwd: probeRoot, env: launch.env, isolated: false,
    });
    if (sensitivity.status !== 41) {
      throw new Error(`autonomous sandbox PID-isolation sensitivity probe expected ancestor visibility exit 41, got ${sensitivity.status ?? sensitivity.signal ?? 'unknown'}`);
    }
    const result = runThroughMarkedSupervisor(launch);
    if (result.status !== 0) {
      throw new Error(`autonomous sandbox capability probe failed (${result.status ?? result.signal ?? 'unknown'})`);
    }
  } finally {
    fs.rmSync(sentinelRoot, { recursive: true, force: true });
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

/** Fail before a run becomes running or gains any release-eligible result. */
export function assertAutonomousExecutionBoundary(options: AutonomousBoundaryPreflightOptions): void {
  const env = options.env ?? process.env;
  configuredPosture(env);
  if ((options.platform ?? process.platform) !== 'linux') throw new Error('linux-bwrap autonomous isolation requires Linux');
  const binary = bwrapBinary(env);
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
): Promise<AutonomousSandboxLaunch> {
  assertAutonomousExecutionBoundary({ cwd: options.cwd, providerCapable: true });
  const egressSocket = await ensureAutonomousModelEgress();
  if (!egressSocket) throw new Error('Autonomous model egress broker is unavailable');
  return prepareAutonomousSandboxLaunch({
    ...options,
    modelCredentials: true,
    env: { ...options.env, RORCA_AUTONOMOUS_EGRESS_SOCKET: egressSocket },
  });
}

export function resetAutonomousSandboxProbeForTests(): void {
  successfulProbeKey = null;
}
