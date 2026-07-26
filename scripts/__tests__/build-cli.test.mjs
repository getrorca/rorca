#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');
const backendSource = path.join(root, 'backend/src');
const cliOutput = path.join(root, 'bin/rorca.js');

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceShadows() {
  const shadows = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js') && fs.existsSync(`${absolute.slice(0, -3)}.ts`)) {
        shadows.push(path.relative(backendSource, absolute).replaceAll(path.sep, '/'));
      }
    }
  };
  visit(backendSource);
  return shadows.sort();
}

test('CLI typecheck/build is deterministic, executable, and cannot regenerate backend source shadows', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(packageJson.scripts.typecheck, /tsc --project bin\/tsconfig\.json --noEmit/);
  assert.match(packageJson.scripts.build, /npm run build:cli/);
  assert.doesNotMatch(packageJson.scripts.build, /tsc --project bin\/tsconfig\.json(?! --noEmit)/);

  const before = sourceShadows();
  assert.deepEqual(before, ['lib/context-safety.js']);
  execFileSync('npx', ['tsc', '--project', 'bin/tsconfig.json', '--noEmit'], { cwd: root, stdio: 'pipe' });
  execFileSync('npm', ['run', 'build:cli'], { cwd: root, stdio: 'pipe' });
  const first = sha256(cliOutput);
  execFileSync('npm', ['run', 'build:cli'], { cwd: root, stdio: 'pipe' });
  assert.equal(sha256(cliOutput), first, 'two CLI builds must be byte-identical');
  assert.deepEqual(sourceShadows(), before, 'CLI typecheck/build regenerated a backend source shadow');

  const help = execFileSync(process.execPath, [cliOutput, '--help'], { cwd: root, encoding: 'utf8' });
  assert.match(help, /^Usage: rorca/m);
  assert.equal((help.match(/^  capture\s/mg) ?? []).length, 1, 'CLI must register the canonical capture alias exactly once');
  const output = fs.readFileSync(cliOutput, 'utf8');
  assert.doesNotMatch(output, /\.\.\/backend\/src\//);
  assert.doesNotMatch(output, /^\/\/ \.\.\/[^/\n]+\/node_modules\//m, 'CLI output must not encode a sibling worktree dependency path');
});
