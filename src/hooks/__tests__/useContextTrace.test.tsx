/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CTM-002 — frontend hook coverage: metadata streaming, duplicate-delivery
 * de-duplication, bounded memory, and lazy raw payload resolution.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { WalEvent } from '../useWalSSE';

// Capture the callback the hook registers with the shared SSE singleton so the
// test can drive WAL events synchronously.
let registeredCallback: ((event: WalEvent) => void) | null = null;
vi.mock('../useWalSSE', () => ({
  useWalSSE: (cb: (event: WalEvent) => void) => {
    registeredCallback = cb;
  },
}));

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
}));

import { useContextTrace, CONTEXT_TRACE_WAL_EVENT_TYPE } from '../useContextTrace';
import { apiFetch } from '../../lib/apiFetch';

const mockApiFetch = vi.mocked(apiFetch);

let walId = 1;
function makeTraceWalEvent(runId: number, seq: number, overrides: Record<string, unknown> = {}): WalEvent {
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

describe('useContextTrace', () => {
  it('streams metadata events scoped to the run', () => {
    const { result } = renderHook(() => useContextTrace('42'));

    push(makeTraceWalEvent(42, 0));
    push(makeTraceWalEvent(42, 1));

    expect(result.current.events).toHaveLength(2);
    expect(result.current.events.map((e) => e.rawRef)).toEqual(['r42:0', 'r42:1']);
  });

  it('ignores events from other runs and non-trace event types', () => {
    const { result } = renderHook(() => useContextTrace('42'));

    push(makeTraceWalEvent(99, 0)); // different run
    const wrongType = makeTraceWalEvent(42, 0);
    wrongType.event_type = 'story_started';
    push(wrongType);

    expect(result.current.events).toHaveLength(0);
  });

  it('de-duplicates duplicate SSE deliveries by rawRef', () => {
    const { result } = renderHook(() => useContextTrace('42'));

    const e = makeTraceWalEvent(42, 0);
    push(e);
    push(e); // identical re-delivery
    push(makeTraceWalEvent(42, 0)); // same rawRef, different wal id

    expect(result.current.events).toHaveLength(1);
  });

  it('drops malformed payloads without throwing', () => {
    const { result } = renderHook(() => useContextTrace('42'));

    push({ ...makeTraceWalEvent(42, 0), payload: '{ not json' });
    const partial = makeTraceWalEvent(42, 1);
    partial.payload = JSON.stringify({ run_id: 42, phase: 'prompt' }); // missing rawRef/seq
    push(partial);

    expect(result.current.events).toHaveLength(0);
  });

  it('bounds memory to maxEvents (oldest dropped)', () => {
    const { result } = renderHook(() => useContextTrace('42', { maxEvents: 3 }));

    for (let i = 0; i < 6; i++) push(makeTraceWalEvent(42, i));

    expect(result.current.events).toHaveLength(3);
    expect(result.current.events.map((e) => e.rawRef)).toEqual(['r42:3', 'r42:4', 'r42:5']);
  });

  it('resolves raw payload lazily and caches it', async () => {
    const record = { rawRef: 'r42:0', runId: 42, seq: 0, phase: 'prompt', ts: '', payload: { big: 'blob' } };
    // The hook fires a backfill fetch on mount (context-inspector-events).
    // Only mock the raw trace endpoint for this test; let the backfill resolve harmlessly.
    mockApiFetch.mockImplementation(async (url: unknown) => {
      if (typeof url === 'string' && url.includes('/context-trace/')) return record;
      return { events: [] }; // backfill response
    });

    const { result } = renderHook(() => useContextTrace('42'));
    push(makeTraceWalEvent(42, 0));

    let resolved: unknown;
    await act(async () => {
      resolved = await result.current.resolveRaw('r42:0');
    });

    expect(resolved).toEqual(record);
    const rawCalls = mockApiFetch.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/context-trace/'),
    );
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0][0]).toBe('/api/pipeline/runs/42/context-trace/r42%3A0');

    // Second call should hit the cache, not the network.
    await act(async () => {
      await result.current.resolveRaw('r42:0');
    });
    const rawCallsAfter = mockApiFetch.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('/context-trace/'),
    );
    expect(rawCallsAfter).toHaveLength(1);
  });

  it('surfaces resolution errors through getRawState', async () => {
    mockApiFetch.mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useContextTrace('42'));
    push(makeTraceWalEvent(42, 0));

    await act(async () => {
      await expect(result.current.resolveRaw('r42:0')).rejects.toThrow('boom');
    });

    await waitFor(() => {
      expect(result.current.getRawState('r42:0').error).toBe('boom');
    });
  });

  it('resets when runId changes', () => {
    const { result, rerender } = renderHook(({ id }) => useContextTrace(id), {
      initialProps: { id: '42' },
    });
    push(makeTraceWalEvent(42, 0));
    expect(result.current.events).toHaveLength(1);

    rerender({ id: '43' });
    expect(result.current.events).toHaveLength(0);
  });
});
