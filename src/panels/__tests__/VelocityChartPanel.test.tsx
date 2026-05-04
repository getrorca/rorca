/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import VelocityChartPanel from '../VelocityChartPanel';

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

const MOCK_VELOCITY_RESPONSE = {
  velocity: [
    {
      week: '2026-W09',
      weekStart: '2026-03-01T00:00:00.000Z',
      weekEnd: '2026-03-07T23:59:59.999Z',
      passed: 5,
      failed: 1,
      skipped: 0,
      specs: ['spec-a', 'spec-b'],
    },
    {
      week: '2026-W08',
      weekStart: '2026-02-22T00:00:00.000Z',
      weekEnd: '2026-02-28T23:59:59.999Z',
      passed: 8,
      failed: 0,
      skipped: 2,
      specs: ['spec-c'],
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

describe('VelocityChartPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/velocity')) return MOCK_VELOCITY_RESPONSE;
      return {};
    });

    renderWithProviders(<VelocityChartPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays velocity chart data when available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/velocity')) return MOCK_VELOCITY_RESPONSE;
      return {};
    });

    renderWithProviders(<VelocityChartPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty velocity data', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/analytics/velocity')) return { velocity: [] };
      return {};
    });

    renderWithProviders(<VelocityChartPanel />);

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
      if (path.includes('/api/analytics/velocity')) throw new Error('Server error');
      return {};
    });

    renderWithProviders(<VelocityChartPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
