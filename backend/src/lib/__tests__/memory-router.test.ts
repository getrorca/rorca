/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockGetDirectionLayers = jest.fn();
const mockGetRecentMemory = jest.fn();
const mockGetInstalledSkills = jest.fn();
const mockCacheStats = jest.fn();
const mockHybridSearch = jest.fn();
const mockGraphStats = jest.fn();
const mockQueryRelated = jest.fn();
const mockQueryImpact = jest.fn();
const mockGetGraphContext = jest.fn();
const mockPersistRetrievalTelemetry = jest.fn();
const mockRecordRetrievalTelemetry = jest.fn();
const mockGetHistoricalUsefulnessMap = jest.fn();
const mockRecordRetrievalSelection = jest.fn();
const mockDbQuery = jest.fn();

jest.mock('../context-cache', () => ({
  getDirectionLayers: (...args: unknown[]) => mockGetDirectionLayers(...args),
  getRecentMemory: (...args: unknown[]) => mockGetRecentMemory(...args),
  getInstalledSkills: (...args: unknown[]) => mockGetInstalledSkills(...args),
  cacheStats: (...args: unknown[]) => mockCacheStats(...args),
}));

jest.mock('../search', () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
}));

jest.mock('../knowledge-graph', () => ({
  queryRelated: (...args: unknown[]) => mockQueryRelated(...args),
  queryImpact: (...args: unknown[]) => mockQueryImpact(...args),
  graphStats: (...args: unknown[]) => mockGraphStats(...args),
}));

jest.mock('../graph-context', () => ({
  getGraphContext: (...args: unknown[]) => mockGetGraphContext(...args),
  formatGraphContext: jest.fn().mockReturnValue(''),
}));

jest.mock('../retrieval-telemetry', () => ({
  persistRetrievalTelemetry: (...args: unknown[]) => mockPersistRetrievalTelemetry(...args),
  recordRetrievalTelemetry: (...args: unknown[]) => mockRecordRetrievalTelemetry(...args),
}));

jest.mock('../retrieval-feedback', () => ({
  getHistoricalUsefulnessMap: (...args: unknown[]) => mockGetHistoricalUsefulnessMap(...args),
  recordRetrievalSelection: (...args: unknown[]) => mockRecordRetrievalSelection(...args),
}));

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockDbQuery(...args),
}));

jest.mock('../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('memory-router execution budgeting', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    mockGetDirectionLayers.mockResolvedValue({
      l1: 'A'.repeat(16000),
      l2: '',
      l3: '',
      schemaSnapshot: '',
    });
    mockGetRecentMemory.mockResolvedValue([
      {
        text: 'Confirmation learning must key history and aliases by workspace to prevent cross-workspace leakage.',
        ts: '2026-05-28T00:22:52.442Z',
      },
    ]);
    mockGetInstalledSkills.mockResolvedValue([]);
    mockCacheStats
      .mockReturnValueOnce({ hits: 0, misses: 0, hitRate: 0, entries: 0, memoryBytes: 0 })
      .mockReturnValueOnce({ hits: 0, misses: 0, hitRate: 0, entries: 0, memoryBytes: 0 })
      .mockReturnValue({ hits: 0, misses: 0, hitRate: 0, entries: 0, memoryBytes: 0 });
    mockHybridSearch.mockResolvedValue([]);
    mockGraphStats.mockResolvedValue({ available: false, vertexCount: 0, edgeCount: 0 });
    mockQueryRelated.mockResolvedValue([]);
    mockQueryImpact.mockResolvedValue({ stories: [], conventions: [] });
    mockGetGraphContext.mockResolvedValue({ relatedMemories: [], relatedConventions: [], fileHistory: [] });
    mockPersistRetrievalTelemetry.mockResolvedValue(undefined);
    mockRecordRetrievalTelemetry.mockImplementation((input: Record<string, unknown>) => ({ id: 'rt-budget', ...input }));
    mockGetHistoricalUsefulnessMap.mockResolvedValue(new Map());
    mockRecordRetrievalSelection.mockResolvedValue(undefined);
    mockDbQuery.mockResolvedValue([
      {
        id: '1845',
        category: 'Bug Fix',
        content: 'Confirmation learning must key history and aliases by workspace to prevent cross-workspace leakage.',
        confidence: 'high',
        related_files: '[]',
        source_type: 'synthesis',
        source: null,
        pinned: false,
        created_at: '2026-05-28T00:22:52.442Z',
        source_story_id: 'IMP-004',
        source_spec_id: 'import-categorization-precision-hardening',
        source_run_id: 20260316000325,
      },
    ]);
  });

  test('retrieval-only budgeting preserves memory selection even when direction layers exceed the local token budget', async () => {
    const { retrieveContext } = require('../memory-router');
    const storyText = 'Ensure confirmation learning keys history and aliases by workspace and prevents leakage.';

    const starved = await retrieveContext('cashflow', storyText, {
      maxTokens: 1000,
    });
    expect(starved.memory).toHaveLength(0);
    expect(starved.meta.selectedCandidateIds).toEqual([]);

    const retrieved = await retrieveContext('cashflow', storyText, {
      maxTokens: 1000,
      budgetMode: 'retrieval-only',
    });

    expect(retrieved.memory).toHaveLength(1);
    expect(retrieved.memory[0].text).toContain('workspace');
    expect(retrieved.meta.selectedCandidateIds).toEqual(['1845']);
    expect(retrieved.meta.totalTokens).toBeLessThanOrEqual(1000);
  });
});

export {};
