#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsx = path.join(root, 'backend', 'node_modules', '.bin', 'tsx');
const checker = path.join(root, 'scripts', 'check-opencore-export.ts');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(cwd, ...args) {
  return spawnSync(tsx, [checker, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

test('candidate boundary mode scans dirty bytes before commit and the exact commit when clean', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-opencore-candidate-'));
  try {
    fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'config', 'open-core-boundaries.json'), JSON.stringify({
      shareable: [{ path: 'candidate.txt', reason: 'test candidate' }],
      review: [],
      blocked: [],
    }));
    fs.writeFileSync(path.join(repo, 'candidate.txt'), 'parent\n');
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'candidate@example.test');
    git(repo, 'config', 'user.name', 'Candidate Test');
    git(repo, 'add', '.');
    git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'parent');

    fs.writeFileSync(path.join(repo, 'candidate.txt'), 'dirty candidate\n');
    const dirty = run(repo, '--candidate');
    assert.equal(dirty.status, 0, dirty.stderr);
    assert.match(dirty.stdout, /files scanned: 1/);
    assert.match(dirty.stdout, /candidate\.txt/);

    git(repo, 'add', 'candidate.txt');
    git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'candidate');
    const clean = run(repo, '--candidate');
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /files scanned: 1/);
    assert.match(clean.stdout, /candidate\.txt/);

    const cleanWorktreeOnly = run(repo, '--worktree');
    assert.equal(cleanWorktreeOnly.status, 3);
    assert.match(cleanWorktreeOnly.stderr, /No changed files/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
