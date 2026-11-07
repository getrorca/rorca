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
import type * as ReactRouter from 'react-router';
import { parseEntityRoute } from '../../lib/entityRoutes';
import { consumeReturnContext } from '../../lib/returnContext';

const mocks = vi.hoisted(() => ({
  workspaceId: 'ws-1' as string | null,
  selectedWorkspace: { id: 'ws-1', name: 'Hermes', git_path: '/tmp/hermes' } as { id: string; name: string; git_path: string } | null,
  lifecycle: {} as Record<string, any>,
  navigate: vi.fn(),
  previewRetry: vi.fn(),
  dispatchRetry: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn() },
}));

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/lifecycle', search: '?spec=spec-a&phase=testing', hash: '', state: null, key: 'test' }),
}));
vi.mock('../../api/lifecycle', () => ({
  previewLifecycleRetry: (...args: unknown[]) => mocks.previewRetry(...args),
  dispatchLifecycleRetry: (...args: unknown[]) => mocks.dispatchRetry(...args),
}));
vi.mock('../../contexts/ToastContext', () => ({
  useGlobalToast: () => mocks.toast,
}));
vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: mocks.workspaceId, selectedWorkspace: mocks.selectedWorkspace }),
}));
vi.mock('../../hooks/useLifecycle', () => ({
  useLifecycle: () => mocks.lifecycle,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function lifecycleState() {
  const marks = { snapshotId: 'snapshot', evidenceHighWaterMark: 'e:1', decisionHighWaterMark: 'd:1' };
  const item = {
    specId: 'spec-a', title: 'Spec A', specStatus: 'approved', state: 'current', overallStatus: 'in_progress', risk: 'high', owner: null,
    storySummary: { total: 2, passed: 1, failed: 0 }, currentPhaseId: 'testing', blocked: false, blockers: [], liveness: null,
    currentRevision: { specVersion: '2', inputHash: 'sha256:spec-a', planVersion: 1 }, phases: [{ phaseId: 'testing', displayName: 'Testing', status: 'in_progress', ownStatus: 'passed', dependencyStatus: 'waiting', disposition: 'required', blocker: null, nextSafeAction: 'Run QA' }],
    readiness: {
      execution: { status: 'completed', runId: 913, rationale: 'Execution completed.' },
      assurance: { status: 'partial', passedControls: 3, totalControls: 7, pendingPolicyApprovals: 1, pendingHumanApprovals: 1, rationale: 'Controls remain pending.' },
      delivery: { status: 'in_progress', rationale: 'A run is reconciling.', reconciledAt: null, reconciliation: null },
    },
    delivery: { status: 'in_progress', rationale: 'A run is active.', reconciledAt: null },
    assurance: { status: 'partial', passedControls: 3, totalControls: 7, coverage: 3 / 7, rationale: 'Controls remain pending.' },
    reconciliation: null,
    updatedAt: null,
  };
  return {
    filters: { sort: 'current_view' },
    urlState: { sort: 'current_view', page: 1, limit: 25, compact: false, mode: 'explorer', selectedSpecId: null, selectedPhaseId: null },
    portfolio: {
      data: {
        items: [item], total: 1, hasMore: false, workspace: { id: 'ws-1', label: 'Workspace' },
        phaseOrder: [{ id: 'testing', displayName: 'Testing' }], stageProfile: null, ...marks,
        kpis: { specs: 1, activeSpecs: 1, evaluatedSpecs: 1, needsCompilation: 0, blockedSpecs: 0, deliveredSpecs: 0, inProgressSpecs: 1, needsReconciliation: 1, assuranceComplete: 0, missingGates: 2, specsWithBlockers: 0, readyForQa: 1, waitingApprovals: 2, recentPhaseTransitions: 3, stories: 2, phases: { total: 1, excluded: 0, denominator: 1, passed: 0, completionRate: 0, byStatus: {} } },
      },
      loading: false, refreshing: false, stale: false, partial: false, error: null,
    },
    selectedSpec: {
      data: {
        specId: 'spec-a',
        title: 'Spec A',
        currentRun: null,
        plan: null,
        readiness: item.readiness,
        assurance: item.assurance,
        delivery: item.delivery,
        ...marks,
      },
      loading: false,
      refreshing: false,
      stale: false,
      partial: false,
      error: null,
    },
    phase: {
      data: {
        workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing', state: 'current', status: 'in_progress', ownStatus: 'passed', dependencyStatus: 'waiting', disposition: 'required',
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
    savedViews: [], refresh: vi.fn(), updateFilters: vi.fn(), updateUrlState: vi.fn(), prefetchFilters: vi.fn().mockResolvedValue(undefined), setPage: vi.fn(), setCompact: vi.fn(), setMode: vi.fn(),
    saveView: vi.fn(), renameSavedView: vi.fn(), removeSavedView: vi.fn(), applySavedView: vi.fn(),
    mutations: { recompile: vi.fn(), recordDecision: vi.fn(), revokeDecision: vi.fn() },
    openEvidence: vi.fn(), closeEvidence: vi.fn(),
  };
}

function openPhase(phaseId: 'testing' | 'testing' = 'testing') {
  mocks.lifecycle.urlState.selectedSpecId = 'spec-a';
  mocks.lifecycle.urlState.selectedPhaseId = phaseId;
}

beforeEach(() => {
  mocks.workspaceId = 'ws-1';
  mocks.selectedWorkspace = { id: 'ws-1', name: 'Hermes', git_path: '/tmp/hermes' };
  mocks.lifecycle = lifecycleState();
  mocks.navigate.mockReset();
  mocks.previewRetry.mockReset();
  mocks.dispatchRetry.mockReset();
  Object.values(mocks.toast).forEach((mock) => mock.mockReset());
});

describe('LifecyclePanel', () => {
  it('opens a deep-linked phase as the primary full-width view after snapshot-pinned data loads', () => {
    openPhase();
    render(<LifecyclePanel />);
    expect(screen.getByRole('heading', { name: 'Lifecycle Control' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Lifecycle Explorer' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('lifecycle-matrix-scroll')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Spec A — Testing' })).toHaveTextContent('QA is required');
    expect(screen.getByText('No standalone evidence records')).toBeInTheDocument();
  });

  it('renders the Explorer as the board-first home view', () => {
    render(<LifecyclePanel />);
    expect(screen.getByRole('region', { name: 'Lifecycle Explorer' })).toBeInTheDocument();
    // The single qa phase projects to the Testing stage cell.
    expect(screen.getByRole('button', { name: /Spec A, Testing\. Own gates: Passed\. Dependencies: waiting/i })).toBeInTheDocument();
    const readiness = screen.getByRole('group', { name: 'Execution, assurance, and delivery readiness' });
    expect(within(readiness).getByText('Execution completed')).toBeInTheDocument();
    expect(within(readiness).getByText('Assurance partial')).toBeInTheDocument();
    expect(within(readiness).queryByText('Execution not started')).not.toBeInTheDocument();
  });

  it('switches to the expert Matrix explicitly and keeps Compact scoped to Matrix', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.urlState.mode = 'matrix';
    render(<LifecyclePanel />);
    expect(screen.getByTestId('lifecycle-matrix-scroll')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Lifecycle Explorer' })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Lifecycle filters')).queryByRole('combobox', { name: 'Status filter' })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Lifecycle filters')).queryByRole('combobox', { name: 'Phase filter' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Lifecycle filters').querySelector('select')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Compact matrix' }));
    expect(mocks.lifecycle.setCompact).toHaveBeenCalledWith(true);
  });

  it('uses an Explorer-shaped loading skeleton with the stable product label', () => {
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

  it.each([
    [new ApiError(501, 'ADAPTER_UNAVAILABLE', 'Git adapter unavailable'), 'Lifecycle adapter is unavailable', 'Retry connection'],
    [new ApiError(403, 'FORBIDDEN', 'Denied'), 'Lifecycle access is restricted', null],
  ] as const)('shows an actionable operational state for %s', async (error, heading, action) => {
    const user = userEvent.setup();
    mocks.lifecycle.portfolio = { data: null, loading: false, error };
    render(<LifecyclePanel />);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.queryByText('Active specs')).not.toBeInTheDocument();
    if (action) {
      await user.click(screen.getByRole('button', { name: action }));
      expect(mocks.lifecycle.refresh).toHaveBeenCalledOnce();
    } else {
      expect(screen.getByText(/Ask a workspace administrator/)).toBeInTheDocument();
    }
  });

  it('avoids redundant workspace chrome and shows all compact API KPI totals', () => {
    render(<LifecyclePanel />);
    expect(screen.queryByText('Current workspace')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Current workspace: Hermes')).not.toBeInTheDocument();
    const totals = within(screen.getByLabelText('Lifecycle totals'));
    expect(totals.getByText('Lifecycle candidates')).toBeInTheDocument();
    expect(totals.getByText('Delivered')).toBeInTheDocument();
    expect(totals.getByText('In progress')).toBeInTheDocument();
    expect(totals.getByText('Needs reconciliation')).toBeInTheDocument();
    expect(totals.getByText('Blocked')).toBeInTheDocument();
    expect(totals.getByText('Assurance complete')).toBeInTheDocument();
    expect(totals.getByText('Waiting approval gates')).toBeInTheDocument();
    expect(totals.getByText('Unique active unresolved gates')).toBeInTheDocument();
  });

  it('applies button-based filter combinations while debouncing query text', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.portfolio.data.items[0].owner = { id: 'u-1', label: 'Ada' };
    render(<LifecyclePanel />);

    await user.click(screen.getByRole('button', { name: 'Testing' }));
    await user.click(screen.getByRole('button', { name: 'Blocked' }));
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    await user.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'Blocked' }));
    await user.click(within(screen.getByRole('group', { name: 'Risk' })).getByRole('button', { name: 'High' }));
    await user.click(within(screen.getByRole('group', { name: 'Owner' })).getByRole('button', { name: 'Ada' }));

    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ status: 'blocked' });
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ stage: 'testing' });
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ blocked: true });
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ risk: 'high' });
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ owner: 'u-1' });

    await user.type(screen.getByRole('combobox', { name: 'Search and filter lifecycle specs' }), 'release');
    expect(mocks.lifecycle.updateFilters).not.toHaveBeenCalledWith(expect.objectContaining({ search: 'release' }), true);
    await waitFor(() => expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith(expect.objectContaining({ search: 'release' }), true), { timeout: 800 });
  });

  it('supports keyboard query autocomplete and maps tokens to validated filters', async () => {
    const user = userEvent.setup();
    render(<LifecyclePanel />);
    const query = screen.getByRole('combobox', { name: 'Search and filter lifecycle specs' });
    await user.type(query, 'status:awa');
    const listbox = screen.getByRole('listbox', { name: 'Lifecycle query suggestions' });
    expect(listbox).toBeInTheDocument();
    expect(listbox.parentElement).toBe(document.body);
    await user.keyboard('{Enter}');
    expect(query).toHaveValue('status:awaiting_approval ');
    await waitFor(() => expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith(expect.objectContaining({ status: 'awaiting_approval' }), true), { timeout: 800 });
  });

  it('commits a free-text query immediately on Enter without waiting for debounce', async () => {
    const user = userEvent.setup();
    render(<LifecyclePanel />);
    const query = screen.getByRole('combobox', { name: 'Search and filter lifecycle specs' });
    await user.type(query, 'release');
    await user.keyboard('{Enter}');
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith(expect.objectContaining({ search: 'release' }), true);
  });

  it('announces active filters as removable chips and clears the complete query', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.filters = { sort: 'risk_desc', status: 'blocked', phase: 'testing', risk: 'high', blocked: true };
    render(<LifecyclePanel />);
    expect(screen.getByRole('button', { name: 'Remove Status: Blocked filter' })).toBeInTheDocument();
    expect(screen.getByText('5 active filters. Status: Blocked. Phase: Testing. Risk: High. Blocked. View: Risk Desc')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
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
    await user.click(screen.getByRole('button', { name: 'Filters' }));

    const name = screen.getByLabelText('View name');
    await user.type(name, 'Risk watch');
    await user.click(screen.getByRole('button', { name: 'Save current' }));
    expect(mocks.lifecycle.saveView).toHaveBeenCalledWith('Risk watch');

    await user.click(screen.getByRole('button', { name: 'Risk watch' }));
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
    expect(screen.getByText('status: blocked')).toBeInTheDocument();
    expect(screen.getByText('risk: critical')).toBeInTheDocument();
    expect(screen.queryByText('status: blocked · risk: critical')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Search and filter lifecycle specs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Status: Blocked filter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear all filters' })).toBeInTheDocument();
  });

  it('keeps prior KPI data on refresh failure and retries without changing selection', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.portfolio.error = new ApiError(503, 'UNAVAILABLE', 'Service unavailable');
    render(<LifecyclePanel />);
    const refreshAlert = screen.getByRole('alert');
    expect(refreshAlert).toHaveTextContent('Refresh failed: Service unavailable');
    expect(refreshAlert).toHaveTextContent(/Last updated|No successful refresh yet/);
    expect(refreshAlert).not.toHaveClass('hidden');
    expect(screen.getByText('Lifecycle candidates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh Lifecycle Control' })).toHaveTextContent('Retry');
    await user.click(screen.getByRole('button', { name: 'Refresh Lifecycle Control' }));
    expect(mocks.lifecycle.refresh).toHaveBeenCalledOnce();
    expect(mocks.lifecycle.updateUrlState).not.toHaveBeenCalled();
  });

  it('operates mode and preset toggles by keyboard without lifecycle mutations', async () => {
    const user = userEvent.setup();
    render(<LifecyclePanel />);
    const blocked = screen.getByRole('button', { name: 'Blocked' });
    blocked.focus();
    await user.keyboard('{Enter}');
    const readyForQa = screen.getByRole('button', { name: 'Ready for Testing' });
    readyForQa.focus();
    await user.keyboard('{Enter}');
    const matrix = screen.getByRole('button', { name: 'Matrix' });
    matrix.focus();
    await user.keyboard(' ');
    expect(mocks.lifecycle.prefetchFilters).toHaveBeenCalledWith({ blocked: true });
    expect(mocks.lifecycle.prefetchFilters).toHaveBeenCalledWith({ phase: 'testing', blocked: false });
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ blocked: true });
    expect(mocks.lifecycle.updateFilters).toHaveBeenCalledWith({ phase: 'testing', blocked: false });
    expect(mocks.lifecycle.setMode).toHaveBeenCalledWith('matrix');
    expect(mocks.lifecycle.mutations.recompile).not.toHaveBeenCalled();
    expect(mocks.lifecycle.mutations.recordDecision).not.toHaveBeenCalled();
    expect(mocks.lifecycle.mutations.revokeDecision).not.toHaveBeenCalled();
  });

  it('keeps the phase view mounted with switcher focus while the next phase loads, then restores board focus on close', async () => {
    const user = userEvent.setup();
    openPhase();
    const rendered = render(<LifecyclePanel />);
    const phaseView = screen.getByTestId('lifecycle-phase-view');
    const planning = within(screen.getByRole('group', { name: 'Switch lifecycle stage' })).getByRole('button', { name: 'Planning' });
    await user.click(planning);
    expect(mocks.lifecycle.closeEvidence).toHaveBeenCalled();
    expect(mocks.lifecycle.updateUrlState).toHaveBeenLastCalledWith({ selectedSpecId: 'spec-a', selectedPhaseId: 'planning' }, true);
    expect(screen.getByTestId('lifecycle-phase-view')).toBe(phaseView);
    expect(screen.getByRole('region', { name: 'Spec A — Planning' })).toHaveTextContent('Loading Planning phase evidence… Previous phase details remain visible.');
    expect(screen.getByText('QA is required')).toBeInTheDocument();
    expect(planning).toHaveFocus();

    mocks.lifecycle.urlState.selectedPhaseId = 'planning';
    mocks.lifecycle.phase.data = {
      ...mocks.lifecycle.phase.data,
      phaseId: 'planning',
      whyRequired: 'Planning requirements loaded.',
    };
    rendered.rerender(<LifecyclePanel />);
    expect(screen.getByTestId('lifecycle-phase-view')).toBe(phaseView);
    expect(screen.getByText('Planning requirements loaded.')).toBeInTheDocument();
    expect(planning).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Back to board' }));
    expect(mocks.lifecycle.updateUrlState).toHaveBeenLastCalledWith({ selectedSpecId: null, selectedPhaseId: null }, true);
    await waitFor(() => {
      // The planning phase projects to the Planning stage cell on the board.
      const restored = screen.getByRole('button', { name: /Spec A, Planning\./i });
      expect(restored).toHaveFocus();
      expect(restored).toHaveAttribute('tabindex', '0');
    });
  });

  it('opens Spec Review on Lifecycle Control and preserves the selected phase return URL', async () => {
    const user = userEvent.setup();
    render(<LifecyclePanel />);
    await user.click(screen.getByRole('button', { name: 'Spec A' }));
    const destination = mocks.navigate.mock.calls[0]?.[0] as string;
    expect(parseEntityRoute(destination, 'ws-1')).toMatchObject({ kind: 'spec', id: 'spec-a', workspaceId: 'ws-1' });
    expect(consumeReturnContext(destination.slice(destination.indexOf('?')), '/specs', 'ws-1')).toBe('/lifecycle?spec=spec-a&phase=testing');
  });

  it('routes the server-permitted Open run action with a deep-link return to the selected phase', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.selectedSpec.data.currentRun = { id: 913 };
    openPhase();
    render(<LifecyclePanel />);
    await user.click(screen.getByRole('button', { name: /Open run/ }));
    const destination = mocks.navigate.mock.calls[0]?.[0] as string;
    expect(parseEntityRoute(destination, 'ws-1')).toMatchObject({ kind: 'run', id: '913', workspaceId: 'ws-1' });
    expect(consumeReturnContext(destination.slice(destination.indexOf('?')), '/runs', 'ws-1')).toBe('/lifecycle?spec=spec-a&phase=testing');
  });

  it('queues an exact current retry only after confirmation and suppresses duplicate submit', async () => {
    const user = userEvent.setup();
    const hash = `sha256:${'a'.repeat(64)}`;
    const preview = {
      ok: true,
      preview: {
        schemaVersion: 'retry-preview.v1', originalRunId: 913, previewHash: hash, requiresApproval: false, forceSequential: true,
        scope: { requested: [{ storyId: 'US-6', reasonCode: 'REQUESTED_FAILED_STORY' }], requiredDependency: [], copiedPassed: [], skipped: [], executable: [{ storyId: 'US-6', reasonCode: 'EXECUTABLE_RETRY_WORK' }], remaining: [], excluded: [] },
        options: { agent: 'pi', model: null, effort: 'high', terminalMode: 'headless', includeGraph: true, worktree: { enabled: true, path: '/tmp/wt', branch: 'retry/us-6' }, merge: { strategy: 'branch-only', autoMerge: false }, safety: { deploy: false, externalSend: false, policyLocked: true, allowBackendJest: false } },
        destructiveOperations: ['reset', 'branch_delete', 'force_push', 'auto_merge', 'deploy', 'external_send'],
      },
      previewIdentity: { schemaVersion: 'retry-preview-identity.v1', previewHash: hash, originalRunId: 913, expiresAt: '2999-01-01T00:00:00.000Z', signature: hash },
      worktreePreflight: { classification: 'fresh', ok: true },
    };
    mocks.lifecycle.phase.data.permittedActions = ['retry_smallest_scope'];
    mocks.lifecycle.selectedSpec.data.currentRun = { id: 913 };
    mocks.previewRetry.mockResolvedValue(preview);
    mocks.dispatchRetry.mockResolvedValue({ ok: true, queued: true, runId: 914, originalRunId: 913, previewHash: hash });
    openPhase();
    render(<LifecyclePanel />);

    await user.click(screen.getByRole('button', { name: /Retry story/ }));
    expect(await screen.findByRole('heading', { name: 'Retry preview' })).toBeInTheDocument();
    expect(mocks.dispatchRetry).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox'));
    const submit = screen.getByRole('button', { name: 'Queue exact retry' });
    await user.dblClick(submit);
    await waitFor(() => expect(mocks.dispatchRetry).toHaveBeenCalledOnce());
    expect(mocks.lifecycle.refresh).toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledWith(expect.stringContaining('durably queued'), expect.objectContaining({ persistent: true }));
  });

  it('does not optimistically approve, suppresses duplicate decisions, and recovers after a server denial', async () => {
    const user = userEvent.setup();
    const request = deferred<{ decision: { id: string } }>();
    const recordDecision = vi.fn()
      .mockImplementationOnce(() => request.promise)
      .mockResolvedValueOnce({ decision: { id: 'decision-2' } });
    const qaCell = mocks.lifecycle.portfolio.data.items[0].phases[0];
    Object.assign(qaCell, { status: 'blocked', blocker: 'QA evidence is missing.' });
    Object.assign(mocks.lifecycle.phase.data, {
      status: 'blocked',
      blocker: { gateId: 'qa-gate', reason: 'QA evidence is missing.' },
      permittedActions: ['request_approval'],
      requiredGates: {
        items: [{
          gateId: 'qa-gate', title: 'Immutable QA evidence', evidenceKind: 'qa_assessment', blockingSeverity: 'release_blocking',
          evaluation: { status: 'blocked', blockerReason: 'QA evidence is missing.' },
        }],
        total: 1,
        truncated: false,
      },
    });
    mocks.lifecycle.mutations.recordDecision = recordDecision;
    openPhase();
    render(<LifecyclePanel />);

    await user.click(screen.getByRole('button', { name: /Request approval/ }));
    expect(screen.getByRole('heading', { name: 'Testing approval' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Rationale/), 'Reviewed the immutable QA evidence packet.');
    await user.click(screen.getByRole('checkbox'));
    await user.dblClick(screen.getByRole('button', { name: 'Record Testing approval' }));

    expect(recordDecision).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'Spec A — Testing' })).toHaveTextContent('QA evidence is missing.');
    expect(mocks.toast.success).not.toHaveBeenCalled();

    request.reject(new ApiError(409, 'STALE_REVISION', 'Preview is stale'));
    expect(await screen.findByRole('alert')).toHaveTextContent('No approval was recorded');
    expect(screen.getByRole('heading', { name: 'Testing approval' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Spec A — Testing' })).toHaveTextContent('QA evidence is missing.');

    await user.click(screen.getByRole('button', { name: 'Record Testing approval' }));
    await waitFor(() => expect(recordDecision).toHaveBeenCalledTimes(2));
    expect(mocks.toast.success).toHaveBeenCalledWith(expect.stringContaining('durably recorded'), expect.objectContaining({ persistent: true }));
  });

  it('never flashes a prior phase response while a different selected cell is loading', () => {
    mocks.lifecycle.phase.data = { ...mocks.lifecycle.phase.data, specId: 'other-spec', whyRequired: 'Stale response content' };
    mocks.lifecycle.phase.loading = true;
    openPhase();
    render(<LifecyclePanel />);
    expect(screen.getByText('Loading phase evidence…')).toBeInTheDocument();
    expect(screen.queryByText('Stale response content')).not.toBeInTheDocument();
  });

  it('keeps a phase request error recoverable without showing stale content', async () => {
    const user = userEvent.setup();
    mocks.lifecycle.phase.data = null;
    mocks.lifecycle.phase.loading = false;
    mocks.lifecycle.phase.error = new ApiError(503, 'UNAVAILABLE', 'Evidence service unavailable');
    openPhase();
    render(<LifecyclePanel />);
    expect(screen.getByRole('alert')).toHaveTextContent('Evidence service unavailable');
    await user.click(within(screen.getByRole('region', { name: 'Spec A — Testing' })).getByRole('button', { name: 'Retry' }));
    expect(mocks.lifecycle.refresh).toHaveBeenCalled();
  });
});
