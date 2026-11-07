/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockTransaction = jest.fn();
const mockUpsertMemoryRelationProjection = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  transaction: (...args: unknown[]) => mockTransaction(...args),
}));

jest.mock('../knowledge-graph', () => ({
  buildMemoryRelationEdgeKey: jest.fn((workspaceId: string, relationType: string, sourceMemoryId: string, targetMemoryId: string) => (
    `memory-relation:${workspaceId}::${relationType}::${sourceMemoryId}::${targetMemoryId}`
  )),
  upsertMemoryRelationProjection: (...args: unknown[]) => mockUpsertMemoryRelationProjection(...args),
}));

jest.mock('../logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  buildMemoryRelationCanonicalKey,
  reconcileMemoryRelationProjection,
  projectMemoryRelationByIdBestEffort,
} from '../memory-relations';

describe('memory-relations helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('canonicalizes symmetric conflict keys while preserving workspace scope', () => {
    expect(buildMemoryRelationCanonicalKey('ws-1', 'CONFLICTS_WITH', 9, 3))
      .toBe('memory-relation:ws-1::CONFLICTS_WITH::3::9');
    expect(buildMemoryRelationCanonicalKey('ws-2', 'CONFLICTS_WITH', 9, 3))
      .toBe('memory-relation:ws-2::CONFLICTS_WITH::3::9');
    expect(buildMemoryRelationCanonicalKey('ws-1', 'SUPERSEDES', 9, 3))
      .toBe('memory-relation:ws-1::SUPERSEDES::9::3');
  });

  it('keeps relation writes non-blocking when projection fails', async () => {
    mockQueryOne.mockResolvedValue({
      id: 17,
      workspace_id: 'ws-1',
      source_memory_id: 5,
      target_memory_id: 8,
      relation_type: 'SUPERSEDES',
      canonical_key: 'memory-relation:ws-1::SUPERSEDES::5::8',
      status: 'active',
      created_at: '2026-06-02T10:00:00.000Z',
      updated_at: '2026-06-02T10:00:00.000Z',
      deleted_at: null,
      restored_at: null,
      superseded_at: null,
      source_category: 'Decision',
      source_pinned: false,
      source_created_at: '2026-06-02T10:00:00.000Z',
      source_updated_at: '2026-06-02T10:00:00.000Z',
      target_category: 'Decision',
      target_pinned: false,
      target_created_at: '2026-06-02T09:00:00.000Z',
      target_updated_at: '2026-06-02T09:00:00.000Z',
    });
    mockUpsertMemoryRelationProjection.mockRejectedValue(new Error('AGE unavailable'));

    await expect(projectMemoryRelationByIdBestEffort(17)).resolves.toBeUndefined();
    expect(mockUpsertMemoryRelationProjection).toHaveBeenCalledTimes(1);
  });

  it('reconciles relation projection from relational truth across active and historical states', async () => {
    mockQuery.mockResolvedValue([
      {
        id: 1,
        workspace_id: 'ws-1',
        source_memory_id: 5,
        target_memory_id: 8,
        relation_type: 'SUPERSEDES',
        canonical_key: 'memory-relation:ws-1::SUPERSEDES::5::8',
        status: 'active',
        created_at: '2026-06-02T10:00:00.000Z',
        updated_at: '2026-06-02T10:05:00.000Z',
        deleted_at: null,
        restored_at: null,
        superseded_at: null,
        source_category: 'Decision',
        source_pinned: false,
        source_created_at: '2026-06-02T10:00:00.000Z',
        source_updated_at: '2026-06-02T10:05:00.000Z',
        target_category: 'Decision',
        target_pinned: false,
        target_created_at: '2026-06-02T09:00:00.000Z',
        target_updated_at: '2026-06-02T09:00:00.000Z',
      },
      {
        id: 2,
        workspace_id: 'ws-1',
        source_memory_id: 3,
        target_memory_id: 4,
        relation_type: 'CONFLICTS_WITH',
        canonical_key: 'memory-relation:ws-1::CONFLICTS_WITH::3::4',
        status: 'deleted',
        created_at: '2026-06-02T11:00:00.000Z',
        updated_at: '2026-06-02T11:05:00.000Z',
        deleted_at: '2026-06-02T11:05:00.000Z',
        restored_at: null,
        superseded_at: null,
        source_category: 'Pattern',
        source_pinned: true,
        source_created_at: '2026-06-02T11:00:00.000Z',
        source_updated_at: '2026-06-02T11:00:00.000Z',
        target_category: 'Bug Fix',
        target_pinned: false,
        target_created_at: '2026-06-02T10:55:00.000Z',
        target_updated_at: '2026-06-02T10:55:00.000Z',
      },
    ]);

    const result = await reconcileMemoryRelationProjection('ws-1');

    expect(result).toEqual({ projected: 2 });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('FROM memory_relations mr'),
      ['ws-1'],
    );
    expect(mockUpsertMemoryRelationProjection).toHaveBeenCalledTimes(2);
    expect(mockUpsertMemoryRelationProjection).toHaveBeenNthCalledWith(2, expect.objectContaining({
      relation_type: 'CONFLICTS_WITH',
      status: 'deleted',
    }));
  });
});
