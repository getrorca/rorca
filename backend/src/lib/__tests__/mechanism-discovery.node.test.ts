/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { discoverRepositoryMechanisms } from '../mechanism-discovery';

const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rorca-mechanisms-'));
  fixtures.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test('discovers a backend Jest command as an executable and argv vector', async () => {
  const root = await fixture();
  const backend = path.join(root, 'backend');
  await mkdir(backend);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  await writeFile(path.join(backend, 'package.json'), JSON.stringify({
    scripts: { test: 'tsx scripts/run-isolated-jest.ts' },
    devDependencies: { jest: '^29.7.0', typescript: '^5.7.0' },
  }));
  await writeFile(path.join(backend, 'jest.config.ts'), 'export default {};');

  const result = await discoverRepositoryMechanisms(root);
  const jest = result.mechanisms.find(mechanism => mechanism.kind === 'jest');

  assert.equal(result.available, true);
  assert.deepEqual(jest, {
    kind: 'jest',
    executable: 'npm',
    args: ['test', '--', '--runInBand'],
    cwd: backend,
    discoveredFrom: ['backend/jest.config.ts', 'backend/package.json'],
    confidence: 1,
  });
});

test('uses the repository package manager for a nested Jest package', async () => {
  const root = await fixture();
  const backend = path.join(root, 'backend');
  await mkdir(backend);
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(path.join(backend, 'package.json'), JSON.stringify({
    scripts: { test: 'jest' },
    devDependencies: { jest: '^29.7.0' },
  }));

  const result = await discoverRepositoryMechanisms(root);

  assert.deepEqual(result.mechanisms[0], {
    kind: 'jest',
    executable: 'pnpm',
    args: ['test', '--', '--runInBand'],
    cwd: backend,
    discoveredFrom: ['backend/package.json', 'pnpm-lock.yaml'],
    confidence: 1,
  });
});

test('prefers a nested npm lockfile over a parent workspace manager', async () => {
  const root = await fixture();
  const backend = path.join(root, 'backend');
  await mkdir(backend);
  await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(path.join(backend, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  await writeFile(path.join(backend, 'package.json'), JSON.stringify({
    scripts: { test: 'jest' },
    devDependencies: { jest: '^29.7.0' },
  }));

  const result = await discoverRepositoryMechanisms(root);

  assert.equal(result.mechanisms[0]?.executable, 'npm');
  assert.deepEqual(result.mechanisms[0]?.discoveredFrom, ['backend/package-lock.json', 'backend/package.json']);
});

test('records corroborating CI and governance evidence without constructing commands from it', async () => {
  const root = await fixture();
  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'jest' },
    devDependencies: { jest: '^29.7.0' },
  }));
  await writeFile(path.join(root, 'AGENTS.md'), 'Verification: run npm test before closeout.');
  await writeFile(path.join(root, '.github', 'workflows', 'verify.yml'), 'steps:\n  - run: npm test\n');

  const result = await discoverRepositoryMechanisms(root);

  assert.deepEqual(result.mechanisms[0], {
    kind: 'jest',
    executable: 'npm',
    args: ['test', '--', '--runInBand'],
    cwd: root,
    discoveredFrom: ['.github/workflows/verify.yml', 'AGENTS.md', 'package.json'],
    confidence: 1,
  });
});

test('discovers pytest from pytest-like pyproject configuration', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');

  const result = await discoverRepositoryMechanisms(root);

  assert.deepEqual(result.mechanisms, [{
    kind: 'pytest',
    executable: 'python3',
    args: ['-m', 'pytest'],
    cwd: root,
    discoveredFrom: ['pyproject.toml'],
    confidence: 0.9,
  }]);
});

test('returns an honest unavailable result when no supported framework exists', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'README.md'), '# no verification framework');

  const unavailable = {
    available: false,
    mechanisms: [],
    inspectedPaths: [],
    reason: 'no-supported-verification-mechanism',
  } as const;
  assert.deepEqual(await discoverRepositoryMechanisms(root), unavailable);
  assert.deepEqual(await discoverRepositoryMechanisms(path.join(root, 'missing')), unavailable);
});

test('does not route an unrelated package test script to Jest', async () => {
  const root = await fixture();
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'vitest run' },
    devDependencies: { jest: '^29.7.0' },
  }));

  const result = await discoverRepositoryMechanisms(root);

  assert.deepEqual(result.mechanisms[0], {
    kind: 'jest',
    executable: 'npm',
    args: ['exec', '--', 'jest', '--runInBand'],
    cwd: root,
    discoveredFrom: ['package.json'],
    confidence: 0.9,
  });
});

test('does not traverse symlinked directories outside the repository', async () => {
  const root = await fixture();
  const outside = await fixture();
  await writeFile(path.join(outside, 'package.json'), JSON.stringify({
    scripts: { test: 'jest' }, devDependencies: { jest: '29.7.0' },
  }));
  await symlink(outside, path.join(root, 'escaped'), 'dir');
  await symlink(path.join(outside, 'package.json'), path.join(root, 'package.json'), 'file');

  const result = await discoverRepositoryMechanisms(path.join(root, '.'));

  assert.equal(result.available, false);
  assert.deepEqual(result.mechanisms, []);
  assert.ok(result.inspectedPaths.every(candidate => !candidate.includes('..')));
});
