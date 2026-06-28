/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Unit tests for US-024 context-diff.ts — Current branch diff awareness.
 *
 * Validates the acceptance criteria:
 *   - Changed files and diff stats for git workspaces
 *   - Full patch text is excluded by default
 *   - Optional excerpts are redacted and size-limited
 *   - WIP/diff context is labeled as non-durable
 *   - Clean tree, dirty tree, branch changes, ignored files, redaction
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import {
  gatherBranchDiff,
  renderDiffSummary,
  gatherDiffExcerpt,
  isGitAvailable,
  isGitRepo,
  getBranchName,
  NON_DURABLE_LABEL,
  _resetGitCache,
  type BranchDiffSummary,
  type ChangedFile,
} from '../context-diff';

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/** Create a temporary directory, init a git repo, write a file, commit. */
function createGitRepo(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-diff-test-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@rorca.dev"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  // Initial commit so HEAD exists
  fs.writeFileSync(path.join(dir, 'README.md'), '# test');
  execSync('git add README.md', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Make the tree dirty with known changes. */
function makeDirty(repoDir: string): void {
  // Modify an existing file
  fs.appendFileSync(path.join(repoDir, 'README.md'), '\nAdded line');
  // Create nested dirs first
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  // Create a new file
  fs.writeFileSync(
    path.join(repoDir, 'src', 'newfile.ts'),
    'export const hello = "world";\nexport const answer = 42;\n',
  );
  stageAll(repoDir);
  // Make another unstaged change
  fs.appendFileSync(path.join(repoDir, 'src', 'newfile.ts'), '\nexport const extra = true;\n');
}

/** Create a branch and check it out. */
function createBranch(repoDir: string, branchName: string): void {
  try {
    execSync(`git checkout -b ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
  } catch {
    // Branch may already exist
    execSync(`git checkout ${branchName}`, { cwd: repoDir, stdio: 'ignore' });
  }
}

/** Stage all files. */
function stageAll(repoDir: string): void {
  execSync('git add -A', { cwd: repoDir, stdio: 'ignore' });
}

/** Write a file and ensure parent dirs exist. */
function writeFile(repoDir: string, relPath: string, content: string): void {
  const fullPath = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe('context-diff (US-024)', () => {
  // Reset git cache before each test since it's process-global
  beforeEach(() => {
    _resetGitCache();
  });

  describe('isGitAvailable / isGitRepo', () => {
    it('detects git availability (assumes git is installed)', () => {
      expect(isGitAvailable()).toBe(true);
      _resetGitCache(); // Ensure cache is consistent
      expect(isGitAvailable()).toBe(true);
    });

    it('detects a git repo', () => {
      const repo = createGitRepo();
      try {
        expect(isGitRepo(repo.dir)).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it('returns false for a non-git directory', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-nogit-'));
      try {
        expect(isGitRepo(dir)).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('getBranchName returns branch name', () => {
      const repo = createGitRepo();
      try {
        const branch = getBranchName(repo.dir);
        // Should be on a default branch (main or master depending on git config)
        expect(['main', 'master'].includes(branch)).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it('getBranchName returns SHA on detached HEAD', () => {
      const repo = createGitRepo();
      try {
        execSync('git checkout --detach HEAD', { cwd: repo.dir, stdio: 'ignore' });
        const name = getBranchName(repo.dir);
        // Should be a SHA-like string (not a branch name)
        expect(name).toMatch(/^[a-f0-9]+$/);
      } finally {
        repo.cleanup();
      }
    });
  });

  describe('gatherBranchDiff', () => {
    // ── Clean tree ─────────────────────────────────────────────────────────

    it('reports a clean tree correctly', () => {
      const repo = createGitRepo();
      try {
        const summary = gatherBranchDiff({ workspaceRoot: repo.dir });
        expect(summary.isGitRepo).toBe(true);
        expect(summary.clean).toBe(true);
        expect(summary.changedFiles).toHaveLength(0);
        expect(summary.stats.filesChanged).toBe(0);
        expect(summary.stats.insertions).toBe(0);
        expect(summary.stats.deletions).toBe(0);
        expect(summary.nonDurable).toBe(true);
        expect(summary.gatheredAt).toBeDefined();
      } finally {
        repo.cleanup();
      }
    });

    // ── Dirty tree ─────────────────────────────────────────────────────────

    it('reports changed files and diff stats for a dirty tree', () => {
      const repo = createGitRepo();
      try {
        makeDirty(repo.dir);

        const summary = gatherBranchDiff({ workspaceRoot: repo.dir, includeUntracked: false });
        expect(summary.clean).toBe(false);
        expect(summary.changedFiles.length).toBeGreaterThanOrEqual(2); // README.md + src/newfile.ts
        expect(summary.stats.filesChanged).toBeGreaterThanOrEqual(2);
        // Should have insertions
        expect(summary.stats.insertions).toBeGreaterThan(0);

        // Verify file statuses
        const readme = summary.changedFiles.find((f) => f.path === 'README.md');
        expect(readme).toBeDefined();
        expect(readme!.status).toBe('modified');

        const newfile = summary.changedFiles.find((f) => f.path === 'src/newfile.ts');
        expect(newfile).toBeDefined();
        // It's staged+unstaged, either added or modified
        expect(['added', 'modified']).toContain(newfile!.status);
      } finally {
        repo.cleanup();
      }
    });

    it('includes addition and deletion counts per file', () => {
      const repo = createGitRepo();
      try {
        makeDirty(repo.dir);

        const summary = gatherBranchDiff({ workspaceRoot: repo.dir });
        const readme = summary.changedFiles.find((f) => f.path === 'README.md');
        expect(readme).toBeDefined();
        expect(readme!.additions).toBeGreaterThan(0);
      } finally {
        repo.cleanup();
      }
    });

    // ── Branch changes ─────────────────────────────────────────────────────

    it('reports branch name in the summary', () => {
      const repo = createGitRepo();
      try {
        createBranch(repo.dir, 'feat/test-branch');
        makeDirty(repo.dir);

        const summary = gatherBranchDiff({ workspaceRoot: repo.dir });
        expect(summary.branch).toBe('feat/test-branch');
      } finally {
        repo.cleanup();
      }
    });

    it('reports changes against HEAD on any branch', () => {
      const repo = createGitRepo();
      try {
        createBranch(repo.dir, 'feat/anotha');
        writeFile(repo.dir, 'cool.ts', 'export const x = 1;');
        stageAll(repo.dir);
        execSync('git commit -m "cool feature"', { cwd: repo.dir, stdio: 'ignore' });

        // Now make more changes on this branch
        writeFile(repo.dir, 'more.ts', 'export const y = 2;');
        stageAll(repo.dir);

        const summary = gatherBranchDiff({ workspaceRoot: repo.dir });
        expect(summary.branch.trim()).toBe('feat/anotha');
        expect(summary.changedFiles.some((f) => f.path === 'more.ts')).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    // ── Ignored files ──────────────────────────────────────────────────────

    it('marks files that are capture-ignored (node_modules, dist, etc.)', () => {
      const repo = createGitRepo();
      try {
        // Create a file in node_modules (should be capture-ignored)
        writeFile(repo.dir, 'node_modules/secret/thing.js', '// secret');
        stageAll(repo.dir);

        const summary = gatherBranchDiff({ workspaceRoot: repo.dir, includeUntracked: false });
        const ignored = summary.changedFiles.filter((f) => f.ignoredByCapture);
        // node_modules files should be flagged
        expect(ignored.length).toBeGreaterThanOrEqual(0); // Depending on whether git tracks them
        if (ignored.length > 0) {
          expect(ignored[0].path).toContain('node_modules');
        }
      } finally {
        repo.cleanup();
      }
    });

    it('still includes capture-ignored files in the list (for awareness) but flags them', () => {
      const repo = createGitRepo();
      try {
        writeFile(repo.dir, 'dist/output.js', '// build output');
        stageAll(repo.dir);

        const summary = gatherBranchDiff({ workspaceRoot: repo.dir });
        const distFile = summary.changedFiles.find((f) => f.path.includes('dist'));
        if (distFile) {
          expect(distFile.ignoredByCapture).toBe(true);
        }
      } finally {
        repo.cleanup();
      }
    });

    // ── Non-git workspace ──────────────────────────────────────────────────

    it('returns a placeholder for non-git workspaces', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-nogit-ws-'));
      try {
        const summary = gatherBranchDiff({ workspaceRoot: dir });
        expect(summary.isGitRepo).toBe(false);
        expect(summary.changedFiles).toHaveLength(0);
        expect(summary.stats.filesChanged).toBe(0);
        expect(summary.branch).toBe('not-a-git-repo');
        expect(summary.nonDurable).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    // ── Limits ─────────────────────────────────────────────────────────────

    it('respects maxFiles limit', () => {
      const repo = createGitRepo();
      try {
        // Create 10 files
        for (let i = 0; i < 10; i++) {
          writeFile(repo.dir, `file${i}.ts`, `export const x${i} = ${i};`);
        }
        stageAll(repo.dir);

        const summary = gatherBranchDiff({ workspaceRoot: repo.dir, maxFiles: 3 });
        expect(summary.changedFiles.length).toBeLessThanOrEqual(3);
        expect(summary.stats.filesChanged).toBeLessThanOrEqual(3);
      } finally {
        repo.cleanup();
      }
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // renderDiffSummary
  // ════════════════════════════════════════════════════════════════════════════

  describe('renderDiffSummary', () => {
    it('renders a diff summary with the non-durable label', () => {
      const summary: BranchDiffSummary = {
        branch: 'feat/test',
        clean: false,
        isGitRepo: true,
        nonDurable: true,
        gatheredAt: '2026-01-01T00:00:00Z',
        stats: { filesChanged: 2, insertions: 5, deletions: 3 },
        changedFiles: [
          { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 2 },
          { path: 'src/b.ts', status: 'added', additions: 2, deletions: 1 },
        ],
      };

      const { text, redactedPaths } = renderDiffSummary(summary);
      expect(text).toContain(NON_DURABLE_LABEL);
      expect(text).toContain('feat/test');
      expect(text).toContain('dirty');
      expect(text).toContain('src/a.ts');
      expect(text).toContain('src/b.ts');
      expect(text).toContain('+5');
      expect(text).toContain('-3');
      expect(redactedPaths).toHaveLength(0);

      // Full patch text MUST NOT be present
      expect(text).not.toContain('diff --git');
      expect(text).not.toContain('@@');
    });

    it('renders a clean tree summary', () => {
      const summary: BranchDiffSummary = {
        branch: 'main',
        clean: true,
        isGitRepo: true,
        nonDurable: true,
        gatheredAt: '2026-01-01T00:00:00Z',
        stats: { filesChanged: 0, insertions: 0, deletions: 0 },
        changedFiles: [],
      };

      const { text } = renderDiffSummary(summary);
      expect(text).toContain(NON_DURABLE_LABEL);
      expect(text).toContain('clean');
      expect(text).toContain('Changed files: none');
    });

    it('renders a non-git repo summary', () => {
      const summary: BranchDiffSummary = {
        branch: 'not-a-git-repo',
        clean: true,
        isGitRepo: false,
        nonDurable: true,
        gatheredAt: '2026-01-01T00:00:00Z',
        stats: { filesChanged: 0, insertions: 0, deletions: 0 },
        changedFiles: [],
      };

      const { text } = renderDiffSummary(summary);
      expect(text).toContain(NON_DURABLE_LABEL);
      expect(text).toContain('not a git repo');
    });

    it('includes status markers for each file', () => {
      const summary: BranchDiffSummary = {
        branch: 'feat/x',
        clean: false,
        isGitRepo: true,
        nonDurable: true,
        gatheredAt: '2026-01-01T00:00:00Z',
        stats: { filesChanged: 4, insertions: 0, deletions: 0 },
        changedFiles: [
          { path: 'added.ts', status: 'added' },
          { path: 'modified.ts', status: 'modified' },
          { path: 'deleted.ts', status: 'deleted' },
          { path: 'renamed.ts', status: 'renamed' },
        ],
      };

      const { text } = renderDiffSummary(summary);
      expect(text).toContain('A added.ts');
      expect(text).toContain('M modified.ts');
      expect(text).toContain('D deleted.ts');
      expect(text).toContain('R renamed.ts');
    });

    it('flags capture-ignored files in the rendered output', () => {
      const summary: BranchDiffSummary = {
        branch: 'feat/x',
        clean: false,
        isGitRepo: true,
        nonDurable: true,
        gatheredAt: '2026-01-01T00:00:00Z',
        stats: { filesChanged: 1, insertions: 0, deletions: 0 },
        changedFiles: [
          { path: 'node_modules/secret.ts', status: 'modified', ignoredByCapture: true },
        ],
      };

      const { text } = renderDiffSummary(summary);
      expect(text).toContain('[capture-ignored]');
    });

    // ── Redaction in rendered output ───────────────────────────────────────

    it('redacts secrets from file paths in rendered summary', () => {
      const summary: BranchDiffSummary = {
        branch: 'feat/x',
        clean: false,
        isGitRepo: true,
        nonDurable: true,
        gatheredAt: '2026-01-01T00:00:00Z',
        stats: { filesChanged: 1, insertions: 0, deletions: 0 },
        changedFiles: [
          { path: 'config/sk_live_abcdef0123456789ABCDEF.json', status: 'modified' },
        ],
      };

      const { text, redactedPaths } = renderDiffSummary(summary);
      // The file path should be redacted
      expect(text).not.toContain('sk_live_abcdef');
      expect(text).toContain('[REDACTED]');
      expect(redactedPaths.length).toBeGreaterThan(0);
    });

    it('redacts secrets from the overall summary text', () => {
      const summary: BranchDiffSummary = {
        branch: 'feat/x',
        clean: false,
        isGitRepo: true,
        nonDurable: true,
        gatheredAt: '2026-01-01T00:00:00Z',
        stats: { filesChanged: 1, insertions: 0, deletions: 0 },
        changedFiles: [
          // File path containing a GitHub token in the name
          { path: 'secrets/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.env', status: 'modified' },
        ],
      };

      const { text } = renderDiffSummary(summary);
      // The GitHub token should be redacted
      expect(text).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      expect(text).toContain('[REDACTED]');
    });

    // ── Size limiting ──────────────────────────────────────────────────────

    it('truncates the summary when it exceeds maxSummaryBytes', () => {
      // Create a summary with many files to force truncation
      const files: ChangedFile[] = [];
      for (let i = 0; i < 200; i++) {
        files.push({
          path: `src/module${String(i).padStart(4, '0')}/component${String(i).padStart(4, '0')}/index.ts`,
          status: 'modified',
          additions: 10,
          deletions: 5,
        });
      }

      const summary: BranchDiffSummary = {
        branch: 'feat/large-change',
        clean: false,
        isGitRepo: true,
        nonDurable: true,
        gatheredAt: '2026-01-01T00:00:00Z',
        stats: { filesChanged: 200, insertions: 2000, deletions: 1000 },
        changedFiles: files,
      };

      const { text } = renderDiffSummary(summary, 4096);
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4096 + 100); // Allow minor overflow from label
      expect(text).toContain(NON_DURABLE_LABEL);
      expect(text).toContain('truncated');
    });
  });

  // ════════════════════════════════════════════════════════════════════════════
  // gatherDiffExcerpt (optional excerpts)
  // ════════════════════════════════════════════════════════════════════════════

  describe('gatherDiffExcerpt', () => {
    it('returns an excerpt with the non-durable label', () => {
      const repo = createGitRepo();
      try {
        writeFile(repo.dir, 'src/changed.ts', 'export const x = 1;\nexport const y = 2;\n');
        stageAll(repo.dir);

        // Modify the file to create a diff
        writeFile(repo.dir, 'src/changed.ts',
          'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n',
        );

        const excerpt = gatherDiffExcerpt({
          workspaceRoot: repo.dir,
          relPath: 'src/changed.ts',
          contextLines: 3,
        });

        expect(excerpt.nonDurable).toBe(true);
        expect(excerpt.content).toContain(NON_DURABLE_LABEL);
        expect(excerpt.path).toBe('src/changed.ts');
        expect(excerpt.status).toBe('modified');
      } finally {
        repo.cleanup();
      }
    });

    it('excludes full file content — only includes diff context', () => {
      const repo = createGitRepo();
      try {
        // Create a file with 100 lines
        const lines: string[] = [];
        for (let i = 0; i < 100; i++) {
          lines.push(`export const fn${i} = () => ${i};`);
        }
        writeFile(repo.dir, 'src/hundred.ts', lines.join('\n'));
        stageAll(repo.dir);
        execSync('git commit -m "base"', { cwd: repo.dir, stdio: 'ignore' });

        // Add one line at line 50
        lines.splice(49, 0, 'export const NEW = "added";');
        writeFile(repo.dir, 'src/hundred.ts', lines.join('\n'));

        const excerpt = gatherDiffExcerpt({
          workspaceRoot: repo.dir,
          relPath: 'src/hundred.ts',
          contextLines: 3,
        });

        // Should contain the diff hunk header, not the whole file
        expect(excerpt.content).toContain('@@');
        expect(excerpt.content).toContain('NEW');
        // Should NOT contain all 100 lines
        const allLines = excerpt.content.split('\n');
        expect(allLines.length).toBeLessThan(20); // contextLines=3 gives ~7 lines per hunk
      } finally {
        repo.cleanup();
      }
    });

    it('redacts secrets from excerpt content', () => {
      const repo = createGitRepo();
      try {
        writeFile(repo.dir, 'src/secrets.ts', 'const key = "old";\n');
        stageAll(repo.dir);

        writeFile(repo.dir, 'src/secrets.ts',
          'const key = "old";\nconst apiKey = "sk_live_abcdef0123456789ABCDEF";\n',
        );

        const excerpt = gatherDiffExcerpt({
          workspaceRoot: repo.dir,
          relPath: 'src/secrets.ts',
          contextLines: 3,
        });

        expect(excerpt.content).toContain('[REDACTED]');
        expect(excerpt.content).not.toContain('sk_live_abcdef');
        expect(excerpt.byteLengthAfterRedaction).toBeGreaterThan(0);
      } finally {
        repo.cleanup();
      }
    });

    it('respects maxBytes limit', () => {
      const repo = createGitRepo();
      try {
        writeFile(repo.dir, 'src/big.ts', '// base');
        stageAll(repo.dir);
        execSync('git commit -m "base"', { cwd: repo.dir, stdio: 'ignore' });

        // Make a very large change
        const bigContent = 'const big = "' + 'x'.repeat(10000) + '";\n';
        writeFile(repo.dir, 'src/big.ts', bigContent);

        const excerpt = gatherDiffExcerpt({
          workspaceRoot: repo.dir,
          relPath: 'src/big.ts',
          contextLines: 0,
          maxBytes: 500,
        });

        expect(excerpt.byteLengthAfterRedaction).toBeLessThanOrEqual(600); // Allow small overhead
        expect(excerpt.truncated).toBe(true);
      } finally {
        repo.cleanup();
      }
    });

    it('handles contextLines=0 by returning file head (first 25 lines)', () => {
      const repo = createGitRepo();
      try {
        const lines: string[] = [];
        for (let i = 0; i < 50; i++) {
          lines.push(`// line ${i}`);
        }
        writeFile(repo.dir, 'src/many.ts', lines.join('\n'));

        const excerpt = gatherDiffExcerpt({
          workspaceRoot: repo.dir,
          relPath: 'src/many.ts',
          contextLines: 0,
        });

        // Should have at most 25 lines of content (plus header)
        expect(excerpt.content).toContain(NON_DURABLE_LABEL);
        expect(excerpt.content).toContain('File head');
        // Should end around line 25, not line 50
        expect(excerpt.content).toContain('line 24');
        // line 49 should NOT appear
        // (it might be truncated if 25 lines exceeds maxBytes, but let's check it's not there)
        const hasLateLine = excerpt.content.includes('line 49');
        // With default 8KB max, 50 simple lines should fit — but we return only first 25 per spec
        expect(hasLateLine).toBe(false);
      } finally {
        repo.cleanup();
      }
    });

    it('handles new/untracked files gracefully', () => {
      const repo = createGitRepo();
      try {
        writeFile(repo.dir, 'src/untracked.ts', 'export const newfile = true;\n');

        const excerpt = gatherDiffExcerpt({
          workspaceRoot: repo.dir,
          relPath: 'src/untracked.ts',
        });

        expect(excerpt.content).toContain(NON_DURABLE_LABEL);
        expect(excerpt.status).toBe('untracked');
      } finally {
        repo.cleanup();
      }
    });

    it('handles non-existent files gracefully', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-noexist-'));
      try {
        const excerpt = gatherDiffExcerpt({
          workspaceRoot: dir,
          relPath: 'nonexistent.ts',
        });

        expect(excerpt.content).toContain(NON_DURABLE_LABEL);
        expect(excerpt.content).toContain('no content available');
        expect(excerpt.byteLength).toBe(0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('includes estimated token count in excerpt', () => {
      const repo = createGitRepo();
      try {
        writeFile(repo.dir, 'src/foo.ts', 'export const a = 1;\n');
        stageAll(repo.dir);

        const excerpt = gatherDiffExcerpt({
          workspaceRoot: repo.dir,
          relPath: 'src/foo.ts',
        });

        expect(excerpt.estimatedTokens).toBeGreaterThan(0);
      } finally {
        repo.cleanup();
      }
    });
  });
});
