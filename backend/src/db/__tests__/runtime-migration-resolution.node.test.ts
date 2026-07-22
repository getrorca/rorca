// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import path from 'node:path';
import ts from 'typescript';

const backendRoot = path.resolve(import.meta.dirname, '../../..');
const srcRoot = path.join(backendRoot, 'src');

test('production tsx launch profile resolves the locked migration replay implementation', () => {
  const probe = `
    import { prepareLiteSkippedMigrationsForReplay } from './src/db/pg-index';
    const calls = [];
    const client = {
      async query(sql) {
        const text = String(sql).replace(/\\s+/g, ' ').trim();
        calls.push(text);
        return { rows: text.includes('SELECT version::text') ? [] : [] };
      },
      release() {},
    };
    const pool = { connect: async () => client, end: async () => {} };
    prepareLiteSkippedMigrationsForReplay(pool)
      .then(() => process.stdout.write(JSON.stringify(calls)))
      .catch((error) => { console.error(error); process.exitCode = 1; });
  `;

  const stdout = execFileSync(process.execPath, [
    path.join(backendRoot, 'node_modules/tsx/dist/cli.mjs'),
    '--eval',
    probe,
  ], {
    cwd: backendRoot,
    encoding: 'utf8',
  });
  const calls = JSON.parse(stdout) as string[];

  assert.match(calls[0] ?? '', /pg_advisory_lock/);
  assert.equal(calls[1], 'BEGIN');
  assert.ok(calls.some((sql) => /SELECT version::text[\s\S]*FOR UPDATE/.test(sql)));
  assert.ok(calls.includes('COMMIT'));
  assert.match(calls.at(-1) ?? '', /pg_advisory_unlock/);
});

test('production source has no unsynchronized JavaScript shadows', () => {
  const shadows: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === '__mocks__') continue;
        visit(absolute);
      } else if (entry.isFile() && entry.name.endsWith('.js') && fs.existsSync(absolute.slice(0, -3) + '.ts')) {
        shadows.push(path.relative(srcRoot, absolute));
      }
    }
  };
  visit(srcRoot);
  shadows.sort();

  // This ESM artifact is intentionally shipped for extension consumers. It is
  // deterministic compiler output and therefore cannot drift from its TS source.
  assert.deepEqual(shadows, ['lib/context-safety.js']);
  const sourcePath = path.join(srcRoot, 'lib/context-safety.ts');
  const generatedPath = path.join(srcRoot, 'lib/context-safety.js');
  const generated = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    fileName: sourcePath,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
  assert.equal(fs.readFileSync(generatedPath, 'utf8'), generated, 'packaged context-safety.js drifted from TypeScript');
});
