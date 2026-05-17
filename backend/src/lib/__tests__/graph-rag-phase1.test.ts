/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockEmbedText = jest.fn();
const mockPrepareText = jest.fn((_: string, text: string) => text);
const mockGetProvider = jest.fn(() => ({ model: 'mock-model' }));

jest.mock('../../db/index', () => ({
  query: mockQuery,
  queryOne: mockQueryOne,
}));

jest.mock('../embedding-pipeline', () => ({
  embedText: mockEmbedText,
  prepareText: mockPrepareText,
  getProvider: () => mockGetProvider(),
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { collectStoryFileTouches } from '../knowledge-graph';
import { hybridSearch } from '../search';

describe('Phase 1 GraphRAG hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('collectStoryFileTouches extracts real file paths from story output chunks', async () => {
    mockQuery.mockResolvedValue([
      { chunk: 'Reading src/foo.ts' },
      { chunk: 'Editing backend/app.ts' },
      { chunk: 'Writing docs/notes.md' },
      { chunk: 'Read src/foo.ts' },
    ]);

    const paths = await collectStoryFileTouches(42, 'US-001');

    expect(paths).toEqual(expect.arrayContaining([
      'src/foo.ts',
      'backend/app.ts',
      'docs/notes.md',
    ]));
    expect(new Set(paths).size).toBe(3);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('story_output_chunks'),
      [42, 'US-001'],
    );
  });

  it('hybridSearch skips semantic work in keyword-only mode', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM memories')) {
        return Promise.resolve([
          {
            source_id: 'mem-1',
            title: 'Memory entry',
            snippet: 'keyword <mark>foo</mark> hit',
            rank: 1,
            highlights: ['foo'],
          },
        ]);
      }
      throw new Error(`Unexpected query in keyword-only mode: ${sql}`);
    });
    mockQueryOne.mockImplementation(() => {
      throw new Error('queryOne should not be called in keyword-only mode');
    });

    const results = await hybridSearch('foo', {
      sourceTypes: ['memory'],
      keywordWeight: 1,
      semanticWeight: 0,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sourceType: 'memory',
      sourceId: 'mem-1',
      matchType: 'keyword',
    });
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockEmbedText).not.toHaveBeenCalled();
  });

  it('hybridSearch skips keyword work in semantic-only mode', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('FROM embeddings')) {
        return Promise.resolve([
          {
            source_type: 'memory',
            source_id: 'mem-2',
            similarity: 0.91,
          },
        ]);
      }
      throw new Error(`Unexpected keyword query in semantic-only mode: ${sql}`);
    });
    mockQueryOne.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)::text AS cnt FROM embeddings')) {
        return Promise.resolve({ cnt: '1' });
      }
      if (sql.includes('SELECT DISTINCT model FROM embeddings LIMIT 1')) {
        return Promise.resolve({ model: 'mock-model' });
      }
      if (sql.includes('spec_search_index')) {
        return Promise.resolve(undefined);
      }
      throw new Error(`Unexpected queryOne in semantic-only mode: ${sql}`);
    });
    mockEmbedText.mockResolvedValue([0.1, 0.2]);

    const results = await hybridSearch('foo', {
      sourceTypes: ['memory'],
      keywordWeight: 0,
      semanticWeight: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sourceType: 'memory',
      sourceId: 'mem-2',
      matchType: 'semantic',
    });
    expect(mockEmbedText).toHaveBeenCalled();
    expect(mockQuery.mock.calls.every(call => String(call[0]).includes('FROM embeddings'))).toBe(true);
    expect(mockQuery.mock.calls.some(call => String(call[0]).includes('FROM memories'))).toBe(false);
  });
});
