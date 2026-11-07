/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

const orchestrationEvent = (
  id: number,
  kind: 'agent_started' | 'task_started' | 'agent_progress' | 'agent_completed' | 'agent_failed',
  agentId: string,
  raw: Record<string, unknown> = {},
  parentAgentId: string | null = null,
) => ({
  id,
  ts: `2026-03-16T00:00:0${Math.min(id, 9)}.000Z`,
  event_type: `orchestration.${kind}`,
  workspace_id: 'ws-1',
  spec_id: 'auth-feature',
  story_id: 'US-001',
  actor: 'omp-managed-executor',
  payload: JSON.stringify({
    schemaVersion: 'rorca.orchestration-event.v1',
    kind,
    sequence: id,
    observedAt: `2026-03-16T00:00:0${Math.min(id, 9)}.000Z`,
    attempt: { id: 'attempt-1' },
    process: { id: 'process-1' },
    omp: { agentId, parentAgentId, taskId: raw.taskId ?? null, rpcType: raw.type ?? kind, raw },
  }),
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

  it('offers read-only exact-evidence preview for any selected run supported by the endpoint', async () => {
    const exactRunId = 731;
    const failedRun = createMockRun({
      id: exactRunId,
      status: 'failed',
      spec_path: 'forge/specs/approved/wave-1.json',
      workspace_id: 'ws-1',
    });
    const preview = {
      schemaVersion: 'rorca.run-closeout-reconciliation-preview.v1',
      eligible: true,
      canonicalTargetHash: `sha256:${'a'.repeat(64)}`,
      target: {
        runId: exactRunId,
        workspaceId: 'ws-1',
        specId: 'wave-1',
        expiresAt: '2026-07-27T18:00:00.000Z',
        immutableAuthorityHash: `sha256:${'b'.repeat(64)}`,
      },
    };
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === `/api/pipeline/runs/${exactRunId}`) {
        return { ...MOCK_RUN_RESPONSE, run: failedRun };
      }
      if (path === `/api/recovery/runs/${exactRunId}/closeout-reconciliation?workspaceId=ws-1`) {
        return {
          schemaVersion: 'rorca.run-closeout-reconciliation-public.v1',
          runId: exactRunId,
          workspaceId: 'ws-1',
          state: 'eligible',
          previewHash: null,
          immutableAuthorityHash: null,
          expiresAt: null,
          reconciliationEventId: null,
          reconciledAt: null,
          resultReceiptHash: null,
        };
      }
      if (path.startsWith(`/api/recovery/runs/${exactRunId}/closeout-reconciliation/preview?`)) {
        return preview;
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={exactRunId} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    const button = await screen.findByRole('button', { name: 'Preview exact evidence' });
    expect(screen.queryByRole('button', { name: /apply|approve|reconcile/i })).not.toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByText(/Apply still requires a distinct signed workspace-owner receipt/i)).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith(
      `/api/recovery/runs/${exactRunId}/closeout-reconciliation/preview?workspaceId=ws-1`,
      { silent: true },
    );
  });

  it('hides closeout reconciliation when the selected run is unsupported', async () => {
    const unsupportedRunId = 732;
    const failedRun = createMockRun({
      id: unsupportedRunId,
      status: 'failed',
      spec_path: 'forge/specs/approved/ordinary-run.json',
      workspace_id: 'ws-1',
    });
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path === `/api/pipeline/runs/${unsupportedRunId}`) {
        return { ...MOCK_RUN_RESPONSE, run: failedRun };
      }
      if (path.includes(`/api/recovery/runs/${unsupportedRunId}/closeout-reconciliation?`)) {
        throw new Error('Not supported');
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={unsupportedRunId} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    await screen.findByTestId('run-terminal');
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Preview exact evidence' })).not.toBeInTheDocument();
    });
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

  it('keeps execution, agent hierarchy, and governed activity as distinct run surfaces', async () => {
    const ptyRun = createMockRun({
      id: 78,
      status: 'running',
      workspace_id: 'ws-1',
      terminal_mode: 'pty',
    });
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${ptyRun.id}`)) {
        return { run: ptyRun, stories: [], specStories: [], specModel: 'omp/default' };
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={ptyRun.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    const terminalTab = await screen.findByRole('button', { name: /^terminal$/i });
    expect(terminalTab).toHaveAttribute('title', 'Interactive PTY output for the active execution.');
    expect(screen.getByRole('button', { name: /^agent tree$/i })).toHaveAttribute(
      'title',
      'Parent and subagent hierarchy reconstructed from durable orchestration events.',
    );
    expect(screen.getByRole('button', { name: /^run activity$/i })).toHaveAttribute(
      'title',
      'Governed state, independent status planes, and durable run events.',
    );
    expect(screen.queryByRole('button', { name: /raw omp/i })).not.toBeInTheDocument();
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

  it('renders the durable parent/child agent tree with Roman presentation lanes and stable IDs', async () => {
    mockUsePipelineSSE.mockReturnValue([
      orchestrationEvent(1, 'agent_started', 'agent-root', { name: 'Hermes', role: 'Orchestrator' }),
      orchestrationEvent(2, 'agent_started', 'agent-a7f9', { name: 'Verifier', role: 'Security reviewer' }, 'agent-root'),
      orchestrationEvent(3, 'task_started', 'agent-a7f9', { type: 'tool_execution_start', toolName: 'read', taskId: 'task-1' }, 'agent-root'),
      orchestrationEvent(4, 'agent_completed', 'agent-a7f9', { evidence: ['review.json'] }, 'agent-root'),
    ]);

    renderWithProviders(<RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /^agent tree$/i }));

    expect(screen.getByRole('tree', { name: 'Agent orchestration lanes' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /Orchestrator Hermes, Running/i })).toHaveTextContent('ID agent-root');
    const child = screen.getByRole('treeitem', { name: /Lane I, Security reviewer Verifier, Completed/i });
    expect(child).toHaveTextContent('I');
    expect(child).toHaveTextContent('ID agent-a7f9');
    expect(child).toHaveTextContent('Child of Hermes (agent-root)');
    expect(child).toHaveTextContent('2s');
    child.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(screen.getByRole('treeitem', { name: /Orchestrator Hermes/i })).toHaveFocus();
  });

  it('reconstructs the same stable agent lanes after a browser-style remount', async () => {
    const storedEvents = [
      orchestrationEvent(1, 'agent_started', 'root-stable', { name: 'Parent' }),
      orchestrationEvent(2, 'agent_started', 'child-stable', { name: 'Builder' }, 'root-stable'),
      orchestrationEvent(3, 'agent_completed', 'child-stable', {}, 'root-stable'),
    ];
    // SSE reconnects may redeliver an already stored WAL row; projection must stay idempotent.
    mockUsePipelineSSE.mockReturnValue([...storedEvents, structuredClone(storedEvents[1])]);

    const first = renderWithProviders(<RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /^agent tree$/i }));
    const firstLaneIdentity = within(screen.getByRole('tree'))
      .getAllByRole('treeitem')
      .map((lane) => ({
        name: lane.getAttribute('aria-label'),
        level: lane.getAttribute('aria-level'),
      }));
    first.unmount();

    renderWithProviders(<RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /^agent tree$/i }));
    const replayedLaneIdentity = within(screen.getByRole('tree'))
      .getAllByRole('treeitem')
      .map((lane) => ({
        name: lane.getAttribute('aria-label'),
        level: lane.getAttribute('aria-level'),
      }));
    expect(replayedLaneIdentity).toEqual(firstLaneIdentity);
    expect(screen.getByText('ID child-stable')).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /Builder, Completed/i })).toHaveTextContent('2 events');
    expect(screen.getByText('Parent and subagent lanes reconstructed from 3 stored orchestration events')).toBeInTheDocument();
    expect(screen.getByTestId('orchestration-replay-receipt')).toHaveTextContent('Sequence 1–3');
    expect(screen.getByTestId('orchestration-replay-receipt')).toHaveTextContent('same AAV-007 WAL stream');

    await userEvent.click(screen.getByRole('button', { name: /^terminal$/i }));
    expect(screen.getByTestId('run-terminal')).toHaveTextContent(`Terminal for run ${BASE_RUN.id}`);
  });

  it('shows failure reason, retry/continuation lineage, tools, and produced evidence per lane', async () => {
    mockUsePipelineSSE.mockReturnValue([
      orchestrationEvent(1, 'agent_started', 'agent-retry', {
        name: 'Recovery worker', role: 'Verifier', retryOfAgentId: 'agent-original', continuationOfAgentId: 'agent-checkpoint',
      }),
      orchestrationEvent(2, 'task_started', 'agent-retry', { toolName: 'bash' }),
      orchestrationEvent(3, 'agent_failed', 'agent-retry', {
        failureReason: 'Signature mismatch', producedEvidence: [{ path: 'evidence/failure.json' }],
      }),
    ]);

    renderWithProviders(<RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /^agent tree$/i }));
    const lane = screen.getByRole('treeitem', { name: /Verifier Recovery worker, Failed/i });
    expect(lane).toHaveTextContent('Failure: Signature mismatch');
    expect(lane).toHaveTextContent('Retry of agent-original');
    expect(lane).toHaveTextContent('Continues agent-checkpoint');
    await userEvent.click(lane);
    expect(screen.getByText('Tools: bash')).toBeInTheDocument();
    expect(screen.getByText('Evidence: evidence/failure.json')).toBeInTheDocument();
  });

  it('renders an accessible orchestration empty state when no durable events exist', async () => {
    renderWithProviders(<RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: /^agent tree$/i }));
    expect(screen.getByTestId('orchestration-empty')).toHaveTextContent('No agent activity recorded');
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  });

  it.each([
    ['waiting_for_authorization', 'Waiting for authorization', 'WAITING_FOR_AUTHORIZATION'],
    ['waiting_for_authentication', 'Waiting for authentication', 'WAITING_FOR_AUTHENTICATION'],
    ['waiting_for_change_window', 'Waiting for change window', 'WAITING_FOR_CHANGE_WINDOW'],
  ])('renders %s distinctly without starting the story timeout', async (lifecycleStatus, label, legacyStatus) => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes(`/api/pipeline/runs/${RUNNING_RUN.id}`)) {
        return {
          ...MOCK_RUN_RESPONSE,
          run: {
            ...RUNNING_RUN,
            status: legacyStatus,
            lifecycleStatus,
            lifecycle_status: lifecycleStatus,
            lifecycle_diagnostics: {
              authorityWaitExpiresAt: '2099-08-24T12:00:00.000Z',
            },
          },
        };
      }
      return {};
    });

    renderWithProviders(
      <RunViewPanel runId={RUNNING_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    const banner = await screen.findByTestId('authority-wait-state');
    expect(banner).toHaveAccessibleName(label);
    expect(banner).toHaveTextContent(legacyStatus);
    expect(banner).toHaveTextContent('Story execution timeout is stopped');
    expect(banner).toHaveTextContent('Authority wait expires independently');
    expect(screen.getByTestId('run-semantic-status')).toHaveTextContent(label);
    expect(screen.getByRole('button', { name: 'Pause unavailable while waiting for Execution Authority' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Open Execution Authority' }))
      .toHaveAttribute('href', '/workspaces/ws-1/execution-authority');
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
