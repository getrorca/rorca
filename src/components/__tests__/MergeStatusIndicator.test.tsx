/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import MergeStatusIndicator, { type MergeStatus } from '../MergeStatusIndicator';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

// Capture the usePipelineSSE mock so we can control returned events per test
let mockEvents: ReturnType<typeof import('../../hooks/usePipelineSSE').usePipelineSSE> = [];
vi.mock('../../hooks/usePipelineSSE', () => ({
  usePipelineSSE: vi.fn(() => mockEvents),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWalEvent(eventType: string, runId = 1, extra: Record<string, unknown> = {}) {
  return {
    id: Math.floor(Math.random() * 10000),
    ts: new Date().toISOString(),
    event_type: eventType,
    workspace_id: 'ws-1',
    spec_id: null,
    story_id: null,
    actor: 'system',
    payload: JSON.stringify({ run_id: runId, ...extra }),
  };
}

function renderIndicator(initialStatus: MergeStatus | null = 'pending', runId = 1) {
  return renderWithProviders(
    <MergeStatusIndicator runId={runId} initialStatus={initialStatus} />,
  );
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockEvents = [];
  localStorage.setItem('rorca_workspaceId', 'ws-1');

  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
    return {};
  });
});

// ─── State Rendering Tests ───────────────────────────────────────────────────

describe('MergeStatusIndicator', () => {
  describe('badge rendering per state', () => {
    it('renders pending state with Clock icon and gray color', () => {
      renderIndicator('pending');

      const badge = screen.getByTestId('merge-badge-pending');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent('Merge pending');
      expect(badge).toHaveClass('text-gray-400');

      const icon = screen.getByTestId('merge-icon-pending');
      expect(icon).toBeInTheDocument();
      expect(icon).not.toHaveClass('animate-spin');
    });

    it('renders merging state with Loader2 spinner and amber color', () => {
      renderIndicator('merging');

      const badge = screen.getByTestId('merge-badge-merging');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent('Merging');
      expect(badge).toHaveClass('text-amber-400');

      const icon = screen.getByTestId('merge-icon-merging');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveClass('animate-spin');
    });

    it('renders merged state with CheckCircle icon and green color', () => {
      renderIndicator('merged');

      const badge = screen.getByTestId('merge-badge-merged');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent('Merged');
      expect(badge).toHaveClass('text-green-400');

      const icon = screen.getByTestId('merge-icon-merged');
      expect(icon).toBeInTheDocument();
      expect(icon).not.toHaveClass('animate-spin');
    });

    it('renders failed state with XCircle icon and red color', () => {
      renderIndicator('failed');

      const badge = screen.getByTestId('merge-badge-failed');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent('Merge failed');
      expect(badge).toHaveClass('text-red-400');

      const icon = screen.getByTestId('merge-icon-failed');
      expect(icon).toBeInTheDocument();
      expect(icon).not.toHaveClass('animate-spin');
    });

    it('defaults to pending when initialStatus is null', () => {
      renderIndicator(null);

      const badge = screen.getByTestId('merge-badge-pending');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent('Merge pending');
    });
  });

  // ─── SSE Event Handling ──────────────────────────────────────────────────

  describe('SSE event-driven state transitions', () => {
    it('transitions pending → merging on merge_started event', async () => {
      mockEvents = [makeWalEvent('merge_started')];
      renderIndicator('pending');

      await waitFor(() => {
        expect(screen.getByTestId('merge-badge-merging')).toBeInTheDocument();
        expect(screen.getByTestId('merge-icon-merging')).toHaveClass('animate-spin');
      });
    });

    it('transitions pending → merging on worktree_merge_started event', async () => {
      mockEvents = [makeWalEvent('worktree_merge_started')];
      renderIndicator('pending');

      await waitFor(() => {
        expect(screen.getByTestId('merge-badge-merging')).toBeInTheDocument();
      });
    });

    it('transitions merging → merged on merge_completed event', async () => {
      mockEvents = [
        makeWalEvent('merge_started'),
        makeWalEvent('merge_completed', 1, { mergeCommitSha: 'abc123' }),
      ];
      renderIndicator('pending');

      await waitFor(() => {
        expect(screen.getByTestId('merge-badge-merged')).toBeInTheDocument();
        expect(screen.getByTestId('merge-icon-merged')).not.toHaveClass('animate-spin');
      });
    });

    it('transitions merging → merged on worktree_merged event', async () => {
      mockEvents = [
        makeWalEvent('worktree_merge_started'),
        makeWalEvent('worktree_merged', 1, { mergeCommitSha: 'def456' }),
      ];
      renderIndicator('pending');

      await waitFor(() => {
        expect(screen.getByTestId('merge-badge-merged')).toBeInTheDocument();
      });
    });

    it('transitions merging → failed on merge_failed event', async () => {
      mockEvents = [
        makeWalEvent('merge_started'),
        makeWalEvent('merge_failed', 1, { conflictFiles: ['src/index.ts'] }),
      ];
      renderIndicator('pending');

      await waitFor(() => {
        expect(screen.getByTestId('merge-badge-failed')).toBeInTheDocument();
        expect(screen.getByTestId('merge-icon-failed')).not.toHaveClass('animate-spin');
      });
    });

    it('transitions merging → failed on worktree_merge_failed event', async () => {
      mockEvents = [
        makeWalEvent('worktree_merge_started'),
        makeWalEvent('worktree_merge_failed', 1, { conflictFiles: ['package.json'] }),
      ];
      renderIndicator('pending');

      await waitFor(() => {
        expect(screen.getByTestId('merge-badge-failed')).toBeInTheDocument();
      });
    });

    it('full success path: pending → merging → merged', async () => {
      mockEvents = [
        makeWalEvent('merge_started'),
        makeWalEvent('merge_completed', 1, { mergeCommitSha: 'abc123' }),
      ];
      renderIndicator('pending');

      await waitFor(() => {
        const badge = screen.getByTestId('merge-badge-merged');
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveTextContent('Merged');
        expect(badge).toHaveClass('text-green-400');
      });
    });

    it('full failure path: pending → merging → failed', async () => {
      mockEvents = [
        makeWalEvent('merge_started'),
        makeWalEvent('merge_failed', 1, { conflictFiles: ['a.ts', 'b.ts'] }),
      ];
      renderIndicator('pending');

      await waitFor(() => {
        const badge = screen.getByTestId('merge-badge-failed');
        expect(badge).toBeInTheDocument();
        expect(badge).toHaveTextContent('Merge failed');
        expect(badge).toHaveClass('text-red-400');
      });
    });

    it('ignores unrelated WAL event types', async () => {
      mockEvents = [
        makeWalEvent('story_started'),
        makeWalEvent('story_passed'),
        makeWalEvent('run_finished'),
      ];
      renderIndicator('pending');

      // Wait for effect to run, then assert state is still pending
      await waitFor(() => {
        expect(screen.getByTestId('merge-badge-pending')).toBeInTheDocument();
      });
    });
  });

  // ─── Retry Merge Button ────────────────────────────────────────────────

  describe('Retry Merge button', () => {
    it('is visible and enabled when status is failed', () => {
      renderIndicator('failed');

      const btn = screen.getByTestId('retry-merge-button');
      expect(btn).toBeInTheDocument();
      expect(btn).toBeEnabled();
      expect(btn).toHaveTextContent('Retry Merge');
    });

    it('is absent when status is merged', () => {
      renderIndicator('merged');

      expect(screen.queryByTestId('retry-merge-button')).not.toBeInTheDocument();
    });

    it('is absent when status is merging', () => {
      renderIndicator('merging');

      expect(screen.queryByTestId('retry-merge-button')).not.toBeInTheDocument();
    });

    it('is absent when status is pending', () => {
      renderIndicator('pending');

      expect(screen.queryByTestId('retry-merge-button')).not.toBeInTheDocument();
    });

    it('calls POST /api/pipeline/runs/:runId/retry-merge on click', async () => {
      mockApiFetch.mockImplementation(async (path: string) => {
        if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
        if (path.includes('/retry-merge')) return { ok: true, runId: 42, queued: true };
        return {};
      });

      renderIndicator('failed', 42);

      const user = userEvent.setup();
      await user.click(screen.getByTestId('retry-merge-button'));

      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/pipeline/runs/42/retry-merge',
        { method: 'POST' },
      );
    });

    it('transitions to merging state after successful retry', async () => {
      mockApiFetch.mockImplementation(async (path: string) => {
        if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
        if (path.includes('/retry-merge')) return { ok: true, runId: 1, queued: true };
        return {};
      });

      renderIndicator('failed');

      const user = userEvent.setup();
      await user.click(screen.getByTestId('retry-merge-button'));

      await waitFor(() => {
        expect(screen.getByTestId('merge-badge-merging')).toBeInTheDocument();
      });
      // Button should disappear once in merging state
      expect(screen.queryByTestId('retry-merge-button')).not.toBeInTheDocument();
    });

    it('stays failed if retry request throws', async () => {
      mockApiFetch.mockImplementation(async (path: string) => {
        if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
        if (path.includes('/retry-merge')) throw new Error('Network error');
        return {};
      });

      renderIndicator('failed');

      const user = userEvent.setup();
      await user.click(screen.getByTestId('retry-merge-button'));

      await waitFor(() => {
        expect(screen.getByTestId('merge-badge-failed')).toBeInTheDocument();
        expect(screen.getByTestId('retry-merge-button')).toBeEnabled();
      });
    });

    it('shows "Retrying..." text while request is in flight', async () => {
      let resolveRetry: (v: unknown) => void;
      mockApiFetch.mockImplementation(async (path: string) => {
        if (path === '/api/workspaces') return { items: [], total: 0, hasMore: false };
        if (path.includes('/retry-merge')) {
          return new Promise((resolve) => { resolveRetry = resolve; });
        }
        return {};
      });

      renderIndicator('failed');

      const user = userEvent.setup();
      await user.click(screen.getByTestId('retry-merge-button'));

      await waitFor(() => {
        expect(screen.getByTestId('retry-merge-button')).toHaveTextContent('Retrying...');
        expect(screen.getByTestId('retry-merge-button')).toBeDisabled();
      });

      // Resolve to clean up
      await act(async () => { resolveRetry!({ ok: true }); });
    });
  });

  // ─── Accessibility ─────────────────────────────────────────────────────

  describe('accessibility', () => {
    const statuses: MergeStatus[] = ['pending', 'merging', 'merged', 'failed'];
    const labels: Record<MergeStatus, string> = {
      pending: 'Merge pending',
      merging: 'Merging',
      merged: 'Merged',
      failed: 'Merge failed',
    };

    it.each(statuses)('badge has role="status" and correct aria-label for %s state', (status) => {
      renderIndicator(status);

      const badge = screen.getByTestId(`merge-badge-${status}`);
      expect(badge).toHaveAttribute('role', 'status');
      expect(badge).toHaveAttribute('aria-label', labels[status]);
    });
  });

  // ─── Agent Agnostic ────────────────────────────────────────────────────

  describe('agent-agnostic behavior', () => {
    it('renders identically regardless of which agent produced the run', () => {
      // Component receives merge_status — it does not care about agent_type.
      // Verify the component has no agent_type prop and renders the same
      // for any initialStatus value.
      const { container: c1 } = renderIndicator('merged');
      const badge1 = c1.querySelector('[data-testid="merge-badge-merged"]');
      expect(badge1).toHaveTextContent('Merged');

      // Re-render — same output, no agent distinction
      const { container: c2 } = renderIndicator('merged', 99);
      const badge2 = c2.querySelector('[data-testid="merge-badge-merged"]');
      expect(badge2).toHaveTextContent('Merged');
    });
  });
});
