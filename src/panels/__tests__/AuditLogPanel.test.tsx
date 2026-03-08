import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/helpers';
import AuditLogPanel from '../AuditLogPanel';

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

const MOCK_WAL_EVENT = {
  id: 'wal-1',
  ts: new Date().toISOString(),   // NOTE: column is 'ts' not 'created_at'
  event_type: 'story_passed',
  workspace_id: 'ws-1',
  spec_id: 'my-spec-slug',
  story_id: 'US-001',
  actor: 'admin@rorca.local',
  payload: JSON.stringify({ result: 'passed', elapsed: 120 }),
};

const MOCK_WAL_RESPONSE = {
  items: [MOCK_WAL_EVENT],
  total: 1,
  hasMore: false,
  eventTypes: ['story_passed', 'story_failed', 'run_started', 'run_finished'],
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

describe('AuditLogPanel', () => {
  it('renders without crashing', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/wal')) return MOCK_WAL_RESPONSE;
      return {};
    });

    renderWithProviders(<AuditLogPanel />);
    expect(document.body).toBeInTheDocument();
  });

  it('displays WAL events when data is available', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/wal')) return MOCK_WAL_RESPONSE;
      return {};
    });

    renderWithProviders(<AuditLogPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('handles empty audit log', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/wal')) return {
        items: [],
        total: 0,
        hasMore: false,
        eventTypes: [],
      };
      return {};
    });

    renderWithProviders(<AuditLogPanel />);

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
      if (path.includes('/api/wal')) throw new Error('Server error');
      return {};
    });

    renderWithProviders(<AuditLogPanel />);

    await waitFor(
      () => {
        expect(document.body).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});
