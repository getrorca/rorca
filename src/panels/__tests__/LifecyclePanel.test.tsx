/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/apiFetch';
import LifecyclePanel from '../LifecyclePanel';

const mocks = vi.hoisted(() => ({
  workspaceId: 'ws-1' as string | null,
  lifecycle: {} as Record<string, any>,
}));

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: mocks.workspaceId }),
}));
vi.mock('../../hooks/useLifecycle', () => ({
  useLifecycle: () => mocks.lifecycle,
}));
vi.mock('../../components/SlideOver', () => ({
  default: ({ isOpen, title, children }: { isOpen: boolean; title: string; children: React.ReactNode }) =>
    isOpen ? <aside role="dialog" aria-label={title}>{children}</aside> : null,
}));

function lifecycleState() {
  const marks = { snapshotId: 'snapshot', evidenceHighWaterMark: 'e:1', decisionHighWaterMark: 'd:1' };
  const item = {
    specId: 'spec-a', title: 'Spec A', specStatus: 'approved', state: 'current', overallStatus: 'in_progress', risk: 'high', owner: null,
    storySummary: { total: 2, passed: 1, failed: 0 }, currentPhaseId: 'qa', blocked: false, blockers: [], liveness: null,
    currentRevision: null, phases: [{ phaseId: 'qa', displayName: 'QA', status: 'in_progress', disposition: 'required', blocker: null, nextSafeAction: 'Run QA' }],
    updatedAt: null,
  };
  return {
    filters: { sort: 'current_view' },
    urlState: { sort: 'current_view', page: 1, limit: 25, compact: false, selectedSpecId: 'spec-a', selectedPhaseId: 'qa' },
    portfolio: {
      data: {
        items: [item], total: 1, hasMore: false, workspace: { id: 'ws-1', label: 'Workspace' },
        phaseOrder: [{ id: 'qa', displayName: 'QA' }], ...marks,
        kpis: { specs: 1, evaluatedSpecs: 1, needsCompilation: 0, blockedSpecs: 0, stories: 2, phases: { total: 1, excluded: 0, denominator: 1, passed: 0, completionRate: 0, byStatus: {} } },
      },
      loading: false, refreshing: false, stale: false, partial: false, error: null,
    },
    selectedSpec: { data: { title: 'Spec A', ...marks }, loading: false, refreshing: false, stale: false, partial: false, error: null },
    phase: {
      data: {
        phaseId: 'qa', status: 'in_progress', whyRequired: 'QA is required', blocker: null, nextSafeAction: 'Run QA',
        mappedRequirements: { items: [], total: 0, truncated: false }, mappedDecisions: { items: [], total: 0, truncated: false },
        mappedStories: { items: [], total: 0, truncated: false }, requiredGates: { items: [], total: 0, truncated: false },
        evidence: { items: [], total: 0, hasMore: false }, ...marks,
      },
      loading: false, refreshing: false, stale: false, partial: false, error: null,
    },
    evidence: { data: null, loading: false, error: null },
    selectedEvidenceId: null,
    pagination: { page: 1, limit: 25, total: 1, hasMore: false },
    empty: false, refreshing: false, stale: false, partialData: false,
    refresh: vi.fn(), updateFilters: vi.fn(), updateUrlState: vi.fn(), setPage: vi.fn(),
    openEvidence: vi.fn(), closeEvidence: vi.fn(),
  };
}

beforeEach(() => {
  mocks.workspaceId = 'ws-1';
  mocks.lifecycle = lifecycleState();
});

describe('LifecyclePanel', () => {
  it('renders the phase matrix and opens a deep-linked phase drawer after spec data loads', () => {
    render(<LifecyclePanel />);
    expect(screen.getByRole('heading', { name: 'Lifecycle Control' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Spec A, QA: In progress' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Spec A — qa' })).toHaveTextContent('QA is required');
    expect(screen.getByText('No evidence has been recorded.')).toBeInTheDocument();
  });

  it('uses a matrix-shaped loading skeleton with the stable product label', () => {
    mocks.lifecycle.portfolio = { data: null, loading: true, error: null };
    render(<LifecyclePanel />);
    expect(screen.getByLabelText('Loading Lifecycle Control')).toHaveTextContent('Lifecycle Control');
  });

  it('shows an empty-workspace state without requesting a different navigation surface', () => {
    mocks.workspaceId = null;
    render(<LifecyclePanel />);
    expect(screen.getByRole('heading', { name: 'Select a workspace' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('offers a recoverable API error state', async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    mocks.lifecycle.portfolio = { data: null, loading: false, error: new ApiError(503, 'UNAVAILABLE', 'Service unavailable') };
    mocks.lifecycle.refresh = refresh;
    render(<LifecyclePanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('Lifecycle Control could not load');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledOnce();
  });
});
