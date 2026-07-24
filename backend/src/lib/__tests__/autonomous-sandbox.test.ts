/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertAutonomousExecutionBoundary,
  buildLinuxSandboxArgumentsForTests,
  resetAutonomousSandboxProbeForTests,
  sanitizeAutonomousSandboxEnvForTests,
} from '../autonomous-sandbox';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
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

afterEach(() => {
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
  })).toMatchObject({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: '/home/rorca-agent',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GH_CONFIG_DIR: '/home/rorca-agent/.config/gh',
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

test('Linux launch topology has fresh namespaces, private proc/home/tmp, exact worktree, Git metadata, clearenv, and no broad host bind', () => {
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
    expect(text).toContain(git(cwd, 'rev-parse', '--absolute-git-dir'));
    expect(text).not.toContain('must-not-appear');
    expect(text).toContain(`--ro-bind\n${os.devNull}\n${path.join(fs.realpathSync(cwd), '.env')}`);
    expect(text).toContain(`--ro-bind\n${os.devNull}\n${path.join(fs.realpathSync(cwd), 'backend', '.env.local')}`);
    expect(text).toContain(`--ro-bind\n${os.devNull}\n${path.join(fs.realpathSync(cwd), 'node_modules', 'fixture', '.env.local')}`);
    expect(text).not.toMatch(/--(?:ro-)?bind\n\/\n\//);
    expect(args.slice(-3)).toEqual(['--', '/usr/bin/node', '--version']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('raw local-dev posture always fails closed, including file-backed and unenumerated credential probes', () => {
  const cwd = fixture();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-fake-home-'));
  try {
    fs.mkdirSync(path.join(fakeHome, '.config', 'gh'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.config', 'gh', 'hosts.yml'), 'github.com:\n  oauth_token: fake-only\n');
    for (const env of [
      { NODE_ENV: 'development', RORCA_AUTONOMOUS_ISOLATION: 'local-dev' },
      { NODE_ENV: 'test' },
      {
        NODE_ENV: 'development', RORCA_AUTONOMOUS_ISOLATION: 'local-dev',
        HOME: fakeHome, GITHUB_APP_PRIVATE_KEY: 'fake-private-key',
      },
    ]) {
      expect(() => assertAutonomousExecutionBoundary({
        cwd, providerCapable: false, platform: 'darwin', runProbe: false, env,
      })).toThrow(/must explicitly be linux-bwrap/);
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
