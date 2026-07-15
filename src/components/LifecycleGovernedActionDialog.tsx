/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, ShieldAlert, X } from 'lucide-react';
import type {
  LifecycleDecisionType,
  LifecycleGate,
  LifecyclePhaseResponse,
  LifecyclePortfolioItem,
  LifecycleRetryPreviewResponse,
  LifecycleSpecResponse,
} from '../types/lifecycle';
import { useFocusTrap } from '../hooks/useFocusTrap';

export type LifecycleGovernedDialog =
  | { kind: 'retry'; preview: LifecycleRetryPreviewResponse }
  | { kind: 'decision'; decisionType: LifecycleDecisionType };

interface Props {
  dialog: LifecycleGovernedDialog;
  phase: LifecyclePhaseResponse;
  spec: LifecycleSpecResponse | null;
  portfolioItem: LifecyclePortfolioItem | null;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onRetryConfirm: () => void;
  onDecisionConfirm: (input: { rationale: string; evidenceGap?: string; expiresAt?: string }) => void;
}

function list(items: Array<{ storyId: string; reasonCode: string }>): string {
  return items.length ? items.map((item) => `${item.storyId} (${item.reasonCode})`).join(', ') : 'None';
}

function decisionLabel(type: LifecycleDecisionType): string {
  if (type === 'gate_override') return 'Review override';
  if (type === 'qa_approval') return 'QA approval';
  if (type === 'merge_approval') return 'Merge approval';
  if (type === 'production_approval') return 'Production approval';
  return 'Governed decision';
}

function serverGate(phase: LifecyclePhaseResponse): LifecycleGate | null {
  return phase.requiredGates.items.find((gate) => gate.gateId === phase.blocker?.gateId)
    ?? phase.requiredGates.items.find((gate) => gate.evaluation?.status !== 'passed')
    ?? null;
}

export default function LifecycleGovernedActionDialog({
  dialog,
  phase,
  spec,
  portfolioItem,
  pending,
  error,
  onCancel,
  onRetryConfirm,
  onDecisionConfirm,
}: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const [rationale, setRationale] = useState('');
  const [evidenceGap, setEvidenceGap] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const dialogRef = useFocusTrap<HTMLDivElement>();
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onCancel();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onCancel, pending]);
  const gate = serverGate(phase);
  const revision = portfolioItem?.currentRevision ?? (spec?.plan ? {
    specVersion: spec.plan.specVersion,
    planVersion: spec.plan.version,
    inputHash: spec.plan.inputHash,
  } : null);

  const retryDenial = useMemo(() => {
    if (dialog.kind !== 'retry') return null;
    if (Date.parse(dialog.preview.previewIdentity.expiresAt) <= Date.now()) return 'Preview expired. Generate a new retry preview.';
    if (dialog.preview.preview.requiresApproval) return 'This packet requires the existing operator approval path; Lifecycle Control cannot supply or broaden that authority.';
    const preflight = dialog.preview.worktreePreflight;
    if (preflight && !preflight.ok && !['dirty_expected_work', 'stale_base'].includes(preflight.classification)) {
      return `${preflight.detail ?? `Preflight failed: ${preflight.classification}`} ${preflight.remediation ?? 'Resolve the server preflight issue, then generate a new preview.'}`;
    }
    return null;
  }, [dialog]);

  const decisionDenied = dialog.kind === 'decision' && dialog.decisionType === 'gate_override' && gate?.hardDeny
    ? `Gate '${gate.gateId}' is a server-classified non-bypassable hard-deny control.`
    : null;
  const decisionNeedsExpiry = dialog.kind === 'decision' && dialog.decisionType === 'gate_override';
  const decisionReady = dialog.kind === 'decision'
    && rationale.trim().length >= 10
    && (!decisionNeedsExpiry || (evidenceGap.trim().length >= 10 && Boolean(expiresAt)))
    && !decisionDenied;

  const title = dialog.kind === 'retry' ? 'Retry preview' : decisionLabel(dialog.decisionType);
  return (
    <div ref={dialogRef} className="lifecycle-governed-dialog fixed inset-0 z-[140] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="lifecycle-action-title">
      <div className="lifecycle-governed-dialog__surface flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-bg">
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-border bg-bg px-5 py-4">
          <ShieldAlert size={20} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
          <div className="min-w-0 flex-1"><h2 id="lifecycle-action-title" className="font-semibold text-[var(--text)]">{title}</h2><p className="mt-1 text-xs text-muted">Preview first. Closing or cancelling records no decision and queues no work.</p></div>
          <button type="button" onClick={onCancel} disabled={pending} aria-label={`Close ${title}`} className="flex min-h-11 min-w-11 items-center justify-center rounded-md p-2 text-muted hover:bg-panel hover:text-[var(--text)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><X size={18} aria-hidden="true" /></button>
        </header>

        <main className="space-y-4 overflow-y-auto p-5 text-sm">
          {dialog.kind === 'retry' ? (
            <>
              <section aria-label="Exact retry scope" className="space-y-2 rounded-lg border border-border bg-panel p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Exact story and dependency scope</h3>
                <p><strong>Requested:</strong> {list(dialog.preview.preview.scope.requested)}</p>
                <p><strong>Required dependencies:</strong> {list(dialog.preview.preview.scope.requiredDependency)}</p>
                <p><strong>Executable:</strong> {list(dialog.preview.preview.scope.executable)}</p>
                <p><strong>Copied passed work:</strong> {list(dialog.preview.preview.scope.copiedPassed)}</p>
                <p><strong>Skipped / remaining:</strong> {list([...dialog.preview.preview.scope.skipped, ...dialog.preview.preview.scope.remaining])}</p>
              </section>
              <section className="grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2" aria-label="Server-enforced retry execution policy">
                <div><h3 className="text-xs text-muted">Agent / model / effort</h3><p>{dialog.preview.preview.options.agent} · {dialog.preview.preview.options.model ?? 'workspace default'} · {dialog.preview.preview.options.effort ?? 'default'}</p></div>
                <div><h3 className="text-xs text-muted">Environment</h3><p>{dialog.preview.preview.options.terminalMode} · graph {dialog.preview.preview.options.includeGraph ? 'included' : 'excluded'} · {dialog.preview.preview.forceSequential ? 'sequential' : 'normal scheduling'}</p></div>
                <div><h3 className="text-xs text-muted">Worktree / branch</h3><p>{dialog.preview.preview.options.worktree.enabled ? 'isolated worktree' : 'existing workspace'} · {dialog.preview.preview.options.worktree.path ?? 'server-assigned path'} · {dialog.preview.preview.options.worktree.branch ?? 'server-assigned branch'}</p></div>
                <div><h3 className="text-xs text-muted">Validation plan</h3><p>Focused tests for exact executable scope · backend Jest prohibited · preflight {dialog.preview.worktreePreflight?.classification ?? 'not required'}</p></div>
                <div><h3 className="text-xs text-muted">Risk</h3><p>{dialog.preview.preview.requiresApproval ? 'Elevated — separate operator approval required' : 'Bounded retry'} · destructive controls remain unavailable</p></div>
                <div><h3 className="text-xs text-muted">Publication policy</h3><p>{dialog.preview.preview.options.merge.strategy} · auto-merge={String(dialog.preview.preview.options.merge.autoMerge)} · deploy={String(dialog.preview.preview.options.safety.deploy)} · external-send={String(dialog.preview.preview.options.safety.externalSend)}</p></div>
              </section>
              <p className="break-all text-xs text-muted">Immutable preview {dialog.preview.preview.previewHash} · expires {dialog.preview.previewIdentity.expiresAt}</p>
            </>
          ) : (
            <>
              <section className="space-y-2 rounded-lg border border-border bg-panel p-4" aria-label="Governed policy packet">
                <p><strong>Blocked rule:</strong> {gate?.title ?? phase.blocker?.gateId ?? 'Exact blocked gate unavailable'}</p>
                <p><strong>Missing evidence:</strong> {gate?.evaluation?.blockerReason ?? phase.blocker?.reason ?? 'Server did not report an evidence gap'}</p>
                <p><strong>Risk:</strong> {portfolioItem?.risk ?? 'unknown'} · {gate?.blockingSeverity ?? 'unknown severity'}</p>
                <p><strong>Authorized approvers:</strong> {gate?.authorizedApprovers?.join(', ') ?? 'Server-verified policy approver only'}</p>
                <p><strong>Scope:</strong> {phase.specId} / {phase.phaseId} / {gate?.gateId ?? 'phase'}</p>
                <p><strong>Expiry:</strong> {dialog.decisionType === 'gate_override' ? 'Required and bounded by submitted timestamp' : 'Policy-managed'}</p>
                <p className="break-all"><strong>Revision:</strong> Spec {revision?.specVersion ?? 'unknown'} · Plan {revision?.planVersion ?? 'unknown'} · {revision?.inputHash ?? phase.snapshotId}</p>
                <p><strong>Hard controls:</strong> {gate?.hardDeny ? 'Non-bypassable — submission disabled' : 'Security, credentials, destructive migration, external send, merge, deploy, and production hard-deny controls remain non-bypassable.'}</p>
                {dialog.decisionType !== 'gate_override' && <p><strong>Consequence:</strong> Records an approval decision for this immutable revision only. It does not merge, deploy, or send externally.</p>}
              </section>
              <label className="block text-xs font-medium text-muted">Rationale (required)<textarea value={rationale} onChange={(event) => setRationale(event.target.value)} className="mt-1 min-h-20 w-full rounded-md border border-border bg-panel p-2 text-sm text-[var(--text)]" /></label>
              {dialog.decisionType === 'gate_override' && <>
                <label className="block text-xs font-medium text-muted">Missing evidence statement (required)<textarea value={evidenceGap} onChange={(event) => setEvidenceGap(event.target.value)} className="mt-1 min-h-16 w-full rounded-md border border-border bg-panel p-2 text-sm text-[var(--text)]" /></label>
                <label className="block text-xs font-medium text-muted">Expiry (required)<input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="mt-1 block rounded-md border border-border bg-panel p-2 text-sm text-[var(--text)]" /></label>
              </>}
            </>
          )}

          {(retryDenial || decisionDenied || error) && <div className="flex items-start gap-2 rounded-md border border-error/30 bg-error/10 p-3 text-sm text-error" role="alert"><AlertTriangle size={16} className="mt-0.5 shrink-0" /> <span>{error ?? decisionDenied ?? retryDenial}</span></div>}
          <label className="flex items-start gap-2 rounded-md border border-border p-3 text-sm text-[var(--text)]">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" />
            <span>I confirm this exact server-returned scope, immutable revision, consequence, and worktree/branch/merge/deployment/external-send policy.</span>
          </label>
        </main>

        <footer className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-bg px-5 py-4">
          <button type="button" onClick={onCancel} disabled={pending} className="min-h-11 rounded-md border border-border bg-bg px-4 py-2 text-sm font-medium text-[var(--text)] hover:bg-panel disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Cancel</button>
          <button
            type="button"
            disabled={pending || !confirmed || Boolean(retryDenial) || Boolean(decisionDenied) || (dialog.kind === 'decision' && !decisionReady)}
            onClick={() => dialog.kind === 'retry' ? onRetryConfirm() : onDecisionConfirm({ rationale: rationale.trim(), ...(evidenceGap.trim() ? { evidenceGap: evidenceGap.trim() } : {}), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) })}
            className="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {pending ? 'Submitting…' : dialog.kind === 'retry' ? 'Queue exact retry' : dialog.decisionType === 'gate_override' ? 'Submit override decision' : `Record ${decisionLabel(dialog.decisionType)}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
