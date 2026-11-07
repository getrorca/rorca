/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockIsGraphAvailable = jest.fn();
const mockUpsertMemoryNode = jest.fn();
const mockAddMemoryLink = jest.fn();
const mockAddMemoryAboutFile = jest.fn();
const mockAddMemorySourceSpec = jest.fn();
const mockReconcileMemoryRelationProjection = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

jest.mock('../knowledge-graph', () => ({
  isGraphAvailable: (...args: unknown[]) => mockIsGraphAvailable(...args),
  populateFromRun: jest.fn(),
  populateFromSpec: jest.fn(),
  populateConventionsFromConfig: jest.fn(),
  addStoryNode: jest.fn(),
  addFileTouch: jest.fn(),
  addSkillUsage: jest.fn(),
  upsertMemoryNode: (...args: unknown[]) => mockUpsertMemoryNode(...args),
  addMemoryLink: (...args: unknown[]) => mockAddMemoryLink(...args),
  addMemoryAboutFile: (...args: unknown[]) => mockAddMemoryAboutFile(...args),
  addMemorySourceSpec: (...args: unknown[]) => mockAddMemorySourceSpec(...args),
  collectStoryFileTouches: jest.fn(),
  normalizeGraphFilePath: (filePath: string) => filePath.replace(/^\.\//, ''),
  reconcileWorkspaceGraphProjection: jest.fn(),
}));

jest.mock('../memory-relations', () => ({
  reconcileMemoryRelationProjection: (...args: unknown[]) => mockReconcileMemoryRelationProjection(...args),
}));

jest.mock('../sse-hub', () => ({ subscribe: jest.fn() }));

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { __testables, rebuildMemoryGraphProjection } from '../graph-populator';
import type { WalEvent } from '../sse-hub';

function memoryEvent(payload: Record<string, unknown>): WalEvent {
  return {
    id: 1,
    ts: '2026-08-19T00:00:00.000Z',
    event_type: 'memory_created',
    workspace_id: 'ws-1',
    spec_id: null,
    story_id: null,
    actor: 'test',
    payload: JSON.stringify(payload),
  };
}

describe('durable memory graph projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsGraphAvailable.mockResolvedValue(true);
    mockUpsertMemoryNode.mockResolvedValue(undefined);
    mockAddMemoryLink.mockResolvedValue(undefined);
    mockAddMemoryAboutFile.mockResolvedValue(undefined);
    mockAddMemorySourceSpec.mockResolvedValue(undefined);
    mockReconcileMemoryRelationProjection.mockResolvedValue({ projected: 0 });
  });

  it('projects a standalone durable memory with no relationship metadata', async () => {
    mockQueryOne.mockResolvedValue({
      category: 'Decision',
      source_story_id: null,
      source_spec_id: null,
      related_files: [],
      pinned: true,
      created_at: '2026-08-11T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:00.000Z',
    });

    await __testables.handleMemoryCreated(memoryEvent({ id: 42 }));

    expect(mockUpsertMemoryNode).toHaveBeenCalledWith('42', 'ws-1', 'Decision', {
      pinned: true,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    expect(mockAddMemoryLink).not.toHaveBeenCalled();
    expect(mockAddMemorySourceSpec).not.toHaveBeenCalled();
    expect(mockAddMemoryAboutFile).not.toHaveBeenCalled();
    expect(mockReconcileMemoryRelationProjection).toHaveBeenCalledWith('ws-1');
  });

  it('keeps file relationships when a memory has no story or spec source', async () => {
    mockQueryOne.mockResolvedValue({
      category: 'Gotcha',
      source_story_id: null,
      source_spec_id: null,
      related_files: ['./backend/src/worker.ts'],
      pinned: false,
      created_at: null,
      updated_at: null,
    });

    await __testables.handleMemoryCreated(memoryEvent({ id: 43 }));

    expect(mockUpsertMemoryNode).toHaveBeenCalledWith('43', 'ws-1', 'Gotcha', {
      pinned: false,
      createdAt: null,
      updatedAt: null,
    });
    expect(mockAddMemoryAboutFile).toHaveBeenCalledWith(
      '43',
      'backend/src/worker.ts',
      'ws-1',
      { pinned: false, createdAt: null, updatedAt: null },
    );
  });

  it('rebuilds every active durable memory and reconciles ontology links once', async () => {
    mockQuery.mockResolvedValue([
      {
        id: 42,
        category: 'Decision',
        source_story_id: null,
        source_spec_id: null,
        related_files: [],
        pinned: false,
        created_at: null,
        updated_at: null,
      },
      {
        id: 43,
        category: 'Architecture',
        source_story_id: 'US-001',
        source_spec_id: 'spec-a',
        related_files: ['backend/src/server.ts'],
        pinned: true,
        created_at: '2026-08-11T00:00:00.000Z',
        updated_at: '2026-08-12T00:00:00.000Z',
      },
    ]);

    await expect(rebuildMemoryGraphProjection('ws-1')).resolves.toEqual({ projected: 2 });

    expect(mockUpsertMemoryNode).toHaveBeenCalledTimes(2);
    expect(mockAddMemoryLink).toHaveBeenCalledWith(
      '43',
      'US-001',
      'spec-a',
      'ws-1',
      'Architecture',
      expect.objectContaining({ pinned: true }),
    );
    expect(mockAddMemorySourceSpec).toHaveBeenCalledWith(
      '43',
      'spec-a',
      'ws-1',
      expect.objectContaining({ pinned: true }),
    );
    expect(mockAddMemoryAboutFile).toHaveBeenCalledWith(
      '43',
      'backend/src/server.ts',
      'ws-1',
      expect.objectContaining({ pinned: true }),
    );
    expect(mockReconcileMemoryRelationProjection).toHaveBeenCalledTimes(1);
    expect(mockReconcileMemoryRelationProjection).toHaveBeenCalledWith('ws-1');
  });
});
