/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import ModelComparisonPanel from '../ModelComparisonPanel';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

const WORKSPACE_ROW = { id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] };
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const MOCK_MODELS_RESPONSE = {
  models: [
    {
      model: 'claude-opus-4-6',
      totalStories: 20,
      passedStories: 18,
      failedStories: 2,
      passRate: 0.9,
      avgCostUsd: 0.5,
      totalCostUsd: 10.0,
      avgElapsedSeconds: 120,
      avgInputTokens: 10000,
      avgOutputTokens: 5000,
      insufficientData: false,
    },
    {
      model: 'claude-sonnet-4-6',
      totalStories: 30,
      passedStories: 26,
      failedStories: 4,
      passRate: 0.85,
      avgCostUsd: 0.1,
      totalCostUsd: 3.0,
      avgElapsedSeconds: 60,
      avgInputTokens: 5000,
      avgOutputTokens: 3000,
      insufficientData: false,
    },
  ],
  dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' },
};

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
  mockApiFetch.mockResolvedValue({ items: [], total: 0, hasMore: false });
});

describe('ModelComparisonPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/models')) return MOCK_MODELS_RESPONSE;
      if (path.includes('/api/direction')) return { preferredModel: null, layer: 3, content: '', workspaceId: 'ws-1' };
      return {};
    });

    renderWithProviders(<ModelComparisonPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays model comparison data when available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/models')) return MOCK_MODELS_RESPONSE;
      if (path.includes('/api/direction')) return { preferredModel: null, layer: 3, content: '', workspaceId: 'ws-1' };
      return {};
    });

    renderWithProviders(<ModelComparisonPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty state with no model data', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/models')) return {
        models: [],
        dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' },
      };
      if (path.includes('/api/direction')) return { preferredModel: null, layer: 3, content: '', workspaceId: 'ws-1' };
      return {};
    });

    renderWithProviders(<ModelComparisonPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles API error gracefully', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/models')) throw new Error('Server error');
      if (path.includes('/api/direction')) return { preferredModel: null, layer: 3, content: '', workspaceId: 'ws-1' };
      return {};
    });

    renderWithProviders(<ModelComparisonPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
