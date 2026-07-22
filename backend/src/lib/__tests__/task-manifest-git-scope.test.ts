/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { changedFilesBetweenTaskManifestRevisions } from '../task-manifest-run-lineage';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-task-scope-git-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Rorca Tests']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'tests@rorca.local']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  return root;
}

function sha(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function commit(root: string, relative: string, content: string, message: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-qm', message]);
  return sha(root);
}

test('complete base-to-terminal inventory catches a forbidden unrecorded ancestor', () => {
  const root = repo();
  const base = sha(root);
  commit(root, 'forbidden/secret.txt', 'hidden ancestor\n', 'unrecorded forbidden ancestor');
  const terminal = commit(root, 'allowed/story.ts', 'export const ok = true;\n', 'recorded story commit');

  expect(changedFilesBetweenTaskManifestRevisions(root, base, terminal))
    .toEqual(['allowed/story.ts', 'forbidden/secret.txt']);
});

test('complete inventory includes merge-parent changes and rejects an invalid/rootless base', () => {
  const root = repo();
  const base = sha(root);
  execFileSync('git', ['-C', root, 'checkout', '-qb', 'side']);
  commit(root, 'forbidden/from-side.txt', 'side\n', 'side change');
  execFileSync('git', ['-C', root, 'checkout', '-q', 'main']);
  commit(root, 'allowed/main.ts', 'main\n', 'main change');
  execFileSync('git', ['-C', root, 'merge', '--no-ff', '-qm', 'merge side', 'side']);
  const terminal = sha(root);

  expect(changedFilesBetweenTaskManifestRevisions(root, base, terminal))
    .toEqual(['allowed/main.ts', 'forbidden/from-side.txt']);
  expect(() => changedFilesBetweenTaskManifestRevisions(root, '0'.repeat(40), terminal))
    .toThrow(/base|revision|ancestor/i);
});
