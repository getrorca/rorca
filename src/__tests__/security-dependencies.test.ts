/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type Lockfile = {
  packages: Record<string, { version?: string }>;
};

const require = createRequire(import.meta.url);
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

describe('root security dependency floors', () => {
  it.each([
    ['concurrently', '9.2.3'],
    ['react-router', '7.15.1'],
    ['react-router-dom', '7.15.1'],
    ['vite', '8.0.16'],
    ['undici', '7.28.0'],
  ])('keeps %s on a remediated release', (packageName, minimum) => {
    const versions = installedVersions(packageName);
    expect(versions.length).toBeGreaterThan(0);
    versions.forEach((version) => expectAtLeast(version, minimum));
  });

  it('does not auto-install the deprecated vulnerable Pi host through the extension peer', () => {
    expect(installedVersions('@mariozechner/pi-coding-agent')).toEqual([]);
  });

  it('rejects newline-bearing shell operator objects', () => {
    const shellQuote = require('shell-quote') as { quote(values: Array<string | { op: string }>): string };
    expect(() => shellQuote.quote([{ op: 'safe\nsecond-command' }])).toThrow(/invalid `op` value/i);
  });
});
