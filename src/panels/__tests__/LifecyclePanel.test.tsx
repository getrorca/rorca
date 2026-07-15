/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/apiFetch';
import LifecyclePanel from '../LifecyclePanel';

const mocks = vi.hoisted(() => ({
  workspaceId: 'ws-1' as string | null,
  selectedWorkspace: { id: 'ws-1', name: 'Hermes', git_path: '/tmp/hermes' } as { id: string; name: string; git_path: string } | null,
  lifecycle: {} as Record<string, any>,
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: mocks.workspaceId, selectedWorkspace: mocks.selectedWorkspace }),
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
    currentRevision: { specVersion: '2', inputHash: 'sha256:spec-a', planVersion: 1 }, phases: [{ phaseId: 'qa', displayName: 'QA', status: 'in_progress', disposition: 'required', blocker: null, nextSafeAction: 'Run QA' }],
    updatedAt: null,
  };
  return {
    filters: { sort: 'current_view' },
    urlState: { sort: 'current_view', page: 1, limit: 25, compact: false, selectedSpecId: 'spec-a', selectedPhaseId: 'qa' },
    portfolio: {
      data: {
        items: [item], total: 1, hasMore: false, workspace: { id: 'ws-1', label: 'Workspace' },
        phaseOrder: [{ id: 'qa', displayName: 'QA' }], ...marks,
        kpis: { specs: 1, activeSpecs: 1, evaluatedSpecs: 1, needsCompilation: 0, blockedSpecs: 0, missingGates: 2, readyForQa: 1, waitingApprovals: 0, recentPhaseTransitions: 3, stories: 2, phases: { total: 1, excluded: 0, denominator: 1, passed: 0, completionRate: 0, byStatus: {} } },
      },
      loading: false, refreshing: false, stale: false, partial: false, error: null,
    },
    selectedSpec: { data: { specId: 'spec-a', title: 'Spec A', currentRun: null, plan: null, ...marks }, loading: false, refreshing: false, stale: false, partial: false, error: null },
    phase: {
      data: {
        workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'qa', state: 'current', status: 'in_progress', disposition: 'required',
        whyRequired: 'QA is required', blocker: null, nextSafeAction: 'Run QA',
        nextSafeActionGuidance: { action: 'Run QA', rationale: 'QA remains incomplete.', confidence: 0.95, classifier: 'phase_evaluator' },
        permittedActions: ['run_phase'], governedDecisions: { items: [], total: 0, truncated: false },
        mappedRequirements: { items: [], total: 0, truncated: false }, mappedDecisions: { items: [], total: 0, truncated: false },
        mappedStories: { items: [], total: 0, truncated: false }, requiredGates: { items: [], total: 0, truncated: false },
        evidence: { items: [], total: 0, hasMore: false }, evaluationSnapshot: marks, ...marks,
      },
      loading: false, refreshing: false, stale: false, partial: false, error: null,
    },
    evidence: { data: null, loading: false, error: null },
    selectedEvidenceId: null,
    pagination: { page: 1, limit: 25, total: 1, hasMore: false },
    empty: false, refreshing: false, stale: false, partialData: false, lastSuccessfulRefresh: '2026-07-15T12:00:00.000Z',
    savedViews: [], refresh: vi.fn(), updateFilters: vi.fn(), updateUrlState: vi.fn(), setPage: vi.fn(), setCompact: vi.fn(),
    saveView: vi.fn(), renameSavedView: vi.fn(), removeSavedView: vi.fn(), applySavedView: vi.fn(),
    mutations: { recompile: vi.fn(), recordDecision: vi.fn(), revokeDecision: vi.fn() },
    openEvidence: vi.fn(), closeEvidence: vi.fn(),
  };
}

beforeEach(() => {
  mocks.workspaceId = 'ws-1';
  mocks.selectedWorkspace = { id: 'ws-1', name: 'Hermes', git_path: '/tmp/hermes' };
  mocks.lifecycle = lifecycleState();
  mocks.navigate.mockReset();
});

describe('LifecyclePanel', () => {
  it('renders the phase matrix and opens a deep-linked phase drawer after spec data loads', () => {
    render(<LifecyclePanel />);
    expect(screen.getByRole('heading', { name: 'Lifecycle Control' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Spec A, QA: In progress.*0 of 0 required gates passed/i })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Spec A — QA' })).toHaveTextContent('QA is required');
    expect(screen.getByText(/No evidence has been recorded; source, time, and revision match are unknown/)).toBeInTheDocument();
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

  it('shows workspace context and all compact API KPI totals', () => {
    render(<LifecyclePanel />);
    expect(screen.getByLabelText('Current workspace: Hermes')).toBeInTheDocument();
    expect(screen.getByText('Active specs')).toBeInTheDocument();
    expect(screen.getByText('Lifecycle coverage')).toBeInTheDocument();
    expect(screen.getByText('2 missing gates')).toBeInTheDocument();
    expect(screen.getByText('Ready for QA')).toBeInTheDocument();
    expect(screen.getByText('Waiting approvals')).toBeInTheDocument();
    expect(screen.getByText('Recent transitions')).toBeInTheDocument();
  });

  it('applies immediate filter combinations while debouncing only search text', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.portfolio.data.items[0].owner = { id: 'u-1', label: 'Ada' };
    render(<LifecyclePanel />);

    await user.selectOptions(screen.getByLabelText('Status filter'), 'blocked');
    await user.selectOptions(screen.getByLabelText('Phase filter'), 'qa');
    await user.click(screen.getByRole('button', { name: 'Blocked only' }));
    await user.click(screen.getByRole('button', { name: 'More filters' }));
    await user.selectOptions(screen.getByLabelText('Risk filter'), 'high');
    await user.selectOptions(screen.getByLabelText('Owner filter'), 'u-1');

    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ status: 'blocked' });
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ phase: 'qa' });
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ blocked: true });
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ risk: 'high' });
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ owner: 'u-1' });

    await user.type(screen.getByPlaceholderText('Search specs'), 'release');
    expect(mocks.lifecycle.updateFilters).not.toHaveBeenCalledWith({ search: 'release' }, true);
    await waitFor(() => expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ search: 'release' }, true), { timeout: 800 });
  });

  it('announces active filters and resets the complete query in one click', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.filters = { sort: 'risk_desc', status: 'blocked', phase: 'qa', risk: 'high', blocked: true };
    render(<LifecyclePanel />);
    expect(screen.getByRole('button', { name: 'More filters (4)' })).toBeInTheDocument();
    expect(screen.getByText('4 active filters. Status: blocked. Phase: qa. Risk: high. Blocked only')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset all' }));
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith(expect.objectContaining({
      search: undefined, status: undefined, phase: undefined, risk: undefined,
      owner: undefined, blocked: undefined, sort: 'current_view',
    }));
  });

  it('creates, applies, renames, and deletes a local saved view', async () => {
    const user = userEvent.setup();
    const savedView = {
      id: 'view-1', name: 'Risk watch', filters: { sort: 'current_view', risk: 'high' },
      display: { compact: true, limit: 25 }, updatedAt: '2026-07-15T12:00:00.000Z',
    };
    mocks.lifecycle.savedViews = [savedView];
    mocks.lifecycle.saveView.mockReturnValue(savedView);
    render(<LifecyclePanel />);
    await user.click(screen.getByRole('button', { name: 'More filters' }));

    const name = screen.getByLabelText('View name');
    await user.type(name, 'Risk watch');
    await user.click(screen.getByRole('button', { name: 'Save current' }));
    expect(mocks.lifecycle.saveView).toHaveBeenCalledWith('Risk watch');

    await user.selectOptions(screen.getByLabelText('Saved view'), 'view-1');
    expect(mocks.lifecycle.applySavedView).toHaveBeenCalledWith(savedView);
    await user.clear(name);
    await user.type(name, 'Critical watch');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(mocks.lifecycle.renameSavedView).toHaveBeenCalledWith('view-1', 'Critical watch');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mocks.lifecycle.removeSavedView).toHaveBeenCalledWith('view-1');
  });

  it('explains zero results with the active filters instead of replacing the controls', () => {
    mocks.lifecycle.filters = { sort: 'current_view', status: 'blocked', risk: 'critical' };
    mocks.lifecycle.portfolio.data.items = [];
    mocks.lifecycle.portfolio.data.total = 0;
    mocks.lifecycle.pagination.total = 0;
    mocks.lifecycle.empty = true;
    render(<LifecyclePanel />);
    expect(screen.getByRole('heading', { name: 'No specs match the active filters' })).toBeInTheDocument();
    expect(screen.getByText('status: blocked · risk: critical')).toBeInTheDocument();
    expect(screen.getByLabelText('Status filter')).toBeInTheDocument();
  });

  it('keeps prior KPI data on refresh failure and retries without changing selection', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.portfolio.error = new ApiError(503, 'UNAVAILABLE', 'Service unavailable');
    render(<LifecyclePanel />);
    expect(screen.getByText('Refresh failed: Service unavailable')).toBeInTheDocument();
    expect(screen.getByText('Active specs')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh Lifecycle Control' }));
    expect(mocks.lifecycle.refresh).toHaveBeenCalledOnce();
    expect(mocks.lifecycle.updateUrlState).not.toHaveBeenCalled();
  });

  it('operates display toggles by keyboard and never calls lifecycle mutation APIs', async () => {
    const user = userEvent.setup();
    render(<LifecyclePanel />);
    const blocked = screen.getByRole('button', { name: 'Blocked only' });
    blocked.focus();
    await user.keyboard('{Enter}');
    const compact = screen.getByRole('button', { name: 'Compact' });
    compact.focus();
    await user.keyboard(' ');
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ blocked: true });
    expect(mocks.lifecycle.setCompact).toHaveBeenCalledWith(true);
    expect(mocks.lifecycle.mutations.recompile).not.toHaveBeenCalled();
    expect(mocks.lifecycle.mutations.recordDecision).not.toHaveBeenCalled();
    expect(mocks.lifecycle.mutations.revokeDecision).not.toHaveBeenCalled();
  });

  it('replaces URL selection on close and when switching an already open drawer', async () => {
    const user = userEvent.setup();
    render(<LifecyclePanel />);
    await user.click(screen.getByRole('button', { name: /Spec A, Intake:/i }));
    expect(mocks.lifecycle.closeEvidence).toHaveBeenCalled();
    expect(mocks.lifecycle.updateUrlState).toHaveBeenLastCalledWith({ selectedSpecId: 'spec-a', selectedPhaseId: 'intake' }, true);
    expect(screen.getByRole('dialog')).toHaveTextContent('Loading phase evidence…');

    await user.click(screen.getByRole('button', { name: 'Close phase details' }));
    expect(mocks.lifecycle.updateUrlState).toHaveBeenLastCalledWith({ selectedSpecId: null, selectedPhaseId: null }, true);
  });

  it('routes the server-permitted Open run action without inferring it from status', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.selectedSpec.data.currentRun = { id: 913 };
    render(<LifecyclePanel />);
    await user.click(screen.getByRole('button', { name: /Open run/ }));
    expect(mocks.navigate).toHaveBeenCalledWith('/runs/913');
  });

  it('never flashes a prior phase response while a different selected cell is loading', () => {
    mocks.lifecycle.phase.data = { ...mocks.lifecycle.phase.data, specId: 'other-spec', whyRequired: 'Stale response content' };
    mocks.lifecycle.phase.loading = true;
    render(<LifecyclePanel />);
    expect(screen.getByText('Loading phase evidence…')).toBeInTheDocument();
    expect(screen.queryByText('Stale response content')).not.toBeInTheDocument();
  });

  it('keeps a phase request error recoverable without showing stale content', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.phase.data = null;
    mocks.lifecycle.phase.loading = false;
    mocks.lifecycle.phase.error = new ApiError(503, 'UNAVAILABLE', 'Evidence service unavailable');
    render(<LifecyclePanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('Evidence service unavailable');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }));
    expect(mocks.lifecycle.refresh).toHaveBeenCalled();
  });
});
