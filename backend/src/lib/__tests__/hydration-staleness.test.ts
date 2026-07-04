/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import simpleGit from 'simple-git';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockGetLatestHydration = jest.fn();

jest.mock('../../db/workspace-hydration', () => ({
  getLatestHydration: (...args: unknown[]) => mockGetLatestHydration(...args),
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// We do NOT mock git-hydrator's getCurrentHead — the real implementation uses
// simpleGit internally, which we want for the integration-level repo tests.
// The hydration DB lookup is the only mocked boundary.

import {
  detectHydrationStaleness,
  deriveStalenessStatus,
  isStaleOrDirty,
  isStalenessUnknown,
  type HydrationStalenessChecks,
  type HydrationStalenessResult,
} from '../hydration-staleness';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeWorkspaceDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-staleness-'));
}

async function initGitRepo(dir: string): Promise<string> {
  const git = simpleGit(dir);
  await git.init();
  // git requires an identity to commit
  await git.addConfig('user.email', 'test@rorca.dev');
  await git.addConfig('user.name', 'Rorca Test');
  return dir;
}

async function createAndCommitFile(
  dir: string,
  filename: string,
  content: string,
  message: string,
): Promise<string> {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  const git = simpleGit(dir);
  await git.add(filename);
  await git.commit(message);
  return filePath;
}

async function getHeadSha(dir: string): Promise<string> {
  const git = simpleGit(dir);
  const result = await git.revparse(['HEAD']);
  return result.trim();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('hydration-staleness (US-009)', () => {
  describe('deriveStalenessStatus', () => {
    it('returns missing when no hydration record exists', () => {
      const checks: HydrationStalenessChecks = {
        gitRepo: true,
        hasHydration: false,
        headMatches: false,
        dirtyTree: false,
      };
      expect(deriveStalenessStatus(checks)).toBe('missing');
    });

    it('returns unknown when not a git repo (even with hydration)', () => {
      const checks: HydrationStalenessChecks = {
        gitRepo: false,
        hasHydration: true,
        headMatches: false,
        dirtyTree: false,
      };
      expect(deriveStalenessStatus(checks)).toBe('unknown');
    });

    it('returns dirty when tree has uncommitted changes', () => {
      const checks: HydrationStalenessChecks = {
        gitRepo: true,
        hasHydration: true,
        headMatches: true,
        dirtyTree: true,
      };
      expect(deriveStalenessStatus(checks)).toBe('dirty');
    });

    it('returns stale when HEAD differs from hydrated SHA', () => {
      const checks: HydrationStalenessChecks = {
        gitRepo: true,
        hasHydration: true,
        headMatches: false,
        dirtyTree: false,
      };
      expect(deriveStalenessStatus(checks)).toBe('stale');
    });

    it('returns clean when everything matches', () => {
      const checks: HydrationStalenessChecks = {
        gitRepo: true,
        hasHydration: true,
        headMatches: true,
        dirtyTree: false,
      };
      expect(deriveStalenessStatus(checks)).toBe('clean');
    });
  });

  describe('detectHydrationStaleness — full integration', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    // ── Missing graph (no hydration record) ─────────────────────────────

    it('reports missing when no hydration record exists', async () => {
      const ws = makeWorkspaceDir();
      try {
        await initGitRepo(ws);
        await createAndCommitFile(ws, 'README.md', '# test', 'initial commit');
        mockGetLatestHydration.mockResolvedValue(null);

        const result = await detectHydrationStaleness('ws-missing', ws);

        expect(result.status).toBe('missing');
        expect(result.checks.hasHydration).toBe(false);
        expect(result.checks.gitRepo).toBe(true);
        expect(result.humanSummary).toMatch(/never been built/);
        expect(mockGetLatestHydration).toHaveBeenCalledWith('ws-missing');
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // ── Clean repo (HEAD matches hydrated SHA, tree clean) ─────────────

    it('reports clean when HEAD matches hydrated SHA and tree is clean', async () => {
      const ws = makeWorkspaceDir();
      try {
        await initGitRepo(ws);
        await createAndCommitFile(ws, 'README.md', '# test', 'initial commit');
        const headSha = await getHeadSha(ws);

        mockGetLatestHydration.mockResolvedValue({
          id: 1,
          workspaceId: 'ws-clean',
          provider: 'hilo' as const,
          status: 'succeeded' as const,
          gitSha: headSha,
          graphPath: '/tmp/graph/ws-clean.json',
          counts: { files: 5 },
          durationMs: 1000,
          staleReason: null,
          errorJson: null,
          metadata: {},
          startedAt: new Date(),
          finishedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        const result = await detectHydrationStaleness('ws-clean', ws);

        expect(result.status).toBe('clean');
        expect(result.checks.gitRepo).toBe(true);
        expect(result.checks.hasHydration).toBe(true);
        expect(result.checks.headMatches).toBe(true);
        expect(result.checks.dirtyTree).toBe(false);
        expect(result.currentHead).toBe(headSha);
        expect(result.hydratedSha).toBe(headSha);
        expect(result.humanSummary).toMatch(/fresh/);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // ── New commit (HEAD differs from hydrated SHA) ────────────────────

    it('reports stale when a new commit exists since hydration', async () => {
      const ws = makeWorkspaceDir();
      try {
        await initGitRepo(ws);
        await createAndCommitFile(ws, 'file1.ts', 'const x = 1;', 'first commit');
        const firstSha = await getHeadSha(ws);

        // Hydration was done at firstSha
        mockGetLatestHydration.mockResolvedValue({
          id: 2,
          workspaceId: 'ws-stale-new-commit',
          provider: 'hilo' as const,
          status: 'succeeded' as const,
          gitSha: firstSha,
          graphPath: '/tmp/graph/ws-stale.json',
          counts: { files: 5 },
          durationMs: 1000,
          staleReason: null,
          errorJson: null,
          metadata: {},
          startedAt: new Date(),
          finishedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Now add a second commit — HEAD moves past the hydrated SHA.
        await createAndCommitFile(ws, 'file2.ts', 'const y = 2;', 'second commit');
        const newHead = await getHeadSha(ws);

        const result = await detectHydrationStaleness('ws-stale-new-commit', ws);

        expect(result.status).toBe('stale');
        expect(result.checks.gitRepo).toBe(true);
        expect(result.checks.hasHydration).toBe(true);
        expect(result.checks.headMatches).toBe(false);
        expect(result.checks.dirtyTree).toBe(false);
        expect(result.currentHead).toBe(newHead);
        expect(result.hydratedSha).toBe(firstSha);
        expect(result.currentHead).not.toBe(result.hydratedSha);
        expect(result.humanSummary).toMatch(/stale/);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // ── Dirty file (uncommitted change in working tree) ────────────────

    it('reports dirty when working tree has uncommitted changes', async () => {
      const ws = makeWorkspaceDir();
      try {
        await initGitRepo(ws);
        await createAndCommitFile(ws, 'file1.ts', 'const x = 1;', 'initial commit');
        const headSha = await getHeadSha(ws);

        mockGetLatestHydration.mockResolvedValue({
          id: 3,
          workspaceId: 'ws-dirty',
          provider: 'hilo' as const,
          status: 'succeeded' as const,
          gitSha: headSha,
          graphPath: '/tmp/graph/ws-dirty.json',
          counts: { files: 5 },
          durationMs: 1000,
          staleReason: null,
          errorJson: null,
          metadata: {},
          startedAt: new Date(),
          finishedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        // Modify a file without committing — dirty working tree.
        fs.writeFileSync(path.join(ws, 'file1.ts'), 'const x = 99;', 'utf8');

        const result = await detectHydrationStaleness('ws-dirty', ws);

        expect(result.status).toBe('dirty');
        expect(result.checks.gitRepo).toBe(true);
        expect(result.checks.hasHydration).toBe(true);
        expect(result.checks.dirtyTree).toBe(true);
        expect(result.currentHead).toBe(headSha);
        expect(result.humanSummary).toMatch(/uncommitted/);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // ── Non-git workspace ──────────────────────────────────────────────

    it('reports unknown for a non-git workspace', async () => {
      const ws = makeWorkspaceDir();
      try {
        // No git init — plain directory.
        fs.writeFileSync(path.join(ws, 'file.txt'), 'hello', 'utf8');

        mockGetLatestHydration.mockResolvedValue({
          id: 4,
          workspaceId: 'ws-non-git',
          provider: 'hilo' as const,
          status: 'succeeded' as const,
          gitSha: 'abc123',
          graphPath: '/tmp/graph/ws-non-git.json',
          counts: { files: 3 },
          durationMs: 500,
          staleReason: null,
          errorJson: null,
          metadata: {},
          startedAt: new Date(),
          finishedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        const result = await detectHydrationStaleness('ws-non-git', ws);

        expect(result.status).toBe('unknown');
        expect(result.checks.gitRepo).toBe(false);
        expect(result.checks.hasHydration).toBe(true);
        expect(result.currentHead).toBeNull();
        expect(result.humanSummary).toMatch(/not a git repository/);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // ── Non-git + missing hydration → missing (higher priority) ───────

    it('reports missing (not unknown) when non-git and no hydration', async () => {
      const ws = makeWorkspaceDir();
      try {
        fs.writeFileSync(path.join(ws, 'file.txt'), 'hello', 'utf8');
        mockGetLatestHydration.mockResolvedValue(null);

        const result = await detectHydrationStaleness('ws-non-git-missing', ws);

        // missing > unknown in priority
        expect(result.status).toBe('missing');
        expect(result.checks.gitRepo).toBe(false);
        expect(result.checks.hasHydration).toBe(false);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    // ── Empty git repo (no commits yet) ────────────────────────────────

    it('handles an empty git repo gracefully (no commits)', async () => {
      const ws = makeWorkspaceDir();
      try {
        await initGitRepo(ws);
        // No commits — HEAD cannot be resolved.

        mockGetLatestHydration.mockResolvedValue({
          id: 5,
          workspaceId: 'ws-empty-repo',
          provider: 'hilo' as const,
          status: 'succeeded' as const,
          gitSha: null,
          graphPath: '/tmp/graph/empty.json',
          counts: { files: 0 },
          durationMs: 0,
          staleReason: null,
          errorJson: null,
          metadata: {},
          startedAt: new Date(),
          finishedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        const result = await detectHydrationStaleness('ws-empty-repo', ws);

        // currentHead is null (no commits) → headMatches is false → stale
        expect(result.currentHead).toBeNull();
        // No commits + no hydrated SHA — both null, so headMatches is false
        // but gitRepo is true and hasHydration is true with gitSha=null
        // and dirtyTree=false, so: !headMatches → stale
        expect(result.status).toBe('stale');
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('isStaleOrDirty', () => {
    it('returns true for stale status', () => {
      const result: HydrationStalenessResult = {
        workspaceId: 'ws',
        workspacePath: '/tmp/ws',
        status: 'stale',
        checks: { gitRepo: true, hasHydration: true, headMatches: false, dirtyTree: false },
        currentHead: 'abc',
        hydratedSha: 'def',
        humanSummary: 'stale',
      };
      expect(isStaleOrDirty(result)).toBe(true);
    });

    it('returns true for dirty status', () => {
      const result: HydrationStalenessResult = {
        workspaceId: 'ws',
        workspacePath: '/tmp/ws',
        status: 'dirty',
        checks: { gitRepo: true, hasHydration: true, headMatches: true, dirtyTree: true },
        currentHead: 'abc',
        hydratedSha: 'abc',
        humanSummary: 'dirty',
      };
      expect(isStaleOrDirty(result)).toBe(true);
    });

    it('returns false for clean status', () => {
      const result: HydrationStalenessResult = {
        workspaceId: 'ws',
        workspacePath: '/tmp/ws',
        status: 'clean',
        checks: { gitRepo: true, hasHydration: true, headMatches: true, dirtyTree: false },
        currentHead: 'abc',
        hydratedSha: 'abc',
        humanSummary: 'clean',
      };
      expect(isStaleOrDirty(result)).toBe(false);
    });
  });

  describe('isStalenessUnknown', () => {
    it('returns true for unknown status', () => {
      const result: HydrationStalenessResult = {
        workspaceId: 'ws',
        workspacePath: '/tmp/ws',
        status: 'unknown',
        checks: { gitRepo: false, hasHydration: true, headMatches: false, dirtyTree: false },
        currentHead: null,
        hydratedSha: 'abc',
        humanSummary: 'unknown',
      };
      expect(isStalenessUnknown(result)).toBe(true);
    });

    it('returns false for clean status', () => {
      const result: HydrationStalenessResult = {
        workspaceId: 'ws',
        workspacePath: '/tmp/ws',
        status: 'clean',
        checks: { gitRepo: true, hasHydration: true, headMatches: true, dirtyTree: false },
        currentHead: 'abc',
        hydratedSha: 'abc',
        humanSummary: 'clean',
      };
      expect(isStalenessUnknown(result)).toBe(false);
    });
  });
});
