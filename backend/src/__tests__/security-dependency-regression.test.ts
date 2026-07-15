/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';

type Lockfile = {
  packages: Record<string, { version?: string }>;
};

const lock = JSON.parse(readFileSync(path.resolve('package-lock.json'), 'utf8')) as Lockfile;

function installedVersions(packageName: string): string[] {
  const suffix = `node_modules/${packageName}`;
  return Object.entries(lock.packages)
    .filter(([location, entry]) => (location === suffix || location.endsWith(`/${suffix}`)) && entry.version)
    .map(([, entry]) => entry.version!)
    .sort();
}

function expectAtLeast(actual: string, minimum: string): void {
  const parts = (value: string) => value.split('-')[0].split('.').map(Number);
  const left = parts(actual);
  const right = parts(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference > 0) return;
    if (difference < 0) throw new Error(`Expected ${actual} to be at least ${minimum}`);
  }
}

function expectEveryVersionAtLeast(packageName: string, minimum: string): void {
  const versions = installedVersions(packageName);
  expect(versions.length).toBeGreaterThan(0);
  versions.forEach((version) => expectAtLeast(version, minimum));
}

describe('backend critical/high dependency floors', () => {
  it.each([
    ['simple-git', '3.36.0'],
    ['multer', '2.2.0'],
    ['nodemailer', '9.0.1'],
    ['@playwright/mcp', '0.0.78'],
    ['playwright', '1.55.1'],
    ['handlebars', '4.7.9'],
    ['shell-quote', '1.8.4'],
    ['@xmldom/xmldom', '0.8.13'],
    ['@hono/node-server', '1.19.13'],
    ['hono', '4.12.25'],
    ['express-rate-limit', '8.5.1'],
    ['fast-uri', '3.1.2'],
    ['flatted', '3.4.2'],
    ['form-data', '4.0.6'],
  ])('keeps %s on a remediated release', (packageName, minimum) => {
    expectEveryVersionAtLeast(packageName, minimum);
  });

  it('keeps both supported ws major lines above the fragment-DoS floors', () => {
    const versions = installedVersions('ws');
    expect(versions.length).toBeGreaterThan(0);
    versions.forEach((version) => {
      expectAtLeast(version, version.startsWith('7.') ? '7.5.11' : '8.21.0');
    });
  });

  it('keeps vulnerable matcher and router major lines above their fixed patch', () => {
    installedVersions('minimatch').forEach((version) => {
      if (version.startsWith('3.')) expectAtLeast(version, '3.1.4');
    });
    installedVersions('picomatch').forEach((version) => {
      expectAtLeast(version, version.startsWith('2.') ? '2.3.2' : '4.0.4');
    });
    installedVersions('path-to-regexp').forEach((version) => {
      expectAtLeast(version, version.startsWith('0.') ? '0.1.13' : '8.4.0');
    });
  });

  it('blocks case-insensitive protocol.allow overrides before Git can execute them', async () => {
    await expect(
      simpleGit().raw(['-c', 'PrOtOcOl.ExT.AlLoW=always', 'ls-remote', 'ext::false']),
    ).rejects.toThrow(/Configuring protocol\.allow is not permitted/i);
  });
});
