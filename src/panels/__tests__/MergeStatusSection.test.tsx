/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { waitFor, within } from '@testing-library/react';
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

// Mock SSE hook — control WAL events per test
const mockUsePipelineSSE = vi.fn((_runId?: string | null, _workspaceId?: string | null): any[] => []);
vi.mock('../../hooks/usePipelineSSE', () => ({
  usePipelineSSE: (runId: string | null, workspaceId?: string | null) => mockUsePipelineSSE(runId, workspaceId),
}));

// Mock xterm terminal — not available in jsdom
vi.mock('../../components/RunTerminal', () => ({
  default: vi.fn(({ runId }: { runId: number }) => (
    <div data-testid="run-terminal">Terminal for run {runId}</div>
  )),
  RunTerminal: vi.fn(({ runId }: { runId: number }) => (
    <div data-testid="run-terminal">Terminal for run {runId}</div>
  )),
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

// Fix ResizeObserver for @tanstack/react-virtual
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

// ─── Run fixtures ─────────────────────────────────────────────────────────────

const WORKTREE_RUN = createMockRun({
  id: 100,
  status: 'running',
  spec_path: 'forge/specs/approved/merge-test.json',
  workspace_id: 'ws-1',
  ...({ worktree_path: '/tmp/worktree', branch_name: 'feat/merge-test-1234' } as any),
});

const MERGED_RUN = createMockRun({
  id: 102,
  status: 'done',
  spec_path: 'forge/specs/approved/merge-test.json',
  workspace_id: 'ws-1',
  ...({
    branch_name: 'feat/merge-test-1234',
    merge_status: 'merged',
    merge_commit_sha: 'abc1234def5678',
  } as any),
});

const FAILED_MERGE_RUN = createMockRun({
  id: 103,
  status: 'done',
  spec_path: 'forge/specs/approved/merge-test.json',
  workspace_id: 'ws-1',
  ...({
    worktree_path: '/tmp/worktree',
    branch_name: 'feat/merge-test-1234',
    merge_status: 'failed',
    merge_error: 'CONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed',
  } as any),
});

const NO_WORKTREE_RUN = createMockRun({
  id: 104,
  status: 'done',
  spec_path: 'forge/specs/approved/no-worktree.json',
  workspace_id: 'ws-1',
});

function makeRunResponse(run: any) {
  return {
    run,
    stories: [],
    specStories: [{ id: 'US-001', title: 'Test Story' }],
    specModel: 'claude-sonnet-4-6',
  };
}

function makeWalEvent(id: number, eventType: string, payload: Record<string, unknown>) {
  return {
    id,
    ts: new Date().toISOString(),
    event_type: eventType,
    workspace_id: 'ws-1',
    spec_id: null,
    story_id: null,
    actor: 'worker',
    payload: JSON.stringify(payload),
  };
}

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
  mockUsePipelineSSE.mockReturnValue([]);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MergeStatusSection', () => {
  it('does not render for runs without worktree', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/104')) return makeRunResponse(NO_WORKTREE_RUN);
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={104} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="run-terminal"]')).toBeInTheDocument();
    }, { timeout: 3000 });

    expect(document.querySelector('[data-testid="merge-status-section"]')).not.toBeInTheDocument();
  });

  it('shows Pending badge for running worktree run', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/100')) return makeRunResponse(WORKTREE_RUN);
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={100} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="merge-status-section"]')).toBeInTheDocument();
    }, { timeout: 3000 });

    expect(document.querySelector('[data-testid="merge-badge-pending"]')).toBeInTheDocument();
    const section = document.querySelector('[data-testid="merge-status-section"]')!;
    expect(within(section as HTMLElement).getByText('Pending')).toBeInTheDocument();
  });

  it('shows Merged badge with branch and SHA from DB state', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/102')) return makeRunResponse(MERGED_RUN);
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={102} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="merge-badge-merged"]')).toBeInTheDocument();
    }, { timeout: 3000 });

    const section = document.querySelector('[data-testid="merge-status-section"]')! as HTMLElement;
    expect(within(section).getByText('Merged')).toBeInTheDocument();
    expect(within(section).getByText('feat/merge-test-1234')).toBeInTheDocument();
    expect(within(section).getByText('abc1234')).toBeInTheDocument(); // first 7 chars
  });

  it('shows retired merge failure as read-only and links to delivery status', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/103')) return makeRunResponse(FAILED_MERGE_RUN);
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={103} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="merge-badge-failed"]')).toBeInTheDocument();
    }, { timeout: 3000 });

    const section = document.querySelector('[data-testid="merge-status-section"]')! as HTMLElement;
    expect(within(section).getByText('Retired merge unavailable')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /retry merge/i })).not.toBeInTheDocument();
    expect(within(section).getByRole('button', { name: /review delivery status/i })).toBeInTheDocument();
    expect(within(section).getByText(/CONFLICT.*Merge conflict/)).toBeInTheDocument();
  });

  it('transitions Pending → Merging via SSE worktree_merge_started event', async () => {
    // Render with SSE events already including merge_started
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/100')) return makeRunResponse(WORKTREE_RUN);
      return {};
    });

    mockUsePipelineSSE.mockReturnValue([
      makeWalEvent(1, 'worktree_merge_started', { run_id: 100, branchName: 'feat/merge-test-1234' }),
    ]);

    renderWithProviders(
      <RunViewPanel runId={100} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="merge-badge-merging"]')).toBeInTheDocument();
    }, { timeout: 3000 });

    const section = document.querySelector('[data-testid="merge-status-section"]')! as HTMLElement;
    expect(within(section).getByText('Merging')).toBeInTheDocument();
  });

  it('transitions to Merged via SSE worktree_merged event', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/100')) return makeRunResponse(WORKTREE_RUN);
      return {};
    });

    mockUsePipelineSSE.mockReturnValue([
      makeWalEvent(1, 'worktree_merge_started', { run_id: 100, branchName: 'feat/merge-test-1234' }),
      makeWalEvent(2, 'worktree_merged', { run_id: 100, branchName: 'feat/merge-test-1234', mergeCommitSha: 'deadbeef1234567' }),
    ]);

    renderWithProviders(
      <RunViewPanel runId={100} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="merge-badge-merged"]')).toBeInTheDocument();
    }, { timeout: 3000 });

    const section = document.querySelector('[data-testid="merge-status-section"]')! as HTMLElement;
    expect(within(section).getByText('feat/merge-test-1234')).toBeInTheDocument();
    expect(within(section).getByText('deadbee')).toBeInTheDocument(); // first 7 chars
  });

  it('transitions to Failed via SSE worktree_merge_failed event', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/100')) return makeRunResponse(WORKTREE_RUN);
      return {};
    });

    mockUsePipelineSSE.mockReturnValue([
      makeWalEvent(1, 'worktree_merge_started', { run_id: 100, branchName: 'feat/merge-test-1234' }),
      makeWalEvent(2, 'worktree_merge_failed', {
        run_id: 100,
        branchName: 'feat/merge-test-1234',
        conflictSummary: 'CONFLICT in src/index.ts',
        message: 'Agentic merge resolution failed',
      }),
    ]);

    renderWithProviders(
      <RunViewPanel runId={100} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="merge-badge-failed"]')).toBeInTheDocument();
    }, { timeout: 3000 });

    const section = document.querySelector('[data-testid="merge-status-section"]')! as HTMLElement;
    expect(within(section).queryByRole('button', { name: /retry merge/i })).not.toBeInTheDocument();
    expect(within(section).getByRole('button', { name: /review delivery status/i })).toBeInTheDocument();
    expect(within(section).getByText(/CONFLICT in src\/index.ts/)).toBeInTheDocument();
  });
});
