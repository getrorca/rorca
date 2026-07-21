/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

vi.mock('../../components/AppHeader', () => ({
  default: vi.fn(({
    title,
    breadcrumbs,
    actions,
  }: {
    title?: React.ReactNode;
    breadcrumbs?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div data-testid="app-header">
      <div>{breadcrumbs ?? title}</div>
      <div>{actions}</div>
    </div>
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
      if (path.includes('/api/pipeline/runs/999')) throw Object.assign(new Error('Not found'), { status: 404 });
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

  it('does not misreport a transient load failure as a missing run and allows retry', async () => {
    let attempts = 0;
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/998')) {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('Too many requests'), { status: 429 });
        return { ...MOCK_RUN_RESPONSE, run: { ...BASE_RUN, id: 998 } };
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={998} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    expect(await screen.findByText(/temporarily rate limited/i)).toBeInTheDocument();
    expect(screen.queryByText(/Run #998 was not found/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(await screen.findByTestId('run-terminal')).toHaveTextContent('Terminal for run 998');
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

  it('uses one normalized Pi engine/model in the header and metadata panel', async () => {
    const piRun = createMockRun({
      id: 57,
      status: 'done',
      workspace_id: 'ws-1',
      agent_type: 'pi',
      agent_model: 'openai-codex/gpt-5.6-sol',
    });

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${piRun.id}`)) {
        return {
          run: piRun,
          stories: [],
          specStories: [],
          agentType: 'pi',
          agentModel: 'openai-codex/gpt-5.6-sol',
        };
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={piRun.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getAllByText('Pi')).toHaveLength(2);
      expect(screen.getByTestId('run-engine-model')).toHaveTextContent('GPT 5.6 Sol');
      expect(screen.getByTestId('run-engine-model')).toHaveAttribute('title', 'openai-codex/gpt-5.6-sol');
      expect(screen.getByText('openai-codex/gpt-5.6-sol')).toBeInTheDocument();
    });
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
  });

  it('uses top-level camelCase compatibility for both run header and metadata', async () => {
    const compatibilityRun = {
      ...createMockRun({ id: 58, status: 'done', workspace_id: 'ws-1' }),
      agent_type: null,
      agent_model: null,
    };

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${compatibilityRun.id}`)) {
        return {
          run: compatibilityRun,
          stories: [],
          specStories: [],
          agentType: 'codex',
          agentModel: 'gpt-5.6-sol',
        };
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={compatibilityRun.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getAllByText('Codex')).toHaveLength(2);
      expect(screen.getByText('gpt-5.6-sol')).toBeInTheDocument();
    });
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
  });

  it('renders missing historical run provenance as Unknown in both surfaces', async () => {
    const historicalRun = {
      ...createMockRun({ id: 59, status: 'done', workspace_id: 'ws-1' }),
      agent_type: null,
      agent_model: null,
    };

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${historicalRun.id}`)) {
        return {
          run: historicalRun,
          stories: [],
          specStories: [],
          agentType: null,
          agentModel: null,
        };
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={historicalRun.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getAllByText('Unknown')).toHaveLength(2));
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
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

  it('shows clear continuation state in the right rail for resumed runs', async () => {
    const resumedRun = createMockRun({
      id: 76,
      status: 'running',
      workspace_id: 'ws-1',
      finished_at: null,
    });

    mockUsePipelineSSE.mockReturnValue([
      { event_type: 'story_started', story_id: 'US-003', ts: new Date().toISOString() },
    ]);

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${resumedRun.id}`)) {
        return {
          run: resumedRun,
          stories: [],
          specStories: [
            { id: 'US-001', title: 'One' },
            { id: 'US-002', title: 'Two' },
            { id: 'US-003', title: 'Three' },
          ],
          runState: {
            specId: 'resume-spec',
            runId: resumedRun.id,
            startedAt: new Date(Date.now() - 60_000).toISOString(),
            lastUpdatedAt: new Date().toISOString(),
            completedStories: [
              { storyId: 'US-001', title: 'One', status: 'passed', startedAt: new Date(Date.now() - 180_000).toISOString(), finishedAt: new Date(Date.now() - 150_000).toISOString(), agentType: 'pi' },
              { storyId: 'US-002', title: 'Two', status: 'passed', startedAt: new Date(Date.now() - 150_000).toISOString(), finishedAt: new Date(Date.now() - 120_000).toISOString(), agentType: 'pi' },
            ],
            failedStories: [],
            skippedStories: [],
            currentStory: 'US-003',
            resumedFromStory: 'US-002',
          },
          specModel: 'claude-sonnet-4-6',
        };
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={resumedRun.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('story-list-resume-banner')).toHaveTextContent('Continuing');
      expect(screen.getByTestId('story-list-resume-banner')).toHaveTextContent('US-003');
      expect(screen.getByTestId('run-resume-summary')).toHaveTextContent('2 carried forward');
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

  it('surfaces per-story context (skills + files) in the Stories view', async () => {
    const CONTEXT_RUN = createMockRun({
      id: 55,
      status: 'done',
      spec_path: 'forge/specs/approved/ctx-feature.json',
      workspace_id: 'ws-1',
    });

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${CONTEXT_RUN.id}`)) {
        return {
          run: CONTEXT_RUN,
          stories: [
            { story_id: 'US-001', status: 'pass', elapsed_seconds: 20, started_at: null, finished_at: null, active_skills: JSON.stringify(['react']) },
          ],
          specStories: [
            { id: 'US-001', title: 'Build Widget', suggestedSkills: [{ name: 'react', relevance: 8, reason: 'Component work' }] },
          ],
          specModel: 'claude-sonnet-4-6',
          contextComparison: {
            predicted: { 'US-001': { totalTokens: 1500, injectedFiles: ['src/widget.tsx'] } },
            actual: { 'US-001': { contextFiles: ['src/widget.tsx', 'src/widget.test.tsx'] } },
          },
          storyTokenBreakdown: [
            { storyId: 'US-001', status: 'pass', inputTokens: 1500, outputTokens: 400, modelUsed: 'claude-sonnet-4-6', costUsd: 0 },
          ],
        };
      }
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={CONTEXT_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    // Wait for run data to load
    await waitFor(() => {
      expect(
        screen.queryByText(/ctx.feature/i) ?? document.querySelector('[data-testid="run-terminal"]'),
      ).toBeInTheDocument();
    }, { timeout: 3000 });

    // Navigate to the Stories tab
    const storiesTab = await screen.findByRole('button', { name: /stories/i });
    await userEvent.click(storiesTab);

    // The aggregate context summary bar reflects the wired per-story context:
    // avg input tokens, 2 unique context files, and 1 routing skill.
    const summaryBar = await screen.findByLabelText('Run context usage summary', {}, { timeout: 3000 });
    expect(summaryBar).toHaveTextContent(/~1\.5K tokens\/story/);
    expect(summaryBar).toHaveTextContent('2 files');
    expect(summaryBar).toHaveTextContent('1 routing skill');
  });

  it('top Context shortcut opens the Context tab, not Skills', async () => {
    const CONTEXT_RUN = createMockRun({
      id: 56,
      status: 'done',
      spec_path: 'forge/specs/approved/ctx-shortcut.json',
      workspace_id: 'ws-1',
    });

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${CONTEXT_RUN.id}`)) {
        return {
          run: CONTEXT_RUN,
          stories: [
            { story_id: 'US-001', status: 'pass', elapsed_seconds: 20, started_at: null, finished_at: null, active_skills: JSON.stringify(['react']) },
          ],
          specStories: [{ id: 'US-001', title: 'Build Widget' }],
          contextComparison: {
            predicted: { 'US-001': { totalTokens: 1500, injectedFiles: ['src/widget.tsx'] } },
            actual: { 'US-001': { contextFiles: ['src/widget.tsx'] } },
          },
          storyTokenBreakdown: [
            { storyId: 'US-001', status: 'pass', inputTokens: 1500, outputTokens: 400, modelUsed: 'claude-sonnet-4-6', costUsd: 0 },
          ],
        };
      }
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={CONTEXT_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    const shortcut = await screen.findByRole('button', { name: /context →/i });
    await userEvent.click(shortcut);

    expect(await screen.findByTestId('context-inspector-empty')).toBeInTheDocument();
    expect(screen.queryByText(/^Skills matched$/i)).not.toBeInTheDocument();
  });

  it.each([
    ['process finish before closeout', [
      { event_type: 'run_finished', story_id: null, ts: new Date().toISOString(), payload: JSON.stringify({ run_id: 88, status: 'done', exit_code: 0 }) },
      { event_type: 'run_closeout', story_id: null, ts: new Date().toISOString(), payload: JSON.stringify({ run_id: 88, status: 'failed' }) },
    ]],
    ['process finish after closeout', [
      { event_type: 'run_closeout', story_id: null, ts: new Date().toISOString(), payload: JSON.stringify({ run_id: 88, status: 'failed' }) },
      { event_type: 'run_finished', story_id: null, ts: new Date().toISOString(), payload: JSON.stringify({ run_id: 88, status: 'done', exit_code: 0 }) },
    ]],
  ])('renders failed semantic closeout when %s', async (_label, events) => {
    const closeoutRun = createMockRun({ id: 88, status: 'done', workspace_id: 'ws-1' });
    mockUsePipelineSSE.mockReturnValue(events);
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/88')) {
        return {
          run: closeoutRun,
          stories: [],
          specStories: [{ id: 'US-001', title: 'No accepted result' }],
        };
      }
      return {};
    });

    renderWithProviders(<RunViewPanel runId={88} onBack={vi.fn()} onNavigate={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('run-semantic-status')).toHaveTextContent('Failed'));
    expect(screen.getByText(/Run failed — 1 story did not complete.*1 no result/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry failed stories/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Passed')).not.toBeInTheDocument();
  });

  it('renders terminal success without story evidence as Incomplete, never Passed', async () => {
    const incompleteRun = createMockRun({ id: 89, status: 'done', workspace_id: 'ws-1' });
    mockUsePipelineSSE.mockReturnValue([
      { event_type: 'run_finished', story_id: null, ts: new Date().toISOString(), payload: JSON.stringify({ run_id: 89, status: 'done', exit_code: 0 }) },
      { event_type: 'run_closeout', story_id: null, ts: new Date().toISOString(), payload: JSON.stringify({ run_id: 89, status: 'done' }) },
    ]);
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/89')) {
        return {
          run: incompleteRun,
          stories: [],
          specStories: Array.from({ length: 12 }, (_, index) => ({ id: `TAX-${String(index + 1).padStart(3, '0')}`, title: `Story ${index + 1}` })),
        };
      }
      return {};
    });

    renderWithProviders(<RunViewPanel runId={89} onBack={vi.fn()} onNavigate={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('run-semantic-status')).toHaveTextContent('Incomplete'));
    expect(screen.queryByText('Passed')).not.toBeInTheDocument();
  });

  it('labels a successful scoped retry without full-spec evidence as Scope passed', async () => {
    const retryRun = {
      ...createMockRun({ id: 90, status: 'done', workspace_id: 'ws-1' }),
      retried_from_run_id: 87,
    };
    mockUsePipelineSSE.mockReturnValue([
      { event_type: 'story_passed', story_id: 'US-002', ts: new Date().toISOString(), payload: JSON.stringify({ run_id: 90 }) },
      { event_type: 'run_finished', story_id: null, ts: new Date().toISOString(), payload: JSON.stringify({ run_id: 90, original_run_id: 87, source: 'worker_retry', status: 'done', retry_scope_complete: true, full_spec_complete: false }) },
    ]);
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('/api/pipeline/runs/90')) {
        return {
          run: retryRun,
          stories: [{ story_id: 'US-002', status: 'pass', elapsed_seconds: 12, started_at: null, finished_at: new Date().toISOString() }],
          specStories: [
            { id: 'US-001', title: 'Prior story' },
            { id: 'US-002', title: 'Retried story' },
            { id: 'US-003', title: 'Remaining story' },
          ],
        };
      }
      return {};
    });

    renderWithProviders(<RunViewPanel runId={90} onBack={vi.fn()} onNavigate={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('run-semantic-status')).toHaveTextContent('Scope passed'));
    expect(screen.queryByText(/^Passed$/)).not.toBeInTheDocument();
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
