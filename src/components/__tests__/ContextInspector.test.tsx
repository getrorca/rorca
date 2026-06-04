/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CTM-003 — ContextInspector surface coverage.
 *
 * Drives the CTM-002 metadata stream through the real useContextTrace hook by
 * mocking the shared SSE singleton (useWalSSE), so the inspector is exercised
 * end-to-end: summary header, retrieval funnel, mixed keep/drop, duplicate
 * delivery stability, and lazy raw fetch (success + failure) via apiFetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { WalEvent } from '../../hooks/useWalSSE';
import { CONTEXT_TRACE_WAL_EVENT_TYPE } from '../../hooks/useContextTrace';

// Capture the SSE callback so the test can push WAL events synchronously.
let registeredCallback: ((event: WalEvent) => void) | null = null;
vi.mock('../../hooks/useWalSSE', () => ({
  useWalSSE: (cb: (event: WalEvent) => void) => {
    registeredCallback = cb;
  },
}));

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
}));

import ContextInspector from '../ContextInspector';
import { apiFetch } from '../../lib/apiFetch';

const mockApiFetch = vi.mocked(apiFetch);

let walId = 1;

function makeTraceWalEvent(
  runId: number,
  seq: number,
  overrides: Partial<Record<string, unknown>> = {},
): WalEvent {
  const payload = {
    traceId: `trace:${runId}:prompt`,
    runId,
    run_id: runId,
    storyId: 'US-001',
    seq,
    rawRef: `r${runId}:${seq}`,
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

function push(event: WalEvent) {
  act(() => {
    registeredCallback?.(event);
  });
}

beforeEach(() => {
  registeredCallback = null;
  walId = 1;
  mockApiFetch.mockReset();
});

describe('ContextInspector — empty / loading states', () => {
  it('shows a settled empty state when no traces and run is settled', () => {
    render(<ContextInspector runId={42} runSettled />);
    expect(screen.getByTestId('context-inspector-empty')).toBeInTheDocument();
    expect(screen.getByText(/no context traces/i)).toBeInTheDocument();
  });

  it('shows a waiting/loading affordance for an unsettled run with no traces', () => {
    render(<ContextInspector runId={42} runSettled={false} />);
    expect(screen.getByText(/waiting for context traces/i)).toBeInTheDocument();
  });

  it('does not mislabel the inspector as a passed run', () => {
    render(<ContextInspector runId={42} runSettled />);
    // The empty surface must never assert run success.
    expect(screen.queryByText(/passed/i)).not.toBeInTheDocument();
  });
});

describe('ContextInspector — summary + funnel', () => {
  it('renders summary header and funnel from metadata events', () => {
    render(<ContextInspector runId={42} runSettled />);

    push(makeTraceWalEvent(42, 0, {
      phase: 'memory',
      label: 'retrieval:US-001',
      metrics: { fileCount: 3, durationMs: 120 },
    }));
    push(makeTraceWalEvent(42, 1, {
      phase: 'prompt',
      label: 'prompt:US-001',
      metrics: { tokens: 4200, bytes: 16800 },
    }));

    expect(screen.getByTestId('context-inspector')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-funnel')).toBeInTheDocument();
    // Funnel rows for both phases present.
    expect(screen.getByTestId('funnel-row-memory')).toBeInTheDocument();
    expect(screen.getByTestId('funnel-row-prompt')).toBeInTheDocument();
    // Prompt-token metric surfaced in summary header.
    expect(screen.getByText(/prompt tokens/i)).toBeInTheDocument();
    expect(screen.getByText('4,200')).toBeInTheDocument();
  });
});

describe('ContextInspector — mixed keep/drop reasoning', () => {
  it('counts errored traces as dropped and shows kept-vs-dropped', () => {
    render(<ContextInspector runId={42} runSettled />);

    push(makeTraceWalEvent(42, 0, { phase: 'memory', status: 'ok', metrics: { fileCount: 2 } }));
    push(makeTraceWalEvent(42, 1, { phase: 'memory', status: 'error', label: 'retrieval failed' }));
    push(makeTraceWalEvent(42, 2, { phase: 'prompt', status: 'ok' }));

    // Health pill reflects a dropped (errored) trace, not run pass/fail.
    const healthPill = screen.getByTestId('inspector-health-partial');
    expect(healthPill).toBeInTheDocument();
    expect(healthPill.textContent).toMatch(/1 dropped/i);

    // Memory funnel row shows kept (1) of candidates (2) with a dropped note.
    const memoryRow = screen.getByTestId('funnel-row-memory');
    expect(memoryRow.textContent).toMatch(/dropped/i);
  });

  it('shows an all-kept health pill when no traces errored', () => {
    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, { phase: 'memory', status: 'ok' }));
    push(makeTraceWalEvent(42, 1, { phase: 'prompt', status: 'ok' }));
    expect(screen.getByTestId('inspector-health-ok')).toBeInTheDocument();
  });
});

describe('ContextInspector — duplicate deliveries & ordering', () => {
  it('de-duplicates identical rawRef deliveries (no flicker/reorder)', () => {
    render(<ContextInspector runId={42} runSettled />);

    push(makeTraceWalEvent(42, 0, { phase: 'memory' }));
    push(makeTraceWalEvent(42, 1, { phase: 'prompt' }));
    // Duplicate delivery of seq 0 — must be dropped.
    push(makeTraceWalEvent(42, 0, { phase: 'memory' }));

    const list = screen.getByTestId('inspector-events');
    // Exactly two unique rows: r42:0 and r42:1.
    expect(list.querySelectorAll('[data-testid^="inspector-event-"]').length).toBe(2);
    expect(screen.getByTestId('inspector-event-r42:0')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-event-r42:1')).toBeInTheDocument();
  });

  it('orders events by seq even when delivered out of order', () => {
    render(<ContextInspector runId={42} runSettled />);

    // Deliver seq 2 before seq 0 — list must render in seq order.
    push(makeTraceWalEvent(42, 2, { phase: 'prompt' }));
    push(makeTraceWalEvent(42, 0, { phase: 'memory' }));
    push(makeTraceWalEvent(42, 1, { phase: 'skill' }));

    const rows = Array.from(
      screen.getByTestId('inspector-events').querySelectorAll('[data-testid^="inspector-event-"]'),
    ).map((el) => el.getAttribute('data-testid'));

    expect(rows).toEqual([
      'inspector-event-r42:0',
      'inspector-event-r42:1',
      'inspector-event-r42:2',
    ]);
  });
});

describe('ContextInspector — lazy raw fetch', () => {
  it('fetches the raw payload only when a detail row is opened', async () => {
    mockApiFetch.mockResolvedValue({
      rawRef: 'r42:0',
      runId: 42,
      seq: 0,
      phase: 'prompt',
      ts: new Date().toISOString(),
      payload: { prompt: 'HELLO RAW PAYLOAD' },
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, { phase: 'prompt', label: 'prompt:US-001' }));

    // Metadata backfill may run on mount, but raw payload fetch must wait until
    // the user opens a detail view.
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/pipeline/runs/42/context-trace/'),
    );

    fireEvent.click(screen.getByTestId('inspector-event-r42:0'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/pipeline/runs/42/context-trace/'),
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/HELLO RAW PAYLOAD/i)).toBeInTheDocument();
    });
  });

  it('surfaces an error state when the lazy raw fetch fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('artifact not found'));

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, { phase: 'prompt' }));

    fireEvent.click(screen.getByTestId('inspector-event-r42:0'));

    await waitFor(() => {
      expect(screen.getByText(/could not load raw payload/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/artifact not found/i)).toBeInTheDocument();
  });
});

describe('ContextInspector — retrieval telemetry lazy fetch', () => {
  const telemetryDetail = {
    telemetryId: 'rt-abc',
    runId: 42,
    storyId: 'US-001',
    query: 'test query',
    selectedCandidates: [
      {
        key: 'file-a.ts',
        origin: 'codebase',
        selected: true,
        relevanceScore: 0.95,
        scoreBreakdown: { semantic: 0.9, graph: 0.05 },
        keptOrDroppedReason: 'Selected',
      },
    ],
    droppedCandidates: [],
    candidateCount: 1,
    selectedCount: 1,
    matchedSkills: ['code-search'],
    retrievalTier: 'search',
    latencyMs: 120,
    needsMoreEvidence: false,
    tokenBudget: 8000,
    contradictions: [],
    rawSummary: '1/1 candidates selected, tier: search, latency: 120ms',
  };

  it('does not fetch retrieval telemetry before the row is opened', () => {
    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, {
      phase: 'memory',
      label: 'retrieval:US-001',
      retrievalTelemetryId: 'rt-abc',
    }));

    // No call to the retrieval-telemetry endpoint yet.
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/retrieval-telemetry/'),
    );
  });

  it('fetches retrieval telemetry on row open (not raw trace endpoint)', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/')) {
        return telemetryDetail;
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, {
      phase: 'memory',
      label: 'retrieval:US-001',
      retrievalTelemetryId: 'rt-abc',
    }));

    // Click the event row — should open retrieval detail drawer, not raw drawer.
    fireEvent.click(screen.getByTestId('inspector-event-r42:0'));

    // Should call retrieval-telemetry endpoint.
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/retrieval-telemetry/rt-abc'),
      );
    });

    // Should NOT call the raw context-trace endpoint.
    const rawCalls = mockApiFetch.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('/context-trace/r42'),
    );
    expect(rawCalls.length).toBe(0);
  });

  it('opens retrieval detail (not raw drawer) for synthetic retrieval events', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-abc')) {
        return telemetryDetail;
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, {
      phase: 'memory',
      label: 'retrieval:US-001',
      synthetic: true,
      retrievalTelemetryId: 'rt-abc',
    }));

    // Synthetic rows with retrievalTelemetryId ARE clickable — they open the retrieval drawer.
    fireEvent.click(screen.getByTestId('inspector-event-r42:0'));

    // Should NOT call the raw context-trace endpoint.
    await waitFor(() => {
      expect(mockApiFetch).not.toHaveBeenCalledWith(
        expect.stringContaining('/context-trace/r42'),
      );
    });

    // Should call the retrieval-telemetry endpoint.
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/retrieval-telemetry/rt-abc'),
      );
    });
  });
});

describe('ContextInspector — retrieval detail drawer', () => {
  const fullDetail = {
    telemetryId: 'rt-full',
    runId: 42,
    storyId: 'US-001',
    query: 'find auth middleware',
    selectedCandidates: [
      {
        key: 'src/auth.ts',
        origin: 'codebase',
        sourceType: 'file',
        title: 'Auth Middleware Module',
        snippet: 'export function authRequired(req, res, next) { ... }',
        category: 'Architecture',
        selected: true,
        enteredPrompt: true,
        relevanceScore: 0.92,
        scoreBreakdown: { semantic: 0.85, graph: 0.07 },
        matchedSkills: ['code-search'],
        keptOrDroppedReason: 'High relevance to query',
      },
    ],
    droppedCandidates: [
      {
        key: 'src/old-auth.ts',
        origin: 'codebase',
        sourceType: 'file',
        title: 'Legacy Auth',
        snippet: 'Deprecated authentication helper',
        category: 'Legacy',
        selected: false,
        enteredPrompt: false,
        relevanceScore: 0.25,
        scoreBreakdown: { semantic: 0.2, keyword: 0.05 },
        matchedSkills: [],
        keptOrDroppedReason: 'Below threshold',
      },
    ],
    candidateCount: 2,
    selectedCount: 1,
    matchedSkills: ['code-search', 'graph-traversal'],
    retrievalTier: 'search',
    latencyMs: 85,
    needsMoreEvidence: false,
    tokenBudget: 8000,
    contradictions: [],
    rawSummary: '1/2 candidates selected, tier: search, latency: 85ms',
  };

  it('opens retrieval detail drawer with all sections when clicking a reconstructed retrieval row', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-full')) {
        return fullDetail;
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, {
      phase: 'memory',
      label: 'retrieval:MOG-009',
      synthetic: true,
      retrievalTelemetryId: 'rt-full',
    }));

    fireEvent.click(screen.getByTestId('inspector-event-r42:0'));

    // Wait for the detail to load and render.
    await waitFor(() => {
      expect(screen.getByTestId('retrieval-detail-content')).toBeInTheDocument();
    });

    // Memory title and snippet rendered in the selected candidates section.
    expect(screen.getByText('Auth Middleware Module')).toBeInTheDocument();
    expect(screen.getByText(/export function authRequired/)).toBeInTheDocument();

    // Score displayed.
    expect(screen.getByText('92%')).toBeInTheDocument();

    // Matched skills section.
    expect(screen.getByTestId('retrieval-matched-skills')).toBeInTheDocument();
    expect(screen.getByText('code-search')).toBeInTheDocument();
    expect(screen.getByText('graph-traversal')).toBeInTheDocument();

    // Prompt inclusion displayed.
    expect(screen.getByText(/Prompt: Yes/)).toBeInTheDocument();

    // Selected and dropped sections present.
    expect(screen.getByTestId('retrieval-selected-section')).toBeInTheDocument();
    expect(screen.getByTestId('retrieval-dropped-section')).toBeInTheDocument();

    // Dropped candidate title.
    expect(screen.getByText('Legacy Auth')).toBeInTheDocument();

    // Tier and latency in summary.
    expect(screen.getByText('search')).toBeInTheDocument();
    expect(screen.getByText('85ms')).toBeInTheDocument();
  });

  it('shows loading state while retrieval telemetry is being fetched', async () => {
    let resolveDetail: ((v: any) => void) | undefined;
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-loading')) {
        return new Promise((resolve) => { resolveDetail = resolve; });
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, {
      phase: 'memory',
      label: 'retrieval:US-001',
      retrievalTelemetryId: 'rt-loading',
    }));

    fireEvent.click(screen.getByTestId('inspector-event-r42:0'));

    await waitFor(() => {
      expect(screen.getByTestId('retrieval-detail-loading')).toBeInTheDocument();
    });

    // Resolve to clean up.
    await act(async () => {
      resolveDetail!(fullDetail);
    });
  });

  it('shows error state when retrieval telemetry fetch fails', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-err')) {
        throw new Error('retrieval service unavailable');
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, {
      phase: 'memory',
      label: 'retrieval:US-001',
      retrievalTelemetryId: 'rt-err',
    }));

    fireEvent.click(screen.getByTestId('inspector-event-r42:0'));

    await waitFor(() => {
      expect(screen.getByTestId('retrieval-detail-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/retrieval service unavailable/)).toBeInTheDocument();
  });

  it('shows Unknown for prompt inclusion when enteredPrompt is not available', async () => {
    const detailWithUnknownPrompt = {
      ...fullDetail,
      telemetryId: 'rt-unk',
      selectedCandidates: [
        {
          ...fullDetail.selectedCandidates[0],
          enteredPrompt: undefined,
        },
      ],
    };

    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-unk')) {
        return detailWithUnknownPrompt;
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, {
      phase: 'memory',
      label: 'retrieval:US-001',
      retrievalTelemetryId: 'rt-unk',
    }));

    fireEvent.click(screen.getByTestId('inspector-event-r42:0'));

    await waitFor(() => {
      expect(screen.getByTestId('retrieval-detail-content')).toBeInTheDocument();
    });

    expect(screen.getByText(/Prompt: Unknown/)).toBeInTheDocument();
  });
});

describe('useContextTrace — resolveRetrievalTelemetry hook API', () => {
  // Test the hook directly via renderHook.
  let renderHookFn: typeof import('@testing-library/react')['renderHook'];
  let useContextTraceHook: typeof import('../../hooks/useContextTrace')['useContextTrace'];

  beforeAll(async () => {
    const rtl = await import('@testing-library/react');
    renderHookFn = rtl.renderHook;
    const mod = await import('../../hooks/useContextTrace');
    useContextTraceHook = mod.useContextTrace;
  });

  const telemetryDetail = {
    telemetryId: 'rt-xyz',
    runId: 99,
    storyId: 'US-002',
    query: 'hook test query',
    selectedCandidates: [],
    droppedCandidates: [],
    candidateCount: 0,
    selectedCount: 0,
    matchedSkills: [],
    retrievalTier: null,
    latencyMs: null,
    needsMoreEvidence: false,
    tokenBudget: 4000,
    contradictions: [],
    rawSummary: '0/0 candidates selected, tier: unknown',
  };

  it('resolves retrieval telemetry lazily with cache and dedup', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-xyz')) {
        return telemetryDetail;
      }
      return { events: [] };
    });

    const { result } = renderHookFn(() => useContextTraceHook('99'));

    // Before calling resolve, state should be idle.
    expect(result.current.getRetrievalTelemetryState('rt-xyz')).toEqual({
      loading: false,
      detail: null,
      error: null,
    });

    // First resolve — triggers fetch.
    let detail: any;
    await act(async () => {
      detail = await result.current.resolveRetrievalTelemetry('rt-xyz');
    });
    expect(detail.telemetryId).toBe('rt-xyz');

    const telemetryCalls = mockApiFetch.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('/retrieval-telemetry/rt-xyz'),
    );
    expect(telemetryCalls.length).toBe(1);

    // Cached state should be populated.
    expect(result.current.getRetrievalTelemetryState('rt-xyz')).toEqual({
      loading: false,
      detail: telemetryDetail,
      error: null,
    });

    // Second resolve — returns cached, no extra fetch.
    await act(async () => {
      detail = await result.current.resolveRetrievalTelemetry('rt-xyz');
    });
    expect(detail.telemetryId).toBe('rt-xyz');

    const telemetryCallsAfter = mockApiFetch.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('/retrieval-telemetry/rt-xyz'),
    );
    expect(telemetryCallsAfter.length).toBe(1); // still 1 — cache reuse
  });

  it('surfaces error state when retrieval telemetry fetch fails', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-fail')) {
        throw new Error('telemetry not found');
      }
      return { events: [] };
    });

    const { result } = renderHookFn(() => useContextTraceHook('99'));

    await act(async () => {
      try {
        await result.current.resolveRetrievalTelemetry('rt-fail');
      } catch {
        // expected
      }
    });

    expect(result.current.getRetrievalTelemetryState('rt-fail')).toEqual({
      loading: false,
      detail: null,
      error: 'telemetry not found',
    });
  });

  it('de-duplicates concurrent requests for the same telemetryId', async () => {
    let resolvePromise: ((v: any) => void) | undefined;
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-dedup')) {
        return new Promise((resolve) => { resolvePromise = resolve; });
      }
      return { events: [] };
    });

    const { result } = renderHookFn(() => useContextTraceHook('99'));

    let p1: Promise<any>;
    let p2: Promise<any>;
    act(() => {
      p1 = result.current.resolveRetrievalTelemetry('rt-dedup');
      p2 = result.current.resolveRetrievalTelemetry('rt-dedup');
    });

    // Only one fetch call should have been made.
    const dedupCalls = mockApiFetch.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('/retrieval-telemetry/rt-dedup'),
    );
    expect(dedupCalls.length).toBe(1);

    // Resolve the single in-flight request.
    await act(async () => {
      resolvePromise!(telemetryDetail);
      await p1!;
      await p2!;
    });
  });
});

describe('ContextInspector — structured retrievalTelemetryId on reconstructed events', () => {
  const telemetryDetail = {
    telemetryId: 'rt-structured',
    runId: 42,
    storyId: 'US-001',
    query: 'structured test query',
    selectedCandidates: [],
    droppedCandidates: [],
    candidateCount: 0,
    selectedCount: 0,
    matchedSkills: [],
    retrievalTier: 'search',
    latencyMs: 50,
    needsMoreEvidence: false,
    tokenBudget: 4000,
    contradictions: [],
    rawSummary: '0/0 candidates selected',
  };

  it('uses structured retrievalTelemetryId from backfill response to enable click path', async () => {
    // Simulate backfill returning a reconstructed event WITH the structured field.
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/context-inspector-events')) {
        return {
          events: [{
            traceId: 'reconstructed:42:memory',
            runId: 42,
            storyId: 'US-001',
            seq: 0,
            rawRef: 'synthetic:42:0',
            phase: 'memory',
            status: 'ok',
            ts: new Date().toISOString(),
            label: 'retrieval:US-001',
            synthetic: true,
            details: ['telemetry: rt-structured', 'selected: 3'],
            retrievalTelemetryId: 'rt-structured',
          }],
          reconstructed: true,
        };
      }
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-structured')) {
        return telemetryDetail;
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);

    // Wait for backfill to populate the event list.
    await waitFor(() => {
      expect(screen.getByTestId('inspector-event-synthetic:42:0')).toBeInTheDocument();
    });

    // Click should open retrieval detail drawer (not raw drawer).
    fireEvent.click(screen.getByTestId('inspector-event-synthetic:42:0'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/retrieval-telemetry/rt-structured'),
      );
    });
  });

  it('falls back to parsing retrievalTelemetryId from details strings when structured field is absent', async () => {
    // Simulate backfill returning an older event WITHOUT the structured field,
    // but with telemetry ID embedded in details.
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/context-inspector-events')) {
        return {
          events: [{
            traceId: 'reconstructed:42:memory',
            runId: 42,
            storyId: 'US-001',
            seq: 0,
            rawRef: 'synthetic:42:0',
            phase: 'memory',
            status: 'ok',
            ts: new Date().toISOString(),
            label: 'retrieval:US-001',
            synthetic: true,
            details: ['telemetry: rt-fallback', 'selected: 2'],
            // NO retrievalTelemetryId field — should be parsed from details.
          }],
          reconstructed: true,
        };
      }
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-fallback')) {
        return { ...telemetryDetail, telemetryId: 'rt-fallback' };
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);

    // Wait for backfill to populate the event list.
    await waitFor(() => {
      expect(screen.getByTestId('inspector-event-synthetic:42:0')).toBeInTheDocument();
    });

    // Click should open retrieval detail drawer via fallback-parsed ID.
    fireEvent.click(screen.getByTestId('inspector-event-synthetic:42:0'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/retrieval-telemetry/rt-fallback'),
      );
    });
  });

  it('does not extract retrievalTelemetryId when details contain no telemetry entry', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/context-inspector-events')) {
        return {
          events: [{
            traceId: 'reconstructed:42:memory',
            runId: 42,
            storyId: 'US-001',
            seq: 0,
            rawRef: 'synthetic:42:0',
            phase: 'memory',
            status: 'ok',
            ts: new Date().toISOString(),
            label: 'retrieval:US-001',
            synthetic: true,
            details: ['selected: 2', 'needs more evidence'],
            // No retrievalTelemetryId and no telemetry entry in details.
          }],
          reconstructed: true,
        };
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);

    await waitFor(() => {
      expect(screen.getByTestId('inspector-event-synthetic:42:0')).toBeInTheDocument();
    });

    // Synthetic row without retrieval ID should NOT be clickable (no chevron path).
    fireEvent.click(screen.getByTestId('inspector-event-synthetic:42:0'));

    // Should NOT call the retrieval-telemetry endpoint.
    const retrievalCalls = mockApiFetch.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('/retrieval-telemetry/'),
    );
    expect(retrievalCalls.length).toBe(0);
  });
});

// ─── SMG-003: Relevance Graph view in Context Inspector ─────────────────────

describe('ContextInspector — Relevance Graph view', () => {
  const graphResponse = {
    available: true,
    hub: { id: 'hub-1', type: 'hub', ring: 0, label: 'Run 42', entityId: 'run:42' },
    nodes: [
      { id: 'hub-1', type: 'hub', ring: 0, label: 'Run 42', entityId: 'run:42' },
      { id: 'mem-1', type: 'memory', ring: 2, label: 'Auth module', entityId: 'mem:auth', sourceId: 'rt-graph', selected: true, enteredPrompt: true, relevanceScore: 0.92, scoreBreakdown: { semantic: 0.85, graph: 0.07, recency: null, skill: null, arbiter: null, keyword: null } },
      { id: 'file-1', type: 'file', ring: 1, label: 'src/auth.ts', entityId: 'file:auth', path: 'src/auth.ts' },
    ],
    edges: [
      { id: 'e1', source: 'hub-1', target: 'file-1', relation: 'routed_to', scoreContribution: null, evidence: null, visualHints: { thickness: 2, dashed: false, opacity: 1 } },
      { id: 'e2', source: 'hub-1', target: 'mem-1', relation: 'selected_memory', scoreContribution: 0.92, evidence: 'high relevance', visualHints: { thickness: 3, dashed: false, opacity: 1 } },
    ],
    scoreLegend: [{ field: 'semantic', label: 'Semantic', description: 'Embedding similarity' }],
    summary: { hubLabel: 'Run 42', nodeCount: 3, edgeCount: 2, selectedCount: 1, droppedCount: 0, avgRelevanceScore: 0.92 },
    caps: { maxFiles: 20, maxMemories: 30, maxEdges: 80 },
    truncation: { filesTruncated: false, memoriesTruncated: false, edgesTruncated: false, totalCandidates: 1, returnedCandidates: 1 },
    fallback: { ageAvailable: false, telemetryAvailable: true, graphPathsAvailable: false, missingReasons: [] },
  };

  const unavailableGraphResponse = {
    available: false,
    hub: null,
    nodes: [],
    edges: [],
    scoreLegend: [],
    summary: { hubLabel: '', nodeCount: 0, edgeCount: 0, selectedCount: 0, droppedCount: 0, avgRelevanceScore: null },
    caps: { maxFiles: 20, maxMemories: 30, maxEdges: 80 },
    truncation: { filesTruncated: false, memoriesTruncated: false, edgesTruncated: false, totalCandidates: 0, returnedCandidates: 0 },
    fallback: { ageAvailable: false, telemetryAvailable: false, graphPathsAvailable: false, missingReasons: ['No retrieval telemetry found'] },
  };

  it('does NOT fetch graph data before the graph tab is opened', () => {
    mockApiFetch.mockImplementation(async () => ({ events: [] }));

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, { phase: 'prompt' }));

    // Graph endpoint should NOT have been called.
    const graphCalls = mockApiFetch.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('/spec-relevance-graph/'),
    );
    expect(graphCalls.length).toBe(0);
  });

  it('fetches graph data when the graph tab is opened', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/spec-relevance-graph/')) {
        return graphResponse;
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, { phase: 'prompt' }));

    // Click the graph tab.
    fireEvent.click(screen.getByTestId('inspector-view-graph'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/spec-relevance-graph/by-run/42'),
      );
    });

    // Graph canvas should render.
    await waitFor(() => {
      expect(screen.getByTestId('graph-canvas')).toBeInTheDocument();
    });
  });

  it('reuses cached graph data when switching back and forth', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/spec-relevance-graph/')) {
        return graphResponse;
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, { phase: 'prompt' }));

    // Open graph tab.
    fireEvent.click(screen.getByTestId('inspector-view-graph'));

    await waitFor(() => {
      expect(screen.getByTestId('graph-canvas')).toBeInTheDocument();
    });

    const graphCallsAfterFirst = mockApiFetch.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('/spec-relevance-graph/'),
    ).length;

    // Switch back to list.
    fireEvent.click(screen.getByTestId('inspector-view-list'));
    expect(screen.getByTestId('inspector-events')).toBeInTheDocument();

    // Switch to graph again — should NOT re-fetch.
    fireEvent.click(screen.getByTestId('inspector-view-graph'));

    await waitFor(() => {
      expect(screen.getByTestId('graph-canvas')).toBeInTheDocument();
    });

    const graphCallsAfterSecond = mockApiFetch.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('/spec-relevance-graph/'),
    ).length;

    expect(graphCallsAfterSecond).toBe(graphCallsAfterFirst);
  });

  it('shows unavailable state with missing reasons when graph is unavailable', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/spec-relevance-graph/')) {
        return unavailableGraphResponse;
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, { phase: 'prompt' }));

    fireEvent.click(screen.getByTestId('inspector-view-graph'));

    await waitFor(() => {
      expect(screen.getByTestId('graph-unavailable')).toBeInTheDocument();
    });
    expect(screen.getByText(/semantic-only/i)).toBeInTheDocument();
    expect(screen.getByText(/No retrieval telemetry found/)).toBeInTheDocument();
  });

  it('shows error state when graph fetch fails', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/spec-relevance-graph/')) {
        throw new Error('graph service down');
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, { phase: 'prompt' }));

    fireEvent.click(screen.getByTestId('inspector-view-graph'));

    await waitFor(() => {
      expect(screen.getByTestId('graph-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/graph service down/)).toBeInTheDocument();
  });

  it('opens retrieval detail drawer when a memory node is clicked', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === 'string' && path.includes('/spec-relevance-graph/')) {
        return graphResponse;
      }
      if (typeof path === 'string' && path.includes('/retrieval-telemetry/rt-graph')) {
        return {
          telemetryId: 'rt-graph',
          runId: 42,
          storyId: 'US-001',
          query: 'auth',
          selectedCandidates: [],
          droppedCandidates: [],
          candidateCount: 0,
          selectedCount: 0,
          matchedSkills: [],
          retrievalTier: null,
          latencyMs: null,
          needsMoreEvidence: false,
          tokenBudget: 4000,
          contradictions: [],
          rawSummary: '',
        };
      }
      return { events: [] };
    });

    render(<ContextInspector runId={42} runSettled />);
    // Push a retrieval event whose telemetryId matches the node's sourceId.
    push(makeTraceWalEvent(42, 0, {
      phase: 'memory',
      label: 'retrieval:US-001',
      retrievalTelemetryId: 'rt-graph',
    }));

    fireEvent.click(screen.getByTestId('inspector-view-graph'));

    await waitFor(() => {
      expect(screen.getByTestId('graph-canvas')).toBeInTheDocument();
    });

    // Click the memory node.
    fireEvent.click(screen.getByTestId('graph-node-mem-1'));

    // Should trigger retrieval telemetry fetch.
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/retrieval-telemetry/rt-graph'),
      );
    });
  });

  it('still shows the list view tab with event list and funnel by default', () => {
    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, { phase: 'prompt' }));

    // Default view is list.
    expect(screen.getByTestId('inspector-funnel')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-events')).toBeInTheDocument();
  });

  it('renders the view toggle with both List and Graph buttons', () => {
    render(<ContextInspector runId={42} runSettled />);
    push(makeTraceWalEvent(42, 0, { phase: 'prompt' }));

    expect(screen.getByTestId('inspector-view-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-view-list')).toBeInTheDocument();
    expect(screen.getByTestId('inspector-view-graph')).toBeInTheDocument();
  });
});
