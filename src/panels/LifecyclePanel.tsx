/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useMemo } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Circle,
  Clock3,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import SlideOver from '../components/SlideOver';
import { LifecycleMatrixSkeleton } from '../components/skeletons';
import LifecycleMetrics from './LifecycleMetrics';
import LifecycleToolbar from './LifecycleToolbar';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useLifecycle } from '../hooks/useLifecycle';
import { ApiError } from '../lib/apiFetch';
import {
  LIFECYCLE_PHASE_IDS,
  type LifecycleEvaluatedStatus,
  type LifecyclePhaseCell,
  type LifecyclePhaseId,
} from '../types/lifecycle';

const FALLBACK_PHASES = LIFECYCLE_PHASE_IDS.map((id) => ({
  id,
  displayName: id.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
}));

const STATUS_LABELS: Record<LifecycleEvaluatedStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  awaiting_approval: 'Awaiting approval',
  passed: 'Passed',
  deferred: 'Deferred',
  not_applicable: 'Not applicable',
  stale: 'Stale',
};

function StatusIcon({ status }: { status: LifecycleEvaluatedStatus }) {
  if (status === 'passed') return <CheckCircle2 size={16} className="text-success" aria-hidden="true" />;
  if (status === 'blocked') return <AlertTriangle size={16} className="text-error" aria-hidden="true" />;
  if (status === 'in_progress') return <Clock3 size={16} className="text-accent" aria-hidden="true" />;
  if (status === 'awaiting_approval' || status === 'stale') return <AlertTriangle size={16} className="text-warning" aria-hidden="true" />;
  if (status === 'not_applicable' || status === 'deferred') return <Ban size={16} className="text-muted" aria-hidden="true" />;
  return <Circle size={14} className="text-muted" aria-hidden="true" />;
}

function phaseFor(itemPhases: LifecyclePhaseCell[], phaseId: LifecyclePhaseId): LifecyclePhaseCell {
  return itemPhases.find((phase) => phase.phaseId === phaseId) ?? {
    phaseId,
    displayName: FALLBACK_PHASES.find((phase) => phase.id === phaseId)?.displayName ?? phaseId,
    status: 'not_started',
    disposition: null,
    blocker: null,
    nextSafeAction: null,
  };
}

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
  const lifecycle = useLifecycle();
  const selectedSpecError = lifecycle.selectedSpec.error;
  const selectedPhaseError = lifecycle.phase.error;
  const updateUrlState = lifecycle.updateUrlState;

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

  const phaseOrder = useMemo(
    () => lifecycle.portfolio.data?.phaseOrder.length
      ? lifecycle.portfolio.data.phaseOrder
      : FALLBACK_PHASES,
    [lifecycle.portfolio.data?.phaseOrder],
  );

  const closeDrawer = () => {
    lifecycle.closeEvidence();
    lifecycle.updateUrlState({ selectedSpecId: null, selectedPhaseId: null });
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
  const drawerOpen = Boolean(
    lifecycle.urlState.selectedSpecId
    && lifecycle.urlState.selectedPhaseId
    && lifecycle.selectedSpec.data,
  );

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
        <LifecycleToolbar lifecycle={lifecycle} phaseOrder={phaseOrder} />

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
        ) : <div className="overflow-x-auto rounded-lg border border-border bg-panel">
          <table className="w-full min-w-[980px] border-collapse text-left text-xs">
            <caption className="sr-only">Lifecycle Control delivery phase matrix</caption>
            <thead className="bg-surface-100 text-muted">
              <tr>
                <th scope="col" className="sticky left-0 z-10 min-w-[230px] border-b border-r border-border bg-surface-100 px-3 py-3 font-medium">Spec</th>
                {phaseOrder.map((phase) => (
                  <th key={phase.id} scope="col" className="min-w-[76px] border-b border-border px-2 py-3 text-center font-medium">
                    {phase.displayName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.specId} className="border-b border-border last:border-b-0 hover:bg-surface-100/60">
                  <th scope="row" className="sticky left-0 z-10 border-r border-border bg-panel px-3 py-3 font-normal">
                    <div className="font-medium text-[var(--text)]">{item.title}</div>
                    {!lifecycle.urlState.compact && <div className="mt-1 text-muted">{item.risk} risk · {item.storySummary.total} stories</div>}
                  </th>
                  {phaseOrder.map(({ id: phaseId, displayName }) => {
                    const cell = phaseFor(item.phases, phaseId);
                    const selected = item.specId === lifecycle.urlState.selectedSpecId && phaseId === lifecycle.urlState.selectedPhaseId;
                    return (
                      <td key={phaseId} className="px-1 py-1 text-center">
                        <button
                          type="button"
                          onClick={() => lifecycle.updateUrlState({ selectedSpecId: item.specId, selectedPhaseId: phaseId })}
                          className={`mx-auto flex ${lifecycle.urlState.compact ? 'min-h-8 min-w-8' : 'min-h-10 min-w-10'} items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                            selected
                              ? 'border-accent bg-accent/15 text-accent'
                              : 'border-transparent hover:border-border hover:bg-surface-200'
                          }`}
                          aria-label={`${item.title}, ${displayName}: ${STATUS_LABELS[cell.status]}`}
                          title={`${displayName}: ${STATUS_LABELS[cell.status]}`}
                        >
                          <StatusIcon status={cell.status} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>}

        {lifecycle.pagination.total > lifecycle.pagination.limit && (
          <nav className="flex items-center justify-end gap-2" aria-label="Lifecycle pagination">
            <button
              type="button"
              disabled={lifecycle.pagination.page === 1}
              onClick={() => lifecycle.setPage(lifecycle.pagination.page - 1)}
              className="rounded-md border border-border px-3 py-2 text-sm text-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >Previous</button>
            <span className="text-xs text-muted">Page {lifecycle.pagination.page}</span>
            <button
              type="button"
              disabled={!lifecycle.pagination.hasMore}
              onClick={() => lifecycle.setPage(lifecycle.pagination.page + 1)}
              className="rounded-md border border-border px-3 py-2 text-sm text-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >Next</button>
          </nav>
        )}

        <footer className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-1 text-[11px] text-muted" aria-label="Lifecycle status legend">
          <span><CheckCircle2 size={12} className="mr-1 inline text-success" aria-hidden="true" />Passed</span>
          <span><Clock3 size={12} className="mr-1 inline text-accent" aria-hidden="true" />In progress</span>
          <span><AlertTriangle size={12} className="mr-1 inline text-error" aria-hidden="true" />Blocked</span>
          <span><Circle size={11} className="mr-1 inline" aria-hidden="true" />Not started</span>
          <span><Ban size={12} className="mr-1 inline" aria-hidden="true" />Deferred / N/A</span>
        </footer>
      </div>

      <SlideOver
        isOpen={drawerOpen}
        onClose={closeDrawer}
        desktopMaxWidth={520}
        title={`${lifecycle.selectedSpec.data?.title ?? 'Spec'} — ${lifecycle.urlState.selectedPhaseId ?? 'Phase'}`}
      >
        <div className="space-y-5 p-5 sm:p-6">
          {lifecycle.phase.loading && <div className="text-sm text-muted" role="status">Loading phase evidence…</div>}
          {lifecycle.phase.error && !(lifecycle.phase.error instanceof ApiError && lifecycle.phase.error.status === 404) && (
            <div className="rounded-lg border border-error/30 bg-error/10 p-4" role="alert">
              <p className="text-sm text-[var(--text)]">Phase details could not load.</p>
              <button type="button" onClick={lifecycle.refresh} className="mt-3 rounded-md bg-accent px-3 py-2 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Retry</button>
            </div>
          )}
          {lifecycle.phase.data && (
            <>
              <div className="rounded-lg border border-border bg-panel p-4">
                <div className="flex items-center gap-2">
                  <StatusIcon status={lifecycle.phase.data.status} />
                  <span className="font-medium text-[var(--text)]">{STATUS_LABELS[lifecycle.phase.data.status]}</span>
                </div>
                {lifecycle.phase.data.whyRequired && <p className="mt-3 text-sm text-muted">{lifecycle.phase.data.whyRequired}</p>}
                {lifecycle.phase.data.blocker && <p className="mt-3 text-sm text-error">{lifecycle.phase.data.blocker.reason}</p>}
                {lifecycle.phase.data.nextSafeAction && <p className="mt-3 text-sm text-[var(--text)]"><span className="font-medium">Next safe action:</span> {lifecycle.phase.data.nextSafeAction}</p>}
              </div>

              <section aria-labelledby="mapped-work-heading">
                <h3 id="mapped-work-heading" className="mb-2 text-sm font-semibold text-[var(--text)]">Mapped work</h3>
                <div className="rounded-lg border border-border bg-panel p-4 text-sm text-muted space-y-2">
                  <p><span className="text-[var(--text)]">Requirements:</span> {lifecycle.phase.data.mappedRequirements.total}</p>
                  <p><span className="text-[var(--text)]">Architecture decisions:</span> {lifecycle.phase.data.mappedDecisions.total}</p>
                  <p><span className="text-[var(--text)]">Stories:</span> {lifecycle.phase.data.mappedStories.total}</p>
                </div>
              </section>

              <section aria-labelledby="gates-heading">
                <h3 id="gates-heading" className="mb-2 text-sm font-semibold text-[var(--text)]">Required gates</h3>
                <div className="space-y-2">
                  {lifecycle.phase.data.requiredGates.items.length === 0 && <p className="text-sm text-muted">No gates are required for this phase.</p>}
                  {lifecycle.phase.data.requiredGates.items.map((gate) => (
                    <div key={gate.gateId} className="flex items-center gap-2 rounded-lg border border-border bg-panel p-3 text-sm">
                      {gate.evaluation ? <StatusIcon status={gate.evaluation.status} /> : <Circle size={14} className="text-muted" aria-hidden="true" />}
                      <span className="text-[var(--text)]">{gate.title}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section aria-labelledby="evidence-heading">
                <h3 id="evidence-heading" className="mb-2 text-sm font-semibold text-[var(--text)]">Evidence</h3>
                <div className="space-y-2">
                  {lifecycle.phase.data.evidence.items.length === 0 && <p className="text-sm text-muted">No evidence has been recorded.</p>}
                  {lifecycle.phase.data.evidence.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => lifecycle.openEvidence(item.id)}
                      className="w-full rounded-lg border border-border bg-panel p-3 text-left text-sm hover:bg-surface-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="font-medium text-[var(--text)]">{item.evidenceType}</span>
                      <span className="mt-1 block text-xs text-muted">{item.sourceSystem} · {item.status}</span>
                    </button>
                  ))}
                </div>
              </section>

              {lifecycle.selectedEvidenceId && (
                <section className="rounded-lg border border-accent/30 bg-accent/5 p-4" aria-live="polite">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-[var(--text)]">Evidence detail</h3>
                    <button type="button" onClick={lifecycle.closeEvidence} className="text-xs text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Close</button>
                  </div>
                  {lifecycle.evidence.loading && <p className="mt-2 text-sm text-muted">Loading evidence…</p>}
                  {lifecycle.evidence.error && <p className="mt-2 text-sm text-error">Evidence could not load.</p>}
                  {lifecycle.evidence.data && (
                    <div className="mt-3 space-y-2 text-xs text-muted">
                      <p><span className="text-[var(--text)]">Source:</span> {lifecycle.evidence.data.source.system}</p>
                      <p><span className="text-[var(--text)]">Subject:</span> {lifecycle.evidence.data.subject.type} · {lifecycle.evidence.data.subject.value}</p>
                      {lifecycle.evidence.data.excerpt && <p className="break-words">{lifecycle.evidence.data.excerpt}</p>}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </SlideOver>
    </section>
  );
}
