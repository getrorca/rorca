/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import {
  AlertTriangle,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import LifecyclePhaseView from '../components/LifecyclePhaseView';
import type { LifecycleSourceActionError } from '../components/LifecycleSourceWorkspace';
import { ProseWithHashes } from '../components/LifecycleHashChip';
import LifecycleGovernedActionDialog, { type LifecycleGovernedDialog } from '../components/LifecycleGovernedActionDialog';
import { LifecycleMatrixSkeleton } from '../components/skeletons';
import { LifecycleStatusBadge } from '../components/LifecycleBadges';
import { LIFECYCLE_STATUS_LABELS } from './LifecycleCell';
import LifecycleExplorer from './LifecycleExplorer';
import LifecycleMatrix from './LifecycleMatrix';
import LifecycleMetrics from './LifecycleMetrics';
import LifecycleToolbar from './LifecycleToolbar';
import { dispatchLifecycleRetry, getLifecyclePhaseAdvice, getLifecycleSourceArtifactContent, openLifecycleSourceArtifact, previewLifecycleRetry } from '../api/lifecycle';
import { getSpecReadinessInspection } from '../api/specs';
import { useGlobalToast } from '../contexts/ToastContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useLifecycle } from '../hooks/useLifecycle';
import { ApiError } from '../lib/apiFetch';
import { entityRoute } from '../lib/entityRoutes';
import { withReturnContext } from '../lib/returnContext';
import type { SpecCoverageByPhase } from '../lib/specWorkflow';
import { MISSION_CONTRACT_VERSIONS } from '../../shared/contracts/mission';
import {
  LIFECYCLE_PHASES,
  LIFECYCLE_STAGES,
  type LifecycleAdviceResponse,
  type LifecycleDecisionType,
  type LifecycleSourceArtifactAction,
  type LifecyclePermittedAction,
  type LifecyclePhaseResponse,
} from '../types/lifecycle';

const EMPTY_FILTERS = {
  search: undefined,
  status: undefined,
  specStatus: undefined,
  phase: undefined,
  risk: undefined,
  owner: undefined,
  blocked: undefined,
  disposition: undefined,
  sort: 'current_view' as const,
};

function LifecycleEmptyState({ hasWorkspace }: { hasWorkspace: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8" role="status">
      <div className="lifecycle-state-card max-w-md text-center rounded-xl border border-border bg-panel p-8">
        <ShieldCheck size={32} className="mx-auto mb-3 text-accent" aria-hidden="true" />
        <h2 className="text-base font-semibold text-[var(--text)]">
          {hasWorkspace ? 'No lifecycle plans yet' : 'Select a workspace'}
        </h2>
        <p className="mt-2 text-sm text-muted">
          {hasWorkspace
            ? 'Open Specs and compile an approved spec to create its lifecycle plan.'
            : 'Choose a workspace from the main sidebar to load Lifecycle Control.'}
        </p>
      </div>
    </div>
  );
}

function lifecycleErrorState(error: Error): { title: string; explanation: string; action: string | null } {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return {
      title: 'Lifecycle access is restricted',
      explanation: 'Your current workspace permission does not allow lifecycle evidence to be viewed. Ask a workspace administrator for access.',
      action: null,
    };
  }
  if (error instanceof ApiError && (error.status === 501 || /adapter/i.test(`${error.code} ${error.message}`))) {
    return {
      title: 'Lifecycle adapter is unavailable',
      explanation: 'Check the workspace adapter configuration, then retry without losing your current view.',
      action: 'Retry connection',
    };
  }
  return {
    title: 'Lifecycle Control could not load',
    explanation: `${error.message} Check the connection, then retry.`,
    action: 'Retry',
  };
}

export default function LifecyclePanel() {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useGlobalToast();
  const lifecycle = useLifecycle();
  const selectedSpecError = lifecycle.selectedSpec.error;
  const selectedPhaseError = lifecycle.phase.error;
  const updateUrlState = lifecycle.updateUrlState;
  const [optimisticSelection, setOptimisticSelection] = useState<
    { specId: string; phaseId: (typeof LIFECYCLE_PHASES)[number]['id'] } | { closed: true } | null
  >(null);
  const [actionPending, setActionPending] = useState<LifecyclePermittedAction | null>(null);
  const [sourceArtifactPending, setSourceArtifactPending] = useState<string | null>(null);
  const [sourceArtifactError, setSourceArtifactError] = useState<LifecycleSourceActionError | null>(null);
  const [governedDialog, setGovernedDialog] = useState<LifecycleGovernedDialog | null>(null);
  const [governedPending, setGovernedPending] = useState(false);
  const [governedError, setGovernedError] = useState<string | null>(null);
  const [readinessCoverage, setReadinessCoverage] = useState<SpecCoverageByPhase | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  // US-011: advisory "what's missing" panel state. Server never persists advice.
  const [advice, setAdvice] = useState<LifecycleAdviceResponse | null>(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [adviceError, setAdviceError] = useState<string | null>(null);
  const boardScrollRef = useRef<HTMLDivElement | null>(null);
  const boardScrollTopRef = useRef(0);
  const restoreCoordinateRef = useRef<{ specId: string; phaseId: (typeof LIFECYCLE_PHASES)[number]['id'] } | null>(null);
  const phaseWasOpenRef = useRef(false);
  const lastPhaseDataRef = useRef<LifecyclePhaseResponse | null>(null);

  useEffect(() => {
    setOptimisticSelection(null);
    setActionPending(null);
    setSourceArtifactPending(null);
    setSourceArtifactError(null);
    setGovernedDialog(null);
    setGovernedPending(false);
    setGovernedError(null);
    restoreCoordinateRef.current = null;
    boardScrollTopRef.current = 0;
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

  const activeSelection = useMemo(() => (
    optimisticSelection && 'closed' in optimisticSelection
      ? null
      : optimisticSelection ?? (lifecycle.urlState.selectedSpecId && lifecycle.urlState.selectedPhaseId
        ? { specId: lifecycle.urlState.selectedSpecId, phaseId: lifecycle.urlState.selectedPhaseId }
        : null)
  ), [lifecycle.urlState.selectedPhaseId, lifecycle.urlState.selectedSpecId, optimisticSelection]);

  // Restore the exact board scroll position and stage/phase-cell focus after
  // the full-width detail view unmounts. Coordinates survive node remounting.
  useEffect(() => {
    const wasOpen = phaseWasOpenRef.current;
    phaseWasOpenRef.current = Boolean(activeSelection);
    if (!wasOpen || activeSelection) return;
    window.requestAnimationFrame(() => {
      if (boardScrollRef.current) boardScrollRef.current.scrollTop = boardScrollTopRef.current;
      const coordinate = restoreCoordinateRef.current;
      if (!coordinate) return;
      const phase = LIFECYCLE_PHASES.find((candidate) => candidate.id === coordinate.phaseId);
      if (!phase) return;
      const stageId = LIFECYCLE_STAGES.find((stage) => stage.phaseIds.includes(phase.id))?.id;
      const cells = Array.from(document.querySelectorAll<HTMLElement>(
        '[data-lifecycle-phase-cell="true"], [data-lifecycle-phase-tab="true"], [data-lifecycle-stage-cell="true"]',
      ));
      const target = cells.find((cell) => (
        cell.closest<HTMLElement>('[data-spec-id]')?.dataset.specId === coordinate.specId
        && (cell.dataset.phase === coordinate.phaseId || (stageId !== undefined && cell.dataset.stage === stageId))
      ));
      target?.focus();
    });
  }, [activeSelection]);

  const activeSelectionRef = useRef(activeSelection);
  activeSelectionRef.current = activeSelection;
  // US-010: per-phase engineering-canon coverage comes from the readiness
  // inspection (coverageByPhase), fetched once per selected spec. Absent or
  // failed coverage degrades to the 'coverage unavailable' rendering — it is
  // never a phase-view error.
  useEffect(() => {
    if (!workspaceId || !activeSelection?.specId) {
      setReadinessCoverage(null);
      setCoverageLoading(false);
      return;
    }
    const controller = new AbortController();
    setCoverageLoading(true);
    getSpecReadinessInspection(activeSelection.specId, workspaceId, { signal: controller.signal })
      .then((inspection) => {
        if (controller.signal.aborted) return;
        setReadinessCoverage(inspection.coverageByPhase ?? null);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setReadinessCoverage(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCoverageLoading(false);
      });
    return () => controller.abort();
  }, [activeSelection?.specId, workspaceId]);
  // US-011: advice is scoped to the selected spec+phase and cleared on change.
  useEffect(() => {
    setAdvice(null);
    setAdviceLoading(false);
    setAdviceError(null);
    setSourceArtifactError(null);
  }, [activeSelection?.specId, activeSelection?.phaseId]);
  const requestAdvice = async () => {
    if (!workspaceId || !activeSelection || adviceLoading) return;
    setAdviceLoading(true);
    setAdviceError(null);
    try {
      const response = await getLifecyclePhaseAdvice(workspaceId, activeSelection.specId, activeSelection.phaseId);
      setAdvice(response);
    } catch (error) {
      setAdvice(null);
      setAdviceError(error instanceof Error ? error.message : 'The phase advisor could not generate suggestions.');
    } finally {
      setAdviceLoading(false);
    }
  };
  const closeEvidence = lifecycle.closeEvidence;
  const selectCell = useCallback((specId: string, phaseId: (typeof LIFECYCLE_PHASES)[number]['id']) => {
    if (boardScrollRef.current) boardScrollTopRef.current = boardScrollRef.current.scrollTop;
    restoreCoordinateRef.current = { specId, phaseId };
    closeEvidence();
    // Selection feedback is a strict interaction budget. Commit the view
    // transition before React Router performs the shareable URL update.
    const switchingOpenView = Boolean(activeSelectionRef.current);
    if (!switchingOpenView) lastPhaseDataRef.current = null;
    flushSync(() => setOptimisticSelection({ specId, phaseId }));
    updateUrlState({ selectedSpecId: specId, selectedPhaseId: phaseId }, switchingOpenView);
  }, [closeEvidence, updateUrlState]);

  const closePhaseView = () => {
    const current = activeSelectionRef.current;
    if (current) restoreCoordinateRef.current = current;
    lifecycle.closeEvidence();
    lastPhaseDataRef.current = null;
    flushSync(() => setOptimisticSelection({ closed: true }));
    // Replace the selected entry so browser Back never reopens a phase detail
    // view the operator explicitly dismissed.
    lifecycle.updateUrlState({ selectedSpecId: null, selectedPhaseId: null }, true);
  };

  const openSpecReview = useCallback((specId: string) => {
    if (!workspaceId) return;
    const destination = entityRoute({
      schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
      workspaceId,
      kind: 'spec',
      id: specId,
      label: lifecycle.selectedSpec.data?.title ?? specId,
    });
    navigate(withReturnContext(destination, location, { focus: `phase:${activeSelection?.phaseId ?? 'overview'}`, lens: 'lifecycle' }));
  }, [activeSelection?.phaseId, lifecycle.selectedSpec.data?.title, location, navigate, workspaceId]);


  const handleOpenSourceArtifact = async (
    relativePath: string,
    action: LifecycleSourceArtifactAction,
    line?: number | null,
    column?: number | null,
  ) => {
    if (!workspaceId || !activeSelection || sourceArtifactPending) return;
    const pendingKey = `${action}:${relativePath}:${line ?? ''}`;
    setSourceArtifactPending(pendingKey);
    try {
      const result = await openLifecycleSourceArtifact(
        workspaceId,
        activeSelection.specId,
        relativePath,
        action,
        line,
        column,
      );
      setSourceArtifactError(null);
      toast.success(action === 'open'
        ? `Opened ${relativePath} in ${result.editor}.`
        : `Revealed ${relativePath} in ${result.editor}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Could not ${action} the source artifact.`;
      setSourceArtifactError({
        relativePath,
        action,
        line,
        column,
        message,
        remediation: error instanceof ApiError && error.status === 403
          ? 'Verify canonical source authority for this workspace, then retry. The phase, source view, preview, and copy-path actions remain available.'
          : 'Check the local editor integration and workspace path, then retry without leaving this phase.',
      });
      toast.error(message);
    } finally {
      setSourceArtifactPending(null);
    }
  };

  const handleReadSourceArtifact = useCallback((
    relativePath: string,
    startLine?: number | null,
    endLine?: number | null,
  ) => {
    if (!workspaceId || !activeSelection) {
      return Promise.reject(new Error('Select a workspace phase before reading source material.'));
    }
    return getLifecycleSourceArtifactContent(
      workspaceId,
      activeSelection.specId,
      relativePath,
      startLine,
      endLine,
    );
  }, [activeSelection, workspaceId]);

  const handlePhaseAction = async (action: LifecyclePermittedAction) => {
    if (!activeSelection || actionPending || governedPending) return;
    const runId = lifecycle.selectedSpec.data?.currentRun?.id;
    if (action === 'run_phase') {
      if (runId && workspaceId) {
        const destination = entityRoute({
          schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
          workspaceId,
          kind: 'run',
          id: String(runId),
          label: `Run #${runId}`,
        });
        navigate(withReturnContext(destination, location, { focus: `phase:${activeSelection.phaseId}`, lens: 'lifecycle' }));
      } else {
        navigate(withReturnContext('/runs', location, { focus: `phase:${activeSelection.phaseId}`, lens: 'lifecycle' }));
      }
      return;
    }
    if (action === 'retry_smallest_scope') {
      if (!runId || !workspaceId) {
        toast.error('Retry preview is unavailable because the server reported no current run. Open Runs and select a retryable run.');
        return;
      }
      setActionPending(action);
      setGovernedError(null);
      try {
        const preview = await previewLifecycleRetry(workspaceId, runId);
        setGovernedDialog({ kind: 'retry', preview });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Retry preview failed');
      } finally {
        setActionPending(null);
      }
      return;
    }
    if (action === 'reopen_disposition') {
      setGovernedError(null);
      setGovernedDialog({ kind: 'decision', decisionType: 'gate_override' });
      return;
    }
    if (action === 'request_approval') {
      const decisionType: LifecycleDecisionType | null = activeSelection.phaseId === 'testing'
        ? 'testing_approval'
        : activeSelection.phaseId === 'deployment'
          ? 'deployment_approval'
          : null;
      if (!decisionType) {
        toast.warning('This phase uses an approval workflow outside Lifecycle Control. Open Spec Review for the server-authorized next action.');
        openSpecReview(activeSelection.specId);
        return;
      }
      setGovernedError(null);
      setGovernedDialog({ kind: 'decision', decisionType });
      return;
    }
    if (action !== 'recompile_plan') return;
    setActionPending(action);
    try {
      const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `lifecycle-recompile-${Date.now()}`;
      await lifecycle.mutations.recompile(activeSelection.specId, idempotencyKey);
      toast.success('Lifecycle plan was durably recompiled.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Lifecycle recompile failed');
    } finally {
      setActionPending(null);
    }
  };

  const confirmRetry = async () => {
    if (governedPending || governedDialog?.kind !== 'retry' || !workspaceId) return;
    setGovernedPending(true);
    setGovernedError(null);
    try {
      const result = await dispatchLifecycleRetry(
        workspaceId,
        governedDialog.preview.preview.originalRunId,
        governedDialog.preview,
        globalThis.crypto?.randomUUID?.() ?? `lifecycle-retry-${governedDialog.preview.preview.previewHash}`,
      );
      setGovernedDialog(null);
      lifecycle.refresh();
      toast.success(result.duplicate ? `Retry run #${result.runId} was already queued.` : `Retry run #${result.runId} was durably queued.`, {
        action: {
          label: 'Open run',
          onClick: () => {
            if (!workspaceId) return;
            navigate(withReturnContext(entityRoute({
              schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
              workspaceId,
              kind: 'run',
              id: String(result.runId),
              label: `Run #${result.runId}`,
            }), location, { focus: `phase:${activeSelection?.phaseId ?? 'retry'}`, lens: 'lifecycle' }));
          },
        },
        persistent: true,
      });
    } catch (error) {
      setGovernedError(`${error instanceof Error ? error.message : 'Retry dispatch failed'} Next action: generate a current preview after resolving the reported server blocker.`);
    } finally {
      setGovernedPending(false);
    }
  };

  const confirmDecision = async (input: { rationale: string; evidenceGap?: string; expiresAt?: string }) => {
    if (governedPending || governedDialog?.kind !== 'decision' || !activeSelection) return;
    const phaseData = lifecycle.phase.data;
    if (!phaseData) return;
    const gate = phaseData.requiredGates.items.find((item) => item.gateId === phaseData.blocker?.gateId)
      ?? phaseData.requiredGates.items.find((item) => item.evaluation?.status !== 'passed');
    const releaseSubject = 'activeReleaseSubject' in phaseData.evaluationSnapshot
      ? phaseData.evaluationSnapshot.activeReleaseSubject
      : null;
    const approvalSubject: { type: 'commit_sha' | 'artifact_digest'; value: string } | undefined =
      releaseSubject?.type === 'commit_sha' || releaseSubject?.type === 'artifact_digest'
        ? { type: releaseSubject.type, value: releaseSubject.value }
        : undefined;
    setGovernedPending(true);
    setGovernedError(null);
    try {
      const result = await lifecycle.mutations.recordDecision({
        specSlug: activeSelection.specId,
        phaseId: activeSelection.phaseId,
        decisionType: governedDialog.decisionType,
        rationale: input.rationale,
        evidenceGap: input.evidenceGap,
        expiresAt: input.expiresAt,
        gateId: gate?.gateId,
        specVersion: lifecycle.selectedSpec.data?.plan?.specVersion,
        runId: lifecycle.selectedSpec.data?.currentRun?.id,
        ...(approvalSubject ? { subject: approvalSubject } : {}),
      }, globalThis.crypto?.randomUUID?.() ?? `lifecycle-decision-${Date.now()}`);
      setGovernedDialog(null);
      toast.success(`Decision ${result.decision.id} was durably recorded; lifecycle state will refresh from server evidence.`, {
        action: { label: 'View decision', onClick: () => lifecycle.refresh() },
        persistent: true,
      });
    } catch (error) {
      setGovernedError(`${error instanceof Error ? error.message : 'Decision was denied'} No approval was recorded. Correct the server-reported scope, identity, evidence, or revision and try again.`);
    } finally {
      setGovernedPending(false);
    }
  };

  if (!workspaceId) return <LifecycleEmptyState hasWorkspace={false} />;
  if (lifecycle.portfolio.loading && !lifecycle.portfolio.data) return <LifecycleMatrixSkeleton />;

  if (lifecycle.portfolio.error && !lifecycle.portfolio.data) {
    const errorState = lifecycleErrorState(lifecycle.portfolio.error);
    return (
      <div className="lifecycle-control flex-1 flex items-center justify-center p-8" role="alert">
        <div className="lifecycle-state-card max-w-md text-center rounded-xl border border-error/30 bg-panel p-8">
          <AlertTriangle size={30} className="mx-auto mb-3 text-error" aria-hidden="true" />
          <h2 className="text-base font-semibold text-[var(--text)]">{errorState.title}</h2>
          <p className="mt-2 text-sm text-muted"><ProseWithHashes text={errorState.explanation} /></p>
          {errorState.action && (
            <button
              type="button"
              onClick={lifecycle.refresh}
              className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <RefreshCw size={15} aria-hidden="true" /> {errorState.action}
            </button>
          )}
        </div>
      </div>
    );
  }

  const data = lifecycle.portfolio.data;
  if (!data) return <LifecycleMatrixSkeleton />;
  const phaseViewOpen = Boolean(activeSelection);
  const selectedPortfolioItem = data.items.find((item) => item.specId === activeSelection?.specId) ?? null;
  const selectedSpecData = lifecycle.selectedSpec.data?.specId === activeSelection?.specId
    ? lifecycle.selectedSpec.data
    : null;
  const phaseData = lifecycle.phase.data
    && lifecycle.phase.data.specId === activeSelection?.specId
    && lifecycle.phase.data.phaseId === activeSelection?.phaseId
    ? lifecycle.phase.data
    : null;
  if (phaseData) lastPhaseDataRef.current = phaseData;
  const retainedPhaseData = phaseData ?? (
    lastPhaseDataRef.current?.workspaceId === workspaceId
    && lastPhaseDataRef.current.specId === activeSelection?.specId
      ? lastPhaseDataRef.current
      : null
  );
  const phasePending = Boolean(retainedPhaseData && !phaseData);
  const phaseViewTitle = `${selectedPortfolioItem?.title ?? selectedSpecData?.title ?? 'Spec'} — ${LIFECYCLE_PHASES.find((phase) => phase.id === activeSelection?.phaseId)?.displayName ?? 'Phase'}`;
  const filtersActive = Object.entries(lifecycle.filters).some(([key, value]) => key !== 'sort' && value !== undefined);
  const filterLabels = Object.entries(lifecycle.filters)
    .filter(([key, value]) => key !== 'sort' && value !== undefined)
    .map(([key, value]) => `${key.replace(/([A-Z])/g, ' $1')}: ${String(value).replace(/_/g, ' ')}`);

  return (
    <section className="lifecycle-control h-full min-h-0 flex flex-col bg-bg" aria-labelledby="lifecycle-control-heading">
      <header className="flex min-h-16 shrink-0 items-center border-b border-border bg-panel px-4 sm:px-6">
        <ShieldCheck size={20} className="mr-2.5 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0">
          <h1 id="lifecycle-control-heading" className="text-base font-semibold tracking-tight text-[var(--text)] sm:text-lg">Lifecycle Control</h1>
          <p className="truncate text-xs text-muted">Track gates, evidence, approvals, and release readiness.</p>
        </div>
      </header>

      {phaseViewOpen ? (
        <div
          className="lifecycle-phase-shell flex-1 min-h-0 overflow-y-auto"
          role="region"
          aria-label={phaseViewTitle}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !governedDialog) {
              event.stopPropagation();
              closePhaseView();
            }
          }}
        >
          {(lifecycle.stale || lifecycle.partialData) && (
            <div className="m-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-[var(--text)]" role="status">
              Showing the last consistent snapshot while lifecycle evidence refreshes.
            </div>
          )}
          {retainedPhaseData && activeSelection ? (
            <LifecyclePhaseView
              phase={retainedPhaseData}
              selectedPhaseId={activeSelection.phaseId}
              phasePending={phasePending}
              spec={selectedSpecData}
              portfolioItem={selectedPortfolioItem}
              evidence={lifecycle.evidence}
              selectedEvidenceId={lifecycle.selectedEvidenceId}
              selectedEvidenceSnapshotId={lifecycle.selectedEvidenceSnapshotId}
              onOpenEvidence={lifecycle.openEvidence}
              onCloseEvidence={lifecycle.closeEvidence}
              onRefreshEvidence={lifecycle.refreshEvidence}
              onClose={closePhaseView}
              onSelectPhase={(phaseId) => selectCell(activeSelection.specId, phaseId)}
              onAction={(action) => { void handlePhaseAction(action); }}
              actionPending={actionPending}
              coverage={readinessCoverage}
              coverageLoading={coverageLoading}
              advice={advice}
              adviceLoading={adviceLoading}
              adviceError={adviceError}
              onRequestAdvice={() => { void requestAdvice(); }}
              onOpenSourceArtifact={(relativePath, action, line, column) => {
                void handleOpenSourceArtifact(relativePath, action, line, column);
              }}
              sourceArtifactError={sourceArtifactError}
              onDismissSourceArtifactError={() => setSourceArtifactError(null)}
              onReadSourceArtifact={handleReadSourceArtifact}
              sourceArtifactPending={sourceArtifactPending}
            />
          ) : (
            <div className="flex min-h-full flex-col bg-bg">
              <header className="flex items-center gap-3 border-b border-border bg-panel px-5 py-4">
                <button type="button" onClick={closePhaseView} className="min-h-11 rounded-md border border-border px-3 text-sm text-muted hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Back to board</button>
                <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--text)]">{phaseViewTitle}</h2>
              </header>
              <div className="p-5">
                {lifecycle.phase.error && !(lifecycle.phase.error instanceof ApiError && lifecycle.phase.error.status === 404) ? (
                  <div className="border-l-2 border-error pl-3" role="alert">
                    <p className="text-sm text-[var(--text)]">Phase details could not load.</p>
                    <p className="mt-1 text-xs text-muted"><ProseWithHashes text={lifecycle.phase.error.message} /></p>
                    <button type="button" onClick={lifecycle.refresh} className="mt-3 rounded-md bg-accent px-3 py-2 text-sm text-[var(--accent-contrast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Retry</button>
                  </div>
                ) : <div className="text-sm text-muted" role="status">Loading phase evidence…</div>}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          ref={boardScrollRef}
          onScroll={(event) => { boardScrollTopRef.current = event.currentTarget.scrollTop; }}
          className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-3"
        >
          {(lifecycle.stale || lifecycle.partialData) && (
            <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-[var(--text)]" role="status">
              Showing the last consistent snapshot while lifecycle evidence refreshes.
            </div>
          )}

          <LifecycleMetrics kpis={data.kpis} />
          <LifecycleToolbar lifecycle={lifecycle} stageOrder={LIFECYCLE_STAGES} />

          {data.items.length === 0 ? (
            <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-border bg-panel p-8 text-center" role="status">
              <div className="max-w-md">
                <ShieldCheck size={28} className="mx-auto mb-3 text-accent" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-[var(--text)]">
                  {filtersActive ? 'No specs match the active filters' : 'No lifecycle plans yet'}
                </h2>
                {filtersActive ? (
                  <>
                    <p className="mt-2 text-xs text-muted">Try removing a filter or clear them all to return to the full delivery board.</p>
                    <div className="mt-3 flex flex-wrap justify-center gap-1.5" aria-label="Active empty-state filters">
                      {filterLabels.map((label) => <span key={label} className="lifecycle-chip">{label}</span>)}
                    </div>
                    <button
                      type="button"
                      onClick={() => lifecycle.updateFilters(EMPTY_FILTERS)}
                      className="mt-4 min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >Clear all filters</button>
                  </>
                ) : (
                  <>
                    <p className="mt-2 text-xs text-muted">Open Specs and compile an approved spec to create its lifecycle plan.</p>
                    <button type="button" onClick={() => navigate('/specs')} className="mt-4 min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Open Specs</button>
                  </>
                )}
              </div>
            </div>
          ) : lifecycle.urlState.mode === 'matrix' ? (
            <LifecycleMatrix
              items={data.items}
              selectedSpecId={activeSelection?.specId ?? null}
              selectedPhaseId={activeSelection?.phaseId ?? null}
              focusSpecId={restoreCoordinateRef.current?.specId ?? null}
              focusPhaseId={restoreCoordinateRef.current?.phaseId ?? null}
              compact={lifecycle.urlState.compact}
              stages={data.stageProfile?.stages ?? null}
              pagination={lifecycle.pagination}
              onSelect={selectCell}
              onOpenSpec={openSpecReview}
              onPageChange={lifecycle.setPage}
            />
          ) : (
            <LifecycleExplorer
              items={data.items}
              selectedSpecId={activeSelection?.specId ?? null}
              selectedPhaseId={activeSelection?.phaseId ?? null}
              focusSpecId={restoreCoordinateRef.current?.specId ?? null}
              focusPhaseId={restoreCoordinateRef.current?.phaseId ?? null}
              pagination={lifecycle.pagination}
              onSelect={selectCell}
              onOpenSpec={openSpecReview}
              onPageChange={lifecycle.setPage}
            />
          )}

          <footer className="border-t border-border px-1 py-2 text-xs text-muted">
            <details className="lifecycle-legend">
              <summary className="cursor-pointer font-medium text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Status legend</summary>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Lifecycle status legend">
                {(Object.keys(LIFECYCLE_STATUS_LABELS) as Array<keyof typeof LIFECYCLE_STATUS_LABELS>).map((status) => (
                  <LifecycleStatusBadge key={status} status={status} />
                ))}
              </div>
            </details>
          </footer>
        </div>
      )}

      {governedDialog && phaseData && (
        <LifecycleGovernedActionDialog
          dialog={governedDialog}
          phase={phaseData}
          spec={selectedSpecData}
          portfolioItem={selectedPortfolioItem}
          pending={governedPending}
          error={governedError}
          onCancel={() => {
            if (!governedPending) {
              setGovernedDialog(null);
              setGovernedError(null);
            }
          }}
          onRetryConfirm={() => { void confirmRetry(); }}
          onDecisionConfirm={(input) => { void confirmDecision(input); }}
        />
      )}
    </section>
  );
}
