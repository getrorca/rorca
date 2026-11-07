/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, FileArchive, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  getDeliveryAdapters,
  listLocalReviewBundles,
  type DeliveryAdapterCatalog,
  type LocalReviewBundleReadModel,
} from '../api/delivery';

interface LocalReviewBundlesTabProps {
  workspaceId: string;
  runId: number;
}

function short(value: string): string {
  return value.length > 22 ? `${value.slice(0, 18)}…` : value;
}

export default function LocalReviewBundlesTab({ workspaceId, runId }: LocalReviewBundlesTabProps) {
  const [catalog, setCatalog] = useState<DeliveryAdapterCatalog | null>(null);
  const [bundles, setBundles] = useState<LocalReviewBundleReadModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [nextCatalog, result] = await Promise.all([
        getDeliveryAdapters(signal),
        listLocalReviewBundles({ workspaceId, runId, limit: 100, signal }),
      ]);
      setCatalog(nextCatalog);
      setBundles(result.items);
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : 'Local review bundles could not be loaded');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [runId, workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const localAdapter = catalog?.adapters.find((adapter) => adapter.adapterId === catalog.defaultAdapterId);
  const legacyGithubSurfaces = catalog?.adapters.find((adapter) =>
    adapter.adapterId === 'github-app' && adapter.implementationStatus === 'legacy_optional_surfaces');

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted" role="status">
        <Loader2 size={16} className="animate-spin" />
        Loading local review bundles…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg)] p-4 md:p-6" data-testid="local-review-bundles-tab">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <section className="rounded-xl border border-border bg-panel p-4" aria-label="Default delivery adapter">
          <div className="flex flex-wrap items-start gap-3">
            <div className="rounded-lg border border-border bg-surface-200 p-2 text-accent">
              <ShieldCheck size={20} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-[var(--text)]">{localAdapter?.label ?? 'Local review bundle'}</h2>
                <span className="rounded bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">Default</span>
                <span className="rounded bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">No network</span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Content-addressed review artifacts stay local. No GitHub account, PAT, webhook, remote provider, merge, or deployment authority is required.
              </p>
              {legacyGithubSurfaces?.optional && (
                <p className="mt-1 text-xs text-muted">Legacy GitHub delivery routes remain optional and are not a provider-neutral adapter or contacted by this view.</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-surface-200 hover:text-[var(--text)]"
            >
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </section>

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning" role="alert">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <section className="rounded-xl border border-border bg-panel px-4 py-3" aria-label="Local review bundle authority">
          <h3 className="text-xs font-semibold text-[var(--text)]">Read-only review surface</h3>
          <p className="mt-1 text-xs text-muted">Finalization is a separate administrator boundary that requires an exact host attempt and generation. This Workbench view cannot mint pass authority or create a bundle.</p>
        </section>

        <section className="space-y-3" aria-label="Finalized local review bundles">
          <h3 className="text-xs font-semibold text-[var(--text)]">Finalized bundles ({bundles.length})</h3>
          {bundles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-panel p-8 text-center">
              <FileArchive size={28} className="mx-auto text-muted" />
              <p className="mt-2 text-sm font-medium text-[var(--text)]">No local bundle finalized yet</p>
              <p className="mt-1 text-xs text-muted">Finalization is bounded, atomic, immutable, and separate from merge or deploy.</p>
            </div>
          ) : bundles.map((bundle) => (
            <article key={bundle.bundleId} className="rounded-xl border border-border bg-panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <FileArchive size={16} className="text-accent" />
                <span className="font-mono text-xs font-medium text-[var(--text)]" title={bundle.bundleId}>{short(bundle.bundleId)}</span>
                <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${bundle.projectionIntegrity === 'verified' ? 'bg-success/10 text-success' : 'bg-error/10 text-error'}`}>
                  {bundle.projectionIntegrity}
                </span>
                <span className={`rounded px-2 py-0.5 text-[10px] font-semibold ${bundle.validation.status === 'passed' ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'}`}>
                  host validation {bundle.validation.status}
                </span>
                <time className="ml-auto text-[10px] text-muted">{new Date(bundle.createdAt).toLocaleString()}</time>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div><dt className="text-muted">Story / attempt</dt><dd className="font-mono text-[var(--text)]">{bundle.identity.storyId} / {bundle.identity.attempt}</dd></div>
                <div><dt className="text-muted">Branch</dt><dd className="truncate font-mono text-[var(--text)]">{bundle.repository.branch}</dd></div>
                <div><dt className="text-muted">Base → head</dt><dd className="font-mono text-[var(--text)]">{bundle.repository.baseSha.slice(0, 8)} → {bundle.repository.headSha.slice(0, 8)}</dd></div>
                <div><dt className="text-muted">Files / patch</dt><dd className="text-[var(--text)]">{bundle.changedFileCount} / {bundle.artifacts[0]?.bytes ?? 0} bytes</dd></div>
              </dl>
              <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-muted">
                <span className="rounded border border-border px-2 py-1">merge: not authorized</span>
                <span className="rounded border border-border px-2 py-1">deploy: not authorized</span>
                <span className="rounded border border-border px-2 py-1">receipts: {bundle.validation.receiptCount}</span>
                <span className="rounded border border-border px-2 py-1" title={bundle.projectionKey}>local projection: {short(bundle.projectionKey)}</span>
              </div>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
