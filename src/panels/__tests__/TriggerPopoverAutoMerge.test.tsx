/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TriggerPopover from '../../components/TriggerPopover';

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

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockResolvedValue({} as never);
});
const PREVIEW_HASH = `sha256:${'a'.repeat(64)}`;
const SPEC_HASH = `sha256:${'b'.repeat(64)}`;

function preview(scheduling: 'run' | 'queue' = 'run') {
  return {
    schemaVersion: 'rorca.execution-preview.v1' as const,
    previewHash: PREVIEW_HASH,
    expiresAt: '2026-08-06T18:00:00.000Z',
    workspaceId: 'ws-1',
    spec: {
      schemaVersion: 'rorca.entity-ref.v1' as const,
      workspaceId: 'ws-1',
      kind: 'spec' as const,
      id: 'ready-spec',
      revision: { kind: 'spec_version' as const, value: '12' },
      label: 'Ready spec',
    },
    specHash: SPEC_HASH,
    effectiveOptions: {
      agent: 'codex',
      model: 'openai-codex/gpt-5.6-sol',
      mode: 'sequential' as const,
      parallelism: 1,
      storyIds: ['US-001', 'US-002'],
      worktree: { enabled: true },
      merge: { strategy: 'branch-only' as const, autoMerge: false },
    },
    scheduling,
  };
}

function receipt(runId: number, scheduling: 'run' | 'queue' = 'run') {
  const boundPreview = preview(scheduling);
  return {
    schemaVersion: 'rorca.execution-receipt.v1' as const,
    workspaceId: 'ws-1',
    spec: boundPreview.spec,
    specHash: SPEC_HASH,
    effectiveOptions: boundPreview.effectiveOptions,
    scheduling,
    previewHash: PREVIEW_HASH,
    idempotencyKey: 'mission-trigger:ws-1:operator-choice',
    returnedEntity: {
      schemaVersion: 'rorca.entity-ref.v1' as const,
      workspaceId: 'ws-1',
      kind: 'run' as const,
      id: String(runId),
      label: scheduling === 'queue' ? `Queued run #${runId}` : `Run #${runId}`,
    },
    acceptedAt: '2026-08-06T16:00:00.000Z',
  };
}

function preflightResponse(scheduling: 'run' | 'queue' = 'run') {
  return {
    compatible: true,
    mismatchMode: 'warn' as const,
    engine: 'codex',
    stories: [],
    preview: preview(scheduling),
  };
}


describe('TriggerPopover — safe local execution defaults', () => {
  it('keeps isolated worktree execution visibly required', () => {
    render(<TriggerPopover loading={false} onTrigger={vi.fn()} onClose={vi.fn()} />);

    const worktree = screen.getByRole('checkbox', { name: /isolate in worktree/i }) as HTMLInputElement;
    expect(worktree.checked).toBe(true);
    expect(worktree.disabled).toBe(true);
    expect(screen.getByText('required')).toBeInTheDocument();
  });

  it('offers only the local branch completion action', () => {
    render(<TriggerPopover loading={false} onTrigger={vi.fn()} onClose={vi.fn()} />);

    const action = screen.getByRole('combobox', { name: /completion action/i }) as HTMLSelectElement;
    expect(action.value).toBe('branch-only');
    expect(Array.from(action.options).map(option => option.value)).toEqual(['branch-only']);
    expect(screen.getByText(/no push, merge, PR, or deployment/i)).toBeInTheDocument();
  });

  it('submits the complete local-only sequential profile by default', () => {
    const onTrigger = vi.fn();
    render(<TriggerPopover loading={false} onTrigger={onTrigger} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    expect(onTrigger).toHaveBeenCalledOnce();
    const [autoWorktree, options] = onTrigger.mock.calls[0];
    expect(autoWorktree).toBe(true);
    expect(options).toEqual(expect.objectContaining({
      autoMerge: false,
      mergeStrategy: 'branch-only',
      terminal_mode: 'ansi-html',
      forceSequential: true,
      orchestrationMode: 'sequential',
      parallelism: 1,
      agentOverride: 'omp',
    }));
  });

  it('defaults the executor selector to OMP and submits an explicit Pi fallback', () => {
    const onTrigger = vi.fn();
    render(<TriggerPopover loading={false} onTrigger={onTrigger} onClose={vi.fn()} />);

    const executor = screen.getByRole('combobox', { name: /executor/i }) as HTMLSelectElement;
    expect(executor.value).toBe('omp');
    fireEvent.change(executor, { target: { value: 'pi' } });
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    expect(onTrigger.mock.calls[0][1]).toEqual(expect.objectContaining({ agentOverride: 'pi' }));
  });

  it('shows and submits an explicit spec-level executor override', () => {
    const onTrigger = vi.fn();
    render(<TriggerPopover loading={false} onTrigger={onTrigger} onClose={vi.fn()} initialAgentOverride="codex" />);

    expect((screen.getByRole('combobox', { name: /executor/i }) as HTMLSelectElement).value).toBe('codex');
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));
    expect(onTrigger.mock.calls[0][1]).toEqual(expect.objectContaining({ agentOverride: 'codex' }));
  });

  it('labels reliable autonomous output as the default terminal', () => {
    render(<TriggerPopover loading={false} onTrigger={vi.fn()} onClose={vi.fn()} />);
    const terminal = screen.getByRole('combobox', { name: /terminal stream/i }) as HTMLSelectElement;
    expect(terminal.value).toBe('ansi-html');
    expect(screen.getByRole('option', { name: /reliable autonomous/i })).toBeInTheDocument();
  });

  it('uses native PTY only after explicit interactive selection', () => {
    const onTrigger = vi.fn();
    render(<TriggerPopover loading={false} onTrigger={onTrigger} onClose={vi.fn()} />);

    fireEvent.change(screen.getByRole('combobox', { name: /terminal stream/i }), {
      target: { value: 'native-pty' },
    });
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    const [, options] = onTrigger.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({ terminal_mode: 'native-pty', forceSequential: true }));
  });

  it('fails closed when canonical readiness does not permit execution', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/readiness?')) {
        return { availableActions: ['repair_post_save'], safeActionHints: [] };
      }
      if (path === '/api/pipeline/preflight') return preflightResponse();
      if (path.includes('/api/conventions/drift/')) return { report: null };
      throw new Error('Not used by readiness test');
    });
    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
        specPath="forge/specs/approved/blocked-spec.json"
        workspaceId="ws-1"
      />,
    );

    expect(await screen.findByText(/execution readiness is blocked/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run now/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('enables dispatch only after the server permits the run action', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/readiness?')) {
        return { availableActions: ['run'], safeActionHints: [] };
      }
      if (path === '/api/pipeline/preflight') return preflightResponse();
      if (path.includes('/api/conventions/drift/')) return { report: null };
      throw new Error('Not used by readiness test');
    });
    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specPath="forge/specs/approved/ready-spec.json"
        workspaceId="ws-1"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /run now/i })).toBeEnabled();
    });
    expect(screen.queryByText(/execution readiness is blocked/i)).not.toBeInTheDocument();
  });

  it('shows an operator-readable immutable preview without rendering the full digest as prose', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/readiness?')) return { availableActions: ['run'], safeActionHints: [] };
      if (path === '/api/pipeline/preflight') return preflightResponse();
      if (path.includes('/api/conventions/drift/')) return { report: null };
      throw new Error('Not used by receipt preview test');
    });
    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onClose={vi.fn()}
        specPath="forge/specs/approved/ready-spec.json"
        workspaceId="ws-1"
      />,
    );

    expect(await screen.findByRole('region', { name: /execution receipt preview/i })).toHaveTextContent(
      'Run now · Ready spec',
    );
    expect(screen.getByText(/Spec revision 12/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Copy execution preview/ })).toHaveAttribute('title', PREVIEW_HASH);
    expect(screen.queryByText(PREVIEW_HASH)).not.toBeInTheDocument();
  });

  it('shows the accepted receipt and navigates to its exact returned run identity', async () => {
    window.location.hash = '';
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/readiness?')) return { availableActions: ['run'], safeActionHints: [] };
      if (path === '/api/pipeline/preflight') return preflightResponse();
      if (path.includes('/api/conventions/drift/')) return { report: null };
      throw new Error('Not used by accepted receipt test');
    });
    const onTrigger = vi.fn().mockResolvedValue({
      ok: true,
      runId: 999,
      position: 0,
      receipt: receipt(73),
    });
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
        specPath="forge/specs/approved/ready-spec.json"
        workspaceId="ws-1"
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /run now/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    expect(await screen.findByRole('region', { name: /accepted execution receipt/i })).toHaveTextContent(
      'Started Run #73',
    );
    expect(window.location.hash).toBe('#/run/73');
  });

  it('keeps queued dispatch identity symmetrical with immediate dispatch', async () => {
    window.location.hash = '';
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/readiness?')) return { availableActions: ['run'], safeActionHints: [] };
      if (path === '/api/pipeline/preflight') return preflightResponse();
      if (path.includes('/api/conventions/drift/')) return { report: null };
      throw new Error('Not used by queued receipt test');
    });
    const onAddToQueue = vi.fn().mockResolvedValue({
      queued: true,
      runId: 998,
      position: 4,
      receipt: receipt(74, 'queue'),
    });
    render(
      <TriggerPopover
        loading={false}
        onTrigger={vi.fn()}
        onAddToQueue={onAddToQueue}
        onClose={vi.fn()}
        specPath="forge/specs/approved/ready-spec.json"
        workspaceId="ws-1"
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /add to queue/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /add to queue/i }));

    expect(await screen.findByRole('region', { name: /accepted execution receipt/i })).toHaveTextContent(
      'Queued run #74',
    );
    expect(window.location.hash).toBe('#/run/74');
  });
});
