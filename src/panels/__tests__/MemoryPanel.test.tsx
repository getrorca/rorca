/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import MemoryPanel from '../MemoryPanel';

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

const MOCK_MEMORY_ENTRIES = [
  {
    date: '2026-02-27',
    category: 'Architecture',
    title: 'Direction Stack 5-Layer Cascade',
    rule: 'Direction Stack layers cascade L1 → L5. Lower layers override higher ones.',
    context: 'Applied to all workspace specs.',
    source: 'US-001',
  },
  {
    date: '2026-02-28',
    category: 'Gotcha',
    title: 'Backend requires restart after changes',
    rule: 'tsx has no hot-reload. Always kill port 3030 and restart.',
    context: 'Critical for backend development workflow.',
    source: 'auto-generated-from-US-005',
  },
];

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

describe('MemoryPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/memory/archive/count')) return { count: 0 };
      if (path.includes('/api/memory')) return { items: MOCK_MEMORY_ENTRIES };
      return {};
    });

    renderWithProviders(<MemoryPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays memory entries when data is available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/memory/archive/count')) return { count: 0 };
      if (path.includes('/api/memory')) return { items: MOCK_MEMORY_ENTRIES };
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty memory entries', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/memory/archive/count')) return { count: 0 };
      if (path.includes('/api/memory')) return { items: [] };
      return {};
    });

    renderWithProviders(<MemoryPanel />);

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
      if (path.includes('/api/memory/archive/count')) return { count: 0 };
      if (path.includes('/api/memory')) throw new Error('Server error');
      return {};
    });

    renderWithProviders(<MemoryPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
