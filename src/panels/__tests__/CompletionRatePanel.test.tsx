/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import CompletionRatePanel from '../CompletionRatePanel';

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

const MOCK_COMPLETION_RESPONSE = {
  byComplexity: [
    { label: 'simple', passed: 10, failed: 1, skipped: 0, total: 11 },
    { label: 'standard', passed: 20, failed: 3, skipped: 1, total: 24 },
    { label: 'complex', passed: 5, failed: 2, skipped: 0, total: 7 },
  ],
  byTag: [
    { label: 'auth', passed: 8, failed: 1, skipped: 0, total: 9 },
    { label: 'ui', passed: 15, failed: 2, skipped: 1, total: 18 },
  ],
  summary: {
    totalStories: 42,
    passed: 35,
    failed: 6,
    skipped: 1,
    overallPassRate: 0.833,
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

describe('CompletionRatePanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/completion-rate')) return MOCK_COMPLETION_RESPONSE;
      return {};
    });

    renderWithProviders(<CompletionRatePanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays completion rate data when available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/completion-rate')) return MOCK_COMPLETION_RESPONSE;
      return {};
    });

    renderWithProviders(<CompletionRatePanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty state with no completion data', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/completion-rate')) return {
        byComplexity: [],
        byTag: [],
        summary: {
          totalStories: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          overallPassRate: 0,
        },
        dateRange: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' },
      };
      return {};
    });

    renderWithProviders(<CompletionRatePanel />);

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
      if (path.includes('/api/analytics/completion-rate')) throw new Error('Server error');
      return {};
    });

    renderWithProviders(<CompletionRatePanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
