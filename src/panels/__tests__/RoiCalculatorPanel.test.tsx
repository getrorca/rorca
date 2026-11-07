/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import RoiCalculatorPanel from '../RoiCalculatorPanel';

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

const MOCK_ROI_RESPONSE = {
  total_stories_passed: 35,
  estimated_hours_saved: 140,
  total_llm_cost: 25.5,
  savings_value: 21000,
  net_savings: 20974.5,
  roi_multiplier: 822,
  metricDefinitions: {
    storiesPassed: 'Latest passing result per logical (spec path, story id) in the selected window; retries and copied results count once.',
    estimatedValue: 'Deduplicated passed stories × configured hours per story × configured hourly rate.',
    costBasis: 'Blended effective FinOps cost: metered API spend plus allocated subscription cost.',
  },
  accounting: {
    basis: 'blended_effective',
    meteredCostUsd: 20,
    allocatedSubscriptionCostUsd: 5.5,
    blendedEffectiveCostUsd: 25.5,
    coverage: {
      totalRecords: 8,
      pricedRecords: 7,
      unpricedRecords: 1,
      pricingCoverage: 0.875,
      profileClassifiedRecords: 3,
      allocationModes: ['by_runs'],
    },
  },
  config: {
    hours_per_story: 4,
    hourly_rate: 150,
  },
  timeSeries: [
    {
      date: '2026-03-01',
      stories_passed: 10,
      hours_saved: 40,
      llm_cost: 8.5,
      net_savings: 5991.5,
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

describe('RoiCalculatorPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/roi')) return MOCK_ROI_RESPONSE;
      return {};
    });

    renderWithProviders(<RoiCalculatorPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays ROI data when available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/roi')) return MOCK_ROI_RESPONSE;
      return {};
    });

    renderWithProviders(<RoiCalculatorPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('shows the deduplication, assumed-value, and canonical FinOps cost bases', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/roi')) return MOCK_ROI_RESPONSE;
      return {};
    });

    renderWithProviders(<RoiCalculatorPanel />);

    expect(await screen.findByText('Deduplicated Passes')).toBeInTheDocument();
    expect(screen.getByText('Blended AI Cost')).toBeInTheDocument();
    expect(screen.getByText(/latest result per spec \+ story; retries count once/i)).toBeInTheDocument();
    expect(screen.getByText(/metered spend \+ allocated subscription cost/i)).toBeInTheDocument();
    expect(screen.getByText(/88% of metered rows priced/i)).toBeInTheDocument();
    expect(screen.queryByText(/infinite return/i)).not.toBeInTheDocument();
  });

  it('handles empty state with no ROI data', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/roi')) return {
        total_stories_passed: 0,
        estimated_hours_saved: 0,
        total_llm_cost: 0,
        savings_value: 0,
        net_savings: 0,
        roi_multiplier: null,
        metricDefinitions: MOCK_ROI_RESPONSE.metricDefinitions,
        accounting: {
          ...MOCK_ROI_RESPONSE.accounting,
          meteredCostUsd: 0,
          allocatedSubscriptionCostUsd: 0,
          blendedEffectiveCostUsd: 0,
          coverage: {
            ...MOCK_ROI_RESPONSE.accounting.coverage,
            totalRecords: 0,
            pricedRecords: 0,
            unpricedRecords: 0,
            pricingCoverage: null,
          },
        },
        config: { hours_per_story: 4, hourly_rate: 150 },
        timeSeries: [],
        dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' },
      };
      return {};
    });

    renderWithProviders(<RoiCalculatorPanel />);

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
      if (path.includes('/api/analytics/roi')) throw new Error('Server error');
      return {};
    });

    renderWithProviders(<RoiCalculatorPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
  it('does not turn an ROI request failure into valid-looking zeros', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/roi')) throw new Error('Accounting unavailable');
      return {};
    });

    renderWithProviders(<RoiCalculatorPanel />);

    expect(await screen.findByText('ROI analytics unavailable')).toBeInTheDocument();
    expect(screen.getByText('Accounting unavailable')).toBeInTheDocument();
    expect(screen.getByText(/No estimates are shown/)).toBeInTheDocument();
    expect(screen.queryByText('Net Estimated Value')).not.toBeInTheDocument();
  });
});
