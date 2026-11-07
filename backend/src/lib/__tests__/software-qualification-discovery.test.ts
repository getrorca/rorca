/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSoftwareQualificationChecks } from '../mechanism-discovery';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-qualification-discovery-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('discovers every supported repository-owned category without creating shell execution', async () => {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      lint: 'eslint .',
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      'test:e2e': 'playwright test',
      'test:performance': 'k6 run performance.js',
      security: 'npm audit --audit-level=high',
      build: 'vite build',
      package: 'npm pack --dry-run',
      smoke: 'node smoke.js',
      unsafe: 'echo safe && curl https://example.invalid',
    },
  }));
  fs.mkdirSync(path.join(root, 'backend'));
  fs.writeFileSync(path.join(root, 'backend', 'package.json'), JSON.stringify({
    scripts: { 'test:integration': 'jest integration --runInBand' },
  }));

  const result = await discoverSoftwareQualificationChecks(root);

  expect(result.availableCategories).toEqual([
    'lint', 'typecheck', 'unit', 'integration', 'e2e',
    'performance', 'security', 'build', 'package', 'smoke',
  ]);
  expect(result.checks).toHaveLength(10);
  expect(result.checks.some((check) => check.executable === 'npm' && check.args[0] === 'run')).toBe(false);
  expect(result.checks.some((check) => check.label.endsWith('unsafe'))).toBe(false);
  expect(result.checks.find((check) => check.category === 'integration')).toMatchObject({
    cwd: fs.realpathSync(path.join(root, 'backend')),
    executable: 'jest',
    args: ['integration', '--runInBand'],
  });
});

test('reports unavailable categories instead of inferring missing verification passed', async () => {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));

  const result = await discoverSoftwareQualificationChecks(root);

  expect(result.availableCategories).toEqual(['unit']);
  expect(result.unavailableCategories).toContain('security');
  expect(result.unavailableCategories).toContain('e2e');
});

test('excludes interactive and operational scripts while synthesizing bounded Playwright security', async () => {
  fs.mkdirSync(path.join(root, 'e2e', 'security'), { recursive: true });
  fs.writeFileSync(path.join(root, 'e2e', 'security', 'auth.spec.ts'), 'export {};');
  fs.writeFileSync(path.join(root, 'playwright.config.ts'), 'export default {};');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      'test:unit': 'vitest run',
      'test:unit:watch': 'vitest --watch',
      'test:e2e': 'playwright test',
      'test:e2e:ui': 'playwright test --ui',
      'test:e2e:headed': 'playwright test --headed',
      'test:smoke': 'node e2e/smoke.js',
      'ops:plaid-smoke': 'node e2e/smoke.js --production',
      deploy: 'node deploy.js',
    },
    devDependencies: { '@playwright/test': '^1.50.0' },
  }));

  const result = await discoverSoftwareQualificationChecks(root);

  expect(result.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
    'package:.:test:unit',
    'package:.:test:e2e',
    'package:.:test:smoke',
    'playwright-security:.',
  ]));
  expect(result.checks.some((check) => /watch|ui|headed|ops:|deploy/.test(check.id))).toBe(false);
  expect(result.checks.find((check) => check.id === 'playwright-security:.')).toMatchObject({
    category: 'security',
    executable: 'npx',
    args: ['--no-install', 'playwright', 'test', 'e2e/security/'],
    controlIds: ['CTRL-TESTING-THREAT-AUTHZ-SECRETS'],
    discoveredFrom: expect.arrayContaining(['e2e/security/', 'package.json', 'playwright.config.ts']),
  });
});
