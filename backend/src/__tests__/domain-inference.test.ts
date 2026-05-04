/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { inferDomain } from '../lib/domain-inference';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'domain-inference-'));
}

function writeJson(dir: string, filename: string, obj: object) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(obj));
}

function writeFile(dir: string, filename: string, content: string) {
  fs.writeFileSync(path.join(dir, filename), content);
}

afterEach(() => {
  // Temp dirs cleaned by OS; no explicit cleanup needed for unit tests
});

describe('inferDomain', () => {
  it('React SaaS project → "saas"', async () => {
    const dir = makeTempDir();
    writeJson(dir, 'package.json', {
      dependencies: {
        next: '^14.0.0',
        react: '^18.0.0',
        'next-auth': '^4.0.0',
      },
      devDependencies: {},
    });
    const result = await inferDomain(dir);
    expect(result).toBe('saas');
  });

  it('CLI tool (commander.js) → "cli"', async () => {
    const dir = makeTempDir();
    writeJson(dir, 'package.json', {
      dependencies: {
        commander: '^11.0.0',
        chalk: '^5.0.0',
      },
      devDependencies: {},
    });
    const result = await inferDomain(dir);
    expect(result).toBe('cli');
  });

  it('mobile (react-native) → "mobile"', async () => {
    const dir = makeTempDir();
    writeJson(dir, 'package.json', {
      dependencies: {
        'react-native': '^0.73.0',
        react: '^18.0.0',
      },
      devDependencies: {},
    });
    const result = await inferDomain(dir);
    expect(result).toBe('mobile');
  });

  it('unrecognizable project → null', async () => {
    const dir = makeTempDir();
    writeJson(dir, 'package.json', {
      dependencies: {
        'some-unknown-library': '^1.0.0',
      },
      devDependencies: {},
    });
    const result = await inferDomain(dir);
    expect(result).toBeNull();
  });

  it('README keywords boost domain score', async () => {
    const dir = makeTempDir();
    writeJson(dir, 'package.json', { dependencies: {}, devDependencies: {} });
    writeFile(dir, 'README.md', 'This is a command-line tool for managing deployments.');
    const result = await inferDomain(dir);
    expect(result).toBe('cli');
  });

  it('directory names contribute to score', async () => {
    const dir = makeTempDir();
    writeJson(dir, 'package.json', { dependencies: {}, devDependencies: {} });
    fs.mkdirSync(path.join(dir, 'android'));
    fs.mkdirSync(path.join(dir, 'ios'));
    const result = await inferDomain(dir);
    expect(result).toBe('mobile');
  });
});
