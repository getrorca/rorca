/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ValidationError } from './errors';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_TARGETS: Record<string, true> = {
  '/bin': true,
  '/lib': true,
  '/lib64': true,
  '/opt': true,
  '/usr': true,
};
const MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);

export interface ToolchainDescriptor {
  schemaVersion: 'rorca.pre-staging-toolchain.v1';
  mounts: Array<{ source: string; target: string }>;
  executables: Record<string, string>;
  dependencyBundles: Record<string, string>;
}

export interface QualificationSandboxIdentity {
  mode: 'linux-bwrap' | 'darwin-docker';
  bwrapPath?: string;
  dockerPath?: string;
  dockerImage?: string;
  sandboxDigest: `sha256:${string}`;
  toolchainRoot: string;
  toolchainDigest: `sha256:${string}`;
  dependencyRoot: string;
  dependencyDigest: `sha256:${string}`;
  descriptor: ToolchainDescriptor;
}

export interface QualificationSandboxLaunch {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

function hashBytes(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeRelative(value: string, label: string): string {
  if (!value || path.isAbsolute(value)) throw new ValidationError(`${label} must be relative`);
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new ValidationError(`${label} escaped its immutable root`);
  return normalized;
}

async function trustedPath(value: string, expected: 'file' | 'directory'): Promise<string> {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) throw new ValidationError(`Qualification ${expected} path must be normalized and absolute`);
  const real = await fs.realpath(value);
  if (real !== value) throw new ValidationError(`Qualification ${expected} path may not contain symlinks`);
  const stat = await fs.stat(real);
  if ((expected === 'file' && !stat.isFile()) || (expected === 'directory' && !stat.isDirectory())) {
    throw new ValidationError(`Qualification ${expected} path has the wrong type`);
  }
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new ValidationError(`Qualification ${expected} path must be root-owned and immutable`);
  }
  return real;
}

async function fileDigest(filename: string): Promise<`sha256:${string}`> {
  const handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return `sha256:${hash.digest('hex')}`;
  } finally {
    await handle.close();
  }
}

function parseDescriptor(raw: Buffer): ToolchainDescriptor {
  let value: unknown;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw new ValidationError('Qualification toolchain descriptor is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Qualification toolchain descriptor must be an object');
  const descriptor = value as Partial<ToolchainDescriptor>;
  if (descriptor.schemaVersion !== 'rorca.pre-staging-toolchain.v1'
    || !Array.isArray(descriptor.mounts)
    || !descriptor.executables || typeof descriptor.executables !== 'object' || Array.isArray(descriptor.executables)
    || !descriptor.dependencyBundles || typeof descriptor.dependencyBundles !== 'object' || Array.isArray(descriptor.dependencyBundles)) {
    throw new ValidationError('Qualification toolchain descriptor has an unsupported shape');
  }
  for (const mount of descriptor.mounts) {
    if (!mount || typeof mount.source !== 'string' || typeof mount.target !== 'string' || !SAFE_TARGETS[mount.target]) {
      throw new ValidationError('Qualification toolchain descriptor contains an unsafe mount');
    }
    safeRelative(mount.source, 'Qualification toolchain mount');
  }
  for (const [executable, target] of Object.entries(descriptor.executables)) {
    if (!/^[A-Za-z0-9._+-]+$/.test(executable) || typeof target !== 'string' || !path.posix.isAbsolute(target)) {
      throw new ValidationError('Qualification toolchain descriptor contains an unsafe executable');
    }
  }
  for (const [dependencyDigest, relativeRoot] of Object.entries(descriptor.dependencyBundles)) {
    if (!SHA256.test(dependencyDigest) || typeof relativeRoot !== 'string') throw new ValidationError('Qualification dependency bundle identity is invalid');
    safeRelative(relativeRoot, 'Qualification dependency bundle');
  }
  return descriptor as ToolchainDescriptor;
}

export async function qualificationDependencyDigest(
  checkoutRoot: string,
  discoveredPaths: readonly string[],
): Promise<`sha256:${string}`> {
  const root = await fs.realpath(checkoutRoot);
  const evidence = [...new Set(discoveredPaths)]
    .filter((value) => /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|pyproject\.toml|pytest\.ini|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum)$/.test(value))
    .sort();
  if (evidence.length === 0) throw new ValidationError('Qualification dependency identity cannot be established without a manifest or lockfile');
  const hash = createHash('sha256');
  hash.update('rorca.pre-staging-dependencies.v1\0');
  for (const relative of evidence) {
    const filename = path.resolve(root, safeRelative(relative, 'Qualification dependency evidence'));
    if (!contained(root, filename)) throw new ValidationError('Qualification dependency evidence escaped the checkout');
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new ValidationError('Qualification dependency evidence is not a bounded regular file');
    const canonical = await fs.realpath(filename);
    if (!contained(root, canonical)) throw new ValidationError('Qualification dependency evidence escaped the checkout');
    hash.update(relative); hash.update('\0'); hash.update(await fs.readFile(canonical)); hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}
export async function loadQualificationSandboxIdentity(input: {
  checkoutRoot: string;
  dependencyDigest: `sha256:${string}`;
  env?: NodeJS.ProcessEnv;
}): Promise<QualificationSandboxIdentity> {
  const env = input.env ?? process.env;
  let runtime: Pick<QualificationSandboxIdentity, 'mode' | 'bwrapPath' | 'dockerPath' | 'dockerImage' | 'sandboxDigest'>;
  if (process.platform === 'linux') {
    const bwrapPath = await trustedPath(String(env.RORCA_QUALIFICATION_BWRAP_BIN ?? ''), 'file');
    const expectedSandboxDigest = String(env.RORCA_QUALIFICATION_BWRAP_DIGEST ?? '');
    const sandboxDigest = await fileDigest(bwrapPath);
    if (!SHA256.test(expectedSandboxDigest) || sandboxDigest !== expectedSandboxDigest) throw new ValidationError('Qualification sandbox executable identity is missing or mismatched');
    runtime = { mode: 'linux-bwrap', bwrapPath, sandboxDigest };
  } else if (process.platform === 'darwin' || env.NODE_ENV === 'test') {
    const dockerPath = await trustedPath(String(env.RORCA_QUALIFICATION_DOCKER_BIN ?? ''), 'file');
    const dockerImage = String(env.RORCA_QUALIFICATION_DOCKER_IMAGE ?? '');
    if (!SHA256.test(dockerImage)) throw new ValidationError('Darwin qualification requires an immutable Docker image digest');
    const inspected = await execFileAsync(dockerPath, ['image', 'inspect', '--format', '{{json .RepoDigests}}', dockerImage], {
      encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 15_000, env: {},
    }).catch(() => { throw new ValidationError('Darwin qualification Docker image is unavailable or unverified'); });
    if (!inspected.stdout.includes(dockerImage)) throw new ValidationError('Darwin qualification Docker image digest is not locally verified');
    runtime = { mode: 'darwin-docker', dockerPath, dockerImage, sandboxDigest: dockerImage as `sha256:${string}` };
  } else {
    throw new ValidationError('Pre-staging qualification is unsupported without Linux bubblewrap or the Darwin Docker sandbox');
  }
  const toolchainRoot = await trustedPath(String(env.RORCA_QUALIFICATION_TOOLCHAIN_ROOT ?? ''), 'directory');
  const checkout = await fs.realpath(input.checkoutRoot);
  if (contained(checkout, toolchainRoot) || contained(toolchainRoot, checkout)) throw new ValidationError('Qualification toolchain overlaps the repository checkout');
  const descriptorPath = path.join(toolchainRoot, 'rorca-qualification-toolchain.json');
  const descriptorStat = await fs.lstat(descriptorPath);
  if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink() || descriptorStat.size > MAX_DESCRIPTOR_BYTES) throw new ValidationError('Qualification toolchain descriptor is not a bounded regular file');
  const descriptorRaw = await fs.readFile(descriptorPath);
  const toolchainDigest = hashBytes(descriptorRaw);
  if (!SHA256.test(String(env.RORCA_QUALIFICATION_TOOLCHAIN_DIGEST ?? '')) || toolchainDigest !== env.RORCA_QUALIFICATION_TOOLCHAIN_DIGEST) {
    throw new ValidationError('Qualification toolchain identity is missing or mismatched');
  }
  const descriptor = parseDescriptor(descriptorRaw);
  for (const mount of descriptor.mounts) {
    const source = await fs.realpath(path.join(toolchainRoot, safeRelative(mount.source, 'Qualification toolchain mount')));
    if (!contained(toolchainRoot, source)) throw new ValidationError('Qualification toolchain mount escaped its immutable root');
    const stat = await fs.stat(source);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new ValidationError('Qualification toolchain mount is mutable');
  }
  const dependencyRelative = descriptor.dependencyBundles[input.dependencyDigest];
  if (!dependencyRelative) throw new ValidationError('No immutable dependency bundle matches the checkout dependency identity');
  const dependencyRoot = await fs.realpath(path.join(toolchainRoot, safeRelative(dependencyRelative, 'Qualification dependency bundle')));
  if (!contained(toolchainRoot, dependencyRoot)) throw new ValidationError('Qualification dependency bundle escaped its toolchain');
  const dependencyStat = await fs.stat(dependencyRoot);
  if (!dependencyStat.isDirectory() || dependencyStat.uid !== 0 || (dependencyStat.mode & 0o022) !== 0) throw new ValidationError('Qualification dependency bundle is mutable');
  return { ...runtime, toolchainRoot, toolchainDigest, dependencyRoot, dependencyDigest: input.dependencyDigest, descriptor };
}

function sandboxPath(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  return relative === '' ? '/workspace' : `/workspace/${relative}`;
}

export async function buildQualificationSandboxLaunch(input: {
  identity: QualificationSandboxIdentity;
  checkoutRoot: string;
  cwd: string;
  executable: string;
  args: readonly string[];
}): Promise<QualificationSandboxLaunch> {
  const checkout = await fs.realpath(input.checkoutRoot);
  const cwd = await fs.realpath(input.cwd);
  if (!contained(checkout, cwd)) throw new ValidationError('Qualification cwd escaped the immutable checkout');
  const executable = input.identity.descriptor.executables[input.executable];
  if (!executable) throw new ValidationError(`Qualification executable is absent from the immutable toolchain: ${input.executable}`);
  if (input.identity.mode === 'darwin-docker') {
    if (!input.identity.dockerPath || !input.identity.dockerImage) throw new ValidationError('Darwin qualification Docker identity is incomplete');
    return {
      command: input.identity.dockerPath,
      args: [
        'run', '--rm', '--init', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '4g',
        '--user', '65534:65534', '--tmpfs', '/tmp:rw,noexec,nosuid,size=1g',
        '--mount', `type=bind,src=${checkout},dst=/workspace,readonly`,
        '--mount', `type=bind,src=${input.identity.dependencyRoot},dst=/dependencies,readonly`,
        '--workdir', sandboxPath(checkout, cwd), '--env', 'CI=1', '--env', 'NODE_ENV=test',
        input.identity.dockerImage, executable, ...input.args,
      ],
      cwd: checkout,
      env: {},
    };
  }
  if (!input.identity.bwrapPath) throw new ValidationError('Linux qualification bubblewrap identity is incomplete');
  const mounts: string[] = [];
  for (const mount of input.identity.descriptor.mounts) {
    mounts.push('--ro-bind', path.join(input.identity.toolchainRoot, mount.source), mount.target);
  }
  const dependencyMounts: string[] = [];
  const directories = new Set([checkout, cwd]);
  for (const directory of directories) {
    const relative = path.relative(checkout, directory);
    const source = path.join(input.identity.dependencyRoot, relative, 'node_modules');
    let canonical: string;
    try {
      canonical = await fs.realpath(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new ValidationError('Qualification dependency mount is invalid');
    }
    const stat = await fs.stat(canonical);
    if (!contained(input.identity.dependencyRoot, canonical) || !stat.isDirectory()
      || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw new ValidationError('Qualification dependency mount is invalid');
    dependencyMounts.push('--ro-bind', canonical, `${sandboxPath(checkout, directory)}/node_modules`);
  }
  return {
    command: input.identity.bwrapPath,
    args: [
      '--die-with-parent', '--new-session', '--unshare-all', '--uid', '65534', '--gid', '65534', '--cap-drop', 'ALL', '--clearenv',
      '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/workspace',
      ...mounts,
      '--ro-bind', checkout, '/workspace', ...dependencyMounts,
      '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8',
      '--setenv', 'CI', '1', '--setenv', 'NODE_ENV', 'test', '--setenv', 'NO_COLOR', '1',
      '--chdir', sandboxPath(checkout, cwd), '--', executable, ...input.args,
    ],
    cwd: checkout,
    env: {},
  };
}
