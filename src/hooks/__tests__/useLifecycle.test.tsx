/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalEvent } from '../useWalSSE';
import type {
  LifecyclePhaseResponse,
  LifecyclePortfolioResponse,
  LifecycleSavedView,
  LifecycleSpecResponse,
} from '../../types/lifecycle';
import {
  LIFECYCLE_SAVED_VIEWS_KEY,
  lifecycleInvalidationTargets,
  loadLifecycleSavedViews,
  parseLifecycleUrlState,
  saveLifecycleSavedViews,
  serializeLifecycleUrlState,
  useLifecycle,
} from '../useLifecycle';
import {
  getLifecycleEvidence,
  getLifecyclePhase,
  getLifecyclePortfolio,
  getLifecycleSpec,
} from '../../api/lifecycle';

const mocks = vi.hoisted(() => ({
  workspaceId: 'ws-1' as string | null,
  sse: null as ((event: WalEvent) => void) | null,
}));

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: mocks.workspaceId }),
}));
vi.mock('../useWalSSE', () => ({
  useWalSSE: (callback: (event: WalEvent) => void) => { mocks.sse = callback; },
}));
vi.mock('../../api/lifecycle', () => ({
  getLifecyclePortfolio: vi.fn(),
  getLifecycleSpec: vi.fn(),
  getLifecyclePhase: vi.fn(),
  getLifecycleEvidence: vi.fn(),
  recompileLifecycleSpec: vi.fn(),
  recordLifecycleDecision: vi.fn(),
  revokeLifecycleDecision: vi.fn(),
}));

const mockPortfolio = vi.mocked(getLifecyclePortfolio);
const mockSpec = vi.mocked(getLifecycleSpec);
const mockPhase = vi.mocked(getLifecyclePhase);
const mockEvidence = vi.mocked(getLifecycleEvidence);
const SNAPSHOT = 'sha256:one';
const MARKS = { evidenceHighWaterMark: 'evidence:1', decisionHighWaterMark: 'decision:1' };

function portfolio(workspace = mocks.workspaceId ?? 'none', snapshot = SNAPSHOT): LifecyclePortfolioResponse {
  return {
    items: [{
      specId: 'spec-a', title: 'Spec A', specStatus: 'approved', state: 'current', overallStatus: 'in_progress', risk: 'high',
      owner: null, storySummary: { total: 2, passed: 1, failed: 0 }, currentPhaseId: 'qa', blocked: false, blockers: [],
      liveness: null, currentRevision: { specVersion: '1', inputHash: 'sha256:input', planVersion: 1 }, phases: [],
      snapshotId: snapshot, ...MARKS, updatedAt: '2026-07-15T00:00:00.000Z',
    }],
    total: 1, hasMore: false, workspace: { id: workspace, label: workspace }, phaseOrder: [], snapshotId: `set:${snapshot}`, ...MARKS,
    kpis: {
      specs: 1, evaluatedSpecs: 1, needsCompilation: 0, blockedSpecs: 0, stories: 2,
      phases: {
        total: 11, excluded: 0, denominator: 11, passed: 1, completionRate: 1 / 11,
        byStatus: { not_started: 9, in_progress: 1, blocked: 0, awaiting_approval: 0, passed: 1, deferred: 0, not_applicable: 0, stale: 0 },
      },
    },
  };
}

function spec(snapshot = SNAPSHOT): LifecycleSpecResponse {
  return {
    workspaceId: mocks.workspaceId ?? 'none', specId: 'spec-a', title: 'Spec A', state: 'current', stale: false,
    plan: null, provenance: {}, overallReadiness: { ready: false, completionRate: 0.2, counts: null }, phaseTimeline: [],
    traceability: {
      requirements: { items: [], total: 0, truncated: false }, stories: { items: [], total: 0, truncated: false },
      architectureDecisions: { items: [], total: 0, truncated: false }, gates: { items: [], total: 0, truncated: false },
      evidence: { total: 1, validForCurrentRevision: 1, stale: 0, boundedAt: 500 },
    },
    currentRun: null, evaluationSnapshot: { snapshotId: snapshot, ...MARKS }, snapshotId: snapshot, ...MARKS,
  };
}

function phase(snapshot = SNAPSHOT): LifecyclePhaseResponse {
  return {
    workspaceId: mocks.workspaceId ?? 'none', specId: 'spec-a', phaseId: 'qa', state: 'current', status: 'in_progress',
    disposition: 'required', whyRequired: 'QA is required', mappedRequirements: { items: [], total: 0, truncated: false },
    mappedDecisions: { items: [], total: 0, truncated: false }, mappedStories: { items: [], total: 0, truncated: false },
    governedDecisions: { items: [], total: 0, truncated: false }, requiredGates: { items: [], total: 0, truncated: false },
    evidence: { items: [], total: 0, hasMore: false }, blocker: null, nextSafeAction: 'Run QA', permittedActions: ['run_phase'],
    evaluationSnapshot: { snapshotId: snapshot, ...MARKS }, snapshotId: snapshot, ...MARKS,
  };
}

function wrapper(initialEntry = '/lifecycle') {
  return function TestRouter({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.workspaceId = 'ws-1';
  mocks.sse = null;
  mockPortfolio.mockReset().mockImplementation(async (workspaceId) => portfolio(workspaceId));
  mockSpec.mockReset().mockResolvedValue(spec());
  mockPhase.mockReset().mockResolvedValue(phase());
  mockEvidence.mockReset().mockImplementation(() => new Promise(() => undefined));
  localStorage.clear();
});

describe('lifecycle URL and saved display state', () => {
  it('round-trips search, filters, sort, page, compact mode, spec, and phase', () => {
    const parsed = parseLifecycleUrlState(new URLSearchParams(
      'search=release&status=blocked&specStatus=approved&phase=security&risk=critical&owner=u1&blocked=true&disposition=required&sort=risk_desc&page=4&limit=50&compact=1&spec=spec-a&phaseDetail=qa',
    ));
    expect(parseLifecycleUrlState(serializeLifecycleUrlState(parsed))).toEqual(parsed);
  });

  it('migrates legacy local storage, bounds views, and strips lifecycle truth', () => {
    localStorage.setItem(LIFECYCLE_SAVED_VIEWS_KEY, JSON.stringify({
      version: 1,
      views: Array.from({ length: 20 }, (_, index) => ({
        name: `View ${index}`, filters: { status: 'blocked', evidence: [{ secret: true }], approval: 'granted' },
        compact: true, pageSize: 500, evidence: { payload: 'must-not-persist' },
      })),
    }));
    const migrated = loadLifecycleSavedViews(localStorage);
    expect(migrated.version).toBe(2);
    expect(migrated.views).toHaveLength(12);
    expect(migrated.views[0].display).toEqual({ compact: true, limit: 100 });
    expect(JSON.stringify(migrated)).not.toContain('must-not-persist');
    expect(JSON.stringify(migrated)).not.toContain('approval');

    const repeated: LifecycleSavedView[] = Array.from({ length: 30 }, (_, index) => ({
      id: String(index), name: `Saved ${index}`, filters: { sort: 'current_view' }, display: { compact: false, limit: 25 }, updatedAt: new Date(0).toISOString(),
    }));
    expect(saveLifecycleSavedViews(localStorage, repeated).views).toHaveLength(12);
  });

  it('computes targeted lifecycle SSE invalidation', () => {
    const event: WalEvent = {
      id: 1, ts: '', event_type: 'lifecycle_changed', workspace_id: 'ws-1', spec_id: 'spec-a', story_id: null, actor: 'test',
      payload: JSON.stringify({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'qa', changeKind: 'evidence_persisted' }),
    };
    expect(lifecycleInvalidationTargets(event, 'ws-1', 'spec-a', 'qa')).toEqual({ portfolio: true, detail: true, phase: true, evidence: true });
    expect(lifecycleInvalidationTargets(event, 'ws-2', 'spec-a', 'qa').portfolio).toBe(false);
    expect(lifecycleInvalidationTargets(event, 'ws-1', 'other', 'qa')).toEqual({ portfolio: true, detail: false, phase: false, evidence: false });
    expect(lifecycleInvalidationTargets({
      ...event,
      event_type: 'decision_recorded',
      payload: JSON.stringify({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'qa', changeKind: 'decision_created' }),
    }, 'ws-1', 'spec-a', 'qa')).toEqual({ portfolio: true, detail: true, phase: true, evidence: false });
  });
});

describe('useLifecycle controller', () => {
  it('drives pagination from the URL', async () => {
    renderHook(() => useLifecycle(), { wrapper: wrapper('/lifecycle?page=3&limit=10') });
    await waitFor(() => expect(mockPortfolio).toHaveBeenCalled());
    expect(mockPortfolio.mock.calls[0][2]).toEqual({ page: 3, limit: 10 });
  });

  it('clears drawer selections on workspace switching and ignores the obsolete response', async () => {
    const old = deferred<LifecyclePortfolioResponse>();
    mockPortfolio.mockImplementationOnce(() => old.promise).mockImplementation(async (workspaceId) => portfolio(workspaceId));
    const { result, rerender } = renderHook(() => useLifecycle(), { wrapper: wrapper('/lifecycle?spec=spec-a&phaseDetail=qa') });
    act(() => result.current.openEvidence('7'));

    mocks.workspaceId = 'ws-2';
    rerender();
    await waitFor(() => expect(result.current.urlState.selectedSpecId).toBeNull());
    await waitFor(() => expect(result.current.portfolio.data?.workspace.id).toBe('ws-2'));
    old.resolve(portfolio('ws-1'));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.portfolio.data?.workspace.id).toBe('ws-2');
    expect(result.current.selectedEvidenceId).toBeNull();
  });

  it('preserves readable data with stale/refreshing state during refresh', async () => {
    const next = deferred<LifecyclePortfolioResponse>();
    mockPortfolio.mockResolvedValueOnce(portfolio()).mockImplementationOnce(() => next.promise);
    const { result } = renderHook(() => useLifecycle(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.portfolio.data).not.toBeNull());

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.portfolio.refreshing).toBe(true));
    expect(result.current.portfolio.data?.items[0].title).toBe('Spec A');
    expect(result.current.portfolio.stale).toBe(true);
    next.resolve(portfolio());
    await waitFor(() => expect(result.current.portfolio.refreshing).toBe(false));
  });

  it('coalesces duplicate SSE events and refetches only selected queries', async () => {
    renderHook(() => useLifecycle({ sseDebounceMs: 0 }), { wrapper: wrapper('/lifecycle?spec=spec-a&phaseDetail=qa') });
    await waitFor(() => expect(mockPhase).toHaveBeenCalled());
    const before = {
      portfolio: mockPortfolio.mock.calls.length,
      spec: mockSpec.mock.calls.length,
      phase: mockPhase.mock.calls.length,
    };
    const event: WalEvent = {
      id: 42, ts: '', event_type: 'lifecycle_changed', workspace_id: 'ws-1', spec_id: 'spec-a', story_id: null, actor: 'test',
      payload: JSON.stringify({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'qa', changeKind: 'decision_created' }),
    };
    act(() => { mocks.sse?.(event); mocks.sse?.(event); });
    await waitFor(() => expect(mockPortfolio).toHaveBeenCalledTimes(before.portfolio + 1));
    expect(mockSpec).toHaveBeenCalledTimes(before.spec + 1);
    expect(mockPhase).toHaveBeenCalledTimes(before.phase + 1);
    expect(mockEvidence).not.toHaveBeenCalled();
  });

  it('discards a mixed phase snapshot and performs one bounded coordinated refetch', async () => {
    mockPhase.mockResolvedValue(phase('sha256:mixed'));
    const { result } = renderHook(() => useLifecycle({ sseDebounceMs: 0 }), { wrapper: wrapper('/lifecycle?spec=spec-a&phaseDetail=qa') });
    await waitFor(() => expect(mockPortfolio).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPortfolio).toHaveBeenCalledTimes(2);
    expect(result.current.phase.data).toBeNull();
    expect(result.current.snapshotConsistent).toBe(true);
  });
});
