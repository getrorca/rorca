/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * TodayPanel — the Action Inbox (`/today`).
 *
 * Renders the server-ranked WorkspaceAttentionV1 projection in exact server
 * order. The client never re-sorts, never infers priority or state, and never
 * synthesizes actions: unknown or unavailable data renders as an explicit
 * honest state (contract violations fail closed). Polling preserves focus —
 * a ranking change that arrives while the operator is focused inside the list
 * is held behind an explicit "Show updated ranking" affordance instead of
 * yanking the rows out from under them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertTriangle, Inbox, RefreshCw, RotateCcw, WifiOff, X } from 'lucide-react';
import type { ActionEnvelopeV1 } from '../../shared/contracts/mission';
import {
  getWorkspaceAttention,
  MissionContractError,
  type WorkspaceAttentionV1,
} from '../api/mission';
import { ApiError } from '../lib/apiFetch';
import { formatRelativeTime } from '../lib/missionFormat';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useNetworkOffline } from '../components/NetworkBanner';
import EmptyState from '../components/EmptyState';
import ErrorBanner from '../components/ErrorBanner';
import { SkeletonBlock, SkeletonLine } from '../components/Skeleton';
import ActionCard from '../components/mission/ActionCard';

const POLL_INTERVAL_MS = 30_000;

type PriorityFilter = 'all' | ActionEnvelopeV1['priority'];

const PRIORITY_FILTERS: ReadonlyArray<{ key: PriorityFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'safety', label: 'Safety' },
  { key: 'decision', label: 'Decisions' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'ready', label: 'Ready' },
  { key: 'informational', label: 'Info' },
];

function sameRanking(a: WorkspaceAttentionV1, b: WorkspaceAttentionV1): boolean {
  return a.items.length === b.items.length
    && a.items.every((item, index) => item.actionId === b.items[index]?.actionId);
}

function asAttentionError(error: unknown): ApiError | MissionContractError {
  if (error instanceof MissionContractError || error instanceof ApiError) return error;
  return new ApiError(0, 'unknown', error instanceof Error ? error.message : String(error));
}

export default function TodayPanel() {
  const { workspaceId, selectedWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const offline = useNetworkOffline();
  const [attention, setAttention] = useState<WorkspaceAttentionV1 | null>(null);
  const [pendingAttention, setPendingAttention] = useState<WorkspaceAttentionV1 | null>(null);
  const [error, setError] = useState<ApiError | MissionContractError | null>(null);
  const [refreshError, setRefreshError] = useState<ApiError | MissionContractError | null>(null);
  const [loading, setLoading] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [offlineNoticeDismissed, setOfflineNoticeDismissed] = useState(false);
  const attentionRef = useRef<WorkspaceAttentionV1 | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const retryRef = useRef<() => void>(() => undefined);

  const retry = useCallback(() => retryRef.current(), []);

  useEffect(() => {
    if (!workspaceId) {
      attentionRef.current = null;
      setAttention(null);
      setPendingAttention(null);
      setError(null);
      setRefreshError(null);
      return;
    }

    attentionRef.current = null;
    setAttention(null);
    setPendingAttention(null);
    setRefreshError(null);
    const controller = new AbortController();
    let cancelled = false;
    let latestGeneration = 0;

    const load = async (initial: boolean) => {
      const generation = ++latestGeneration;
      if (initial) {
        setLoading(true);
        setError(null);
      }
      try {
        const result = await getWorkspaceAttention(workspaceId, { signal: controller.signal });
        if (cancelled || generation !== latestGeneration) return;
        setError(null);
        setRefreshError(null);
        const current = attentionRef.current;
        const activeElement = document.activeElement;
        const focusInsideList = !!listRef.current
          && !!activeElement
          && activeElement !== document.body
          && listRef.current.contains(activeElement);
        if (current && !sameRanking(current, result) && focusInsideList) {
          // Poll-without-yank: hold the new ranking until the operator asks.
          setPendingAttention(result);
        } else {
          attentionRef.current = result;
          setAttention(result);
          setPendingAttention(null);
        }
      } catch (loadError) {
        if (cancelled || controller.signal.aborted || generation !== latestGeneration) return;
        const normalized = asAttentionError(loadError);
        if (attentionRef.current) setRefreshError(normalized);
        else setError(normalized);
      } finally {
        if (!cancelled && generation === latestGeneration && initial) setLoading(false);
      }
    };

    retryRef.current = () => {
      void load(attentionRef.current === null);
    };
    void load(true);
    const interval = window.setInterval(() => { void load(false); }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      retryRef.current = () => undefined;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [workspaceId]);

  const filterCounts = useMemo(() => {
    const counts: Record<PriorityFilter, number> = {
      all: attention?.items.length ?? 0,
      safety: 0,
      decision: 0,
      blocked: 0,
      ready: 0,
      informational: 0,
    };
    for (const item of attention?.items ?? []) {
      counts[item.priority] += 1;
    }
    return counts;
  }, [attention]);

  const applyPendingRanking = () => {
    if (!pendingAttention) return;
    attentionRef.current = pendingAttention;
    setAttention(pendingAttention);
    setPendingAttention(null);
  };

  if (!workspaceId) {
    return (
      <section aria-labelledby="today-heading" className="flex h-full flex-col">
        <h1 id="today-heading" className="sr-only">Today</h1>
        <EmptyState
          icon={Inbox}
          heading="Select a workspace"
          subtext="Today shows the server-ranked action inbox for the active workspace. Pick a workspace to see its pending decisions, blockers, and ready work."
        />
      </section>
    );
  }

  if (loading && !attention) {
    return (
      <section aria-labelledby="today-heading" className="flex h-full flex-col gap-3 p-4 md:p-6">
        <h1 id="today-heading" className="sr-only">Today</h1>
        <div aria-busy="true" aria-label="Loading ranked actions" className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="action-card" aria-hidden="true">
              <div className="action-card__row">
                <div className="action-card__identity">
                  <SkeletonLine className="w-24" />
                  <SkeletonLine className="w-2/3" />
                </div>
                <SkeletonBlock className="h-9 w-28" />
              </div>
              <SkeletonLine className="w-full" />
              <SkeletonLine className="w-1/2" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (offline && !attention) {
    return (
      <section aria-labelledby="today-heading" className="flex h-full flex-col">
        <h1 id="today-heading" className="sr-only">Today</h1>
        <EmptyState
          icon={WifiOff}
          heading="You are offline"
          subtext="Reconnect to load the server-ranked action inbox for this workspace."
        />
      </section>
    );
  }

  if (error && !attention) {
    if (error instanceof MissionContractError) {
      return (
        <section aria-labelledby="today-heading" className="flex h-full flex-col">
          <h1 id="today-heading" className="sr-only">Today</h1>
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="w-full max-w-md rounded-xl border border-error/30 bg-panel p-6">
              <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-error/15">
                <AlertTriangle size={20} className="text-error" />
              </div>
              <h3 className="mb-2 text-center text-base font-semibold text-[var(--text)]">
                Attention data failed contract validation
              </h3>
              <p className="mb-4 text-center text-sm text-muted">
                The server response did not match the published contract. This surface fails closed rather than guessing state.
              </p>
              <details className="mb-4 rounded-lg border border-border bg-surface-200 px-3 py-2 text-xs text-muted">
                <summary className="cursor-pointer font-medium text-[var(--text)]">
                  Contract issues
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {error.issues.map((issue) => (
                    <li key={issue} className="break-words">{issue}</li>
                  ))}
                </ul>
              </details>
              <div className="text-center">
                <button
                  type="button"
                  onClick={retry}
                  className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
                >
                  <RotateCcw size={14} />
                  Retry
                </button>
              </div>
            </div>
          </div>
        </section>
      );
    }
    return (
      <section aria-labelledby="today-heading" className="flex h-full flex-col">
        <h1 id="today-heading" className="sr-only">Today</h1>
        <ErrorBanner
          variant="fullscreen"
          message={`The attention projection is unavailable. ${error.message}`}
          onRetry={retry}
        />
      </section>
    );
  }

  if (!attention) return null;

  if (attention.items.length === 0) {
    return (
      <section aria-labelledby="today-heading" className="flex h-full flex-col">
        <h1 id="today-heading" className="sr-only">Today</h1>
        <EmptyState
          icon={Inbox}
          heading="Nothing needs your decision"
          subtext="The server found no pending decisions, blockers, or risks for this workspace."
          action={{ label: 'Open Missions', onClick: () => navigate('/missions') }}
        />
      </section>
    );
  }

  const visibleItems = priorityFilter === 'all'
    ? attention.items
    : attention.items.filter((item) => item.priority === priorityFilter);

  return (
    <section
      aria-labelledby="today-heading"
      className="flex h-full flex-col gap-4 overflow-y-auto p-4 md:p-6"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 id="today-heading" className="text-lg font-semibold text-[var(--text)]">Today</h1>
          <p className="text-sm text-muted">
            Server-ranked decisions, blockers, and ready work for {selectedWorkspace?.name ?? workspaceId}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="pk-meta">
            Ranked by the server · generated {formatRelativeTime(attention.generatedAt)}
          </span>
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-200 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-[var(--text)]"
          >
            <RefreshCw size={12} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </header>

      {offline && !offlineNoticeDismissed && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm"
        >
          <WifiOff size={14} className="shrink-0 text-warning" aria-hidden="true" />
          <span className="flex-1 text-[var(--text)]">
            You are offline. Showing the last server-ranked list from {formatRelativeTime(attention.generatedAt)}.
          </span>
          <button
            type="button"
            onClick={() => setOfflineNoticeDismissed(true)}
            aria-label="Dismiss offline notice"
            className="p-0.5 text-muted transition-colors hover:text-[var(--text)]"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {refreshError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
        >
          <AlertTriangle size={14} className="shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[var(--text)]">
            Refresh failed. Showing the last successful ranking from {formatRelativeTime(attention.generatedAt)}.
            {' '}{refreshError.message}
          </span>
          <button
            type="button"
            onClick={retry}
            className="inline-flex items-center gap-1.5 rounded-md border border-current px-2.5 py-1 text-xs font-medium text-[var(--text)]"
          >
            <RefreshCw size={12} aria-hidden="true" />
            Retry
          </button>
        </div>
      )}

      {pendingAttention && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-200 px-3 py-2 text-xs text-muted"
        >
          <span>Ranking updated on the server —</span>
          <button
            type="button"
            onClick={applyPendingRanking}
            className="font-medium text-[var(--text)] underline underline-offset-2 transition-colors hover:text-accent"
          >
            Show updated ranking
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by priority">
        {PRIORITY_FILTERS.map((filter) => {
          const pressed = priorityFilter === filter.key;
          return (
            <button
              key={filter.key}
              type="button"
              aria-pressed={pressed}
              onClick={() => setPriorityFilter(filter.key)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                pressed
                  ? 'border-border bg-surface-200 text-[var(--text)]'
                  : 'border-transparent text-muted hover:text-[var(--text)]'
              }`}
            >
              {filter.label}
              <span className="text-muted">{filterCounts[filter.key]}</span>
            </button>
          );
        })}
      </div>

      <ul ref={listRef} aria-label="Ranked actions" className="flex flex-col gap-3">
        {visibleItems.map((item) => (
          <li key={item.actionId}>
            <ActionCard action={item} workspaceId={workspaceId} />
          </li>
        ))}
      </ul>
      {visibleItems.length === 0 && (
        <p className="py-6 text-center text-sm text-muted">
          No items with this priority in the current ranking.
        </p>
      )}
    </section>
  );
}
