/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Tests for commit-metadata.ts (US-028).
 *
 * Uses temp git repos created with execFileSync('git', …) to avoid dependency
 * on the host repo state. Each describe block initialises a fresh repo, makes
 * commits, and tears down afterward.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { extractCommitMetadata, extractHeadMetadata } from '../commit-metadata';
import { createIgnoreMatcher } from '../context-safety';


// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-commit-meta-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Rorca Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  return dir;
}

function commitFile(repo: string, filePath: string, content: string, message: string): string {
  const absPath = path.join(repo, filePath);
  const parent = path.dirname(absPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(absPath, content);
  git(repo, ['add', filePath]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}


function cleanupRepo(repo: string): void {
  fs.rmSync(repo, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

describe('extractCommitMetadata — normal commit', () => {
  let repo = '';
  let firstSha = '';
  let sha = '';

  beforeAll(() => {
    repo = initRepo();
    firstSha = commitFile(repo, 'src/initial.ts', 'export const z = 0;\n', 'feat: initial');
    sha = commitFile(repo, 'src/index.ts', 'export const x = 1;\n', 'feat: add index');
  });

  afterAll(() => cleanupRepo(repo));

  test('extracts SHA correctly', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.sha).toBe(sha);
    expect(result.sha).toHaveLength(40);
  });

  test('extracts branch name', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.branch).toBeTruthy();
  });

  test('extracts author name and email', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.author.name).toBe('Rorca Test');
    expect(result.author.email).toBe('test@example.com');
  });

  test('extracts ISO-8601 timestamp', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test('extracts message subject and body', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.message.subject).toBe('feat: add index');
    expect(result.message.body).toBe('');
  });

  test('extracts single parent (second commit has one parent)', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.parents).toHaveLength(1);
    expect(result.parents[0]).toHaveLength(40);
    expect(result.parents[0]).toBe(firstSha);
  });

  test('extracts changed files', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file.path).toBe('src/index.ts');
    expect(file.status).toBe('added');
    expect(file.additions).toBeGreaterThanOrEqual(1);
    expect(file.oldPath).toBeUndefined();
  });

  test('extracts diff stats', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.diffStats.filesChanged).toBe(1);
    expect(result.diffStats.insertions).toBeGreaterThanOrEqual(1);
  });

  test('does not include excerpt by default', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.excerpt).toBeUndefined();
  });

  test('extractHeadMetadata shorthand works', async () => {
    const result = await extractHeadMetadata(repo);
    expect(result.sha).toHaveLength(40);
    expect(result.author.name).toBe('Rorca Test');
  });

  test('arbitrary SHA works', async () => {
    // Extract the first commit by its SHA
    const result = await extractCommitMetadata(repo, { sha: firstSha });
    expect(result.sha).toBe(firstSha);
    expect(result.message.subject).toBe('feat: initial');
  });
});

// ── Renames & deletes ──────────────────────────────────────────────────────

describe('extractCommitMetadata — rename and delete', () => {
  let repo = '';
  let renameSha = '';
  let deleteSha = '';

  beforeAll(() => {
    repo = initRepo();
    commitFile(repo, 'old.ts', '// old file\n', 'feat: initial old file');
    // Rename
    fs.renameSync(path.join(repo, 'old.ts'), path.join(repo, 'new.ts'));
    git(repo, ['add', 'old.ts', 'new.ts']);
    git(repo, ['commit', '-m', 'refactor: rename old.ts to new.ts']);
    renameSha = git(repo, ['rev-parse', 'HEAD']);
    // Delete
    fs.unlinkSync(path.join(repo, 'new.ts'));
    git(repo, ['add', 'new.ts']);
    git(repo, ['commit', '-m', 'chore: remove new.ts']);
    deleteSha = git(repo, ['rev-parse', 'HEAD']);
  });

  afterAll(() => cleanupRepo(repo));

  test('rename commit shows oldPath and status renamed', async () => {
    const result = await extractCommitMetadata(repo, { sha: renameSha });
    expect(result.message.subject).toContain('rename');
    // A rename should have a file with status 'renamed' or oldPath present
    const renamed = result.files.find((f) => f.status === 'renamed' || f.oldPath);
    expect(renamed).toBeDefined();
    if (renamed) {
      expect(renamed.path).toBe('new.ts');
      if (renamed.oldPath) expect(renamed.oldPath).toBe('old.ts');
    }
  });

  test('delete commit shows status deleted', async () => {
    const result = await extractCommitMetadata(repo, { sha: deleteSha });
    expect(result.message.subject).toContain('remove');
    const deleted = result.files.find((f) => f.status === 'deleted');
    expect(deleted).toBeDefined();
    if (deleted) {
      expect(deleted.path).toBe('new.ts');
      expect(deleted.additions).toBe(0);
      expect(deleted.deletions).toBeGreaterThanOrEqual(1);
    }
  });
});

// ── Merge commits ──────────────────────────────────────────────────────────

describe('extractCommitMetadata — merge commit', () => {
  let repo = '';
  let mergeSha = '';

  beforeAll(() => {
    repo = initRepo();
    commitFile(repo, 'main.ts', '// main\n', 'feat: main file');
    // Create a topic branch
    git(repo, ['checkout', '-b', 'topic']);
    commitFile(repo, 'topic.ts', '// topic\n', 'feat: topic file');
    const topicHead = git(repo, ['rev-parse', 'HEAD']);
    // Back to main and merge
    git(repo, ['checkout', 'main']);
    git(repo, ['merge', '--no-ff', '-m', 'merge: topic into main', topicHead]);
    mergeSha = git(repo, ['rev-parse', 'HEAD']);
  });

  afterAll(() => cleanupRepo(repo));

  test('merge commit has two parents', async () => {
    const result = await extractCommitMetadata(repo, { sha: mergeSha });
    expect(result.parents.length).toBeGreaterThanOrEqual(2);
  });

  test('merge commit message is preserved', async () => {
    const result = await extractCommitMetadata(repo, { sha: mergeSha });
    expect(result.message.subject).toContain('merge');
  });

  test('merge commit lists changed files from the topic branch', async () => {
    const result = await extractCommitMetadata(repo, { sha: mergeSha });
    const topicFile = result.files.find((f) => f.path === 'topic.ts');
    expect(topicFile).toBeDefined();
    if (topicFile) expect(topicFile.status).toBe('added');
  });
});

// ── Initial commit (no parents) ────────────────────────────────────────────

describe('extractCommitMetadata — initial commit', () => {
  let repo = '';
  let sha = '';

  beforeAll(() => {
    repo = initRepo();
    sha = commitFile(repo, 'README.md', '# Project\n', 'chore: initial commit');
  });

  afterAll(() => cleanupRepo(repo));

  test('initial commit has zero parents', async () => {
    // The first real file commit will have 0 parents
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.parents).toHaveLength(0);
  });

  test('initial commit with excerpt works gracefully', async () => {
    const result = await extractCommitMetadata(repo, { sha, includeExcerpt: true });
    expect(result.excerpt).toBeDefined();
    expect(typeof result.excerpt).toBe('string');
    // Should not crash or produce empty string
    expect(result.excerpt!.length).toBeGreaterThan(0);
  });
});

// ── Ignore rules ───────────────────────────────────────────────────────────

describe('extractCommitMetadata — ignore rules', () => {
  let repo = '';
  let sha = '';

  beforeAll(() => {
    repo = initRepo();
    // Create all files and commit them together so the commit diff includes them all
    const files: Record<string, string> = {
      'src/index.ts': 'export const x = 1;\n',
      'dist/bundle.js': 'console.log("built");\n',
      'node_modules/dep/index.js': 'module.exports = {};\n',
      'README.md': '# readme\n',
    };
    for (const [fp, content] of Object.entries(files)) {
      const abs = path.join(repo, fp);
      const parent = path.dirname(abs);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(abs, content);
      git(repo, ['add', fp]);
    }
    git(repo, ['commit', '-m', 'feat: add all files']);
    sha = git(repo, ['rev-parse', 'HEAD']);
  });

  afterAll(() => cleanupRepo(repo));

  test('returns all files when no ignore matcher is provided', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain('dist/bundle.js');
    expect(paths).toContain('node_modules/dep/index.js');
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('README.md');
    expect(result.diffStats.filesChanged).toBe(4);
  });

  test('filters files through an ignore matcher', async () => {
    const ignoreMatcher = createIgnoreMatcher({
      extraPatterns: ['dist/', 'node_modules/'],
    });
    const result = await extractCommitMetadata(repo, { sha, ignoreMatcher });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain('src/index.ts');
    expect(paths).toContain('README.md');
    expect(paths).not.toContain('dist/bundle.js');
    expect(paths).not.toContain('node_modules/dep/index.js');
  });

  test('diff stats still include unfiltered counts', async () => {
    const ignoreMatcher = createIgnoreMatcher({
      extraPatterns: ['dist/', 'node_modules/'],
    });
    const result = await extractCommitMetadata(repo, { sha, ignoreMatcher });
    // files list is filtered
    expect(result.files.length).toBeLessThan(result.diffStats.filesChanged);
    // diffStats.filesChanged is the unfiltered count
    expect(result.diffStats.filesChanged).toBe(4);
  });
});

// ── Error cases ────────────────────────────────────────────────────────────

describe('extractCommitMetadata — error cases', () => {
  test('throws for non-git directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-non-git-'));
    try {
      await expect(extractCommitMetadata(dir)).rejects.toThrow(/Not a git repository/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws for invalid SHA in a valid repo', async () => {
    const repo = initRepo();
    commitFile(repo, 'file.ts', '// content\n', 'feat: file');
    try {
      await expect(
        extractCommitMetadata(repo, { sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
      ).rejects.toThrow(/Invalid SHA/);
    } finally {
      cleanupRepo(repo);
    }
  });
});

// ── Excerpt inclusion ──────────────────────────────────────────────────────

describe('extractCommitMetadata — excerpt', () => {
  let repo = '';
  let sha = '';

  beforeAll(() => {
    repo = initRepo();
    commitFile(
      repo,
      'src/auth.ts',
      'const API_KEY = "sk-ant-secret-key-12345678901234567890";\nexport function auth() { return API_KEY; }\n',
      'feat: add auth',
    );
    sha = git(repo, ['rev-parse', 'HEAD']);
  });

  afterAll(() => cleanupRepo(repo));

  test('includes excerpt when requested', async () => {
    const result = await extractCommitMetadata(repo, { sha, includeExcerpt: true });
    expect(result.excerpt).toBeDefined();
    expect(result.excerpt!.length).toBeGreaterThan(0);
  });

  test('excerpt does not contain raw API key (redacted)', async () => {
    const result = await extractCommitMetadata(repo, { sha, includeExcerpt: true });
    expect(result.excerpt).toBeDefined();
    // The secret should be redacted
    expect(result.excerpt!).not.toMatch(/sk-ant-secret/);
    expect(result.excerpt!).toContain('[REDACTED]');
  });

  test('excerpt is bounded by maxExcerptBytes', async () => {
    const result = await extractCommitMetadata(repo, {
      sha,
      includeExcerpt: true,
      maxExcerptBytes: 100,
    });
    expect(result.excerpt).toBeDefined();
    const bytes = Buffer.byteLength(result.excerpt!, 'utf8');
    expect(bytes).toBeLessThanOrEqual(120); // small buffer for redaction overhead
  });
});

// ── Message with body ──────────────────────────────────────────────────────

describe('extractCommitMetadata — message with body', () => {
  let repo = '';
  let sha = '';

  beforeAll(() => {
    repo = initRepo();
    const absPath = path.join(repo, 'file.ts');
    fs.writeFileSync(absPath, '// content\n');
    git(repo, ['add', 'file.ts']);
    git(repo, [
      'commit',
      '-m',
      'feat: add file with body',
      '-m',
      'This is the body of the commit message.\nIt spans multiple lines.',
    ]);
    sha = git(repo, ['rev-parse', 'HEAD']);
  });

  afterAll(() => cleanupRepo(repo));

  test('splits subject and multi-line body correctly', async () => {
    const result = await extractCommitMetadata(repo, { sha });
    expect(result.message.subject).toBe('feat: add file with body');
    expect(result.message.body).toContain('This is the body');
    expect(result.message.body).toContain('multiple lines');
  });
});
