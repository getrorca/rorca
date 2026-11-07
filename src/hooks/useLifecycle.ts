/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  getLifecycleEvidence,
  getLifecyclePhase,
  getLifecyclePortfolio,
  getLifecycleSpec,
  recordLifecycleDecision,
  recompileLifecycleSpec,
  revokeLifecycleDecision,
} from '../api/lifecycle';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { ApiError } from '../lib/apiFetch';
import { entityRoute } from '../lib/entityRoutes';
import { MISSION_CONTRACT_VERSIONS } from '../../shared/contracts/mission';
import type { WalEvent } from './useWalSSE';
import { useWalSSE } from './useWalSSE';
import {
  LIFECYCLE_PHASE_IDS,
  LIFECYCLE_STAGES,
  type LifecycleDecisionMutationResult,
  type LifecycleEvidenceDetail,
  type LifecycleMissionStage,
  type LifecycleMutationResult,
  type LifecyclePhaseId,
  type LifecyclePhaseResponse,
  type LifecyclePortfolioFilters,
  type LifecyclePortfolioResponse,
  type LifecycleQueryState,
  type LifecycleSavedView,
  type LifecycleSavedViewsEnvelope,
  type LifecycleSnapshotRef,
  type LifecycleSpecResponse,
  type LifecycleUrlState,
  type RecordLifecycleDecisionInput,
} from '../types/lifecycle';

export const LIFECYCLE_SAVED_VIEWS_KEY = 'rorca.lifecycle.savedViews';
export const LIFECYCLE_SAVED_VIEWS_VERSION = 2 as const;
export const LIFECYCLE_SAVED_VIEWS_LIMIT = 12;
export const LIFECYCLE_DISPLAY_PREFERENCES_KEY = 'rorca.lifecycle.displayPreferences';
const SAVED_VIEWS_BYTE_LIMIT = 32_768;
const DEFAULT_LIMIT = 25;
const PORTFOLIO_CACHE_LIMIT = 16;
const PORTFOLIO_CACHE_REUSE_MS = 5_000;
const PORTFOLIO_CACHE_STALE_MS = 30_000;
const SNAPSHOT_DETAIL_MAX_ATTEMPTS = 3;
const SNAPSHOT_DETAIL_BACKOFF_MS = [100, 250] as const;

interface LifecyclePortfolioCacheEntry {
  data: LifecyclePortfolioResponse;
  receivedAt: number;
}

function portfolioCacheKey(
  workspaceId: string,
  filters: LifecyclePortfolioFilters,
  page: number,
  limit: number,
  revision: number,
): string {
  return JSON.stringify([
    workspaceId,
    revision,
    page,
    limit,
    filters.search ?? null,
    filters.status ?? null,
    filters.specStatus ?? null,
    filters.phase ?? null,
    filters.stage ?? null,
    filters.risk ?? null,
    filters.owner ?? null,
    filters.blocked ?? null,
    filters.disposition ?? null,
    filters.sort,
  ]);
}

function withFilterPatch(
  filters: LifecyclePortfolioFilters,
  patch: Partial<LifecyclePortfolioFilters>,
): LifecyclePortfolioFilters {
  const next = { ...filters, ...patch } as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) delete next[key];
  }
  return { ...next, sort: typeof next.sort === 'string' ? next.sort : 'current_view' } as LifecyclePortfolioFilters;
}

export const DEFAULT_LIFECYCLE_URL_STATE: LifecycleUrlState = {
  sort: 'current_view',
  page: 1,
  limit: DEFAULT_LIMIT,
  compact: false,
  mode: 'explorer',
  selectedSpecId: null,
  selectedPhaseId: null,
};

const STATUSES = new Set(['not_started', 'in_progress', 'blocked', 'awaiting_approval', 'passed', 'deferred', 'not_applicable', 'stale', 'needs_compilation']);
const SPEC_STATUSES = new Set(['pending', 'approved', 'completed', 'rejected']);
const RISKS = new Set(['low', 'medium', 'high', 'critical']);
const DISPOSITIONS = new Set(['required', 'deferred', 'not_applicable']);
const SORTS = new Set(['current_view', 'updated_desc', 'title_asc', 'risk_desc', 'readiness_desc', 'owner_asc']);
const PHASES = new Set<string>(LIFECYCLE_PHASE_IDS);
const STAGES = new Set<string>(LIFECYCLE_STAGES.map((stage) => stage.id));

function positiveInteger(value: string | null, fallback: number, maximum: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  return Math.max(1, Math.min(Number(value), maximum));
}

export function parseLifecycleUrlState(params: URLSearchParams): LifecycleUrlState {
  const selectedSpecId = params.get('spec')?.slice(0, 128) || null;
  const phaseValue = params.get('phase');
  const filterPhaseValue = params.get('phaseFilter') ?? (!selectedSpecId ? phaseValue : null);
  const legacyPhaseDetail = params.get('phaseDetail');
  const selectedPhaseValue = selectedSpecId ? (legacyPhaseDetail ?? phaseValue) : legacyPhaseDetail;
  const state: LifecycleUrlState = {
    ...DEFAULT_LIFECYCLE_URL_STATE,
    page: positiveInteger(params.get('page'), 1, 10_000),
    limit: positiveInteger(params.get('limit'), DEFAULT_LIMIT, 100),
    compact: params.get('compact') === '1' || params.get('compact') === 'true',
    mode: params.get('mode') === 'matrix' ? 'matrix' : 'explorer',
    selectedSpecId,
    selectedPhaseId: PHASES.has(selectedPhaseValue ?? '') ? selectedPhaseValue as LifecyclePhaseId : null,
  };
  const search = params.get('search')?.trim();
  const status = params.get('status');
  const specStatus = params.get('specStatus');
  const phase = filterPhaseValue;
  const risk = params.get('risk');
  const owner = params.get('owner')?.trim();
  const disposition = params.get('disposition');
  const sort = params.get('sort');
  const blocked = params.get('blocked');
  if (search) state.search = search.slice(0, 200);
  if (status && STATUSES.has(status)) state.status = status as LifecyclePortfolioFilters['status'];
  if (specStatus && SPEC_STATUSES.has(specStatus)) state.specStatus = specStatus as LifecyclePortfolioFilters['specStatus'];
  // `phase` is the canonical drawer selection when `spec` is present; without
  // a selected spec it remains the portfolio phase filter for compatibility.
  if (phase && PHASES.has(phase)) state.phase = phase as LifecyclePhaseId;
  const stageValue = params.get('stage');
  if (stageValue && STAGES.has(stageValue)) state.stage = stageValue as LifecycleMissionStage;
  if (risk && RISKS.has(risk)) state.risk = risk as LifecyclePortfolioFilters['risk'];
  if (owner) state.owner = owner.slice(0, 256);
  if (blocked === 'true' || blocked === 'false') state.blocked = blocked === 'true';
  if (disposition && DISPOSITIONS.has(disposition)) state.disposition = disposition as LifecyclePortfolioFilters['disposition'];
  if (sort && SORTS.has(sort)) state.sort = sort as LifecyclePortfolioFilters['sort'];
  return state;
}

/** Serializes only lifecycle view state; caller-owned route parameters may be supplied as base. */
export function serializeLifecycleUrlState(state: LifecycleUrlState, base = new URLSearchParams()): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of ['search', 'status', 'specStatus', 'phase', 'phaseFilter', 'stage', 'risk', 'owner', 'blocked', 'disposition', 'sort', 'page', 'limit', 'compact', 'mode', 'spec', 'phaseDetail']) {
    params.delete(key);
  }
  if (state.search) params.set('search', state.search);
  if (state.status) params.set('status', state.status);
  if (state.specStatus) params.set('specStatus', state.specStatus);
  if (state.phase) params.set(state.selectedSpecId ? 'phaseFilter' : 'phase', state.phase);
  if (state.stage) params.set('stage', state.stage);
  if (state.risk) params.set('risk', state.risk);
  if (state.owner) params.set('owner', state.owner);
  if (state.blocked !== undefined) params.set('blocked', String(state.blocked));
  if (state.disposition) params.set('disposition', state.disposition);
  if (state.sort !== DEFAULT_LIFECYCLE_URL_STATE.sort) params.set('sort', state.sort);
  if (state.page !== 1) params.set('page', String(state.page));
  if (state.limit !== DEFAULT_LIMIT) params.set('limit', String(state.limit));
  if (state.compact) params.set('compact', '1');
  if (state.mode === 'matrix') params.set('mode', 'matrix');
  if (state.selectedSpecId) params.set('spec', state.selectedSpecId);
  if (state.selectedSpecId && state.selectedPhaseId) params.set('phase', state.selectedPhaseId);
  return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeFilters(value: unknown): LifecyclePortfolioFilters {
  if (!isRecord(value)) return { sort: 'current_view' };
  const params = new URLSearchParams();
  for (const key of ['search', 'status', 'specStatus', 'phase', 'stage', 'risk', 'owner', 'blocked', 'disposition', 'sort']) {
    const item = value[key];
    if (typeof item === 'string' || typeof item === 'boolean') params.set(key, String(item));
  }
  const parsed = parseLifecycleUrlState(params);
  return {
    sort: parsed.sort,
    ...(parsed.search ? { search: parsed.search } : {}),
    ...(parsed.status ? { status: parsed.status } : {}),
    ...(parsed.specStatus ? { specStatus: parsed.specStatus } : {}),
    ...(parsed.phase ? { phase: parsed.phase } : {}),
    ...(parsed.stage ? { stage: parsed.stage } : {}),
    ...(parsed.risk ? { risk: parsed.risk } : {}),
    ...(parsed.owner ? { owner: parsed.owner } : {}),
    ...(parsed.blocked !== undefined ? { blocked: parsed.blocked } : {}),
    ...(parsed.disposition ? { disposition: parsed.disposition } : {}),
  };
}

function sanitizeSavedView(value: unknown, index: number): LifecycleSavedView | null {
  if (!isRecord(value)) return null;
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 80) : '';
  if (!name) return null;
  const displayValue = isRecord(value.display) ? value.display : value;
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, 120) : `migrated-${index}`,
    name,
    filters: sanitizeFilters(value.filters),
    display: {
      compact: displayValue.compact === true,
      limit: typeof displayValue.limit === 'number'
        ? Math.max(1, Math.min(Math.floor(displayValue.limit), 100))
        : typeof displayValue.pageSize === 'number'
          ? Math.max(1, Math.min(Math.floor(displayValue.pageSize), 100))
          : DEFAULT_LIMIT,
    },
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
  };
}

export function loadLifecycleSavedViews(storage: Pick<Storage, 'getItem' | 'setItem'>): LifecycleSavedViewsEnvelope {
  let parsed: unknown;
  try { parsed = JSON.parse(storage.getItem(LIFECYCLE_SAVED_VIEWS_KEY) ?? 'null') as unknown; } catch { parsed = null; }
  const source = isRecord(parsed) && Array.isArray(parsed.views) ? parsed.views : Array.isArray(parsed) ? parsed : [];
  const envelope: LifecycleSavedViewsEnvelope = {
    version: LIFECYCLE_SAVED_VIEWS_VERSION,
    views: source.slice(-LIFECYCLE_SAVED_VIEWS_LIMIT).map(sanitizeSavedView).filter((view): view is LifecycleSavedView => view !== null),
  };
  try {
    // Rewrite even a nominal v2 envelope after sanitization so unrecognized
    // evidence/approval fields can never remain persisted as saved-view truth.
    return saveLifecycleSavedViews(storage, envelope.views);
  } catch {
    return envelope;
  }
}

export function saveLifecycleSavedViews(storage: Pick<Storage, 'setItem'>, views: LifecycleSavedView[]): LifecycleSavedViewsEnvelope {
  const bounded = views.slice(-LIFECYCLE_SAVED_VIEWS_LIMIT);
  let envelope: LifecycleSavedViewsEnvelope = { version: LIFECYCLE_SAVED_VIEWS_VERSION, views: bounded };
  while (envelope.views.length > 0 && new TextEncoder().encode(JSON.stringify(envelope)).byteLength > SAVED_VIEWS_BYTE_LIMIT) {
    envelope = { ...envelope, views: envelope.views.slice(1) };
  }
  storage.setItem(LIFECYCLE_SAVED_VIEWS_KEY, JSON.stringify(envelope));
  return envelope;
}

interface LifecycleDisplayPreferences { compact: boolean; blockedOnly: boolean }

function loadDisplayPreferences(storage: Pick<Storage, 'getItem'>): LifecycleDisplayPreferences {
  try {
    const value = JSON.parse(storage.getItem(LIFECYCLE_DISPLAY_PREFERENCES_KEY) ?? 'null') as unknown;
    return isRecord(value)
      ? { compact: value.compact === true, blockedOnly: value.blockedOnly === true }
      : { compact: false, blockedOnly: false };
  } catch {
    return { compact: false, blockedOnly: false };
  }
}

interface InvalidationTargets { portfolio: boolean; detail: boolean; phase: boolean; evidence: boolean }
interface LifecycleWalPayload { workspaceId: string; specId: string | null; phaseId: string | null; changeKind: string }

function walPayload(event: WalEvent): LifecycleWalPayload | null {
  if (event.event_type !== 'lifecycle_changed' && event.event_type !== 'decision_recorded') return null;
  try {
    // pg returns JSONB as an object for freshly inserted/broadcast WAL rows,
    // while historical/query fixtures expose the serialized string contract.
    const rawPayload = event.payload as unknown;
    const value = typeof rawPayload === 'string' ? JSON.parse(rawPayload || '{}') as unknown : rawPayload;
    if (!isRecord(value) || typeof value.workspaceId !== 'string' || typeof value.changeKind !== 'string') return null;
    return {
      workspaceId: value.workspaceId,
      specId: typeof value.specId === 'string' ? value.specId : null,
      phaseId: typeof value.phaseId === 'string' ? value.phaseId : null,
      changeKind: value.changeKind,
    };
  } catch { return null; }
}

export function lifecycleInvalidationTargets(
  event: WalEvent,
  workspaceId: string | null,
  selectedSpecId: string | null,
  selectedPhaseId: LifecyclePhaseId | null,
): InvalidationTargets {
  const payload = walPayload(event);
  if (!payload || !workspaceId || payload.workspaceId !== workspaceId || (event.workspace_id && event.workspace_id !== workspaceId)) {
    return { portfolio: false, detail: false, phase: false, evidence: false };
  }
  const selectedSpecAffected = Boolean(selectedSpecId && (!payload.specId || payload.specId === selectedSpecId));
  const selectedPhaseAffected = selectedSpecAffected && Boolean(selectedPhaseId && (!payload.phaseId || payload.phaseId === selectedPhaseId));
  return {
    portfolio: true,
    detail: selectedSpecAffected,
    phase: selectedPhaseAffected,
    evidence: selectedPhaseAffected && payload.changeKind === 'evidence_persisted',
  };
}

function emptyQuery<T>(): LifecycleQueryState<T> {
  return { data: null, snapshotId: null, loading: false, refreshing: false, stale: false, partial: false, error: null };
}

function beginQuery<T>(previous: LifecycleQueryState<T>): LifecycleQueryState<T> {
  const readable = previous.data !== null;
  return { ...previous, loading: !readable, refreshing: readable, stale: readable, error: null };
}

function querySuccess<T>(data: T, snapshotId: string | null): LifecycleQueryState<T> {
  return { data, snapshotId, loading: false, refreshing: false, stale: false, partial: false, error: null };
}

function queryFailure<T>(previous: LifecycleQueryState<T>, error: Error): LifecycleQueryState<T> {
  return {
    ...previous,
    loading: false,
    refreshing: false,
    stale: previous.data !== null,
    partial: previous.data !== null,
    error,
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Unknown lifecycle request error');
}
export function isSnapshotConflict(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 409
    && error.details.type === 'refresh_required';
}

export function conflictCurrentSnapshot(error: unknown): {
  currentSnapshotId: string;
  evidenceHighWaterMark: string;
  decisionHighWaterMark: string;
} | null {
  if (!isSnapshotConflict(error)) return null;
  const { currentSnapshotId, evidenceHighWaterMark, decisionHighWaterMark } = error.details;
  if (
    typeof currentSnapshotId !== 'string'
    || typeof evidenceHighWaterMark !== 'string'
    || typeof decisionHighWaterMark !== 'string'
  ) return null;
  return { currentSnapshotId, evidenceHighWaterMark, decisionHighWaterMark };
}


function snapshotRetryBackoff(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithSnapshotConflictRetry<T>(
  initialSnapshotId: string | undefined,
  signal: AbortSignal,
  request: (expectedSnapshotId: string | undefined) => Promise<T>,
  adoptSnapshot: (snapshot: LifecycleSnapshotRef) => void,
): Promise<{ data: T; expectedSnapshotId: string | undefined }> {
  let expectedSnapshotId = initialSnapshotId;
  for (let attempt = 0; attempt < SNAPSHOT_DETAIL_MAX_ATTEMPTS; attempt += 1) {
    try {
      return { data: await request(expectedSnapshotId), expectedSnapshotId };
    } catch (error) {
      if (signal.aborted) throw error;
      const current = conflictCurrentSnapshot(error);
      if (!current) throw error;
      adoptSnapshot({
        snapshotId: current.currentSnapshotId,
        evidenceHighWaterMark: current.evidenceHighWaterMark,
        decisionHighWaterMark: current.decisionHighWaterMark,
      });
      if (attempt === SNAPSHOT_DETAIL_MAX_ATTEMPTS - 1) throw error;
      expectedSnapshotId = current.currentSnapshotId;
      await snapshotRetryBackoff(SNAPSHOT_DETAIL_BACKOFF_MS[attempt], signal);
    }
  }
  throw new Error('Lifecycle snapshot retry attempts exhausted');
}

function snapshotsAgree(left: LifecycleSnapshotRef | null | undefined, right: LifecycleSnapshotRef | null | undefined): boolean {
  return !left || !right || (
    left.snapshotId === right.snapshotId
    && left.evidenceHighWaterMark === right.evidenceHighWaterMark
    && left.decisionHighWaterMark === right.decisionHighWaterMark
  );
}

export interface UseLifecycleOptions { sseDebounceMs?: number }

export function useLifecycle(options: UseLifecycleOptions = {}) {
  const { workspaceId } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const routeIdentity = useParams<{ specId?: string; phaseId?: string; evidenceId?: string }>();
  const effectiveSearchParams = useMemo(() => {
    const params = new URLSearchParams(searchParams);
    if (routeIdentity.specId) params.set('spec', routeIdentity.specId);
    if (routeIdentity.phaseId) params.set('phase', routeIdentity.phaseId);
    if (routeIdentity.evidenceId) params.set('evidence', routeIdentity.evidenceId);
    return params;
  }, [routeIdentity.evidenceId, routeIdentity.phaseId, routeIdentity.specId, searchParams]);
  const urlState = useMemo(() => parseLifecycleUrlState(effectiveSearchParams), [effectiveSearchParams]);
  const filters = useMemo<LifecyclePortfolioFilters>(() => ({
    sort: urlState.sort,
    ...(urlState.search ? { search: urlState.search } : {}),
    ...(urlState.status ? { status: urlState.status } : {}),
    ...(urlState.specStatus ? { specStatus: urlState.specStatus } : {}),
    ...(urlState.phase ? { phase: urlState.phase } : {}),
    ...(urlState.risk ? { risk: urlState.risk } : {}),
    ...(urlState.owner ? { owner: urlState.owner } : {}),
    ...(urlState.blocked !== undefined ? { blocked: urlState.blocked } : {}),
    ...(urlState.disposition ? { disposition: urlState.disposition } : {}),
  }), [
    urlState.sort,
    urlState.search,
    urlState.status,
    urlState.specStatus,
    urlState.phase,
    urlState.risk,
    urlState.owner,
    urlState.blocked,
    urlState.disposition,
  ]);

  const [portfolio, setPortfolio] = useState<LifecycleQueryState<LifecyclePortfolioResponse>>(emptyQuery);
  const [selectedSpec, setSelectedSpec] = useState<LifecycleQueryState<LifecycleSpecResponse>>(emptyQuery);
  const [phase, setPhase] = useState<LifecycleQueryState<LifecyclePhaseResponse>>(emptyQuery);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [selectedEvidenceSnapshotId, setSelectedEvidenceSnapshotId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<LifecycleQueryState<LifecycleEvidenceDetail>>(emptyQuery);
  const [mutationError, setMutationError] = useState<ApiError | Error | null>(null);
  const [savedViews, setSavedViews] = useState<LifecycleSavedView[]>(() => loadLifecycleSavedViews(localStorage).views);
  const [displayPreferences, setDisplayPreferences] = useState<LifecycleDisplayPreferences>(() => {
    const stored = loadDisplayPreferences(localStorage);
    return { ...stored, compact: stored.compact || urlState.compact };
  });
  const [lastSuccessfulRefresh, setLastSuccessfulRefresh] = useState<string | null>(null);
  const [revisions, setRevisions] = useState({ portfolio: 0, detail: 0, phase: 0, evidence: 0 });

  useEffect(() => {
    try {
      localStorage.setItem(LIFECYCLE_DISPLAY_PREFERENCES_KEY, JSON.stringify(displayPreferences));
    } catch {
      // Display preferences are optional when storage is unavailable or full.
    }
  }, [displayPreferences]);

  const portfolioRef = useRef(portfolio);
  const selectedSpecRef = useRef(selectedSpec);
  const phaseRef = useRef(phase);
  portfolioRef.current = portfolio;
  selectedSpecRef.current = selectedSpec;
  phaseRef.current = phase;
  const generations = useRef({ portfolio: 0, detail: 0, phase: 0, evidence: 0 });
  const phaseSelectionKeyRef = useRef<string | null>(null);
  const evidenceSelectionKeyRef = useRef<string | null>(null);
  const recoveryKeyRef = useRef<string | null>(null);
  const latestSnapshotRef = useRef<LifecycleSnapshotRef | null>(null);
  const adoptSnapshotConflict = useCallback((snapshot: LifecycleSnapshotRef) => {
    latestSnapshotRef.current = snapshot;
  }, []);
  const portfolioCacheRef = useRef(new Map<string, LifecyclePortfolioCacheEntry>());
  const portfolioPrefetchRef = useRef(new Map<string, Promise<LifecyclePortfolioResponse>>());

  const readPortfolioCache = useCallback((key: string): LifecyclePortfolioCacheEntry | null => {
    const cached = portfolioCacheRef.current.get(key);
    if (!cached) return null;
    if (Date.now() - cached.receivedAt > PORTFOLIO_CACHE_STALE_MS) {
      portfolioCacheRef.current.delete(key);
      return null;
    }
    // Refresh insertion order so the bounded map behaves as a small LRU cache.
    portfolioCacheRef.current.delete(key);
    portfolioCacheRef.current.set(key, cached);
    return cached;
  }, []);

  const writePortfolioCache = useCallback((key: string, data: LifecyclePortfolioResponse) => {
    portfolioCacheRef.current.delete(key);
    portfolioCacheRef.current.set(key, { data, receivedAt: Date.now() });
    while (portfolioCacheRef.current.size > PORTFOLIO_CACHE_LIMIT) {
      const oldest = portfolioCacheRef.current.keys().next().value as string | undefined;
      if (!oldest) break;
      portfolioCacheRef.current.delete(oldest);
    }
  }, []);

  const updateUrlState = useCallback((patch: Partial<LifecycleUrlState>, replace = false) => {
    const current = parseLifecycleUrlState(effectiveSearchParams);
    const next = { ...current, ...patch };
    if (patch.selectedSpecId === null) next.selectedPhaseId = null;
    const viewParams = serializeLifecycleUrlState(next, searchParams);
    let pathname = workspaceId ? `/workspaces/${encodeURIComponent(workspaceId)}/lifecycle` : '/lifecycle';
    if (workspaceId && next.selectedSpecId && next.selectedPhaseId) {
      const canonical = new URL(entityRoute({
        schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
        workspaceId,
        kind: 'phase',
        id: next.selectedPhaseId,
        label: next.selectedPhaseId,
        parent: {
          workspaceId,
          kind: 'spec',
          id: next.selectedSpecId,
          label: next.selectedSpecId,
        },
      }), 'https://rorca.invalid');
      pathname = canonical.pathname;
      for (const [key, value] of canonical.searchParams) viewParams.set(key, value);
    }
    const serialized = viewParams.toString();
    navigate(`${pathname}${serialized ? `?${serialized}` : ''}`, { replace });
  }, [effectiveSearchParams, navigate, searchParams, workspaceId]);

  const updateFilters = useCallback((patch: Partial<LifecyclePortfolioFilters>, replace = false) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'blocked')) {
      setDisplayPreferences((current) => ({ ...current, blockedOnly: patch.blocked === true }));
    }
    updateUrlState({ ...patch, page: 1 }, replace);
  }, [updateUrlState]);

  useEffect(() => {
    if (urlState.compact) {
      // Compact was URL-backed before display preferences were introduced.
      // Consume that legacy value once, then keep it local-only.
      updateUrlState({ compact: false }, true);
    } else if (!searchParams.has('blocked') && displayPreferences.blockedOnly) {
      updateUrlState({ blocked: true, page: 1 }, true);
    }
  }, [displayPreferences.blockedOnly, searchParams, updateUrlState, urlState.compact]);

  // Normalize malformed drawer links and migrate the legacy `phaseDetail`
  // parameter without ever attempting a request for an unknown phase.
  useEffect(() => {
    const rawSpec = searchParams.get('spec');
    const rawPhase = searchParams.get('phaseDetail') ?? searchParams.get('phase');
    const invalidSelection = Boolean(rawSpec && rawPhase && !PHASES.has(rawPhase));
    const incompleteLegacySelection = Boolean(!rawSpec && searchParams.has('phaseDetail'));
    const needsMigration = Boolean(rawSpec && searchParams.has('phaseDetail') && rawPhase && PHASES.has(rawPhase));
    if (invalidSelection || incompleteLegacySelection) {
      updateUrlState({ selectedSpecId: null, selectedPhaseId: null }, true);
    } else if (needsMigration) {
      updateUrlState({ selectedSpecId: rawSpec, selectedPhaseId: rawPhase as LifecyclePhaseId }, true);
    }
  }, [searchParams, updateUrlState]);

  const coordinatedRefetch = useCallback((key: string) => {
    if (recoveryKeyRef.current === key) return;
    recoveryKeyRef.current = key;
    setPortfolio((state) => ({ ...state, stale: state.data !== null }));
    setSelectedSpec((state) => ({ ...state, stale: state.data !== null }));
    setPhase((state) => ({ ...state, stale: state.data !== null }));
    setEvidence((state) => ({ ...state, stale: state.data !== null }));
    setRevisions((value) => ({
      portfolio: value.portfolio + 1,
      detail: value.detail + 1,
      phase: value.phase + 1,
      evidence: value.evidence,
    }));
  }, []);

  const previousWorkspace = useRef(workspaceId);
  useEffect(() => {
    if (previousWorkspace.current === workspaceId) return;
    previousWorkspace.current = workspaceId;
    generations.current = {
      portfolio: generations.current.portfolio + 1,
      detail: generations.current.detail + 1,
      phase: generations.current.phase + 1,
      evidence: generations.current.evidence + 1,
    };
    recoveryKeyRef.current = null;
    latestSnapshotRef.current = null;
    phaseSelectionKeyRef.current = null;
    evidenceSelectionKeyRef.current = null;
    setPortfolio(emptyQuery());
    setSelectedSpec(emptyQuery());
    setPhase(emptyQuery());
    setEvidence(emptyQuery());
    setSelectedEvidenceId(null);
    setSelectedEvidenceSnapshotId(null);
    updateUrlState({ selectedSpecId: null, selectedPhaseId: null }, true);
  }, [workspaceId, updateUrlState]);

  const prefetchFilters = useCallback((patch: Partial<LifecyclePortfolioFilters>): Promise<void> => {
    if (!workspaceId) return Promise.resolve();
    const nextFilters = withFilterPatch(filters, patch);
    const key = portfolioCacheKey(workspaceId, nextFilters, 1, urlState.limit, revisions.portfolio);
    if (readPortfolioCache(key)) return Promise.resolve();
    const existing = portfolioPrefetchRef.current.get(key);
    if (existing) return existing.then(() => undefined).catch(() => undefined);
    const request = getLifecyclePortfolio(
      workspaceId,
      nextFilters,
      { page: 1, limit: urlState.limit },
      { silent: true },
    ).then((data) => {
      writePortfolioCache(key, data);
      return data;
    }).finally(() => {
      portfolioPrefetchRef.current.delete(key);
    });
    portfolioPrefetchRef.current.set(key, request);
    return request.then(() => undefined).catch(() => undefined);
  }, [filters, readPortfolioCache, revisions.portfolio, urlState.limit, workspaceId, writePortfolioCache]);

  useEffect(() => {
    if (!workspaceId) { setPortfolio(emptyQuery()); return; }
    const generation = ++generations.current.portfolio;
    const key = portfolioCacheKey(workspaceId, filters, urlState.page, urlState.limit, revisions.portfolio);
    const cached = readPortfolioCache(key);
    if (cached) {
      const reusable = Date.now() - cached.receivedAt <= PORTFOLIO_CACHE_REUSE_MS;
      const state = querySuccess(cached.data, cached.data.snapshotId);
      setPortfolio(reusable ? state : { ...state, refreshing: true, stale: true });
      setLastSuccessfulRefresh(new Date(cached.receivedAt).toISOString());
      if (reusable) return;
    } else {
      setPortfolio(beginQuery);
    }

    const controller = new AbortController();
    const prefetched = portfolioPrefetchRef.current.get(key);
    const request = prefetched ?? getLifecyclePortfolio(
      workspaceId,
      filters,
      { page: urlState.page, limit: urlState.limit },
      { signal: controller.signal, silent: true },
    );
    request.then((data) => {
      if (generation !== generations.current.portfolio || controller.signal.aborted) return;
      writePortfolioCache(key, data);
      setPortfolio(querySuccess(data, data.snapshotId));
      setLastSuccessfulRefresh(new Date().toISOString());
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation !== generations.current.portfolio) return;
      setPortfolio((state) => queryFailure(state, asError(error)));
    });
    return () => controller.abort();
  }, [workspaceId, filters, urlState.page, urlState.limit, revisions.portfolio, readPortfolioCache, writePortfolioCache]);

  const portfolioReady = portfolio.data !== null;
  const selectedPortfolioItem = portfolio.data?.items.find((item) => item.specId === urlState.selectedSpecId);
  const selectedPortfolioSnapshot = selectedPortfolioItem?.snapshotId;
  useEffect(() => {
    if (!workspaceId || !urlState.selectedSpecId) { setSelectedSpec(emptyQuery()); return; }
    // Wait for the portfolio page before choosing the selected row's snapshot.
    // Specs outside the current page are fetched without an expected snapshot.
    if (!portfolioReady) return;
    const generation = ++generations.current.detail;
    const controller = new AbortController();
    const expected = latestSnapshotRef.current?.snapshotId
      ?? selectedPortfolioSnapshot
      ?? selectedSpecRef.current.data?.snapshotId;
    setSelectedSpec(beginQuery);
    fetchWithSnapshotConflictRetry(
      expected,
      controller.signal,
      (snapshotId) => getLifecycleSpec(
        workspaceId,
        urlState.selectedSpecId!,
        snapshotId,
        { signal: controller.signal, silent: true },
      ),
      adoptSnapshotConflict,
    ).then(({ data }) => {
      if (generation !== generations.current.detail || controller.signal.aborted) return;
      if (selectedPortfolioSnapshot && data.snapshotId !== selectedPortfolioSnapshot) {
        setSelectedSpec((state) => ({ ...state, loading: false, refreshing: false, stale: true, partial: true }));
        coordinatedRefetch(`spec:${selectedPortfolioSnapshot}:${data.snapshotId}`);
        return;
      }
      setSelectedSpec(querySuccess(data, data.snapshotId));
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation !== generations.current.detail) return;
      setSelectedSpec((state) => queryFailure(state, asError(error)));
    });
    return () => controller.abort();
  }, [workspaceId, urlState.selectedSpecId, portfolioReady, selectedPortfolioSnapshot, revisions.detail, coordinatedRefetch, adoptSnapshotConflict]);

  useEffect(() => {
    if (!workspaceId || !urlState.selectedSpecId || !urlState.selectedPhaseId) {
      phaseSelectionKeyRef.current = null;
      setPhase(emptyQuery());
      return;
    }
    const selectionKey = `${workspaceId}:${urlState.selectedSpecId}:${urlState.selectedPhaseId}`;
    const selectionChanged = phaseSelectionKeyRef.current !== selectionKey;
    phaseSelectionKeyRef.current = selectionKey;
    if (selectionChanged) {
      setSelectedEvidenceId(null);
      setSelectedEvidenceSnapshotId(null);
      setEvidence(emptyQuery());
    }
    setPhase((state) => selectionChanged ? { ...emptyQuery<LifecyclePhaseResponse>(), loading: true } : beginQuery(state));
    const expected = latestSnapshotRef.current?.snapshotId
      ?? selectedPortfolioSnapshot
      ?? selectedSpec.data?.snapshotId;
    if (!expected) return;
    const generation = ++generations.current.phase;
    const controller = new AbortController();
    fetchWithSnapshotConflictRetry(
      expected,
      controller.signal,
      (snapshotId) => getLifecyclePhase(
        workspaceId,
        urlState.selectedSpecId!,
        urlState.selectedPhaseId!,
        { page: 1, limit: urlState.limit },
        snapshotId!,
        { signal: controller.signal, silent: true },
      ),
      adoptSnapshotConflict,
    ).then(({ data }) => {
      if (generation !== generations.current.phase || controller.signal.aborted) return;
      const baseline = selectedSpecRef.current.data;
      if (baseline && !snapshotsAgree(baseline, data)) {
        setPhase((state) => ({ ...state, data: null, snapshotId: null, loading: false, refreshing: false, stale: true, partial: true }));
        coordinatedRefetch(`phase:${baseline.snapshotId}:${data.snapshotId}`);
        return;
      }
      setPhase(querySuccess(data, data.snapshotId));
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation !== generations.current.phase) return;
      setPhase((state) => queryFailure(state, asError(error)));
    });
    return () => controller.abort();
  }, [workspaceId, urlState.selectedSpecId, urlState.selectedPhaseId, urlState.limit, selectedSpec.data?.snapshotId, selectedPortfolioSnapshot, revisions.phase, coordinatedRefetch, adoptSnapshotConflict]);

  useEffect(() => {
    if (!workspaceId || !selectedEvidenceId) {
      evidenceSelectionKeyRef.current = null;
      setEvidence(emptyQuery());
      return;
    }
    const selectionKey = `${workspaceId}:${selectedEvidenceId}`;
    const selectionChanged = evidenceSelectionKeyRef.current !== selectionKey;
    evidenceSelectionKeyRef.current = selectionKey;
    const generation = ++generations.current.evidence;
    const controller = new AbortController();
    setEvidence((state) => selectionChanged ? { ...emptyQuery<LifecycleEvidenceDetail>(), loading: true } : beginQuery(state));
    const expected = latestSnapshotRef.current?.snapshotId
      ?? selectedPortfolioSnapshot
      ?? selectedSpecRef.current.data?.snapshotId
      ?? selectedEvidenceSnapshotId;
    if (!expected) {
      setEvidence((state) => queryFailure(state, new Error('Evidence cannot be inspected without a bound evaluation snapshot.')));
      return;
    }
    fetchWithSnapshotConflictRetry(
      expected,
      controller.signal,
      (snapshotId) => getLifecycleEvidence(
        workspaceId,
        selectedEvidenceId,
        snapshotId!,
        { signal: controller.signal, silent: true },
      ),
      adoptSnapshotConflict,
    ).then(({ data, expectedSnapshotId }) => {
      if (generation !== generations.current.evidence || controller.signal.aborted) return;
      if (data.snapshotId !== expectedSnapshotId) {
        setEvidence((state) => queryFailure(state, new Error('Evidence response did not match the pinned evaluation snapshot.')));
        return;
      }
      setEvidence(querySuccess(data, data.snapshotId));
    }).catch((error: unknown) => {
      if (controller.signal.aborted || generation !== generations.current.evidence) return;
      setEvidence((state) => queryFailure(state, asError(error)));
    });
    return () => controller.abort();
  }, [workspaceId, selectedEvidenceId, selectedEvidenceSnapshotId, selectedPortfolioSnapshot, revisions.evidence, adoptSnapshotConflict]);

  useEffect(() => {
    const specData = selectedSpec.data;
    const phaseData = phase.data;
    if (!specData || !phaseData) return;
    if (snapshotsAgree(specData, phaseData)) recoveryKeyRef.current = null;
  }, [selectedSpec.data, phase.data]);

  const pendingInvalidation = useRef<InvalidationTargets>({ portfolio: false, detail: false, phase: false, evidence: false });
  const invalidationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenEvents = useRef(new Set<number>());
  useWalSSE((event) => {
    if (seenEvents.current.has(event.id)) return;
    seenEvents.current.add(event.id);
    if (seenEvents.current.size > 100) seenEvents.current.delete(seenEvents.current.values().next().value!);
    const targets = lifecycleInvalidationTargets(event, workspaceId, urlState.selectedSpecId, urlState.selectedPhaseId);
    if (!targets.portfolio) return;
    pendingInvalidation.current = {
      portfolio: pendingInvalidation.current.portfolio || targets.portfolio,
      detail: pendingInvalidation.current.detail || targets.detail,
      phase: pendingInvalidation.current.phase || targets.phase,
      evidence: pendingInvalidation.current.evidence || targets.evidence,
    };
    setPortfolio((state) => ({ ...state, stale: state.data !== null }));
    if (targets.detail) setSelectedSpec((state) => ({ ...state, stale: state.data !== null }));
    if (targets.phase) setPhase((state) => ({ ...state, stale: state.data !== null }));
    if (targets.evidence) setEvidence((state) => ({ ...state, stale: true }));
    if (invalidationTimer.current) return;
    invalidationTimer.current = setTimeout(() => {
      const pending = pendingInvalidation.current;
      pendingInvalidation.current = { portfolio: false, detail: false, phase: false, evidence: false };
      invalidationTimer.current = null;
      setRevisions((value) => ({
        portfolio: value.portfolio + Number(pending.portfolio),
        detail: value.detail + Number(pending.detail),
        phase: value.phase + Number(pending.phase),
        // Keep an open inspector pinned until its explicit refresh is used.
        evidence: value.evidence,
      }));
    }, options.sseDebounceMs ?? 150);
  });

  useEffect(() => () => {
    if (invalidationTimer.current) clearTimeout(invalidationTimer.current);
  }, []);

  const refresh = useCallback(() => {
    setRevisions((value) => ({
      portfolio: value.portfolio + 1,
      detail: value.detail + Number(Boolean(urlState.selectedSpecId)),
      phase: value.phase + Number(Boolean(urlState.selectedPhaseId)),
      evidence: value.evidence,
    }));
  }, [urlState.selectedSpecId, urlState.selectedPhaseId]);

  const openEvidence = useCallback((evidenceId: string) => {
    const callerSnapshot = phaseRef.current.data?.snapshotId ?? selectedSpecRef.current.data?.snapshotId ?? null;
    setSelectedEvidenceSnapshotId(callerSnapshot);
    setSelectedEvidenceId(evidenceId);
  }, []);

  // Spec Review can deep-link to a specific evidence record. Consume the
  // `evidence` parameter only after the selected phase has loaded so the read
  // is pinned to that phase's snapshot, then remove the one-shot parameter.
  const evidenceDeepLink = effectiveSearchParams.get('evidence')?.slice(0, 128) || null;
  useEffect(() => {
    if (!evidenceDeepLink || !urlState.selectedSpecId || !urlState.selectedPhaseId) return;
    const phaseData = phaseRef.current.data;
    if (
      !phaseData
      || phaseData.specId !== urlState.selectedSpecId
      || phaseData.phaseId !== urlState.selectedPhaseId
    ) return;
    openEvidence(evidenceDeepLink);
    if (!routeIdentity.evidenceId) {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.delete('evidence');
      setSearchParams(nextParams, { replace: true });
    }
  }, [evidenceDeepLink, openEvidence, phase.data, routeIdentity.evidenceId, searchParams, setSearchParams, urlState.selectedPhaseId, urlState.selectedSpecId]);

  const closeEvidence = useCallback(() => {
    setSelectedEvidenceId(null);
    setSelectedEvidenceSnapshotId(null);
  }, []);

  const refreshEvidence = useCallback(() => {
    const latestSnapshot = phaseRef.current.data?.snapshotId ?? selectedSpecRef.current.data?.snapshotId ?? null;
    if (!selectedEvidenceId || !latestSnapshot) return;
    setSelectedEvidenceSnapshotId(latestSnapshot);
    setRevisions((value) => ({ ...value, evidence: value.evidence + 1 }));
  }, [selectedEvidenceId]);

  const runMutation = useCallback(async <T,>(operation: () => Promise<T>, targets: Partial<InvalidationTargets>): Promise<T> => {
    setMutationError(null);
    try {
      const result = await operation();
      setRevisions((value) => ({
        portfolio: value.portfolio + Number(Boolean(targets.portfolio)),
        detail: value.detail + Number(Boolean(targets.detail)),
        phase: value.phase + Number(Boolean(targets.phase)),
        evidence: value.evidence + Number(Boolean(targets.evidence)),
      }));
      return result;
    } catch (error) {
      const typed = asError(error);
      setMutationError(typed);
      throw typed;
    }
  }, []);

  const mutations = useMemo(() => ({
    recompile: (specId: string, idempotencyKey: string, expectedSaveGeneration?: number | null): Promise<LifecycleMutationResult> => {
      if (!workspaceId) return Promise.reject(new Error('Select a workspace before recompiling'));
      return runMutation(
        () => recompileLifecycleSpec(workspaceId, specId, idempotencyKey, expectedSaveGeneration),
        { portfolio: true, detail: specId === urlState.selectedSpecId, phase: specId === urlState.selectedSpecId },
      );
    },
    recordDecision: (input: Omit<RecordLifecycleDecisionInput, 'workspaceId'>, idempotencyKey: string): Promise<LifecycleDecisionMutationResult> => {
      if (!workspaceId) return Promise.reject(new Error('Select a workspace before recording a decision'));
      return runMutation(
        () => recordLifecycleDecision({ ...input, workspaceId }, idempotencyKey),
        { portfolio: true, detail: input.specSlug === urlState.selectedSpecId, phase: input.specSlug === urlState.selectedSpecId && input.phaseId === urlState.selectedPhaseId },
      );
    },
    revokeDecision: (decisionId: string, rationale: string, idempotencyKey: string): Promise<LifecycleDecisionMutationResult> => {
      if (!workspaceId) return Promise.reject(new Error('Select a workspace before revoking a decision'));
      return runMutation(
        () => revokeLifecycleDecision(workspaceId, decisionId, rationale, idempotencyKey),
        { portfolio: true, detail: true, phase: true },
      );
    },
  }), [workspaceId, urlState.selectedSpecId, urlState.selectedPhaseId, runMutation]);

  const saveView = useCallback((name: string): LifecycleSavedView => {
    const view: LifecycleSavedView = {
      id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim().slice(0, 80),
      filters,
      display: { compact: displayPreferences.compact, limit: urlState.limit },
      updatedAt: new Date().toISOString(),
    };
    if (!view.name) throw new Error('Saved view name is required');
    setSavedViews((current) => saveLifecycleSavedViews(localStorage, [...current, view]).views);
    return view;
  }, [filters, displayPreferences.compact, urlState.limit]);

  const renameSavedView = useCallback((id: string, name: string) => {
    const nextName = name.trim().slice(0, 80);
    if (!nextName) throw new Error('Saved view name is required');
    setSavedViews((current) => saveLifecycleSavedViews(localStorage, current.map((view) => (
      view.id === id ? { ...view, name: nextName, updatedAt: new Date().toISOString() } : view
    ))).views);
  }, []);

  const removeSavedView = useCallback((id: string) => {
    setSavedViews((current) => saveLifecycleSavedViews(localStorage, current.filter((view) => view.id !== id)).views);
  }, []);

  const applySavedView = useCallback((view: LifecycleSavedView) => {
    setDisplayPreferences({ compact: view.display.compact, blockedOnly: view.filters.blocked === true });
    updateUrlState({
      search: undefined,
      status: undefined,
      specStatus: undefined,
      phase: undefined,
      risk: undefined,
      owner: undefined,
      blocked: undefined,
      disposition: undefined,
      ...view.filters,
      compact: false,
      limit: view.display.limit,
      page: 1,
    });
  }, [updateUrlState]);

  const traceability: LifecycleQueryState<LifecycleSpecResponse['traceability']> = selectedSpec.data
    ? { ...selectedSpec, data: selectedSpec.data.traceability }
    : { ...selectedSpec, data: null };
  const empty = !portfolio.loading && !portfolio.error && (portfolio.data?.items.length ?? 0) === 0;
  const refreshing = portfolio.refreshing || selectedSpec.refreshing || phase.refreshing || evidence.refreshing;
  const stale = portfolio.stale || selectedSpec.stale || phase.stale || evidence.stale;
  const error = portfolio.error ?? selectedSpec.error ?? phase.error ?? evidence.error;
  const partialData = Boolean(portfolio.data && (
    selectedSpec.partial || phase.partial || evidence.partial
    || (urlState.selectedSpecId && !selectedSpec.data && !selectedSpec.loading)
  ));

  return {
    urlState: { ...urlState, compact: displayPreferences.compact },
    filters,
    pagination: { page: urlState.page, limit: urlState.limit, total: portfolio.data?.total ?? 0, hasMore: portfolio.data?.hasMore ?? false },
    portfolio,
    selectedSpec,
    phase,
    traceability,
    evidence,
    selectedEvidenceId,
    selectedEvidenceSnapshotId,
    loading: portfolio.loading,
    refreshing,
    empty,
    error,
    stale,
    partialData,
    lastSuccessfulRefresh,
    snapshotConsistent: (
      (!selectedPortfolioItem?.snapshotId || !selectedSpec.data || selectedPortfolioItem.snapshotId === selectedSpec.data.snapshotId)
      && snapshotsAgree(selectedSpec.data, phase.data)
    ),
    mutationError,
    savedViews,
    updateFilters,
    updateUrlState,
    prefetchFilters,
    selectSpec: (specId: string | null) => updateUrlState({ selectedSpecId: specId, selectedPhaseId: null }),
    selectPhase: (phaseId: LifecyclePhaseId | null) => updateUrlState({ selectedPhaseId: phaseId }),
    openEvidence,
    closeEvidence,
    refreshEvidence,
    setPage: (page: number) => updateUrlState({ page: Math.max(1, page) }),
    setCompact: (compact: boolean) => {
      setDisplayPreferences((current) => ({ ...current, compact }));
      if (urlState.compact) updateUrlState({ compact: false }, true);
    },
    setMode: (mode: LifecycleUrlState['mode']) => updateUrlState({ mode }, true),
    refresh,
    mutations,
    saveView,
    renameSavedView,
    removeSavedView,
    applySavedView,
  };
}
