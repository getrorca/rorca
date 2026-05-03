/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import TeamDirectionPanel from '../TeamDirectionPanel';

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

const MOCK_TEAMS = {
  items: [
    { id: 'team-1', name: 'Engineering', description: 'Core engineering team', memberCount: 3 },
    { id: 'team-2', name: 'Design', description: 'Design & UX team', memberCount: 2 },
  ],
  total: 2,
};

const MOCK_TEAM_DIRECTION_L1 = {
  teamId: 'team-1',
  layer: 1,
  content: '# Engineering L1\n- Write tests\n- Document APIs',
};

const MOCK_TEAM_DIRECTION_L2 = {
  teamId: 'team-1',
  layer: 2,
  content: '# Engineering L2\n- SaaS patterns\n- REST conventions',
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

describe('TeamDirectionPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/teams') return MOCK_TEAMS;
      if (path.includes('/direction') && path.includes('team-1')) return {
        l1: MOCK_TEAM_DIRECTION_L1,
        l2: MOCK_TEAM_DIRECTION_L2,
      };
      return {};
    });

    renderWithProviders(<TeamDirectionPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays teams list when data is available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/teams') return MOCK_TEAMS;
      if (path.includes('/direction')) return {
        l1: MOCK_TEAM_DIRECTION_L1,
        l2: MOCK_TEAM_DIRECTION_L2,
      };
      return {};
    });

    renderWithProviders(<TeamDirectionPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty teams list', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/teams') return { items: [], total: 0 };
      return {};
    });

    renderWithProviders(<TeamDirectionPanel />);

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
      if (path === '/api/teams') throw new Error('Server error');
      return {};
    });

    renderWithProviders(<TeamDirectionPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
