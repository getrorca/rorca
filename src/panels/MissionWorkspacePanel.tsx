/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Mission Workspace panel. One URL-addressable delivery case:
 * `/missions/:specId` (overview) plus one lens per delivery stage. Every
 * datum comes from the strict delivery-case / run-control projections —
 * permission, liveness, readiness, and completion are never inferred
 * client-side. Cross-surface links carry return context; lens switches
 * preserve the current query string.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { FileSearch, FolderOpen, PlayCircle, Rocket } from 'lucide-react';
import {
  getDeliveryCaseSummary,
  getRunControlProjection,
  MissionContractError,
} from '../api/mission';
import type {
  DeliveryCaseSummaryV1,
  DeliveryStageProjectionV1,
  RunControlProjectionV1,
} from '../../shared/contracts/mission';
import { MISSION_CONTRACT_VERSIONS } from '../../shared/contracts/mission';
import MissionHeader from '../components/mission/MissionHeader';
import StageRail from '../components/mission/StageRail';
import SemanticRunCanvas from '../components/mission/SemanticRunCanvas';
import IntentSourceProvenance from '../components/mission/IntentSourceProvenance';
import StateChips, {
  ALL_STATE_FACETS,
  BlockerNote,
  type StateFacet,
} from '../components/mission/StateChips';
import LifecycleHashChip from '../components/LifecycleHashChip';
import EmptyState from '../components/EmptyState';
import ErrorBanner from '../components/ErrorBanner';
import { SkeletonBlock, SkeletonLine } from '../components/Skeleton';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { ApiError } from '../lib/apiFetch';
import { entityRoute } from '../lib/entityRoutes';
import { consumeReturnContext, withReturnContext } from '../lib/returnContext';
import {
  MISSION_LENSES,
  MISSION_LENS_LABELS,
  isMissionLens,
  missionCasePath,
  type MissionLens,
} from '../lib/missionRoutes';
import { formatAbsoluteTime, formatRelativeTime } from '../lib/missionFormat';

type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; value: T };

const QUIET_LINK =
  'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-[var(--text)]';

/* ─── Shared building blocks ─────────────────────────────────────────────── */

function StageCard({
  stage,
  facets = ALL_STATE_FACETS,
}: {
  stage: DeliveryStageProjectionV1;
  facets?: readonly StateFacet[];
}) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-4">
      <h3 className="text-sm font-semibold text-[var(--text)]">{stage.label}</h3>
      <p className="text-sm text-muted">{stage.summary}</p>
      <StateChips packet={stage.state} facets={facets} />
      <span className="text-xs text-muted">updated {formatRelativeTime(stage.updatedAt)}</span>
      {stage.state.blocker && <BlockerNote blocker={stage.state.blocker} />}
    </section>
  );
}

/** Honest fail-closed state when a backend payload violates the contract. */
function ContractViolation({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: MissionContractError;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="w-full max-w-lg rounded-xl border border-border bg-panel p-6">
        <h2 className="text-base font-semibold text-[var(--text)]">{title}</h2>
        <p className="mt-2 text-sm text-muted">
          The backend response for <code className="font-mono text-xs">{error.endpoint}</code> did
          not match the published contract. This surface fails closed rather than guessing mission
          state from a payload it cannot trust.
        </p>
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">Contract issues</summary>
          <ul className="mt-2 list-disc pl-5">
            {error.issues.map((issue) => (
              <li key={issue}>
                <code className="font-mono">{issue}</code>
              </li>
            ))}
          </ul>
        </details>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="flex h-full flex-col" aria-busy="true" aria-label="Loading mission workspace">
      <div className="border-b border-border bg-panel p-5">
        <SkeletonLine className="w-40" />
        <SkeletonBlock className="mt-3 h-6 w-72" />
        <SkeletonLine className="mt-3 w-full max-w-xl" />
        <SkeletonLine className="mt-2 w-2/3 max-w-lg" />
      </div>
      <div className="border-b border-border bg-panel px-5 py-3">
        <SkeletonBlock className="h-5 w-full max-w-md" />
      </div>
      <div className="flex-1 p-5">
        <SkeletonBlock className="h-40 w-full" />
      </div>
    </div>
  );
}

/* ─── Lenses ─────────────────────────────────────────────────────────────── */

function OverviewLens({ summary, specId }: { summary: DeliveryCaseSummaryV1; specId: string }) {
  const location = useLocation();
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {MISSION_LENSES.map((lens) => {
          const stage = summary.stages[lens];
          return (
            <div key={lens} className="flex flex-col gap-2">
              <StageCard stage={stage} facets={['outcome', 'liveness', 'risk']} />
              <Link
                to={`${missionCasePath(specId, lens)}${location.search}`}
                className="text-xs font-medium text-accent hover:underline"
              >
                Open {stage.label} lens
              </Link>
            </div>
          );
        })}
      </div>
      <section aria-label="Case projections" className="rounded-lg border border-border bg-panel p-4">
        <h3 className="text-sm font-semibold text-[var(--text)]">Case projections</h3>
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          <div className="flex gap-2">
            <dt className="w-24 flex-none text-muted">Review</dt>
            <dd className="text-[var(--text)]">
              {summary.review.state} · {summary.review.unresolvedDecisions} of{' '}
              {summary.review.requiredDecisions} decisions unresolved
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 flex-none text-muted">Readiness</dt>
            <dd className="text-[var(--text)]">
              {summary.readiness.state} · {summary.readiness.completedChecks} of{' '}
              {summary.readiness.totalChecks} checks
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 flex-none text-muted">Lifecycle</dt>
            <dd className="text-[var(--text)]">
              {summary.lifecycle.state} · current stage {summary.lifecycle.currentStage}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 flex-none text-muted">Run</dt>
            <dd className="text-[var(--text)]">{summary.run.state}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-24 flex-none text-muted">Release</dt>
            <dd className="text-[var(--text)]">{summary.release.state}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function PlanningLens({ summary }: { summary: DeliveryCaseSummaryV1 }) {
  const location = useLocation();
  const reviewHref = withReturnContext(entityRoute(summary.spec), location, { lens: 'planning' });
  return (
    <div className="flex min-w-0 max-w-3xl flex-col gap-4">
      <StageCard stage={summary.stages.planning} />
      <IntentSourceProvenance
        bundle={summary.sourceBundle}
        drift={summary.sourceContext}
        reviewHref={reviewHref}
      />
    </div>
  );
}

function RequirementsLens({ summary }: { summary: DeliveryCaseSummaryV1 }) {
  const location = useLocation();
  const specRoute = entityRoute(summary.spec);
  const lifecycleTabRoute = specRoute.includes('?')
    ? `${specRoute}&tab=lifecycle`
    : `${specRoute}?tab=lifecycle`;
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <StageCard stage={summary.stages.requirements} />
      <p className="text-sm text-muted">
        Review: {summary.review.state} · {summary.review.unresolvedDecisions} of{' '}
        {summary.review.requiredDecisions} decisions unresolved
      </p>
      <p className="text-sm text-muted">
        Readiness: {summary.readiness.state} · {summary.readiness.completedChecks} of{' '}
        {summary.readiness.totalChecks} checks
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          to={withReturnContext(specRoute, location, { lens: 'requirements' })}
          className={QUIET_LINK}
        >
          Open stories and review
        </Link>
        <Link
          to={withReturnContext(lifecycleTabRoute, location, { lens: 'requirements' })}
          className={QUIET_LINK}
        >
          Open lifecycle plan in Spec Review
        </Link>
      </div>
      <p className="text-xs text-muted">
        Approved execution starts from the canonical trigger in Spec Review; the immutable receipt
        names the exact returned run. This lens does not duplicate the trigger.
      </p>
    </div>
  );
}

function DesignLens({ summary, specId }: { summary: DeliveryCaseSummaryV1; specId: string }) {
  const location = useLocation();
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <StageCard stage={summary.stages.design} />
      <p className="text-sm text-muted">
        Architecture decisions and threat-model controls are evaluated in Lifecycle Control; this
        lens links rather than re-evaluates.
      </p>
      <div>
        <Link
          to={withReturnContext(`/lifecycle?spec=${encodeURIComponent(specId)}`, location, {
            lens: 'design',
          })}
          className={QUIET_LINK}
        >
          Open Lifecycle Control for this spec
        </Link>
      </div>
    </div>
  );
}

function DevelopmentLens({
  summary,
  specId,
  workspaceId,
}: {
  summary: DeliveryCaseSummaryV1;
  specId: string;
  workspaceId: string;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const run = summary.run.run ?? null;
  const runId = run?.id ?? null;
  const [reloadKey, setReloadKey] = useState(0);
  const [control, setControl] = useState<AsyncState<RunControlProjectionV1>>({ status: 'loading' });

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    setControl({ status: 'loading' });
    getRunControlProjection(workspaceId, specId, runId, { signal: controller.signal })
      .then((projection) => {
        if (!controller.signal.aborted) setControl({ status: 'ready', value: projection });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setControl({ status: 'error', error });
      });
    return () => controller.abort();
  }, [workspaceId, specId, runId, reloadKey]);

  return (
    <div className="flex flex-col gap-4">
      <div className="max-w-2xl">
        <StageCard stage={summary.stages.development} />
      </div>
      {!run ? (
        <EmptyState
          variant="section"
          icon={PlayCircle}
          heading="No run scheduled"
          subtext="This case has no execution run yet. Approved execution starts from Spec Review."
          action={{
            label: 'Open Spec Review',
            onClick: () =>
              navigate(withReturnContext(entityRoute(summary.spec), location, { lens: 'development' })),
          }}
        />
      ) : control.status === 'loading' ? (
        <div aria-busy="true" aria-label="Loading run control projection">
          <SkeletonLine className="w-48" />
          <SkeletonBlock className="mt-3 h-32 w-full" />
          <SkeletonBlock className="mt-2 h-16 w-full" />
        </div>
      ) : control.status === 'error' ? (
        control.error instanceof MissionContractError ? (
          <ContractViolation
            title="Run control projection failed contract validation"
            error={control.error}
            onRetry={() => setReloadKey((key) => key + 1)}
          />
        ) : (
          <ErrorBanner
            variant="inline"
            message={
              control.error instanceof Error
                ? control.error.message
                : 'Run control projection is unavailable.'
            }
            onRetry={() => setReloadKey((key) => key + 1)}
          />
        )
      ) : (
        <>
          <SemanticRunCanvas projection={control.value} />
          <div>
            <Link
              to={withReturnContext(entityRoute(run), location, { lens: 'development' })}
              className={QUIET_LINK}
            >
              Open run in Run View (raw terminal)
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function TestingLens({ summary, specId }: { summary: DeliveryCaseSummaryV1; specId: string }) {
  const location = useLocation();
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <StageCard stage={summary.stages.testing} />
      <p className="text-sm text-muted">
        Lifecycle: {summary.lifecycle.state} · current stage {summary.lifecycle.currentStage}
      </p>
      <p className="text-xs text-muted">
        Gates, evidence, and decisions are evaluated in Lifecycle Control; this lens links rather
        than re-evaluates.
      </p>
      <div>
        <Link
          to={withReturnContext(`/lifecycle?spec=${encodeURIComponent(specId)}`, location, {
            lens: 'testing',
          })}
          className={QUIET_LINK}
        >
          Open Lifecycle Control for this spec
        </Link>
      </div>
    </div>
  );
}

const RELEASE_TONES: Record<DeliveryCaseSummaryV1['release']['state'], string> = {
  released: 'success',
  failed: 'failed',
  ready: 'progress',
  preparing: 'progress',
  rolled_back: 'warning',
  not_started: 'unknown',
  unknown: 'unknown',
};

function DeploymentLens({ summary, specId }: { summary: DeliveryCaseSummaryV1; specId: string }) {
  const location = useLocation();
  const { release } = summary;
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <section aria-label="Release projection" className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="pk-chip" data-tone={RELEASE_TONES[release.state]}>
            <Rocket size={12} aria-hidden="true" />
            <span>Release: {release.state}</span>
          </span>
          {release.revision && (
            <LifecycleHashChip
              value={release.revision.value}
              label={`release ${release.revision.kind}`}
            />
          )}
        </div>
        {release.releasedAt && (
          <p className="text-xs text-muted">released {formatAbsoluteTime(release.releasedAt)}</p>
        )}
      </section>
      <StageCard stage={summary.stages.deployment} />
      <p className="text-xs text-muted">
        Delivery bundles, commits, provider checks, and review evidence are not part of this
        projection.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          to={withReturnContext(`/lifecycle?spec=${encodeURIComponent(specId)}`, location, {
            lens: 'deployment',
          })}
          className={QUIET_LINK}
        >
          Open Lifecycle merge evidence
        </Link>
        {summary.run.run && (
          <Link
            to={withReturnContext(entityRoute(summary.run.run), location, { lens: 'deployment' })}
            className={QUIET_LINK}
          >
            Open Run View delivery
          </Link>
        )}
      </div>
    </div>
  );
}

function MaintenanceLens({ summary }: { summary: DeliveryCaseSummaryV1 }) {
  const location = useLocation();
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <StageCard stage={summary.stages.maintenance} />
      <p className="text-xs text-muted">
        Knowledge candidate review state is not included in this projection — captured is not
        approved. Reviewed knowledge lives in Knowledge.
      </p>
      <div>
        <Link to={withReturnContext('/direction', location, { lens: 'maintenance' })} className={QUIET_LINK}>
          Open Knowledge
        </Link>
      </div>
    </div>
  );
}

/* ─── Panel ──────────────────────────────────────────────────────────────── */

export default function MissionWorkspacePanel() {
  const { specId, lens } = useParams<{ specId: string; lens?: string }>();
  const { workspaceId, selectedWorkspace } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const [reloadKey, setReloadKey] = useState(0);
  const [summaryState, setSummaryState] = useState<AsyncState<DeliveryCaseSummaryV1>>({
    status: 'loading',
  });

  const invalidLens = lens !== undefined && !isMissionLens(lens);
  const activeLens: MissionLens | 'overview' = isMissionLens(lens) ? lens : 'overview';

  useEffect(() => {
    if (!workspaceId || !specId || invalidLens) return;
    const controller = new AbortController();
    setSummaryState({ status: 'loading' });
    getDeliveryCaseSummary(workspaceId, specId, { signal: controller.signal })
      .then((summary) => {
        if (!controller.signal.aborted) setSummaryState({ status: 'ready', value: summary });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSummaryState({ status: 'error', error });
      });
    return () => controller.abort();
  }, [workspaceId, specId, invalidLens, reloadKey]);

  if (!specId) {
    return <Navigate to="/missions" replace />;
  }
  if (invalidLens) {
    return <Navigate to={missionCasePath(specId)} replace />;
  }
  if (!workspaceId) {
    return (
      <EmptyState
        icon={FolderOpen}
        heading="Select a workspace"
        subtext="Choose a workspace to view its mission projections."
      />
    );
  }
  if (summaryState.status === 'loading') {
    return <PanelSkeleton />;
  }
  if (summaryState.status === 'error') {
    const { error } = summaryState;
    if (error instanceof MissionContractError) {
      return (
        <ContractViolation
          title="Delivery case failed contract validation"
          error={error}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      );
    }
    if (error instanceof ApiError && error.status === 404) {
      return (
        <EmptyState
          icon={FileSearch}
          heading="No delivery case projection for this spec"
          subtext={`The backend could not project a delivery case for ${specId} in this workspace. The spec itself may still exist in the expert lenses.`}
          action={{
            label: 'Open Spec Review',
            onClick: () =>
              navigate(
                withReturnContext(
                  entityRoute({
                    schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
                    workspaceId,
                    kind: 'spec',
                    id: specId,
                    label: specId,
                  }),
                  location,
                  { lens: 'mission' },
                ),
              ),
          }}
        />
      );
    }
    const errorMessage = error instanceof ApiError
      ? error.status === 401
        ? `Authorization failed while loading this mission projection. ${error.message}`
        : `The delivery case projection request failed${error.status > 0 ? ` (HTTP ${error.status})` : ''}. ${error.message}`
      : `Could not reach the delivery case projection. ${
          error instanceof Error ? error.message : 'The network request failed.'
        }`;
    return (
      <section
        aria-labelledby="mission-load-error-heading"
        className="flex h-full flex-col gap-4 overflow-y-auto p-5"
      >
        <div>
          <Link
            to={consumeReturnContext(location.search, '/missions', workspaceId)}
            className={QUIET_LINK}
          >
            Back
          </Link>
          <h1 id="mission-load-error-heading" className="mt-4 text-lg font-semibold text-[var(--text)]">
            Mission projection unavailable
          </h1>
          <p className="mt-1 break-words text-sm text-muted">
            Mission {specId} · Workspace {selectedWorkspace?.name ?? workspaceId}
          </p>
        </div>
        <ErrorBanner
          variant="inline"
          message={errorMessage}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      </section>
    );
  }

  const summary = summaryState.value;

  let body: ReactNode;
  switch (activeLens) {
    case 'overview':
      body = <OverviewLens summary={summary} specId={specId} />;
      break;
    case 'planning':
      body = <PlanningLens summary={summary} />;
      break;
    case 'requirements':
      body = <RequirementsLens summary={summary} />;
      break;
    case 'design':
      body = <DesignLens summary={summary} specId={specId} />;
      break;
    case 'development':
      body = <DevelopmentLens summary={summary} specId={specId} workspaceId={workspaceId} />;
      break;
    case 'testing':
      body = <TestingLens summary={summary} specId={specId} />;
      break;
    case 'deployment':
      body = <DeploymentLens summary={summary} specId={specId} />;
      break;
    case 'maintenance':
      body = <MaintenanceLens summary={summary} />;
      break;
  }

  return (
    <div className="flex h-full flex-col bg-bg">
      <MissionHeader summary={summary} workspaceLabel={selectedWorkspace?.name ?? undefined} />
      <StageRail summary={summary} specId={specId} activeLens={activeLens} />
      <section
        aria-label={`${activeLens === 'overview' ? 'Overview' : MISSION_LENS_LABELS[activeLens]} lens`}
        className="flex-1 overflow-y-auto p-5"
      >
        {body}
      </section>
    </div>
  );
}
