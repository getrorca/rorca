/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSpecRelevanceGraph } from '../useSpecRelevanceGraph';
import { apiFetch } from '../../lib/apiFetch';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

const RESPONSE = {
  available: true,
  hub: { id: 'hub:ws::spec-a', type: 'hub', ring: 0, label: 'Spec: spec-a', entityId: 'spec-a' },
  nodes: [{ id: 'hub:ws::spec-a', type: 'hub', ring: 0, label: 'Spec: spec-a', entityId: 'spec-a' }],
  edges: [],
  scoreLegend: [],
  summary: { hubLabel: 'Spec: spec-a', nodeCount: 1, edgeCount: 0, selectedCount: 0, droppedCount: 0, avgRelevanceScore: null },
  caps: { maxFiles: 20, maxMemories: 30, maxEdges: 80 },
  truncation: { filesTruncated: false, memoriesTruncated: false, edgesTruncated: false, totalCandidates: 0, returnedCandidates: 0 },
  fallback: { ageAvailable: true, telemetryAvailable: true, graphPathsAvailable: true, missingReasons: [] },
};

describe('useSpecRelevanceGraph', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockResolvedValue(RESPONSE as any);
  });

  it('uses the spec-scoped endpoint for spec-only requests', async () => {
    renderHook(() => useSpecRelevanceGraph({ workspaceId: 'ws-1', specSlug: 'spec-a' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/spec-relevance-graph/by-spec/spec-a?workspaceId=ws-1');
    });
  });

  it('uses the generic endpoint when a runId is provided', async () => {
    renderHook(() => useSpecRelevanceGraph({ workspaceId: 'ws-1', specSlug: 'spec-a', runId: 42 }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/spec-relevance-graph?'));
    });
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('workspaceId=ws-1'));
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('specSlug=spec-a'));
    expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('runId=42'));
  });
});
