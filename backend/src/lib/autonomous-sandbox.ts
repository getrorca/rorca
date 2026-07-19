/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Linux capability boundary for every autonomous/model-controlled subprocess. */

import * as crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  // Model credentials are the only production child credentials. The child has
  // no network interface; they are usable only through the exact-host CONNECT
  // broker mounted below, never for GitHub/DB/control-plane egress.
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1',
  'GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'GIT_SSH_COMMAND', 'GCM_INTERACTIVE', 'GH_CONFIG_DIR',
  'RORCA_AUTONOMOUS_COMMAND_GUARD', 'RORCA_AUTONOMOUS_WORKSPACE_ROOT',
  'RORCA_AUTONOMOUS_EGRESS_SOCKET',
  'RORCA_ALLOW_BACKEND_JEST', 'RORCA_AUTONOMOUS_BACKEND_JEST_DATABASE_URL',
  'RORCA_AUTONOMOUS_BACKEND_JEST_PGHOST', 'RORCA_AUTONOMOUS_BACKEND_JEST_PGPORT',
  'RORCA_AUTONOMOUS_BACKEND_JEST_PGUSER', 'RORCA_AUTONOMOUS_BACKEND_JEST_PGPASSWORD',
  'RORCA_AUTONOMOUS_BACKEND_JEST_PGDATABASE',
]);

const PROVIDER_AUTHORITY_KEYS = [
  'GITHUB_TOKEN', 'GH_TOKEN', 'VAULT_KEY', 'RORCA_OPERATOR_CAPABILITY',
  'RORCA_OPERATOR_CAPABILITY_SHA256', 'GIT_ASKPASS', 'SSH_AUTH_SOCK',
] as const;

const DEFAULT_TOOL_ROOTS = ['/usr', '/bin', '/lib', '/lib64'];
const SANDBOX_EGRESS_SOCKET = '/run/rorca-egress/proxy.sock';
const SANDBOX_PROXY_URL = 'http://127.0.0.1:3128';
const EGRESS_RELAY_SCRIPT = String.raw`
const net=require('net'),cp=require('child_process');
const socket=process.argv[1],command=process.argv[2],args=JSON.parse(process.argv[3]);
const relay=net.createServer(client=>{const upstream=net.connect({path:socket});client.pipe(upstream);upstream.pipe(client);upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy())});
relay.listen(3128,'127.0.0.1',()=>{const child=cp.spawn(command,args,{stdio:'inherit',env:process.env});for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));child.on('error',()=>process.exit(127));child.on('exit',(code,signal)=>{relay.close();if(signal)process.kill(process.pid,signal);else process.exit(code??1)})});`;
const FORBIDDEN_TOOL_ROOTS = ['/', '/root', '/home', '/etc', '/proc', '/sys', '/dev', '/run', '/var/run'];
let successfulProbeKey: string | null = null;

function configuredPosture(env: NodeJS.ProcessEnv = process.env): AutonomousIsolationPosture {
  const value = String(env.RORCA_AUTONOMOUS_ISOLATION ?? '').trim();
  if (value === 'linux-bwrap' || value === 'local-dev') return value;
  if (env.NODE_ENV === 'test') return 'local-dev';
  throw new Error('RORCA_AUTONOMOUS_ISOLATION must explicitly be linux-bwrap or local-dev');
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
  const roots = configured ? configured.split(':').filter(Boolean) : DEFAULT_TOOL_ROOTS;
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

function safeProductionEnv(input: Record<string, string>): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SAFE_PRODUCTION_ENV_KEYS.has(key) && value !== undefined) selected[key] = value;
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
  if (input.RORCA_AUTONOMOUS_EGRESS_SOCKET) {
    selected.HTTP_PROXY = SANDBOX_PROXY_URL;
    selected.HTTPS_PROXY = SANDBOX_PROXY_URL;
    selected.ALL_PROXY = SANDBOX_PROXY_URL;
    selected.NO_PROXY = '';
    selected.RORCA_AUTONOMOUS_EGRESS_SOCKET = SANDBOX_EGRESS_SOCKET;
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

function maskWorkspaceCredentialFiles(args: string[], cwd: string): void {
  const candidates: string[] = [];
  for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
    if (entry.isFile() && /^\.env(?:\..+)?$/.test(entry.name)
      && !/\.(?:example|sample|template)$/.test(entry.name)) candidates.push(path.join(cwd, entry.name));
  }
  for (const relative of [
    '.npmrc', '.netrc', '.pypirc',
    '.ssh', '.aws', '.config/gh', '.config/gcloud',
    '.claude/.credentials.json', '.claude/settings.local.json',
    '.codex/auth.json', '.pi/agent/auth.json',
  ]) {
    const candidate = path.join(cwd, relative);
    if (fs.existsSync(candidate)) candidates.push(candidate);
  }
  for (const candidate of [...new Set(candidates)]) {
    const stat = fs.lstatSync(candidate);
    if (stat.isDirectory()) args.push('--tmpfs', candidate);
    else args.push('--ro-bind', os.devNull, candidate);
  }
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
  const innerEnv = safeProductionEnv(options.env);
  const egressSocket = options.env.RORCA_AUTONOMOUS_EGRESS_SOCKET;
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

export function sanitizeAutonomousSandboxEnvForTests(input: Record<string, string>): Record<string, string> {
  return safeProductionEnv(input);
}

/** Build one launch that cannot see the trusted ancestor namespace/filesystem/network. */
export function prepareAutonomousSandboxLaunch(options: AutonomousSandboxOptions): AutonomousSandboxLaunch {
  const posture = configuredPosture();
  const cwd = fs.realpathSync(options.cwd);
  if (posture === 'local-dev') {
    if (process.env.NODE_ENV === 'production') throw new Error('local-dev autonomous isolation is forbidden in production');
    return { command: options.command, args: [...options.args], cwd, env: options.env, isolated: false };
  }
  if (process.platform !== 'linux') throw new Error('linux-bwrap autonomous isolation requires Linux');
  const roots = toolRoots();
  const executable = resolveExecutable(options.command, options.env, roots);
  const env = safeProductionEnv(options.env);
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

function assertLocalDevPosture(options: AutonomousBoundaryPreflightOptions, env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === 'production') {
    throw new Error('local-dev autonomous isolation is forbidden in production');
  }
  if (options.providerCapable || PROVIDER_AUTHORITY_KEYS.some(key => Boolean(env[key]))) {
    throw new Error('local-dev autonomous isolation cannot coexist with provider authority');
  }
}

function runBoundaryProbe(cwd: string, env: NodeJS.ProcessEnv): void {
  const marker = `rorca-ancestor-secret-${crypto.randomBytes(24).toString('hex')}`;
  const sentinelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sandbox-credential-'));
  const sentinel = path.join(sentinelRoot, 'credentials');
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sandbox-worktree-'));
  const workspaceCredential = path.join(probeRoot, '.env');
  fs.writeFileSync(sentinel, 'must-not-be-readable', { mode: 0o600 });
  fs.writeFileSync(workspaceCredential, marker, { mode: 0o600 });
  const script = String.raw`
const fs=require('fs'),net=require('net'),cp=require('child_process');
const marker=process.argv[1],sentinel=process.argv[2],workspaceCredential=process.argv[3],tools=JSON.parse(process.argv[4]);
for(const pid of fs.readdirSync('/proc').filter(v=>/^\d+$/.test(v))){try{if(fs.readFileSync('/proc/'+pid+'/environ').includes(marker))process.exit(41)}catch{}}
try{fs.readFileSync(sentinel);process.exit(42)}catch{}
try{if(fs.readFileSync(workspaceCredential).includes(marker))process.exit(45)}catch{}
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
    const launch = prepareAutonomousSandboxLaunch({
      command: node,
      args: ['-e', script, marker, sentinel, workspaceCredential, JSON.stringify(tools)],
      cwd: probeRoot,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });
    const result = spawnSync(launch.command, launch.args, {
      cwd: launch.cwd,
      env: { ...launch.env, RORCA_ANCESTOR_SECRET_PROBE: marker },
      encoding: 'utf8', timeout: 15_000,
    });
    if (result.status !== 0) {
      throw new Error(`autonomous sandbox capability probe failed (${result.status ?? result.signal ?? 'unknown'}): ${String(result.stderr ?? '').trim()}`);
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
  if (posture === 'local-dev') {
    assertLocalDevPosture(options, env);
    return;
  }
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

export function resetAutonomousSandboxProbeForTests(): void {
  successfulProbeKey = null;
}
