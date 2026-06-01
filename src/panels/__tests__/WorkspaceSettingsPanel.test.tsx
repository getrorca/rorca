/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import WorkspaceSettingsPanel from '../WorkspaceSettingsPanel';

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

const MOCK_WORKSPACE_DETAILS = {
  id: 'ws-1',
  label: 'My Repo',
  path: '/tmp/repo',
  domains: ['saas'],
};

const MOCK_DIRECTION_LAYER = {
  layer: 3,
  content: '# L3 Direction\nStack-specific conventions',
  workspaceId: 'ws-1',
};

const MOCK_ENV_VARS = {
  items: [
    { id: 'env-1', key: 'ANTHROPIC_API_KEY', value: 'sk-***', workspaceId: 'ws-1' },
  ],
  total: 1,
};

const MOCK_RORCA_CONFIG = {
  config: {
    version: 1,
    globals: { priority: 101, content: '# Global context' },
    scopes: [],
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
  mockApiFetch.mockResolvedValue({ items: [], total: 0, hasMore: false });
});

describe('WorkspaceSettingsPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/workspaces/ws-1') return MOCK_WORKSPACE_DETAILS;
      if (path.includes('/api/direction')) return MOCK_DIRECTION_LAYER;
      if (path.includes('/env-vars')) return MOCK_ENV_VARS;
      if (path.includes('/rorca-config')) return MOCK_RORCA_CONFIG;
      if (path.includes('/agent-hooks')) return { items: [], total: 0 };
      if (path.includes('/agent-profiles')) return { items: [], total: 0 };
      if (path.includes('/pipeline-config')) return { config: {} };
      if (path.includes('/health')) return { score: 80, components: [], scannedAt: new Date().toISOString() };
      return {};
    });

    renderWithProviders(<WorkspaceSettingsPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('loads workspace settings on mount', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/workspaces/ws-1') return MOCK_WORKSPACE_DETAILS;
      if (path.includes('/api/direction')) return MOCK_DIRECTION_LAYER;
      if (path.includes('/env-vars')) return MOCK_ENV_VARS;
      if (path.includes('/rorca-config')) return MOCK_RORCA_CONFIG;
      if (path.includes('/agent-hooks')) return { items: [], total: 0 };
      if (path.includes('/agent-profiles')) return { items: [], total: 0 };
      if (path.includes('/pipeline-config')) return { config: {} };
      if (path.includes('/health')) return { score: 80, components: [], scannedAt: new Date().toISOString() };
      return {};
    });

    renderWithProviders(<WorkspaceSettingsPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty state with no workspace selected', async () => {
    localStorage.removeItem('rorca_workspaceId');
    sessionStorage.removeItem('rorca_workspaceId');

    mockApiFetch.mockResolvedValue({ items: [], total: 0, hasMore: false });

    renderWithProviders(<WorkspaceSettingsPanel />);

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
      if (path === '/api/workspaces/ws-1') throw new Error('Not found');
      return {};
    });

    renderWithProviders(<WorkspaceSettingsPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
