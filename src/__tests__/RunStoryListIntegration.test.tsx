/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { renderWithProviders, createMockWorkspace, createMockRun } from '../test/helpers';
import RunStoryList from '../components/RunStoryList';
import type { WalEvent } from '../hooks/usePipelineSSE';

// ─── Mock @tanstack/react-virtual ───────────────────────────────────────────
// jsdom has no layout — useVirtualizer returns zero visible items.
// Mock it to render ALL items so we can assert on story rows.
const scrollToIndexSpy = vi.fn();

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        start: i * opts.estimateSize(),
        size: opts.estimateSize(),
        key: i,
      })),
    getTotalSize: () => opts.count * opts.estimateSize(),
    scrollToIndex: scrollToIndexSpy,
  }),
}));

// ─── Mock apiFetch ──────────────────────────────────────────────────────────
vi.mock('../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

// Mock pipeline API functions used by StoryRow internals
vi.mock('../api/pipeline', () => ({
  fetchStoryOutput: vi.fn().mockResolvedValue({ output: [], failureReason: null }),
  retryRun: vi.fn().mockResolvedValue({ runId: 100 }),
  pauseRun: vi.fn(),
  resumeRun: vi.fn(),
  cancelRun: vi.fn(),
  injectContext: vi.fn(),
}));

// Mock SSE hook (may be pulled in transitively)
vi.mock('../hooks/usePipelineSSE', () => ({
  usePipelineSSE: vi.fn(() => []),
}));

// ResizeObserver needed for refs
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

import { apiFetch } from '../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

// ─── Helpers ────────────────────────────────────────────────────────────────

const WORKSPACE = createMockWorkspace({ id: 'ws-1', label: 'Test Repo', path: '/tmp/test' });
const WORKSPACE_RESPONSE = { items: [WORKSPACE], total: 1, hasMore: false };

function makeWalEvent(overrides: Partial<WalEvent> & { event_type: string }): WalEvent {
  return {
    id: Math.floor(Math.random() * 100000),
    ts: new Date().toISOString(),
    workspace_id: 'ws-1',
    spec_id: 'test-spec',
    story_id: null,
    actor: 'system',
    payload: JSON.stringify({ run_id: 42 }),
    ...overrides,
  };
}

function makeSpecStory(id: string, title: string, deps: string[] = []) {
  return { id, title, dependsOn: deps, passes: false };
}

function makeStoryResult(storyId: string, status: string, elapsed = 30) {
  return {
    story_id: storyId,
    status,
    elapsed_seconds: elapsed,
    started_at: new Date(Date.now() - elapsed * 1000).toISOString(),
    finished_at: status !== 'running' ? new Date().toISOString() : null,
    retries: 0,
    blocked_by: null,
    log_path: null,
  };
}

function setupRunApiFetch(runId: number, stories: ReturnType<typeof makeStoryResult>[], specStories: ReturnType<typeof makeSpecStory>[], runStatus = 'running') {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.includes(`/api/pipeline/runs/${runId}`)) {
      return {
        run: createMockRun({ id: runId, status: runStatus as 'running' | 'done', workspace_id: 'ws-1' }),
        stories,
        specStories,
      };
    }
    return {};
  });
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  scrollToIndexSpy.mockClear();
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('RunStoryList Integration', () => {
  it('renders RunStoryList (not StoriesListTab) with story data from API', async () => {
    const specStories = [
      makeSpecStory('US-001', 'Add Login Route'),
      makeSpecStory('US-002', 'Add Auth Middleware'),
      makeSpecStory('US-003', 'Add Password Reset'),
    ];

    setupRunApiFetch(42, [makeStoryResult('US-001', 'pass', 45)], specStories);

    renderWithProviders(
      <RunStoryList runId={42} walEvents={[]} />,
    );

    await waitFor(() => {
      expect(screen.getByText('US-001')).toBeInTheDocument();
      expect(screen.getByText('Add Login Route')).toBeInTheDocument();
      expect(screen.getByText('US-002')).toBeInTheDocument();
      expect(screen.getByText('Add Auth Middleware')).toBeInTheDocument();
      expect(screen.getByText('US-003')).toBeInTheDocument();
    });

    // RunStoryList renders a header with story count
    expect(screen.getByText(/Stories \(3\)/)).toBeInTheDocument();

    // Footer summary
    expect(screen.getByText('1 passed')).toBeInTheDocument();

    // Verify this is RunStoryList, not StoriesListTab —
    // RunStoryList renders a listbox with aria-label="Story list"
    expect(screen.getByRole('listbox', { name: 'Story list' })).toBeInTheDocument();
  });

  it('transitions story status from pending → running → passed via WAL events', async () => {
    const specStories = [
      makeSpecStory('US-001', 'Implement Feature'),
      makeSpecStory('US-002', 'Write Tests'),
    ];

    // Track fetch calls to return different data over time
    let fetchCount = 0;
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/42')) {
        fetchCount++;
        if (fetchCount <= 2) {
          return {
            run: createMockRun({ id: 42, status: 'running', workspace_id: 'ws-1' }),
            stories: [],
            specStories,
          };
        }
        return {
          run: createMockRun({ id: 42, status: 'running', workspace_id: 'ws-1' }),
          stories: [makeStoryResult('US-001', 'pass', 60)],
          specStories,
        };
      }
      return {};
    });

    // Phase 1: Both stories pending
    const { rerender } = renderWithProviders(
      <RunStoryList runId={42} walEvents={[]} />,
    );

    await waitFor(() => {
      expect(screen.getByText('US-001')).toBeInTheDocument();
    });
    expect(screen.getByText('0 passed')).toBeInTheDocument();

    // Phase 2: story_started — US-001 transitions to running
    const startedEvent = makeWalEvent({
      event_type: 'story_started',
      story_id: 'US-001',
    });

    rerender(
      <RunStoryList runId={42} walEvents={[startedEvent]} />,
    );

    await waitFor(() => {
      const badge = screen.getByText('US-001');
      // Current running story badge styling is emerald in RunStoryList
      expect(badge.className).toContain('bg-emerald-500/10');
    });

    // Phase 3: story_passed — US-001 transitions to passed
    const passedEvent = makeWalEvent({
      event_type: 'story_passed',
      story_id: 'US-001',
    });

    rerender(
      <RunStoryList runId={42} walEvents={[startedEvent, passedEvent]} />,
    );

    await waitFor(() => {
      expect(screen.getByText('1 passed')).toBeInTheDocument();
    });
  });

  it('applies animate-checkmark-pop CSS class when story transitions to passed', async () => {
    const specStories = [makeSpecStory('US-001', 'Add Feature')];

    let fetchCount = 0;
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/42')) {
        fetchCount++;
        if (fetchCount <= 2) {
          return {
            run: createMockRun({ id: 42, status: 'running', workspace_id: 'ws-1' }),
            stories: [],
            specStories,
          };
        }
        return {
          run: createMockRun({ id: 42, status: 'running', workspace_id: 'ws-1' }),
          stories: [makeStoryResult('US-001', 'pass', 30)],
          specStories,
        };
      }
      return {};
    });

    // Start with story running
    const startedEvent = makeWalEvent({
      event_type: 'story_started',
      story_id: 'US-001',
    });

    const { rerender } = renderWithProviders(
      <RunStoryList runId={42} walEvents={[startedEvent]} />,
    );

    await waitFor(() => {
      expect(screen.getByText('US-001')).toBeInTheDocument();
    });

    // Transition to passed — should trigger animate-checkmark-pop on icon
    const passedEvent = makeWalEvent({
      event_type: 'story_passed',
      story_id: 'US-001',
    });

    rerender(
      <RunStoryList runId={42} walEvents={[startedEvent, passedEvent]} />,
    );

    await waitFor(() => {
      // The StoryRow wraps content in a div; the icon inside gets animate-checkmark-pop
      // The container div gets animate-story-pass when justPassed is true
      const storyIdBadge = screen.getByText('US-001');
      // Walk up to the StoryRow container that has the animation class
      const storyRowOuter = storyIdBadge.closest('[class*="border-b"]')?.parentElement;
      expect(storyRowOuter).toBeTruthy();

      // Check for animate-checkmark-pop on the SVG icon
      const popIcon = storyRowOuter!.querySelector('.animate-checkmark-pop');
      expect(popIcon).not.toBeNull();
    });
  });

  it('shows live elapsed timer for running stories that updates over time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const specStories = [makeSpecStory('US-001', 'Running Story')];
    setupRunApiFetch(42, [], specStories);

    const now = Date.now();
    const startedEvent = makeWalEvent({
      event_type: 'story_started',
      story_id: 'US-001',
      ts: new Date(now).toISOString(),
    });

    renderWithProviders(
      <RunStoryList runId={42} walEvents={[startedEvent]} />,
    );

    await waitFor(() => {
      expect(screen.getByText('US-001')).toBeInTheDocument();
    });

    // LiveElapsed should show initial time (~0s)
    await waitFor(() => {
      expect(screen.getByText('0s')).toBeInTheDocument();
    });

    // Advance by 5 seconds
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    await waitFor(() => {
      expect(screen.getByText('5s')).toBeInTheDocument();
    });

    vi.useRealTimers();
  });

  it('auto-scrolls to newly started story in a long list', async () => {
    const specStories = Array.from({ length: 25 }, (_, i) => {
      const id = `US-${String(i + 1).padStart(3, '0')}`;
      return makeSpecStory(id, `Story ${i + 1}`);
    });

    setupRunApiFetch(42, [], specStories);

    const { rerender } = renderWithProviders(
      <RunStoryList runId={42} walEvents={[]} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Stories (25)')).toBeInTheDocument();
    });

    // Simulate story_started for US-015
    const startedEvent = makeWalEvent({
      event_type: 'story_started',
      story_id: 'US-015',
    });

    rerender(
      <RunStoryList runId={42} walEvents={[startedEvent]} />,
    );

    // The auto-scroll effect calls virtualizer.scrollToIndex
    await waitFor(() => {
      expect(scrollToIndexSpy).toHaveBeenCalledWith(
        14, // index of US-015 (0-based)
        expect.objectContaining({ align: 'auto', behavior: 'smooth' }),
      );
    });
  });

  it('displays failed stories with red styling and correct footer counts', async () => {
    const specStories = [
      makeSpecStory('US-001', 'Working Story'),
      makeSpecStory('US-002', 'Broken Story'),
    ];

    setupRunApiFetch(42, [
      makeStoryResult('US-001', 'pass', 45),
      makeStoryResult('US-002', 'fail', 20),
    ], specStories, 'done');

    renderWithProviders(
      <RunStoryList runId={42} walEvents={[]} />,
    );

    await waitFor(() => {
      expect(screen.getByText('US-002')).toBeInTheDocument();
    });

    // Failed story badge should have red styling
    const failBadge = screen.getByText('US-002');
    expect(failBadge.className).toContain('bg-red-500/10');

    // Footer counts
    expect(screen.getByText('1 passed')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
  });

  it('shows empty state message when no stories exist', async () => {
    setupRunApiFetch(42, [], [], 'running');

    renderWithProviders(
      <RunStoryList runId={42} walEvents={[]} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/no stories recorded yet/i)).toBeInTheDocument();
    });
  });
});
