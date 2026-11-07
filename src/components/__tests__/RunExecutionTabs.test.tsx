/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SkillsTab from '../SkillsTab';
import FinOpsTab from '../FinOpsTab';
import { apiFetch } from '../../lib/apiFetch';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const mockApiFetch = vi.mocked(apiFetch);

describe('run execution tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders in-flight matched skills instead of the empty skills state', async () => {
    mockApiFetch.mockResolvedValueOnce({
      runId: 123,
      perStory: [
        {
          storyId: 'US-001',
          storyTitle: 'Build API',
          storyStatus: 'pending',
          skills: [
            { name: 'api-documentation', relevance: 9, reason: 'New API endpoint', description: null, category: null },
            { name: 'data-validation', relevance: 7, reason: 'Route validation', description: null, category: null },
          ],
        },
      ],
      summary: {
        totalSkillInjections: 2,
        uniqueSkills: ['api-documentation', 'data-validation'],
        skillFrequency: [
          { name: 'api-documentation', count: 1, passRate: 0, category: null },
          { name: 'data-validation', count: 1, passRate: 0, category: null },
        ],
        storiesWithSkills: 1,
        storiesWithoutSkills: 0,
      },
    });

    render(<SkillsTab runId={123} />);

    await waitFor(() => expect(screen.queryByText(/No skills were used/i)).not.toBeInTheDocument());
    expect(screen.getAllByText('api-documentation').length).toBeGreaterThan(0);
    expect(screen.getAllByText('data-validation').length).toBeGreaterThan(0);
    expect(screen.getByText('Build API')).toBeInTheDocument();
  });

  it('renders FinOps provider/model rows while waiting for token usage', async () => {
    mockApiFetch.mockResolvedValueOnce({
      runId: 456,
      agentType: 'pi',
      agentModel: 'openrouter/google/gemini-2.5-pro',
      usageAvailable: false,
      isSubscription: false,
      totals: { stories: 2, inputTokens: 0, outputTokens: 0, cost: 0 },
      runSummary: [
        { model: 'openrouter/google/gemini-2.5-pro', tier: 'sonnet', stories: 2, inputTokens: 0, outputTokens: 0, cost: 0 },
      ],
      modelDistribution: [{ tier: 'sonnet', count: 2, percentage: 100 }],
      perStory: [
        { storyId: 'US-001', model: 'openrouter/google/gemini-2.5-pro', tier: 'sonnet', inputTokens: 0, outputTokens: 0, actualCost: 0, opusBaseline: 0 },
        { storyId: 'US-002', model: 'openrouter/google/gemini-2.5-pro', tier: 'sonnet', inputTokens: 0, outputTokens: 0, actualCost: 0, opusBaseline: 0 },
      ],
      escalationLog: [],
    });

    render(<FinOpsTab runId={456} isActive />);

    await waitFor(() => expect(screen.queryByText(/No token usage data available/i)).not.toBeInTheDocument());
    expect(screen.getByText(/Waiting for token usage from pi/i)).toBeInTheDocument();
    expect(screen.getAllByText('openrouter/google/gemini-2.5-pro').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Stories').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });

  it('keeps mixed-provider rows visible with billing badges while usage is pending', async () => {
    mockApiFetch.mockResolvedValueOnce({
      runId: 789,
      agentType: 'opencode',
      agentModel: 'mixed',
      usageAvailable: false,
      isSubscription: false,
      billingMode: 'metered_api',
      runSummary: [
        { model: 'claude-opus-4', tier: 'opus', stories: 1, inputTokens: 0, outputTokens: 0, cost: 0 },
        { model: 'openrouter/x/y', tier: 'sonnet', stories: 1, inputTokens: 0, outputTokens: 0, cost: 0 },
      ],
      totals: { stories: 2, inputTokens: 0, outputTokens: 0, cost: 0, meteredCostUsd: 0, allocatedSubscriptionCostUsd: 0, blendedEffectiveCostUsd: 0 },
      modelDistribution: [
        { tier: 'opus', count: 1, percentage: 50 },
        { tier: 'sonnet', count: 1, percentage: 50 },
      ],
      perStory: [
        { storyId: 'US-001', model: 'claude-opus-4', tier: 'opus', billingMode: 'subscription', inputTokens: 0, outputTokens: 0, meteredCost: 0, actualCost: 0, opusBaseline: 0 },
        { storyId: 'US-002', model: 'openrouter/x/y', tier: 'sonnet', billingMode: 'metered_api', inputTokens: 0, outputTokens: 0, meteredCost: 0, actualCost: 0, opusBaseline: 0 },
      ],
      escalationLog: [],
    });

    render(<FinOpsTab runId={789} isActive />);

    // Rows must stay visible (not collapse to the empty state) while pending.
    await waitFor(() => expect(screen.queryByText(/No token usage data available/i)).not.toBeInTheDocument());
    expect(screen.getAllByText('claude-opus-4').length).toBeGreaterThan(0);
    expect(screen.getAllByText('openrouter/x/y').length).toBeGreaterThan(0);
    // Mixed billing surfaces per-row Billing badges.
    expect(screen.getByText('Billing')).toBeInTheDocument();
    expect(screen.getAllByText('Subscription').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Metered').length).toBeGreaterThan(0);
  });

  it('shows truthful subscription coverage instead of invoice-backed spend', async () => {
    mockApiFetch.mockResolvedValueOnce({
      runId: 321,
      agentType: 'claude',
      agentModel: 'claude-opus-4',
      usageAvailable: true,
      isSubscription: true,
      billingMode: 'subscription',
      accounting: {
        meteredCostUsd: 0,
        allocatedSubscriptionCostUsd: 0,
        blendedEffectiveCostUsd: 0,
        subscriptionUsage: { inputTokens: 1000, outputTokens: 500, reasoningTokens: 0, recordCount: 2 },
        byMode: [{ mode: 'subscription', recordCount: 2, meteredCostUsd: 0, allocatedCostUsd: 0, blendedCostUsd: 0 }],
        coverage: { totalRecords: 2, profileClassifiedRecords: 2, pricedRecords: 0, unpricedRecords: 0, pricingCoverage: null, allocationModes: [], hasAllocatedCost: false, hasBlendedCost: false },
      },
      provenance: {
        billingMode: 'subscription', isSubscription: true, hasMeteredSpend: false,
        hasAllocatedCost: false, hasBlendedCost: false, pricingCoverage: null,
        unpricedRecords: 0, profileClassifiedRecords: 2, allocationModes: [],
      },
      runSummary: [
        { model: 'claude-opus-4', tier: 'opus', stories: 2, inputTokens: 1000, outputTokens: 500, cost: 0 },
      ],
      totals: { stories: 2, inputTokens: 1000, outputTokens: 500, cost: 0, meteredCostUsd: 0, allocatedSubscriptionCostUsd: 0, blendedEffectiveCostUsd: 0 },
      modelDistribution: [{ tier: 'opus', count: 2, percentage: 100 }],
      perStory: [
        { storyId: 'US-001', model: 'claude-opus-4', tier: 'opus', billingMode: 'subscription', inputTokens: 600, outputTokens: 300, meteredCost: 0, actualCost: 0, opusBaseline: 0 },
        { storyId: 'US-002', model: 'claude-opus-4', tier: 'opus', billingMode: 'subscription', inputTokens: 400, outputTokens: 200, meteredCost: 0, actualCost: 0, opusBaseline: 0 },
      ],
      escalationLog: [],
    });

    render(<FinOpsTab runId={321} />);

    await waitFor(() => expect(screen.getByText(/covered by a flat subscription/i)).toBeInTheDocument());
    expect(screen.getByText(/no metered, invoice-backed per-story charge/i)).toBeInTheDocument();
    // Savings comparison columns must not appear for subscription-only runs.
    expect(screen.queryByText('Opus Baseline')).not.toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('labels unclassified Pi/Codex cost as reported rather than invoice-backed total cost', async () => {
    mockApiFetch.mockResolvedValueOnce({
      runId: 987,
      agentType: 'pi',
      agentModel: 'openai-codex/gpt-5.5',
      usageAvailable: true,
      isSubscription: false,
      billingMode: 'unknown',
      accounting: {
        meteredCostUsd: 0,
        allocatedSubscriptionCostUsd: 0,
        blendedEffectiveCostUsd: 0,
        subscriptionUsage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, recordCount: 0 },
        byMode: [{ mode: 'unknown', recordCount: 1, meteredCostUsd: 0, allocatedCostUsd: 0, blendedCostUsd: 0 }],
        coverage: { totalRecords: 1, profileClassifiedRecords: 0, pricedRecords: 0, unpricedRecords: 0, pricingCoverage: null, allocationModes: [], hasAllocatedCost: false, hasBlendedCost: false },
      },
      provenance: {
        billingMode: 'unknown', isSubscription: false, hasMeteredSpend: false,
        hasAllocatedCost: false, hasBlendedCost: false, pricingCoverage: null,
        unpricedRecords: 0, unclassifiedRecords: 1, profileClassifiedRecords: 0,
        allocationModes: [], reportedCostUsd: 0.43, hasReportedCost: true,
      },
      runSummary: [
        { model: 'openai-codex/gpt-5.5', tier: 'codex', stories: 1, inputTokens: 100, outputTokens: 50, cost: 0, reportedCost: 0.43 },
      ],
      totals: { stories: 1, inputTokens: 100, outputTokens: 50, cost: 0, meteredCostUsd: 0, allocatedSubscriptionCostUsd: 0, blendedEffectiveCostUsd: 0, reportedCostUsd: 0.43 },
      modelDistribution: [{ tier: 'codex', count: 1, percentage: 100 }],
      perStory: [
        { storyId: 'US-001', model: 'openai-codex/gpt-5.5', tier: 'codex', billingMode: 'unknown', inputTokens: 100, outputTokens: 50, meteredCost: 0, actualCost: 0, reportedCost: 0.43, opusBaseline: 2.0 },
      ],
      savings: null,
      escalationLog: [],
    });

    render(<FinOpsTab runId={987} />);

    await waitFor(() => expect(screen.getByText('Reported Cost')).toBeInTheDocument());
    expect(screen.getByText('$0.430')).toBeInTheDocument();
    expect(screen.getByText(/not invoice-backed/i)).toBeInTheDocument();
    expect(screen.getByText('Cost Basis')).toBeInTheDocument();
    expect(screen.getByText(/reported \$0.430/i)).toBeInTheDocument();
    expect(screen.queryByText('Opus Baseline')).not.toBeInTheDocument();
  });

  it('surfaces a coverage notice when pricing or token history is missing', async () => {
    mockApiFetch.mockResolvedValueOnce({
      runId: 654,
      agentType: 'opencode',
      agentModel: 'some/model',
      usageAvailable: true,
      isSubscription: false,
      billingMode: 'metered_api',
      accounting: {
        meteredCostUsd: 1.23,
        allocatedSubscriptionCostUsd: 0,
        blendedEffectiveCostUsd: 1.23,
        subscriptionUsage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, recordCount: 0 },
        byMode: [{ mode: 'metered_api', recordCount: 3, meteredCostUsd: 1.23, allocatedCostUsd: 0, blendedCostUsd: 1.23 }],
        coverage: { totalRecords: 3, profileClassifiedRecords: 3, pricedRecords: 2, unpricedRecords: 1, pricingCoverage: 0.67, allocationModes: [], hasAllocatedCost: false, hasBlendedCost: false },
      },
      provenance: {
        billingMode: 'metered_api', isSubscription: false, hasMeteredSpend: true,
        hasAllocatedCost: false, hasBlendedCost: false, pricingCoverage: 0.67,
        unpricedRecords: 1, profileClassifiedRecords: 3, allocationModes: [],
      },
      runSummary: [
        { model: 'some/model', tier: 'sonnet', stories: 3, inputTokens: 100, outputTokens: 50, cost: 1.23 },
      ],
      totals: { stories: 3, inputTokens: 100, outputTokens: 50, cost: 1.23, meteredCostUsd: 1.23, allocatedSubscriptionCostUsd: 0, blendedEffectiveCostUsd: 1.23 },
      modelDistribution: [{ tier: 'sonnet', count: 3, percentage: 100 }],
      perStory: [
        { storyId: 'US-001', model: 'some/model', tier: 'sonnet', billingMode: 'metered_api', inputTokens: 100, outputTokens: 50, meteredCost: 1.23, actualCost: 1.23, opusBaseline: 2.0 },
      ],
      escalationLog: [],
    });

    render(<FinOpsTab runId={654} />);

    await waitFor(() => expect(screen.getByText(/Metered pricing covers 67% of usage/i)).toBeInTheDocument());
    expect(screen.getByText(/lack pricing or token history/i)).toBeInTheDocument();
  });
});
