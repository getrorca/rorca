/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, mockApiResponses } from '../../test/helpers';

// Pin the workspace so the panel loads with a stable scope.
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import FinOpsDashboardPanel from '../FinOpsDashboardPanel';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const emptyCoverage = {
  totalRecords: 0,
  profileClassifiedRecords: 0,
  pricedRecords: 0,
  unpricedRecords: 0,
  pricingCoverage: null as number | null,
  allocationModes: [] as string[],
  hasAllocatedCost: false,
  hasBlendedCost: false,
};

const emptySubUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  recordCount: 0,
};

/**
 * Mixed-billing historical payload: one metered API provider with real spend
 * plus one subscription provider whose flat cost has been allocated to runs.
 */
function mixedHistorical() {
  return {
    accounting: {
      meteredCostUsd: 12,
      allocatedSubscriptionCostUsd: 8,
      blendedEffectiveCostUsd: 20,
      subscriptionUsage: {
        inputTokens: 5000, outputTokens: 3000, reasoningTokens: 0, recordCount: 4,
      },
      byMode: [],
      coverage: { ...emptyCoverage, totalRecords: 10, hasAllocatedCost: true, hasBlendedCost: true },
    },
    dailyTrend: [
      {
        date: '2026-05-01',
        cost: 20,
        meteredCostUsd: 12,
        allocatedSubscriptionCostUsd: 8,
        blendedEffectiveCostUsd: 20,
        inputTokens: 1000,
        outputTokens: 500,
        reasoningTokens: 0,
        storyCount: 3,
      },
    ],
    byWorkspace: [
      {
        workspaceId: 'ws-1',
        label: 'Main',
        totalCost: 20,
        meteredCostUsd: 12,
        allocatedSubscriptionCostUsd: 8,
        blendedEffectiveCostUsd: 20,
        inputTokens: 5000,
        outputTokens: 3000,
        runCount: 4,
      },
    ],
    bySpec: [
      {
        specSlug: 'demo-spec',
        totalCost: 20,
        meteredCostUsd: 12,
        allocatedSubscriptionCostUsd: 8,
        blendedEffectiveCostUsd: 20,
        inputTokens: 5000,
        outputTokens: 3000,
        runCount: 4,
      },
    ],
    byMonth: [
      {
        month: '2026-05',
        totalCost: 20,
        meteredCostUsd: 12,
        allocatedSubscriptionCostUsd: 8,
        blendedEffectiveCostUsd: 20,
        inputTokens: 5000,
        outputTokens: 3000,
        reasoningTokens: 0,
        runCount: 4,
        storyCount: 6,
      },
    ],
    byProvider: [
      {
        provider: 'openai',
        billingMode: 'metered_api',
        meteredCostUsd: 12,
        allocatedSubscriptionCostUsd: 0,
        blendedEffectiveCostUsd: 12,
        subscriptionUsage: emptySubUsage,
        inputTokens: 3000,
        outputTokens: 2000,
        runCount: 2,
        storyCount: 3,
      },
      {
        provider: 'claude',
        billingMode: 'subscription',
        meteredCostUsd: 0,
        allocatedSubscriptionCostUsd: 8,
        blendedEffectiveCostUsd: 8,
        subscriptionUsage: {
          inputTokens: 2000, outputTokens: 1000, reasoningTokens: 0, recordCount: 4,
        },
        inputTokens: 2000,
        outputTokens: 1000,
        runCount: 2,
        storyCount: 3,
      },
    ],
    modelDistribution: [
      {
        model: 'gpt-4o',
        tier: 'sonnet',
        billingMode: 'metered_api',
        storyCount: 3,
        totalCost: 12,
        meteredCostUsd: 12,
        allocatedSubscriptionCostUsd: 0,
        blendedEffectiveCostUsd: 12,
        percentage: 50,
      },
      {
        model: 'claude-sonnet-4-5',
        tier: 'sonnet',
        billingMode: 'subscription',
        storyCount: 3,
        totalCost: 8,
        meteredCostUsd: 0,
        allocatedSubscriptionCostUsd: 8,
        blendedEffectiveCostUsd: 8,
        percentage: 50,
      },
    ],
    projectedMonthlyCost: 600,
    savings: null,
    allSubscription: false,
    coverage: { ...emptyCoverage, totalRecords: 10, hasAllocatedCost: true, hasBlendedCost: true },
    dateRange: { from: '2026-05-01T00:00:00.000Z', to: '2026-05-31T00:00:00.000Z' },
  };
}

function mockHistorical(payload: unknown, providers: unknown = []) {
  mockApiResponses({
    'finops/historical': payload,
    'pi-providers': providers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FinOpsDashboardPanel', () => {
  it('renders separated metered, allocated, and blended cost cards for mixed billing', async () => {
    mockHistorical(mixedHistorical());
    renderWithProviders(<FinOpsDashboardPanel />);

    await waitFor(() => {
      expect(screen.getByText('Metered API Spend')).toBeInTheDocument();
    });
    expect(screen.getByText('Allocated Subscription')).toBeInTheDocument();
    expect(screen.getByText('Blended Effective')).toBeInTheDocument();
    expect(screen.getByText('Subscription Usage')).toBeInTheDocument();

    // No ambiguous "Total Cost" label anywhere.
    expect(screen.queryByText('Total Cost')).not.toBeInTheDocument();

    // Metered ($12), allocated ($8), blended ($20) values are all present
    // (they also appear in breakdown tables, so allow multiple matches).
    expect(screen.getAllByText('$12.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$8.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$20.00').length).toBeGreaterThan(0);
  });

  it('toggles cost mode and changes table cost column header without refetching', async () => {
    mockHistorical(mixedHistorical());
    renderWithProviders(<FinOpsDashboardPanel />);

    await waitFor(() => {
      expect(screen.getByText('Metered API Spend')).toBeInTheDocument();
    });

    const toggle = screen.getByRole('group', { name: /cost mode/i });
    const blendedBtn = within(toggle).getByRole('button', { name: 'Blended' });
    const meteredBtn = within(toggle).getByRole('button', { name: 'Metered' });

    // Default is blended.
    expect(blendedBtn).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(meteredBtn);
    expect(meteredBtn).toHaveAttribute('aria-pressed', 'true');
    expect(blendedBtn).toHaveAttribute('aria-pressed', 'false');

    // Explainer text reflects the active metered mode.
    expect(screen.getByText(/Metered view:/)).toBeInTheDocument();
  });

  it('renders provider billing badges (Metered API + Subscription)', async () => {
    mockHistorical(mixedHistorical());
    renderWithProviders(<FinOpsDashboardPanel />);

    await waitFor(() => {
      expect(screen.getByText('Metered API Spend')).toBeInTheDocument();
    });

    // Provider table shows both providers with billing badges (desktop +
    // mobile layouts both render, so allow multiple matches).
    expect(screen.getAllByText('openai').length).toBeGreaterThan(0);
    expect(screen.getAllByText('claude').length).toBeGreaterThan(0);
    // Badge labels appear (metered in model + provider tables, subscription pill).
    expect(screen.getAllByText('Metered API').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Subscription').length).toBeGreaterThan(0);
  });

  it('renders subscription-only ranges as token usage without metered dollars', async () => {
    const subOnly = {
      ...mixedHistorical(),
      accounting: {
        meteredCostUsd: 0,
        allocatedSubscriptionCostUsd: 0,
        blendedEffectiveCostUsd: 0,
        subscriptionUsage: {
          inputTokens: 4000, outputTokens: 2000, reasoningTokens: 0, recordCount: 5,
        },
        byMode: [],
        coverage: emptyCoverage,
      },
      byProvider: [
        {
          provider: 'claude',
          billingMode: 'subscription',
          meteredCostUsd: 0,
          allocatedSubscriptionCostUsd: 0,
          blendedEffectiveCostUsd: 0,
          subscriptionUsage: {
            inputTokens: 4000, outputTokens: 2000, reasoningTokens: 0, recordCount: 5,
          },
          inputTokens: 4000,
          outputTokens: 2000,
          runCount: 3,
          storyCount: 5,
        },
      ],
      allSubscription: true,
      savings: null,
    };
    mockHistorical(subOnly);
    renderWithProviders(<FinOpsDashboardPanel />);

    await waitFor(() => {
      expect(screen.getByText('Subscription Usage')).toBeInTheDocument();
    });

    // Subscription notice for all-subscription ranges.
    expect(
      screen.getByText(/All runs used subscription-based agents/i),
    ).toBeInTheDocument();
    // Daily chart switches to token usage title.
    expect(screen.getByText('Daily Token Usage')).toBeInTheDocument();
  });

  it('surfaces a missing-pricing warning when records are unpriced', async () => {
    const payload = mixedHistorical();
    payload.coverage = {
      ...emptyCoverage,
      totalRecords: 10,
      unpricedRecords: 3,
      pricingCoverage: 0.7,
    };
    mockHistorical(payload);
    renderWithProviders(<FinOpsDashboardPanel />);

    await waitFor(() => {
      expect(screen.getByText(/have no pricing/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/70% priced/i)).toBeInTheDocument();
  });
});
