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

    // No raw fetch should have happened before the user opens a detail view.
    expect(mockApiFetch).not.toHaveBeenCalled();

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
