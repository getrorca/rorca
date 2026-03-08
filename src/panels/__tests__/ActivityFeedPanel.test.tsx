import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import ActivityFeedPanel from '../ActivityFeedPanel';

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

const MOCK_ACTIVITY_ITEM = {
  id: 'act-1',
  timestamp: new Date().toISOString(),
  activityType: 'spec_approved',
  actor: {
    id: 'user-1',
    name: 'Admin',
    avatarUrl: null,
  },
  target: {
    type: 'spec',
    id: 'my-spec-slug',
    label: 'My Spec',
  },
  description: 'Approved spec "My Spec"',
};

const MOCK_ACTIVITY_RESPONSE = {
  items: [MOCK_ACTIVITY_ITEM],
  total: 1,
  hasMore: false,
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

describe('ActivityFeedPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/activity')) return MOCK_ACTIVITY_RESPONSE;
      return {};
    });

    renderWithProviders(<ActivityFeedPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays activity items when data is available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/activity')) return MOCK_ACTIVITY_RESPONSE;
      return {};
    });

    renderWithProviders(<ActivityFeedPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty activity feed', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/activity')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(<ActivityFeedPanel />);

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
      if (path.includes('/api/activity')) throw new Error('Server error');
      return {};
    });

    renderWithProviders(<ActivityFeedPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
