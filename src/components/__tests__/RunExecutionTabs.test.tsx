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

    render(<FinOpsTab runId={456} />);

    await waitFor(() => expect(screen.queryByText(/No token usage data available/i)).not.toBeInTheDocument());
    expect(screen.getByText(/Waiting for token usage from pi/i)).toBeInTheDocument();
    expect(screen.getAllByText('openrouter/google/gemini-2.5-pro').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Stories').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2').length).toBeGreaterThan(0);
  });
});
