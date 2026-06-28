/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 *
 * US-012: Focused tests for ContextHealthPanel states:
 *   ready, stale, running, failed, disabled/missing Hilo.
 * Also verifies trigger hydration action feedback and apiFetch usage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import ContextHealthPanel from '../ContextHealthPanel';

// ─── Mocks ──────────────────────────────────────────────────────────────────

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

// ─── Fixtures ───────────────────────────────────────────────────────────────

const WORKSPACE_ROW = { id: 'ws-1', label: 'My Repo', path: '/tmp/repo', domains: [] };
const WORKSPACE_RESPONSE = { items: [WORKSPACE_ROW], total: 1, hasMore: false };

/** Helper: set up apiFetch mock to return workspace list (auto-selects ws-1) and a hydration response. */
function mockWorkspaceAndHydration(hydrationResp: unknown) {
  mockApiFetch.mockImplementation(async (path: unknown) => {
    const p = String(path);
    if (p === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (p === '/api/workspaces/ws-1/hydration') return hydrationResp;
    // WorkspaceProvider side effects: pipeline runs, pipeline-config, active runs.
    if (p.startsWith('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
    if (p.startsWith('/api/workspaces/ws-1/pipeline-config')) return { config: {} };
    return {};
  });
}

/** Base success response — ready state. */
const READY_RESPONSE = {
  workspaceId: 'ws-1',
  provider: 'hilo' as const,
  latest: {
    id: 1,
    workspaceId: 'ws-1',
    provider: 'hilo',
    status: 'succeeded' as const,
    gitSha: 'abc1234567890def',
    graphPath: '/tmp/graph.json',
    counts: { nodes: 150, edges: 420, files: 80, imports: 200, reverseImporters: 180, tests: 45, testedBy: 30, roles: 12 },
    durationMs: 3200,
    staleReason: null,
    errorJson: null,
    startedAt: new Date(Date.now() - 60000).toISOString(),
    finishedAt: new Date(Date.now() - 30000).toISOString(),
    createdAt: new Date(Date.now() - 60000).toISOString(),
    updatedAt: new Date(Date.now() - 30000).toISOString(),
  },
  freshness: 'clean' as const,
  freshnessDetails: {
    gitRepo: true,
    hasHydration: true,
    headMatches: true,
    dirtyTree: false,
    currentHead: 'abc1234567890def',
    hydratedSha: 'abc1234567890def',
    humanSummary: 'Graph is fresh — hydration matches current HEAD.',
  },
  counts: { nodes: 150, edges: 420, files: 80, imports: 200, reverseImporters: 180, tests: 45, testedBy: 30, roles: 12 },
  errors: { hasErrors: false, latestError: null, latestErrorStatus: null },
  currentStatus: 'succeeded' as const,
  actionHint: 'none' as const,
  actionMessage: null,
};

/** Stale response. */
const STALE_RESPONSE = {
  ...READY_RESPONSE,
  freshness: 'stale' as const,
  freshnessDetails: {
    ...READY_RESPONSE.freshnessDetails,
    headMatches: false,
    currentHead: 'def6789abcdef01',
    humanSummary: 'New commits exist since the last hydration. The graph is stale and should be re-hydrated.',
  },
  currentStatus: 'succeeded' as const,
  actionHint: 'rehydrate' as const,
  actionMessage: 'New commits exist since the last hydration. Re-hydrate to capture recent changes.',
};

/** Running response. */
const RUNNING_RESPONSE = {
  ...READY_RESPONSE,
  latest: {
    ...READY_RESPONSE.latest,
    status: 'running' as const,
    finishedAt: null,
    durationMs: null,
    counts: {},
  },
  currentStatus: 'running' as const,
  freshness: 'unknown' as const,
  freshnessDetails: {
    gitRepo: true,
    hasHydration: true,
    headMatches: false,
    dirtyTree: false,
    currentHead: 'abc1234567890def',
    hydratedSha: 'ghi4567890abcde',
    humanSummary: 'Hydration is in progress.',
  },
  counts: {},
  actionHint: 'wait' as const,
  actionMessage: 'Hydration is currently running.',
};

/** Failed response. */
const FAILED_RESPONSE = {
  ...READY_RESPONSE,
  latest: {
    ...READY_RESPONSE.latest,
    status: 'failed' as const,
    finishedAt: new Date(Date.now() - 30000).toISOString(),
    durationMs: 1200,
    counts: {},
    errorJson: { message: 'Hilo process exited with code 1', stderr: 'Error: could not parse AST' },
  },
  currentStatus: 'failed' as const,
  freshness: 'stale' as const,
  freshnessDetails: {
    gitRepo: true,
    hasHydration: true,
    headMatches: false,
    dirtyTree: false,
    currentHead: 'def6789abcdef01',
    hydratedSha: null,
    humanSummary: 'The last hydration failed. Re-hydrate to rebuild the graph.',
  },
  counts: {},
  errors: { hasErrors: true, latestError: { message: 'Hilo process exited with code 1', stderr: 'Error: could not parse AST' }, latestErrorStatus: 'failed' },
  actionHint: 'rehydrate' as const,
  actionMessage: 'The last hydration failed. Re-hydrate to rebuild the graph.',
};

/** Disabled / missing Hilo response. */
const DISABLED_RESPONSE = {
  workspaceId: 'ws-1',
  provider: 'hilo' as const,
  latest: null,
  freshness: 'missing' as const,
  freshnessDetails: {
    gitRepo: true,
    hasHydration: false,
    headMatches: false,
    dirtyTree: false,
    currentHead: 'abc1234567890def',
    hydratedSha: null,
    humanSummary: 'No hydration data available.',
  },
  counts: {},
  errors: { hasErrors: false, latestError: null, latestErrorStatus: null },
  currentStatus: null,
  actionHint: 'configure_hilo' as const,
  actionMessage: 'Hilo is not available for this workspace. Configure and enable Hilo to hydrate the codegraph.',
};

/** Missing (no hydration yet, but Hilo available). */
const MISSING_RESPONSE = {
  ...DISABLED_RESPONSE,
  actionHint: 'hydrate' as const,
  actionMessage: 'No hydration has been attempted. Hydrate to build the codegraph.',
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ContextHealthPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Ready state ─────────────────────────────────────────────────────────

  it('renders the ready state with green badge when hydration is current', async () => {
    mockWorkspaceAndHydration(READY_RESPONSE);

    renderWithProviders(<ContextHealthPanel />);

    const badge = await screen.findByTestId('context-health-state-badge');
    expect(badge).toHaveTextContent('Ready');
    expect(badge.className).toContain('emerald');

    // Summary shows freshness as 'Current'.
    expect(screen.getByText('Current')).toBeDefined();
  });

  // ── Stale state ─────────────────────────────────────────────────────────

  it('renders the stale state with amber badge and stale reason', async () => {
    mockWorkspaceAndHydration(STALE_RESPONSE);

    renderWithProviders(<ContextHealthPanel />);

    const badge = await screen.findByTestId('context-health-state-badge');
    expect(badge).toHaveTextContent('Stale');
    expect(badge.className).toContain('amber');

    // Expand to see details.
    const toggle = screen.getByTestId('context-health-expand-toggle');
    await userEvent.click(toggle);

    // Stale reason should be visible.
    expect(screen.getByText(/New commits exist since the last hydration/)).toBeDefined();

    // SHA comparison shows mismatch.
    expect(screen.getByText('def6789')).toBeDefined();
    expect(screen.getByText('abc1234')).toBeDefined();
  });

  // ── Running state ───────────────────────────────────────────────────────

  it('renders the running state with accent badge and disabled trigger', async () => {
    mockWorkspaceAndHydration(RUNNING_RESPONSE);

    renderWithProviders(<ContextHealthPanel />);

    const badge = await screen.findByTestId('context-health-state-badge');
    expect(badge).toHaveTextContent('Running');

    const trigger = screen.getByTestId('context-health-trigger');
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent('Hydrating…');
  });

  // ── Failed state ────────────────────────────────────────────────────────

  it('renders the failed state with error details expanded', async () => {
    mockWorkspaceAndHydration(FAILED_RESPONSE);

    renderWithProviders(<ContextHealthPanel />);

    const badge = await screen.findByTestId('context-health-state-badge');
    expect(badge).toHaveTextContent('Failed');
    expect(badge.className).toContain('rose');

    // Expand to see errors.
    const toggle = screen.getByTestId('context-health-expand-toggle');
    await userEvent.click(toggle);

    // Error details should be visible.
    const errors = screen.getByTestId('context-health-errors');
    expect(errors).toBeDefined();
    expect(errors.textContent).toContain('Hilo process exited with code 1');
    expect(errors.textContent).toContain('could not parse AST');
  });

  // ── Disabled / missing Hilo state ───────────────────────────────────────

  it('renders the disabled state when Hilo is not available', async () => {
    mockWorkspaceAndHydration(DISABLED_RESPONSE);

    renderWithProviders(<ContextHealthPanel />);

    const badge = await screen.findByTestId('context-health-state-badge');
    expect(badge).toHaveTextContent('No Hilo');

    // No trigger button when disabled.
    expect(screen.queryByTestId('context-health-trigger')).toBeNull();

    // Expand to see hint message.
    const toggle = screen.getByTestId('context-health-expand-toggle');
    await userEvent.click(toggle);

    expect(screen.getByText(/Hilo is not available/)).toBeDefined();
  });

  // ── Missing state (Hilo available, no hydration yet) ────────────────────

  it('renders the missing state with hydrate action button', async () => {
    mockWorkspaceAndHydration(MISSING_RESPONSE);

    renderWithProviders(<ContextHealthPanel />);

    const badge = await screen.findByTestId('context-health-state-badge');
    expect(badge).toHaveTextContent('No data');

    // Trigger button should say "Hydrate".
    const trigger = screen.getByTestId('context-health-trigger');
    expect(trigger).toHaveTextContent('Hydrate');
    expect(trigger).not.toBeDisabled();
  });

  // ── Trigger hydration action ────────────────────────────────────────────

  it('shows queued feedback when hydration is triggered', async () => {
    let getCallCount = 0;
    mockApiFetch.mockImplementation(async (path: unknown, opts?: unknown) => {
      const p = String(path);
      const isPost = (opts && typeof opts === 'object' && 'method' in opts && (opts as Record<string,unknown>).method === 'POST');
      if (p === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (p.startsWith('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      if (p.startsWith('/api/workspaces/ws-1/pipeline-config')) return { config: {} };
      if (p === '/api/workspaces/ws-1/hydration') {
        if (isPost) {
          return {
            hydrationId: 5,
            status: 'pending',
            idempotent: false,
            message: 'Hydration queued. Monitor status via GET /api/workspaces/{workspaceId}/hydration.',
          };
        }
        getCallCount += 1;
        // First GET: missing, subsequent GETs: running (polling).
        if (getCallCount <= 1) return MISSING_RESPONSE;
        return RUNNING_RESPONSE;
      }
      return {};
    });

    const user = userEvent.setup();
    renderWithProviders(<ContextHealthPanel />);

    const trigger = await screen.findByTestId('context-health-trigger');
    await user.click(trigger);

    // Feedback banner should appear with queuing state.
    const feedback = await screen.findByTestId('context-health-trigger-feedback');
    expect(feedback).toBeDefined();
    expect(feedback.textContent).toContain('Hydration queued');
  });

  // ── Counts display ──────────────────────────────────────────────────────

  it('renders graph counts in the expanded view', async () => {
    mockWorkspaceAndHydration(READY_RESPONSE);

    renderWithProviders(<ContextHealthPanel />);

    await screen.findByTestId('context-health-state-badge');

    const toggle = screen.getByTestId('context-health-expand-toggle');
    await userEvent.click(toggle);

    // Counts section should have all the expected values.
    const counts = screen.getByTestId('context-health-counts');
    expect(counts).toBeDefined();
    expect(counts.textContent).toContain('150');  // nodes
    expect(counts.textContent).toContain('420');  // edges
    expect(counts.textContent).toContain('80');   // files
    expect(counts.textContent).toContain('200');  // imports
    expect(counts.textContent).toContain('45');   // tests
  });

  // ── Uses apiFetch (not raw fetch) ───────────────────────────────────────

  it('calls apiFetch for hydration status', async () => {
    mockWorkspaceAndHydration(READY_RESPONSE);

    renderWithProviders(<ContextHealthPanel />);

    await screen.findByTestId('context-health-state-badge');

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/workspaces/ws-1/hydration',
      expect.objectContaining({ silent: true }),
    );
  });

  // ── Error handling ─────────────────────────────────────────────────────

  it('renders error state when fetch fails', async () => {
    mockApiFetch.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (p.startsWith('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      if (p.startsWith('/api/workspaces/ws-1/pipeline-config')) return { config: {} };
      throw new Error('Network error');
    });

    renderWithProviders(<ContextHealthPanel />);

    const errorEl = await screen.findByTestId('context-health-error');
    expect(errorEl).toBeDefined();
    expect(errorEl.textContent).toContain('Network error');
  });

  // ── Loading state ──────────────────────────────────────────────────────

  it('renders loading skeleton while fetching hydration after workspace loads', async () => {
    // Pre-set workspaceId so the context has it from the start.
    sessionStorage.setItem('rorca_workspaceId', 'ws-1');

    mockApiFetch.mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (p.startsWith('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      if (p.startsWith('/api/workspaces/ws-1/pipeline-config')) return { config: {} };
      // Hydration fetch hangs forever.
      return new Promise(() => {});
    });

    renderWithProviders(<ContextHealthPanel />);

    const loadingEl = await screen.findByTestId('context-health-loading', {}, { timeout: 2000 });
    expect(loadingEl).toBeDefined();
  });
});
