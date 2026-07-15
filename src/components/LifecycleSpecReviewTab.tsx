/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, GitCommitHorizontal, Loader2 } from 'lucide-react';
import { getLifecycleSpec } from '../api/lifecycle';
import type { LifecycleSpecResponse } from '../types/lifecycle';
import LifecycleTraceability from './LifecycleTraceability';

function readable(value: string): string {
  return value.replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export default function LifecycleSpecReviewTab({ workspaceId, specId }: { workspaceId: string; specId: string }) {
  const [data, setData] = useState<LifecycleSpecResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    getLifecycleSpec(workspaceId, specId, undefined, { signal: controller.signal, silent: true })
      .then(setData)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Lifecycle review could not load');
      });
    return () => controller.abort();
  }, [specId, workspaceId]);

  if (error) {
    return <div className="m-5 border-l-2 border-error pl-3 text-sm text-error" role="alert">{error}</div>;
  }
  if (!data) {
    return <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted" role="status"><Loader2 size={15} className="animate-spin" /> Loading Lifecycle Control…</div>;
  }

  const revisionChanged = data.state !== 'current' || data.stale === true;
  return (
    <div className="space-y-5 p-5 sm:p-6" data-testid="lifecycle-spec-review">
      <section aria-labelledby="lifecycle-provenance-heading" className="rounded-lg border border-border bg-panel p-4">
        <h2 id="lifecycle-provenance-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Plan provenance</h2>
        {data.plan ? (
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-muted">Plan / compiler</dt><dd className="break-all text-[var(--text)]">{data.plan.id} · {data.plan.compilerVersion}</dd></div>
            <div><dt className="text-xs text-muted">Policy</dt><dd className="text-[var(--text)]">{data.plan.policyVersion}</dd></div>
            <div><dt className="text-xs text-muted">Input hash</dt><dd className="break-all font-mono text-xs text-[var(--text)]">{data.plan.inputHash}</dd></div>
            <div><dt className="text-xs text-muted">Compiled</dt><dd className="text-[var(--text)]"><time dateTime={data.plan.compiledAt}>{new Date(data.plan.compiledAt).toLocaleString()}</time></dd></div>
          </dl>
        ) : <p className="mt-2 text-sm text-warning">No current compiled plan is available.</p>}
      </section>

      <section aria-labelledby="lifecycle-readiness-heading" className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-panel p-4">
          <h2 id="lifecycle-readiness-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Readiness</h2>
          <p className="mt-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]">
            {data.overallReadiness.ready ? <CheckCircle2 size={16} className="text-success" /> : <AlertTriangle size={16} className="text-warning" />}
            {data.overallReadiness.ready ? 'Ready under current policy' : 'Not ready under current policy'}
          </p>
          <p className="mt-1 text-xs text-muted">{Math.round(data.overallReadiness.completionRate * 100)}% required phase coverage · {readable(data.overallReadiness.status ?? 'unknown')}</p>
        </div>
        <div className="rounded-lg border border-border bg-panel p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Version impact</h2>
          <p className="mt-2 flex items-center gap-2 text-sm font-medium text-[var(--text)]"><GitCommitHorizontal size={16} /> {revisionChanged ? 'Downstream evidence requires revalidation' : 'Evidence is bound to the current revision'}</p>
          <p className="mt-1 break-all text-xs text-muted">Snapshot {data.snapshotId} · Plan v{data.plan?.version ?? 'unknown'} · Spec {data.plan?.specVersion ?? 'unknown'}</p>
        </div>
      </section>

      <section aria-labelledby="lifecycle-timeline-heading">
        <h2 id="lifecycle-timeline-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Phase timeline</h2>
        <ol className="divide-y divide-border border-y border-border">
          {data.phaseTimeline.map((phase) => (
            <li key={phase.phaseId} className="flex items-start gap-3 py-3 text-sm">
              <Clock3 size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              <span className="min-w-0 flex-1"><strong className="font-medium text-[var(--text)]">{phase.displayName}</strong><span className="ml-2 text-xs text-muted">{readable(phase.status)}</span>{phase.rationale && <span className="mt-1 block text-xs text-muted">{phase.rationale}</span>}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="lifecycle-traceability-heading">
        <h2 id="lifecycle-traceability-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Traceability</h2>
        <LifecycleTraceability traceability={data.traceability} snapshotId={data.snapshotId} onOpenEvidence={() => undefined} />
      </section>
    </div>
  );
}
