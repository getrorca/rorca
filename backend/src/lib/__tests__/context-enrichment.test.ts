/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockRetrieveContext = jest.fn();
const mockGetDirectionLayers = jest.fn();
const mockGetInstalledSkills = jest.fn();
const mockCheckAge = jest.fn();
const mockEcholocate = jest.fn();
const mockInferSkillsFromStack = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

jest.mock('../memory-router', () => ({
  retrieveContext: (...args: unknown[]) => mockRetrieveContext(...args),
}));

jest.mock('../context-cache', () => ({
  getDirectionLayers: (...args: unknown[]) => mockGetDirectionLayers(...args),
  getInstalledSkills: (...args: unknown[]) => mockGetInstalledSkills(...args),
}));

jest.mock('../age-guard', () => ({
  checkAge: (...args: unknown[]) => mockCheckAge(...args),
}));

jest.mock('../workspace-echolocation', () => ({
  echolocate: (...args: unknown[]) => mockEcholocate(...args),
  inferSkillsFromStack: (...args: unknown[]) => mockInferSkillsFromStack(...args),
}));

describe('context-enrichment', () => {
  let workspacePath: string;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-context-enrichment-'));
    fs.mkdirSync(path.join(workspacePath, 'forge', 'specs', 'approved'), { recursive: true });

    mockQueryOne.mockResolvedValue({ id: 'ws-1', path: workspacePath });
    mockEcholocate.mockReturnValue({
      stack: [{ name: 'React', source: 'package.json' }],
      contextFiles: [],
      missing: [],
      monorepo: { detected: false, packages: [], tool: null, apps: [] },
      score: 80,
      suggestions: [],
      scannedAt: new Date().toISOString(),
    });
    mockInferSkillsFromStack.mockReturnValue(['react']);
  });

  afterEach(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  test('semantic mode degrades cleanly to direction-only graph output when AGE is unavailable', async () => {
    fs.writeFileSync(
      path.join(workspacePath, 'forge', 'specs', 'approved', 'spec-a.json'),
      JSON.stringify({
        userStories: [
          {
            id: 'US-001',
            title: 'Refactor the auth panel',
            description: 'Touch src/panels/Auth.tsx and align conventions',
            acceptanceCriteria: ['Use existing patterns'],
          },
        ],
      }),
    );

    mockCheckAge.mockResolvedValue(false);
    mockRetrieveContext.mockResolvedValue({
      direction: { standards: 'L1', conventions: 'L2', project: 'L3' },
      memory: [{ text: 'Pinned memory', score: 1, source: 'cache' }],
      skills: [{ name: 'react', content: 'Prefer contexts' }],
      graphContext: { relatedStories: [{ id: 'US-099', title: 'prior', relevance: 0.8 }], fileTouches: [], conventionLinks: [] },
      graphSection: 'graph text',
      meta: { cagHits: 1, ragHits: 1, graphHits: 3, totalTokens: 123, latencyMs: 5, tier: 'hybrid' },
    });

    const { buildContextForStory } = require('../context-enrichment');
    const result = await buildContextForStory('US-001', 'spec-a', 'ws-1', { mode: 'semantic' });

    expect(mockRetrieveContext).toHaveBeenCalledWith(
      'ws-1',
      expect.stringContaining('Refactor the auth panel'),
      expect.objectContaining({
        includeGraph: false,
        storyId: 'US-001',
      }),
    );
    expect(result.graphContext).toBeNull();
    expect(result.graphSection).toBe('');
    expect(result.meta.graphHits).toBe(0);
    expect(result.meta.tier).toBe('rag');
    expect(result.meta.graphAvailable).toBe(false);
  });

  test('recent mode returns pinned-first memory and skips graph retrieval entirely', async () => {
    mockGetDirectionLayers.mockResolvedValue({
      l1: 'Global standards',
      l2: 'Domain conventions',
      l3: 'Project context',
      schemaSnapshot: null,
    });
    mockGetInstalledSkills.mockResolvedValue([
      { name: 'react', content: 'Use contexts' },
    ]);
    mockQuery.mockResolvedValue([
      { content: 'Pinned memory', pinned: true },
      { content: 'Recent memory', pinned: false },
    ]);

    const { buildContextForStory } = require('../context-enrichment');
    const result = await buildContextForStory(null, 'spec-a', 'ws-1', {
      mode: 'recent',
      maxTokens: 400,
    });

    expect(mockRetrieveContext).not.toHaveBeenCalled();
    expect(result.graphContext).toBeNull();
    expect(result.graphSection).toBe('');
    expect(result.memory.map((entry: { text: string }) => entry.text)).toEqual([
      'Pinned memory',
      'Recent memory',
    ]);
    expect(result.meta.mode).toBe('recent');
    expect(result.meta.tier).toBe('cag');
  });
});
