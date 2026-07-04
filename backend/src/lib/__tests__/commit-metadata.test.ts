/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractCommitMetadata } from '../commit-metadata';
import { NotFoundError } from '../errors';

const tmpRoots: string[] = [];

function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-commit-metadata-'));
  tmpRoots.push(repo);
  git(repo, ['init']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['config', 'user.name', 'Rorca Tester']);
  git(repo, ['config', 'user.email', 'tester@example.com']);
  return repo;
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(repo: string, relativePath: string, content: string): void {
  const filePath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function remove(repo: string, relativePath: string): void {
  fs.rmSync(path.join(repo, relativePath), { force: true });
}

function commit(repo: string, subject: string, body?: string): string {
  git(repo, ['add', '-A']);
  const args = ['commit', '-m', subject];
  if (body) args.push('-m', body);
  git(repo, args);
  return git(repo, ['rev-parse', 'HEAD']);
}

afterAll(() => {
  for (const root of tmpRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('extractCommitMetadata', () => {
  it('extracts HEAD and arbitrary SHA with redacted bounded summaries', async () => {
    const repo = initRepo();
    write(repo, 'src/app.ts', 'export const value = 1;\n');
    const firstSha = commit(repo, 'feat: initial app');

    write(repo, 'src/app.ts', 'export const value = 2;\nconst API_TOKEN = "ghp_123456789012345678901234567890";\n');
    const headSha = commit(repo, 'feat: update app', 'API_KEY=super-secret-value');

    const head = await extractCommitMetadata({ workspacePath: repo, ref: 'HEAD', ignore: { maxEventBytes: 4096 } });
    expect(head.sha).toBe(headSha);
    expect(head.ref).toBe('HEAD');
    expect(head.branch).toBe('main');
    expect(head.author).toEqual({ name: 'Rorca Tester', email: 'tester@example.com' });
    expect(head.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(head.subject).toBe('feat: update app');
    expect(head.body).toContain('[REDACTED_SECRET_ASSIGNMENT]');
    expect(head.changedFiles).toEqual([{ path: 'src/app.ts', status: 'modified', sizeBytes: expect.any(Number) }]);
    expect(head.diffSummary.fullDiffPersisted).toBe(false);
    expect(head.diffSummary.byteLength).toBeLessThanOrEqual(head.diffSummary.maxBytes);
    expect(head.diffSummary.text).not.toContain('ghp_123456789012345678901234567890');
    expect(head.diffSummary.text).toContain('[REDACTED');

    const first = await extractCommitMetadata({ workspacePath: repo, ref: firstSha });
    expect(first.sha).toBe(firstSha);
    expect(first.subject).toBe('feat: initial app');
    expect(first.changedFiles).toEqual([{ path: 'src/app.ts', status: 'added', sizeBytes: expect.any(Number) }]);
  });

  it('uses first-parent diffs for merge commits', async () => {
    const repo = initRepo();
    write(repo, 'src/base.ts', 'export const base = true;\n');
    commit(repo, 'feat: base');

    git(repo, ['checkout', '-b', 'feature/context']);
    write(repo, 'src/feature.ts', 'export const feature = true;\n');
    const featureSha = commit(repo, 'feat: feature branch');

    git(repo, ['checkout', 'main']);
    write(repo, 'src/main.ts', 'export const main = true;\n');
    commit(repo, 'feat: main branch');

    git(repo, ['merge', '--no-ff', 'feature/context', '-m', 'merge: feature context']);
    const merge = await extractCommitMetadata({ workspacePath: repo, ref: 'HEAD' });

    expect(merge.isMergeCommit).toBe(true);
    expect(merge.parents).toHaveLength(2);
    expect(merge.subject).toBe('merge: feature context');
    expect(merge.changedFiles.map((file) => file.path)).toEqual(['src/feature.ts']);
    expect(merge.diffSummary.text).toContain('src/feature.ts');
    expect(merge.diffSummary.text).not.toContain(featureSha);
  });

  it('captures renamed and deleted files safely', async () => {
    const repo = initRepo();
    write(repo, 'src/old-name.ts', 'export const oldName = true;\n');
    write(repo, 'src/remove-me.ts', 'export const removeMe = true;\n');
    commit(repo, 'feat: files to move');

    git(repo, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
    remove(repo, 'src/remove-me.ts');
    commit(repo, 'refactor: rename and delete files');

    const metadata = await extractCommitMetadata({ workspacePath: repo, ref: 'HEAD' });
    expect(metadata.changedFiles).toEqual(expect.arrayContaining([
      { path: 'src/new-name.ts', previousPath: 'src/old-name.ts', status: 'renamed', sizeBytes: expect.any(Number) },
      { path: 'src/remove-me.ts', status: 'deleted', sizeBytes: null },
    ]));
  });

  it('applies .gitignore, .rorca-captureignore, workspace path normalization, and size caps', async () => {
    const repo = initRepo();
    write(repo, '.gitignore', 'ignored/\n');
    write(repo, '.rorca-captureignore', 'capture-secret.txt\n');
    commit(repo, 'chore: add capture ignore rules');

    write(repo, 'ignored/from-gitignore.txt', 'ignored by gitignore\n');
    write(repo, 'capture-secret.txt', 'ignored by captureignore\n');
    write(repo, 'src/keep.txt', 'ok\n');
    write(repo, 'src/big.txt', 'x'.repeat(128));
    git(repo, ['add', '-f', 'ignored/from-gitignore.txt', 'capture-secret.txt']);
    git(repo, ['add', 'src/keep.txt', 'src/big.txt']);
    git(repo, ['commit', '-m', 'feat: mixed capture paths']);

    const metadata = await extractCommitMetadata({ workspacePath: repo, ref: 'HEAD', ignore: { maxFileBytes: 16 } });

    expect(metadata.changedFiles).toEqual([{ path: 'src/keep.txt', status: 'added', sizeBytes: 3 }]);
    expect(metadata.changedFiles.every((file) => !path.isAbsolute(file.path) && !file.path.startsWith('..'))).toBe(true);
    expect(metadata.omittedChangedFiles).toEqual(expect.arrayContaining([
      { path: 'ignored/from-gitignore.txt', status: 'added', reason: 'ignored' },
      { path: 'capture-secret.txt', status: 'added', reason: 'ignored' },
      { path: 'src/big.txt', status: 'added', reason: 'too_large', sizeBytes: 128 },
    ]));
    expect(metadata.diffSummary.text).toContain('src/keep.txt');
    expect(metadata.diffSummary.text).not.toContain('capture-secret.txt');
    expect(metadata.diffSummary.text).not.toContain('src/big.txt');
  });

  it('flags formatting-only, lockfile-only, generated-only, and dependency churn as non-durable', async () => {
    const repo = initRepo();
    write(repo, 'src/format.ts', 'const value=1\n');
    commit(repo, 'feat: add formatted file');

    write(repo, 'src/format.ts', 'const value = 1;\n');
    commit(repo, 'style: format only');
    const formatting = await extractCommitMetadata({ workspacePath: repo, ref: 'HEAD' });
    expect(formatting.lessonHeuristics.noise.formattingOnly).toBe(true);
    expect(formatting.lessonHeuristics.shouldCreateMemory).toBe(false);

    write(repo, 'package-lock.json', '{"lockfileVersion":3}\n');
    commit(repo, 'chore: update package lock');
    const lockfile = await extractCommitMetadata({ workspacePath: repo, ref: 'HEAD' });
    expect(lockfile.lessonHeuristics.noise.lockfileOnly).toBe(true);
    expect(lockfile.lessonHeuristics.shouldCreateMemory).toBe(false);

    write(repo, 'dist/app.min.js', 'function minified(){return 1}\n');
    git(repo, ['add', '-f', 'dist/app.min.js']);
    git(repo, ['commit', '-m', 'chore: generated dist output']);
    const generated = await extractCommitMetadata({ workspacePath: repo, ref: 'HEAD' });
    expect(generated.changedFiles).toEqual([]);
    expect(generated.lessonHeuristics.noise.generatedFileOnly).toBe(true);
    expect(generated.lessonHeuristics.shouldCreateMemory).toBe(false);

    write(repo, 'package.json', '{"dependencies":{"left-pad":"1.3.0"}}\n');
    commit(repo, 'chore: bump deps');
    const deps = await extractCommitMetadata({ workspacePath: repo, ref: 'HEAD' });
    expect(deps.lessonHeuristics.noise.dependencyChurn).toBe(true);
    expect(deps.lessonHeuristics.shouldCreateMemory).toBe(false);
  });

  it('allows noisy commits when security or incident signals are present', async () => {
    const repo = initRepo();
    write(repo, 'package-lock.json', '{"lockfileVersion":3}\n');
    commit(repo, 'security: fix CVE-2026-1234 dependency issue');

    const metadata = await extractCommitMetadata({ workspacePath: repo, ref: 'HEAD' });
    expect(metadata.lessonHeuristics.noise.lockfileOnly).toBe(true);
    expect(metadata.lessonHeuristics.override.incidentRelevant).toBe(true);
    expect(metadata.lessonHeuristics.shouldCreateMemory).toBe(true);
  });

  it('throws NotFoundError for invalid commit refs', async () => {
    const repo = initRepo();
    write(repo, 'README.md', '# Test\n');
    commit(repo, 'docs: initial readme');

    await expect(extractCommitMetadata({ workspacePath: repo, ref: 'not-a-real-sha' })).rejects.toMatchObject({
      name: 'NotFoundError',
      statusCode: 404,
      code: 'NOT_FOUND',
    } satisfies Partial<NotFoundError>);
  });
});
