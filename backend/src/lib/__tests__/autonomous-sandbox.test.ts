/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createAutonomousCommandGuard } from '../autonomous-command-guard';
import * as net from 'node:net';
import { promisify } from 'node:util';
import * as nodePty from 'node-pty';
import {
  AUTONOMOUS_GIT_STATE_ROOT_ENV,
  AUTONOMOUS_GIT_VIEW_ENV,
  assertAutonomousGitHostReconciliation,
  assertNoSharedGitHardlinkAliases,
  autonomousGitStateManifestForTests,
  createAutonomousGitState,
  createAutonomousGitView,
  removeAutonomousGitState,
  resolveReachableLocalGitObjectDirectories,
} from '../autonomous-git-state';
import {
  assertAutonomousExecutionBoundary,
  buildDarwinOrdinaryLocalPiSeatbeltProfile,
  buildLinuxSandboxArgumentsForTests,
  prepareAutonomousSandboxLaunch,
  createOrdinaryLocalPiRuntimeState,
  removeOrdinaryLocalPiRuntimeState,
  resetAutonomousSandboxProbeForTests,
  sweepStaleOrdinaryLocalPiRuntimeState,
  sanitizeAutonomousSandboxEnvForTests,
} from '../autonomous-sandbox';
import {
  closeAutonomousModelEgress,
  closeAutonomousModelEgressForTests,
  ensureAutonomousModelEgress,
  type AutonomousModelEgressRunIdentity,
} from '../autonomous-model-egress';
import {
  ORDINARY_LOCAL_PI_PROFILE_ENV,
  ORDINARY_LOCAL_PI_PROFILE_VERSION,
  serializeOrdinaryLocalPiRuntimeProfile,
} from '../ordinary-local-pi-profile';

function git(cwd: string, ...args: string[]): string {
  // Qualification may itself run with a parent worktree's private Git view.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env[AUTONOMOUS_GIT_VIEW_ENV];
  return execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
}

function fixture(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sandbox-test-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'sandbox@rorca.invalid');
  git(cwd, 'config', 'user.name', 'Sandbox Test');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"scripts":{"probe":"node --version"}}\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'fixture');
  return cwd;
}

interface AlternateChainFixture {
  root: string;
  cwd: string;
  requiredCommit: string;
  objectDirs: string[];
  deepestObject: string;
}

function alternateChainFixture(): AlternateChainFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-alternate-chain-'));
  const source = path.join(root, 'source');
  const middle = path.join(root, 'middle');
  const cwd = path.join(root, 'worktree');
  for (const repository of [source, middle, cwd]) fs.mkdirSync(repository);

  git(source, 'init', '-q', '-b', 'main');
  git(source, 'config', 'user.email', 'alternate@rorca.invalid');
  git(source, 'config', 'user.name', 'Alternate Source');
  fs.writeFileSync(path.join(source, 'required-history.txt'), 'alternate-only-history\n');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'alternate-only base');
  const requiredCommit = git(source, 'rev-parse', 'HEAD');
  const sourceObjects = fs.realpathSync(path.join(source, '.git', 'objects'));

  git(middle, 'init', '-q', '-b', 'main');
  const middleObjects = fs.realpathSync(path.join(middle, '.git', 'objects'));
  fs.writeFileSync(
    path.join(middleObjects, 'info', 'alternates'),
    `${path.relative(middleObjects, sourceObjects)}\n`,
  );
  git(middle, 'update-ref', 'refs/heads/main', requiredCommit);
  git(middle, 'reset', '--hard', '-q', 'HEAD');

  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'sandbox@rorca.invalid');
  git(cwd, 'config', 'user.name', 'Sandbox Test');
  const primaryObjects = fs.realpathSync(path.join(cwd, '.git', 'objects'));
  fs.writeFileSync(path.join(primaryObjects, 'info', 'alternates'), `${middleObjects}\n`);
  git(cwd, 'update-ref', 'refs/heads/main', requiredCommit);
  git(cwd, 'reset', '--hard', '-q', 'HEAD');

  const deepestObject = path.join(sourceObjects, requiredCommit.slice(0, 2), requiredCommit.slice(2));
  if (!fs.existsSync(deepestObject)) throw new Error('alternate fixture commit object is not loose');
  const objectDirs = [primaryObjects, middleObjects, sourceObjects];
  for (const objectDir of objectDirs.slice(0, -1)) {
    expect(fs.existsSync(path.join(objectDir, requiredCommit.slice(0, 2), requiredCommit.slice(2)))).toBe(false);
  }
  expect(git(cwd, 'cat-file', '-t', requiredCommit)).toBe('commit');
  expect(git(cwd, 'status', '--porcelain')).toBe('');
  return { root, cwd, requiredCommit, objectDirs, deepestObject };
}

function installCleanSharedGitHardlinkAlias(
  cwd: string,
  kind: 'config' | 'ref' | 'hook' | 'object',
): { alias: string; target: string } {
  const gitDir = fs.realpathSync(git(cwd, 'rev-parse', '--absolute-git-dir'));
  let target: string;
  if (kind === 'config') {
    target = path.join(gitDir, 'config');
  } else if (kind === 'ref') {
    git(cwd, 'branch', 'hardlink-stable-ref');
    target = path.join(gitDir, 'refs', 'heads', 'hardlink-stable-ref');
  } else if (kind === 'hook') {
    target = path.join(gitDir, 'hooks', 'hardlink-proof');
    fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  } else {
    const objects = path.join(gitDir, 'objects');
    const looseDirectory = fs.readdirSync(objects)
      .find(name => /^[a-f0-9]{2}$/.test(name) && fs.statSync(path.join(objects, name)).isDirectory());
    if (!looseDirectory) throw new Error('fixture has no loose Git object');
    const objectName = fs.readdirSync(path.join(objects, looseDirectory))[0];
    target = path.join(objects, looseDirectory, objectName);
  }
  const alias = path.join(cwd, `tracked-${kind}-alias.bin`);
  fs.copyFileSync(target, alias);
  git(cwd, 'add', path.basename(alias));
  git(cwd, 'commit', '-qm', `track ${kind} alias content`);
  fs.unlinkSync(alias);
  fs.linkSync(target, alias);
  expect(git(cwd, 'status', '--porcelain')).toBe('');
  const targetStat = fs.statSync(target);
  const aliasStat = fs.statSync(alias);
  expect(`${aliasStat.dev}:${aliasStat.ino}`).toBe(`${targetStat.dev}:${targetStat.ino}`);
  return { alias, target };
}

afterEach(async () => {
  await closeAutonomousModelEgressForTests();
  delete process.env.RORCA_AUTONOMOUS_ISOLATION;
  delete process.env.RORCA_BWRAP_BIN;
  resetAutonomousSandboxProbeForTests();
});

test('production environment is reconstructed from an allowlist with no inherited capabilities', () => {
  expect(sanitizeAutonomousSandboxEnvForTests({
    PATH: '/host/bin',
    LANG: 'C.UTF-8',
    DATABASE_URL: 'postgres://secret',
    VAULT_KEY: 'vault-secret',
    JWT_SECRET: 'jwt-secret',
    GITHUB_TOKEN: 'github-secret',
    GH_TOKEN: 'gh-secret',
    ANTHROPIC_API_KEY: 'model-secret',
    OPENAI_API_KEY: 'model-secret',
    AWS_SECRET_ACCESS_KEY: 'cloud-secret',
    RORCA_INTERNAL_SERVICE_TOKEN: 'internal-secret',
    RORCA_OPERATOR_CAPABILITY_SHA256: 'operator-secret',
    PI_OFFLINE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  })).toMatchObject({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: '/home/rorca-agent',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GH_CONFIG_DIR: '/home/rorca-agent/.config/gh',
    PI_OFFLINE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  });
  const generic = sanitizeAutonomousSandboxEnvForTests({
    ANTHROPIC_API_KEY: 'must-not-reach-hooks',
    RORCA_AUTONOMOUS_EGRESS_SOCKET: '/must/not/mount.sock',
  });
  expect(generic.ANTHROPIC_API_KEY).toBeUndefined();
  expect(generic.RORCA_AUTONOMOUS_EGRESS_SOCKET).toBeUndefined();
  expect(generic.HTTPS_PROXY).toBeUndefined();
  const sanitized = sanitizeAutonomousSandboxEnvForTests({
    DATABASE_URL: 'secret', VAULT_KEY: 'secret', JWT_SECRET: 'secret',
    GITHUB_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret', RORCA_INTERNAL_SERVICE_TOKEN: 'secret',
  }, true);
  expect(Object.keys(sanitized)).not.toEqual(expect.arrayContaining([
    'DATABASE_URL', 'VAULT_KEY', 'JWT_SECRET', 'GITHUB_TOKEN',
    'RORCA_INTERNAL_SERVICE_TOKEN',
  ]));
  expect(sanitized.ANTHROPIC_API_KEY).toBe('secret');
});

test('Linux launch topology has fresh namespaces, private proc/home/tmp, read-only shared Git metadata, clearenv, and no broad host bind', () => {
  const cwd = fixture();
  try {
    fs.writeFileSync(path.join(cwd, '.env'), 'DATABASE_URL=must-not-be-readable\n', { mode: 0o600 });
    fs.mkdirSync(path.join(cwd, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'backend', '.env.local'), 'TOKEN=nested-must-not-be-readable\n', { mode: 0o600 });
    fs.mkdirSync(path.join(cwd, 'node_modules', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'node_modules', 'fixture', '.env.local'), 'TOKEN=deep-nested-must-not-be-readable\n', { mode: 0o600 });
    const args = buildLinuxSandboxArgumentsForTests({
      command: '/usr/bin/node', args: ['--version'], cwd,
      env: { PATH: '/usr/bin', DATABASE_URL: 'must-not-appear' },
    }, '/usr/bin/node', ['/usr']);
    const text = args.join('\n');
    expect(args).toEqual(expect.arrayContaining([
      '--die-with-parent', '--new-session', '--unshare-all', '--clearenv',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--chdir', fs.realpathSync(cwd),
    ]));
    expect(text).toContain(`--bind\n${fs.realpathSync(cwd)}\n${fs.realpathSync(cwd)}`);
    const sharedGitDir = git(cwd, 'rev-parse', '--absolute-git-dir');
    expect(text).toContain(`--ro-bind\n${sharedGitDir}\n${sharedGitDir}`);
    expect(text).not.toContain('must-not-appear');
    expect(text).toContain(`--ro-bind\n${os.devNull}\n${path.join(fs.realpathSync(cwd), '.env')}`);
    expect(text).toContain(`--ro-bind\n${os.devNull}\n${path.join(fs.realpathSync(cwd), 'backend', '.env.local')}`);
    expect(text).toContain(`--ro-bind\n${os.devNull}\n${path.join(fs.realpathSync(cwd), 'node_modules', 'fixture', '.env.local')}`);
    expect(text).not.toMatch(/--(?:ro-)?bind\n\/\n\//);
    for (const [alias, target] of [['/bin', 'usr/bin'], ['/sbin', 'usr/sbin'], ['/lib', 'usr/lib']]) {
      if (fs.existsSync(alias) && fs.lstatSync(alias).isSymbolicLink() && fs.readlinkSync(alias) === target) {
        expect(text).toContain(`--symlink\n${target}\n${alias}`);
      }
    }
    expect(args.slice(-3)).toEqual(['--', '/usr/bin/node', '--version']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('Linux bwrap OMP child uses the confined model-egress relay and worktree bind', async () => {
  const cwd = fixture();
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-omp-linux-runtime-'));
  const socketPath = path.join(runtime, 'egress.sock');
  const ompBin = path.join(runtime, 'omp');
  const server = net.createServer(socket => socket.end());
  try {
    fs.writeFileSync(ompBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const ompArgs = ['--mode', 'rpc', '--profile', 'rorca', '--cwd', cwd, '--no-extensions'];
    const args = buildLinuxSandboxArgumentsForTests({
      command: ompBin,
      args: ompArgs,
      cwd,
      modelCredentials: true,
      env: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'broker-eligible-fixture',
        RORCA_AUTONOMOUS_EGRESS_SOCKET: socketPath,
      },
    }, ompBin, ['/usr', runtime]);
    const text = args.join('\n');
    expect(args).toEqual(expect.arrayContaining([
      '--die-with-parent', '--unshare-all', '--clearenv', '--chdir', fs.realpathSync(cwd),
    ]));
    expect(text).toContain(`--bind\n${fs.realpathSync(cwd)}\n${fs.realpathSync(cwd)}`);
    expect(text).toContain(`--ro-bind\n${fs.realpathSync(socketPath)}\n/run/rorca-egress/proxy.sock`);
    expect(args).toEqual(expect.arrayContaining(['--setenv', 'ANTHROPIC_API_KEY', 'broker-eligible-fixture']));
    expect(args.at(-2)).toBe(ompBin);
    expect(args.at(-1)).toBe(JSON.stringify(ompArgs));
    expect(text).not.toContain('--share-net');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});

test.each(['config', 'ref', 'hook', 'object'] as const)(
  'Linux bwrap planning fails closed before sandbox issue for a clean shared Git %s hardlink alias',
  (kind) => {
    const cwd = fixture();
    try {
      const alias = installCleanSharedGitHardlinkAlias(cwd, kind);
      expect(() => buildLinuxSandboxArgumentsForTests({
        command: '/usr/bin/git', args: ['status', '--short'], cwd,
        env: { PATH: '/usr/bin' },
      }, '/usr/bin/git', ['/usr'])).toThrow(new RegExp(`hardlink alias.*${path.basename(alias.alias)}`));
      expect(fs.statSync(alias.target).ino).toBe(fs.statSync(alias.alias).ino);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test('hardlink inventory follows the resolved object store when common-dir/objects is a symlink', () => {
  const cwd = fixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-external-object-store-'));
  try {
    const gitDir = fs.realpathSync(git(cwd, 'rev-parse', '--absolute-git-dir'));
    const objectsPath = path.join(gitDir, 'objects');
    const externalObjects = path.join(external, 'objects');
    fs.renameSync(objectsPath, externalObjects);
    fs.symlinkSync(externalObjects, objectsPath, 'dir');
    const looseDirectory = fs.readdirSync(externalObjects)
      .find(name => /^[a-f0-9]{2}$/.test(name) && fs.statSync(path.join(externalObjects, name)).isDirectory());
    if (!looseDirectory) throw new Error('fixture has no loose Git object');
    const objectName = fs.readdirSync(path.join(externalObjects, looseDirectory))[0];
    const target = path.join(externalObjects, looseDirectory, objectName);
    const alias = path.join(cwd, 'tracked-external-object-alias.bin');
    fs.copyFileSync(target, alias);
    git(cwd, 'add', path.basename(alias));
    git(cwd, 'commit', '-qm', 'track external object alias content');
    const cleanPlan = buildLinuxSandboxArgumentsForTests({
      command: '/usr/bin/git', args: ['status', '--short'], cwd,
      env: { PATH: '/usr/bin' },
    }, '/usr/bin/git', ['/usr']).join('\n');
    const resolvedExternalObjects = fs.realpathSync(externalObjects);
    expect(cleanPlan).toContain(`--ro-bind\n${resolvedExternalObjects}\n${resolvedExternalObjects}`);
    fs.unlinkSync(alias);
    fs.linkSync(target, alias);
    expect(git(cwd, 'status', '--porcelain')).toBe('');

    expect(() => assertNoSharedGitHardlinkAliases(cwd)).toThrow(/hardlink alias.*tracked-external-object-alias/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('alternate-only history is manifest-pinned and every chained object root enters both sandbox policies', () => {
  const alternate = alternateChainFixture();
  const stateRoot = createAutonomousGitState(509, alternate.cwd, 'main');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-alternate-profile-runtime-'));
  const tmpdir = path.join(runtime, 'tmp');
  fs.mkdirSync(tmpdir);
  try {
    expect(resolveReachableLocalGitObjectDirectories(alternate.cwd)).toEqual(alternate.objectDirs);
    const manifest = autonomousGitStateManifestForTests(stateRoot);
    expect(manifest.sharedObjectDirs).toEqual(alternate.objectDirs);
    const view = createAutonomousGitView(stateRoot, alternate.cwd);
    expect(view.sharedObjectDirs).toEqual(alternate.objectDirs);
    expect(execFileSync('git', ['--git-dir', view.gitDir, 'cat-file', '-t', alternate.requiredCommit], {
      cwd: alternate.cwd,
      encoding: 'utf8',
    }).trim()).toBe('commit');

    const linuxPlan = buildLinuxSandboxArgumentsForTests({
      command: '/usr/bin/git', args: ['cat-file', '-t', alternate.requiredCommit], cwd: alternate.cwd,
      env: { PATH: '/usr/bin', [AUTONOMOUS_GIT_STATE_ROOT_ENV]: stateRoot },
    }, '/usr/bin/git', ['/usr']).join('\n');
    for (const objectDir of alternate.objectDirs) {
      expect(linuxPlan).toContain(`--ro-bind\n${objectDir}\n${objectDir}`);
    }

    const profile = buildDarwinOrdinaryLocalPiSeatbeltProfile(alternate.cwd, { piBinPath: process.execPath }, {
      HOME: runtime,
      TMPDIR: tmpdir,
      PATH: '/usr/bin:/bin',
      GIT_DIR: view.gitDir,
      GIT_WORK_TREE: alternate.cwd,
      [AUTONOMOUS_GIT_VIEW_ENV]: view.gitDir,
    });
    const readRule = profile.split('\n').find(line => line.startsWith('(allow file-read*')) ?? '';
    const writeDenyRule = profile.split('\n').find(line => line.startsWith('(deny file-write* (')) ?? '';
    for (const objectDir of alternate.objectDirs) {
      expect(readRule).toContain(`(subpath ${JSON.stringify(objectDir)})`);
      expect(writeDenyRule).toContain(`(subpath ${JSON.stringify(objectDir)})`);
    }

    fs.writeFileSync(path.join(alternate.objectDirs[0], 'info', 'alternates'), `${alternate.objectDirs[2]}\n`);
    expect(() => assertAutonomousGitHostReconciliation(alternate.cwd, {
      [AUTONOMOUS_GIT_STATE_ROOT_ENV]: stateRoot,
    })).toThrow(/shared object topology changed/);
  } finally {
    removeAutonomousGitState(stateRoot);
    fs.rmSync(runtime, { recursive: true, force: true });
    fs.rmSync(alternate.root, { recursive: true, force: true });
  }
});

test('clean external-alternate hardlink aliases are rejected before Linux or Darwin plan issuance', () => {
  const alternate = alternateChainFixture();
  const alias = path.join(alternate.cwd, 'tracked-external-alternate-alias.bin');
  let stateRoot: string | undefined;
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-alternate-hardlink-runtime-'));
  const tmpdir = path.join(runtime, 'tmp');
  fs.mkdirSync(tmpdir);
  try {
    fs.copyFileSync(alternate.deepestObject, alias);
    git(alternate.cwd, 'add', path.basename(alias));
    git(alternate.cwd, 'commit', '-qm', 'track alternate object bytes');
    fs.unlinkSync(alias);
    fs.linkSync(alternate.deepestObject, alias);
    expect(git(alternate.cwd, 'status', '--porcelain')).toBe('');
    expect(fs.statSync(alias).ino).toBe(fs.statSync(alternate.deepestObject).ino);

    expect(() => assertNoSharedGitHardlinkAliases(alternate.cwd))
      .toThrow(/hardlink alias.*tracked-external-alternate-alias/);
    expect(() => buildLinuxSandboxArgumentsForTests({
      command: '/usr/bin/git', args: ['status', '--short'], cwd: alternate.cwd,
      env: { PATH: '/usr/bin' },
    }, '/usr/bin/git', ['/usr'])).toThrow(/hardlink alias.*tracked-external-alternate-alias/);

    stateRoot = createAutonomousGitState(510, alternate.cwd, 'main');
    const view = createAutonomousGitView(stateRoot, alternate.cwd);
    expect(() => buildDarwinOrdinaryLocalPiSeatbeltProfile(alternate.cwd, { piBinPath: process.execPath }, {
      HOME: runtime,
      TMPDIR: tmpdir,
      PATH: '/usr/bin:/bin',
      GIT_DIR: view.gitDir,
      GIT_WORK_TREE: alternate.cwd,
      [AUTONOMOUS_GIT_VIEW_ENV]: view.gitDir,
    })).toThrow(/hardlink alias.*tracked-external-alternate-alias/);
  } finally {
    if (stateRoot) removeAutonomousGitState(stateRoot);
    fs.rmSync(runtime, { recursive: true, force: true });
    fs.rmSync(alternate.root, { recursive: true, force: true });
  }
});

test.each(['config', 'ref', 'hook', 'object'] as const)(
  'Darwin Seatbelt profile issuance fails closed for a clean shared Git %s hardlink alias',
  (kind) => {
    const cwd = fixture();
    const stateRoot = createAutonomousGitState(500 + ['config', 'ref', 'hook', 'object'].indexOf(kind), cwd, git(cwd, 'branch', '--show-current'));
    const view = createAutonomousGitView(stateRoot, cwd);
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hardlink-profile-runtime-'));
    const tmpdir = path.join(runtime, 'tmp');
    fs.mkdirSync(tmpdir);
    try {
      const alias = installCleanSharedGitHardlinkAlias(cwd, kind);
      expect(() => buildDarwinOrdinaryLocalPiSeatbeltProfile(cwd, { piBinPath: process.execPath }, {
        HOME: runtime,
        TMPDIR: tmpdir,
        PATH: '/usr/bin:/bin',
        GIT_DIR: view.gitDir,
        GIT_WORK_TREE: cwd,
        [AUTONOMOUS_GIT_VIEW_ENV]: view.gitDir,
      })).toThrow(new RegExp(`hardlink alias.*${path.basename(alias.alias)}`));
      expect(fs.statSync(alias.target).ino).toBe(fs.statSync(alias.alias).ino);
    } finally {
      removeAutonomousGitState(stateRoot);
      fs.rmSync(runtime, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test('Linux run-private Git view is writable while every shared gitdir/common-dir mount is read-only', () => {
  const cwd = fixture();
  const stateRoot = createAutonomousGitState(60, cwd, git(cwd, 'branch', '--show-current'));
  try {
    const args = buildLinuxSandboxArgumentsForTests({
      command: '/usr/bin/git',
      args: ['status', '--short'],
      cwd,
      env: {
        PATH: '/usr/bin',
        [AUTONOMOUS_GIT_STATE_ROOT_ENV]: stateRoot,
      },
    }, '/usr/bin/git', ['/usr']);
    const text = args.join('\n');
    const sharedGitDir = fs.realpathSync(git(cwd, 'rev-parse', '--absolute-git-dir'));
    expect(text).toContain(`--ro-bind\n${sharedGitDir}\n${sharedGitDir}`);
    const gitDirIndex = args.lastIndexOf('GIT_DIR');
    expect(gitDirIndex).toBeGreaterThan(0);
    const privateGitDir = args[gitDirIndex + 1];
    expect(privateGitDir).toContain(`${path.sep}rorca-autonomous-git-state-60-`);
    expect(text).toContain(`--bind\n${privateGitDir}\n${privateGitDir}`);
    expect(text).not.toContain(`--bind\n${sharedGitDir}\n${sharedGitDir}`);
  } finally {
    removeAutonomousGitState(stateRoot);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('ordinary local Pi uses a scoped Seatbelt profile rather than a raw host launch', () => {
  const cwd = fixture();
  const gitStateRoot = createAutonomousGitState(61, cwd, git(cwd, 'branch', '--show-current'));
  const gitView = createAutonomousGitView(gitStateRoot, cwd);
  try {
    const secret = path.join(cwd, '.env');
    fs.writeFileSync(secret, 'DATABASE_URL=must-not-be-readable\n', { mode: 0o600 });
    const tmpdir = path.join(cwd, '.rorca', 'ordinary-local-pi-tmp');
    fs.mkdirSync(tmpdir, { recursive: true });
    const profile = buildDarwinOrdinaryLocalPiSeatbeltProfile(cwd, {
      piBinPath: process.execPath,
    }, {
      HOME: os.homedir(),
      TMPDIR: tmpdir,
      PATH: '',
      GIT_DIR: gitView.gitDir,
      GIT_WORK_TREE: cwd,
      [AUTONOMOUS_GIT_VIEW_ENV]: gitView.gitDir,
    });

    expect(profile).toContain('(deny network*)');
    expect(profile).not.toContain('(allow network-outbound)');
    expect(profile).toContain('(deny file-read*)');
    expect(profile).toContain(`(subpath ${JSON.stringify(fs.realpathSync(cwd))})`);
    expect(profile).toContain(`(deny file-read* file-write* file-map-executable (literal ${JSON.stringify(fs.realpathSync(secret))}))`);
    if (process.platform === 'darwin' && fs.existsSync('/private/var/select/sh')) {
      expect(profile).toContain(`(literal ${JSON.stringify('/private/var/select/sh')})`);
      expect(profile).not.toContain(`(subpath ${JSON.stringify('/private/var')})`);
    }
    expect(profile).not.toContain(`(subpath ${JSON.stringify(path.dirname(process.execPath))})`);
    expect(profile).not.toContain('(allow default)');

    const brokeredProfile = buildDarwinOrdinaryLocalPiSeatbeltProfile(cwd, {
      piBinPath: process.execPath,
    }, {
      HOME: os.homedir(),
      TMPDIR: tmpdir,
      PATH: '',
      GIT_DIR: gitView.gitDir,
      GIT_WORK_TREE: cwd,
      [AUTONOMOUS_GIT_VIEW_ENV]: gitView.gitDir,
      RORCA_AUTONOMOUS_EGRESS_SOCKET: '/private/tmp/rorca-model-egress/proxy.sock',
    });
    expect(brokeredProfile).toContain('(deny network*)');
    expect(brokeredProfile).toContain('(remote ip "localhost:__RORCA_DARWIN_RELAY_PORT__")');
    expect(brokeredProfile).not.toContain('network-bind');
    expect(brokeredProfile).not.toContain('network-inbound');
    expect(brokeredProfile).not.toContain('remote unix-socket');
    expect(brokeredProfile).not.toContain('(allow network-outbound)');
    expect(brokeredProfile).not.toContain(`(subpath ${JSON.stringify(path.join(os.homedir(), '.config'))})`);
    expect(brokeredProfile).not.toContain(`(subpath ${JSON.stringify(path.join(os.homedir(), '.cache'))})`);
  } finally {
    removeAutonomousGitState(gitStateRoot);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

(process.platform === 'darwin' ? test : test.skip)(
  'ordinary local Pi uses the worker Node runtime when PI_BIN is a JavaScript entrypoint',
  () => {
    const cwd = fixture();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sandbox-workspace-'));
    const piEntrypoint = path.join(workspace, 'pi-entrypoint.js');
    const gitStateRoot = createAutonomousGitState(93, cwd, git(cwd, 'branch', '--show-current'));
    const gitView = createAutonomousGitView(gitStateRoot, cwd);
    try {
      fs.writeFileSync(piEntrypoint, '#!/usr/bin/env node\n');
      fs.chmodSync(piEntrypoint, 0o755);
      const realPiEntrypoint = fs.realpathSync(piEntrypoint);
      const launch = prepareAutonomousSandboxLaunch({
        command: 'node',
        args: ['-p', 'process.execPath'],
        cwd,
        env: {
          HOME: os.homedir(),
          PATH: process.env.PATH ?? '',
          PI_BIN: piEntrypoint,
          GIT_DIR: gitView.gitDir,
          GIT_WORK_TREE: cwd,
          [AUTONOMOUS_GIT_STATE_ROOT_ENV]: gitStateRoot,
          RORCA_ORDINARY_LOCAL_PI_PROFILE: serializeOrdinaryLocalPiRuntimeProfile({
            schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION,
            runId: 93,
            workspacePath: workspace,
            worktreePath: cwd,
            branchName: 'feat/ordinary-local',
            piBinPath: piEntrypoint,
            piRealPath: realPiEntrypoint,
            runtimeRoot: createOrdinaryLocalPiRuntimeState(93),
            posture: 'ordinary-local-branch' as const,
          }),
        },
      });
      const result = spawnSync(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        encoding: 'utf8',
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(fs.realpathSync(process.execPath));
    } finally {
      removeAutonomousGitState(gitStateRoot);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
const hasNativeSeatbelt = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
const execFileAsync = promisify(execFile);

(hasNativeSeatbelt ? test : test.skip)(
  'native Darwin private Git reads history available only through a chained external alternate',
  () => {
    const alternate = alternateChainFixture();
    const stateRoot = createAutonomousGitState(511, alternate.cwd, 'main');
    const view = createAutonomousGitView(stateRoot, alternate.cwd);
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-seatbelt-alternate-runtime-'));
    const tmpdir = path.join(runtime, 'tmp');
    fs.mkdirSync(tmpdir);
    try {
      const env: Record<string, string> = {
        HOME: runtime,
        TMPDIR: tmpdir,
        PATH: '/usr/bin:/bin',
        GIT_DIR: view.gitDir,
        GIT_WORK_TREE: alternate.cwd,
        [AUTONOMOUS_GIT_VIEW_ENV]: view.gitDir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
      };
      const profile = buildDarwinOrdinaryLocalPiSeatbeltProfile(
        alternate.cwd,
        { piBinPath: process.execPath },
        env,
      );
      const result = spawnSync('/usr/bin/sandbox-exec', [
        '-p', profile, '/usr/bin/git', 'show', `${alternate.requiredCommit}:required-history.txt`,
      ], {
        cwd: alternate.cwd,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('alternate-only-history\n');
    } finally {
      removeAutonomousGitState(stateRoot);
      fs.rmSync(runtime, { recursive: true, force: true });
      fs.rmSync(alternate.root, { recursive: true, force: true });
    }
  },
);

function gitControlSnapshot(commonDir: string): string {
  const hash = crypto.createHash('sha256');
  const visit = (candidate: string, relative: string): void => {
    const stat = fs.lstatSync(candidate);
    hash.update(`${relative}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`link:${fs.readlinkSync(candidate)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(candidate).sort()) {
        if (!relative && name === 'objects') continue;
        visit(path.join(candidate, name), relative ? `${relative}/${name}` : name);
      }
      return;
    }
    hash.update(fs.readFileSync(candidate));
    hash.update('\0');
  };
  visit(commonDir, '');
  return hash.digest('hex');
}

(hasNativeSeatbelt ? test : test.skip)(
  'native Darwin absolute Git/config/hook attacks cannot mutate primary control state while private refs remain writable',
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-seatbelt-git-control-'));
    const primary = path.join(root, 'primary');
    const worktree = path.join(root, 'feature');
    fs.mkdirSync(primary);
    git(primary, 'init', '-q', '-b', 'main');
    git(primary, 'config', 'user.email', 'sandbox@rorca.invalid');
    git(primary, 'config', 'user.name', 'Sandbox Test');
    fs.writeFileSync(path.join(primary, 'tracked.txt'), 'base\n');
    git(primary, 'add', '.');
    git(primary, 'commit', '-qm', 'base');
    git(primary, 'worktree', 'add', '-qb', 'feature/private-git', worktree);
    const baseHead = git(primary, 'rev-parse', 'main');
    fs.writeFileSync(path.join(worktree, 'tracked.txt'), 'feature\n');
    git(worktree, 'commit', '-qam', 'feature');
    const featureHead = git(worktree, 'rev-parse', 'HEAD');
    const commonPath = git(worktree, 'rev-parse', '--git-common-dir');
    const commonDir = fs.realpathSync(path.isAbsolute(commonPath) ? commonPath : path.resolve(worktree, commonPath));
    const hook = path.join(commonDir, 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const stateRoot = createAutonomousGitState(62, worktree, 'feature/private-git');
    const view = createAutonomousGitView(stateRoot, worktree);
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-seatbelt-git-runtime-'));
    const tmpdir = path.join(runtime, 'tmp');
    fs.mkdirSync(tmpdir);
    try {
      const env: Record<string, string> = {
        HOME: runtime,
        TMPDIR: tmpdir,
        PATH: '/usr/bin:/bin',
        GIT_DIR: view.gitDir,
        GIT_WORK_TREE: worktree,
        [AUTONOMOUS_GIT_VIEW_ENV]: view.gitDir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_AUTHOR_NAME: 'Private Git Test',
        GIT_AUTHOR_EMAIL: 'private@rorca.invalid',
        GIT_COMMITTER_NAME: 'Private Git Test',
        GIT_COMMITTER_EMAIL: 'private@rorca.invalid',
      };
      const profile = buildDarwinOrdinaryLocalPiSeatbeltProfile(worktree, { piBinPath: process.execPath }, env);
      const run = (command: string, args: string[]) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, command, ...args], {
        cwd: worktree,
        env,
        encoding: 'utf8',
        timeout: 10_000,
      });
      const before = gitControlSnapshot(commonDir);

      const privateRef = run('/usr/bin/git', ['update-ref', 'refs/heads/private-proof', baseHead]);
      expect(privateRef.status).toBe(0);
      expect(gitControlSnapshot(commonDir)).toBe(before);
      expect(run('/usr/bin/env', ['-u', 'GIT_DIR', '-u', 'GIT_WORK_TREE', '/usr/bin/git', '-C', worktree,
        'update-ref', 'refs/heads/main', featureHead]).status).not.toBe(0);
      expect(run('/usr/bin/git', [`--git-dir=${commonDir}`, 'update-ref', 'refs/heads/main', featureHead]).status).not.toBe(0);
      expect(run('/usr/bin/git', ['config', '--file', path.join(commonDir, 'config'), 'rorca.attack', 'true']).status).not.toBe(0);
      expect(run('/bin/sh', ['-c', 'printf attacked > "$1"', '_', hook]).status).not.toBe(0);

      expect(git(primary, 'rev-parse', 'main')).toBe(baseHead);
      expect(gitControlSnapshot(commonDir)).toBe(before);
      expect(fs.readFileSync(hook, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
    } finally {
      removeAutonomousGitState(stateRoot);
      fs.rmSync(runtime, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

function egressIdentity(runId: number): AutonomousModelEgressRunIdentity {
  return {
    runId,
    authorityHash: `sha256:${crypto.createHash('sha256').update(`sandbox-run:${runId}`).digest('hex')}`,
  };
}

(hasNativeSeatbelt ? test : test.skip)(
  'Darwin OMP launch uses the ordinary-local broker and copied Pi auth state [skip: requires macOS sandbox-exec]',
  async () => {
    const cwd = fixture();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sandbox-workspace-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sandbox-home-'));
    const ompShim = path.join(cwd, '.rorca', 'omp-managed-shim');
    const ompReal = path.join(workspace, 'formula', 'bin', 'omp');
    const identity = egressIdentity(73);
    const gitStateRoot = createAutonomousGitState(73, cwd, git(cwd, 'branch', '--show-current'));
    try {
      fs.mkdirSync(path.dirname(ompReal), { recursive: true });
      const ompResource = path.join(workspace, 'formula', 'share', 'startup.txt');
      fs.mkdirSync(path.dirname(ompResource), { recursive: true });
      fs.writeFileSync(ompResource, 'omp-startup-resource\n');
      fs.writeFileSync(ompReal, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
      fs.mkdirSync(path.dirname(ompShim), { recursive: true });
      fs.symlinkSync(ompReal, ompShim);
      const sourceAgent = path.join(fakeHome, '.pi', 'agent');
      fs.mkdirSync(sourceAgent, { recursive: true });
      fs.writeFileSync(path.join(sourceAgent, 'auth.json'), '{"provider":"required"}\n', { mode: 0o600 });
      fs.writeFileSync(path.join(sourceAgent, 'models.json'), '{"providers":{}}\n', { mode: 0o600 });
      fs.writeFileSync(path.join(sourceAgent, 'settings.json'), '{"extensions":["unrelated"]}\n');
      fs.mkdirSync(path.join(fakeHome, '.config', 'gh'), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, '.config', 'gh', 'hosts.yml'), 'unrelated-credential\n');
      fs.mkdirSync(path.join(fakeHome, '.cache', 'shared'), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, '.cache', 'shared', 'token'), 'unrelated-cache\n');
      const runtimeRoot = createOrdinaryLocalPiRuntimeState(73);
      const profile = {
        schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION as typeof ORDINARY_LOCAL_PI_PROFILE_VERSION,
        runId: 73,
        workspacePath: workspace,
        worktreePath: path.resolve(cwd),
        branchName: 'feat/scoped-pi-state',
        piBinPath: process.execPath,
        piRealPath: fs.realpathSync(process.execPath),
        runtimeRoot,
        posture: 'ordinary-local-branch' as const,
      };
      const probe = String.raw`
const fs=require('fs'),path=require('path');
if(!fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'auth.json'),'utf8').includes('required'))process.exit(41);
if(fs.readFileSync(process.argv[1],'utf8').trim()!=='omp-startup-resource')process.exit(43);
if(process.stdin.isTTY){if(typeof process.stdin.setRawMode!=='function')process.exit(44);process.stdin.setRawMode(true);process.stdin.setRawMode(false);process.stdout.write('RAW_MODE_OK\\n')}
for(const denied of process.argv.slice(2)){try{fs.readFileSync(denied);process.exit(42)}catch{}}
process.exit(0);`;
      const env: NodeJS.ProcessEnv = {
        HOME: fakeHome,
        PATH: path.dirname(process.execPath),
        PI_BIN: process.execPath,
        RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: 'model-omp.example.invalid',
        [AUTONOMOUS_GIT_STATE_ROOT_ENV]: gitStateRoot,
      };
      await ensureAutonomousModelEgress(env, 'darwin-local-pi', identity);
      const launch = prepareAutonomousSandboxLaunch({
        command: ompShim,
        args: ['-e', probe,
          ompResource,
          path.join(sourceAgent, 'settings.json'),
          path.join(fakeHome, '.config', 'gh', 'hosts.yml'),
          path.join(fakeHome, '.cache', 'shared', 'token'),
        ],
        cwd,
        modelCredentials: true,
        env: {
          ...env,
          [ORDINARY_LOCAL_PI_PROFILE_ENV]: serializeOrdinaryLocalPiRuntimeProfile(profile),
        } as Record<string, string>,
      });
      const isolatedAgentDir = launch.env.PI_CODING_AGENT_DIR;
      expect(isolatedAgentDir).toBe(path.join(runtimeRoot, 'agent'));
      expect(fs.readFileSync(path.join(isolatedAgentDir, 'auth.json'), 'utf8')).toContain('required');
      expect(fs.existsSync(path.join(isolatedAgentDir, 'models.json'))).toBe(true);
      expect(fs.existsSync(path.join(isolatedAgentDir, 'settings.json'))).toBe(false);
      expect(launch.env.HOME).toBe(path.join(runtimeRoot, 'home'));
      expect(launch.env.XDG_CONFIG_HOME).not.toContain(fakeHome);
      expect(launch.env.XDG_CACHE_HOME).not.toContain(fakeHome);
      expect(launch.env.RORCA_AUTONOMOUS_EGRESS_SOCKET).toBe(env.RORCA_AUTONOMOUS_EGRESS_SOCKET);
      expect(launch.env.PI_OFFLINE).toBeUndefined();
      expect(launch.command).toBe(fs.realpathSync(process.execPath));
      expect(launch.args).toContain(fs.realpathSync(ompReal));
      expect(launch.args).not.toContain(ompShim);
      expect(launch.args.join('\n')).toContain('/usr/bin/sandbox-exec');
      // The probe's argv legitimately carries the denied fake-home paths, so
      // the launch args WILL contain them; the invariant is that the seatbelt
      // profile's read/map allows never admit the fake home.
      const seatbeltArg = String(launch.args.find((arg) => typeof arg === 'string' && arg.includes('(version 1)')) ?? '');
      const fileAllows = seatbeltArg.split('\n')
        .filter((line) => line.includes('(allow file-read*') || line.includes('(allow file-map-executable'))
        .join('\n');
      expect(fileAllows).not.toContain(fakeHome);
      expect(seatbeltArg).toContain('(allow file-ioctl (subpath "/dev"))');
      execFileSync(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, timeout: 10_000 });
      await new Promise<void>((resolve, reject) => {
        const output: string[] = [];
        const child = nodePty.spawn(launch.command, launch.args, {
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
          cwd: launch.cwd,
          env: launch.env,
          encoding: 'utf8',
        });
        // Native PTY exit is an OS event; fake timers cannot bound a child
        // whose terminal ioctl was denied before it can report completion.
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Sandboxed OMP terminal-mode probe timed out'));
        }, 10_000);
        child.onData((chunk) => output.push(chunk));
        child.onExit(({ exitCode }) => {
          clearTimeout(timer);
          if (exitCode !== 0) {
            reject(new Error(`Sandboxed OMP terminal-mode probe exited ${exitCode}: ${output.join('').slice(-1000)}`));
            return;
          }
          expect(output.join('')).toContain('RAW_MODE_OK');
          resolve();
        });
      });
      expect(fs.existsSync(path.join(cwd, '.rorca', 'ordinary-local-pi-runtime'))).toBe(false);
      removeOrdinaryLocalPiRuntimeState(runtimeRoot);
      expect(fs.existsSync(runtimeRoot)).toBe(false);
    } finally {
      await closeAutonomousModelEgress(identity);
      removeAutonomousGitState(gitStateRoot);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  },
);

(process.platform === 'darwin' ? test : test.skip)(
  'ordinary local Pi permits the canonical host-created command guard',
  () => {
    const cwd = fixture();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sandbox-workspace-'));
    const piEntrypoint = path.join(workspace, 'pi-entrypoint.js');
    const gitStateRoot = createAutonomousGitState(94, cwd, git(cwd, 'branch', '--show-current'));
    const gitView = createAutonomousGitView(gitStateRoot, cwd);
    try {
      fs.writeFileSync(piEntrypoint, '#!/usr/bin/env node\n');
      fs.chmodSync(piEntrypoint, 0o755);
      const env = {
        HOME: os.homedir(),
        PATH: process.env.PATH ?? '',
        PI_BIN: piEntrypoint,
        GIT_DIR: gitView.gitDir,
        GIT_WORK_TREE: cwd,
        [AUTONOMOUS_GIT_STATE_ROOT_ENV]: gitStateRoot,
        RORCA_ORDINARY_LOCAL_PI_PROFILE: serializeOrdinaryLocalPiRuntimeProfile({
          schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION,
          runId: 94,
          workspacePath: workspace,
          worktreePath: cwd,
          branchName: 'feat/ordinary-local',
          piBinPath: piEntrypoint,
          piRealPath: fs.realpathSync(piEntrypoint),
          runtimeRoot: createOrdinaryLocalPiRuntimeState(94),
          posture: 'ordinary-local-branch' as const,
        }),
      };
      const guard = createAutonomousCommandGuard({ cwd, env });
      try {
        const launch = prepareAutonomousSandboxLaunch({
          command: 'npm', args: ['--version'], cwd, env: guard.env,
        });
        const result = spawnSync(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.env,
          encoding: 'utf8',
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
      } finally {
        fs.rmSync(guard.guardBinDir, { recursive: true, force: true });
      }
    } finally {
      removeAutonomousGitState(gitStateRoot);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
      }
    });
(hasNativeSeatbelt ? test : test.skip)(
  'native concurrent generated Seatbelt launches use distinct run-owned brokers and deny every ungranted socket [skip: requires macOS sandbox-exec]',
  async () => {
    const cwd = fixture();
    const socketRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-seatbelt-sockets-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-seatbelt-workspace-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-seatbelt-home-'));
    const deniedSocket = path.join(socketRoot, 'denied.sock');
    const deniedServer = net.createServer(socket => socket.end('forbidden'));
    const deniedTcpServer = net.createServer(socket => socket.end('forbidden'));
    const listen = (server: net.Server, target: string | number, host?: string) => new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      const listening = () => { server.off('error', reject); resolve(); };
      if (typeof target === 'string') server.listen(target, listening);
      else server.listen(target, host, listening);
    });
    const runtimeRoots: string[] = [];
    const gitStateRoots: string[] = [];
    try {
      await listen(deniedServer, deniedSocket);
      await listen(deniedTcpServer, 0, '127.0.0.1');
      const deniedTcpAddress = deniedTcpServer.address();
      if (!deniedTcpAddress || typeof deniedTcpAddress === 'string') throw new Error('expected TCP test address');
      const probe = String.raw`
const net=require('net');
const [deniedSocket,deniedPort]=process.argv.slice(1);
const relayPort=Number(new URL(process.env.HTTPS_PROXY).port);
if(!Number.isSafeInteger(relayPort)||relayPort<=0)throw new Error('relay endpoint was not dynamically allocated');
const relayConnect=()=>new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port:relayPort});let data='';const timer=setTimeout(()=>{socket.destroy();reject(new Error('relay timeout'))},1500);socket.on('connect',()=>socket.write('GET / HTTP/1.1\r\n\r\n'));socket.on('data',chunk=>{data+=chunk});socket.once('end',()=>{clearTimeout(timer);data.includes('405 Method Not Allowed')?resolve():reject(new Error('relay did not reach exact run-owned broker'))});socket.once('error',error=>{clearTimeout(timer);reject(error)})});
const denied=(options)=>new Promise((resolve,reject)=>{const socket=net.connect(options);const timer=setTimeout(()=>{socket.destroy();reject(new Error('denial timeout'))},1500);socket.once('connect',()=>{clearTimeout(timer);socket.destroy();reject(new Error('unexpected connection'))});socket.once('error',()=>{clearTimeout(timer);resolve()})});
(async()=>{await relayConnect();await denied({path:deniedSocket});await denied({host:'127.0.0.1',port:Number(deniedPort)});await denied({host:'198.51.100.1',port:443})})().then(()=>process.exit(0),error=>{console.error(error);process.exit(1)});`;
      const createLaunch = async (runId: number, host: string) => {
        const runtimeRoot = createOrdinaryLocalPiRuntimeState(runId);
        runtimeRoots.push(runtimeRoot);
        const gitStateRoot = createAutonomousGitState(runId, cwd, git(cwd, 'branch', '--show-current'));
        gitStateRoots.push(gitStateRoot);
        const identity = egressIdentity(runId);
        const env: NodeJS.ProcessEnv = {
          HOME: fakeHome,
          PATH: path.dirname(process.execPath),
          PI_BIN: process.execPath,
          [AUTONOMOUS_GIT_STATE_ROOT_ENV]: gitStateRoot,
          RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: host,
        };
        await ensureAutonomousModelEgress(env, 'darwin-local-pi', identity);
        const profile = {
          schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION as typeof ORDINARY_LOCAL_PI_PROFILE_VERSION,
          runId,
          workspacePath: workspace,
          worktreePath: path.resolve(cwd),
          branchName: `feat/native-seatbelt-relay-${runId}`,
          piBinPath: process.execPath,
          piRealPath: fs.realpathSync(process.execPath),
          runtimeRoot,
          posture: 'task-manifest-pr' as const,
        };
        return prepareAutonomousSandboxLaunch({
          command: process.execPath,
          args: ['-e', probe, deniedSocket, String(deniedTcpAddress.port)],
          cwd,
          modelCredentials: true,
          env: { ...env, [ORDINARY_LOCAL_PI_PROFILE_ENV]: serializeOrdinaryLocalPiRuntimeProfile(profile) } as Record<string, string>,
        });
      };
      const launches = await Promise.all([
        createLaunch(74, 'model-a.example.invalid'),
        createLaunch(79, 'model-b.example.invalid'),
      ]);
      expect(launches[0].env.RORCA_AUTONOMOUS_EGRESS_SOCKET).not.toBe(launches[1].env.RORCA_AUTONOMOUS_EGRESS_SOCKET);
      await Promise.all(launches.map(launch => execFileAsync(launch.command, launch.args, {
        cwd: launch.cwd, env: launch.env, timeout: 10_000,
      })));
    } finally {
      for (const runtimeRoot of runtimeRoots) removeOrdinaryLocalPiRuntimeState(runtimeRoot);
      for (const gitStateRoot of gitStateRoots) removeAutonomousGitState(gitStateRoot);
      deniedServer.close();
      deniedTcpServer.close();
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(socketRoot, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  },
);

const nativePiBinary = (() => {
  const configured = process.env.PI_BIN;
  if (configured && path.isAbsolute(configured) && fs.existsSync(configured)) return path.resolve(configured);
  try {
    const discovered = execFileSync('/usr/bin/which', ['pi'], { encoding: 'utf8' }).trim();
    return path.isAbsolute(discovered) && fs.existsSync(discovered) ? discovered : null;
  } catch { return null; }
})();

(hasNativeSeatbelt && nativePiBinary ? test : test.skip)(
  'actual bounded Pi launches through the generated run-owned-broker Seatbelt supervisor [skip: requires macOS sandbox-exec and Pi]',
  async () => {
    const cwd = fixture();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-real-pi-workspace-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-real-pi-home-'));
    const runtimeRoot = createOrdinaryLocalPiRuntimeState(83);
    const gitStateRoot = createAutonomousGitState(83, cwd, git(cwd, 'branch', '--show-current'));
    const identity = egressIdentity(83);
    try {
      const piRealPath = fs.realpathSync(nativePiBinary!);
      const env: NodeJS.ProcessEnv = {
        HOME: fakeHome,
        PATH: `${path.dirname(nativePiBinary!)}:/usr/bin:/bin`,
        PI_BIN: nativePiBinary!,
        [AUTONOMOUS_GIT_STATE_ROOT_ENV]: gitStateRoot,
        RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: 'model-api.example.invalid',
      };
      await ensureAutonomousModelEgress(env, 'darwin-local-pi', identity);
      const profile = {
        schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION as typeof ORDINARY_LOCAL_PI_PROFILE_VERSION,
        runId: 83,
        workspacePath: workspace,
        worktreePath: path.resolve(cwd),
        branchName: 'feat/native-real-pi-broker',
        piBinPath: nativePiBinary!,
        piRealPath,
        runtimeRoot,
        posture: 'task-manifest-pr' as const,
      };
      const launch = prepareAutonomousSandboxLaunch({
        command: nativePiBinary!,
        args: ['--version'],
        cwd,
        modelCredentials: true,
        env: { ...env, [ORDINARY_LOCAL_PI_PROFILE_ENV]: serializeOrdinaryLocalPiRuntimeProfile(profile) } as Record<string, string>,
      });
      const result = await execFileAsync(launch.command, launch.args, {
        cwd: launch.cwd, env: launch.env, timeout: 20_000,
      });
      expect(`${result.stdout}${result.stderr}`).toMatch(/\b\d+\.\d+\.\d+\b/);
      expect(launch.args.join('\n')).toContain('/usr/bin/sandbox-exec');
      expect(launch.isolated).toBe(true);
    } finally {
      await closeAutonomousModelEgress(identity);
      removeOrdinaryLocalPiRuntimeState(runtimeRoot);
      removeAutonomousGitState(gitStateRoot);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  },
);

test('cleanup never follows model-writable worktree state or a substituted runtime-root symlink', () => {
  const cwd = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-cleanup-outside-'));
  const sentinel = path.join(outside, 'must-survive');
  const runtimeRoot = createOrdinaryLocalPiRuntimeState(75);
  fs.writeFileSync(sentinel, 'survive');
  try {
    const modelWritableParent = path.join(cwd, '.rorca', 'ordinary-local-pi-runtime');
    fs.mkdirSync(path.dirname(modelWritableParent), { recursive: true });
    fs.symlinkSync(outside, modelWritableParent);
    removeOrdinaryLocalPiRuntimeState(runtimeRoot);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('survive');

    const substituted = createOrdinaryLocalPiRuntimeState(76);
    fs.rmSync(substituted, { recursive: true });
    fs.symlinkSync(outside, substituted);
    removeOrdinaryLocalPiRuntimeState(substituted);
    expect(fs.lstatSync(substituted).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('survive');
    fs.unlinkSync(substituted);

    const modeDrifted = createOrdinaryLocalPiRuntimeState(78);
    fs.chmodSync(modeDrifted, 0o777);
    removeOrdinaryLocalPiRuntimeState(modeDrifted);
    expect(fs.existsSync(modeDrifted)).toBe(false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    removeOrdinaryLocalPiRuntimeState(runtimeRoot);
  }
});

test('startup sweep removes a prior-worker credential snapshot without touching reusable worktree state', () => {
  const cwd = fixture();
  const staleRoot = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()), 'rorca-ordinary-local-pi-runtime-999-',
  ));
  fs.chmodSync(staleRoot, 0o700);
  const agent = path.join(staleRoot, 'agent');
  fs.mkdirSync(agent, { mode: 0o700 });
  fs.writeFileSync(path.join(agent, 'auth.json'), '{"stale":true}\n', { mode: 0o600 });
  try {
    expect(sweepStaleOrdinaryLocalPiRuntimeState([staleRoot])).toBe(1);
    expect(fs.existsSync(staleRoot)).toBe(false);
    expect(fs.existsSync(path.join(cwd, '.rorca', 'ordinary-local-pi-runtime'))).toBe(false);
  } finally {
    fs.rmSync(staleRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('startup sweep spares roots whose run is still live (parallel-worker coexistence)', () => {
  const cwd = fixture();
  const liveRoot = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()), 'rorca-ordinary-local-pi-runtime-20260316000616-',
  ));
  fs.chmodSync(liveRoot, 0o700);
  const agent = path.join(liveRoot, 'agent');
  fs.mkdirSync(agent, { mode: 0o700 });
  fs.writeFileSync(path.join(agent, 'auth.json'), '{"live":true}\n', { mode: 0o600 });
  try {
    // Run 20260316000616 is live → the sweep must keep its runtime root.
    expect(sweepStaleOrdinaryLocalPiRuntimeState([liveRoot], (runId) => runId === 20260316000616)).toBe(0);
    expect(fs.existsSync(liveRoot)).toBe(true);
    // Same root with no live run → removed.
    expect(sweepStaleOrdinaryLocalPiRuntimeState([liveRoot], () => false)).toBe(1);
    expect(fs.existsSync(liveRoot)).toBe(false);
  } finally {
    fs.rmSync(liveRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

(hasNativeSeatbelt ? test : test.skip)(
  'native worktree symlink substitution cannot redirect exact-root host cleanup [skip: requires macOS sandbox-exec]',
  async () => {
    const cwd = fixture();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-cleanup-workspace-'));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-cleanup-home-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-cleanup-native-outside-'));
    const sentinel = path.join(outside, 'must-survive');
    const runtimeRoot = createOrdinaryLocalPiRuntimeState(77);
    const gitStateRoot = createAutonomousGitState(77, cwd, git(cwd, 'branch', '--show-current'));
    fs.writeFileSync(sentinel, 'survive');
    try {
      const probe = String.raw`
const fs=require('fs'),path=require('path');
const [runtimeRoot,outside,cwd]=process.argv.slice(1);
const legacyParent=path.join(cwd,'.rorca','ordinary-local-pi-runtime');
fs.mkdirSync(path.dirname(legacyParent),{recursive:true});
fs.symlinkSync(outside,legacyParent);
let denied=false;
try{fs.renameSync(runtimeRoot,runtimeRoot+'.model-moved');fs.symlinkSync(outside,runtimeRoot)}catch{denied=true}
if(!denied)process.exit(42);
process.exit(0);`;
      const profile = {
        schemaVersion: ORDINARY_LOCAL_PI_PROFILE_VERSION as typeof ORDINARY_LOCAL_PI_PROFILE_VERSION,
        runId: 77,
        workspacePath: workspace,
        worktreePath: path.resolve(cwd),
        branchName: 'feat/native-cleanup-boundary',
        piBinPath: process.execPath,
        piRealPath: fs.realpathSync(process.execPath),
        runtimeRoot,
        posture: 'ordinary-local-branch' as const,
      };
      const launch = prepareAutonomousSandboxLaunch({
        command: process.execPath,
        args: ['-e', probe, runtimeRoot, outside, cwd],
        cwd,
        env: {
          HOME: fakeHome,
          PATH: path.dirname(process.execPath),
          PI_BIN: process.execPath,
          [AUTONOMOUS_GIT_STATE_ROOT_ENV]: gitStateRoot,
          [ORDINARY_LOCAL_PI_PROFILE_ENV]: serializeOrdinaryLocalPiRuntimeProfile(profile),
        },
      });
      await execFileAsync(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, timeout: 10_000 });
      removeOrdinaryLocalPiRuntimeState(runtimeRoot);
      expect(fs.lstatSync(path.join(cwd, '.rorca', 'ordinary-local-pi-runtime')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('survive');
    } finally {
      removeOrdinaryLocalPiRuntimeState(runtimeRoot);
      removeAutonomousGitState(gitStateRoot);
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  },
);

test('local-dev posture requires explicit env opt-in and never infers from host state', () => {
  const cwd = fixture();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-fake-home-'));
  try {
    fs.mkdirSync(path.join(fakeHome, '.config', 'gh'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.config', 'gh', 'hosts.yml'), 'github.com:\n  oauth_token: fake-only\n');
    // No explicit posture → still fails closed on any host.
    for (const env of [
      { NODE_ENV: 'test' },
      { NODE_ENV: 'development' },
      { NODE_ENV: 'test', RORCA_AUTONOMOUS_ISOLATION: 'bwrap' },
    ]) {
      expect(() => assertAutonomousExecutionBoundary({
        cwd, providerCapable: false, platform: 'darwin', runProbe: false, env,
      })).toThrow(/must explicitly be linux-bwrap or local-dev/);
    }
    // Explicit local-dev opt-in (operator-declared) permits direct local
    // spawning even with ambient credential files present — the posture is
    // declared, never inferred.
    for (const env of [
      { NODE_ENV: 'development', RORCA_AUTONOMOUS_ISOLATION: 'local-dev' },
      {
        NODE_ENV: 'development', RORCA_AUTONOMOUS_ISOLATION: 'local-dev',
        HOME: fakeHome, GITHUB_APP_PRIVATE_KEY: 'fake-private-key',
      },
    ]) {
      expect(() => assertAutonomousExecutionBoundary({
        cwd, providerCapable: false, platform: 'darwin', runProbe: false, env,
      })).not.toThrow();
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

const hasLinuxBoundary = process.platform === 'linux'
  && fs.existsSync('/usr/bin/bwrap')
  && ['/usr/local/bin/node', '/usr/bin/node'].some(fs.existsSync)
  && ['/usr/local/bin/python3', '/usr/bin/python3'].some(fs.existsSync)
  && fs.existsSync('/usr/bin/git')
  && fs.existsSync('/usr/bin/gh')
  && fs.existsSync('/usr/local/bin/npm')
  && fs.existsSync('/usr/local/bin/npx');

(hasLinuxBoundary ? test : test.skip)(
  'shipped Linux boundary sensitivity sees the exec-time marked supervisor without PID isolation while canonical isolation hides it [skip: requires Linux bwrap platform fixture]',
  () => {
    const cwd = fixture();
    const originalIsolation = process.env.RORCA_AUTONOMOUS_ISOLATION;
    const originalBwrap = process.env.RORCA_BWRAP_BIN;
    try {
      process.env.RORCA_AUTONOMOUS_ISOLATION = 'linux-bwrap';
      process.env.RORCA_BWRAP_BIN = '/usr/bin/bwrap';
      expect(() => assertAutonomousExecutionBoundary({ cwd, providerCapable: true })).not.toThrow();
    } finally {
      process.env.RORCA_AUTONOMOUS_ISOLATION = originalIsolation;
      process.env.RORCA_BWRAP_BIN = originalBwrap;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  },
);
