/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/** Trusted, exact-owner CONNECT brokers exposing only configured model API hosts. */

import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export type AutonomousModelEgressIsolation = 'linux-bwrap' | 'darwin-local-pi';

export interface AutonomousModelEgressRunIdentity {
  runId: number;
  /** Immutable dispatch/effective-options or governed-retry identity. */
  authorityHash: string;
}

export interface AutonomousModelEgressOperationIdentity {
  /** Host-generated, unguessable identity for one non-pipeline model operation. */
  readonly operationId: string;
  /** Immutable hash of the operation request plus its host-generated nonce. */
  readonly authorityHash: string;
}

export type AutonomousModelEgressIdentity =
  | AutonomousModelEgressRunIdentity
  | AutonomousModelEgressOperationIdentity;

export const AUTONOMOUS_EGRESS_RUN_ID_ENV = 'RORCA_AUTONOMOUS_EGRESS_RUN_ID';
export const AUTONOMOUS_EGRESS_OPERATION_ID_ENV = 'RORCA_AUTONOMOUS_EGRESS_OPERATION_ID';
export const AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV = 'RORCA_AUTONOMOUS_EGRESS_AUTHORITY_HASH';
export const AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV = 'RORCA_AUTONOMOUS_EGRESS_IDENTITY_HASH';
const EGRESS_ROOT_PREFIX = 'rorca-model-egress-run-';
const EGRESS_STAGING_ROOT_PREFIX = 'rorca-model-egress-stage-';
const METADATA_FILENAME = 'broker.json';
const LIFECYCLE_FILENAME = 'lifecycle.json';
const SOCKET_FILENAME = 'proxy.sock';
const METADATA_SCHEMA = 'rorca.autonomous-model-egress/v3';
const LIFECYCLE_SCHEMA = 'rorca.autonomous-model-egress-lifecycle/v1';

/**
 * Exact provider API authorities. Known providers do not inherit an ambient,
 * hand-maintained host list: a model selection itself defines its egress
 * policy. Unknown/custom providers still require explicit operator policy.
 */
const PROVIDER_EGRESS_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'openai-codex': ['auth.openai.com', 'chatgpt.com'],
  openai: ['api.openai.com'],
  deepseek: ['api.deepseek.com'],
  anthropic: ['api.anthropic.com'],
  openrouter: ['openrouter.ai'],
  google: ['generativelanguage.googleapis.com'],
});

function configuredHostList(value: string | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Resolve the least-privilege host set for one frozen run. A known provider
 * cannot accidentally use stale ambient policy; custom providers remain
 * operator-configured because their authority cannot be inferred safely.
 */
export function resolveModelEgressHosts(
  models: readonly (string | null | undefined)[],
  configuredHosts: string | undefined,
): string[] {
  const resolved = new Set<string>();
  let requiresConfiguredPolicy = false;

  for (const model of models) {
    if (!model) continue;
    const slash = model.indexOf('/');
    const provider = (slash === -1 ? model : model.slice(0, slash)).trim().toLowerCase();
    const hosts = PROVIDER_EGRESS_HOSTS[provider];
    if (!hosts) {
      requiresConfiguredPolicy = true;
      continue;
    }
    for (const host of hosts) resolved.add(host);
  }

  if (resolved.size === 0 || requiresConfiguredPolicy) {
    for (const host of configuredHostList(configuredHosts)) resolved.add(host);
  }

  return [...resolved].sort();
}
const PROCESS_INSTANCE_ID = crypto.randomBytes(32).toString('hex');
const PROCESS_START_IDENTITY = readProcessStartIdentity(process.pid);

interface BrokerMetadata {
  schemaVersion: typeof METADATA_SCHEMA;
  ownerType: 'run' | 'operation';
  runId?: number;
  operationId?: string;
  authorityHash: string;
  ownerIdentityHash: string;
  lifecycleHash: string;
  /** Binds immutable owner authority, exact host policy, isolation, and socket path. */
  identityHash: string;
  policyHash: string;
  isolation: AutonomousModelEgressIsolation;
  socketPath: string;
  allowedHosts: string[];
}

interface BrokerLifecycle {
  schemaVersion: typeof LIFECYCLE_SCHEMA;
  ownerPid: number;
  /** Kernel/host process-birth identity; prevents PID reuse from retaining stale roots. */
  ownerStartIdentity: string;
  processInstanceId: string;
  createdAt: string;
}

interface ActiveBroker {
  key: string;
  root: string;
  socketPath: string;
  metadata: BrokerMetadata;
  server: net.Server;
  clients: Set<net.Socket>;
}

const activeBrokers = new Map<string, ActiveBroker>();
const pendingBrokers = new Map<string, Promise<ActiveBroker>>();
const trustedOperationIdentities = new WeakSet<AutonomousModelEgressOperationIdentity>();
let exitCleanupRegistered = false;

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function isRunIdentity(identity: AutonomousModelEgressIdentity): identity is AutonomousModelEgressRunIdentity {
  return 'runId' in identity;
}

function canonicalIdentity(identity: AutonomousModelEgressIdentity): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(identity.authorityHash)) {
    throw new Error('Autonomous model egress requires an immutable sha256 authority hash');
  }
  if (isRunIdentity(identity)) {
    if (!Number.isSafeInteger(identity.runId) || identity.runId <= 0) {
      throw new Error('Autonomous model egress requires a valid immutable run id');
    }
    return `run\0${identity.runId}\0${identity.authorityHash}`;
  }
  if (!/^operation:[a-f0-9]{64}$/.test(identity.operationId)) {
    throw new Error('Autonomous model egress requires a valid immutable operation id');
  }
  if (!trustedOperationIdentities.has(identity)) {
    throw new Error('Autonomous model egress rejects caller-controlled operation identity');
  }
  return `operation\0${identity.operationId}\0${identity.authorityHash}`;
}

function ownerIdentityHash(identity: AutonomousModelEgressIdentity): string {
  return sha256(canonicalIdentity(identity));
}

function brokerIdentityHash(ownerHash: string, brokerPolicyHash: string, socketPath: string): string {
  return sha256(JSON.stringify({ ownerIdentityHash: ownerHash, policyHash: brokerPolicyHash, socketPath }));
}

/** Create one immutable host-owned identity; no ambient or process-global identity participates. */
export function createAutonomousModelEgressOperationIdentity(
  operationAuthority: unknown,
): AutonomousModelEgressOperationIdentity {
  const nonce = crypto.randomBytes(32).toString('hex');
  const operationId = `operation:${crypto.createHash('sha256').update(`operation-id\0${nonce}`).digest('hex')}`;
  const authorityHash = sha256(JSON.stringify({
    schemaVersion: 'rorca.autonomous-model-operation-authority/v1',
    operationId,
    nonce,
    operationAuthority,
  }));
  const identity = { operationId, authorityHash };
  trustedOperationIdentities.add(identity);
  return Object.freeze(identity);
}

function configuredHosts(env: NodeJS.ProcessEnv): Set<string> {
  const raw = String(env.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS ?? '').trim();
  if (!raw) throw new Error('RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS is required for isolated model execution');
  const hosts = raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (hosts.length === 0 || hosts.length > 32) throw new Error('Autonomous model egress host list is invalid');
  for (const host of hosts) {
    if (host === 'localhost' || host === 'github.com' || host.endsWith('.github.com')
      || host === 'githubusercontent.com' || host.endsWith('.githubusercontent.com')
      || net.isIP(host) !== 0 || host.includes('*')
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z0-9][a-z0-9-]{0,62}$/.test(host)) {
      throw new Error(`Autonomous model egress host is not an exact public DNS name: ${host}`);
    }
  }
  return new Set(hosts);
}

function policyHash(isolation: AutonomousModelEgressIsolation, allowed: Set<string>): string {
  return sha256(JSON.stringify({ isolation, allowedHosts: [...allowed].sort(), connectPort: 443 }));
}

function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19)));
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isPublicAddress(normalized.slice(7));
    return normalized !== '::' && normalized !== '::1'
      && !normalized.startsWith('fc') && !normalized.startsWith('fd')
      && !normalized.startsWith('fe8') && !normalized.startsWith('fe9')
      && !normalized.startsWith('fea') && !normalized.startsWith('feb')
      && !normalized.startsWith('ff');
  }
  return false;
}

function reject(socket: net.Socket, status = '403 Forbidden'): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

async function connectAllowed(socket: net.Socket, header: string, allowed: Set<string>): Promise<void> {
  const firstLine = header.split('\r\n', 1)[0] ?? '';
  const match = /^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\/1\.[01]$/i.exec(firstLine);
  if (!match) return reject(socket, '405 Method Not Allowed');
  const host = match[1].toLowerCase();
  const port = Number(match[2]);
  if (port !== 443 || !allowed.has(host)) return reject(socket);
  const resolved = await dns.lookup(host, { all: true, verbatim: true });
  const selected = resolved.find(candidate => isPublicAddress(candidate.address));
  if (!selected || resolved.some(candidate => !isPublicAddress(candidate.address))) return reject(socket);
  const upstream = net.connect({ host: selected.address, port, family: selected.family });
  upstream.setTimeout(15_000, () => upstream.destroy());
  upstream.once('connect', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.once('error', () => reject(socket, '502 Bad Gateway'));
  socket.once('close', () => upstream.destroy());
  socket.once('error', () => upstream.destroy());
}

function handle(socket: net.Socket, allowed: Set<string>): void {
  socket.setTimeout(15_000, () => socket.destroy());
  let bytes = 0;
  let header = '';
  const onData = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 16 * 1024) return reject(socket, '431 Request Header Fields Too Large');
    header += chunk.toString('latin1');
    const end = header.indexOf('\r\n\r\n');
    if (end < 0) return;
    socket.off('data', onData);
    const remainder = Buffer.from(header.slice(end + 4), 'latin1');
    void connectAllowed(socket, header.slice(0, end), allowed).then(() => {
      if (remainder.length > 0 && !socket.destroyed) socket.unshift(remainder);
    }).catch(() => reject(socket, '502 Bad Gateway'));
  };
  socket.on('data', onData);
}

function realTemporaryRoot(): string {
  return fs.realpathSync(os.tmpdir());
}

function assertPrivateTemporaryDirectory(root: string, prefix: string, label: string): string {
  if (!path.isAbsolute(root)) throw new Error(`Autonomous model egress ${label} must be absolute`);
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== realTemporaryRoot() || !path.basename(resolved).startsWith(prefix)) {
    throw new Error(`Autonomous model egress ${label} is outside its trusted temporary namespace`);
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Autonomous model egress ${label} is not a private non-symbolic directory`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`Autonomous model egress ${label} has an unexpected owner`);
  }
  if (fs.realpathSync(resolved) !== resolved) {
    throw new Error(`Autonomous model egress ${label} changed identity`);
  }
  return resolved;
}

function assertRunOwnedRoot(root: string): string {
  return assertPrivateTemporaryDirectory(root, EGRESS_ROOT_PREFIX, 'root');
}

function assertStagingRoot(root: string): string {
  return assertPrivateTemporaryDirectory(root, EGRESS_STAGING_ROOT_PREFIX, 'staging root');
}

function processStartIdentityDigest(identity: string): string {
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function stagingOwnerIsAlive(root: string): boolean {
  const match = /^rorca-model-egress-stage-([1-9][0-9]*)-([a-f0-9]{64})-([a-f0-9]{64})-[A-Za-z0-9]{6}$/
    .exec(path.basename(root));
  if (!match) return false;
  const ownerPid = Number(match[1]);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  const currentStartIdentity = readProcessStartIdentity(ownerPid);
  return currentStartIdentity !== null
    && processStartIdentityDigest(currentStartIdentity) === match[2];
}

function brokerLifecycleHash(lifecycle: BrokerLifecycle): string {
  return sha256(JSON.stringify(lifecycle));
}

function readProcessStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = stat.lastIndexOf(')');
      if (commandEnd < 0) return null;
      // Fields after the command begin at proc field 3; starttime is field 22.
      const startTicks = stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
      return /^\d+$/.test(startTicks ?? '') ? `linux-proc-start:${startTicks}` : null;
    }
    if (process.platform === 'darwin') {
      const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
      }).trim();
      return started ? `darwin-ps-start:${started}` : null;
    }
  } catch { /* absent or exited */ }
  return null;
}

function readLifecycle(root: string): BrokerLifecycle {
  const lifecyclePath = path.join(root, LIFECYCLE_FILENAME);
  const stat = fs.lstatSync(lifecyclePath);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error('Autonomous model egress lifecycle is not a private regular file');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Autonomous model egress lifecycle has an unexpected owner');
  }
  const lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, 'utf8')) as BrokerLifecycle;
  if (lifecycle.schemaVersion !== LIFECYCLE_SCHEMA
    || !Number.isSafeInteger(lifecycle.ownerPid) || lifecycle.ownerPid <= 0
    || typeof lifecycle.ownerStartIdentity !== 'string'
    || lifecycle.ownerStartIdentity.length < 3 || lifecycle.ownerStartIdentity.length > 256
    || !/^[a-f0-9]{64}$/.test(lifecycle.processInstanceId)
    || !Number.isFinite(Date.parse(lifecycle.createdAt))) {
    throw new Error('Autonomous model egress lifecycle is malformed');
  }
  return lifecycle;
}

function createLifecycle(root: string): BrokerLifecycle {
  if (!PROCESS_START_IDENTITY) {
    throw new Error('Autonomous model egress cannot establish immutable process lifecycle identity');
  }
  const lifecycle: BrokerLifecycle = {
    schemaVersion: LIFECYCLE_SCHEMA,
    ownerPid: process.pid,
    ownerStartIdentity: PROCESS_START_IDENTITY,
    processInstanceId: PROCESS_INSTANCE_ID,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(root, LIFECYCLE_FILENAME), `${JSON.stringify(lifecycle)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  return lifecycle;
}

function lifecycleOwnerIsAlive(lifecycle: BrokerLifecycle): boolean {
  try {
    process.kill(lifecycle.ownerPid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  return readProcessStartIdentity(lifecycle.ownerPid) === lifecycle.ownerStartIdentity;
}

function readMetadata(socket: string): BrokerMetadata {
  const root = assertRunOwnedRoot(path.dirname(path.resolve(socket)));
  if (path.resolve(socket) !== path.join(root, SOCKET_FILENAME)) {
    throw new Error('Autonomous model egress socket path is not the exact run-owned endpoint');
  }
  const socketStat = fs.lstatSync(socket);
  if (socketStat.isSymbolicLink() || !socketStat.isSocket()) {
    throw new Error('Autonomous model egress endpoint is not a non-symbolic Unix socket');
  }
  const lifecycle = readLifecycle(root);
  const metadataPath = path.join(root, METADATA_FILENAME);
  const metadataStat = fs.lstatSync(metadataPath);
  if (metadataStat.isSymbolicLink() || !metadataStat.isFile() || (metadataStat.mode & 0o077) !== 0) {
    throw new Error('Autonomous model egress metadata is not a private regular file');
  }
  if (typeof process.getuid === 'function' && metadataStat.uid !== process.getuid()) {
    throw new Error('Autonomous model egress metadata has an unexpected owner');
  }
  const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as BrokerMetadata;
  if (parsed.schemaVersion !== METADATA_SCHEMA || parsed.socketPath !== socket
    || (parsed.ownerType !== 'run' && parsed.ownerType !== 'operation')
    || (parsed.ownerType === 'run' && (!Number.isSafeInteger(parsed.runId) || parsed.runId! <= 0 || parsed.operationId !== undefined))
    || (parsed.ownerType === 'operation' && (!parsed.operationId || !/^operation:[a-f0-9]{64}$/.test(parsed.operationId) || parsed.runId !== undefined))
    || !/^sha256:[a-f0-9]{64}$/.test(parsed.authorityHash)
    || !/^sha256:[a-f0-9]{64}$/.test(parsed.ownerIdentityHash)
    || parsed.lifecycleHash !== brokerLifecycleHash(lifecycle)
    || !/^sha256:[a-f0-9]{64}$/.test(parsed.identityHash)
    || !/^sha256:[a-f0-9]{64}$/.test(parsed.policyHash)
    || parsed.identityHash !== brokerIdentityHash(parsed.ownerIdentityHash, parsed.policyHash, parsed.socketPath)
    || (parsed.isolation !== 'linux-bwrap' && parsed.isolation !== 'darwin-local-pi')
    || !Array.isArray(parsed.allowedHosts)) {
    throw new Error('Autonomous model egress metadata is malformed');
  }
  return parsed;
}

function identityFromEnv(env: NodeJS.ProcessEnv): AutonomousModelEgressRunIdentity | null {
  const runId = Number(env[AUTONOMOUS_EGRESS_RUN_ID_ENV]);
  const operationId = String(env[AUTONOMOUS_EGRESS_OPERATION_ID_ENV] ?? '');
  const authorityHash = String(env[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV] ?? '');
  if (Number.isSafeInteger(runId) && runId > 0 && !operationId && authorityHash) return { runId, authorityHash };
  // Operation ownership is never reconstructed from ambient or caller-provided
  // environment. Only an in-process host-generated capability can create,
  // replay, validate, or close an operation broker.
  return null;
}

function exportIdentity(env: NodeJS.ProcessEnv, metadata: BrokerMetadata): void {
  env.RORCA_AUTONOMOUS_EGRESS_SOCKET = metadata.socketPath;
  if (metadata.ownerType === 'run') {
    env[AUTONOMOUS_EGRESS_RUN_ID_ENV] = String(metadata.runId);
    delete env[AUTONOMOUS_EGRESS_OPERATION_ID_ENV];
  } else {
    env[AUTONOMOUS_EGRESS_OPERATION_ID_ENV] = metadata.operationId!;
    delete env[AUTONOMOUS_EGRESS_RUN_ID_ENV];
  }
  env[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV] = metadata.authorityHash;
  env[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV] = metadata.identityHash;
}

/** Validate that an inherited endpoint belongs to the exact immutable owner. */
export function assertAutonomousModelEgressBinding(
  env: NodeJS.ProcessEnv,
  expected: AutonomousModelEgressIdentity,
  expectedIsolation?: AutonomousModelEgressIsolation,
): string {
  canonicalIdentity(expected);
  const inherited = String(env.RORCA_AUTONOMOUS_EGRESS_SOCKET ?? '').trim();
  if (!inherited) throw new Error('Autonomous model egress endpoint is missing');
  const metadata = readMetadata(inherited);
  const expectedPolicy = policyHash(metadata.isolation, configuredHosts(env));
  const ownerMatches = isRunIdentity(expected)
    ? metadata.ownerType === 'run' && metadata.runId === expected.runId
    : metadata.ownerType === 'operation' && metadata.operationId === expected.operationId;
  const exportedOwnerMatches = isRunIdentity(expected)
    ? env[AUTONOMOUS_EGRESS_RUN_ID_ENV] === String(expected.runId)
      && !env[AUTONOMOUS_EGRESS_OPERATION_ID_ENV]
    : env[AUTONOMOUS_EGRESS_OPERATION_ID_ENV] === expected.operationId
      && !env[AUTONOMOUS_EGRESS_RUN_ID_ENV];
  if (!ownerMatches || !exportedOwnerMatches || metadata.authorityHash !== expected.authorityHash
    || metadata.ownerIdentityHash !== ownerIdentityHash(expected)
    || env[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV] !== metadata.identityHash
    || metadata.policyHash !== expectedPolicy
    || (expectedIsolation !== undefined && metadata.isolation !== expectedIsolation)) {
    throw new Error(`Autonomous model egress endpoint differs from immutable ${isRunIdentity(expected) ? 'run' : 'operation'} identity`);
  }
  return inherited;
}

/** Validate that an inherited endpoint belongs to the exact immutable run. */
export function assertAutonomousModelEgressRunBinding(
  env: NodeJS.ProcessEnv,
  expected: AutonomousModelEgressRunIdentity,
  expectedIsolation?: AutonomousModelEgressIsolation,
): string {
  return assertAutonomousModelEgressBinding(env, expected, expectedIsolation);
}

async function createBroker(
  env: NodeJS.ProcessEnv,
  isolation: AutonomousModelEgressIsolation,
  identity: AutonomousModelEgressIdentity,
  allowed: Set<string>,
): Promise<ActiveBroker> {
  const key = canonicalIdentity(identity);
  if (!PROCESS_START_IDENTITY) {
    throw new Error('Autonomous model egress cannot establish immutable process lifecycle identity');
  }
  const temporaryRoot = realTemporaryRoot();
  // Build lifecycle and metadata outside the worker-swept publication prefix.
  // The owner PID + process-birth digest also lets stale staging cleanup
  // distinguish a live creator before its lifecycle write from a dead owner.
  const stagingPrefix = `${EGRESS_STAGING_ROOT_PREFIX}${process.pid}-${processStartIdentityDigest(PROCESS_START_IDENTITY)}-${PROCESS_INSTANCE_ID}-`;
  const stagingRoot = fs.mkdtempSync(path.join(temporaryRoot, stagingPrefix));
  fs.chmodSync(stagingRoot, 0o700);
  const trustedStagingRoot = assertStagingRoot(stagingRoot);

  // Keep operation socket paths below Darwin's 104-char AF_UNIX sun_path
  // limit. The full run id (14 digits) plus the mkdtemp suffix can push the
  // final path over the bound when TMPDIR itself is deep (e.g. /private/var/
  // folders/...), so the root label keeps only the run id's trailing digits.
  // Preserve as much of mkdtemp's random suffix as that platform path budget
  // allows: operation roots retain the full six characters, while run roots
  // retain at least two beyond their unique run id.
  const rootLabel = isRunIdentity(identity) ? String(identity.runId).slice(-8) : 'op';
  const finalRootPrefix = `${EGRESS_ROOT_PREFIX}${rootLabel}-`;
  const suffixBudget = 104 - Buffer.byteLength(path.join(temporaryRoot, finalRootPrefix, SOCKET_FILENAME));
  const suffixLength = Math.min(6, suffixBudget);
  if (suffixLength < 2) {
    throw new Error('Autonomous model egress socket path exceeds Darwin AF_UNIX limit');
  }
  const finalRoot = path.join(
    temporaryRoot,
    `${finalRootPrefix}${path.basename(trustedStagingRoot).slice(-suffixLength)}`,
  );
  const candidate = path.join(finalRoot, SOCKET_FILENAME);
  const clients = new Set<net.Socket>();
  const server = net.createServer(client => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    handle(client, allowed);
  });
  let published = false;
  try {
    const lifecycle = createLifecycle(trustedStagingRoot);
    const metadata: BrokerMetadata = {
      schemaVersion: METADATA_SCHEMA,
      ownerType: isRunIdentity(identity) ? 'run' : 'operation',
      ...(isRunIdentity(identity) ? { runId: identity.runId } : { operationId: identity.operationId }),
      authorityHash: identity.authorityHash,
      ownerIdentityHash: ownerIdentityHash(identity),
      lifecycleHash: brokerLifecycleHash(lifecycle),
      policyHash: policyHash(isolation, allowed),
      isolation,
      socketPath: candidate,
      identityHash: '',
      allowedHosts: [...allowed].sort(),
    };
    metadata.identityHash = brokerIdentityHash(metadata.ownerIdentityHash, metadata.policyHash, metadata.socketPath);
    fs.writeFileSync(path.join(trustedStagingRoot, METADATA_FILENAME), `${JSON.stringify(metadata)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    if (fs.existsSync(finalRoot)) throw new Error('Autonomous model egress final root identity collided');
    fs.renameSync(trustedStagingRoot, finalRoot);
    published = true;
    const trustedRoot = assertRunOwnedRoot(finalRoot);

    // Bind only after publication. Every root visible to a concurrent final
    // sweep therefore already has a valid live lifecycle; a bind failure is
    // rolled back through the exact published root.
    await new Promise<void>((resolve, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(candidate, () => {
        server.off('error', rejectPromise);
        resolve();
      });
    });
    fs.chmodSync(candidate, 0o600);
    server.unref();
    const broker = { key, root: trustedRoot, socketPath: candidate, metadata, server, clients };
    activeBrokers.set(key, broker);
    exportIdentity(env, metadata);
    if (!exitCleanupRegistered) {
      exitCleanupRegistered = true;
      process.once('exit', () => {
        for (const active of activeBrokers.values()) {
          try { active.server.close(); } catch { /* exiting */ }
          try {
            const trustedRoot = assertRunOwnedRoot(active.root);
            fs.rmSync(trustedRoot, { recursive: true, force: true });
          } catch { /* never follow a substituted exit-cleanup target */ }
        }
      });
    }
    return broker;
  } catch (error) {
    try { server.close(); } catch { /* creation failed */ }
    try {
      const cleanupRoot = published
        ? assertRunOwnedRoot(finalRoot)
        : assertStagingRoot(trustedStagingRoot);
      fs.rmSync(cleanupRoot, { recursive: true, force: true });
    } catch { /* never follow a substituted creation-cleanup target */ }
    throw error;
  }
}

/**
 * Acquire the broker owned by one immutable run or trusted host operation.
 * Replays may observe the same active instance only when owner identity,
 * isolation, and host policy all match.
 */
export async function ensureAutonomousModelEgress(
  env: NodeJS.ProcessEnv = process.env,
  workerAuthorizedIsolation?: AutonomousModelEgressIsolation,
  explicitIdentity?: AutonomousModelEgressIdentity,
): Promise<string | null> {
  const isolation = workerAuthorizedIsolation ?? env.RORCA_AUTONOMOUS_ISOLATION;
  if (isolation !== 'linux-bwrap' && isolation !== 'darwin-local-pi') return null;
  if (isolation === 'darwin-local-pi' && workerAuthorizedIsolation !== 'darwin-local-pi') return null;
  const identity = explicitIdentity ?? identityFromEnv(env);
  if (!identity) throw new Error('Autonomous model egress requires exact run- or operation-owned identity');
  const key = canonicalIdentity(identity);
  const inherited = String(env.RORCA_AUTONOMOUS_EGRESS_SOCKET ?? '').trim();
  if (inherited) return assertAutonomousModelEgressBinding(env, identity, isolation);

  const allowed = configuredHosts(env);
  const expectedPolicyHash = policyHash(isolation, allowed);
  const active = activeBrokers.get(key);
  if (active) {
    if (active.metadata.policyHash !== expectedPolicyHash || active.metadata.isolation !== isolation) {
      throw new Error('Autonomous model egress replay attempted to reconfigure immutable owner policy');
    }
    exportIdentity(env, active.metadata);
    return active.socketPath;
  }
  let pending = pendingBrokers.get(key);
  if (!pending) {
    pending = createBroker(env, isolation, identity, allowed);
    pendingBrokers.set(key, pending);
  }
  const broker = await pending.finally(() => pendingBrokers.delete(key));
  if (broker.metadata.policyHash !== expectedPolicyHash || broker.metadata.isolation !== isolation) {
    throw new Error('Autonomous model egress concurrent replay attempted to reconfigure immutable owner policy');
  }
  exportIdentity(env, broker.metadata);
  return broker.socketPath;
}

async function closeBroker(broker: ActiveBroker): Promise<void> {
  if (activeBrokers.get(broker.key) !== broker) return;
  activeBrokers.delete(broker.key);
  for (const client of broker.clients) client.destroy();
  await new Promise<void>(resolve => {
    try { broker.server.close(() => resolve()); } catch { resolve(); }
  });
  try {
    const trustedRoot = assertRunOwnedRoot(broker.root);
    fs.rmSync(trustedRoot, { recursive: true, force: true });
  } catch {
    // Never follow or remove a substituted cleanup target.
  }
}

/** Close only the broker held by the exact immutable owner capability. */
export async function closeAutonomousModelEgress(identity: AutonomousModelEgressIdentity): Promise<void> {
  const broker = activeBrokers.get(canonicalIdentity(identity));
  if (broker) await closeBroker(broker);
}

/** Bounded test teardown; production callers cannot invoke global broker closure. */
export async function closeAutonomousModelEgressForTests(identity?: AutonomousModelEgressIdentity): Promise<void> {
  if (identity) return closeAutonomousModelEgress(identity);
  await Promise.all([...activeBrokers.values()].map(closeBroker));
}

/** Remove broker and staging roots left after a dead owner has been fenced and its children terminated. */
export function sweepStaleAutonomousModelEgressState(candidates?: readonly string[]): number {
  const temporaryRoot = realTemporaryRoot();
  const roots = candidates ?? fs.readdirSync(temporaryRoot)
    .filter(name => name.startsWith(EGRESS_ROOT_PREFIX) || name.startsWith(EGRESS_STAGING_ROOT_PREFIX))
    .map(name => path.join(temporaryRoot, name));
  const activeRoots = new Set([...activeBrokers.values()].map(broker => broker.root));
  let removed = 0;
  for (const candidate of roots) {
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== temporaryRoot || activeRoots.has(resolved)) continue;
    const basename = path.basename(resolved);
    if (basename.startsWith(EGRESS_STAGING_ROOT_PREFIX)) {
      try {
        const trustedStagingRoot = assertStagingRoot(resolved);
        // The root name binds process birth, so even the interval before the
        // lifecycle file exists cannot be mistaken for a dead creator.
        if (stagingOwnerIsAlive(trustedStagingRoot)) continue;
        fs.rmSync(trustedStagingRoot, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Never follow or recursively remove a substituted staging entry.
      }
      continue;
    }
    if (!basename.startsWith(EGRESS_ROOT_PREFIX)) continue;
    try {
      const trustedRoot = assertRunOwnedRoot(resolved);
      // Active brokers in another API/worker process are absent from this
      // process's map. Their immutable lifecycle protects them from a
      // concurrent startup sweep; dead/crashed owners remain removable.
      try {
        const lifecycle = readLifecycle(trustedRoot);
        if (lifecycleOwnerIsAlive(lifecycle)) continue;
      } catch {
        // Legacy/incomplete final roots have no live trusted lifecycle and are stale.
      }
      fs.rmSync(trustedRoot, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Never follow or recursively remove a substituted entry.
    }
  }
  return removed;
}
