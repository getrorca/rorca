/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalEvent } from '../useWalSSE';
import type {
  LifecycleEvidenceDetail,
  LifecyclePhaseResponse,
  LifecyclePortfolioResponse,
  LifecycleSavedView,
  LifecycleSpecResponse,
} from '../../types/lifecycle';
import {
  DEFAULT_LIFECYCLE_URL_STATE,
  LIFECYCLE_DISPLAY_PREFERENCES_KEY,
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
import { ApiError } from '../../lib/apiFetch';

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
      owner: null, storySummary: { total: 2, passed: 1, failed: 0 }, currentPhaseId: 'testing', blocked: false, blockers: [],
      liveness: null, currentRevision: { specVersion: '1', inputHash: 'sha256:input', planVersion: 1 }, phases: [],
      snapshotId: snapshot, ...MARKS, updatedAt: '2026-07-15T00:00:00.000Z',
      delivery: { status: 'in_progress', rationale: 'Current delivery run is active.', reconciledAt: null },
      assurance: { status: 'partial', passedControls: 1, totalControls: 7, coverage: 1 / 7, rationale: 'Assurance is partial.' },
      reconciliation: null,
    }],
    total: 1, hasMore: false, workspace: { id: workspace, label: workspace }, phaseOrder: [], stageProfile: null, snapshotId: `set:${snapshot}`, ...MARKS,
    kpis: {
      specs: 1, activeSpecs: 1, evaluatedSpecs: 1, needsCompilation: 0, blockedSpecs: 0,
      deliveredSpecs: 0, inProgressSpecs: 1, needsReconciliation: 1, assuranceComplete: 0,
      missingGates: 2, specsWithBlockers: 0, readyForQa: 1, waitingApprovals: 0, recentPhaseTransitions: 3, stories: 2,
      phases: {
        total: 7, excluded: 0, denominator: 7, passed: 1, completionRate: 1 / 7,
        byStatus: { not_started: 5, in_progress: 1, blocked: 0, awaiting_approval: 0, passed: 1, deferred: 0, not_applicable: 0, stale: 0 },
      },
    },
  };
}

function spec(snapshot = SNAPSHOT): LifecycleSpecResponse {
  return {
    workspaceId: mocks.workspaceId ?? 'none', specId: 'spec-a', title: 'Spec A', state: 'current', stale: false,
    plan: null, provenance: {}, overallReadiness: { ready: false, completionRate: 0.2, counts: null }, phaseTimeline: [],
    delivery: { status: 'in_progress', rationale: 'Current delivery run is active.', reconciledAt: null },
    assurance: { status: 'partial', passedControls: 1, totalControls: 7, coverage: 1 / 7, rationale: 'Assurance is partial.' },
    reconciliation: null,
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
    workspaceId: mocks.workspaceId ?? 'none', specId: 'spec-a', phaseId: 'testing', state: 'current', status: 'in_progress',
    disposition: 'required', whyRequired: 'QA is required', mappedRequirements: { items: [], total: 0, truncated: false },
    mappedDecisions: { items: [], total: 0, truncated: false }, mappedStories: { items: [], total: 0, truncated: false },
    governedDecisions: { items: [], total: 0, truncated: false }, requiredGates: { items: [], total: 0, truncated: false },
    evidence: { items: [], total: 0, hasMore: false }, blocker: null,
    nextSafeActionGuidance: { action: 'Run QA', rationale: 'QA has not completed.', confidence: 0.95, classifier: 'phase_evaluator' },
    nextSafeAction: 'Run QA', permittedActions: ['run_phase'],
    evaluationSnapshot: { snapshotId: snapshot, ...MARKS }, snapshotId: snapshot, ...MARKS,
  };
}

function evidence(excerpt = 'original audited evidence', snapshot = SNAPSHOT): LifecycleEvidenceDetail {
  return {
    id: '7', workspaceId: 'ws-1', specId: 'spec-a', scope: { workspaceId: 'ws-1', specSlug: 'spec-a', runId: 42, storyId: 'US-001', phaseId: 'testing', gateId: 'gate-qa' },
    source: { type: 'github_check', system: 'GitHub', eventId: 'check-7' }, observedAt: '2026-07-15T00:00:00.000Z', createdAt: '2026-07-15T00:00:01.000Z',
    subject: { type: 'commit_sha', value: 'abc123' }, phaseSubject: null, releaseIdentity: { commitSha: 'abc123', artifactDigest: null, deploymentId: null },
    classification: 'testing', status: 'passed', trustLevel: 'provider_verified', confidence: 1, excerpt, actor: null, rationale: null,
    expiresAt: null, environment: null, redactionState: 'normalized_redacted', details: {}, provenanceChain: [], revisionMismatch: false,
    eligibleForActiveGate: true, invalidReasons: [], lineageVerified: true, payloadHash: 'sha256:payload', sourcePayloadHash: null,
    rawReference: { available: true, accessTier: 'auth', allowed: true, kind: 'run', label: 'Open authorized run', reference: 'run-output-chunks:42', href: '/runs/42', external: false, rawPayloadIncluded: false },
    snapshotId: snapshot, ...MARKS,
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

function snapshotConflict(currentSnapshotId: string): ApiError {
  return new ApiError(
    409,
    'CONFLICT',
    'Lifecycle evaluation snapshot is stale; refresh before acting',
    {
      type: 'refresh_required',
      requestedSnapshotId: SNAPSHOT,
      currentSnapshotId,
      ...MARKS,
    },
  );
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
      'search=release&status=blocked&specStatus=approved&phase=security&risk=critical&owner=u1&blocked=true&disposition=required&sort=risk_desc&page=4&limit=50&compact=1&mode=matrix&spec=spec-a&phaseDetail=qa',
    ));
    expect(parseLifecycleUrlState(serializeLifecycleUrlState(parsed))).toEqual(parsed);
  });

  it('defaults to Explorer and serializes Matrix as explicit URL state', () => {
    expect(parseLifecycleUrlState(new URLSearchParams()).mode).toBe('explorer');
    expect(serializeLifecycleUrlState({ ...DEFAULT_LIFECYCLE_URL_STATE, mode: 'matrix' }).get('mode')).toBe('matrix');
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

  it('persists compact and blocked-only strictly as local display preferences', async () => {
    const first = renderHook(() => useLifecycle(), { wrapper: wrapper() });
    await waitFor(() => expect(first.result.current.portfolio.data).not.toBeNull());
    act(() => {
      first.result.current.setCompact(true);
      first.result.current.updateFilters({ blocked: true });
    });
    await waitFor(() => expect(JSON.parse(localStorage.getItem(LIFECYCLE_DISPLAY_PREFERENCES_KEY) ?? '{}')).toEqual({
      compact: true,
      blockedOnly: true,
    }));
    first.unmount();

    const second = renderHook(() => useLifecycle(), { wrapper: wrapper() });
    await waitFor(() => expect(second.result.current.filters.blocked).toBe(true));
    expect(second.result.current.urlState.compact).toBe(true);
  });

  it('renames saved views without retaining lifecycle truth fields', async () => {
    const { result } = renderHook(() => useLifecycle(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.portfolio.data).not.toBeNull());
    let id = '';
    act(() => { id = result.current.saveView('My view').id; });
    act(() => result.current.renameSavedView(id, 'Renamed view'));
    await waitFor(() => expect(result.current.savedViews.find((view) => view.id === id)?.name).toBe('Renamed view'));
    expect(JSON.stringify(JSON.parse(localStorage.getItem(LIFECYCLE_SAVED_VIEWS_KEY) ?? '{}'))).not.toContain('evidence');
  });

  it('computes targeted lifecycle SSE invalidation', () => {
    const event: WalEvent = {
      id: 1, ts: '', event_type: 'lifecycle_changed', workspace_id: 'ws-1', spec_id: 'spec-a', story_id: null, actor: 'test',
      payload: JSON.stringify({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing', changeKind: 'evidence_persisted' }),
    };
    expect(lifecycleInvalidationTargets(event, 'ws-1', 'spec-a', 'testing')).toEqual({ portfolio: true, detail: true, phase: true, evidence: true });
    expect(lifecycleInvalidationTargets(event, 'ws-2', 'spec-a', 'testing').portfolio).toBe(false);
    expect(lifecycleInvalidationTargets({
      ...event,
      payload: { workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'maintenance', changeKind: 'evidence_persisted' } as unknown as string,
    }, 'ws-1', 'spec-a', 'maintenance')).toEqual({ portfolio: true, detail: true, phase: true, evidence: true });
    expect(lifecycleInvalidationTargets(event, 'ws-1', 'other', 'testing')).toEqual({ portfolio: true, detail: false, phase: false, evidence: false });
    expect(lifecycleInvalidationTargets({
      ...event,
      event_type: 'decision_recorded',
      payload: JSON.stringify({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing', changeKind: 'decision_created' }),
    }, 'ws-1', 'spec-a', 'testing')).toEqual({ portfolio: true, detail: true, phase: true, evidence: false });
  });
});

describe('useLifecycle controller', () => {
  it('opens canonical spec and phase deep links after lifecycle data loads', async () => {
    const { result } = renderHook(() => useLifecycle(), { wrapper: wrapper('/lifecycle?spec=spec-a&phase=testing') });
    await waitFor(() => expect(mockPhase).toHaveBeenCalledWith(
      'ws-1', 'spec-a', 'testing', expect.any(Object), expect.any(String), expect.any(Object),
    ));
    await waitFor(() => expect(result.current.phase.data?.phaseId).toBe('testing'));
    expect(result.current.urlState.selectedSpecId).toBe('spec-a');
    expect(result.current.urlState.selectedPhaseId).toBe('testing');
  });

  it('automatically adopts a spec conflict snapshot and recovers without an error state', async () => {
    const adoptedSnapshot = 'sha256:two';
    let portfolioCalls = 0;
    mockPortfolio.mockImplementation(async (workspaceId) => (
      portfolio(workspaceId, portfolioCalls++ === 0 ? SNAPSHOT : adoptedSnapshot)
    ));
    mockSpec.mockRejectedValueOnce(snapshotConflict(adoptedSnapshot)).mockResolvedValue(spec(adoptedSnapshot));

    const { result } = renderHook(() => useLifecycle(), { wrapper: wrapper('/lifecycle?spec=spec-a') });

    await waitFor(() => expect(mockSpec.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(mockSpec.mock.calls[0][2]).toBe(SNAPSHOT);
    expect(mockSpec.mock.calls[1][2]).toBe(adoptedSnapshot);
    await waitFor(() => expect(result.current.selectedSpec.data?.snapshotId).toBe(adoptedSnapshot));
    expect(result.current.selectedSpec.error).toBeNull();
  });

  it('uses each newer server snapshot across two conflicts before succeeding', async () => {
    const secondSnapshot = 'sha256:two';
    const thirdSnapshot = 'sha256:three';
    let portfolioCalls = 0;
    mockPortfolio.mockImplementation(async (workspaceId) => (
      portfolio(workspaceId, portfolioCalls++ === 0 ? SNAPSHOT : thirdSnapshot)
    ));
    mockSpec
      .mockRejectedValueOnce(snapshotConflict(secondSnapshot))
      .mockRejectedValueOnce(snapshotConflict(thirdSnapshot))
      .mockResolvedValue(spec(thirdSnapshot));

    const { result } = renderHook(() => useLifecycle(), { wrapper: wrapper('/lifecycle?spec=spec-a') });

    await waitFor(() => expect(mockSpec.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(mockSpec.mock.calls[0][2]).toBe(SNAPSHOT);
    expect(mockSpec.mock.calls[1][2]).toBe(secondSnapshot);
    expect(mockSpec.mock.calls[2][2]).toBe(thirdSnapshot);
    await waitFor(() => expect(result.current.selectedSpec.data?.snapshotId).toBe(thirdSnapshot));
    expect(result.current.selectedSpec.error).toBeNull();
  });

  it('shows the error state after three conflicts and allows an explicit retry', async () => {
    const adoptedSnapshot = 'sha256:exhausted';
    mockSpec.mockRejectedValue(snapshotConflict(adoptedSnapshot));
    const { result } = renderHook(() => useLifecycle(), { wrapper: wrapper('/lifecycle?spec=spec-a') });

    await waitFor(() => expect(result.current.selectedSpec.error).toBeInstanceOf(ApiError));
    expect(mockSpec).toHaveBeenCalledTimes(3);

    mockPortfolio.mockImplementation(async (workspaceId) => portfolio(workspaceId, adoptedSnapshot));
    mockSpec.mockReset().mockResolvedValue(spec(adoptedSnapshot));
    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.selectedSpec.data?.snapshotId).toBe(adoptedSnapshot));
    expect(result.current.selectedSpec.error).toBeNull();
  });

  it('does not retry an aborted spec request', async () => {
    const pending = deferred<LifecycleSpecResponse>();
    mockSpec.mockImplementation((_workspaceId, _specId, _snapshotId, options) => {
      options?.signal?.addEventListener('abort', () => {
        pending.reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
      return pending.promise;
    });
    const { unmount } = renderHook(() => useLifecycle(), { wrapper: wrapper('/lifecycle?spec=spec-a') });
    await waitFor(() => expect(mockSpec).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => { await Promise.resolve(); });

    expect(mockSpec).toHaveBeenCalledTimes(1);
  });

  it('self-heals a phase conflict and pins evidence to the adopted snapshot', async () => {
    const adoptedSnapshot = 'sha256:phase-two';
    let portfolioCalls = 0;
    mockPortfolio.mockImplementation(async (workspaceId) => (
      portfolio(workspaceId, portfolioCalls++ === 0 ? SNAPSHOT : adoptedSnapshot)
    ));
    mockSpec.mockImplementation(async (_workspaceId, _specId, expectedSnapshotId) => (
      spec(expectedSnapshotId ?? SNAPSHOT)
    ));
    mockPhase.mockRejectedValueOnce(snapshotConflict(adoptedSnapshot)).mockResolvedValue(phase(adoptedSnapshot));
    mockEvidence.mockResolvedValue(evidence('adopted snapshot evidence', adoptedSnapshot));

    const { result } = renderHook(() => useLifecycle(), {
      wrapper: wrapper('/lifecycle?spec=spec-a&phase=testing&evidence=7'),
    });

    await waitFor(() => expect(mockPhase.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(mockPhase.mock.calls[0][4]).toBe(SNAPSHOT);
    expect(mockPhase.mock.calls[1][4]).toBe(adoptedSnapshot);
    await waitFor(() => expect(result.current.phase.data?.snapshotId).toBe(adoptedSnapshot));
    await waitFor(() => expect(result.current.evidence.data?.snapshotId).toBe(adoptedSnapshot));
    expect(mockEvidence).toHaveBeenLastCalledWith('ws-1', '7', adoptedSnapshot, expect.any(Object));
    expect(result.current.selectedEvidenceSnapshotId).toBe(adoptedSnapshot);
  });

  it('consumes an evidence deep link only after the selected phase snapshot is available', async () => {
    mockEvidence.mockResolvedValue(evidence('deep-linked audited evidence'));
    const { result } = renderHook(() => useLifecycle(), {
      wrapper: wrapper('/lifecycle?spec=spec-a&phase=testing&evidence=7'),
    });
    await waitFor(() => expect(result.current.phase.data?.snapshotId).toBe(SNAPSHOT));
    await waitFor(() => expect(result.current.selectedEvidenceId).toBe('7'));
    await waitFor(() => expect(result.current.evidence.data?.excerpt).toBe('deep-linked audited evidence'));
    expect(mockEvidence).toHaveBeenLastCalledWith('ws-1', '7', SNAPSHOT, expect.any(Object));
  });

  it('preserves an evidence deep link while applying a persisted blocked-only preference', async () => {
    localStorage.setItem(LIFECYCLE_DISPLAY_PREFERENCES_KEY, JSON.stringify({ compact: false, blockedOnly: true }));
    mockEvidence.mockResolvedValue(evidence('blocked preference deep-linked evidence'));
    const { result } = renderHook(() => useLifecycle(), {
      wrapper: wrapper('/lifecycle?spec=spec-a&phase=testing&evidence=7'),
    });
    await waitFor(() => expect(result.current.filters.blocked).toBe(true));
    await waitFor(() => expect(result.current.phase.data?.snapshotId).toBe(SNAPSHOT));
    await waitFor(() => expect(result.current.selectedEvidenceId).toBe('7'));
    await waitFor(() => expect(result.current.evidence.data?.excerpt).toBe('blocked preference deep-linked evidence'));
    expect(mockEvidence).toHaveBeenLastCalledWith('ws-1', '7', SNAPSHOT, expect.any(Object));
  });

  it('pins an open inspector and does not silently replace it after evidence invalidation', async () => {
    mockEvidence.mockResolvedValue(evidence());
    const { result } = renderHook(() => useLifecycle({ sseDebounceMs: 0 }), { wrapper: wrapper('/lifecycle?spec=spec-a&phase=testing') });
    await waitFor(() => expect(result.current.phase.data?.snapshotId).toBe(SNAPSHOT));
    act(() => result.current.openEvidence('7'));
    await waitFor(() => expect(result.current.evidence.data?.excerpt).toBe('original audited evidence'));
    expect(mockEvidence).toHaveBeenLastCalledWith('ws-1', '7', SNAPSHOT, expect.any(Object));
    const evidenceCalls = mockEvidence.mock.calls.length;

    act(() => mocks.sse?.({
      id: 99, ts: '', event_type: 'lifecycle_changed', workspace_id: 'ws-1', spec_id: 'spec-a', story_id: 'US-001', actor: 'test',
      payload: JSON.stringify({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing', changeKind: 'evidence_persisted' }),
    }));
    await waitFor(() => expect(result.current.evidence.stale).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockEvidence).toHaveBeenCalledTimes(evidenceCalls);
    expect(result.current.evidence.data?.excerpt).toBe('original audited evidence');

    mockEvidence.mockResolvedValueOnce(evidence('explicitly refreshed evidence'));
    act(() => result.current.refreshEvidence());
    await waitFor(() => expect(mockEvidence).toHaveBeenCalledTimes(evidenceCalls + 1));
  });

  it('clears an invalid phase selection without requesting phase data', async () => {
    const { result } = renderHook(() => useLifecycle(), { wrapper: wrapper('/lifecycle?spec=spec-a&phase=unknown') });
    await waitFor(() => expect(result.current.urlState.selectedSpecId).toBeNull());
    expect(result.current.urlState.selectedPhaseId).toBeNull();
    expect(mockPhase).not.toHaveBeenCalled();
  });

  it('drives pagination from the URL, preserves filters across pages, and resets page for filter changes', async () => {
    const { result } = renderHook(() => useLifecycle(), {
      wrapper: wrapper('/lifecycle?page=3&limit=10&status=blocked&risk=high'),
    });
    await waitFor(() => expect(mockPortfolio).toHaveBeenCalled());
    expect(mockPortfolio.mock.calls[0][2]).toEqual({ page: 3, limit: 10 });
    act(() => result.current.setPage(4));
    await waitFor(() => expect(result.current.pagination.page).toBe(4));
    expect(result.current.filters).toEqual(expect.objectContaining({ status: 'blocked', risk: 'high' }));
    act(() => result.current.updateFilters({ phase: 'testing' }));
    await waitFor(() => expect(result.current.pagination.page).toBe(1));
    expect(result.current.filters).toEqual(expect.objectContaining({ status: 'blocked', risk: 'high', phase: 'testing' }));
  });

  it('reuses a fresh prefetched portfolio without issuing a duplicate filter request', async () => {
    const { result } = renderHook(() => useLifecycle(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.portfolio.data).not.toBeNull());
    mockPortfolio.mockClear();
    const prefetched = { ...portfolio(), total: 7 };
    mockPortfolio.mockResolvedValueOnce(prefetched);

    await act(async () => {
      await result.current.prefetchFilters({ blocked: true });
    });
    expect(mockPortfolio).toHaveBeenCalledTimes(1);
    expect(mockPortfolio).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ blocked: true }),
      { page: 1, limit: 25 },
      expect.objectContaining({ silent: true }),
    );

    act(() => result.current.updateFilters({ blocked: true }));
    await waitFor(() => expect(result.current.filters.blocked).toBe(true));
    await waitFor(() => expect(result.current.portfolio.data?.total).toBe(7));
    expect(result.current.portfolio.refreshing).toBe(false);
    expect(result.current.portfolio.stale).toBe(false);
    expect(mockPortfolio).toHaveBeenCalledTimes(1);
  });

  it('deduplicates and safely contains failed best-effort prefetches', async () => {
    const { result } = renderHook(() => useLifecycle(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.portfolio.data).not.toBeNull());
    mockPortfolio.mockClear();
    const pending = deferred<LifecyclePortfolioResponse>();
    mockPortfolio.mockImplementationOnce(() => pending.promise);

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.prefetchFilters({ status: 'awaiting_approval' });
      second = result.current.prefetchFilters({ status: 'awaiting_approval' });
    });
    expect(mockPortfolio).toHaveBeenCalledTimes(1);
    pending.reject(new Error('Prefetch unavailable'));
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it('clears drawer selections on workspace switching and ignores the obsolete response', async () => {
    const old = deferred<LifecyclePortfolioResponse>();
    mockPortfolio.mockImplementationOnce(() => old.promise).mockImplementation(async (workspaceId) => portfolio(workspaceId));
    const { result, rerender } = renderHook(() => useLifecycle(), { wrapper: wrapper('/lifecycle?spec=spec-a&phase=testing') });
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

  it('preserves the last successful data and timestamp when refresh fails', async () => {
    mockPortfolio.mockResolvedValueOnce(portfolio()).mockRejectedValueOnce(new Error('Refresh unavailable'));
    const { result } = renderHook(() => useLifecycle(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.lastSuccessfulRefresh).not.toBeNull());
    const successfulAt = result.current.lastSuccessfulRefresh;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.portfolio.error?.message).toBe('Refresh unavailable'));
    expect(result.current.portfolio.data?.items[0].title).toBe('Spec A');
    expect(result.current.lastSuccessfulRefresh).toBe(successfulAt);
  });

  it('coalesces duplicate SSE events and refetches only selected queries', async () => {
    renderHook(() => useLifecycle({ sseDebounceMs: 0 }), { wrapper: wrapper('/lifecycle?spec=spec-a&phase=testing') });
    await waitFor(() => expect(mockPhase).toHaveBeenCalled());
    const before = {
      portfolio: mockPortfolio.mock.calls.length,
      spec: mockSpec.mock.calls.length,
      phase: mockPhase.mock.calls.length,
    };
    const event: WalEvent = {
      id: 42, ts: '', event_type: 'lifecycle_changed', workspace_id: 'ws-1', spec_id: 'spec-a', story_id: null, actor: 'test',
      payload: JSON.stringify({ workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing', changeKind: 'decision_created' }),
    };
    act(() => { mocks.sse?.(event); mocks.sse?.(event); });
    await waitFor(() => expect(mockPortfolio).toHaveBeenCalledTimes(before.portfolio + 1));
    expect(mockSpec).toHaveBeenCalledTimes(before.spec + 1);
    expect(mockPhase).toHaveBeenCalledTimes(before.phase + 1);
    expect(mockEvidence).not.toHaveBeenCalled();
  });

  it('discards a mixed phase snapshot and performs one bounded coordinated refetch', async () => {
    mockPhase.mockResolvedValue(phase('sha256:mixed'));
    const { result } = renderHook(() => useLifecycle({ sseDebounceMs: 0 }), { wrapper: wrapper('/lifecycle?spec=spec-a&phase=testing') });
    await waitFor(() => expect(mockPortfolio).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockPortfolio).toHaveBeenCalledTimes(2);
    expect(result.current.phase.data).toBeNull();
    expect(result.current.snapshotConsistent).toBe(true);
  });
});
