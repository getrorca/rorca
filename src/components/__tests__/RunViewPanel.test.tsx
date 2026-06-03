/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CTM-003 — RunViewPanel ⇄ Context Inspector integration.
 *
 * Verifies the new "Context" tab mounts the ContextInspector surface, that it
 * coexists with the existing execution-trace / stories experience, and that the
 * inspector consumes the CTM-002 metadata stream (via the mocked useWalSSE
 * singleton) and performs a lazy raw fetch only on an explicit detail open.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithProviders, createMockWorkspace, createMockRun } from '../../test/helpers';
import type { WalEvent } from '../../hooks/useWalSSE';
import { CONTEXT_TRACE_WAL_EVENT_TYPE } from '../../hooks/useContextTrace';
import RunViewPanel from '../../panels/RunViewPanel';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

// RunViewPanel's own SSE source — kept empty here so run status is stable.
vi.mock('../../hooks/usePipelineSSE', () => ({
  usePipelineSSE: vi.fn(() => []),
}));

// Shared WAL singleton that ContextInspector → useContextTrace subscribes to.
let registeredCallback: ((event: WalEvent) => void) | null = null;
vi.mock('../../hooks/useWalSSE', () => ({
  useWalSSE: (cb: (event: WalEvent) => void) => {
    registeredCallback = cb;
  },
}));

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

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WORKSPACE = createMockWorkspace({ id: 'ws-1', label: 'Test Repo', path: '/tmp/test' });
const WORKSPACE_RESPONSE = { items: [WORKSPACE], total: 1, hasMore: false };

const BASE_RUN = createMockRun({
  id: 42,
  status: 'done',
  spec_path: 'forge/specs/approved/auth-feature.json',
  workspace_id: 'ws-1',
});

const RUN_RESPONSE = {
  run: BASE_RUN,
  stories: [
    { story_id: 'US-001', status: 'pass', elapsed_seconds: 45, started_at: new Date().toISOString(), finished_at: new Date().toISOString() },
  ],
  specStories: [{ id: 'US-001', title: 'Add Login Route', passes: false }],
  specModel: 'claude-sonnet-4-6',
  tokenSummary: { inputTokens: 2000, outputTokens: 800 },
};

let walId = 1;
function makeTraceWalEvent(seq: number, overrides: Record<string, unknown> = {}): WalEvent {
  const payload = {
    traceId: `trace:42:prompt`,
    runId: 42,
    run_id: 42,
    storyId: 'US-001',
    seq,
    rawRef: `r42:${seq}`,
    phase: 'prompt',
    status: 'ok',
    ts: new Date().toISOString(),
    label: `prompt:US-001`,
    ...overrides,
  };
  return {
    id: walId++,
    ts: new Date().toISOString(),
    event_type: CONTEXT_TRACE_WAL_EVENT_TYPE,
    workspace_id: 'ws-1',
    spec_id: null,
    story_id: 'US-001',
    actor: 'engine',
    payload: JSON.stringify(payload),
  };
}

function pushTrace(event: WalEvent) {
  act(() => {
    registeredCallback?.(event);
  });
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
  registeredCallback = null;
  walId = 1;
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');

  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
    if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`) && !path.includes('context-trace')) return RUN_RESPONSE;
    if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
    return {};
  });
});

async function renderAndOpenContextTab() {
  renderWithProviders(<RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />);

  await waitFor(() => {
    expect(document.querySelector('[data-testid="run-terminal"]')).toBeInTheDocument();
  }, { timeout: 3000 });

  const contextTab = screen.getByRole('button', { name: /^context$/i });
  fireEvent.click(contextTab);
}

describe('RunViewPanel — Context Inspector tab', () => {
  it('renders a Context tab alongside the existing tabs', async () => {
    renderWithProviders(<RunViewPanel runId={BASE_RUN.id} onBack={vi.fn()} onNavigate={vi.fn()} />);
    await waitFor(() => {
      expect(document.querySelector('[data-testid="run-terminal"]')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByRole('button', { name: /^context$/i })).toBeInTheDocument();
    // Existing experience still present.
    expect(screen.getByRole('button', { name: /stories/i })).toBeInTheDocument();
  });

  it('shows the empty inspector state when no traces have streamed (settled run)', async () => {
    await renderAndOpenContextTab();
    await waitFor(() => {
      expect(screen.getByTestId('context-inspector-empty')).toBeInTheDocument();
    });
    // Must not assert run success on the inspector empty surface.
    expect(screen.queryByText(/no context traces/i)).toBeInTheDocument();
  });

  it('renders the funnel + summary once metadata traces stream in', async () => {
    await renderAndOpenContextTab();

    pushTrace(makeTraceWalEvent(0, { phase: 'memory', label: 'retrieval:US-001', metrics: { fileCount: 3, durationMs: 90 } }));
    pushTrace(makeTraceWalEvent(1, { phase: 'prompt', label: 'prompt:US-001', metrics: { tokens: 5100 } }));

    await waitFor(() => {
      expect(screen.getByTestId('context-inspector')).toBeInTheDocument();
    });
    expect(screen.getByTestId('funnel-row-memory')).toBeInTheDocument();
    expect(screen.getByTestId('funnel-row-prompt')).toBeInTheDocument();
    expect(screen.getByText('5,100')).toBeInTheDocument();
  });

  it('performs a lazy raw fetch only when a trace detail is opened', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return WORKSPACE_RESPONSE;
      if (path.includes('context-trace')) {
        return {
          rawRef: 'r42:0',
          runId: 42,
          seq: 0,
          phase: 'prompt',
          ts: new Date().toISOString(),
          payload: { prompt: 'RAW PROMPT BODY' },
        };
      }
      if (path.includes(`/api/pipeline/runs/${BASE_RUN.id}`)) return RUN_RESPONSE;
      if (path.includes('/api/pipeline/runs')) return { items: [], total: 0, hasMore: false };
      return {};
    });

    await renderAndOpenContextTab();
    pushTrace(makeTraceWalEvent(0, { phase: 'prompt', label: 'prompt:US-001' }));

    await waitFor(() => {
      expect(screen.getByTestId('inspector-event-r42:0')).toBeInTheDocument();
    });

    // No context-trace fetch should have fired before the user opens a detail.
    expect(mockApiFetch).not.toHaveBeenCalledWith(expect.stringContaining('context-trace'));

    fireEvent.click(screen.getByTestId('inspector-event-r42:0'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('/context-trace/'));
    });
    await waitFor(() => {
      expect(screen.getByText(/RAW PROMPT BODY/i)).toBeInTheDocument();
    });
  });
});
