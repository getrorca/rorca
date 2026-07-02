/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CTM-002 — raw payload drawer: safe JSON truncation, fetch-on-open, and
 * loading / error / truncation rendering.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ContextTraceRawDrawer, { truncateJson, MAX_RAW_RENDER_CHARS } from '../ContextTraceRawDrawer';
import type { ContextTraceEvent } from '../../hooks/useContextTrace';

const baseEvent: ContextTraceEvent = {
  traceId: 'trace:42:prompt',
  runId: 42,
  storyId: 'US-001',
  seq: 0,
  rawRef: 'r42:0',
  phase: 'prompt',
  status: 'ok',
  ts: new Date('2026-06-03T12:00:00Z').toISOString(),
  label: 'prompt:US-001',
};

describe('truncateJson', () => {
  it('pretty-prints small payloads without truncation', () => {
    const out = truncateJson({ a: 1 });
    expect(out.truncated).toBe(false);
    expect(out.text).toContain('"a": 1');
  });

  it('truncates large payloads and reports totals', () => {
    const big = { blob: 'x'.repeat(MAX_RAW_RENDER_CHARS + 5000) };
    const out = truncateJson(big);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(MAX_RAW_RENDER_CHARS);
    expect(out.totalChars).toBeGreaterThan(MAX_RAW_RENDER_CHARS);
  });

  it('degrades gracefully on circular payloads', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = truncateJson(circular);
    expect(typeof out.text).toBe('string');
    expect(out.text.length).toBeGreaterThan(0);
  });

  it('respects a custom max', () => {
    const out = truncateJson({ s: 'abcdefghij' }, 5);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(5);
  });
});

describe('ContextTraceRawDrawer', () => {
  function renderDrawer(props: Partial<React.ComponentProps<typeof ContextTraceRawDrawer>> = {}) {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextTraceRawDrawer
        isOpen
        onClose={onClose}
        event={baseEvent}
        loading={false}
        error={null}
        record={null}
        onResolve={onResolve}
        {...props}
      />,
    );
    return { onResolve, onClose };
  }

  it('fetches on open when nothing is loaded', async () => {
    const { onResolve } = renderDrawer();
    await waitFor(() => expect(onResolve).toHaveBeenCalledWith('r42:0'));
  });

  it('does not fetch when already loading', () => {
    const { onResolve } = renderDrawer({ loading: true });
    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByText(/Loading raw payload/i)).toBeInTheDocument();
  });

  it('does not fetch when closed', () => {
    const onResolve = vi.fn();
    render(
      <ContextTraceRawDrawer
        isOpen={false}
        onClose={() => {}}
        event={baseEvent}
        loading={false}
        error={null}
        record={null}
        onResolve={onResolve}
      />,
    );
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('renders an error state', () => {
    renderDrawer({ error: 'corrupt artifact' });
    expect(screen.getByText(/Could not load raw payload/i)).toBeInTheDocument();
    expect(screen.getByText(/corrupt artifact/i)).toBeInTheDocument();
  });

  it('renders the resolved payload', () => {
    renderDrawer({
      record: { rawRef: 'r42:0', runId: 42, seq: 0, phase: 'prompt', ts: '', payload: { hello: 'world' } },
    });
    expect(screen.getByText(/"hello": "world"/)).toBeInTheDocument();
  });

  it('renders retrieval traces as synthesized context instead of raw JSON', () => {
    renderDrawer({
      event: { ...baseEvent, phase: 'memory', label: 'retrieval:US-001' },
      record: {
        rawRef: 'r42:0',
        runId: 42,
        seq: 0,
        phase: 'memory',
        ts: '',
        payload: {
          memorySection: '## Retrieved Memory Context\nUse these decisions as constraints.\n- Keep MCP-first behavior with safe fallbacks.\n- Validate focused tests before declaring success.',
          graphSection: 'Graph connected backend/src/routes/specs.ts to prior retrieval work.',
          selections: [{ candidateKey: 'memory:rorca::3797', candidateKind: 'memory', skillName: 'rorca-forge' }],
          meta: { candidateCount: 4, selectedCandidateKeys: ['memory:rorca::3797'], matchedSkills: ['rorca-forge'], tier: 'hybrid', latencyMs: 22, graphHits: 1 },
        },
      },
    });

    expect(screen.getByTestId('trace-retrieval-view')).toBeInTheDocument();
    expect(screen.getByText(/Retrieval synthesis/i)).toBeInTheDocument();
    expect(screen.getByText(/Selected evidence/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Keep MCP-first behavior/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Graph connected/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Memory 3797$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/"memorySection"/)).not.toBeInTheDocument();
  });

  it('explains selected evidence and graph misses without exposing memory ids as primary labels', () => {
    renderDrawer({
      event: { ...baseEvent, phase: 'memory', label: 'retrieval:US-002' },
      record: {
        rawRef: 'r42:0',
        runId: 42,
        seq: 0,
        phase: 'memory',
        ts: '',
        payload: {
          memorySection: '## Retrieved Memory Context\nUse these decisions as constraints.\n- Spec post-save processing should use stage fingerprints: enrichment should rerun only invalidated stages, not blindly rerun every edit.',
          graphSection: '',
          selections: [{ candidateKey: 'memory:rorca::3861', candidateKind: 'memory', score: 0.82 }],
          meta: { candidateCount: 2, selectedCandidateKeys: ['memory:rorca::3861'], tier: 'search', graphHits: 0 },
        },
      },
    });

    expect(screen.getByText(/Selected evidence/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Spec post-save processing should use stage fingerprints/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Graph was not used for this story/i)).toBeInTheDocument();
    expect(screen.getByText(/Retrieval source: Memory\/search/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Memory 3861$/i)).not.toBeInTheDocument();
  });

  it('renders arbiter traces as direction layer insight instead of raw JSON', () => {
    renderDrawer({
      event: { ...baseEvent, phase: 'context', label: 'arbiter:US-001' },
      record: {
        rawRef: 'r42:0',
        runId: 42,
        seq: 0,
        phase: 'context',
        ts: '',
        payload: {
          directionText: '=== GLOBAL STANDARDS (L1) ===\n- Prefer root-cause fixes.\n\n=== PROJECT CONTEXT (L3) ===\nproject:\n  name: Rorca',
        },
      },
    });

    expect(screen.getByTestId('trace-arbiter-view')).toBeInTheDocument();
    expect(screen.getByText(/Arbiter synthesis/i)).toBeInTheDocument();
    expect(screen.getAllByText(/GLOBAL STANDARDS/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Prefer root-cause fixes/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/"directionText"/)).not.toBeInTheDocument();
  });

  it('renders prompt traces as assembled prompt insight instead of raw JSON', () => {
    renderDrawer({
      event: { ...baseEvent, phase: 'prompt', label: 'prompt:US-001' },
      record: {
        rawRef: 'r42:0',
        runId: 42,
        seq: 0,
        phase: 'prompt',
        ts: '',
        payload: {
          prompt: 'You are implementing a story.\n\n## Story\nBuild the login form.\n\n## Retrieved Memory\nKeep MCP-first behavior with safe fallbacks.',
          agentType: 'pi',
          mode: 'execute',
        },
      },
    });

    expect(screen.getByTestId('trace-prompt-view')).toBeInTheDocument();
    expect(screen.getByText(/Prompt assembly/i)).toBeInTheDocument();
    expect(screen.getByText(/Final prompt/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Build the login form/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/"prompt"/)).not.toBeInTheDocument();
  });

  it('shows a truncation notice for oversized payloads', () => {
    renderDrawer({
      record: {
        rawRef: 'r42:0',
        runId: 42,
        seq: 0,
        phase: 'prompt',
        ts: '',
        payload: { blob: 'y'.repeat(MAX_RAW_RENDER_CHARS + 1000) },
      },
    });
    expect(screen.getByText(/Payload truncated for display/i)).toBeInTheDocument();
  });
});
