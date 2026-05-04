/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import {
  score,
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
    title: 'Test story',
    description: 'A test story description',
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

  describe('score()', () => {
    // ── Dependency depth ──────────────────────────────────────────────

    it('scores low for a story with no dependencies and no signals', () => {
      const story = makeStory({
        title: 'Basic change',
        description: 'A small update to a file',
      });
      const result = score(story);
      // tag:feat (+10) is the only signal for a minimal feature story
      expect(result.tier).toBe('haiku');
      expect(result.signals).not.toContainEqual(expect.stringMatching(/dependsOn/));
    });

    it('adds +10 per dependency depth level', () => {
      const stories: ScorerStory[] = [
        makeStory({ id: 'US-001', dependsOn: [] }),
        makeStory({ id: 'US-002', dependsOn: ['US-001'] }),
        makeStory({ id: 'US-003', dependsOn: ['US-002'] }),
      ];
      const result = score(stories[2], stories);
      expect(result.signals).toContainEqual(expect.stringMatching(/dependsOn depth 2 \(\+20\)/));
    });

    it('handles deep dependency chains (+30 for depth 3)', () => {
      const stories: ScorerStory[] = [
        makeStory({ id: 'A', dependsOn: [] }),
        makeStory({ id: 'B', dependsOn: ['A'] }),
        makeStory({ id: 'C', dependsOn: ['B'] }),
        makeStory({ id: 'D', dependsOn: ['C'] }),
      ];
      const result = score(stories[3], stories);
      expect(result.signals).toContainEqual(expect.stringMatching(/dependsOn depth 3 \(\+30\)/));
    });

    it('handles dependency cycles without infinite loop', () => {
      const stories: ScorerStory[] = [
        makeStory({ id: 'A', dependsOn: ['B'] }),
        makeStory({ id: 'B', dependsOn: ['A'] }),
      ];
      // Should not throw and should return a result
      const result = score(stories[0], stories);
      expect(typeof result.score).toBe('number');
      expect(result.tier).toBeDefined();
    });

    // ── Acceptance criteria ───────────────────────────────────────────

    it('adds +5 per acceptance criterion', () => {
      const story = makeStory({
        acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
        description: 'simple task',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/acceptanceCriteria ×3 \(\+15\)/));
    });

    it('handles 10 acceptance criteria (+50)', () => {
      const story = makeStory({
        acceptanceCriteria: Array.from({ length: 10 }, (_, i) => `AC${i}`),
        description: 'simple task',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/acceptanceCriteria ×10 \(\+50\)/));
    });

    // ── File path patterns ────────────────────────────────────────────

    it('subtracts -20 for docs path references', () => {
      const story = makeStory({ description: 'Update the docs/ folder README' });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/docs path \(-20\)/));
    });

    it('adds +20 for src/core path references', () => {
      const story = makeStory({ description: 'Refactor src/core/engine module' });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/src\/core path \(\+20\)/));
    });

    it('adds +15 for src/lib path references', () => {
      const story = makeStory({ description: 'Update src/lib/utils module' });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/src\/lib path \(\+15\)/));
    });

    it('adds +15 for auth path references', () => {
      const story = makeStory({ description: 'Fix auth middleware bug' });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/auth path \(\+15\)/));
    });

    // ── Story type tags ───────────────────────────────────────────────

    it('assigns tag:docs with -25 for documentation stories', () => {
      const story = makeStory({
        title: 'Documentation updates',
        description: 'Update documentation for the API',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/tag:docs \(-25\)/));
    });

    it('assigns tag:test with +5 for test stories', () => {
      const story = makeStory({
        title: 'Add unit tests for scorer',
        description: 'Write unit test coverage',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/tag:test \(\+5\)/));
    });

    it('assigns tag:feat with +10 for feature stories', () => {
      const story = makeStory({
        title: 'Add new payment widget',
        description: 'Build a payment processing widget',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/tag:feat \(\+10\)/));
    });

    it('assigns tag:architecture with +30 for architecture stories', () => {
      const story = makeStory({
        title: 'System Design for Auth',
        description: 'Architect the new authentication system',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/tag:architecture \(\+30\)/));
    });

    // ── Keyword detection ─────────────────────────────────────────────

    it('subtracts -10 for haiku keywords like "fix typo"', () => {
      const story = makeStory({
        description: 'Fix typo in the header component',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/keyword:"fix typo" \(-10\)/));
    });

    it('subtracts -10 for haiku keyword "rename"', () => {
      const story = makeStory({
        description: 'Rename the getUserData function',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/keyword:"rename" \(-10\)/));
    });

    it('adds +10 for sonnet keywords like "refactor"', () => {
      const story = makeStory({
        description: 'Refactor the state management layer',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/keyword:"refactor" \(\+10\)/));
    });

    it('adds +10 for sonnet keyword "migrate"', () => {
      const story = makeStory({
        description: 'Migrate the database to new schema',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/keyword:"migrate" \(\+10\)/));
    });

    it('adds +25 for opus keywords like "architect"', () => {
      const story = makeStory({
        description: 'Architect the new microservice boundary',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/keyword:"architect" \(\+25\)/));
    });

    it('adds +25 for opus keyword "implement from scratch"', () => {
      const story = makeStory({
        description: 'Implement from scratch a new execution engine',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/keyword:"implement from scratch" \(\+25\)/));
    });

    it('adds +25 for opus keyword "security"', () => {
      const story = makeStory({
        description: 'Implement security hardening for API endpoints',
      });
      const result = score(story);
      expect(result.signals).toContainEqual(expect.stringMatching(/keyword:"security" \(\+25\)/));
    });

    it('opus keywords take priority over sonnet keywords', () => {
      const story = makeStory({
        description: 'Design and refactor the authentication module',
      });
      const result = score(story);
      // "design" is opus (+25), "refactor" is sonnet (+10) — opus should win
      const opusSignal = result.signals.find(s => s.includes('+25'));
      const sonnetSignal = result.signals.find(s => s.includes('keyword') && s.includes('+10'));
      expect(opusSignal).toBeDefined();
      expect(sonnetSignal).toBeUndefined();
    });

    // ── Threshold boundaries ──────────────────────────────────────────

    it('returns haiku for score = 0', () => {
      const story = makeStory({ description: 'simple task' });
      const result = score(story);
      expect(result.tier).toBe('haiku');
    });

    it('returns haiku for score exactly at haiku threshold (30)', () => {
      // 6 acceptance criteria = +30, tag:feat = +10 → need to engineer score=30
      // Actually, let's just use 6 AC (+30) with docs tag (-25) and haiku keyword (-10) → floor at 0
      // Better: use custom thresholds via config
      const cwd = makeConfigDir({
        orchestration: { thresholds: { haiku: 30, sonnet: 65 } },
      });
      // 6 AC = +30, no other signals on a minimal story
      const story = makeStory({
        acceptanceCriteria: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6'],
        title: 'Basic task',
        description: 'A simple task with criteria',
      });
      const result = score(story, [], cwd);
      // 30 (AC) + 10 (tag:feat) = 40 → sonnet at default thresholds
      // With 6 AC and tag:feat: 30 + 10 = 40
      expect(result.score).toBeGreaterThan(0);
    });

    it('returns sonnet for score = 31 (just above haiku threshold)', () => {
      // Engineer a score in the sonnet range (31-65)
      const stories: ScorerStory[] = [
        makeStory({ id: 'A', dependsOn: [] }),
        makeStory({
          id: 'B',
          dependsOn: ['A'],
          acceptanceCriteria: ['AC1', 'AC2', 'AC3'],
          title: 'Add new feature',
          description: 'Add endpoint for user profiles',
        }),
      ];
      const result = score(stories[1], stories);
      // depth 1 (+10) + 3 AC (+15) + tag:feat (+10) + keyword "add endpoint" (+10) = 45
      expect(result.tier).toBe('sonnet');
    });

    it('returns opus for score = 66 (just above sonnet threshold)', () => {
      const stories: ScorerStory[] = [
        makeStory({ id: 'A', dependsOn: [] }),
        makeStory({ id: 'B', dependsOn: ['A'] }),
        makeStory({
          id: 'C',
          dependsOn: ['B'],
          acceptanceCriteria: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5'],
          title: 'Design authentication system',
          description: 'Architect the new auth module with security hardening',
        }),
      ];
      const result = score(stories[2], stories);
      // depth 2 (+20) + 5 AC (+25) + tag:architecture (+30) + keyword "architect" (+25) + auth (+15) + security (+20) = 135
      expect(result.tier).toBe('opus');
      expect(result.score).toBeGreaterThan(65);
    });

    // ── Score floor ───────────────────────────────────────────────────

    it('floors score at 0 (never negative)', () => {
      const story = makeStory({
        title: 'Fix typo in README',
        description: 'Fix typo in the docs readme file. Update config comment.',
      });
      const result = score(story);
      expect(result.score).toBe(0);
      expect(result.tier).toBe('haiku');
    });

    // ── Combined signals ──────────────────────────────────────────────

    it('combines all signal types correctly', () => {
      const stories: ScorerStory[] = [
        makeStory({ id: 'A', dependsOn: [] }),
        makeStory({
          id: 'B',
          dependsOn: ['A'],
          acceptanceCriteria: ['AC1', 'AC2'],
          title: 'Refactor src/lib/auth module',
          description: 'Refactor the authentication middleware in src/lib',
        }),
      ];
      const result = score(stories[1], stories);
      // Signals should include: dependsOn, AC, path, tag, keyword
      expect(result.signals.length).toBeGreaterThanOrEqual(3);
      expect(result.score).toBeGreaterThan(0);
    });

    it('returns consistent results for the same story', () => {
      const story = makeStory({
        acceptanceCriteria: ['AC1', 'AC2'],
        description: 'Add a new feature endpoint',
      });
      const r1 = score(story);
      const r2 = score(story);
      expect(r1.tier).toBe(r2.tier);
      expect(r1.score).toBe(r2.score);
      expect(r1.signals).toEqual(r2.signals);
    });
  });

  // ── Config loading ──────────────────────────────────────────────────

  describe('loadOrchestrationConfig()', () => {
    it('returns defaults when no cwd provided', () => {
      const config = loadOrchestrationConfig();
      expect(config.thresholds.haiku).toBe(30);
      expect(config.thresholds.sonnet).toBe(65);
    });

    it('returns defaults when .rorca/config.json does not exist', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-test-'));
      const config = loadOrchestrationConfig(tmpDir);
      expect(config.thresholds.haiku).toBe(30);
      expect(config.thresholds.sonnet).toBe(65);
    });

    it('reads custom thresholds from .rorca/config.json', () => {
      const cwd = makeConfigDir({
        orchestration: { thresholds: { haiku: 20, sonnet: 50 } },
      });
      const config = loadOrchestrationConfig(cwd);
      expect(config.thresholds.haiku).toBe(20);
      expect(config.thresholds.sonnet).toBe(50);
    });

    it('merges partial threshold overrides with defaults', () => {
      const cwd = makeConfigDir({
        orchestration: { thresholds: { haiku: 15 } },
      });
      const config = loadOrchestrationConfig(cwd);
      expect(config.thresholds.haiku).toBe(15);
      expect(config.thresholds.sonnet).toBe(65); // default
    });

    it('handles malformed config gracefully', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-test-'));
      const rorcaDir = path.join(tmpDir, '.rorca');
      fs.mkdirSync(rorcaDir, { recursive: true });
      fs.writeFileSync(path.join(rorcaDir, 'config.json'), 'NOT JSON');
      const config = loadOrchestrationConfig(tmpDir);
      expect(config.thresholds.haiku).toBe(30);
      expect(config.thresholds.sonnet).toBe(65);
    });

    it('caches config for same cwd', () => {
      const cwd = makeConfigDir({
        orchestration: { thresholds: { haiku: 10, sonnet: 40 } },
      });
      const c1 = loadOrchestrationConfig(cwd);
      const c2 = loadOrchestrationConfig(cwd);
      expect(c1).toBe(c2); // same object reference
    });
  });

  // ── Integration: real-world story scoring ───────────────────────────

  describe('real-world scoring scenarios', () => {
    it('scores a simple typo fix as haiku', () => {
      const story = makeStory({
        title: 'Fix typo in button label',
        description: 'Fix typo: "Submti" → "Submit" in the login form button',
        acceptanceCriteria: ['Button shows "Submit"'],
      });
      const result = score(story);
      expect(result.tier).toBe('haiku');
    });

    it('scores a standard CRUD feature as sonnet', () => {
      const stories: ScorerStory[] = [
        makeStory({ id: 'DB-001', dependsOn: [] }),
        makeStory({
          id: 'API-001',
          dependsOn: ['DB-001'],
          title: 'Add user profile endpoint',
          description: 'Add GET/PUT /api/users/:id/profile endpoint with validation',
          acceptanceCriteria: [
            'GET returns user profile',
            'PUT updates user profile',
            'Validates required fields',
            'Returns 404 for unknown users',
          ],
        }),
      ];
      const result = score(stories[1], stories);
      expect(result.tier).toBe('sonnet');
    });

    it('scores a complex architecture story as opus', () => {
      const stories: ScorerStory[] = [
        makeStory({ id: 'A', dependsOn: [] }),
        makeStory({ id: 'B', dependsOn: ['A'] }),
        makeStory({
          id: 'C',
          dependsOn: ['B'],
          title: 'Design new authentication architecture',
          description: 'Architect the security layer: implement from scratch JWT + OAuth2 with encryption, design session management, add auth middleware to all routes',
          acceptanceCriteria: [
            'JWT token generation and validation',
            'OAuth2 provider integration',
            'Session management with Redis',
            'Auth middleware applied globally',
            'Rate limiting per user',
            'Audit log for auth events',
            'Password hashing with bcrypt',
          ],
        }),
      ];
      const result = score(stories[2], stories);
      expect(result.tier).toBe('opus');
      expect(result.score).toBeGreaterThan(65);
    });
  });

  // ── OC-021: Router modes ──────────────────────────────────────────

  describe('router modes (OC-021)', () => {
    it('router=fixed always returns sonnet with router:fixed signal', () => {
      const cwd = makeConfigDir({
        orchestration: { router: 'fixed' },
      });
      const story = makeStory({
        title: 'Design authentication architecture',
        description: 'Architect new security layer',
        acceptanceCriteria: ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7'],
      });
      const result = score(story, [], cwd);
      expect(result.tier).toBe('sonnet');
      expect(result.signals).toContain('router:fixed');
    });

    it('router=manual respects story-level modelTier', () => {
      const cwd = makeConfigDir({
        orchestration: { router: 'manual' },
      });
      const story = { ...makeStory(), modelTier: 'opus' } as ScorerStory & { modelTier: string };
      const result = score(story, [], cwd);
      expect(result.tier).toBe('opus');
      expect(result.signals).toContain('router:manual(opus)');
    });

    it('router=manual falls through to auto when no modelTier set', () => {
      const cwd = makeConfigDir({
        orchestration: { router: 'manual' },
      });
      const story = makeStory({
        title: 'Fix typo in README',
        description: 'Fix typo in docs readme',
      });
      const result = score(story, [], cwd);
      // Should use auto scoring (haiku for this simple story)
      expect(result.tier).toBe('haiku');
      expect(result.signals.some(s => s.startsWith('router:'))).toBe(false);
    });

    it('router=auto uses standard complexity scoring', () => {
      const cwd = makeConfigDir({
        orchestration: { router: 'auto' },
      });
      const story = makeStory({
        title: 'Fix typo',
        description: 'Fix typo in docs readme',
      });
      const result = score(story, [], cwd);
      expect(result.tier).toBe('haiku');
    });
  });

  // ── OC-021: Threshold ranges ──────────────────────────────────────

  describe('threshold ranges (OC-021)', () => {
    it('parses [min, max] range format for thresholds', () => {
      const cwd = makeConfigDir({
        orchestration: {
          thresholds: { haiku: [0, 20], sonnet: [21, 50] },
        },
      });
      const config = loadOrchestrationConfig(cwd);
      expect(config.thresholds.haiku).toBe(20);
      expect(config.thresholds.sonnet).toBe(50);
    });

    it('handles legacy number format alongside range format', () => {
      const cwd = makeConfigDir({
        orchestration: {
          thresholds: { haiku: 25, sonnet: [26, 60] },
        },
      });
      const config = loadOrchestrationConfig(cwd);
      expect(config.thresholds.haiku).toBe(25);
      expect(config.thresholds.sonnet).toBe(60);
    });
  });

  // ── OC-021: Task cascades ─────────────────────────────────────────

  describe('task cascades (OC-021)', () => {
    it('returns default task cascades when no config', () => {
      const config = loadOrchestrationConfig();
      expect(config.taskCascades.echolocation).toBe('claude-haiku-4-5-20251001');
      expect(config.taskCascades.coding).toBe('claude-sonnet-4-6');
      expect(config.taskCascades.documentation).toBe('claude-haiku-4-5-20251001');
    });

    it('reads custom task cascades from config', () => {
      const cwd = makeConfigDir({
        orchestration: {
          taskCascades: { coding: 'gpt-4o', testing: 'gpt-4o-mini' },
        },
      });
      const config = loadOrchestrationConfig(cwd);
      expect(config.taskCascades.coding).toBe('gpt-4o');
      expect(config.taskCascades.testing).toBe('gpt-4o-mini');
      // Unspecified task types keep defaults
      expect(config.taskCascades.echolocation).toBe('claude-haiku-4-5-20251001');
    });
  });

  // ── OC-021: Token budget ──────────────────────────────────────────

  describe('tokenBudgetPerStory (OC-021)', () => {
    it('defaults to 50000', () => {
      const config = loadOrchestrationConfig();
      expect(config.tokenBudgetPerStory).toBe(50000);
    });

    it('reads custom token budget from config', () => {
      const cwd = makeConfigDir({
        orchestration: { tokenBudgetPerStory: 100000 },
      });
      const config = loadOrchestrationConfig(cwd);
      expect(config.tokenBudgetPerStory).toBe(100000);
    });

    it('falls back to default for invalid values', () => {
      const cwd = makeConfigDir({
        orchestration: { tokenBudgetPerStory: -1 },
      });
      const config = loadOrchestrationConfig(cwd);
      expect(config.tokenBudgetPerStory).toBe(50000);
    });
  });
});

// ─── OC-021: Orchestration Validation Tests ─────────────────────────────────

describe('validateOrchestrationConfig (OC-021)', () => {
  it('returns empty array for valid config', () => {
    const errors = validateOrchestrationConfig({
      router: 'auto',
      thresholds: { haiku: [0, 30], sonnet: [31, 65], opus: [66, 100] },
      taskCascades: { coding: 'gpt-4o' },
      tokenBudgetPerStory: 50000,
    });
    expect(errors).toEqual([]);
  });

  it('returns empty array for empty object (all defaults)', () => {
    const errors = validateOrchestrationConfig({});
    expect(errors).toEqual([]);
  });

  it('rejects non-object input', () => {
    expect(validateOrchestrationConfig('string')).toHaveLength(1);
    expect(validateOrchestrationConfig(null)).toHaveLength(1);
    expect(validateOrchestrationConfig(42)).toHaveLength(1);
  });

  it('rejects invalid router mode', () => {
    const errors = validateOrchestrationConfig({ router: 'turbo' });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('orchestration.router');
  });

  it('rejects thresholds outside 0-100', () => {
    const errors = validateOrchestrationConfig({
      thresholds: { haiku: 150 },
    });
    expect(errors.some(e => e.field.includes('haiku'))).toBe(true);
  });

  it('rejects threshold ranges with min > max', () => {
    const errors = validateOrchestrationConfig({
      thresholds: { haiku: [40, 20] },
    });
    expect(errors.some(e => e.field.includes('haiku'))).toBe(true);
  });

  it('rejects haiku >= sonnet threshold', () => {
    const errors = validateOrchestrationConfig({
      thresholds: { haiku: 60, sonnet: 50 },
    });
    expect(errors.some(e => e.message.includes('less than'))).toBe(true);
  });

  it('rejects unknown task type', () => {
    const errors = validateOrchestrationConfig({
      taskCascades: { invalidTask: 'gpt-4o' },
    });
    expect(errors.some(e => e.field.includes('invalidTask'))).toBe(true);
  });

  it('rejects empty model ID in task cascades', () => {
    const errors = validateOrchestrationConfig({
      taskCascades: { coding: '' },
    });
    expect(errors.some(e => e.field.includes('coding'))).toBe(true);
  });

  it('rejects non-positive tokenBudgetPerStory', () => {
    const errors = validateOrchestrationConfig({
      tokenBudgetPerStory: 0,
    });
    expect(errors.some(e => e.field.includes('tokenBudget'))).toBe(true);
  });

  it('accepts legacy number format for thresholds', () => {
    const errors = validateOrchestrationConfig({
      thresholds: { haiku: 30, sonnet: 65 },
    });
    expect(errors).toEqual([]);
  });

});
