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

test('removing a blocked file is safe, adding one is not', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-opencore-removal-'));
  try {
    fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'private'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'config', 'open-core-boundaries.json'), JSON.stringify({
      shareable: [{ path: 'public.txt', reason: 'test shareable' }],
      review: [],
      blocked: [{ path: 'private/', reason: 'test blocked' }],
    }));
    fs.writeFileSync(path.join(repo, 'public.txt'), 'public\n');
    fs.writeFileSync(path.join(repo, 'private', 'secret.txt'), 'private\n');
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'removal@example.test');
    git(repo, 'config', 'user.name', 'Removal Test');
    git(repo, 'add', '.');
    git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'seed');

    // Removing a blocked path must not fail the export gate.
    fs.rmSync(path.join(repo, 'private', 'secret.txt'));
    git(repo, 'add', '-A');
    const removalOnly = run(repo, '--staged');
    assert.equal(removalOnly.status, 0, removalOnly.stderr);
    assert.match(removalOnly.stdout, /removed: 1/);
    assert.match(removalOnly.stdout, /blocked: 0/);
    assert.match(removalOnly.stdout, /private\/secret\.txt/);

    git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'drop private');

    // Adding a blocked path back must still fail.
    fs.writeFileSync(path.join(repo, 'private', 'secret.txt'), 'private again\n');
    git(repo, 'add', '-A');
    const readded = run(repo, '--staged');
    assert.equal(readded.status, 1, readded.stderr);
    assert.match(readded.stdout, /blocked: 1/);
    assert.match(readded.stderr, /Export is NOT safe/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('removing an unclassified file does not require a boundary rule', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-opencore-unknown-removal-'));
  try {
    fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'config', 'open-core-boundaries.json'), JSON.stringify({
      shareable: [{ path: 'public.txt', reason: 'test shareable' }],
      review: [],
      blocked: [],
    }));
    fs.writeFileSync(path.join(repo, 'public.txt'), 'public\n');
    fs.writeFileSync(path.join(repo, 'unclassified.txt'), 'no rule covers me\n');
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'unknown@example.test');
    git(repo, 'config', 'user.name', 'Unknown Removal Test');
    git(repo, 'add', '.');
    git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '-m', 'seed');

    // Deleting a path with no boundary rule is safe: it leaves the export set.
    fs.rmSync(path.join(repo, 'unclassified.txt'));
    git(repo, 'add', '-A');
    const removedUnknown = run(repo, '--staged');
    assert.equal(removedUnknown.status, 0, removedUnknown.stderr);
    assert.match(removedUnknown.stdout, /removed: 1/);
    assert.match(removedUnknown.stdout, /unknown: 0/);

    // But adding one back still needs a rule.
    fs.writeFileSync(path.join(repo, 'unclassified.txt'), 'back again\n');
    git(repo, 'add', '-A');
    const readdedUnknown = run(repo, '--staged');
    assert.equal(readdedUnknown.status, 1, readdedUnknown.stderr);
    assert.match(readdedUnknown.stdout, /unknown: 1/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
