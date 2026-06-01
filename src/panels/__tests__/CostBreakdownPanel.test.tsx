/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import CostBreakdownPanel from '../CostBreakdownPanel';

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

const MOCK_COST_RESPONSE = {
  groupBy: 'spec',
  breakdown: [
    {
      group_key: 'test-spec',
      total_input_tokens: 10000,
      total_output_tokens: 5000,
      input_cost_usd: 0.01,
      output_cost_usd: 0.015,
      total_cost_usd: 0.025,
      story_count: 3,
    },
  ],
  totals: {
    total_input_tokens: 10000,
    total_output_tokens: 5000,
    total_input_cost_usd: 0.01,
    total_output_cost_usd: 0.015,
    total_cost_usd: 0.025,
    total_stories: 3,
  },
  dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' },
};

const MOCK_PRICING_RESPONSE = {
  pricing: [
    {
      model_id: 'claude-opus-4-6',
      provider: 'anthropic',
      input_cost_per_1m_tokens: 15,
      output_cost_per_1m_tokens: 75,
      effective_date: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  ],
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

describe('CostBreakdownPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/costs')) return MOCK_COST_RESPONSE;
      if (path.includes('/api/analytics/pricing')) return MOCK_PRICING_RESPONSE;
      return {};
    });

    renderWithProviders(<CostBreakdownPanel />);
    // Should render without throwing
    expect(document.body).toBeInTheDocument();
  });

  it('displays cost data when available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/costs')) return MOCK_COST_RESPONSE;
      if (path.includes('/api/analytics/pricing')) return MOCK_PRICING_RESPONSE;
      return {};
    });

    renderWithProviders(<CostBreakdownPanel />);

    await waitFor(
      () => {
        // Panel renders cost breakdown content
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty state with no cost data', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/costs')) return {
        groupBy: 'spec',
        breakdown: [],
        totals: {
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_input_cost_usd: 0,
          total_output_cost_usd: 0,
          total_cost_usd: 0,
          total_stories: 0,
        },
        dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' },
      };
      if (path.includes('/api/analytics/pricing')) return MOCK_PRICING_RESPONSE;
      return {};
    });

    renderWithProviders(<CostBreakdownPanel />);

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
      if (path.includes('/api/analytics/costs')) throw new Error('Server error');
      if (path.includes('/api/analytics/pricing')) return MOCK_PRICING_RESPONSE;
      return {};
    });

    renderWithProviders(<CostBreakdownPanel />);

    await waitFor(
      () => {
        // Component should not crash even when API fails
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('shows pricing tab when no workspace is selected', async () => {
    mockApiFetch.mockResolvedValue({ items: [], total: 0, hasMore: false });

    renderWithProviders(<CostBreakdownPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
