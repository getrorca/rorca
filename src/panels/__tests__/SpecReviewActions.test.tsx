/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockWorkspace, renderWithProviders } from '../../test/helpers';
import SpecReviewPanel from '../SpecReviewPanel';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

vi.mock('../../components/TriggerPopover', () => ({
  default: ({ onTrigger }: { onTrigger: (autoWorktree: boolean) => void }) => (
    <button onClick={() => onTrigger(true)}>Confirm governed dispatch</button>
  ),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);
const workspace = createMockWorkspace({ id: 'ws-1', label: 'Test Repo', path: '/tmp/test' });

const PREVIEW_HASH = `sha256:${'a'.repeat(64)}`;
const SPEC_HASH = `sha256:${'b'.repeat(64)}`;
const IDEMPOTENCY_KEY = 'mission-trigger:ws-1:spec-review-test';

function executionPreview() {
  return {
    schemaVersion: 'rorca.execution-preview.v1' as const,
    previewHash: PREVIEW_HASH,
    expiresAt: '2026-08-06T18:00:00.000Z',
    workspaceId: 'ws-1',
    spec: {
      schemaVersion: 'rorca.entity-ref.v1' as const,
      workspaceId: 'ws-1',
      kind: 'spec' as const,
      id: 'approved-spec',
      revision: { kind: 'spec_version' as const, value: '3' },
      label: 'Trust repair spec',
    },
    specHash: SPEC_HASH,
    effectiveOptions: {
      agent: 'codex',
      mode: 'sequential' as const,
      parallelism: 1,
      storyIds: ['US-001'],
      worktree: { enabled: true },
      merge: { strategy: 'branch-only' as const, autoMerge: false },
    },
    scheduling: 'run' as const,
  };
}

function executionReceipt(runId: number) {
  const boundPreview = executionPreview();
  return {
    schemaVersion: 'rorca.execution-receipt.v1' as const,
    workspaceId: 'ws-1',
    spec: boundPreview.spec,
    specHash: SPEC_HASH,
    effectiveOptions: boundPreview.effectiveOptions,
    scheduling: 'run' as const,
    previewHash: PREVIEW_HASH,
    idempotencyKey: IDEMPOTENCY_KEY,
    returnedEntity: {
      schemaVersion: 'rorca.entity-ref.v1' as const,
      workspaceId: 'ws-1',
      kind: 'run' as const,
      id: String(runId),
      label: `Run #${runId}`,
    },
    acceptedAt: '2026-08-06T16:00:00.000Z',
  };
}

function configureSpec(status: 'pending' | 'approved', dispatch?: { runId: number; queued?: boolean; position?: number }) {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return { items: [workspace], total: 1, hasMore: false };
    if (path.includes('/readiness?')) {
      return { availableActions: status === 'approved' ? ['run'] : ['approve'] };
    }
    if (path.includes('/workflow?')) return { safeActionHints: [] };
    if (path === '/api/pipeline/preflight') {
      return { compatible: true, mismatchMode: 'warn' as const, engine: 'codex', stories: [], preview: executionPreview() };
    }
    if (path === '/api/pipeline/trigger') {
      const runId = dispatch?.runId ?? 70;
      return {
        ok: true,
        runId,
        queued: dispatch?.queued ?? false,
        position: dispatch?.position ?? 0,
        receipt: executionReceipt(runId),
      };
    }
    if (path.includes('/api/specs/')) {
      return {
        title: 'Trust repair spec',
        _status: status,
        userStories: [{ id: 'US-001', title: 'Safe action', acceptanceCriteria: ['One', 'Two', 'Three'] }],
      };
    }
    return {};
  });
}

describe('SpecReviewPanel execution actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    localStorage.setItem('rorca_workspaceId', 'ws-1');
    sessionStorage.setItem('rorca_workspaceId', 'ws-1');
    // Pin the caller idempotency key so the strict receipt binding validates.
    sessionStorage.setItem(`rorca:execution-idempotency:ws-1:${PREVIEW_HASH}`, IDEMPOTENCY_KEY);
  });

  it('shows readiness repair instead of Run for a pending spec', async () => {
    configureSpec('pending');
    renderWithProviders(
      <SpecReviewPanel specId="pending-spec" onBack={vi.fn()} onNavigate={vi.fn()} />,
    );

    expect(await screen.findByRole('button', { name: /review readiness/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run pipeline/i })).not.toBeInTheDocument();
    expect(mockApiFetch.mock.calls.some(([path]) => path === '/api/pipeline/trigger')).toBe(false);
  });

  it('navigates to the exact queued run identity returned by dispatch', async () => {
    configureSpec('approved', { queued: true, runId: 77, position: 4 });
    const onNavigateToRun = vi.fn();
    renderWithProviders(
      <SpecReviewPanel
        specId="approved-spec"
        onBack={vi.fn()}
        onNavigate={vi.fn()}
        onNavigateToRun={onNavigateToRun}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /run pipeline/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm governed dispatch/i }));

    await waitFor(() => expect(onNavigateToRun).toHaveBeenCalledWith(77));
    expect(onNavigateToRun).toHaveBeenCalledTimes(1);
  });
});
