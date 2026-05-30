/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as path from 'path';
import {
  buildConventionIdentity,
  buildFileIdentity,
  buildMemoryIdentity,
  buildSkillIdentity,
  buildSpecIdentity,
  buildStoryIdentity,
  buildWorkspaceIdentity,
  conventionKey,
  fileKey,
  GRAPH_IDENTITY_NODE_TYPES,
  memoryKey,
  normalizeGraphFilePath,
  skillKey,
  specKey,
  storyKey,
  workspaceKey,
} from '../lib/graph-identity';

describe('graph-identity', () => {
  describe('canonical key builders', () => {
    it('exports the supported canonical graph node types', () => {
      expect(GRAPH_IDENTITY_NODE_TYPES).toEqual([
        'workspace',
        'spec',
        'story',
        'file',
        'memory',
        'convention',
        'skill',
      ]);
    });

    it('build deterministic canonical keys for every supported node type', () => {
      expect(workspaceKey('ws-1')).toBe('workspace/ws-1');
      expect(specKey('ws-1', 'spec-1')).toBe('workspace/ws-1/spec/spec-1');
      expect(storyKey('ws-1', 'spec-1', 'GI-002')).toBe(
        'workspace/ws-1/spec/spec-1/story/GI-002',
      );
      expect(fileKey('ws-1', 'backend/src/lib/graph-identity.ts')).toBe(
        'workspace/ws-1/file/backend/src/lib/graph-identity.ts',
      );
      expect(memoryKey('ws-1', 'note-1')).toBe('workspace/ws-1/memory/note-1');
      expect(conventionKey('ws-1', '.rorca/skills/node.md')).toBe(
        'workspace/ws-1/convention/.rorca%2Fskills%2Fnode.md',
      );
      expect(skillKey('ws-1', 'typescript.md')).toBe(
        'workspace/ws-1/skill/typescript.md',
      );
    });

    it('returns identity objects that preserve human-readable properties', () => {
      expect(buildWorkspaceIdentity(' ws-1 ')).toEqual({
        key: 'workspace/ws-1',
        workspaceId: 'ws-1',
      });
      expect(buildSpecIdentity(' ws-1 ', ' spec-1 ')).toEqual({
        key: 'workspace/ws-1/spec/spec-1',
        workspaceId: 'ws-1',
        specId: 'spec-1',
      });
      expect(buildStoryIdentity(' ws-1 ', ' spec-1 ', ' GI-002 ')).toEqual({
        key: 'workspace/ws-1/spec/spec-1/story/GI-002',
        workspaceId: 'ws-1',
        specId: 'spec-1',
        storyId: 'GI-002',
      });
      expect(buildMemoryIdentity(' ws-1 ', ' memory-1 ')).toEqual({
        key: 'workspace/ws-1/memory/memory-1',
        workspaceId: 'ws-1',
        memoryId: 'memory-1',
      });
      expect(buildConventionIdentity(' ws-1 ', '  team/rules.md  ')).toEqual({
        key: 'workspace/ws-1/convention/team%2Frules.md',
        workspaceId: 'ws-1',
        name: 'team/rules.md',
      });
      expect(buildSkillIdentity(' ws-1 ', '  typescript.md  ')).toEqual({
        key: 'workspace/ws-1/skill/typescript.md',
        workspaceId: 'ws-1',
        name: 'typescript.md',
      });
    });
  });

  describe('file path normalization', () => {
    it('strips leading dot segments and normalizes separators', () => {
      expect(normalizeGraphFilePath('./backend\\src/./lib//graph-identity.ts')).toBe(
        'backend/src/lib/graph-identity.ts',
      );
    });

    it('converts absolute paths inside the workspace to repo-relative paths', () => {
      const workspacePath = path.join('/tmp', 'rorca-workspace');
      const absoluteFilePath = path.join(
        workspacePath,
        'backend',
        'src',
        'lib',
        'graph-identity.ts',
      );

      expect(
        normalizeGraphFilePath(absoluteFilePath, { workspacePath }),
      ).toBe('backend/src/lib/graph-identity.ts');
      expect(fileKey('ws-1', absoluteFilePath, { workspacePath })).toBe(
        'workspace/ws-1/file/backend/src/lib/graph-identity.ts',
      );
    });

    it('preserves normalized file path as a property on file identities', () => {
      expect(buildFileIdentity('ws-1', './backend\\src/lib/graph-identity.ts')).toEqual({
        key: 'workspace/ws-1/file/backend/src/lib/graph-identity.ts',
        workspaceId: 'ws-1',
        path: 'backend/src/lib/graph-identity.ts',
      });
    });

    it('rejects absolute paths when no workspace root is provided', () => {
      expect(() => normalizeGraphFilePath('/tmp/graph-identity.ts')).toThrow(
        'absolute file paths require a workspacePath',
      );
    });

    it('rejects paths that escape the workspace root', () => {
      const workspacePath = path.join('/tmp', 'rorca-workspace');
      const outsideFilePath = path.join('/tmp', 'other', 'graph-identity.ts');

      expect(() =>
        normalizeGraphFilePath(outsideFilePath, { workspacePath }),
      ).toThrow('file path must stay within the workspace');
    });
  });
});
