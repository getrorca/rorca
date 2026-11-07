/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  score,
  effortForComplexity,
  loadOrchestrationConfig,
  clearConfigCache,
  type ScorerStory,
} from '../complexity-scorer';
import { validateOrchestrationConfig } from '../config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeStory(overrides: Partial<ScorerStory> = {}): ScorerStory {
  return {
    id: 'US-001',
    title: 'Story fixture',
    description: 'A story fixture for scoring signals',
    acceptanceCriteria: [],
    dependsOn: [],
    ...overrides,
  };
}

function makeConfigDir(config: Record<string, unknown>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-test-'));
  const rorcaDir = path.join(tmpDir, '.rorca');
  fs.mkdirSync(rorcaDir, { recursive: true });
  fs.writeFileSync(
    path.join(rorcaDir, 'config.json'),
    JSON.stringify(config),
  );
  return tmpDir;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('complexity-scorer', () => {
  beforeEach(() => {
    clearConfigCache();
  });

  describe('effortForComplexity()', () => {
    it('maps 1-2 to low', () => {
      expect(effortForComplexity(1)).toBe('low');
      expect(effortForComplexity(2)).toBe('low');
    });

    it('maps 3 to medium', () => {
      expect(effortForComplexity(3)).toBe('medium');
    });

    it('maps 4-5 to high', () => {
      expect(effortForComplexity(4)).toBe('high');
      expect(effortForComplexity(5)).toBe('high');
    });

    it('never emits max/xhigh for any complexity', () => {
      for (const c of [1, 2, 3, 4, 5]) {
        expect(['low', 'medium', 'high']).toContain(effortForComplexity(c));
      }
    });

    it('defaults to medium for missing or invalid complexity', () => {
      expect(effortForComplexity()).toBe('medium');
      expect(effortForComplexity(undefined)).toBe('medium');
      expect(effortForComplexity(NaN)).toBe('medium');
      expect(effortForComplexity(Number.POSITIVE_INFINITY)).toBe('medium');
      expect(effortForComplexity(Number('not-a-number'))).toBe('medium');
    });
  });

  describe('score()', () => {
    it('derives effort from the declared complexity', () => {
      expect(score(makeStory({ complexity: 5 })).effort).toBe('high');
      expect(score(makeStory({ complexity: 4 })).effort).toBe('high');
      expect(score(makeStory({ complexity: 3 })).effort).toBe('medium');
      expect(score(makeStory({ complexity: 2 })).effort).toBe('low');
      expect(score(makeStory({})).effort).toBe('medium');
    });

    it('returns a numeric score and signal breakdown', () => {
      const result = score(makeStory());
      expect(typeof result.score).toBe('number');
      expect(Array.isArray(result.signals)).toBe(true);
      expect(result.signals.length).toBeGreaterThan(0);
    });

    // ── Dependency depth ──────────────────────────────────────────────

    it('adds +10 per dependency depth level', () => {
      const stories = [
        makeStory({ id: 'US-001' }),
        makeStory({ id: 'US-002', dependsOn: ['US-001'] }),
        makeStory({ id: 'US-003', dependsOn: ['US-002'] }),
      ];
      const result = score(stories[2], stories);
      expect(result.signals).toContain('dependsOn depth 2 (+20)');
      expect(result.score).toBe(30); // 20 depth + 10 tag:feat
    });

    it('terminates on dependency cycles', () => {
      const stories = [
        makeStory({ id: 'US-001', dependsOn: ['US-002'] }),
        makeStory({ id: 'US-002', dependsOn: ['US-001'] }),
      ];
      const result = score(stories[0], stories);
      expect(typeof result.score).toBe('number');
      expect(Number.isFinite(result.score)).toBe(true);
    });

    // ── Acceptance criteria ────────────────────────────────────────────

    it('adds +5 per acceptance criterion', () => {
      const story = makeStory({ acceptanceCriteria: ['a', 'b', 'c'] });
      const result = score(story);
      expect(result.signals).toContain('acceptanceCriteria ×3 (+15)');
      expect(result.score).toBe(25); // 15 AC + 10 tag:feat
    });

    // ── File path patterns ─────────────────────────────────────────────

    it('subtracts for docs paths and adds for src/core paths', () => {
      const docs = score(makeStory({ title: 'Update docs/README.md' }));
      expect(docs.score).toBe(0); // 10 tag:feat - 20 docs path, floored at 0

      const core = score(makeStory({ title: 'Touch src/core/engine.ts' }));
      expect(core.score).toBe(30); // 10 tag:feat + 20 src/core path
      expect(core.signals).toContain('src/core path (+20)');
    });

    // ── Story type tags ────────────────────────────────────────────────

    it('applies tag deltas for docs, test, feat, and architecture', () => {
      const docs = score(makeStory({ title: 'Write documentation for the API' }));
      expect(docs.signals).toContain('tag:docs (-25)');
      expect(docs.score).toBe(0); // 10 feat - 25 docs, floored at 0

      const test = score(makeStory({ title: 'Add integration test for checkout' }));
      expect(test.signals).toContain('tag:test (+5)');

      const arch = score(makeStory({ title: 'Design the core engine architecture' }));
      expect(arch.signals).toContain('tag:architecture (+30)');
    });

    // ── Keyword detection ──────────────────────────────────────────────

    it('applies a single keyword bonus: opus > sonnet > haiku', () => {
      const opus = score(makeStory({ title: 'Implement authentication for payments' }));
      expect(opus.signals.some(s => s.startsWith('keyword:') && s.endsWith('(+25)'))).toBe(true);

      const sonnet = score(makeStory({ title: 'Refactor the endpoint router' }));
      expect(sonnet.signals.some(s => s.startsWith('keyword:') && s.endsWith('(+10)'))).toBe(true);

      const haiku = score(makeStory({ title: 'Fix typo in the readme' }));
      expect(haiku.signals.some(s => s.endsWith('(-10)'))).toBe(true);
    });

    // ── Floor ──────────────────────────────────────────────────────────

    it('floors the numeric score at 0', () => {
      const story = makeStory({
        title: 'Update docs/README.md changelog with a typo fix',
        description: 'Docs only',
      });
      expect(score(story).score).toBe(0);
    });

    // ── Determinism ────────────────────────────────────────────────────

    it('is deterministic for the same story', () => {
      const story = makeStory({ complexity: 5, acceptanceCriteria: ['a', 'b'] });
      const r1 = score(story);
      const r2 = score(story);
      expect(r1.effort).toBe(r2.effort);
      expect(r1.score).toBe(r2.score);
      expect(r1.signals).toEqual(r2.signals);
    });
  });

  describe('loadOrchestrationConfig()', () => {
    it('returns defaults when no cwd is provided', () => {
      const config = loadOrchestrationConfig();
      expect(config.tokenBudgetPerStory).toBe(50000);
      expect(config.fallbackEngine).toBeNull();
      expect(config.capabilityMismatch).toBe('warn');
    });

    it('returns defaults when .rorca/config.json does not exist', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-config-'));
      const config = loadOrchestrationConfig(tmpDir);
      expect(config.tokenBudgetPerStory).toBe(50000);
      expect(config.fallbackEngine).toBeNull();
      expect(config.capabilityMismatch).toBe('warn');
    });

    it('reads tokenBudgetPerStory, fallbackEngine, and capabilityMismatch', () => {
      const cwd = makeConfigDir({
        orchestration: {
          tokenBudgetPerStory: 90000,
          fallbackEngine: 'codex',
          capabilityMismatch: 'block',
        },
      });
      const config = loadOrchestrationConfig(cwd);
      expect(config.tokenBudgetPerStory).toBe(90000);
      expect(config.fallbackEngine).toBe('codex');
      expect(config.capabilityMismatch).toBe('block');
    });

    it('falls back per-field for invalid values', () => {
      const cwd = makeConfigDir({
        orchestration: {
          tokenBudgetPerStory: -5,
          fallbackEngine: 'not-an-engine',
          capabilityMismatch: 'nope',
        },
      });
      const config = loadOrchestrationConfig(cwd);
      expect(config.tokenBudgetPerStory).toBe(50000);
      expect(config.fallbackEngine).toBeNull();
      expect(config.capabilityMismatch).toBe('warn');
    });

    it('handles malformed config gracefully', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-malformed-'));
      fs.mkdirSync(path.join(tmpDir, '.rorca'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.rorca', 'config.json'), '{not json');
      const config = loadOrchestrationConfig(tmpDir);
      expect(config.tokenBudgetPerStory).toBe(50000);
      expect(config.capabilityMismatch).toBe('warn');
    });

    it('ignores legacy tier keys (router/thresholds/escalation/taskCascades)', () => {
      const cwd = makeConfigDir({
        orchestration: {
          router: 'auto',
          thresholds: { haiku: 30, sonnet: 65, opus: 100 },
          escalation: { enabled: true, chain: ['haiku', 'sonnet', 'opus'] },
          taskCascades: { coding: 'gpt-4o' },
          tokenBudgetPerStory: 70000,
        },
      });
      const config = loadOrchestrationConfig(cwd);
      expect(config.tokenBudgetPerStory).toBe(70000);
      expect(config.capabilityMismatch).toBe('warn');
    });

    it('caches config for same cwd', () => {
      const cwd = makeConfigDir({
        orchestration: { tokenBudgetPerStory: 60000 },
      });
      const c1 = loadOrchestrationConfig(cwd);
      const c2 = loadOrchestrationConfig(cwd);
      expect(c1).toBe(c2);
    });
  });

  describe('validateOrchestrationConfig()', () => {
    it('accepts empty and valid orchestration sections', () => {
      expect(validateOrchestrationConfig({})).toEqual([]);
      expect(validateOrchestrationConfig({ tokenBudgetPerStory: 50000, fallbackEngine: 'codex', capabilityMismatch: 'reroute' })).toEqual([]);
      expect(validateOrchestrationConfig(null)).not.toEqual([]);
    });

    it('tolerates legacy tier keys', () => {
      expect(validateOrchestrationConfig({
        router: 'auto',
        thresholds: { haiku: 30 },
        taskCascades: { coding: 'gpt-4o' },
      })).toEqual([]);
    });

    it('rejects invalid capabilityMismatch and tokenBudgetPerStory', () => {
      expect(validateOrchestrationConfig({ capabilityMismatch: 'nope' })).toHaveLength(1);
      expect(validateOrchestrationConfig({ tokenBudgetPerStory: 0 })).toHaveLength(1);
      expect(validateOrchestrationConfig({ tokenBudgetPerStory: -1 })).toHaveLength(1);
    });

    it('rejects invalid fallbackEngine', () => {
      expect(validateOrchestrationConfig({ fallbackEngine: 'invalid' })).toHaveLength(1);
      expect(validateOrchestrationConfig({ fallbackEngine: 42 })).toHaveLength(1);
    });
  });
});
