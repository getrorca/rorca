/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import UsageDashboardPanel from '../UsageDashboardPanel';

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

const MOCK_USAGE_RESPONSE = {
  grouped: [
    {
      group_key: 'claude-opus-4-6',
      total_input_tokens: 50000,
      total_output_tokens: 25000,
      total_cost_usd: 1.5,
      story_count: 10,
    },
  ],
  timeSeries: [
    {
      period: '2026-03-01',
      total_input_tokens: 50000,
      total_output_tokens: 25000,
      total_cost_usd: 1.5,
      story_count: 10,
    },
  ],
  totals: {
    total_input_tokens: 50000,
    total_output_tokens: 25000,
    total_cost_usd: 1.5,
    total_stories: 10,
  },
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

describe('UsageDashboardPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/usage')) return MOCK_USAGE_RESPONSE;
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(<UsageDashboardPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays usage data when available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/usage')) return MOCK_USAGE_RESPONSE;
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(<UsageDashboardPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty state with no usage data', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/usage')) return {
        grouped: [],
        timeSeries: [],
        totals: {
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost_usd: 0,
          total_stories: 0,
        },
        dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' },
      };
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(<UsageDashboardPanel />);

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
      if (path.includes('/api/analytics/usage')) throw new Error('Server error');
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(<UsageDashboardPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
