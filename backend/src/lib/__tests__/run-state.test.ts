/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  initRunState,
  readRunState,
  markStoryStarted,
  markStoryCompleted,
  markStoryFailed,
  markStorySkipped,
  recordDecision,
  archiveRunState,
  writeProgressTxt,
  migrateProgressTxt,
  getResumeContext,
} from '../run-state';

describe('run-state', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-state-test-'));
    fs.mkdirSync(path.join(tmpDir, '.rorca'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initRunState', () => {
    it('creates a new run-state.json with correct schema', () => {
      const state = initRunState(tmpDir, 'my-spec', 42);

      expect(state.specId).toBe('my-spec');
      expect(state.runId).toBe(42);
      expect(state.completedStories).toEqual([]);
      expect(state.failedStories).toEqual([]);
      expect(state.skippedStories).toEqual([]);
      expect(state.currentStory).toBeNull();
      expect(state.decisions).toEqual([]);
      expect(state.resumedFromStory).toBeNull();
      expect(state.startedAt).toBeDefined();
      expect(state.lastUpdatedAt).toBeDefined();
    });

    it('detects resume from previous run of same spec', () => {
      // Simulate a previous run
      const _first = initRunState(tmpDir, 'my-spec', 1);
      markStoryCompleted(tmpDir, {
        storyId: 'US-001', title: 'First Story', status: 'passed',
        startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:05:00Z',
        agentType: 'claude',
      });

      // Re-init same spec → resume
      const resumed = initRunState(tmpDir, 'my-spec', 2);
      expect(resumed.resumedFromStory).toBe('US-001');
      expect(resumed.completedStories).toHaveLength(1);
    });

    it('does not carry forward stories from different spec', () => {
      initRunState(tmpDir, 'spec-a', 1);
      markStoryCompleted(tmpDir, {
        storyId: 'US-001', title: 'Story A', status: 'passed',
        startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:05:00Z',
        agentType: 'claude',
      });

      const fresh = initRunState(tmpDir, 'spec-b', 2);
      expect(fresh.completedStories).toHaveLength(0);
      expect(fresh.resumedFromStory).toBeNull();
    });
  });

  describe('story lifecycle', () => {
    beforeEach(() => {
      initRunState(tmpDir, 'test-spec', 1);
    });

    it('marks story started', () => {
      markStoryStarted(tmpDir, 'US-001');
      const state = readRunState(tmpDir)!;
      expect(state.currentStory).toBe('US-001');
    });

    it('marks story completed', () => {
      markStoryStarted(tmpDir, 'US-001');
      markStoryCompleted(tmpDir, {
        storyId: 'US-001', title: 'Add feature', status: 'passed',
        startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:05:00Z',
        agentType: 'claude', elapsedMs: 300000,
      });

      const state = readRunState(tmpDir)!;
      expect(state.completedStories).toHaveLength(1);
      expect(state.completedStories[0].storyId).toBe('US-001');
      expect(state.currentStory).toBeNull();
    });

    it('marks story failed', () => {
      markStoryFailed(tmpDir, {
        storyId: 'US-002', title: 'Broken thing', status: 'failed',
        startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:10:00Z',
        agentType: 'opencode', failReason: 'timeout',
      });

      const state = readRunState(tmpDir)!;
      expect(state.failedStories).toHaveLength(1);
      expect(state.failedStories[0].failReason).toBe('timeout');
    });

    it('marks story skipped', () => {
      markStorySkipped(tmpDir, {
        storyId: 'US-003', title: 'Blocked', status: 'skipped',
        startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z',
        agentType: 'claude', failReason: 'blocked_by: US-002',
      });

      const state = readRunState(tmpDir)!;
      expect(state.skippedStories).toHaveLength(1);
    });
  });

  describe('recordDecision', () => {
    it('appends decisions to the ledger', () => {
      initRunState(tmpDir, 'test-spec', 1);

      recordDecision(tmpDir, {
        storyId: 'US-001', timestamp: '2026-01-01T00:00:00Z',
        type: 'escalation', description: 'Escalated haiku → sonnet',
      });
      recordDecision(tmpDir, {
        storyId: 'US-002', timestamp: '2026-01-01T00:01:00Z',
        type: 'reroute', description: 'Rerouted claude → opencode',
      });

      const state = readRunState(tmpDir)!;
      expect(state.decisions).toHaveLength(2);
      expect(state.decisions[0].type).toBe('escalation');
      expect(state.decisions[1].type).toBe('reroute');
    });
  });

  describe('getResumeContext', () => {
    it('returns empty context when no run-state exists', () => {
      const ctx = getResumeContext(tmpDir, 'no-spec');
      expect(ctx.isResume).toBe(false);
      expect(ctx.passedStoryIds.size).toBe(0);
    });

    it('returns passed story IDs for matching spec', () => {
      initRunState(tmpDir, 'my-spec', 1);
      markStoryCompleted(tmpDir, {
        storyId: 'US-001', title: 'A', status: 'passed',
        startedAt: '', finishedAt: '', agentType: 'claude',
      });
      markStoryCompleted(tmpDir, {
        storyId: 'US-002', title: 'B', status: 'passed',
        startedAt: '', finishedAt: '', agentType: 'claude',
      });

      const ctx = getResumeContext(tmpDir, 'my-spec');
      expect(ctx.isResume).toBe(true);
      expect(ctx.passedStoryIds.has('US-001')).toBe(true);
      expect(ctx.passedStoryIds.has('US-002')).toBe(true);
    });
  });

  describe('archiveRunState', () => {
    it('archives to .rorca/memory/runs/{runId}.json', () => {
      initRunState(tmpDir, 'test-spec', 99);
      markStoryCompleted(tmpDir, {
        storyId: 'US-001', title: 'Done', status: 'passed',
        startedAt: '', finishedAt: '', agentType: 'claude',
      });

      const archivePath = archiveRunState(tmpDir, 99);
      expect(archivePath).toBeTruthy();
      expect(fs.existsSync(archivePath!)).toBe(true);

      const archived = JSON.parse(fs.readFileSync(archivePath!, 'utf8'));
      expect(archived.specId).toBe('test-spec');
      expect(archived.completedStories).toHaveLength(1);

      // Current state should be reset (empty specId → readRunState returns null)
      const current = readRunState(tmpDir);
      expect(current).toBeNull();
    });
  });

  describe('writeProgressTxt', () => {
    it('writes human-readable progress.txt', () => {
      initRunState(tmpDir, 'test-spec', 1);
      markStoryCompleted(tmpDir, {
        storyId: 'US-001', title: 'Add Login', status: 'passed',
        startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:05:00Z',
        agentType: 'claude', elapsedMs: 300000,
      });

      writeProgressTxt(tmpDir);
      const content = fs.readFileSync(path.join(tmpDir, 'progress.txt'), 'utf8');
      expect(content).toContain('US-001');
      expect(content).toContain('Add Login');
      expect(content).toContain('DONE');
    });
  });

  describe('migrateProgressTxt', () => {
    it('migrates completed stories from progress.txt', () => {
      const progressContent = `# Progress

## Story US-001: Add Auth — DONE
Files touched: backend/src/routes/auth.ts

## Story US-002: Add Profile — DONE
Files touched: backend/src/routes/profile.ts
`;
      fs.writeFileSync(path.join(tmpDir, 'progress.txt'), progressContent);

      const migrated = migrateProgressTxt(tmpDir, 'my-spec', 1);
      expect(migrated).toBeTruthy();
      expect(migrated!.completedStories).toHaveLength(2);
      expect(migrated!.completedStories[0].storyId).toBe('US-001');
      expect(migrated!.completedStories[1].storyId).toBe('US-002');
    });

    it('returns null when no progress.txt exists', () => {
      const result = migrateProgressTxt(tmpDir, 'my-spec', 1);
      expect(result).toBeNull();
    });

    it('returns null when run-state already has data', () => {
      initRunState(tmpDir, 'existing-spec', 1);
      fs.writeFileSync(path.join(tmpDir, 'progress.txt'), '## Story US-001: A — DONE\n');

      const result = migrateProgressTxt(tmpDir, 'existing-spec', 2);
      expect(result).toBeNull();
    });
  });

  describe('atomic writes', () => {
    it('run-state.json is valid JSON after concurrent writes', () => {
      initRunState(tmpDir, 'test-spec', 1);

      // Simulate rapid sequential writes
      for (let i = 0; i < 20; i++) {
        markStoryCompleted(tmpDir, {
          storyId: `US-${String(i).padStart(3, '0')}`, title: `Story ${i}`, status: 'passed',
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          agentType: 'claude',
        });
      }

      const state = readRunState(tmpDir)!;
      expect(state.completedStories).toHaveLength(20);
    });
  });

  describe('readRunState', () => {
    it('returns null for empty scaffold', () => {
      // Write old-format empty scaffold
      fs.writeFileSync(
        path.join(tmpDir, '.rorca', 'run-state.json'),
        JSON.stringify({ version: 1, events: [], currentRunId: null, lastUpdated: null }),
      );
      const result = readRunState(tmpDir);
      expect(result).toBeNull();
    });

    it('returns null for missing file', () => {
      const result = readRunState(tmpDir);
      expect(result).toBeNull();
    });
  });
});
