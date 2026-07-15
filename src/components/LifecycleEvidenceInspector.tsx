/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, ExternalLink, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { LifecycleEvidenceDetail, LifecycleQueryState } from '../types/lifecycle';

const MAX_RENDERED_PAYLOAD_CHARS = 12_000;

interface LifecycleEvidenceInspectorProps {
  evidence: LifecycleQueryState<LifecycleEvidenceDetail>;
  pinnedSnapshotId: string | null;
  onRefresh: () => void;
  onClose: () => void;
}

function readable(value: string): string {
  const normalized = value.replace(/_/g, ' ');
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function time(value: string | null): React.ReactNode {
  if (!value) return 'Not supplied';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? <time dateTime={value}>{date.toLocaleString()}</time> : 'Invalid timestamp';
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-all text-xs text-[var(--text)]">{children ?? 'Not supplied'}</dd>
    </div>
  );
}

export default function LifecycleEvidenceInspector({ evidence, pinnedSnapshotId, onRefresh, onClose }: LifecycleEvidenceInspectorProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const data = evidence.data;
  useEffect(() => {
    if (data) headingRef.current?.focus();
  }, [data]);
  const payload = useMemo(() => {
    if (!data) return '';
    const serialized = JSON.stringify({ details: data.details, provenanceChain: data.provenanceChain }, null, 2);
    return serialized.length > MAX_RENDERED_PAYLOAD_CHARS
      ? `${serialized.slice(0, MAX_RENDERED_PAYLOAD_CHARS)}\n… payload display bounded at ${MAX_RENDERED_PAYLOAD_CHARS.toLocaleString()} characters`
      : serialized;
  }, [data]);

  const copyReference = async () => {
    const reference = data?.rawReference.reference;
    if (!reference) return;
    try {
      await navigator.clipboard.writeText(reference);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  return (
    <section className="mt-3 rounded-md border border-accent/40 bg-panel" aria-labelledby="evidence-inspector-heading" data-testid="lifecycle-evidence-inspector">
      <header className="flex items-start gap-2 border-b border-border p-3">
        <div className="min-w-0 flex-1">
          <h4 id="evidence-inspector-heading" ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-[var(--text)] focus:outline-none">Evidence Inspector</h4>
          <p className="mt-0.5 break-all text-[10px] text-muted">Pinned snapshot: {pinnedSnapshotId ?? 'Unavailable'}</p>
        </div>
        <button type="button" onClick={onClose} className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-muted hover:bg-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Close Evidence Inspector"><X size={16} aria-hidden="true" /></button>
      </header>

      {(evidence.stale || evidence.error) && (
        <div className="border-b border-warning/40 bg-warning/10 p-3 text-xs" role="status">
          <p className="font-medium text-[var(--text)]">Newer evidence may be available. This audited item has not changed.</p>
          {evidence.error && <p className="mt-1 text-muted">{evidence.error.message}</p>}
          <button type="button" onClick={onRefresh} className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-md border border-warning/50 px-2.5 py-1.5 font-medium text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><RefreshCw size={13} aria-hidden="true" /> Refresh against latest snapshot</button>
        </div>
      )}

      {evidence.loading && !data && <p className="p-3 text-xs text-muted" role="status">Loading pinned evidence…</p>}
      {!evidence.loading && !data && !evidence.error && <p className="p-3 text-xs text-muted">No evidence item is available for this snapshot.</p>}

      {data && (
        <div className="space-y-4 p-3">
          <div className={`rounded-md border p-2 text-xs ${!data.eligibleForActiveGate ? 'border-warning/50 bg-warning/10' : 'border-border bg-bg'}`}>
            <div className="flex items-center gap-2 font-medium text-[var(--text)]"><ShieldCheck size={14} aria-hidden="true" /> {data.revisionMismatch ? 'Historical evidence — excluded from the active gate' : data.eligibleForActiveGate ? 'Eligible for the bound revision' : 'Ineligible evidence — excluded from the active gate'}</div>
            {!data.eligibleForActiveGate && <p className="mt-1 text-muted">This record remains audit-visible but cannot satisfy the current gate{data.invalidReasons.length ? `: ${data.invalidReasons.map(readable).join(', ')}` : '.'}</p>}
          </div>

          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Source / type">{data.source.system} / {readable(data.source.type)}</Field>
            <Field label="Source ID">{data.source.eventId}</Field>
            <Field label="Status / classification">{readable(data.status)} / {readable(data.classification)}</Field>
            <Field label="Trust / confidence">{readable(data.trustLevel)} / {Math.round(data.confidence * 100)}%</Field>
            <Field label="Observed">{time(data.observedAt)}</Field>
            <Field label="Expires">{time(data.expiresAt)}</Field>
            <Field label="Actor">{data.actor ?? 'Not applicable'}</Field>
            <Field label="Redaction state">{readable(data.redactionState)} · raw payload not included</Field>
            <Field label="Commit">{data.releaseIdentity.commitSha ?? (data.subject.type === 'commit_sha' ? data.subject.value : 'Absent')}</Field>
            <Field label="Image / artifact">{data.releaseIdentity.artifactDigest ?? (data.subject.type === 'artifact_digest' ? data.subject.value : 'Absent')}</Field>
            <Field label="Deployment">{data.releaseIdentity.deploymentId ?? (data.subject.type === 'deployment_id' ? data.subject.value : 'Absent')}</Field>
            <Field label="Environment">{data.environment ?? 'Not supplied'}</Field>
          </dl>

          {data.excerpt && <div><div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Redacted excerpt</div><p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg p-2 text-xs text-[var(--text)]">{data.excerpt}</p></div>}

          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted">Raw reference</div>
            <p className="mt-1 break-all text-xs text-[var(--text)]">{data.rawReference.reference ?? 'No reference supplied'}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {data.rawReference.reference && <button type="button" onClick={() => { void copyReference(); }} className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><Copy size={13} aria-hidden="true" /> {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy reference'}</button>}
              {data.rawReference.allowed && data.rawReference.href && <a href={data.rawReference.href} target={data.rawReference.external ? '_blank' : undefined} rel={data.rawReference.external ? 'noreferrer' : undefined} className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><ExternalLink size={13} aria-hidden="true" /> {data.rawReference.label}</a>}
            </div>
            {data.rawReference.reference && !data.rawReference.allowed && <p className="mt-1 text-[11px] text-warning">This reference is not an authorized run/log/PTY/GitHub/GitReins destination and cannot be opened.</p>}
          </div>

          <details className="text-xs">
            <summary className="cursor-pointer font-medium text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Bounded normalized payload and provenance</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg p-2 text-[11px] text-muted">{payload}</pre>
          </details>
          <p className="break-all text-[10px] text-muted">Payload hash: {data.payloadHash}</p>
        </div>
      )}
    </section>
  );
}
