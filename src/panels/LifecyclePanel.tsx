/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import LifecyclePhaseDrawer from '../components/LifecyclePhaseDrawer';
import SlideOver from '../components/SlideOver';
import { LifecycleMatrixSkeleton } from '../components/skeletons';
import { LIFECYCLE_STATUS_LABELS, LifecycleStatusIcon } from './LifecycleCell';
import LifecycleMatrix from './LifecycleMatrix';
import LifecycleMetrics from './LifecycleMetrics';
import LifecycleToolbar from './LifecycleToolbar';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useLifecycle } from '../hooks/useLifecycle';
import { ApiError } from '../lib/apiFetch';
import { LIFECYCLE_PHASES, type LifecyclePermittedAction } from '../types/lifecycle';

function LifecycleEmptyState({ hasWorkspace }: { hasWorkspace: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8" role="status">
      <div className="max-w-md text-center rounded-xl border border-border bg-panel p-8">
        <ShieldCheck size={32} className="mx-auto mb-3 text-accent" aria-hidden="true" />
        <h2 className="text-base font-semibold text-[var(--text)]">
          {hasWorkspace ? 'No lifecycle plans yet' : 'Select a workspace'}
        </h2>
        <p className="mt-2 text-sm text-muted">
          {hasWorkspace
            ? 'Lifecycle plans appear here after specs are compiled. Specs remains your backlog and authoring workspace.'
            : 'Choose a workspace from the main sidebar to load Lifecycle Control.'}
        </p>
      </div>
    </div>
  );
}

export default function LifecyclePanel() {
  const { workspaceId, selectedWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const lifecycle = useLifecycle();
  const selectedSpecError = lifecycle.selectedSpec.error;
  const selectedPhaseError = lifecycle.phase.error;
  const updateUrlState = lifecycle.updateUrlState;
  const [optimisticSelection, setOptimisticSelection] = useState<
    { specId: string; phaseId: (typeof LIFECYCLE_PHASES)[number]['id'] } | { closed: true } | null
  >(null);
  const [actionPending, setActionPending] = useState<LifecyclePermittedAction | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setOptimisticSelection(null);
    setActionPending(null);
    restoreFocusRef.current = null;
  }, [workspaceId]);

  // A malformed enum is normalized by useLifecycle. A syntactically valid but
  // nonexistent spec/phase is only known after the API responds, so clear that
  // stale selection without turning a recoverable portfolio error into a redirect.
  useEffect(() => {
    const invalidSpec = selectedSpecError instanceof ApiError && selectedSpecError.status === 404;
    const invalidPhase = selectedPhaseError instanceof ApiError
      && (selectedPhaseError.status === 400 || selectedPhaseError.status === 404);
    if (invalidSpec || invalidPhase) {
      updateUrlState({ selectedSpecId: null, selectedPhaseId: null }, true);
    }
  }, [selectedSpecError, selectedPhaseError, updateUrlState]);

  useEffect(() => {
    if (!optimisticSelection) return;
    if ('closed' in optimisticSelection) {
      if (!lifecycle.urlState.selectedSpecId) setOptimisticSelection(null);
      return;
    }
    if (
      lifecycle.urlState.selectedSpecId === optimisticSelection.specId
      && lifecycle.urlState.selectedPhaseId === optimisticSelection.phaseId
    ) setOptimisticSelection(null);
  }, [lifecycle.urlState.selectedPhaseId, lifecycle.urlState.selectedSpecId, optimisticSelection]);

  const activeSelection = optimisticSelection && 'closed' in optimisticSelection
    ? null
    : optimisticSelection ?? (lifecycle.urlState.selectedSpecId && lifecycle.urlState.selectedPhaseId
      ? { specId: lifecycle.urlState.selectedSpecId, phaseId: lifecycle.urlState.selectedPhaseId }
      : null);

  useEffect(() => {
    if (!activeSelection) return;
    const selectedCell = document.querySelector<HTMLElement>('.lifecycle-cell[data-selected="true"]');
    if (selectedCell) restoreFocusRef.current = selectedCell;
  }, [activeSelection]);

  const selectCell = (specId: string, phaseId: (typeof LIFECYCLE_PHASES)[number]['id']) => {
    if (document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('lifecycle-cell')) {
      restoreFocusRef.current = document.activeElement;
    }
    lifecycle.closeEvidence();
    // Selection feedback is a strict interaction budget. Commit the visible
    // highlight/drawer before React Router performs the shareable URL update.
    const switchingOpenDrawer = Boolean(activeSelection);
    flushSync(() => setOptimisticSelection({ specId, phaseId }));
    lifecycle.updateUrlState({ selectedSpecId: specId, selectedPhaseId: phaseId }, switchingOpenDrawer);
  };

  const closeDrawer = () => {
    lifecycle.closeEvidence();
    flushSync(() => setOptimisticSelection({ closed: true }));
    // Replace the selected entry so browser Back never reopens a drawer that
    // the user explicitly dismissed.
    lifecycle.updateUrlState({ selectedSpecId: null, selectedPhaseId: null }, true);
  };

  const handleDrawerAction = async (action: LifecyclePermittedAction) => {
    if (!activeSelection) return;
    const runId = lifecycle.selectedSpec.data?.currentRun?.id;
    if (action === 'retry_smallest_scope' || action === 'run_phase') {
      navigate(runId ? `/runs/${runId}` : '/runs');
      return;
    }
    if (action === 'request_approval' || action === 'reopen_disposition') {
      navigate(`/specs/${encodeURIComponent(activeSelection.specId)}/review`);
      return;
    }
    if (action !== 'recompile_plan') return;
    setActionPending(action);
    try {
      const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `lifecycle-recompile-${Date.now()}`;
      await lifecycle.mutations.recompile(activeSelection.specId, idempotencyKey);
    } finally {
      setActionPending(null);
    }
  };

  if (!workspaceId) return <LifecycleEmptyState hasWorkspace={false} />;
  if (lifecycle.portfolio.loading && !lifecycle.portfolio.data) return <LifecycleMatrixSkeleton />;

  if (lifecycle.portfolio.error && !lifecycle.portfolio.data) {
    return (
      <div className="flex-1 flex items-center justify-center p-8" role="alert">
        <div className="max-w-md text-center rounded-xl border border-error/30 bg-panel p-8">
          <AlertTriangle size={30} className="mx-auto mb-3 text-error" aria-hidden="true" />
          <h2 className="text-base font-semibold text-[var(--text)]">Lifecycle Control could not load</h2>
          <p className="mt-2 text-sm text-muted">{lifecycle.portfolio.error.message}</p>
          <button
            type="button"
            onClick={lifecycle.refresh}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <RefreshCw size={15} aria-hidden="true" /> Retry
          </button>
        </div>
      </div>
    );
  }

  const data = lifecycle.portfolio.data;
  if (!data) return <LifecycleMatrixSkeleton />;
  const drawerOpen = Boolean(activeSelection);
  const selectedPortfolioItem = data.items.find((item) => item.specId === activeSelection?.specId) ?? null;
  const selectedSpecData = lifecycle.selectedSpec.data?.specId === activeSelection?.specId
    ? lifecycle.selectedSpec.data
    : null;
  const drawerPhaseData = lifecycle.phase.data
    && lifecycle.phase.data.specId === activeSelection?.specId
    && lifecycle.phase.data.phaseId === activeSelection?.phaseId
    ? lifecycle.phase.data
    : null;
  const drawerTitle = `${selectedPortfolioItem?.title ?? selectedSpecData?.title ?? 'Spec'} — ${LIFECYCLE_PHASES.find((phase) => phase.id === activeSelection?.phaseId)?.displayName ?? 'Phase'}`;

  return (
    <section className="h-full min-h-0 flex flex-col bg-bg" aria-labelledby="lifecycle-control-heading">
      <header className="flex min-h-[72px] shrink-0 items-center border-b border-border bg-panel px-4 sm:px-6">
        <ShieldCheck size={22} className="mr-3 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0">
          <h1 id="lifecycle-control-heading" className="text-lg font-semibold text-[var(--text)]">Lifecycle Control</h1>
          <p className="truncate text-xs text-muted">End-to-end delivery completeness and evidence</p>
        </div>
        <div className="ml-auto min-w-0 rounded-md border border-border bg-bg px-3 py-1.5 text-right" aria-label={`Current workspace: ${selectedWorkspace?.name ?? data.workspace.label}`}>
          <div className="text-[10px] uppercase tracking-wide text-muted">Current workspace</div>
          <div className="max-w-[240px] truncate text-xs font-medium text-[var(--text)]">{selectedWorkspace?.name ?? data.workspace.label}</div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-3">
        {(lifecycle.stale || lifecycle.partialData) && (
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-[var(--text)]" role="status">
            Showing the last consistent snapshot while lifecycle evidence refreshes.
          </div>
        )}

        <LifecycleMetrics kpis={data.kpis} />
        <LifecycleToolbar lifecycle={lifecycle} phaseOrder={LIFECYCLE_PHASES} />

        {data.items.length === 0 ? (
          <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-border bg-panel p-8 text-center" role="status">
            <div className="max-w-md">
              <ShieldCheck size={28} className="mx-auto mb-3 text-accent" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-[var(--text)]">
                {Object.keys(lifecycle.filters).some((key) => key !== 'sort' && lifecycle.filters[key as keyof typeof lifecycle.filters] !== undefined)
                  ? 'No specs match the active filters'
                  : 'No lifecycle plans yet'}
              </h2>
              <p className="mt-2 text-xs text-muted">
                {Object.entries(lifecycle.filters)
                  .filter(([key, value]) => key !== 'sort' && value !== undefined)
                  .map(([key, value]) => `${key}: ${String(value).replace(/_/g, ' ')}`).join(' · ')
                  || 'Lifecycle plans appear after specs are compiled.'}
              </p>
            </div>
          </div>
        ) : (
          <LifecycleMatrix
            items={data.items}
            selectedSpecId={activeSelection?.specId ?? null}
            selectedPhaseId={activeSelection?.phaseId ?? null}
            compact={lifecycle.urlState.compact}
            pagination={lifecycle.pagination}
            onSelect={selectCell}
            onPageChange={lifecycle.setPage}
          />
        )}

        <footer className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-1 text-xs text-muted" aria-label="Lifecycle status legend">
          {(Object.entries(LIFECYCLE_STATUS_LABELS) as Array<[keyof typeof LIFECYCLE_STATUS_LABELS, string]>).map(([status, label]) => (
            <span key={status} className="inline-flex items-center gap-1"><LifecycleStatusIcon status={status} size={13} />{label}</span>
          ))}
        </footer>
      </div>

      <SlideOver
        isOpen={drawerOpen}
        onClose={closeDrawer}
        desktopMaxWidth={520}
        fullScreenBelowDesktop
        allowBackgroundInteraction
        restoreFocusRef={restoreFocusRef}
        hideHeader
        ariaLabel={drawerTitle}
        title={drawerTitle}
      >
        {drawerPhaseData ? (
          <LifecyclePhaseDrawer
            key={`${drawerPhaseData.specId}:${drawerPhaseData.phaseId}`}
            phase={drawerPhaseData}
            spec={selectedSpecData}
            portfolioItem={selectedPortfolioItem}
            evidence={lifecycle.evidence}
            selectedEvidenceId={lifecycle.selectedEvidenceId}
            onOpenEvidence={lifecycle.openEvidence}
            onCloseEvidence={lifecycle.closeEvidence}
            onClose={closeDrawer}
            onAction={(action) => { void handleDrawerAction(action); }}
            actionPending={actionPending}
          />
        ) : (
          <div className="flex min-h-full flex-col bg-bg">
            <header className="flex items-center gap-3 border-b border-border bg-panel px-5 py-4">
              <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--text)]">{drawerTitle}</h2>
              <button type="button" onClick={closeDrawer} aria-label="Close phase details" className="min-h-11 rounded-md px-3 text-sm text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Close</button>
            </header>
            <div className="p-5">
              {lifecycle.phase.error && !(lifecycle.phase.error instanceof ApiError && lifecycle.phase.error.status === 404) ? (
                <div className="border-l-2 border-error pl-3" role="alert">
                  <p className="text-sm text-[var(--text)]">Phase details could not load.</p>
                  <p className="mt-1 text-xs text-muted">{lifecycle.phase.error.message}</p>
                  <button type="button" onClick={lifecycle.refresh} className="mt-3 rounded-md bg-accent px-3 py-2 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Retry</button>
                </div>
              ) : <div className="text-sm text-muted" role="status">Loading phase evidence…</div>}
            </div>
          </div>
        )}
      </SlideOver>
    </section>
  );
}
