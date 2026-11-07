/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Ban, CircleCheck, CircleHelp, GitCompareArrows, Link as LinkIcon, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import type { DeliveryCaseSummaryV1 } from '../../../shared/contracts/mission';
import LifecycleHashChip from '../LifecycleHashChip';

interface IntentSourceProvenanceProps {
  bundle: DeliveryCaseSummaryV1['sourceBundle'];
  drift: DeliveryCaseSummaryV1['sourceContext'];
  reviewHref: string;
}

const sourceKey = (sourceId: string, section: string) => `${sourceId}\u0000${section}`;

function DriftState({
  drift,
  reviewHref,
}: Pick<IntentSourceProvenanceProps, 'drift' | 'reviewHref'>) {
  const state = drift?.contextState ?? 'unavailable';
  const presentation = state === 'fresh'
    ? { label: 'No drift detected', detail: 'The last recorded check found no source changes.', tone: 'success', Icon: CircleCheck }
    : state === 'stale'
      ? { label: 'Source context is stale', detail: 'Execution still uses the frozen revision. Recompile and re-review before changed content can affect execution.', tone: 'failed', Icon: TriangleAlert }
      : state === 'unknown'
        ? { label: 'Drift state unknown', detail: 'The projection cannot determine whether the frozen sources have changed.', tone: 'unknown', Icon: CircleHelp }
        : { label: 'Drift check unavailable', detail: 'No drift result is present in this projection. No freshness claim is made.', tone: 'unknown', Icon: CircleHelp };
  const { Icon } = presentation;

  return (
    <section aria-labelledby="intent-drift-heading" className="rounded-lg border border-border bg-panel p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 id="intent-drift-heading" className="text-sm font-semibold text-[var(--text)]">Source drift</h3>
        <span className="pk-chip" data-tone={presentation.tone}>
          <Icon size={13} aria-hidden="true" />
          <span>{presentation.label}</span>
        </span>
      </div>
      <p className="mt-2 break-words text-sm text-muted">{presentation.detail}</p>
      {drift && (
        <div className="mt-3 flex min-w-0 flex-col gap-2">
          {drift.sources.map((source) => (
            <div key={source.sourceId} className="min-w-0 rounded-md border border-border p-3 text-xs">
              <p className="break-words font-medium text-[var(--text)]">
                {source.locator} · {source.state}
              </p>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-muted">Frozen</span>
                <LifecycleHashChip value={source.oldHash} label={`${source.locator} frozen source hash`} />
                <span className="text-muted">Current</span>
                {source.newHash
                  ? <LifecycleHashChip value={source.newHash} label={`${source.locator} current source hash`} />
                  : <span className="font-medium text-muted">
                    {source.state === 'deleted' ? 'Deleted' : source.state === 'unknown' ? 'Unknown' : 'Unavailable'}
                  </span>}
              </div>
              <p className="mt-2 break-words text-muted">{source.detail}</p>
            </div>
          ))}
        </div>
      )}
      {state !== 'fresh' && (
        <Link
          to={reviewHref}
          className="mt-4 inline-flex max-w-full items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
        >
          Open Spec Review
        </Link>
      )}
    </section>
  );
}

export default function IntentSourceProvenance({ bundle, drift, reviewHref }: IntentSourceProvenanceProps) {
  if (!bundle) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <section aria-labelledby="source-bundle-unavailable-heading" className="rounded-lg border border-border bg-panel p-4">
          <div className="flex items-center gap-2 text-[var(--text)]">
            <CircleHelp size={16} aria-hidden="true" />
            <h3 id="source-bundle-unavailable-heading" className="text-sm font-semibold">Frozen source bundle unavailable</h3>
          </div>
          <p className="mt-2 break-words text-sm text-muted">
            This delivery-case projection does not contain a frozen source bundle. Source count, titles, revisions, hashes, exclusions, conflicts, and citations are unavailable.
          </p>
        </section>
        <DriftState drift={drift} reviewHref={reviewHref} />
      </div>
    );
  }

  const sectionTargets = new Map<string, string>();
  bundle.includedSources.forEach((source, sourceIndex) => {
    source.selectedSections.forEach((section, sectionIndex) => {
      sectionTargets.set(sourceKey(source.sourceId, section), `intent-source-${sourceIndex}-section-${sectionIndex}`);
    });
  });
  const includedById = new Map(bundle.includedSources.map((source) => [source.sourceId, source]));

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section aria-labelledby="source-bundle-heading" className="min-w-0 rounded-lg border border-border bg-panel p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <CircleCheck size={16} className="text-accent" aria-hidden="true" />
          <h3 id="source-bundle-heading" className="text-sm font-semibold text-[var(--text)]">
            Built from {bundle.includedSources.length} {bundle.includedSources.length === 1 ? 'source' : 'sources'}
          </h3>
          <LifecycleHashChip value={bundle.bundleHash} label="frozen source bundle hash" />
        </div>
        <p className="mt-2 min-w-0 break-words text-xs text-muted">
          Frozen bundle <span className="break-all">{bundle.bundleId}</span> · compiled{' '}
          {new Date(bundle.compiledAt).toLocaleString()}
        </p>

        <ol className="mt-4 flex min-w-0 flex-col gap-3" aria-label="Included sources">
          {bundle.includedSources.map((source, sourceIndex) => (
            <li key={source.sourceId} className="min-w-0 rounded-md border border-border p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="break-words text-sm font-medium text-[var(--text)]">{source.title}</span>
                <span className="pk-chip" data-tone="success"><CircleCheck size={12} aria-hidden="true" /> Included</span>
              </div>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
                <span className="break-all">Revision {source.sourceVersion}</span>
                <LifecycleHashChip value={source.contentHash} label={`${source.title} content hash`} />
              </div>
              <div className="mt-3">
                <p className="text-xs font-medium text-muted">Included sections</p>
                {source.selectedSections.length ? (
                  <ul className="mt-1 flex min-w-0 flex-wrap gap-2">
                    {source.selectedSections.map((section, sectionIndex) => (
                      <li
                        id={`intent-source-${sourceIndex}-section-${sectionIndex}`}
                        key={section}
                        tabIndex={-1}
                        className="max-w-full break-words rounded-md border border-border px-2 py-1 text-xs text-[var(--text)] target:outline target:outline-2 target:outline-accent"
                      >
                        {section}
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-1 text-xs font-medium text-muted">Unavailable</p>}
                <p className="mt-2 break-words text-xs text-muted">
                  Excluded sections: Unavailable in this projection
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="source-citations-heading" className="min-w-0 rounded-lg border border-border bg-panel p-4">
        <div className="flex items-center gap-2">
          <LinkIcon size={15} aria-hidden="true" />
          <h3 id="source-citations-heading" className="text-sm font-semibold text-[var(--text)]">Requirement citations</h3>
        </div>
        {bundle.citations.length ? (
          <ul className="mt-3 flex min-w-0 flex-col gap-2">
            {bundle.citations.map((citation) => {
              const source = includedById.get(citation.sourceId);
              const target = sectionTargets.get(sourceKey(citation.sourceId, citation.section));
              return (
                <li key={citation.citationId} className="min-w-0 rounded-md border border-border p-3 text-sm">
                  <p className="break-words text-[var(--text)]">Requirement trace: {citation.rationale}</p>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs">
                    {target && source ? (
                      <a
                        className="break-words rounded-sm font-medium text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        href={`#${target}`}
                      >
                        {source.title} — {citation.section}
                      </a>
                    ) : <span className="font-medium text-muted">Source passage unavailable</span>}
                    <LifecycleHashChip value={citation.excerptHash} label={`${citation.citationId} cited passage hash`} />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <p className="mt-2 text-sm font-medium text-muted">Citations unavailable</p>}
      </section>

      <section aria-labelledby="excluded-sources-heading" className="min-w-0 rounded-lg border border-border bg-panel p-4">
        <div className="flex items-center gap-2">
          <Ban size={15} aria-hidden="true" />
          <h3 id="excluded-sources-heading" className="text-sm font-semibold text-[var(--text)]">Excluded sources</h3>
        </div>
        {bundle.excludedSources.length ? (
          <ul className="mt-3 flex min-w-0 flex-col gap-2">
            {bundle.excludedSources.map(({ source, reason }) => (
              <li key={source.sourceId} className="min-w-0 rounded-md border border-border p-3 text-sm">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="break-words font-medium text-[var(--text)]">{source.title}</span>
                  <span className="pk-chip" data-tone="warning"><Ban size={12} aria-hidden="true" /> Excluded</span>
                </div>
                <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="break-all">Revision {source.sourceVersion}</span>
                  <LifecycleHashChip value={source.contentHash} label={`${source.title} excluded source hash`} />
                </div>
                <p className="mt-2 break-words text-muted">
                  Excluded sections:{' '}
                  {source.selectedSections.length
                    ? source.selectedSections.join(', ')
                    : 'Unavailable in this projection'}
                </p>
                <p className="mt-2 break-words text-muted">Rationale: {reason}</p>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-muted">No excluded sources recorded.</p>}
      </section>

      <section aria-labelledby="source-conflicts-heading" className="min-w-0 rounded-lg border border-border bg-panel p-4">
        <div className="flex items-center gap-2">
          <GitCompareArrows size={15} aria-hidden="true" />
          <h3 id="source-conflicts-heading" className="text-sm font-semibold text-[var(--text)]">Conflict resolutions</h3>
        </div>
        {bundle.conflicts.length ? (
          <ul className="mt-3 flex min-w-0 flex-col gap-2">
            {bundle.conflicts.map((conflict) => (
              <li key={conflict.conflictId} className="min-w-0 rounded-md border border-border p-3 text-sm">
                <p className="break-words font-medium text-[var(--text)]">{conflict.summary}</p>
                <p className="mt-1 break-words text-muted">Sources: {conflict.sourceIds.map((id) => includedById.get(id)?.title ?? id).join(', ')}</p>
                <p className="mt-2 break-words text-[var(--text)]">
                  {conflict.resolution ? `Resolution: ${conflict.resolution}` : 'Resolution unavailable'}
                </p>
              </li>
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-muted">No source conflicts recorded.</p>}
      </section>

      <DriftState drift={drift} reviewHref={reviewHref} />
    </div>
  );
}
