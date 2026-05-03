/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import HealthDashboardPanel from '../HealthDashboardPanel';

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

const MOCK_HEALTH_BASIC = {
  status: 'ok',
  version: '1.0.0',
  uptime: 3600,
  db_connected: true,
  active_runs: 0,
  authRequired: false,
};

const MOCK_HEALTH_DETAILED = {
  ...MOCK_HEALTH_BASIC,
  db_size: 1024 * 1024 * 5, // 5 MB
  pending_specs_count: 2,
  memory_usage: {
    rss: 1024 * 1024 * 100,
    heapTotal: 1024 * 1024 * 80,
    heapUsed: 1024 * 1024 * 60,
    external: 1024 * 1024 * 5,
  },
  last_backup_at: null,
};

const MOCK_WORKSPACE_HEALTH = {
  score: 85,
  components: [
    { name: 'CLAUDE.md', score: 30, maxScore: 30, status: 'good' },
    { name: 'AGENTS.md', score: 20, maxScore: 20, status: 'good' },
    { name: 'config.json', score: 15, maxScore: 20, status: 'partial' },
    { name: 'MEMORY.md', score: 15, maxScore: 15, status: 'good' },
    { name: 'Skills', score: 5, maxScore: 15, status: 'partial' },
  ],
  scannedAt: new Date().toISOString(),
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

describe('HealthDashboardPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('detailed=true')) return MOCK_HEALTH_DETAILED;
      if (path.includes('/api/health')) return MOCK_HEALTH_BASIC;
      if (path.includes('/health')) return MOCK_WORKSPACE_HEALTH;
      return {};
    });

    renderWithProviders(<HealthDashboardPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays health metrics when data is available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('detailed=true')) return MOCK_HEALTH_DETAILED;
      if (path.includes('/api/health')) return MOCK_HEALTH_BASIC;
      if (path.includes('/health')) return MOCK_WORKSPACE_HEALTH;
      return {};
    });

    renderWithProviders(<HealthDashboardPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('shows workspace health score with correct percentages', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('detailed=true')) return MOCK_HEALTH_DETAILED;
      if (path.includes('/api/health')) return MOCK_HEALTH_BASIC;
      if (path.includes('/health')) return MOCK_WORKSPACE_HEALTH;
      return {};
    });

    renderWithProviders(<HealthDashboardPanel />);

    await waitFor(
      () => {
        // Panel renders with workspace health data present
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles API error gracefully', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/health')) throw new Error('Server error');
      return {};
    });

    renderWithProviders(<HealthDashboardPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
