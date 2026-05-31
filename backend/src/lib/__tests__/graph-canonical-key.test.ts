/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * GI-003: Regression coverage for canonical key-based graph identity.
 *
 * Proves that the same story ID in two specs and the same file path in two
 * workspaces do not collide when using canonical keys.
 */

import {
  buildStoryNodeKey,
  buildFileNodeKey,
  buildSpecNodeKey,
  buildMemoryNodeKey,
  buildConventionNodeKey,
  buildSkillNodeKey,
  normalizeGraphFilePath,
} from '../knowledge-graph';

describe('Graph Canonical Key Identity (GI-003)', () => {
  describe('Canonical key builders provide scoped identity', () => {
    it('buildStoryNodeKey scopes by workspaceId and specId to prevent collisions', () => {
      const key1 = buildStoryNodeKey('ws-1', 'spec-a', 'US-001');
      const key2 = buildStoryNodeKey('ws-2', 'spec-a', 'US-001');

      expect(key1).toBe('story:ws-1::spec-a::US-001');
      expect(key2).toBe('story:ws-2::spec-a::US-001');
      expect(key1).not.toBe(key2);
    });

    it('buildFileNodeKey scopes by workspaceId to prevent cross-workspace collisions', () => {
      const key1 = buildFileNodeKey('ws-1', 'src/index.ts');
      const key2 = buildFileNodeKey('ws-2', 'src/index.ts');

      expect(key1).toBe('file:ws-1::src/index.ts');
      expect(key2).toBe('file:ws-2::src/index.ts');
      expect(key1).not.toBe(key2);
    });

    it('buildSpecNodeKey scopes by workspaceId to prevent cross-workspace collisions', () => {
      const key1 = buildSpecNodeKey('ws-1', 'my-spec');
      const key2 = buildSpecNodeKey('ws-2', 'my-spec');

      expect(key1).toBe('spec:ws-1::my-spec');
      expect(key2).toBe('spec:ws-2::my-spec');
      expect(key1).not.toBe(key2);
    });

    it('buildMemoryNodeKey scopes by workspaceId to prevent cross-workspace collisions', () => {
      const key1 = buildMemoryNodeKey('ws-1', 'mem-123');
      const key2 = buildMemoryNodeKey('ws-2', 'mem-123');

      expect(key1).toBe('memory:ws-1::mem-123');
      expect(key2).toBe('memory:ws-2::mem-123');
      expect(key1).not.toBe(key2);
    });

    it('buildConventionNodeKey scopes by workspaceId to prevent cross-workspace collisions', () => {
      const key1 = buildConventionNodeKey('ws-1', 'tailwind');
      const key2 = buildConventionNodeKey('ws-2', 'tailwind');

      expect(key1).toBe('convention:ws-1::tailwind');
      expect(key2).toBe('convention:ws-2::tailwind');
      expect(key1).not.toBe(key2);
    });

    it('buildSkillNodeKey scopes by source to prevent cross-source collisions', () => {
      const key1 = buildSkillNodeKey('react', 'github.com/vercel/agent-skills');
      const key2 = buildSkillNodeKey('react', 'default');

      expect(key1).toBe('skill:github.com/vercel/agent-skills::react');
      expect(key2).toBe('skill:default::react');
      expect(key1).not.toBe(key2);
    });

    it('buildSkillNodeKey handles missing source parameter', () => {
      const key = buildSkillNodeKey('react');

      expect(key).toBe('skill:default::react');
    });
  });

  describe('File path normalization for graph identity', () => {
    it('normalizeGraphFilePath removes leading ./ and normalizes separators', () => {
      expect(normalizeGraphFilePath('./src/index.ts')).toBe('src/index.ts');
      expect(normalizeGraphFilePath('src/index.ts')).toBe('src/index.ts');
      expect(normalizeGraphFilePath('src\\index.ts')).toBe('src/index.ts');
    });

    it('normalizeGraphFilePath returns empty string for invalid paths', () => {
      expect(normalizeGraphFilePath('')).toBe('');
      expect(normalizeGraphFilePath('.')).toBe('');
      expect(normalizeGraphFilePath('./')).toBe('');
    });

    it('buildFileNodeKey normalizes file paths automatically', () => {
      const key1 = buildFileNodeKey('ws-1', './src/app.ts');
      const key2 = buildFileNodeKey('ws-1', 'src/app.ts');
      const key3 = buildFileNodeKey('ws-1', 'src\\app.ts');

      expect(key1).toBe('file:ws-1::src/app.ts');
      expect(key2).toBe('file:ws-1::src/app.ts');
      expect(key3).toBe('file:ws-1::src/app.ts');
      expect(key1).toBe(key2);
      expect(key2).toBe(key3);
    });
  });

  describe('Collision prevention scenarios', () => {
    it('same story ID in two different specs produces distinct keys', () => {
      const specA = buildStoryNodeKey('ws-1', 'spec-a', 'US-001');
      const specB = buildStoryNodeKey('ws-1', 'spec-b', 'US-001');

      expect(specA).not.toBe(specB);
      expect(specA).toContain('spec-a');
      expect(specB).toContain('spec-b');
    });

    it('same story ID in the same spec slug across workspaces produces distinct keys', () => {
      const ws1 = buildStoryNodeKey('ws-1', 'spec-a', 'US-001');
      const ws2 = buildStoryNodeKey('ws-2', 'spec-a', 'US-001');

      expect(ws1).not.toBe(ws2);
      expect(ws1).toContain('ws-1');
      expect(ws2).toContain('ws-2');
    });

    it('same file path in two different workspaces produces distinct keys', () => {
      const ws1 = buildFileNodeKey('ws-1', 'src/index.ts');
      const ws2 = buildFileNodeKey('ws-2', 'src/index.ts');

      expect(ws1).not.toBe(ws2);
      expect(ws1).toContain('ws-1');
      expect(ws2).toContain('ws-2');
    });

    it('same spec ID in two different workspaces produces distinct keys', () => {
      const ws1 = buildSpecNodeKey('ws-1', 'my-spec');
      const ws2 = buildSpecNodeKey('ws-2', 'my-spec');

      expect(ws1).not.toBe(ws2);
      expect(ws1).toContain('ws-1');
      expect(ws2).toContain('ws-2');
    });

    it('same memory ID in two different workspaces produces distinct keys', () => {
      const ws1 = buildMemoryNodeKey('ws-1', 'mem-1');
      const ws2 = buildMemoryNodeKey('ws-2', 'mem-1');

      expect(ws1).not.toBe(ws2);
      expect(ws1).toContain('ws-1');
      expect(ws2).toContain('ws-2');
    });

    it('same convention name in two different workspaces produces distinct keys', () => {
      const ws1 = buildConventionNodeKey('ws-1', 'tailwind');
      const ws2 = buildConventionNodeKey('ws-2', 'tailwind');

      expect(ws1).not.toBe(ws2);
      expect(ws1).toContain('ws-1');
      expect(ws2).toContain('ws-2');
    });

    it('same skill name from two different sources produces distinct keys', () => {
      const source1 = buildSkillNodeKey('react', 'vercel/agent-skills');
      const source2 = buildSkillNodeKey('react', 'anthropics/skills');

      expect(source1).not.toBe(source2);
      expect(source1).toContain('vercel/agent-skills');
      expect(source2).toContain('anthropics/skills');
    });
  });

  describe('Key format and structure validation', () => {
    it('all node keys follow the type:scope::identifier pattern', () => {
      const storyKey = buildStoryNodeKey('ws-1', 'spec-a', 'US-001');
      const fileKey = buildFileNodeKey('ws-1', 'src/app.ts');
      const specKey = buildSpecNodeKey('ws-1', 'my-spec');
      const memoryKey = buildMemoryNodeKey('ws-1', 'mem-1');
      const conventionKey = buildConventionNodeKey('ws-1', 'tailwind');
      const skillKey = buildSkillNodeKey('react', 'default');

      expect(storyKey).toMatch(/^story:[^:]+::[^:]+::.+$/);
      expect(fileKey).toMatch(/^file:[^:]+::.+$/);
      expect(specKey).toMatch(/^spec:[^:]+::.+$/);
      expect(memoryKey).toMatch(/^memory:[^:]+::.+$/);
      expect(conventionKey).toMatch(/^convention:[^:]+::.+$/);
      expect(skillKey).toMatch(/^skill:[^:]+::.+$/);
    });

    it('keys are deterministic and repeatable', () => {
      const key1 = buildStoryNodeKey('ws-1', 'spec-a', 'US-001');
      const key2 = buildStoryNodeKey('ws-1', 'spec-a', 'US-001');

      expect(key1).toBe(key2);
    });
  });
});
