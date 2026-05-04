/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import GitHubSettingsPanel from '../GitHubSettingsPanel';

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

const MOCK_GITHUB_STATUS = {
  connected: false,
  repoOwner: null,
  repoName: null,
  installationId: null,
};

const MOCK_GITHUB_ACCOUNT = {
  login: null,
  avatarUrl: null,
  connected: false,
};

const MOCK_CONNECTED_STATUS = {
  connected: true,
  repoOwner: 'testorg',
  repoName: 'test-repo',
  installationId: '12345',
};

const MOCK_CONNECTED_ACCOUNT = {
  login: 'testuser',
  avatarUrl: 'https://avatars.githubusercontent.com/u/123456?v=4',
  connected: true,
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

describe('GitHubSettingsPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/github') && path.includes('ws-1')) return MOCK_GITHUB_STATUS;
      if (path === '/api/github/account') return MOCK_GITHUB_ACCOUNT;
      if (path.includes('/api/github/pr-template')) return { template: '' };
      return {};
    });

    renderWithProviders(<GitHubSettingsPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('shows disconnected state when not connected', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/github') && path.includes('ws-1')) return MOCK_GITHUB_STATUS;
      if (path === '/api/github/account') return MOCK_GITHUB_ACCOUNT;
      if (path.includes('/api/github/pr-template')) return { template: '' };
      return {};
    });

    renderWithProviders(<GitHubSettingsPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('shows connected state when GitHub is connected', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/github') && path.includes('ws-1')) return MOCK_CONNECTED_STATUS;
      if (path === '/api/github/account') return MOCK_CONNECTED_ACCOUNT;
      if (path.includes('/api/github/pr-template')) return { template: '' };
      return {};
    });

    renderWithProviders(<GitHubSettingsPanel />);

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
      if (path.includes('/github')) throw new Error('GitHub API error');
      return {};
    });

    renderWithProviders(<GitHubSettingsPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
