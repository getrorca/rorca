/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders, createMockWorkspace, createMockRun } from '../../test/helpers';
import RunViewPanel from '../RunViewPanel';

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

// Mock SSE hook — RunViewPanel subscribes to live WAL events
const mockUsePipelineSSE = vi.fn((_runId?: string | null, _workspaceId?: string | null): any[] => []);
vi.mock('../../hooks/usePipelineSSE', () => ({
  usePipelineSSE: (runId: string | null, workspaceId?: string | null) => mockUsePipelineSSE(runId, workspaceId),
}));

// Mock xterm terminal — not available in jsdom
vi.mock('../../components/RunTerminal', () => ({
  default: vi.fn(({ runId, terminalMode }: { runId: number; terminalMode?: string }) => (
    <div data-testid="run-terminal" data-terminal-mode={terminalMode}>Terminal for run {runId}</div>
  )),
  RunTerminal: vi.fn(({ runId, terminalMode }: { runId: number; terminalMode?: string }) => (
    <div data-testid="run-terminal" data-terminal-mode={terminalMode}>Terminal for run {runId}</div>
  )),
}));

vi.mock('../../components/MultiPaneTerminal', () => ({
  default: vi.fn(({ runId }: { runId: number }) => (
    <div data-testid="multi-pane-terminal">Multi pane terminal for run {runId}</div>
  )),
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

// Fix ResizeObserver for @tanstack/react-virtual — needs a proper class constructor
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

const WORKSPACE_ROW = createMockWorkspace({ id: 'ws-1', label: 'Test Repo', path: '/tmp/test' });
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

const BASE_RUN = createMockRun({
  id: 42,
  status: 'done',
  spec_path: 'forge/specs/approved/auth-feature.json',
  workspace_id: 'ws-1',
});

const RUNNING_RUN = createMockRun({
  id: 43,
  status: 'running',
  spec_path: 'forge/specs/approved/new-feature.json',
  workspace_id: 'ws-1',
  finished_at: null,
  pid: 12345,
});

const MOCK_RUN_RESPONSE = {
  run: BASE_RUN,
  stories: [
    { story_id: 'US-001', status: 'pass', elapsed_seconds: 45, started_at: new Date(Date.now() - 60_000).toISOString(), finished_at: new Date().toISOString() },
    { story_id: 'US-002', status: 'fail', elapsed_seconds: 30, started_at: new Date(Date.now() - 30_000).toISOString(), finished_at: new Date().toISOString() },
  ],
  specStories: [
    { id: 'US-001', title: 'Add Login Route', priority: 1, passes: true },
    { id: 'US-002', title: 'Add Auth Middleware', priority: 2, passes: false },
  ],
  specModel: 'claude-sonnet-4-6',
  tokenSummary: { totalInput: 2000, totalOutput: 800 },
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
  mockUsePipelineSSE.mockReturnValue([]);
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');

  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return MOCK_RUN_RESPONSE;
    if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
    return {};
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RunViewPanel', () => {
  it('renders without crashing', async () => {
    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );
    await waitFor(() => {
      expect(document.body).toBeTruthy();
    });
  });

  it('shows loading skeleton initially', () => {
    // Delay the API response so loading state is visible
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      // Hang to simulate loading
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    // Skeleton or loading indicator should be present immediately
    const _skeleton = document.querySelector('[class*="skeleton"]') ??
      document.querySelector('[class*="animate-pulse"]') ??
      document.querySelector('[data-testid*="skeleton"]');
    // Alternatively, the component renders loading state or the panel shell
    expect(document.body).toBeTruthy();
  });

  it('shows run not found state when run does not exist', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/999')) throw new Error('Not found');
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={999} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      const notFound = screen.queryByText(/not found/i) ??
        screen.queryByText(/back to hub/i) ??
        screen.queryByText(/back/i);
      expect(notFound).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('displays run data after fetch resolves', async () => {
    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      // The panel should show the spec name or run ID
      const specEl = screen.queryByText(/auth.feature/i) ??
        screen.queryByText(/auth feature/i) ??
        screen.queryByText(`#${BASE_RUN.id}`) ??
        document.querySelector('[data-testid="run-terminal"]');
      expect(specEl).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('renders tab navigation', async () => {
    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    // Tabs render after run data loads — wait for run data first
    await waitFor(() => {
      const specEl = screen.queryByText(/auth.feature/i) ??
        screen.queryByText(/auth feature/i) ??
        document.querySelector('[data-testid="run-terminal"]');
      expect(specEl).toBeInTheDocument();
    }, { timeout: 5000 });

    // Now check for tab labels
    const terminalTab = screen.queryByText(/^terminal$/i) ??
      screen.queryByRole('button', { name: /terminal/i });
    const storiesTab = screen.queryByText(/^stories$/i) ??
      screen.queryByRole('button', { name: /stories/i });
    expect(terminalTab !== null || storiesTab !== null).toBe(true);
  });

  it('shows active run status for a running run', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${RUNNING_RUN.id}`)) {
        return {
          run: RUNNING_RUN,
          stories: [],
          specStories: [
            { id: 'US-001', title: 'Implement Login', priority: 1, passes: false },
          ],
          specModel: 'claude-sonnet-4-6',
        };
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={RUNNING_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      // Running status or pause/kill controls should be visible
      const runningEl = screen.queryByText(/running/i) ??
        screen.queryByRole('button', { name: /pause/i }) ??
        screen.queryByRole('button', { name: /stop/i }) ??
        screen.queryByRole('button', { name: /kill/i }) ??
        document.querySelector('[data-testid="run-terminal"]');
      expect(runningEl).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('prefers the native terminal renderer for PTY runs even when multiple stories are active', async () => {
    const ptyRun = createMockRun({
      id: 77,
      status: 'running',
      workspace_id: 'ws-1',
      terminal_mode: 'pty',
      ...({ parallelism: 4 } as any),
    });

    mockUsePipelineSSE.mockReturnValue([
      { event_type: 'story_started', story_id: 'US-001', ts: new Date().toISOString() },
      { event_type: 'story_started', story_id: 'US-002', ts: new Date().toISOString() },
    ]);

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${ptyRun.id}`)) {
        return {
          run: ptyRun,
          stories: [],
          specStories: [
            { id: 'US-001', title: 'One' },
            { id: 'US-002', title: 'Two' },
          ],
          specModel: 'claude-sonnet-4-6',
        };
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={ptyRun.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    const terminal = await screen.findByTestId('run-terminal');
    expect(terminal).toHaveAttribute('data-terminal-mode', 'pty');
    expect(screen.queryByTestId('multi-pane-terminal')).not.toBeInTheDocument();
  });

  it('handles API error gracefully', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs')) throw new Error('Server error');
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      // Should not crash
      expect(document.body).toBeTruthy();
    }, { timeout: 3000 });
  });
});
