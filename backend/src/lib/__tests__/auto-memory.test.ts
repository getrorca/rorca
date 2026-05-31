/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

const mockExecute = jest.fn();
const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockChatComplete = jest.fn();
const mockEmbedText = jest.fn();
const mockPrepareText = jest.fn((_: string, text: string) => text);
const mockCollectStoryFileTouches = jest.fn();
const mockBroadcastAll = jest.fn();
const mockResolveWorkflowConfig = jest.fn();

jest.mock('../../db/index', () => ({
  execute: mockExecute,
  query: mockQuery,
  queryOne: mockQueryOne,
}));

jest.mock('../llm-client', () => ({
  chatComplete: mockChatComplete,
}));

jest.mock('../embedding-pipeline', () => ({
  embedText: mockEmbedText,
  prepareText: mockPrepareText,
}));

jest.mock('../knowledge-graph', () => ({
  collectStoryFileTouches: mockCollectStoryFileTouches,
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../sse-hub', () => ({
  broadcastAll: mockBroadcastAll,
}));

jest.mock('../workflow-config-resolver', () => ({
  resolveWorkflowConfig: mockResolveWorkflowConfig,
}));

import { autoSynthesizeMemory } from '../auto-memory';

describe('autoSynthesizeMemory provenance hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveWorkflowConfig.mockResolvedValue({});
    mockChatComplete.mockResolvedValue({
      text: JSON.stringify([
        {
          category: 'Pattern',
          content: 'Persist memory provenance from canonical sources.',
          confidence: 'high',
          relatedFiles: [],
        },
      ]),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    mockEmbedText.mockResolvedValue([0.1, 0.2]);
    mockCollectStoryFileTouches.mockResolvedValue(['src/foo.ts', 'src/foo.ts', 'docs/notes.md']);
    mockQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT spec_path FROM pipeline_runs')) {
        return { spec_path: 'forge/specs/approved/spec-graph.json' };
      }
      if (sql.includes('INSERT INTO memories')) {
        return { id: 123 };
      }
      if (sql.includes('INSERT INTO wal_events')) {
        return {
          id: 999,
          event_type: 'memory_created',
          workspace_id: 'ws-1',
          spec_id: 'spec-graph',
          story_id: 'US-001',
          payload: '{}',
          ts: new Date().toISOString(),
        };
      }
      return undefined;
    });
  });

  it('stores source_spec_id and backfills related_files from known story file scope', async () => {
    await autoSynthesizeMemory(
      'US-001',
      'ws-1',
      'Implement provenance hardening',
      'Edited src/foo.ts and docs/notes.md',
      'passed',
      77,
    );

    expect(mockCollectStoryFileTouches).toHaveBeenCalledWith(77, 'US-001');

    const insertCall = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO memories'));
    expect(insertCall).toBeDefined();
    expect(String(insertCall![0])).toContain('source_spec_id');
    expect(insertCall![1]).toEqual([
      'ws-1',
      'Pattern',
      'Persist memory provenance from canonical sources.',
      'US-001',
      'spec-graph',
      77,
      'high',
      JSON.stringify(['src/foo.ts', 'docs/notes.md']),
      '[0.1,0.2]',
    ]);

    const walCall = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO wal_events'));
    expect(walCall).toBeDefined();
    expect(walCall![1]).toEqual([
      'memory_created',
      'ws-1',
      'spec-graph',
      'US-001',
      JSON.stringify({
        id: 123,
        text: 'Persist memory provenance from canonical sources.',
        category: 'Pattern',
        relatedFiles: ['src/foo.ts', 'docs/notes.md'],
        source_spec_id: 'spec-graph',
      }),
    ]);
    expect(mockBroadcastAll).toHaveBeenCalled();
  });
});
