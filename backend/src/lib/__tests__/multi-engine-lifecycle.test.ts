/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * OC-029: Multi-Engine Process Lifecycle Management
 *
 * Integration tests for per-story agent assignment, engine scanning,
 * rate limit rerouting tracking, and fallbackEngine config validation.
 */

import {
  resolveStoryAgent,
  scanRequiredEngines,
  countStoriesByEngine,
  reroutedStories,
} from '../execution-engine';
import {
  loadOrchestrationConfig,
  clearConfigCache,
} from '../complexity-scorer';
import { validateOrchestrationConfig } from '../config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Types ──────────────────────────────────────────────────────────────────

type AgentType = 'claude' | 'opencode' | 'codex';

interface TestStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  passes?: boolean;
  skipped?: boolean;
  excluded?: boolean;
  agent?: AgentType;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeStory(overrides: Partial<TestStory> = {}): TestStory {
  return {
    id: 'US-001',
    title: 'Test story',
    description: 'A test story',
    acceptanceCriteria: [],
    dependsOn: [],
    ...overrides,
  };
}

function makeConfigDir(config: Record<string, unknown>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-engine-test-'));
  const rorcaDir = path.join(tmpDir, '.rorca');
  fs.mkdirSync(rorcaDir, { recursive: true });
  fs.writeFileSync(
    path.join(rorcaDir, 'config.json'),
    JSON.stringify(config),
  );
  return tmpDir;
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Multi-Engine Lifecycle (OC-029)', () => {
  // ── resolveStoryAgent ──────────────────────────────────────────────

  describe('resolveStoryAgent()', () => {
    it('returns run-level agent when story has no agent override', () => {
      const story = makeStory({ id: 'US-001' });
      expect(resolveStoryAgent(story, 'claude')).toBe('claude');
      expect(resolveStoryAgent(story, 'opencode')).toBe('opencode');
      expect(resolveStoryAgent(story, 'codex')).toBe('codex');
    });

    it('returns story-level agent when set', () => {
      const story = makeStory({ id: 'US-001', agent: 'opencode' });
      expect(resolveStoryAgent(story, 'claude')).toBe('opencode');
    });

    it('falls back to run-level agent for invalid story agent', () => {
      const story = makeStory({ id: 'US-001', agent: 'invalid' as AgentType });
      expect(resolveStoryAgent(story, 'claude')).toBe('claude');
    });
  });

  // ── scanRequiredEngines ────────────────────────────────────────────

  describe('scanRequiredEngines()', () => {
    it('returns single engine when all stories use run-level default', () => {
      const stories = [
        makeStory({ id: 'US-001' }),
        makeStory({ id: 'US-002' }),
        makeStory({ id: 'US-003' }),
      ];
      const engines = scanRequiredEngines(stories, 'claude');
      expect(engines.size).toBe(1);
      expect(engines.has('claude')).toBe(true);
    });

    it('returns multiple engines when stories have mixed assignments', () => {
      const stories = [
        makeStory({ id: 'US-001' }),                           // claude (run default)
        makeStory({ id: 'US-002', agent: 'opencode' }),        // opencode override
        makeStory({ id: 'US-003', agent: 'codex' }),           // codex override
      ];
      const engines = scanRequiredEngines(stories, 'claude');
      expect(engines.size).toBe(3);
      expect(engines.has('claude')).toBe(true);
      expect(engines.has('opencode')).toBe(true);
      expect(engines.has('codex')).toBe(true);
    });

    it('excludes passed stories from engine scan', () => {
      const stories = [
        makeStory({ id: 'US-001', agent: 'opencode', passes: true }),
        makeStory({ id: 'US-002' }),
      ];
      const engines = scanRequiredEngines(stories, 'claude');
      expect(engines.size).toBe(1);
      expect(engines.has('claude')).toBe(true);
      expect(engines.has('opencode')).toBe(false);
    });

    it('excludes skipped stories from engine scan', () => {
      const stories = [
        makeStory({ id: 'US-001', agent: 'codex', skipped: true }),
        makeStory({ id: 'US-002' }),
      ];
      const engines = scanRequiredEngines(stories, 'claude');
      expect(engines.size).toBe(1);
      expect(engines.has('codex')).toBe(false);
    });

    it('excludes excluded stories from engine scan', () => {
      const stories = [
        makeStory({ id: 'US-001', agent: 'opencode', excluded: true }),
        makeStory({ id: 'US-002' }),
      ];
      const engines = scanRequiredEngines(stories, 'claude');
      expect(engines.size).toBe(1);
      expect(engines.has('opencode')).toBe(false);
    });

    it('returns empty set when all stories are done', () => {
      const stories = [
        makeStory({ id: 'US-001', passes: true }),
        makeStory({ id: 'US-002', skipped: true }),
      ];
      const engines = scanRequiredEngines(stories, 'claude');
      expect(engines.size).toBe(0);
    });
  });

  // ── countStoriesByEngine ───────────────────────────────────────────

  describe('countStoriesByEngine()', () => {
    it('counts stories correctly for single engine', () => {
      const stories = [
        makeStory({ id: 'US-001' }),
        makeStory({ id: 'US-002' }),
        makeStory({ id: 'US-003' }),
      ];
      const counts = countStoriesByEngine(stories, 'claude');
      expect(counts.get('claude')).toBe(3);
      expect(counts.size).toBe(1);
    });

    it('counts stories correctly for mixed engines', () => {
      const stories = [
        makeStory({ id: 'US-001' }),                      // claude
        makeStory({ id: 'US-002', agent: 'opencode' }),   // opencode
        makeStory({ id: 'US-003', agent: 'opencode' }),   // opencode
        makeStory({ id: 'US-004', agent: 'codex' }),      // codex
      ];
      const counts = countStoriesByEngine(stories, 'claude');
      expect(counts.get('claude')).toBe(1);
      expect(counts.get('opencode')).toBe(2);
      expect(counts.get('codex')).toBe(1);
    });

    it('skips passed/excluded/skipped stories in count', () => {
      const stories = [
        makeStory({ id: 'US-001', agent: 'opencode', passes: true }),
        makeStory({ id: 'US-002', agent: 'opencode' }),
        makeStory({ id: 'US-003', agent: 'opencode', excluded: true }),
      ];
      const counts = countStoriesByEngine(stories, 'claude');
      expect(counts.get('opencode')).toBe(1);
      expect(counts.has('claude')).toBe(false);
    });
  });

  // ── reroutedStories Map ────────────────────────────────────────────

  describe('reroutedStories tracking', () => {
    afterEach(() => {
      reroutedStories.clear();
    });

    it('starts empty', () => {
      expect(reroutedStories.size).toBe(0);
    });

    it('tracks reroute entries correctly', () => {
      reroutedStories.set('US-001', {
        storyId: 'US-001',
        fromEngine: 'claude',
        toEngine: 'codex',
        reason: 'rate_limit',
      });
      expect(reroutedStories.has('US-001')).toBe(true);
      const info = reroutedStories.get('US-001')!;
      expect(info.fromEngine).toBe('claude');
      expect(info.toEngine).toBe('codex');
      expect(info.reason).toBe('rate_limit');
    });

    it('prevents duplicate reroutes for same story', () => {
      reroutedStories.set('US-001', {
        storyId: 'US-001',
        fromEngine: 'claude',
        toEngine: 'opencode',
        reason: 'rate_limit',
      });
      // Attempting to reroute the same story should be prevented by the has() check
      const alreadyRerouted = reroutedStories.has('US-001');
      expect(alreadyRerouted).toBe(true);
    });
  });

  // ── fallbackEngine Config Validation ───────────────────────────────

  describe('fallbackEngine in validateOrchestrationConfig', () => {
    it('accepts valid fallbackEngine values', () => {
      expect(validateOrchestrationConfig({ fallbackEngine: 'claude' })).toEqual([]);
      expect(validateOrchestrationConfig({ fallbackEngine: 'opencode' })).toEqual([]);
      expect(validateOrchestrationConfig({ fallbackEngine: 'codex' })).toEqual([]);
    });

    it('accepts null fallbackEngine (disabled)', () => {
      expect(validateOrchestrationConfig({ fallbackEngine: null })).toEqual([]);
    });

    it('accepts undefined fallbackEngine (not set)', () => {
      expect(validateOrchestrationConfig({})).toEqual([]);
    });

    it('rejects invalid fallbackEngine string', () => {
      const errors = validateOrchestrationConfig({ fallbackEngine: 'invalid' });
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('orchestration.fallbackEngine');
      expect(errors[0].message).toContain('claude');
      expect(errors[0].message).toContain('opencode');
      expect(errors[0].message).toContain('codex');
    });

    it('rejects non-string fallbackEngine', () => {
      const errors = validateOrchestrationConfig({ fallbackEngine: 42 });
      expect(errors).toHaveLength(1);
      expect(errors[0].field).toBe('orchestration.fallbackEngine');
    });
  });

  // ── fallbackEngine in loadOrchestrationConfig ──────────────────────

  describe('fallbackEngine in loadOrchestrationConfig', () => {
    let tmpDir: string;

    beforeEach(() => {
      clearConfigCache();
    });

    afterEach(() => {
      if (tmpDir) cleanupDir(tmpDir);
    });

    it('defaults to null when not specified', () => {
      tmpDir = makeConfigDir({ orchestration: {} });
      const config = loadOrchestrationConfig(tmpDir);
      expect(config.fallbackEngine).toBeNull();
    });

    it('loads fallbackEngine from config', () => {
      tmpDir = makeConfigDir({ orchestration: { fallbackEngine: 'codex' } });
      const config = loadOrchestrationConfig(tmpDir);
      expect(config.fallbackEngine).toBe('codex');
    });

    it('ignores invalid fallbackEngine and defaults to null', () => {
      tmpDir = makeConfigDir({ orchestration: { fallbackEngine: 'invalid' } });
      const config = loadOrchestrationConfig(tmpDir);
      expect(config.fallbackEngine).toBeNull();
    });

    it('loads null fallbackEngine explicitly set to null', () => {
      tmpDir = makeConfigDir({ orchestration: { fallbackEngine: null } });
      const config = loadOrchestrationConfig(tmpDir);
      expect(config.fallbackEngine).toBeNull();
    });
  });

  // ── Multi-engine scenario: 3 stories across 2 engines ─────────────

  describe('Multi-engine scenario (3 stories, 2 engines)', () => {
    it('correctly scans and counts a mixed claude/opencode run', () => {
      const stories = [
        makeStory({ id: 'US-001', title: 'Setup API routes' }),           // claude (default)
        makeStory({ id: 'US-002', title: 'Build UI components', agent: 'opencode' }),
        makeStory({ id: 'US-003', title: 'Add validation', agent: 'opencode' }),
      ];

      const engines = scanRequiredEngines(stories, 'claude');
      expect(engines.size).toBe(2);
      expect(engines.has('claude')).toBe(true);
      expect(engines.has('opencode')).toBe(true);

      const counts = countStoriesByEngine(stories, 'claude');
      expect(counts.get('claude')).toBe(1);
      expect(counts.get('opencode')).toBe(2);

      // Verify each story resolves to the correct engine
      expect(resolveStoryAgent(stories[0], 'claude')).toBe('claude');
      expect(resolveStoryAgent(stories[1], 'claude')).toBe('opencode');
      expect(resolveStoryAgent(stories[2], 'claude')).toBe('opencode');
    });

    it('opencode server should only start when opencode stories exist', () => {
      // Simulates the condition check in pipeline.ts
      const storiesWithOpencode = [
        makeStory({ id: 'US-001' }),
        makeStory({ id: 'US-002', agent: 'opencode' }),
      ];
      const storiesWithoutOpencode = [
        makeStory({ id: 'US-001' }),
        makeStory({ id: 'US-002' }),
      ];

      const enginesA = scanRequiredEngines(storiesWithOpencode, 'claude');
      expect(enginesA.has('opencode')).toBe(true);

      const enginesB = scanRequiredEngines(storiesWithoutOpencode, 'claude');
      expect(enginesB.has('opencode')).toBe(false);
    });

    it('tracks reroute from claude to codex on rate limit', () => {
      reroutedStories.clear();

      // Simulate rate limit reroute
      const story = makeStory({ id: 'US-001', title: 'Rate limited story' });
      const fromEngine: AgentType = 'claude';
      const toEngine: AgentType = 'codex';

      reroutedStories.set(story.id, {
        storyId: story.id,
        fromEngine,
        toEngine,
        reason: 'rate_limit',
      });

      expect(reroutedStories.size).toBe(1);
      const info = reroutedStories.get('US-001')!;
      expect(info.fromEngine).toBe('claude');
      expect(info.toEngine).toBe('codex');
      expect(info.reason).toBe('rate_limit');

      // Should prevent double-reroute
      expect(reroutedStories.has('US-001')).toBe(true);

      reroutedStories.clear();
    });
  });
});
