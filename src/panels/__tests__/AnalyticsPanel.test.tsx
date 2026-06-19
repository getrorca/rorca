/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import AnalyticsPanel from '../AnalyticsPanel';

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

const WORKSPACE_RESPONSE = {
  items: [{ id: 'ws-1', label: 'Workspace Alpha', path: '/tmp/workspace-alpha', domains: [] }],
  total: 1,
  hasMore: false,
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
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.includes('/api/analytics/usage')) {
      return {
        grouped: [
          { group_key: 'openai-codex/gpt-5.4', total_input_tokens: 50000, total_output_tokens: 12000, total_reasoning_tokens: 0, total_cost_usd: 1.25, count: 4 },
        ],
        timeSeries: [
          { date: '2026-05-01', total_input_tokens: 50000, total_output_tokens: 12000, total_reasoning_tokens: 0, total_cost_usd: 1.25 },
        ],
        totals: {
          total_input_tokens: 50000,
          total_output_tokens: 12000,
          total_reasoning_tokens: 0,
          total_cost_usd: 1.25,
          total_records: 4,
        },
        hasActiveRuns: false,
        dateRange: { from: '2026-04-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
        groupBy: 'model',
      };
    }
    if (path.includes('/api/analytics/costs')) {
      return {
        groupBy: 'spec',
        breakdown: [
          { group_key: 'workspace-alpha-imports', total_input_tokens: 15000, total_output_tokens: 4000, input_cost_usd: 0.02, output_cost_usd: 0.03, total_cost_usd: 0.05, story_count: 3 },
          { group_key: 'workspace-alpha-ledger', total_input_tokens: 10000, total_output_tokens: 2500, input_cost_usd: 0.01, output_cost_usd: 0.02, total_cost_usd: 0.03, story_count: 2 },
        ],
        totals: {
          total_input_tokens: 25000,
          total_output_tokens: 6500,
          total_input_cost_usd: 0.03,
          total_output_cost_usd: 0.05,
          total_cost_usd: 0.08,
          total_stories: 5,
        },
        dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
      };
    }
    if (path.includes('/api/analytics/models')) {
      return {
        models: [
          { model: 'openai-codex/gpt-5.4', totalStories: 4, passedStories: 3, failedStories: 1, passRate: 0.75, avgCostUsd: 0.31, totalCostUsd: 1.25, avgElapsedSeconds: 80, avgInputTokens: 12000, avgOutputTokens: 3000, insufficientData: false },
        ],
        dateRange: { from: '2026-04-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
      };
    }
    if (path.includes('/api/analytics/velocity')) {
      return {
        velocity: [
          { week: '2026-W17', week_start: '2026-04-21', passed: 2, failed: 0, skipped: 0, total: 2, specs: ['workspace-alpha-imports'], rollingAvg: 1.5 },
          { week: '2026-W18', week_start: '2026-04-28', passed: 3, failed: 1, skipped: 0, total: 4, specs: ['workspace-alpha-ledger'], rollingAvg: 2.2 },
        ],
        availableSpecs: ['workspace-alpha-imports', 'workspace-alpha-ledger'],
        dateRange: { from: '2026-03-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z' },
      };
    }
    if (path.includes('/api/direction?layer=3')) {
      return { preferredModel: 'openai-codex/gpt-5.4', contentYaml: 'preferred_model: openai-codex/gpt-5.4' };
    }
    return {};
  });
});

describe('AnalyticsPanel', () => {
  it('renders the overview tab with token usage data', async () => {
    renderWithProviders(<AnalyticsPanel />);

    // Overview tab renders UsageDashboardPanel, which shows Token Usage as heading
    await waitFor(() => {
      expect(screen.getByText('Token Usage')).toBeInTheDocument();
    });

    // Click on Costs tab to verify tab switching works
    fireEvent.click(screen.getByRole('tab', { name: 'Costs' }));

    await waitFor(() => {
      expect(screen.getByText('Cost Breakdown')).toBeInTheDocument();
    });

    // Token Usage heading should no longer be visible
    expect(screen.queryByText('Token Usage')).not.toBeInTheDocument();
  });
});
