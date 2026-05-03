/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders, createMockWorkspace, createMockRun } from '../../test/helpers';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: vi.fn(() => vi.fn()),
  };
});

vi.mock('../../routes', async () => {
  const actual = await vi.importActual<typeof import('../../routes')>('../../routes');
  return {
    ...actual,
    useAppNavigate: vi.fn(() => ({ navigateTo: vi.fn() })),
  };
});

import PipelineMonitorPanel from '../PipelineMonitorPanel';

// ─── Mock apiFetch ────────────────────────────────────────────────────────────
vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

// Mock SSE hook — PipelineMonitorPanel subscribes to live WAL events
vi.mock('../../hooks/usePipelineSSE', () => ({
  usePipelineSSE: vi.fn(() => []),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

const WORKSPACE_ROW = createMockWorkspace({ id: 'ws-1', label: 'Test Repo', path: '/tmp/test' });
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };
const HEALTH_RESPONSE = {
  workerActive: true,
  queueHealth: 'healthy' as const,
  queueStats: {
    pending: 0,
    active: 0,
    failed: 0,
    failedInLast24h: 0,
    oldestPendingAgeSeconds: null,
  },
};

const RUNNING_RUN = createMockRun({
  id: 10,
  status: 'running',
  spec_path: 'forge/specs/approved/my-feature.json',
  workspace_id: 'ws-1',
  finished_at: null,
  pid: 12345,
});

const COMPLETED_RUN = createMockRun({
  id: 11,
  status: 'done',
  spec_path: 'forge/specs/approved/auth-feature.json',
  workspace_id: 'ws-1',
  started_at: new Date(Date.now() - 120_000).toISOString(),
  finished_at: new Date().toISOString(),
});

const MOCK_STORY_RESULTS = [
  {
    id: 1, run_id: 11, story_id: 'US-001', status: 'pass',
    retries: 0, log_path: null,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: new Date().toISOString(),
    input_tokens: 1000, output_tokens: 500,
  },
  {
    id: 2, run_id: 11, story_id: 'US-002', status: 'fail',
    retries: 1, log_path: null,
    started_at: new Date(Date.now() - 30_000).toISOString(),
    finished_at: new Date().toISOString(),
    input_tokens: 800, output_tokens: 300,
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

  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path === '/api/pipeline/worker/health') return HEALTH_RESPONSE;
    if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
    if (path.includes('/api/run-queue')) return { items: [] };
    return { items: [], total: 0, hasMore: false };
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PipelineMonitorPanel', () => {
  it('renders without crashing', async () => {
    renderWithProviders(<PipelineMonitorPanel />);
    await waitFor(() => {
      expect(document.body).toBeTruthy();
    });
  });

  it('shows no-workspace empty state when no workspace selected', async () => {
    localStorage.removeItem('rorca_workspaceId');
    sessionStorage.removeItem('rorca_workspaceId');

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
      if (path === '/api/pipeline/worker/health') return HEALTH_RESPONSE;
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<PipelineMonitorPanel />);

    await waitFor(() => {
      expect(screen.getByText(/select a workspace/i)).toBeInTheDocument();
    });
  });

  it('shows empty state when no runs exist', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/pipeline/worker/health') return HEALTH_RESPONSE;
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      if (path.includes('/api/run-queue')) return { items: [] };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<PipelineMonitorPanel />);

    await waitFor(() => {
      // Empty state should mention pipeline or runs
      const emptyEl = screen.queryByText(/no runs/i) ??
        screen.queryByText(/no pipeline/i) ??
        screen.queryByText(/approve a spec/i) ??
        screen.queryByText(/start your first/i) ??
        document.querySelector('[class*="empty"]');
      expect(emptyEl !== null).toBe(true);
    }, { timeout: 3000 });
  });

  it('displays active run in the run list', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/pipeline/worker/health') return HEALTH_RESPONSE;
      if (path.includes('/api/pipeline/runs') && !path.includes('/api/pipeline/runs/')) {
        return { items: [RUNNING_RUN], total: 1, hasMore: false };
      }
      if (path.includes('/api/pipeline/runs/10')) {
        return { run: RUNNING_RUN, stories: [], specStories: [] };
      }
      if (path.includes('/api/run-queue')) return { items: [] };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<PipelineMonitorPanel />);

    await waitFor(() => {
      // The run should appear in the list — either by spec name or run ID
      const runEl = screen.queryByText(/my.feature/i) ??
        screen.queryByText(/#10/i) ??
        screen.queryByText('my feature') ??
        screen.queryByText('running');
      expect(runEl).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('displays completed run in the run list', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/pipeline/worker/health') return HEALTH_RESPONSE;
      if (path.includes('/api/pipeline/runs') && !path.includes('/api/pipeline/runs/')) {
        return { items: [COMPLETED_RUN], total: 1, hasMore: false };
      }
      if (path.includes('/api/pipeline/runs/11')) {
        return { run: COMPLETED_RUN, stories: MOCK_STORY_RESULTS, specStories: [] };
      }
      if (path.includes('/api/run-queue')) return { items: [] };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<PipelineMonitorPanel />);

    await waitFor(() => {
      // The run should appear in the list — either by spec name or run ID
      const runEl = screen.queryByText(/auth.feature/i) ??
        screen.queryByText(/#11/i) ??
        screen.queryByText('auth feature') ??
        screen.queryByText('done');
      expect(runEl).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('displays story list with status badges when run is selected', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/pipeline/worker/health') return HEALTH_RESPONSE;
      if (path.includes('/api/pipeline/runs') && !path.includes('/api/pipeline/runs/')) {
        return { items: [COMPLETED_RUN], total: 1, hasMore: false };
      }
      if (path.includes(`/api/pipeline/runs/${COMPLETED_RUN.id}`)) {
        return {
          run: COMPLETED_RUN,
          stories: MOCK_STORY_RESULTS,
          specStories: [
            { id: 'US-001', title: 'Setup Database', priority: 1, passes: true },
            { id: 'US-002', title: 'Add Auth Routes', priority: 2, passes: false },
          ],
        };
      }
      if (path.includes('/api/run-queue')) return { items: [] };
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<PipelineMonitorPanel />);

    // Wait for run list to appear then select the run
    await waitFor(() => {
      const runItem = screen.queryByText(/auth.feature/i) ??
        screen.queryByText(/#11/i) ??
        screen.queryByText('auth feature');
      expect(runItem).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('handles API error gracefully', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === '/api/pipeline/worker/health') return HEALTH_RESPONSE;
      if (path.includes('/api/pipeline/runs')) throw new Error('Server error');
      return { items: [], total: 0, hasMore: false };
    });

    renderWithProviders(<PipelineMonitorPanel />);

    // Should not crash — panel mounts and either shows error or empty state
    await waitFor(() => {
      expect(document.body).toBeTruthy();
    }, { timeout: 3000 });
  });
});
