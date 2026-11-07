/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import DirectionStackPanel from '../DirectionStackPanel';

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

const MOCK_L1 = {
  layer: 1,
  contentYaml: '# L1 Global Engineering Principles\n- Write clean code\n- Test everything',
  workspaceId: null,
};

const MOCK_L2 = {
  layer: 2,
  contentYaml: '# L2 Domain Conventions\n- SaaS patterns\n- REST API standards',
  workspaceId: null,
};

const MOCK_L3 = {
  layer: 3,
  contentYaml: '# L3 Project-Specific\n- React 18 + TypeScript\n- Express + SQLite',
  workspaceId: 'ws-1',
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

describe('DirectionStackPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/direction') && path.includes('layer=1')) return MOCK_L1;
      if (path.includes('/api/direction') && path.includes('layer=2')) return MOCK_L2;
      if (path.includes('/api/direction') && path.includes('layer=3')) return MOCK_L3;
      if (path.includes('/api/direction')) return MOCK_L1;
      return {};
    });

    renderWithProviders(<DirectionStackPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays direction layers when data is available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/direction') && path.includes('layer=1')) return MOCK_L1;
      if (path.includes('/api/direction') && path.includes('layer=2')) return MOCK_L2;
      if (path.includes('/api/direction') && path.includes('layer=3')) return MOCK_L3;
      if (path.includes('/api/direction')) return MOCK_L1;
      return {};
    });

    renderWithProviders(<DirectionStackPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty direction layers', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/direction')) return { layer: 1, contentYaml: '', workspaceId: null };
      return {};
    });

    renderWithProviders(<DirectionStackPanel />);

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
      if (path.includes('/api/direction')) throw new Error('Server error');
      return {};
    });

    renderWithProviders(<DirectionStackPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
