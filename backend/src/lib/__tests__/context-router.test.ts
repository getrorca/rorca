/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  estimateTokens,
  extractPathMentions,
  matchScopes,
  matchTags,
  resolveConflicts,
  enforceBudget,
  route,
  writeContextFile,
  type ContextStory,
  type ContextPayload,
} from '../context-router';
import type { RoutingConfig, RoutingScope } from '../rorca-config';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeStory(overrides: Partial<ContextStory> = {}): ContextStory {
  return {
    id: 'US-001',
    title: 'Test Story',
    description: 'Implement feature in backend/src/routes/api.ts',
    acceptanceCriteria: ['Endpoint returns 200'],
    dependsOn: [],
    tags: [],
    ...overrides,
  };
}

function makeConfig(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    global: ['CLAUDE.md', 'AGENTS.md'],
    scopes: [],
    tags: [],
    tokenBudget: 8000,
    ...overrides,
  };
}

let tmpWorkspace: string;

beforeAll(() => {
  tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-router-test-'));
  // Create test files
  fs.writeFileSync(path.join(tmpWorkspace, 'CLAUDE.md'), 'Global context A');
  fs.writeFileSync(path.join(tmpWorkspace, 'AGENTS.md'), 'Global context B');
  fs.mkdirSync(path.join(tmpWorkspace, '.rorca', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(tmpWorkspace, '.rorca', 'skills', 'backend.md'), 'Backend skill content');
  fs.writeFileSync(path.join(tmpWorkspace, '.rorca', 'skills', 'frontend.md'), 'Frontend skill content');
  fs.writeFileSync(path.join(tmpWorkspace, '.rorca', 'skills', 'security.md'), 'Security skill content');
  fs.writeFileSync(path.join(tmpWorkspace, '.rorca', 'skills', 'testing.md'), 'Testing skill content');
});

afterAll(() => {
  fs.rmSync(tmpWorkspace, { recursive: true, force: true });
});

// ─── Token Estimation ───────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates ~4 chars per token', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });

  it('rounds up partial tokens', () => {
    expect(estimateTokens('abc')).toBe(1); // 3/4 = 0.75 → ceil → 1
  });
});

// ─── Path Prediction ────────────────────────────────────────────────────────

describe('extractPathMentions', () => {
  it('extracts file paths from description', () => {
    const story = makeStory({
      description: 'Modify backend/src/routes/api.ts and src/panels/Forge.tsx',
    });
    const paths = extractPathMentions(story);
    expect(paths).toContain('backend/src/routes/api.ts');
    expect(paths).toContain('src/panels/Forge.tsx');
  });

  it('extracts backtick-wrapped paths', () => {
    const story = makeStory({
      description: 'Update `backend/src/lib/context-router.ts` for new feature',
    });
    const paths = extractPathMentions(story);
    expect(paths).toContain('backend/src/lib/context-router.ts');
  });

  it('extracts paths from acceptanceCriteria', () => {
    const story = makeStory({
      description: 'Some description',
      acceptanceCriteria: ['File src/components/Shell.tsx renders correctly'],
    });
    const paths = extractPathMentions(story);
    expect(paths).toContain('src/components/Shell.tsx');
  });

  it('returns empty array when no paths found', () => {
    const story = makeStory({
      description: 'Add a button to the page',
      acceptanceCriteria: ['Button is visible'],
    });
    const paths = extractPathMentions(story);
    expect(paths).toHaveLength(0);
  });

  it('deduplicates paths', () => {
    const story = makeStory({
      description: 'Edit backend/src/routes/api.ts',
      acceptanceCriteria: ['backend/src/routes/api.ts exports correctly'],
    });
    const paths = extractPathMentions(story);
    const apiPaths = paths.filter(p => p === 'backend/src/routes/api.ts');
    expect(apiPaths).toHaveLength(1);
  });
});

// ─── Scope Matching ─────────────────────────────────────────────────────────

describe('matchScopes', () => {
  const scopes: RoutingScope[] = [
    { path: 'backend/src/**', inject: ['.rorca/skills/backend.md'], priority: 60, managed: 'rorca' },
    { path: 'src/panels/**', inject: ['.rorca/skills/frontend.md'], priority: 50, managed: 'rorca' },
    { path: 'backend/src/routes/**', inject: ['.rorca/skills/security.md'], priority: 70, managed: 'rorca' },
  ];

  it('matches paths against scope globs', () => {
    const matched = matchScopes(['backend/src/routes/api.ts'], scopes);
    expect(matched).toHaveLength(2); // backend/src/** and backend/src/routes/**
  });

  it('returns empty for no matches', () => {
    const matched = matchScopes(['docs/README.md'], scopes);
    expect(matched).toHaveLength(0);
  });

  it('returns empty for empty predicted paths', () => {
    const matched = matchScopes([], scopes);
    expect(matched).toHaveLength(0);
  });

  it('returns empty for empty scopes', () => {
    const matched = matchScopes(['backend/src/foo.ts'], []);
    expect(matched).toHaveLength(0);
  });
});

// ─── Tag Matching ───────────────────────────────────────────────────────────

describe('matchTags', () => {
  const tagRules = [
    { tag: 'security', inject: ['.rorca/skills/security.md'] },
    { tag: 'testing', inject: ['.rorca/skills/testing.md'] },
    { tag: 'frontend', inject: ['.rorca/skills/frontend.md'] },
  ];

  it('matches story tags against rules', () => {
    const matched = matchTags(['security', 'testing'], tagRules);
    expect(matched).toHaveLength(2);
    expect(matched.map(m => m.tag)).toEqual(['security', 'testing']);
  });

  it('is case-insensitive', () => {
    const matched = matchTags(['Security'], tagRules);
    expect(matched).toHaveLength(1);
    expect(matched[0].tag).toBe('security');
  });

  it('returns empty for no matches', () => {
    const matched = matchTags(['database'], tagRules);
    expect(matched).toHaveLength(0);
  });

  it('returns empty for empty tags', () => {
    const matched = matchTags([], tagRules);
    expect(matched).toHaveLength(0);
  });
});

// ─── Priority Resolution ────────────────────────────────────────────────────

describe('resolveConflicts', () => {
  it('keeps highest priority when same file from multiple sources', () => {
    const files = [
      { filePath: 'security.md', content: 'low', tokens: 10, priority: 30, source: 'scoped' as const },
      { filePath: 'security.md', content: 'high', tokens: 10, priority: 70, source: 'tagged' as const },
    ];
    const resolved = resolveConflicts(files);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].priority).toBe(70);
    expect(resolved[0].content).toBe('high');
  });

  it('keeps all files with unique paths', () => {
    const files = [
      { filePath: 'a.md', content: 'a', tokens: 10, priority: 50, source: 'scoped' as const },
      { filePath: 'b.md', content: 'b', tokens: 10, priority: 60, source: 'scoped' as const },
    ];
    const resolved = resolveConflicts(files);
    expect(resolved).toHaveLength(2);
  });
});

// ─── Token Budget Enforcement ───────────────────────────────────────────────

describe('enforceBudget', () => {
  it('never drops global files', () => {
    const files = [
      { filePath: 'CLAUDE.md', content: 'x'.repeat(40000), tokens: 10000, priority: 101, source: 'global' as const },
      { filePath: 'backend.md', content: 'y', tokens: 100, priority: 60, source: 'scoped' as const },
    ];
    const result = enforceBudget(files, 5000);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('CLAUDE.md');
  });

  it('drops lowest-priority scoped files first', () => {
    const files = [
      { filePath: 'CLAUDE.md', content: 'g', tokens: 100, priority: 101, source: 'global' as const },
      { filePath: 'low.md', content: 'l', tokens: 500, priority: 30, source: 'scoped' as const },
      { filePath: 'high.md', content: 'h', tokens: 500, priority: 70, source: 'scoped' as const },
      { filePath: 'med.md', content: 'm', tokens: 500, priority: 50, source: 'scoped' as const },
    ];
    // Budget: 100 (global) + 700 remaining = enough for high + med but not low
    const result = enforceBudget(files, 1100);
    expect(result.map(f => f.filePath)).toContain('CLAUDE.md');
    expect(result.map(f => f.filePath)).toContain('high.md');
    expect(result.map(f => f.filePath)).toContain('med.md');
    expect(result.map(f => f.filePath)).not.toContain('low.md');
  });

  it('keeps all files when under budget', () => {
    const files = [
      { filePath: 'CLAUDE.md', content: 'g', tokens: 100, priority: 101, source: 'global' as const },
      { filePath: 'a.md', content: 'a', tokens: 200, priority: 50, source: 'scoped' as const },
    ];
    const result = enforceBudget(files, 8000);
    expect(result).toHaveLength(2);
  });

  it('handles empty files list', () => {
    const result = enforceBudget([], 8000);
    expect(result).toHaveLength(0);
  });
});

// ─── Full Route Function ────────────────────────────────────────────────────

describe('route', () => {
  it('returns globals when no scopes or tags match', () => {
    const story = makeStory({ description: 'Add a button' });
    const config = makeConfig();
    const payload = route(story, config, tmpWorkspace);

    expect(payload.globals).toHaveLength(2);
    expect(payload.globals[0]).toBe('Global context A');
    expect(payload.globals[1]).toBe('Global context B');
    expect(payload.scoped).toHaveLength(0);
    expect(payload.tagged).toHaveLength(0);
    expect(payload.totalTokens).toBeGreaterThan(0);
    expect(payload.injectedFiles).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });

  it('includes scoped files when story paths match scope globs', () => {
    const story = makeStory({
      description: 'Modify `backend/src/routes/api.ts`',
    });
    const config = makeConfig({
      scopes: [
        { path: 'backend/src/**', inject: ['.rorca/skills/backend.md'], priority: 60, managed: 'rorca' },
      ],
    });
    const payload = route(story, config, tmpWorkspace);

    expect(payload.scoped).toHaveLength(1);
    expect(payload.scoped[0]).toBe('Backend skill content');
  });

  it('includes tagged files when story tags match', () => {
    const story = makeStory({ tags: ['security'] });
    const config = makeConfig({
      tags: [{ tag: 'security', inject: ['.rorca/skills/security.md'] }],
    });
    const payload = route(story, config, tmpWorkspace);

    expect(payload.tagged).toHaveLength(1);
    expect(payload.tagged[0]).toBe('Security skill content');
  });

  it('enforces token budget by dropping low-priority scoped files', () => {
    const story = makeStory({
      description: 'Edit `backend/src/routes/api.ts` and `src/panels/Forge.tsx`',
      tags: ['security'],
    });
    const config = makeConfig({
      scopes: [
        { path: 'backend/src/**', inject: ['.rorca/skills/backend.md'], priority: 60, managed: 'rorca' },
        { path: 'src/panels/**', inject: ['.rorca/skills/frontend.md'], priority: 30, managed: 'rorca' },
      ],
      tags: [{ tag: 'security', inject: ['.rorca/skills/security.md'] }],
      // Very tight budget — globals + at most one more file
      tokenBudget: estimateTokens('Global context A') + estimateTokens('Global context B') + 30,
    });
    const payload = route(story, config, tmpWorkspace);

    // Globals always present
    expect(payload.globals).toHaveLength(2);
    // Under tight budget, lowest-priority scoped files should be dropped
    expect(payload.totalTokens).toBeLessThanOrEqual(config.tokenBudget);
  });

  it('handles missing global files gracefully', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-empty-'));
    const story = makeStory();
    const config = makeConfig();
    const payload = route(story, config, emptyDir);

    expect(payload.globals).toHaveLength(0);
    expect(payload.totalTokens).toBe(0);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('deduplicates files injected by multiple scopes', () => {
    const story = makeStory({
      description: 'Edit `backend/src/routes/api.ts`',
    });
    const config = makeConfig({
      scopes: [
        { path: 'backend/src/**', inject: ['.rorca/skills/backend.md'], priority: 60, managed: 'rorca' },
        { path: 'backend/src/routes/**', inject: ['.rorca/skills/backend.md'], priority: 70, managed: 'rorca' },
      ],
    });
    const payload = route(story, config, tmpWorkspace);

    // Same file injected by two scopes — should be deduplicated, higher priority wins
    expect(payload.scoped).toHaveLength(1);
  });
});

// ─── Context File Writer ────────────────────────────────────────────────────

describe('writeContextFile', () => {
  it('writes payload to a temp file and returns its path', () => {
    const payload: ContextPayload = {
      globals: ['Global content'],
      scoped: ['Scoped content'],
      tagged: ['Tagged content'],
      totalTokens: 100,
      injectedFiles: ['CLAUDE.md', '.rorca/skills/backend.md', '.rorca/skills/security.md'],
    };
    const filePath = writeContextFile(payload);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('RORCA GLOBAL CONTEXT');
    expect(content).toContain('Global content');
    expect(content).toContain('RORCA SCOPED CONTEXT');
    expect(content).toContain('Scoped content');
    expect(content).toContain('RORCA TAGGED CONTEXT');
    expect(content).toContain('Tagged content');

    // Cleanup
    fs.unlinkSync(filePath);
  });

  it('omits empty sections', () => {
    const payload: ContextPayload = {
      globals: ['Global only'],
      scoped: [],
      tagged: [],
      totalTokens: 10,
      injectedFiles: ['CLAUDE.md'],
    };
    const filePath = writeContextFile(payload);
    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('RORCA GLOBAL CONTEXT');
    expect(content).not.toContain('RORCA SCOPED CONTEXT');
    expect(content).not.toContain('RORCA TAGGED CONTEXT');

    fs.unlinkSync(filePath);
  });
});
