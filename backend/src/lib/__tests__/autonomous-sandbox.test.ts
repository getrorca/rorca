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
  const sanitized = sanitizeAutonomousSandboxEnvForTests({
    DATABASE_URL: 'secret', VAULT_KEY: 'secret', JWT_SECRET: 'secret',
    GITHUB_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret', RORCA_INTERNAL_SERVICE_TOKEN: 'secret',
  });
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
    expect(text).not.toMatch(/--(?:ro-)?bind\n\/\n\//);
    expect(args.slice(-3)).toEqual(['--', '/usr/bin/node', '--version']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('explicit local-dev posture is non-production and cannot coexist with provider capability', () => {
  const cwd = fixture();
  try {
    expect(() => assertAutonomousExecutionBoundary({
      cwd, providerCapable: false, platform: 'darwin', runProbe: false,
      env: { NODE_ENV: 'development', RORCA_AUTONOMOUS_ISOLATION: 'local-dev' },
    })).not.toThrow();
    expect(() => assertAutonomousExecutionBoundary({
      cwd, providerCapable: true, platform: 'darwin', runProbe: false,
      env: { NODE_ENV: 'development', RORCA_AUTONOMOUS_ISOLATION: 'local-dev' },
    })).toThrow(/cannot coexist with provider authority/);
    expect(() => assertAutonomousExecutionBoundary({
      cwd, providerCapable: false, platform: 'darwin', runProbe: false,
      env: { NODE_ENV: 'development', RORCA_AUTONOMOUS_ISOLATION: 'local-dev', GITHUB_TOKEN: 'present' },
    })).toThrow(/cannot coexist with provider authority/);
    expect(() => assertAutonomousExecutionBoundary({
      cwd, providerCapable: false, platform: 'linux', runProbe: false,
      env: { NODE_ENV: 'production', RORCA_AUTONOMOUS_ISOLATION: 'local-dev' },
    })).toThrow(/forbidden in production/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
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
  'shipped Linux boundary behavior denies ancestor environ, credential files, localhost/provider sockets while absolute tools and package runners execute',
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
