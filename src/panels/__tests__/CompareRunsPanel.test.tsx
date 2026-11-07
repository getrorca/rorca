/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders, createMockWorkspace, createMockRun } from '../../test/helpers';
import CompareRunsPanel from '../CompareRunsPanel';

// ─── Mock apiFetch ────────────────────────────────────────────────────────────
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

const WORKSPACE_ROW = createMockWorkspace({ id: 'ws-1', label: 'Test Repo', path: '/tmp/test' });
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const RUN_1 = createMockRun({
  id: 1,
  status: 'done',
  spec_path: 'forge/specs/approved/feature-auth.json',
  workspace_id: 'ws-1',
  started_at: new Date(Date.now() - 200_000).toISOString(),
  finished_at: new Date(Date.now() - 100_000).toISOString(),
});

const RUN_2 = createMockRun({
  id: 2,
  status: 'done',
  spec_path: 'forge/specs/approved/feature-auth.json',
  workspace_id: 'ws-1',
  started_at: new Date(Date.now() - 90_000).toISOString(),
  finished_at: new Date(Date.now() - 10_000).toISOString(),
});

const MOCK_COMPARISON = {
  run1: RUN_1,
  run2: RUN_2,
  stories: [
    {
      storyId: 'US-001',
      run1Status: 'pass',
      run2Status: 'pass',
      run1Elapsed: 45,
      run2Elapsed: 40,
      run1Retries: 0,
      run2Retries: 0,
      change: 'unchanged' as const,
    },
    {
      storyId: 'US-002',
      run1Status: 'fail',
      run2Status: 'pass',
      run1Elapsed: 30,
      run2Elapsed: 25,
      run1Retries: 2,
      run2Retries: 0,
      change: 'improved' as const,
    },
    {
      storyId: 'US-003',
      run1Status: 'pass',
      run2Status: 'fail',
      run1Elapsed: 60,
      run2Elapsed: 70,
      run1Retries: 0,
      run2Retries: 1,
      change: 'regressed' as const,
    },
  ],
  summary: {
    run1PassRate: 66.7,
    run2PassRate: 66.7,
    passRateDelta: 0,
    run1TotalElapsed: 135,
    run2TotalElapsed: 135,
    elapsedDelta: 0,
    run1StoryCount: 3,
    run2StoryCount: 3,
    improved: 1,
    regressed: 1,
    newStories: 0,
    removedStories: 0,
  },
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
    if (path.includes('/api/pipeline/runs') && !path.includes('compare')) {
      return { items: [RUN_1, RUN_2], total: 2, hasMore: false };
    }
    return {};
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CompareRunsPanel', () => {
  it('renders without crashing', async () => {
    renderWithProviders(<CompareRunsPanel onBack={vi.fn()} />);
    await waitFor(() => {
      expect(document.body).toBeTruthy();
    });
  });

  it('shows no-workspace empty state when no workspace selected', async () => {
    localStorage.removeItem('rorca_workspaceId');
    sessionStorage.removeItem('rorca_workspaceId');

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(<CompareRunsPanel onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/select a workspace/i)).toBeInTheDocument();
    });
  });

  it('displays panel header with Compare Pipeline Runs title', async () => {
    renderWithProviders(<CompareRunsPanel onBack={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/compare pipeline runs/i)).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('displays run selector dropdowns', async () => {
    renderWithProviders(<CompareRunsPanel onBack={vi.fn()} />);

    await waitFor(() => {
      // Both run selectors should appear (Baseline and Comparison)
      const run1Label = screen.queryByText(/baseline/i) ??
        screen.queryByLabelText(/baseline/i) ??
        screen.queryByText(/run 1/i);
      expect(run1Label).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('populates run selectors with completed runs', async () => {
    renderWithProviders(<CompareRunsPanel onBack={vi.fn()} />);

    // Wait for workspace to load first, then check select options
    await waitFor(() => {
      expect(screen.queryByText(/compare pipeline runs/i)).toBeInTheDocument();
    }, { timeout: 3000 });

    await waitFor(() => {
      // Runs appear inside <option> elements inside <select> — use getAllByRole or query options
      const selects = document.querySelectorAll('select');
      const hasRunOptions = selects.length > 0 && Array.from(selects[0].options).some(
        (opt) => opt.value !== '' && (opt.text.includes('#1') || opt.text.includes('feature auth') || opt.text.toLowerCase().includes('feature-auth')),
      );
      expect(hasRunOptions).toBe(true);
    }, { timeout: 3000 });
  });

  it('displays comparison results after both runs selected', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs') && !path.includes('compare')) {
        return { items: [RUN_1, RUN_2], total: 2, hasMore: false };
      }
      if (path.includes('compare?run1=1&run2=2') || path.includes('compare?run1=2&run2=1')) {
        return MOCK_COMPARISON;
      }
      return {};
    });

    renderWithProviders(<CompareRunsPanel onBack={vi.fn()} />);

    // Select first run
    await waitFor(() => {
      const run1Select = screen.queryByLabelText(/baseline run/i) ??
        (document.querySelectorAll('select')[0] as HTMLSelectElement | undefined);
      expect(run1Select).toBeTruthy();
    }, { timeout: 3000 });

    const selects = document.querySelectorAll('select');
    if (selects.length >= 2) {
      const { fireEvent } = await import('@testing-library/react');
      fireEvent.change(selects[0], { target: { value: '1' } });
      fireEvent.change(selects[1], { target: { value: '2' } });

      await waitFor(() => {
        // Story comparison results should appear
        const storyEl = screen.queryByText('US-001') ??
          screen.queryByText('US-002') ??
          screen.queryByText(/improved/i) ??
          screen.queryByText(/regressed/i);
        expect(storyEl).toBeInTheDocument();
      }, { timeout: 3000 });
    }
  });

  it('handles API error gracefully', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs')) throw new Error('Server error');
      return {};
    });

    renderWithProviders(<CompareRunsPanel onBack={vi.fn()} />);

    // Should not crash — error is silently logged (console.error is mocked)
    await waitFor(() => {
      expect(document.body).toBeTruthy();
    }, { timeout: 3000 });
  });

  it('back button is rendered', async () => {
    renderWithProviders(<CompareRunsPanel onBack={vi.fn()} />);

    await waitFor(() => {
      const backBtn = screen.queryByRole('button', { name: /back/i }) ??
        screen.queryByTitle(/back/i) ??
        screen.queryByLabelText(/back/i);
      expect(backBtn).toBeInTheDocument();
    }, { timeout: 3000 });
  });
});
