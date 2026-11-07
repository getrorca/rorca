/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverRepositoryMechanisms } from '../lib/mechanism-discovery';

async function writeFixture(root: string, relativePath: string, content: string): Promise<void> {
  const filename = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content, 'utf8');
}

describe('repository mechanism discovery', () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rorca-mechanism-discovery-'));
  });

  afterEach(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  test('discovers the repository-owned Jest command in a TypeScript backend', async () => {
    await writeFixture(fixtureRoot, 'package-lock.json', '{}');
    await writeFixture(fixtureRoot, 'backend/package.json', JSON.stringify({
      scripts: { test: 'jest' },
      devDependencies: { jest: '^29.7.0', typescript: '^5.7.0' },
    }));
    await writeFixture(fixtureRoot, 'backend/jest.config.ts', 'export default {};');
    await writeFixture(fixtureRoot, '.github/workflows/ci.yml', 'steps:\n  - run: npm test\n');

    const result = await discoverRepositoryMechanisms(fixtureRoot);

    expect(result.available).toBe(true);
    expect(result.mechanisms).toEqual([{
      kind: 'jest',
      executable: 'npm',
      args: ['test', '--', '--runInBand'],
      cwd: await fs.realpath(path.join(fixtureRoot, 'backend')),
      discoveredFrom: [
        '.github/workflows/ci.yml',
        'backend/jest.config.ts',
        'backend/package.json',
        'package-lock.json',
      ],
      confidence: 1,
    }]);
  });

  test('keeps repository script content out of the executable and argv', async () => {
    const untrustedScript = 'jest --runInBand; node ../../outside-workspace.js';
    await writeFixture(fixtureRoot, 'backend/package.json', JSON.stringify({
      scripts: { test: untrustedScript },
      devDependencies: { jest: '^29.7.0' },
    }));

    const result = await discoverRepositoryMechanisms(fixtureRoot);

    expect(result.mechanisms).toHaveLength(1);
    expect(result.mechanisms[0]).toMatchObject({
      executable: 'npm',
      args: ['test', '--', '--runInBand'],
      cwd: await fs.realpath(path.join(fixtureRoot, 'backend')),
    });
    expect([result.mechanisms[0].executable, ...result.mechanisms[0].args]).not.toContain(untrustedScript);
  });

  test('discovers pytest from pyproject configuration without inventing shell syntax', async () => {
    await writeFixture(fixtureRoot, 'services/api/pyproject.toml', [
      '[project]',
      'name = "api"',
      '[tool.pytest.ini_options]',
      'testpaths = ["tests"]',
    ].join('\n'));

    const result = await discoverRepositoryMechanisms(fixtureRoot);

    expect(result.mechanisms).toEqual([{
      kind: 'pytest',
      executable: 'python3',
      args: ['-m', 'pytest'],
      cwd: await fs.realpath(path.join(fixtureRoot, 'services/api')),
      discoveredFrom: ['services/api/pyproject.toml'],
      confidence: 0.9,
    }]);
  });

  test('does not apply nested governance evidence to a sibling package', async () => {
    await writeFixture(fixtureRoot, 'frontend/package.json', JSON.stringify({
      devDependencies: { jest: '^29.7.0' },
    }));
    await writeFixture(fixtureRoot, 'backend/AGENTS.md', 'Verification: run jest before closeout.');

    const result = await discoverRepositoryMechanisms(fixtureRoot);

    expect(result.mechanisms).toEqual([{
      kind: 'jest',
      executable: 'npm',
      args: ['exec', '--', 'jest', '--runInBand'],
      cwd: await fs.realpath(path.join(fixtureRoot, 'frontend')),
      discoveredFrom: ['frontend/package.json'],
      confidence: 0.9,
    }]);
    expect(result.inspectedPaths).toEqual(['backend/AGENTS.md', 'frontend/package.json']);
  });

  test('returns an honest unavailable result when no supported framework is evidenced', async () => {
    await writeFixture(fixtureRoot, 'package.json', JSON.stringify({ scripts: { build: 'tsc' } }));
    await writeFixture(fixtureRoot, 'README.md', '# Unknown project');

    await expect(discoverRepositoryMechanisms(fixtureRoot)).resolves.toEqual({
      available: false,
      mechanisms: [],
      inspectedPaths: ['package.json'],
      reason: 'no-supported-verification-mechanism',
    });
  });

  test('does not traverse symlinked directories or report evidence outside the workspace', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rorca-mechanism-outside-'));
    try {
      await writeFixture(outside, 'package.json', JSON.stringify({
        scripts: { test: 'jest' },
        devDependencies: { jest: '^29.7.0' },
      }));
      await fs.symlink(outside, path.join(fixtureRoot, 'linked-outside'), 'dir');

      const result = await discoverRepositoryMechanisms(fixtureRoot);

      expect(result.available).toBe(false);
      expect(result.mechanisms).toEqual([]);
      expect(result.inspectedPaths).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
