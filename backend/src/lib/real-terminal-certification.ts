/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Certification-only real Pi/OpenCode provider capture. No ordinary run imports this module. */

import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutonomousSandboxLaunch } from './autonomous-sandbox';
import { prepareAutonomousModelSandboxLaunch } from './autonomous-sandbox';
import {
  closeAutonomousModelEgress,
  createAutonomousModelEgressOperationIdentity,
  type AutonomousModelEgressOperationIdentity,
} from './autonomous-model-egress';
import { RELEASE_TERMINAL_RUNTIME, type ReleaseTerminalEngine } from './terminal-runtime-contract';

const CAPTURE_SCHEMA = 'rorca.real-terminal-captures.v1';
const GRANT_SCHEMA = 'rorca.provider-capture-grant.v1';
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_GRANT_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MODEL_CREDENTIAL_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
]);
const runtimeRequire = createRequire(
  typeof __filename === 'string' ? __filename : path.resolve(process.argv[1] ?? process.cwd()),
);

export interface ProviderCaptureEngineGrant {
  executable: string;
  version: string;
  provider: string;
  model: string;
  credentialEnv: string;
  expectedMarker: string;
  timeoutMs: number;
}

export interface ProviderCaptureGrant {
  schemaVersion: typeof GRANT_SCHEMA;
  purpose: 'rb02-real-terminal-certification';
  grantId: string;
  issuedAt: string;
  expiresAt: string;
  maxCostUsd: number;
  fixture: {
    identity: {
      platform: 'linux';
      architecture: string;
      kernel: string;
      resourceNonceSha256: string;
      sourceArchiveSha256: string;
      sourceArchiveCommit: string;
      sourceArchiveTree: string;
    };
    identitySha256: string;
  };
  credentialFileSha256: string;
  allowedHosts: string[];
  runtime: {
    isolation: 'linux-bwrap';
    bwrapPath: string;
    toolRoots: string[];
  };
  engines: Record<ReleaseTerminalEngine, ProviderCaptureEngineGrant>;
}

interface PtyProcessLike {
  onData(callback: (data: string) => void): { dispose(): void } | void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } | void;
  kill(signal?: string): void;
}

export interface RealTerminalCaptureDependencies {
  now(): Date;
  platformIdentity(): { platform: NodeJS.Platform; architecture: string; kernel: string };
  probeVersion(executable: string, env: Record<string, string>): string;
  prepareLaunch(options: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: Record<string, string>;
    modelEgressIdentity: AutonomousModelEgressOperationIdentity;
  }): Promise<AutonomousSandboxLaunch & { modelEgressSocket?: string }>;
  spawnPty(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; cols: number; rows: number; name: string },
  ): PtyProcessLike;
  closeBroker(identity: AutonomousModelEgressOperationIdentity): Promise<void>;
}

export interface RealTerminalCaptureOptions {
  sourceRoot: string;
  outputDir: string;
  grantFile: string;
  credentialFile: string;
}

interface EvidenceRef {
  path: string;
  sha256: string;
  bytes: number;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map(key => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function extractSemver(value: string): string | null {
  return value.match(/(?:^|\D)(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\D|$)/)?.[1] ?? null;
}

function within(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveNewPathThroughExistingParent(candidate: string): string {
  let current = path.resolve(candidate);
  const missing: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

function ambientCredentialDirectories(): string[] {
  const home = fs.realpathSync(os.homedir());
  return [
    '.pi',
    '.ssh',
    '.aws',
    '.azure',
    '.config/gcloud',
    '.config/gh',
    '.config/opencode',
    '.local/share/opencode',
    '.cache/opencode',
  ].map(relative => path.join(home, relative));
}

function readExplicitMode0600File(file: string, label: string): { path: string; bytes: Buffer } {
  if (!path.isAbsolute(file)) throw new Error(`${label} must be an explicit absolute path`);
  const requested = path.resolve(file);
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`${label} must be mode 0600`);
  if (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) {
    throw new Error(`${label} must be owned by the capture process user`);
  }
  const real = fs.realpathSync(requested);
  if (ambientCredentialDirectories().some(directory => within(real, directory))) {
    throw new Error(`${label} may not come from an ambient credential directory`);
  }
  return { path: real, bytes: fs.readFileSync(real) };
}

function assertExactPublicHost(host: string): void {
  if (host !== host.toLowerCase()
    || host === 'localhost'
    || host.includes('*')
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z0-9][a-z0-9-]{0,62}$/.test(host)) {
    throw new Error(`Capture grant host is not an exact public DNS name: ${host}`);
  }
}

function validateEngineGrant(engine: ReleaseTerminalEngine, value: unknown): ProviderCaptureEngineGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Capture grant is missing ${engine}`);
  const entry = value as Record<string, unknown>;
  if ('skip' in entry || 'skipped' in entry) throw new Error(`Capture grant may not skip ${engine}`);
  const expectedVersion = RELEASE_TERMINAL_RUNTIME[engine].version;
  if (entry.version !== expectedVersion) throw new Error(`${engine} grant version must equal shipped ${expectedVersion}`);
  if (typeof entry.executable !== 'string' || !path.isAbsolute(entry.executable)) throw new Error(`${engine} executable must be absolute`);
  if (typeof entry.provider !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(entry.provider)) throw new Error(`${engine} provider authority is missing or invalid`);
  if (typeof entry.model !== 'string' || entry.model.length < 2 || entry.model.length > 160 || /\s/.test(entry.model)
    || (entry.model.includes('/') && !entry.model.startsWith(`${entry.provider}/`))) {
    throw new Error(`${engine} model authority is missing, invalid, or inconsistent with its provider`);
  }
  if (typeof entry.credentialEnv !== 'string' || !MODEL_CREDENTIAL_KEYS.has(entry.credentialEnv)) throw new Error(`${engine} credential environment is not allowed`);
  if (typeof entry.expectedMarker !== 'string' || !/^RORCA_RB02_[A-Z0-9_]{12,96}$/.test(entry.expectedMarker)) throw new Error(`${engine} expected response marker is invalid`);
  if (!Number.isSafeInteger(entry.timeoutMs) || Number(entry.timeoutMs) < 1_000 || Number(entry.timeoutMs) > 600_000) throw new Error(`${engine} capture timeout is invalid`);
  return entry as unknown as ProviderCaptureEngineGrant;
}

function validateGrant(value: unknown, now: Date): ProviderCaptureGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provider capture grant must be an object');
  const grant = value as Record<string, unknown>;
  if (grant.schemaVersion !== GRANT_SCHEMA || grant.purpose !== 'rb02-real-terminal-certification') throw new Error('Provider capture grant schema/purpose is invalid');
  if (typeof grant.grantId !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(grant.grantId)) throw new Error('Provider capture grant ID is invalid');
  const issuedAt = Date.parse(String(grant.issuedAt ?? ''));
  const expiresAt = Date.parse(String(grant.expiresAt ?? ''));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_GRANT_LIFETIME_MS || now.getTime() < issuedAt || now.getTime() >= expiresAt) {
    throw new Error('Provider capture grant is not currently valid and time-bounded to 24 hours');
  }
  if (typeof grant.maxCostUsd !== 'number' || !Number.isFinite(grant.maxCostUsd)
    || grant.maxCostUsd <= 0 || grant.maxCostUsd > 100) throw new Error('Provider capture grant cost budget is invalid');
  if (!isSha256(grant.credentialFileSha256)) throw new Error('Provider capture grant credential hash is invalid');
  const fixture = grant.fixture as Record<string, unknown> | undefined;
  const fixtureIdentity = fixture?.identity as Record<string, unknown> | undefined;
  if (!fixture || !fixtureIdentity || fixtureIdentity.platform !== 'linux'
    || typeof fixtureIdentity.architecture !== 'string' || !fixtureIdentity.architecture
    || typeof fixtureIdentity.kernel !== 'string' || !fixtureIdentity.kernel
    || !isSha256(fixtureIdentity.resourceNonceSha256)
    || !isSha256(fixtureIdentity.sourceArchiveSha256)
    || typeof fixtureIdentity.sourceArchiveCommit !== 'string'
    || typeof fixtureIdentity.sourceArchiveTree !== 'string'
    || !isSha256(fixture.identitySha256)
    || sha256(canonicalJson(fixtureIdentity)) !== fixture.identitySha256) {
    throw new Error('Provider capture grant fixture identity is invalid');
  }
  if (!Array.isArray(grant.allowedHosts) || grant.allowedHosts.length === 0 || grant.allowedHosts.length > 32
    || !grant.allowedHosts.every(host => typeof host === 'string')) throw new Error('Provider capture grant requires exact hosts');
  const hosts = [...new Set(grant.allowedHosts as string[])].sort();
  if (hosts.length !== grant.allowedHosts.length) throw new Error('Provider capture grant hosts must be unique');
  hosts.forEach(assertExactPublicHost);
  const runtime = grant.runtime as Record<string, unknown> | undefined;
  if (!runtime || runtime.isolation !== 'linux-bwrap' || typeof runtime.bwrapPath !== 'string'
    || !path.isAbsolute(runtime.bwrapPath) || !Array.isArray(runtime.toolRoots) || runtime.toolRoots.length === 0
    || !runtime.toolRoots.every(root => typeof root === 'string' && path.isAbsolute(root))) {
    throw new Error('Provider capture grant requires explicit linux-bwrap runtime authority');
  }
  const engines = grant.engines as Record<string, unknown> | undefined;
  const pi = validateEngineGrant('pi', engines?.pi);
  const opencode = validateEngineGrant('opencode', engines?.opencode);
  if (pi.expectedMarker === opencode.expectedMarker) {
    throw new Error('Pi and OpenCode require distinct semantic response markers');
  }
  return {
    ...(grant as unknown as ProviderCaptureGrant),
    allowedHosts: hosts,
    runtime: { isolation: 'linux-bwrap', bwrapPath: runtime.bwrapPath, toolRoots: [...new Set(runtime.toolRoots as string[])].sort() },
    engines: { pi, opencode },
  };
}

function parseCredentials(bytes: Buffer, requiredKeys: Set<string>): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const raw of bytes.toString('utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('Credential file contains an invalid line');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!requiredKeys.has(key) || key in credentials) throw new Error(`Credential file contains an unauthorized or duplicate key: ${key}`);
    if (value.length < 8 || /[\r\n\0]/.test(value)) throw new Error(`Credential ${key} is missing or invalid`);
    credentials[key] = value;
  }
  for (const key of requiredKeys) if (!credentials[key]) throw new Error(`Credential file is missing ${key}`);
  return credentials;
}

function realExecutable(file: string, engine: ReleaseTerminalEngine): string {
  let real: string;
  try { real = fs.realpathSync(file); } catch { throw new Error(`${engine} executable is missing`); }
  const stat = fs.statSync(real);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error(`${engine} executable is not executable`);
  if (ambientCredentialDirectories().some(directory => within(real, directory))) throw new Error(`${engine} executable may not resolve through an ambient credential directory`);
  return real;
}

function captureArgs(engine: ReleaseTerminalEngine, grant: ProviderCaptureEngineGrant): string[] {
  if (engine === 'pi') {
    return [
      '--mode', 'json',
      '--no-session',
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
      '--no-approve', '--no-tools',
      '--provider', grant.provider,
      '--model', grant.model,
      `Reply with exactly ${grant.expectedMarker} and no other text.`,
    ];
  }
  const model = grant.model.includes('/') ? grant.model : `${grant.provider}/${grant.model}`;
  return [
    'run', '--format', 'json', '--model', model,
    `Reply with exactly ${grant.expectedMarker} and no other text.`,
  ];
}

function cleanTerminalText(raw: Buffer): string {
  return raw.toString('utf8')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function assistantTextFromEvent(event: unknown): string[] {
  if (!event || typeof event !== 'object') return [];
  const value = event as Record<string, unknown>;
  const type = String(value.type ?? '');
  const parts: string[] = [];
  const message = value.message as Record<string, unknown> | undefined;
  if (message?.role === 'assistant') parts.push(...assistantContent(message.content));
  if (type === 'message_update') {
    const update = value.assistantMessageEvent as Record<string, unknown> | undefined;
    if (update?.type === 'text_delta' && typeof update.delta === 'string') parts.push(update.delta);
  }
  if (type === 'assistant') {
    if (typeof value.content === 'string') parts.push(value.content);
    parts.push(...assistantContent(value.content));
  }
  if (type === 'text') {
    const part = value.part as Record<string, unknown> | undefined;
    if (typeof part?.text === 'string') parts.push(part.text);
  }
  if (type === 'completion' && typeof value.content === 'string') parts.push(value.content);
  return parts;
}

function assistantContent(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const block = item as Record<string, unknown>;
    return (block.type === 'text' || block.type === 'output_text') && typeof block.text === 'string' ? [block.text] : [];
  });
}

function assertSemanticProviderResponse(
  engine: ReleaseTerminalEngine,
  raw: Buffer,
  marker: string,
): { assistantEventCount: number; responseMarker: string; responseMarkerSha256: string } {
  const lines = cleanTerminalText(raw).split('\n').map(line => line.trim()).filter(Boolean);
  const events: unknown[] = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* terminal banners are not provider evidence */ }
  }
  if (events.length === 0) throw new Error(`${engine} capture has no JSON provider events`);
  const assistantEvents = events.map(assistantTextFromEvent).filter(parts => parts.length > 0);
  const assistantText = assistantEvents.flat().join('');
  if (!assistantText.includes(marker) || assistantText.replaceAll(marker, '').trim()) {
    throw new Error(`${engine} capture lacks an exact approved semantic response marker`);
  }
  return {
    assistantEventCount: assistantEvents.length,
    responseMarker: marker,
    responseMarkerSha256: sha256(marker),
  };
}

function normalizeTranscript(raw: Buffer, workspace: string): Buffer {
  const volatileKeys = /^(?:id|session_?id|timestamp|started_?at|finished_?at|duration_?ms|wallClockMs|input_?tokens|output_?tokens|reasoning_?tokens|cost(?:Usd|_usd))$/i;
  const normalized = cleanTerminalText(raw).split('\n').map(line => {
    const trimmed = line.trimEnd();
    if (!trimmed.trim()) return '';
    try {
      const redact = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === 'object') {
          return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
            key,
            volatileKeys.test(key) ? `<${key}>` : redact(child),
          ]));
        }
        if (typeof value === 'string') return value.replaceAll(workspace, '<capture-workspace>');
        return value;
      };
      return canonicalJson(redact(JSON.parse(trimmed)));
    } catch {
      return trimmed.replaceAll(workspace, '<capture-workspace>');
    }
  }).join('\n').trimEnd();
  return Buffer.from(`${normalized}\n`, 'utf8');
}

function assertNoCredentialLeak(bytes: Buffer, credentials: Record<string, string>): void {
  const text = bytes.toString('utf8');
  for (const value of Object.values(credentials)) {
    if (text.includes(value)) throw new Error('Provider credential appeared in terminal capture');
  }
}

function writePrivateFile(root: string, relative: string, bytes: Buffer): EvidenceRef {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolute, bytes, { mode: 0o600, flag: 'wx' });
  return { path: relative.replaceAll(path.sep, '/'), sha256: sha256(bytes), bytes: bytes.length };
}

function writePrivateJson(root: string, relative: string, value: unknown): EvidenceRef {
  return writePrivateFile(root, relative, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

async function capturePty(
  dependencies: RealTerminalCaptureDependencies,
  launch: AutonomousSandboxLaunch,
  timeoutMs: number,
): Promise<{ raw: Buffer; exitCode: number; signal: number | null }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const pty = dependencies.spawnPty(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      cols: RELEASE_TERMINAL_RUNTIME.terminal.cols,
      rows: RELEASE_TERMINAL_RUNTIME.terminal.rows,
      name: 'xterm-256color',
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { pty.kill('SIGKILL'); } catch { /* already exited */ }
      reject(new Error(`Provider capture timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pty.onData(data => {
      if (settled) return;
      const chunk = Buffer.from(data, 'utf8');
      bytes += chunk.length;
      if (bytes > MAX_CAPTURE_BYTES) {
        settled = true;
        clearTimeout(timer);
        try { pty.kill('SIGKILL'); } catch { /* already exited */ }
        reject(new Error('Provider capture exceeded the raw transcript limit'));
        return;
      }
      chunks.push(chunk);
    });
    pty.onExit(event => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ raw: Buffer.concat(chunks), exitCode: event.exitCode, signal: event.signal ?? null });
    });
  });
}

function defaultDependencies(): RealTerminalCaptureDependencies {
  return {
    now: () => new Date(),
    platformIdentity: () => ({ platform: process.platform, architecture: process.arch, kernel: os.release() }),
    probeVersion: (executable, env) => {
      const result = spawnSync(executable, ['--version'], { encoding: 'utf8', env, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
      if (result.status !== 0 || result.signal || result.error) throw new Error('Executable version probe failed');
      return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    },
    prepareLaunch: options => prepareAutonomousModelSandboxLaunch(options),
    spawnPty: (command, args, options) => {
      const nodePty = runtimeRequire('node-pty') as { spawn: typeof import('node-pty').spawn };
      return nodePty.spawn(command, args, options);
    },
    closeBroker: identity => closeAutonomousModelEgress(identity),
  };
}

function sourceIdentity(root: string): { head: string; tree: string } {
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  }).trim();
  if (git('status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Real provider capture requires a clean exact source tree');
  return { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

/**
 * Execute both real captures sequentially. The only credential read is the
 * separately supplied mode-0600 file bound by the explicit grant hash.
 */
export async function runRealTerminalCertificationCapture(
  options: RealTerminalCaptureOptions,
  overrides: Partial<RealTerminalCaptureDependencies> = {},
): Promise<Record<string, unknown>> {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const sourceRoot = fs.realpathSync(options.sourceRoot);
  const outputDir = resolveNewPathThroughExistingParent(options.outputDir);
  if (fs.existsSync(outputDir)) throw new Error('Capture output directory must be new and non-reused');
  if (within(outputDir, sourceRoot)) throw new Error('Capture output must be outside the source repository');

  const grantFile = readExplicitMode0600File(options.grantFile, 'Provider capture grant');
  const credentialFile = readExplicitMode0600File(options.credentialFile, 'Provider credential file');
  const grant = validateGrant(JSON.parse(grantFile.bytes.toString('utf8')), dependencies.now());
  const platformIdentity = dependencies.platformIdentity();
  if (platformIdentity.platform !== grant.fixture.identity.platform
    || platformIdentity.architecture !== grant.fixture.identity.architecture
    || platformIdentity.kernel !== grant.fixture.identity.kernel) {
    throw new Error('Provider capture grant fixture does not bind the executing Linux platform');
  }
  if (sha256(credentialFile.bytes) !== grant.credentialFileSha256) throw new Error('Provider credential file hash does not match the scoped grant');
  const requiredCredentialKeys = new Set(Object.values(grant.engines).map(engine => engine.credentialEnv));
  const credentials = parseCredentials(credentialFile.bytes, requiredCredentialKeys);
  const source = sourceIdentity(sourceRoot);
  if (grant.fixture.identity.sourceArchiveCommit !== source.head
    || grant.fixture.identity.sourceArchiveTree !== source.tree) {
    throw new Error('Provider capture grant fixture does not bind the exact current source');
  }
  const observedAt = dependencies.now().toISOString();

  fs.mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  fs.chmodSync(outputDir, 0o700);
  const workspaceRoot = path.join(outputDir, 'capture-workspaces');
  fs.mkdirSync(workspaceRoot, { mode: 0o700 });
  const fixtureReadme = Buffer.from('RB-02 provider capture fixture. No tools, files, or repository credentials are available.\n');

  const fixtureIdentity = grant.fixture.identity;
  const fixtureIdentitySha256 = grant.fixture.identitySha256;
  const captureIdentity = {
    fixtureIdentitySha256,
    source,
    geometry: RELEASE_TERMINAL_RUNTIME.terminal,
    workspaceSeedSha256: sha256(fixtureReadme),
  };
  const captureIdentitySha256 = sha256(canonicalJson(captureIdentity));
  const policy = {
    mode: 'exact-host-unix-socket-connect',
    transport: 'unix-socket',
    connectPort: 443,
    allowedHosts: grant.allowedHosts,
    noAmbientCredentialDirectories: true,
  } as const;
  const policySha256 = sha256(canonicalJson(policy));
  const grantAuthoritySha256 = sha256(grantFile.bytes);
  const egressIdentity = createAutonomousModelEgressOperationIdentity({
    purpose: 'rb02-real-terminal-certification',
    captureIdentitySha256,
    grantAuthoritySha256,
    policySha256,
    engines: ['pi', 'opencode'],
  });
  const captures: Record<string, unknown> = {};
  const originalRuntimeEnv = Object.fromEntries([
    'RORCA_AUTONOMOUS_ISOLATION',
    'RORCA_BWRAP_BIN',
    'RORCA_AUTONOMOUS_TOOL_ROOTS',
    'RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS',
    'RORCA_AUTONOMOUS_EGRESS_SOCKET',
  ].map(key => [key, process.env[key]]));
  let brokerSocket: string | null = null;
  let brokerInstanceSha256: string | null = null;
  let brokerClosed = false;
  let workspaceRemoved = false;

  try {
    if (process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET) throw new Error('Capture refuses an ambient/inherited egress socket');
    process.env.RORCA_AUTONOMOUS_ISOLATION = 'linux-bwrap';
    process.env.RORCA_BWRAP_BIN = grant.runtime.bwrapPath;
    process.env.RORCA_AUTONOMOUS_TOOL_ROOTS = grant.runtime.toolRoots.join(':');
    process.env.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS = grant.allowedHosts.join(',');

    for (const engine of ['pi', 'opencode'] as const) {
      if (dependencies.now().getTime() >= Date.parse(grant.expiresAt)) throw new Error('Provider capture grant expired before all engines completed');
      const engineGrant = grant.engines[engine];
      const executable = realExecutable(engineGrant.executable, engine);
      const workspace = path.join(workspaceRoot, engine);
      fs.mkdirSync(workspace, { mode: 0o700 });
      fs.writeFileSync(path.join(workspace, 'README.txt'), fixtureReadme, { mode: 0o600, flag: 'wx' });
      const versionEnv = {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: workspace,
        XDG_CONFIG_HOME: path.join(workspace, '.config'),
        XDG_CACHE_HOME: path.join(workspace, '.cache'),
      };
      const observedVersion = extractSemver(dependencies.probeVersion(executable, versionEnv));
      if (observedVersion !== engineGrant.version) throw new Error(`${engine} version mismatch: expected ${engineGrant.version}, observed ${observedVersion ?? 'unknown'}`);
      const executableStat = fs.statSync(executable);
      const executableBytes = fs.readFileSync(executable);
      const executableSha256 = sha256(executableBytes);
      const args = captureArgs(engine, engineGrant);
      const launch = await dependencies.prepareLaunch({
        command: executable,
        args,
        cwd: workspace,
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          TERM: 'xterm-256color',
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
          OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
          [engineGrant.credentialEnv]: credentials[engineGrant.credentialEnv],
        },
        modelEgressIdentity: egressIdentity,
      });
      brokerSocket = launch.modelEgressSocket ?? process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET ?? null;
      const brokerStat = brokerSocket ? fs.statSync(brokerSocket) : null;
      if (!brokerSocket || !brokerStat?.isSocket() || !launch.isolated
        || !launch.args.includes('/run/rorca-egress/proxy.sock')
        || !launch.args.some(value => value === 'http://127.0.0.1:3128')) {
        throw new Error(`${engine} launch did not traverse the exact Unix-socket CONNECT broker`);
      }
      const observedBrokerInstance = sha256(canonicalJson({
        captureIdentitySha256,
        device: String(brokerStat.dev),
        inode: String(brokerStat.ino),
        policySha256,
      }));
      if (brokerInstanceSha256 && brokerInstanceSha256 !== observedBrokerInstance) {
        throw new Error('Pi and OpenCode did not traverse the same Unix-socket CONNECT broker instance');
      }
      brokerInstanceSha256 = observedBrokerInstance;

      const result = await capturePty(dependencies, launch, engineGrant.timeoutMs);
      if (result.exitCode !== 0 || result.signal !== null) throw new Error(`${engine} capture exited non-zero`);
      const finalExecutableStat = fs.statSync(executable);
      if (finalExecutableStat.dev !== executableStat.dev || finalExecutableStat.ino !== executableStat.ino
        || finalExecutableStat.size !== executableStat.size || sha256(fs.readFileSync(executable)) !== executableSha256) {
        throw new Error(`${engine} executable identity changed during capture`);
      }
      if (result.raw.length === 0) throw new Error(`${engine} raw transcript is missing`);
      assertNoCredentialLeak(result.raw, credentials);
      const semantic = assertSemanticProviderResponse(engine, result.raw, engineGrant.expectedMarker);
      const normalized = normalizeTranscript(result.raw, workspace);
      if (normalized.length === 0) throw new Error(`${engine} normalized transcript is missing`);

      const rawTranscript = writePrivateFile(outputDir, `${engine}/raw-transcript.bin`, result.raw);
      const normalizedTranscript = writePrivateFile(outputDir, `${engine}/normalized-transcript.jsonl`, normalized);
      const versionEvidence = writePrivateJson(outputDir, `${engine}/executable.json`, {
        engine,
        version: observedVersion,
        executableSha256,
      });
      fs.rmSync(workspace, { recursive: true, force: true });
      const engineWorkspaceRemoved = !fs.existsSync(workspace);
      if (!engineWorkspaceRemoved) throw new Error(`${engine} capture workspace teardown was not proven`);
      captures[engine] = {
        status: 'passed',
        actual: true,
        skipped: 0,
        engine,
        executable: { version: observedVersion, sha256: executableSha256 },
        provider: engineGrant.provider,
        model: engineGrant.model,
        terminal: RELEASE_TERMINAL_RUNTIME.terminal,
        fixtureIdentitySha256,
        grant: {
          grantId: grant.grantId,
          authoritySha256: grantAuthoritySha256,
          issuedAt: grant.issuedAt,
          expiresAt: grant.expiresAt,
          maxCostUsd: grant.maxCostUsd,
        },
        brokerPolicySha256: policySha256,
        brokerInstanceSha256,
        semantic,
        rawTranscript,
        normalizedTranscript,
        engineWorkspaceRemoved,
        evidence: [versionEvidence],
      };
    }

    if (!brokerInstanceSha256) throw new Error('Unix-socket CONNECT broker instance was not captured');
    const brokerEvidence = writePrivateJson(outputDir, 'broker-policy.json', {
      ...policy,
      policySha256,
      brokerInstanceSha256,
      engines: ['pi', 'opencode'],
      isolated: true,
      rawSocketPathPersisted: false,
    });
    await dependencies.closeBroker(egressIdentity);
    brokerClosed = brokerSocket !== null && !fs.existsSync(brokerSocket);
    if (!brokerClosed) throw new Error('Unix-socket CONNECT broker teardown was not proven');
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRemoved = !fs.existsSync(workspaceRoot);
    if (!workspaceRemoved) throw new Error('Capture workspace teardown was not proven');
    const teardownEvidence = writePrivateJson(outputDir, 'teardown.json', {
      status: 'passed', actual: true, skipped: 0, brokerClosed, workspaceRemoved,
    });
    const finalSource = sourceIdentity(sourceRoot);
    if (finalSource.head !== source.head || finalSource.tree !== source.tree) {
      throw new Error('Source identity changed during real provider capture');
    }

    const artifact = {
      schemaVersion: CAPTURE_SCHEMA,
      status: 'passed',
      actual: true,
      skipped: 0,
      observedAt,
      source,
      fixture: {
        identity: fixtureIdentity,
        identitySha256: fixtureIdentitySha256,
        captureIdentity,
        captureIdentitySha256,
      },
      networkPolicy: { ...policy, policySha256, brokerInstanceSha256, evidence: brokerEvidence },
      captures,
      teardown: { status: 'passed', actual: true, skipped: 0, evidence: teardownEvidence },
    };
    writePrivateJson(outputDir, 'terminal-captures.json', artifact);
    return artifact;
  } catch (error) {
    try { await dependencies.closeBroker(egressIdentity); } catch { /* preserve primary failure */ }
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* preserve primary failure */ }
    const message = error instanceof Error ? error.message : String(error);
    try {
      writePrivateJson(outputDir, 'capture-failure.json', {
        schemaVersion: 'rorca.real-terminal-capture-failure.v1',
        status: 'failed',
        actual: false,
        skipped: 0,
        message,
      });
    } catch { /* preserve primary failure */ }
    throw error;
  } finally {
    for (const [key, value] of Object.entries(originalRuntimeEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
