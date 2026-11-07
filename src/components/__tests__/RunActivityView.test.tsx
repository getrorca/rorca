/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../lib/apiFetch';
import RunActivityView from '../RunActivityView';

vi.mock('../../lib/apiFetch', () => ({ apiFetch: vi.fn() }));

const mockedApiFetch = vi.mocked(apiFetch);
const state = {
  state: 'live',
  projection: {
    runtimeGeneration: 9,
    lease: 'active',
    cancellation: 'requested',
    context: 'retrying',
    completionCandidate: 'controller_validated',
    retryBudget: { state: 'backoff', spent: 2, maximum: 5 },
    closeout: { decisionId: 'decision:one', status: 'blocked' as const, verified: true as const },
  },
  operationalPlanes: [
    { plane: 'runtime_health', status: 'healthy', reasonCode: 'runtime:ready', impact: 'none', nextSafeAction: 'observe',
      sourceClass: 'sandbox_resource_monitor', sourceIdentity: 'runtime:probe', sourceHash: 'sha256:runtime',
      observedAt: '2026-08-05T12:00:00.000Z', validUntil: '2026-08-05T12:05:00.000Z' },
    { plane: 'queue_outbox_freshness', status: 'degraded', reasonCode: 'queue:late', impact: 'delivery delayed', nextSafeAction: 'inspect queue',
      sourceClass: 'queue_outbox_monitor', sourceIdentity: 'queue:probe', sourceHash: 'sha256:queue',
      observedAt: '2026-08-05T11:59:00.000Z', validUntil: '2026-08-05T12:01:00.000Z' },
  ],
  planeCount: 7 as const,
  notices: ['Observability only'],
  authoritative: false as const,
  authorityEffect: 'none' as const,
};
const page = {
  status: 'ok' as const,
  resetReason: null,
  events: [{
    eventId: 'event:one', streamSequence: 1, observedAt: '2026-08-05T12:00:00.000Z',
    kind: 'pty_output_referenced', plane: 'terminal', payload: { reasonCode: 'pty:durable-range' },
    redaction: { class: 'restricted', ordinaryProjectionContainsRaw: false as const }, authorityEffect: 'none' as const,
  }],
  nextCursor: 'cursor:next',
  hasMore: false,
};

describe('RunActivityView', () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
    mockedApiFetch.mockImplementation(async (url) => url.includes('/state?') ? state : page);
  });

  it('shows governed state, independent status planes, and redacted durable activity without duplicating the terminal', async () => {
    render(<RunActivityView runId={42} workspaceId="workspace:one" refreshMs={60_000} />);

    expect(screen.queryByTestId('xterm-output')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('runtime health')).toBeInTheDocument());
    expect(screen.getByText(/healthy · runtime:ready/)).toBeInTheDocument();
    expect(screen.getByText('pty output referenced')).toBeInTheDocument();
    expect(screen.getByText(/terminal · pty:durable-range/)).toBeInTheDocument();
    expect(screen.getByText(/Governed state, status planes, and durable events/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Skip terminal output to governed activity' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Governed run activity' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('button', { name: 'Refresh run activity' })).toHaveClass('focus-visible:ring-2');
    expect(screen.getByTestId('run-current-state')).toHaveTextContent('generation 9');
    expect(screen.getByTestId('run-current-state')).toHaveTextContent('requested');
    expect(screen.getByTestId('run-current-state')).toHaveTextContent('retrying');
    expect(screen.getByTestId('run-current-state')).toHaveTextContent('backoff · 2/5');
    expect(screen.getByTestId('run-current-state')).toHaveTextContent('controller validated');
    expect(screen.getByTestId('run-current-state')).toHaveTextContent('blocked · decision:one');
    expect(screen.getByTestId('status-planes')).toHaveTextContent('sandbox_resource_monitor · runtime:probe');
    expect(screen.getByTestId('status-planes')).toHaveTextContent('sha256:runtime');
    expect(screen.getByTestId('status-planes')).toHaveTextContent('valid until 2026-08-05T12:05:00.000Z');
    expect(mockedApiFetch).toHaveBeenCalledWith(expect.stringContaining('/run-activity/runs/42/state?workspaceId=workspace%3Aone'));
    expect(mockedApiFetch).toHaveBeenCalledWith(expect.stringContaining('/run-activity/runs/42/events?workspaceId=workspace%3Aone'));
    expect(mockedApiFetch).toHaveBeenCalledWith(expect.stringContaining('&limit=100&tail=true'));
  });

  it('surfaces replay gaps and supports a focused refresh', async () => {
    mockedApiFetch.mockImplementation(async (url) => url.includes('/state?') ? state : { ...page, status: 'gap', resetReason: 'pruned', events: [] });
    render(<RunActivityView runId={43} workspaceId="workspace:one" refreshMs={60_000} />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('gap: pruned'));
    const calls = mockedApiFetch.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh run activity' }));
    await waitFor(() => expect(mockedApiFetch.mock.calls.length).toBeGreaterThan(calls));
  });
});
