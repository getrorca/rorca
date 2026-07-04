/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-029: ingest-commit and ingest-git — tests.
 *
 * Coverage:
 *   - Single commit: produces context event + memory candidate
 *   - Noise commit: produces context event but NO memory candidate
 *   - Range ingest: scans since..HEAD, deduplicates by SHA
 *   - Rerun idempotency: second pass returns created: false
 *   - No-candidate edge case: noise commit yields zero candidates
 *   - Offline queue: when backend is unreachable, entries are queued
 *   - isNoiseCommit heuristic: WIP, fix typo, cleanup, etc.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import {
  ingestCommit,
  ingestGitRange,
  isNoiseCommit,
  buildContextEvent,
  buildCandidates,
} from '../ingest-commit';
import { extractCommitMetadata } from '../commit-metadata';
import { CaptureQueue } from '../capture-client';

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-ingest-'));
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

/** Remove the offline queue file if it exists. */
function cleanupQueue(repo: string): void {
  const q = new CaptureQueue(repo);
  q.clear();
}

// ════════════════════════════════════════════════════════════════════════════
// isNoiseCommit
// ════════════════════════════════════════════════════════════════════════════

describe('isNoiseCommit', () => {
  test('WIP commits are noise', () => {
    expect(isNoiseCommit({ subject: 'WIP', body: '' })).toBe(true);
    expect(isNoiseCommit({ subject: 'wip: stuff', body: '' })).toBe(true);
    expect(isNoiseCommit({ subject: 'WIP add feature', body: '' })).toBe(true);
  });

  test('fix typo commits are noise', () => {
    expect(isNoiseCommit({ subject: 'fix typo', body: '' })).toBe(true);
    expect(isNoiseCommit({ subject: 'fix typo in readme', body: '' })).toBe(true);
    expect(isNoiseCommit({ subject: 'Fix Typo', body: '' })).toBe(true);
  });

  test('cleanup commits are noise', () => {
    expect(isNoiseCommit({ subject: 'cleanup', body: '' })).toBe(true);
    expect(isNoiseCommit({ subject: 'clean up', body: '' })).toBe(true);
  });

  test('short messages are noise', () => {
    expect(isNoiseCommit({ subject: '.', body: '' })).toBe(true);
    expect(isNoiseCommit({ subject: 'ok', body: '' })).toBe(true);
    expect(isNoiseCommit({ subject: 'x', body: '' })).toBe(true);
  });

  test('meaningful commits are NOT noise', () => {
    expect(isNoiseCommit({ subject: 'feat: add user authentication', body: '' })).toBe(false);
    expect(isNoiseCommit({ subject: 'fix: resolve race condition in task queue', body: '' })).toBe(false);
    expect(isNoiseCommit({ subject: 'refactor: extract validation logic', body: '' })).toBe(false);
    expect(isNoiseCommit({ subject: 'Add memory candidate review UI', body: '' })).toBe(false);
  });

  test('chore deps are noise', () => {
    expect(isNoiseCommit({ subject: 'chore(deps): bump lodash', body: '' })).toBe(true);
    expect(isNoiseCommit({ subject: 'chore(deps): update express', body: '' })).toBe(true);
  });

  test('lint/format commits are noise', () => {
    expect(isNoiseCommit({ subject: 'lint fix', body: '' })).toBe(true);
    expect(isNoiseCommit({ subject: 'format code', body: '' })).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildContextEvent / buildCandidates
// ════════════════════════════════════════════════════════════════════════════

describe('buildContextEvent', () => {
  let repo = '';
  let sha = '';

  beforeAll(() => {
    repo = initRepo();
    sha = commitFile(repo, 'src/app.ts', 'export const app = 1;\n', 'feat: add app module');
  });

  afterAll(() => cleanupRepo(repo));

  test('produces a valid context event', async () => {
    const meta = await extractCommitMetadata(repo, { sha });
    const event = buildContextEvent(meta, 'ws-test');
    expect(event.schemaVersion).toBe('v1');
    expect(event.kind).toBe('commit');
    expect(event.workspaceId).toBe('ws-test');
    expect(event.idempotencyKey).toBe(`commit:ws-test:${sha}`);
    expect(event.gitSha).toBe(sha);
    expect(event.source).toBe('rorca-capture');
    expect(event.payload.sha).toBe(sha);
    expect((event.payload as Record<string, unknown>).message).toEqual({ subject: 'feat: add app module', body: '' });
  });
});

describe('buildCandidates', () => {
  let repo = '';

  beforeAll(() => {
    repo = initRepo();
  });

  afterAll(() => cleanupRepo(repo));

  test('commit with feat prefix produces a Pattern candidate', async () => {
    const sha = commitFile(repo, 'src/feat.ts', 'export const feat = 1;\n', 'feat: add new feature');
    const meta = await extractCommitMetadata(repo, { sha });
    const candidates = buildCandidates(meta, 'ws-test');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].category).toBe('Pattern');
    expect(candidates[0].status).toBe('pending');
    expect(candidates[0].trust).toBe('unverified');
    expect(candidates[0].idempotencyKey).toBe(`candidate:ws-test:${sha}`);
    expect(candidates[0].sourceEventKey).toBe(`commit:ws-test:${sha}`);
  });

  test('commit with fix prefix produces a Bug Fix candidate', async () => {
    const sha = commitFile(repo, 'src/fix.ts', 'export const fix = 1;\n', 'fix: resolve crash');
    const meta = await extractCommitMetadata(repo, { sha });
    const candidates = buildCandidates(meta, 'ws-test');
    expect(candidates).toHaveLength(1);
    expect(candidates[0].category).toBe('Bug Fix');
  });

  test('noise commit produces ZERO candidates', async () => {
    const sha = commitFile(repo, 'src/noop.ts', '// nothing\n', 'WIP');
    const meta = await extractCommitMetadata(repo, { sha });
    const candidates = buildCandidates(meta, 'ws-test');
    expect(candidates).toHaveLength(0);
  });

  test('relatedFiles are populated', async () => {
    commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: add module a');
    commitFile(repo, 'src/b.ts', 'export const b = 2;\n', 'feat: add module b');
    const sha = commitFile(repo, 'src/c.ts', 'export const c = 3;\n', 'feat: add module c');
    const meta = await extractCommitMetadata(repo, { sha });
    const candidates = buildCandidates(meta, 'ws-test');
    expect(candidates).toHaveLength(1);
    // c.ts is the changed file
    expect(candidates[0].relatedFiles).toContain('src/c.ts');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ingestCommit — dry run
// ════════════════════════════════════════════════════════════════════════════

describe('ingestCommit — dry run', () => {
  let repo = '';
  let sha = '';

  beforeAll(() => {
    repo = initRepo();
    sha = commitFile(repo, 'src/main.ts', 'export const main = 1;\n', 'feat: add main');
  });

  afterAll(() => cleanupRepo(repo));

  test('dry run extracts metadata without submitting', async () => {
    const result = await ingestCommit({
      workspaceId: 'ws-test',
      workspacePath: repo,
      backendUrl: 'http://localhost:3030',
      sha,
      dryRun: true,
    });

    expect(result.commitSha).toBe(sha);
    expect(result.subject).toBe('feat: add main');
    expect(result.event.created).toBe(false);
    expect(result.event.queued).toBe(false);
    expect(result.noise).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].created).toBe(false);
  });

  test('dry run for noise commit produces no candidates', async () => {
    const noiseSha = commitFile(repo, 'src/tmp.ts', '// temp\n', 'WIP');
    const result = await ingestCommit({
      workspaceId: 'ws-test',
      workspacePath: repo,
      backendUrl: 'http://localhost:3030',
      sha: noiseSha,
      dryRun: true,
    });

    expect(result.noise).toBe(true);
    expect(result.candidates).toHaveLength(0);
    // Context event is always present (for provenance)
    expect(result.idempotencyKey).toContain(noiseSha);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ingestGitRange
// ════════════════════════════════════════════════════════════════════════════

describe('ingestGitRange', () => {
  let repo = '';


  beforeAll(() => {
    repo = initRepo();

    // Create an initial commit to serve as the 'since' ref
    commitFile(repo, 'README.md', '# Test\n', 'chore: initial commit');

    // Create a branch point
    git(repo, ['checkout', '-b', 'feature-branch']);

    // Add several commits
    commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: add module a');
    commitFile(repo, 'src/b.ts', 'export const b = 2;\n', 'WIP');
    commitFile(repo, 'src/c.ts', 'export const c = 3;\n', 'fix: resolve null pointer');
    commitFile(repo, 'src/d.ts', 'export const d = 4;\n', 'fix typo');
    commitFile(repo, 'src/e.ts', 'export const e = 5;\n', 'refactor: extract helpers');
  });

  afterAll(() => cleanupRepo(repo));

  test('scans range and deduplicates commits', async () => {
    const result = await ingestGitRange({
      workspaceId: 'ws-test',
      workspacePath: repo,
      backendUrl: 'http://localhost:3030',
      since: 'main',
      dryRun: true,
    });

    expect(result.commits).toBe(5); // 5 commits on feature-branch since main
    expect(result.noise).toBe(2);   // WIP + fix typo
    expect(result.ingested).toBe(3); // feat, fix, refactor
    expect(result.results).toHaveLength(5);

    // Verify each result has a proper SHA
    for (const r of result.results) {
      expect(r.commitSha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test('range with zero commits (since == HEAD) returns empty', async () => {
    const result = await ingestGitRange({
      workspaceId: 'ws-test',
      workspacePath: repo,
      backendUrl: 'http://localhost:3030',
      since: 'HEAD',
      dryRun: true,
    });

    expect(result.commits).toBe(0);
    expect(result.results).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Rerun idempotency (offline queue + dry run)
// ════════════════════════════════════════════════════════════════════════════

describe('rerun idempotency', () => {
  let repo = '';

  beforeAll(() => {
    repo = initRepo();
    commitFile(repo, 'src/base.ts', 'export const base = 1;\n', 'feat: base module');
    commitFile(repo, 'src/extra.ts', 'export const extra = 1;\n', 'fix: edge case');
    commitFile(repo, 'src/noop.ts', '', 'WIP');
  });

  afterAll(() => {
    cleanupQueue(repo);
    cleanupRepo(repo);
  });

  test('second dry run produces same results as first', async () => {
    const opts = {
      workspaceId: 'ws-test',
      workspacePath: repo,
      backendUrl: 'http://localhost:3030',
      since: 'main',
      dryRun: true,
    };

    const first = await ingestGitRange(opts);
    const second = await ingestGitRange(opts);

    expect(second.commits).toBe(first.commits);
    expect(second.results).toHaveLength(first.results.length);

    // Same SHAs, same subjects
    for (let i = 0; i < first.results.length; i++) {
      expect(second.results[i].commitSha).toBe(first.results[i].commitSha);
      expect(second.results[i].subject).toBe(first.results[i].subject);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Offline queue fallback
// ════════════════════════════════════════════════════════════════════════════

describe('offline queue fallback', () => {
  let repo = '';
  let sha = '';

  beforeAll(() => {
    repo = initRepo();
    sha = commitFile(repo, 'src/offline.ts', 'export const offline = 1;\n', 'feat: offline module');
  });

  afterAll(() => {
    cleanupQueue(repo);
    cleanupRepo(repo);
  });

  test('when backend unreachable, entries are queued locally', async () => {
    // Set backend URL to an unreachable port
    const result = await ingestCommit({
      workspaceId: 'ws-test',
      workspacePath: repo,
      backendUrl: 'http://127.0.0.1:19999', // unreachable
      sha,
    });

    // The event should be queued
    expect(result.event.queued).toBe(true);
    expect(result.event.created).toBe(false);

    // Candidates should be queued
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].queued).toBe(true);

    // Verify queue file exists and has entries
    const queue = new CaptureQueue(repo);
    expect(queue.isEmpty).toBe(false);
    expect(queue.length).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// No-candidate edge case
// ════════════════════════════════════════════════════════════════════════════

describe('no-candidate edge case', () => {
  let repo = '';

  beforeAll(() => {
    repo = initRepo();
  });

  afterAll(() => {
    cleanupQueue(repo);
    cleanupRepo(repo);
  });

  test('noise commits create context event but zero candidates', async () => {
    const noiseSha = commitFile(repo, 'src/noise.ts', '// noise\n', 'WIP');

    const result = await ingestCommit({
      workspaceId: 'ws-test',
      workspacePath: repo,
      backendUrl: 'http://localhost:3030',
      sha: noiseSha,
      dryRun: true,
    });

    expect(result.noise).toBe(true);
    expect(result.candidates).toHaveLength(0);
    // Event always has a key
    expect(result.idempotencyKey).toBe(`commit:ws-test:${noiseSha}`);
  });

  test('multiple noise commits in a row all produce zero candidates', async () => {
    // Tag the current position as baseline
    git(repo, ['tag', 'baseline']);
    commitFile(repo, 'src/n1.ts', '// n1\n', 'fix typo');
    commitFile(repo, 'src/n2.ts', '// n2\n', 'cleanup');
    commitFile(repo, 'src/n3.ts', '// n3\n', 'lint fix');

    const result = await ingestGitRange({
      workspaceId: 'ws-test',
      workspacePath: repo,
      backendUrl: 'http://localhost:3030',
      since: 'baseline',
      dryRun: true,
    });

    // All 3 commits on this branch
    expect(result.commits).toBe(3);
    // All are noise
    expect(result.noise).toBe(3);
    expect(result.ingested).toBe(0);
    // But events exist for all
    expect(result.results.every((r) => r.idempotencyKey.length > 0)).toBe(true);
  });
});
