/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, FlaskConical, Loader2, ShieldCheck, X, XCircle } from 'lucide-react';
import {
  getPreStagingQualificationPreview,
  listPreStagingQualifications,
  runPreStagingQualification,
} from '../api/lifecycle';
import { ApiError } from '../lib/apiFetch';
import { useFocusTrap } from '../hooks/useFocusTrap';
import type { PreStagingQualificationPreview, PreStagingQualificationReceipt } from '../types/lifecycle';
import LifecycleHashChip from './LifecycleHashChip';

interface Props {
  workspaceId: string;
  specId: string;
  runId?: number | null;
  onEvidenceWritten?: () => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Qualification request failed';
}

function statusIcon(status: PreStagingQualificationReceipt['status']) {
  if (status === 'passed') return <CheckCircle2 size={16} className="text-success" aria-hidden="true" />;
  if (status === 'failed') return <XCircle size={16} className="text-error" aria-hidden="true" />;
  return <AlertTriangle size={16} className="text-warning" aria-hidden="true" />;
}

function ReceiptRevisionBinding({
  item,
  activePreview,
}: {
  item: PreStagingQualificationReceipt;
  activePreview: PreStagingQualificationPreview | null;
}) {
  const current = Boolean(
    activePreview
    && item.previewHash !== null
    && item.previewHash === activePreview.previewHash,
  );
  const relation = current ? 'Current preview revision' : 'Historical revision';
  return (
    <section className="rounded-md border border-border bg-bg p-3" aria-label={`${relation} binding`}>
      <p className={`mb-2 text-xs font-semibold ${current ? 'text-success' : 'text-warning'}`}>{relation}</p>
      <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <dt className="text-muted">Preview identity</dt>
          <dd className="mt-1">{item.previewHash
            ? <LifecycleHashChip value={item.previewHash} label="receipt preview hash" />
            : 'Unavailable for legacy receipt'}</dd>
        </div>
        <div>
          <dt className="text-muted">Run ID</dt>
          <dd className="mt-1">{item.runId ?? 'Spec-level qualification'}</dd>
        </div>
        <div>
          <dt className="text-muted">HEAD</dt>
          <dd className="mt-1"><LifecycleHashChip value={item.headSha} label="receipt HEAD" /></dd>
        </div>
        <div>
          <dt className="text-muted">Spec revision</dt>
          <dd className="mt-1"><LifecycleHashChip value={item.specRevisionHash} label="receipt spec revision hash" /></dd>
        </div>
        <div>
          <dt className="text-muted">Compiled plan</dt>
          <dd className="mt-1 break-all font-mono">{item.compiledPlanId ?? 'Unavailable'}</dd>
        </div>
      </dl>
    </section>
  );
}

function CheckDiagnostics({ result }: { result: PreStagingQualificationReceipt['checkResults'][number] }) {
  return (
    <li className="space-y-3 px-3 py-3">
      <div className="flex items-start gap-2">
        {result.status === 'passed'
          ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
          : <XCircle size={15} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />}
        <div className="min-w-0 flex-1">
          <strong>{result.label}</strong>
          <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-4">
            <div><dt className="text-muted">Exit code</dt><dd>{result.exitCode ?? 'None'}</dd></div>
            <div><dt className="text-muted">Signal</dt><dd>{result.signal ?? 'None'}</dd></div>
            <div><dt className="text-muted">Timeout</dt><dd>{result.timedOut ? 'Timed out' : 'No'} · limit {result.timeoutMs} ms</dd></div>
            <div><dt className="text-muted">Duration</dt><dd>{result.durationMs} ms</dd></div>
          </dl>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <section aria-label={`${result.label} stdout`}>
          <h4 className="text-xs font-semibold text-muted">stdout</h4>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-2 text-xs text-[var(--text)]">{result.stdoutExcerpt || 'No stdout captured.'}</pre>
        </section>
        <section aria-label={`${result.label} stderr`}>
          <h4 className="text-xs font-semibold text-muted">stderr</h4>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel p-2 text-xs text-[var(--text)]">{result.stderrExcerpt || 'No stderr captured.'}</pre>
        </section>
      </div>
    </li>
  );
}

function ReceiptReadiness({ item }: { item: PreStagingQualificationReceipt }) {
  const readiness = item.readiness;
  return (
    <section className="space-y-2" aria-label="Qualification readiness">
      <p>{readiness.rationale ?? 'No readiness rationale was recorded.'}</p>
      <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="text-muted">Discovered checks passed</dt>
          <dd>{readiness.allDiscoveredChecksPassed === undefined ? 'Unavailable' : readiness.allDiscoveredChecksPassed ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt className="text-muted">Missing required categories</dt>
          <dd>{readiness.missingRequiredCategories === undefined ? 'Unavailable' : readiness.missingRequiredCategories.join(', ') || 'None'}</dd>
        </div>
        <div>
          <dt className="text-muted">Evidence-emitting gates</dt>
          <dd>{readiness.evidenceEmittedGateIds === undefined ? 'Unavailable' : readiness.evidenceEmittedGateIds.join(', ') || 'None'}</dd>
        </div>
        <div>
          <dt className="text-muted">Pending governed gates</dt>
          <dd>{readiness.pendingGovernedGateIds === undefined ? 'Unavailable' : readiness.pendingGovernedGateIds.join(', ') || 'None'}</dd>
        </div>
        <div>
          <dt className="text-muted">Staging authority</dt>
          <dd>{readiness.stagingAuthorityGranted === false ? 'Not granted' : 'Unavailable'}</dd>
        </div>
      </dl>
    </section>
  );
}

export default function PreStagingQualification({ workspaceId, specId, runId, onEvidenceWritten }: Props) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<PreStagingQualificationPreview | null>(null);
  const [receipt, setReceipt] = useState<PreStagingQualificationReceipt | null>(null);
  const [history, setHistory] = useState<PreStagingQualificationReceipt[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirmedPreviewHash, setConfirmedPreviewHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewInvalidated, setPreviewInvalidated] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const loadGenerationRef = useRef(0);
  const executionIdentityRef = useRef<{ previewHash: string; idempotencyKey: string } | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(open, undefined, {
    onEscape: running ? undefined : () => setOpen(false),
  });
  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setAnnouncement('Loading exact qualification preview.');
    setError(null);
    setPreview(null);
    setReceipt(null);
    setHistory([]);
    setConfirmedPreviewHash(null);
    setPreviewInvalidated(false);
    try {
      const [nextPreview, past] = await Promise.all([
        getPreStagingQualificationPreview(workspaceId, specId, runId ?? undefined),
        listPreStagingQualifications(workspaceId, specId, 5),
      ]);
      if (generation !== loadGenerationRef.current) return;
      if (
        executionIdentityRef.current
        && executionIdentityRef.current.previewHash !== nextPreview.previewHash
      ) {
        executionIdentityRef.current = null;
      }
      setPreview(nextPreview);
      setHistory(past.items);
      setAnnouncement('Qualification preview loaded. Review the exact commands before confirming.');
    } catch (cause) {
      if (generation !== loadGenerationRef.current) return;
      setError(message(cause));
      setAnnouncement(`Qualification preview failed to load: ${message(cause)}`);
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [runId, specId, workspaceId]);

  useEffect(() => {
    if (!open) return;
    void load();
    return () => { loadGenerationRef.current += 1; };
  }, [load, open]);


  const execute = async () => {
    const exactPreview = preview;
    if (!exactPreview || confirmedPreviewHash !== exactPreview.previewHash) {
      setConfirmedPreviewHash(null);
      setError('The qualification preview changed. Review and confirm the current preview before running checks.');
      setAnnouncement('Qualification was not started because the confirmed preview changed.');
      return;
    }
    const executionGeneration = loadGenerationRef.current;
    if (
      !executionIdentityRef.current
      || executionIdentityRef.current.previewHash !== exactPreview.previewHash
    ) {
      executionIdentityRef.current = {
        previewHash: exactPreview.previewHash,
        idempotencyKey: `pre-staging-${crypto.randomUUID()}`,
      };
    }
    const idempotencyKey = executionIdentityRef.current.idempotencyKey;
    setRunning(true);
    setConfirmedPreviewHash(null);
    setError(null);
    setAnnouncement('Running isolated qualification checks.');
    try {
      const result = await runPreStagingQualification(
        workspaceId,
        specId,
        exactPreview.previewHash,
        idempotencyKey,
        runId ?? undefined,
      );
      if (executionGeneration !== loadGenerationRef.current) return;
      executionIdentityRef.current = null;
      setReceipt(result);
      setHistory((current) => [result, ...current.filter((item) => item.id !== result.id)].slice(0, 5));
      setAnnouncement(`Qualification ${result.status}. ${result.readiness.rationale ?? 'Review the immutable receipt for details.'}`);
      onEvidenceWritten?.();
    } catch (cause) {
      if (executionGeneration !== loadGenerationRef.current) return;
      if (cause instanceof ApiError && cause.status === 409) {
        setPreview(null);
        setConfirmedPreviewHash(null);
        setPreviewInvalidated(true);
      }
      setError(message(cause));
      setAnnouncement(`Qualification failed: ${message(cause)}`);
    } finally {
      if (executionGeneration === loadGenerationRef.current) setRunning(false);
    }
  };

  useEffect(() => {
    if (open && !running && (receipt || previewInvalidated)) primaryActionRef.current?.focus();
  }, [open, previewInvalidated, receipt, running]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setAnnouncement('');
          setOpen(true);
        }}
        className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-sm font-medium text-[var(--text)] hover:border-accent/50 hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <FlaskConical size={16} aria-hidden="true" /> Qualify for staging
      </button>

      {open && createPortal(
        <div ref={dialogRef} className="lifecycle-governed-dialog fixed inset-0 z-[140] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="pre-staging-title">
          <div className="lifecycle-governed-dialog__surface flex max-h-[92vh] w-full max-w-4xl flex-col rounded-xl border border-border bg-bg">
            <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-border bg-bg px-5 py-4">
              <ShieldCheck size={20} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <h2 id="pre-staging-title" className="font-semibold text-[var(--text)]">Pre-staging qualification</h2>
                <p className="mt-1 text-xs text-muted">Preview exact repository-owned checks. Execution uses an isolated worktree at the displayed HEAD and grants no staging, merge, or deployment authority.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} disabled={running} aria-label="Close qualification preview" className="flex min-h-11 min-w-11 items-center justify-center rounded-md p-2 text-muted hover:bg-panel hover:text-[var(--text)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><X size={18} aria-hidden="true" /></button>
            </header>

            <main className="space-y-4 overflow-y-auto p-5 text-sm">
              <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</p>
              {loading && <div className="flex items-center gap-2 py-8 text-muted" role="status"><Loader2 size={17} className="animate-spin" aria-hidden="true" /> Loading exact qualification preview…</div>}

              {preview && !loading && <>
                <section className="grid gap-3 rounded-lg border border-border bg-panel p-4 sm:grid-cols-2" aria-label="Qualification revision binding">
                  <div><h3 className="text-xs text-muted">Immutable source</h3><p className="mt-1 flex flex-wrap items-center gap-1.5">HEAD <LifecycleHashChip value={preview.headSha} label="qualification HEAD" /></p></div>
                  <div><h3 className="text-xs text-muted">Canonical plan</h3><p className="mt-1">{preview.planId ?? 'Unavailable'} · {preview.compilerVersion ?? 'no compiler'} · {preview.policyVersion ?? 'no policy'}</p></div>
                  <div><h3 className="text-xs text-muted">Required categories</h3><p className="mt-1">{preview.requiredCategories.join(', ') || 'None declared by active gates'}</p></div>
                  <div><h3 className="text-xs text-muted">Unavailable required categories</h3><p className={`mt-1 ${preview.missingRequiredCategories.length ? 'text-warning' : 'text-success'}`}>{preview.missingRequiredCategories.join(', ') || 'None'}</p></div>
                  <div className="sm:col-span-2"><h3 className="text-xs text-muted">Preview identity</h3><p className="mt-1 flex flex-wrap items-center gap-1.5"><LifecycleHashChip value={preview.previewHash} label="qualification preview hash" /> <span>· {preview.checks.length} commands · {preview.runId === null ? 'spec-level qualification' : `run ${preview.runId}`} · clean HEAD={String(preview.cleanHead)}</span></p></div>
                </section>

                <section className="overflow-hidden rounded-lg border border-border" aria-labelledby="qualification-checks-title">
                  <div className="border-b border-border bg-panel px-4 py-3"><h3 id="qualification-checks-title" className="text-xs font-semibold uppercase tracking-wide text-muted">Exact command plan</h3></div>
                  {preview.checks.length === 0 ? <p className="p-4 text-muted">No safe repository-declared checks were discovered.</p> : (
                    <ul className="divide-y divide-border">
                      {preview.checks.map((check) => <li key={check.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[7rem_1fr_auto] sm:items-start">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted">{check.category}</span>
                        <div className="min-w-0">
                          <p className="font-medium text-[var(--text)]">{check.label}</p>
                          <dl className="mt-2 space-y-2 text-xs">
                            <div><dt className="text-muted">Working directory (JSON string)</dt><dd><code className="block break-all text-[var(--text)]">{JSON.stringify(check.cwd)}</code></dd></div>
                            <div><dt className="text-muted">argv (JSON array)</dt><dd><code className="block break-all text-[var(--text)]">{JSON.stringify([check.executable, ...check.args])}</code></dd></div>
                          </dl>
                        </div>
                        <span className="text-xs tabular-nums text-muted">limit {check.timeoutMs} ms</span>
                      </li>)}
                    </ul>
                  )}
                </section>

                {preview.preconditions.blockers.length > 0 && <div className="rounded-md border border-error/30 bg-error/10 p-3 text-error" role="alert"><p className="font-medium">Execution blocked</p><ul className="mt-1 list-disc space-y-1 pl-5">{preview.preconditions.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
                {preview.missingRequiredCategories.length > 0 && preview.preconditions.canExecute && <div className="rounded-md border border-warning/30 bg-warning/10 p-3 text-warning"><strong>Expected result: blocked.</strong> Available checks will still run and produce evidence, but missing required categories cannot be inferred as passed.</div>}
                <div className="rounded-md border border-border p-3 text-xs text-muted">{preview.authority.rationale}</div>

                {!receipt && <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={confirmedPreviewHash === preview.previewHash}
                    disabled={running}
                    onChange={(event) => setConfirmedPreviewHash(event.target.checked ? preview.previewHash : null)}
                    className="mt-0.5"
                  />
                  <span>I confirm the exact HEAD, canonical plan, command list, isolated-worktree execution, and no-authority consequence shown above.</span>
                </label>}
              </>}

              {receipt && <section className="space-y-3 rounded-lg border border-border bg-panel p-4" aria-label="Latest qualification receipt">
                <div className="flex items-center gap-2">{statusIcon(receipt.status)}<h3 className="font-semibold capitalize text-[var(--text)]">Qualification {receipt.status}</h3></div>
                <ReceiptReadiness item={receipt} />
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">Receipt <LifecycleHashChip value={receipt.receiptHash} label="qualification receipt hash" /> · {receipt.evidenceIds.length} evidence records · {new Date(receipt.createdAt).toLocaleString()}</p>
                <ReceiptRevisionBinding item={receipt} activePreview={preview} />
                <ul className="divide-y divide-border rounded-md border border-border bg-bg" aria-label="Qualification check diagnostics">
                  {receipt.checkResults.map((result) => <CheckDiagnostics key={result.id} result={result} />)}
                </ul>
              </section>}

              {error && <div className="flex items-start gap-2 rounded-md border border-error/30 bg-error/10 p-3 text-error" role="alert"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /><span>{error}</span></div>}

              {history.length > 0 && <details className="rounded-lg border border-border p-4">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">Recent immutable receipts ({history.length})</summary>
                <ul className="mt-3 space-y-3">
                  {history.map((item) => <li key={item.id} className="space-y-3 rounded-md border border-border bg-panel p-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      {statusIcon(item.status)}
                      <span className="capitalize">{item.status}</span>
                      <LifecycleHashChip value={item.receiptHash} label="receipt hash" />
                      <time dateTime={item.createdAt} className="text-muted">{new Date(item.createdAt).toLocaleString()}</time>
                    </div>
                    <ReceiptReadiness item={item} />
                    <ReceiptRevisionBinding item={item} activePreview={preview} />
                    <ul className="divide-y divide-border rounded-md border border-border bg-bg" aria-label={`Qualification check diagnostics for receipt ${item.id}`}>
                      {item.checkResults.map((result) => <CheckDiagnostics key={result.id} result={result} />)}
                    </ul>
                  </li>)}
                </ul>
              </details>}
            </main>

            <footer className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg px-5 py-4">
              <button type="button" onClick={() => setOpen(false)} disabled={running} className="min-h-11 rounded-md border border-border bg-bg px-4 py-2 text-sm font-medium text-[var(--text)] hover:bg-panel disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Close</button>
              {error && !loading && !preview && !receipt && <button ref={primaryActionRef} type="button" onClick={() => void load()} className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{previewInvalidated ? 'Refresh preview' : 'Retry preview'}</button>}
              {preview && !receipt && <button ref={primaryActionRef} type="button" onClick={() => void execute()} disabled={running || confirmedPreviewHash !== preview.previewHash || !preview.preconditions.canExecute} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{running && <Loader2 size={15} className="animate-spin" aria-hidden="true" />} {running ? 'Running isolated checks…' : 'Run exact qualification'}</button>}
              {receipt && <button ref={primaryActionRef} type="button" onClick={() => void load()} disabled={loading || running} className="min-h-11 rounded-md bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-accent-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Refresh preview</button>}
            </footer>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
