/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { AlertTriangle, CheckCircle2, GitCommitHorizontal, Loader2 } from 'lucide-react';
import { getLifecycleSpec } from '../api/lifecycle';
import type { LifecycleSpecResponse } from '../types/lifecycle';
import { projectFeatureAssuranceMap } from '../lib/feature-assurance-map';
import FeatureAssuranceMap from './FeatureAssuranceMap';
import LifecycleTraceability from './LifecycleTraceability';
import LifecycleHashChip, { ProseWithHashes } from './LifecycleHashChip';
import { entityRoute } from '../lib/entityRoutes';
import { aggregateStageCells } from '../lib/lifecycle-stages';
import { LifecycleStatusIcon } from '../panels/LifecycleCell';
import { LifecycleAssuranceBadge, LifecycleDeliveryBadge } from './LifecycleBadges';
import { withReturnContext } from '../lib/returnContext';
import { MISSION_CONTRACT_VERSIONS } from '../../shared/contracts/mission';
import PreStagingQualification from './PreStagingQualification';

function readable(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export default function LifecycleSpecReviewTab({ workspaceId, specId }: { workspaceId: string; specId: string }) {
  const [data, setData] = useState<LifecycleSpecResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshingAfterEvidence, setRefreshingAfterEvidence] = useState(false);
  const requestGenerationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setData(null);
    setError(null);
    setRefreshingAfterEvidence(false);
    getLifecycleSpec(workspaceId, specId, undefined, { signal: controller.signal, silent: true })
      .then((nextData) => {
        if (generation === requestGenerationRef.current) setData(nextData);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && generation === requestGenerationRef.current) {
          setError(cause instanceof Error ? cause.message : 'Lifecycle review could not load');
        }
      });
    return () => {
      controller.abort();
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      requestGenerationRef.current += 1;
    };
  }, [specId, workspaceId]);

  if (error) {
    return <div className="m-5 border-l-2 border-error pl-3 text-sm text-error" role="alert">{error}</div>;
  }
  if (!data) {
    return <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted" role="status"><Loader2 size={15} className="animate-spin" /> Loading Lifecycle Control…</div>;
  }

  const revisionChanged = data.state !== 'current' || data.stale === true;
  const stageTimeline = aggregateStageCells({ phases: data.phaseTimeline });
  const openEvidence = (evidenceId: string) => {
    const gates = [
      ...data.traceability.gates.items,
      ...data.traceability.requirements.items.flatMap((requirement) => requirement.gates ?? []),
    ];
    const gate = gates.find((candidate) => (
      candidate.currentEvidence?.some((item) => item.id === evidenceId)
      || candidate.historicalEvidence?.some((item) => item.id === evidenceId)
    ));
    const evidencePath = entityRoute({
      schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
      workspaceId,
      kind: 'evidence',
      id: evidenceId,
      label: `Evidence ${evidenceId}`,
      revision: { kind: 'snapshot', value: data.snapshotId },
      parent: {
        workspaceId,
        kind: 'spec',
        id: specId,
        label: data.title,
      },
    });
    if (!gate) {
      navigate(withReturnContext(evidencePath, location, { focus: `evidence:${evidenceId}`, lens: 'spec-review' }));
      return;
    }
    const destination = new URL(evidencePath, 'https://rorca.invalid');
    destination.searchParams.set('phase', gate.phaseId);
    navigate(withReturnContext(`${destination.pathname}${destination.search}`, location, {
      focus: `evidence:${evidenceId}`,
      lens: 'spec-review',
    }));
  };
  const navigateAssuranceNode = (kind: string, id: string) => {
    const parent = {
      workspaceId,
      kind: 'spec' as const,
      id: specId,
      label: data.title,
    };
    let destination: string | null = null;
    if (kind === 'story') {
      destination = entityRoute({
        schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
        workspaceId,
        kind: 'story',
        id,
        label: `Story ${id}`,
        parent,
      });
    } else if (kind === 'decision') {
      destination = entityRoute({
        schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
        workspaceId,
        kind: 'decision',
        id,
        label: `Decision ${id}`,
        parent,
      });
    } else if (kind === 'control') {
      const gate = data.traceability.gates.items.find((candidate) => (
        candidate.gateId === id
        || candidate.gateId.replace(/^gate-/, '').toUpperCase() === id.toUpperCase()
      ));
      destination = entityRoute({
        schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
        workspaceId,
        kind: 'gate',
        id: gate?.gateId ?? id,
        label: gate?.title ?? `Control ${id}`,
        parent,
      });
    }
    if (destination) {
      navigate(withReturnContext(destination, location, { focus: `${kind}:${id}`, lens: 'spec-review' }));
      return;
    }
    const localDestination = new URL(`${location.pathname}${location.search}`, 'https://rorca.invalid');
    localDestination.searchParams.set('tab', 'lifecycle');
    localDestination.searchParams.set('assuranceFocus', `${kind}:${id}`);
    navigate(withReturnContext(`${localDestination.pathname}${localDestination.search}`, location, {
      focus: `${kind}:${id}`,
      lens: 'spec-review',
    }));
  };
  const assuranceMap = data.assuranceMapInput ? projectFeatureAssuranceMap(data.assuranceMapInput) : null;
  return (
    <div className="space-y-5 p-5 sm:p-6" data-testid="lifecycle-spec-review">
      {refreshingAfterEvidence && (
        <div className="rounded-md border border-border bg-panel p-3 text-sm text-muted" role="status">
          Qualification evidence was recorded. Refreshing lifecycle status for this spec…
        </div>
      )}
      <section aria-labelledby="lifecycle-provenance-heading" className="rounded-lg border border-border bg-panel p-4">
        <h2 id="lifecycle-provenance-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Plan provenance</h2>
        {data.plan ? (
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted">Plan / compiler</dt><dd className="break-all text-[var(--text)]">{data.plan.id} · {data.plan.compilerVersion}</dd></div>
            <div><dt className="text-xs text-muted">Policy</dt><dd className="text-[var(--text)]">{data.plan.policyVersion}</dd></div>
            <div><dt className="text-xs text-muted">Input hash</dt><dd className="mt-1 text-xs text-[var(--text)]"><LifecycleHashChip value={data.plan.inputHash} label="plan input hash" /></dd></div>
            <div><dt className="text-xs text-muted">Compiled</dt><dd className="text-[var(--text)]"><time dateTime={data.plan.compiledAt}>{new Date(data.plan.compiledAt).toLocaleString()}</time></dd></div>
          </dl>
        ) : <p className="mt-2 text-sm text-warning">No current compiled plan is available.</p>}
      </section>

      <section aria-labelledby="lifecycle-readiness-heading" className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Delivery outcome</h2>
          <p className="mt-2"><LifecycleDeliveryBadge delivery={data.delivery} /></p>
          <p className="mt-2 text-xs text-muted">{data.delivery.rationale}</p>
        </div>
        <div className="rounded-lg border border-border bg-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Assurance status</h2>
          <p className="mt-2"><LifecycleAssuranceBadge assurance={data.assurance} /></p>
          <p className="mt-2 text-xs text-muted">{data.assurance.rationale}</p>
        </div>
        <div className="rounded-lg border border-border bg-panel p-4">
          <h2 id="lifecycle-readiness-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Lifecycle evaluation</h2>
          <p className="mt-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]">
            {data.overallReadiness.ready === true ? <CheckCircle2 size={16} className="text-success" /> : <AlertTriangle size={16} className="text-warning" />}
            {data.overallReadiness.ready === null ? 'Not evaluated' : data.overallReadiness.ready ? 'Ready under current policy' : 'Not ready under current policy'}
          </p>
          <p className="mt-1 text-xs text-muted">{data.overallReadiness.completionRate === null ? '—' : `${Math.round(data.overallReadiness.completionRate * 100)}%`} required phase coverage · {readable(data.overallReadiness.status ?? 'unknown')}</p>
        </div>
        <div className="rounded-lg border border-border bg-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Version impact</h2>
          <p className="mt-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]"><GitCommitHorizontal size={16} /> {revisionChanged ? 'Downstream evidence requires revalidation' : 'Evidence is bound to the current revision'}</p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>Snapshot</span><LifecycleHashChip value={data.snapshotId} label="lifecycle snapshot" />
            <span>· Plan v{data.plan?.version ?? 'unknown'} · Spec {data.plan?.specVersion ?? 'unknown'}</span>
          </p>
        </div>
      </section>

      <section aria-labelledby="pre-staging-qualification-heading" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-panel p-4">
        <div>
          <h2 id="pre-staging-qualification-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Pre-staging qualification</h2>
          <p className="mt-1 text-xs text-muted">Discover and run every safe repository-declared software check against the exact current commit. Governed approvals remain separate.</p>
        </div>
        <PreStagingQualification
          workspaceId={workspaceId}
          specId={specId}
          onEvidenceWritten={() => {
            const generation = ++requestGenerationRef.current;
            requestControllerRef.current?.abort();
            const controller = new AbortController();
            requestControllerRef.current = controller;
            setError(null);
            setRefreshingAfterEvidence(true);
            void getLifecycleSpec(workspaceId, specId, undefined, { signal: controller.signal, silent: true })
              .then((nextData) => {
                if (generation !== requestGenerationRef.current) return;
                setData(nextData);
                setRefreshingAfterEvidence(false);
              })
              .catch((cause: unknown) => {
                if (controller.signal.aborted || generation !== requestGenerationRef.current) return;
                setData(null);
                setRefreshingAfterEvidence(false);
                const detail = cause instanceof Error ? cause.message : 'Lifecycle review refresh failed';
                setError(`Qualification evidence was recorded, but lifecycle status refresh failed: ${detail}`);
              });
          }}
        />
      </section>

      <section aria-labelledby="lifecycle-timeline-heading">
        <h2 id="lifecycle-timeline-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Stage timeline</h2>
        <ol className="divide-y divide-border border-y border-border" aria-label="Seven-stage lifecycle timeline">
          {stageTimeline.map((stage) => (
            <li
              key={stage.stageId}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 py-3 text-sm"
              data-lifecycle-stage={stage.stageId}
              data-status={stage.status}
            >
              <span className="mt-0.5 shrink-0 text-accent"><LifecycleStatusIcon status={stage.status} size={15} /></span>
              <span className="min-w-0">
                <strong className="font-medium text-[var(--text)]">{stage.displayName}</strong>
                {stage.cells.length > 1 && <span className="ml-2 text-xs text-muted">{stage.cells.length} controls</span>}
                {stage.rationale && <span className="mt-1 block text-xs text-muted"><ProseWithHashes text={stage.rationale} /></span>}
              </span>
              <span className="text-right">
                <span className="block text-xs font-medium text-[var(--text)]">{readable(stage.status)}</span>
                {stage.gateProgress && (
                  <span className="mt-1 block whitespace-nowrap text-xs tabular-nums text-muted">
                    {stage.gateProgress.passed === null || stage.gateProgress.required === null
                      ? 'Not evaluated'
                      : `${stage.gateProgress.passed}/${stage.gateProgress.required} gates passed`}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {assuranceMap && (
        <section aria-labelledby="feature-assurance-map-section-heading">
          <h2 id="feature-assurance-map-section-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Feature assurance</h2>
          <FeatureAssuranceMap projection={assuranceMap} onNavigate={navigateAssuranceNode} onOpenEvidence={openEvidence} />
        </section>
      )}

      <section aria-labelledby="lifecycle-traceability-heading">
        <h2 id="lifecycle-traceability-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Traceability</h2>
        <LifecycleTraceability traceability={data.traceability} snapshotId={data.snapshotId} onOpenEvidence={openEvidence} />
      </section>
    </div>
  );
}
