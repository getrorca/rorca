/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useRef } from 'react';
import {
  Activity,
  ChevronRight,
  Clock3,
  ExternalLink,
  X,
} from 'lucide-react';
import LifecycleEvidenceInspector from './LifecycleEvidenceInspector';
import LifecycleTraceability from './LifecycleTraceability';
import type {
  LifecycleBounded,
  LifecycleEvidenceDetail,
  LifecycleEvidenceSummary,
  LifecyclePermittedAction,
  LifecyclePhaseResponse,
  LifecyclePortfolioItem,
  LifecycleQueryState,
  LifecycleSpecResponse,
} from '../types/lifecycle';
import { LIFECYCLE_STATUS_LABELS, LifecycleStatusIcon } from '../panels/LifecycleCell';

export const LIFECYCLE_STICKY_ACTIONS: ReadonlyArray<{
  id: LifecyclePermittedAction;
  label: string;
}> = [
  { id: 'retry_smallest_scope', label: 'Retry story' },
  { id: 'run_phase', label: 'Open run' },
  { id: 'reopen_disposition', label: 'Review override' },
  { id: 'recompile_plan', label: 'Recompile' },
  { id: 'request_approval', label: 'Request approval' },
];

interface LifecyclePhaseDrawerProps {
  phase: LifecyclePhaseResponse;
  spec: LifecycleSpecResponse | null;
  portfolioItem: LifecyclePortfolioItem | null;
  evidence: LifecycleQueryState<LifecycleEvidenceDetail>;
  selectedEvidenceId: string | null;
  selectedEvidenceSnapshotId: string | null;
  onOpenEvidence: (evidenceId: string) => void;
  onCloseEvidence: () => void;
  onRefreshEvidence: () => void;
  onClose: () => void;
  onAction: (action: LifecyclePermittedAction) => void;
  actionPending?: LifecyclePermittedAction | null;
}

function readable(value: string): string {
  const normalized = value.replace(/_/g, ' ');
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function timestamp(value: string | null | undefined): React.ReactNode {
  if (!value) return <span>Unknown time</span>;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return <span>Unknown time</span>;
  return <time dateTime={value}>{parsed.toLocaleString()}</time>;
}

function revisionLabel(evidence: LifecycleEvidenceSummary | undefined): string {
  if (!evidence || typeof evidence.currentRevision !== 'boolean') return 'Revision unknown';
  return evidence.currentRevision && !evidence.stale ? 'Current revision' : 'Revision mismatch';
}

function BoundedMapping({ label, value, onOpenTraceability }: { label: string; value: LifecycleBounded<string>; onOpenTraceability?: (reference: string) => void }) {
  return (
    <div className="border-b border-border py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</h4>
        <span className="text-xs tabular-nums text-muted">{value.total}</span>
      </div>
      {value.items.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-[var(--text)]">
          {value.items.map((item) => (
            <li key={item} className="break-words">
              {onOpenTraceability ? <button type="button" onClick={() => onOpenTraceability(item)} className="rounded-sm text-left text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={`Open traceability for ${item}`}>{item}</button> : item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">No mapped {label.toLowerCase()}.</p>
      )}
      {value.truncated && <p className="mt-2 text-xs text-warning">Showing {value.items.length} of {value.total} mapped records.</p>}
    </div>
  );
}

function gateEvidence(gateId: string, evidence: LifecycleEvidenceSummary[]): LifecycleEvidenceSummary | undefined {
  return evidence.find((item) => item.gateId === gateId);
}

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return <h3 id={id} className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{children}</h3>;
}

export default function LifecyclePhaseDrawer({
  phase,
  spec,
  portfolioItem,
  evidence,
  selectedEvidenceId,
  selectedEvidenceSnapshotId,
  onOpenEvidence,
  onCloseEvidence,
  onRefreshEvidence,
  onClose,
  onAction,
  actionPending = null,
}: LifecyclePhaseDrawerProps) {
  const gates = phase.requiredGates.items;
  const passedGates = gates.filter((gate) => gate.evaluation?.status === 'passed').length;
  const liveness = spec?.currentRun?.liveness ?? portfolioItem?.liveness ?? null;
  const latestEvidence = phase.evidence.items.find((item) => item.observedAt)?.observedAt;
  const lastActivity = latestEvidence ?? liveness?.lastMeaningfulActivity ?? portfolioItem?.updatedAt ?? null;
  const revision = portfolioItem?.currentRevision ?? (spec?.plan ? {
    specVersion: spec.plan.specVersion,
    inputHash: spec.plan.inputHash,
    planVersion: spec.plan.version,
  } : null);
  const permitted = new Set(phase.permittedActions);
  const actions = LIFECYCLE_STICKY_ACTIONS.filter((action) => permitted.has(action.id));
  const guidance = phase.nextSafeActionGuidance;
  const evidenceTriggerRef = useRef<HTMLElement | null>(null);
  const traceabilityViewRef = useRef<HTMLElement | null>(null);
  const openEvidence = (evidenceId: string, trigger?: HTMLElement) => {
    evidenceTriggerRef.current = trigger ?? null;
    onOpenEvidence(evidenceId);
  };
  const closeEvidence = () => {
    onCloseEvidence();
    queueMicrotask(() => evidenceTriggerRef.current?.focus());
  };
  const openTraceability = () => {
    traceabilityViewRef.current?.scrollIntoView?.({ block: 'start' });
    traceabilityViewRef.current?.focus();
  };

  return (
    <div className="flex min-h-full flex-col bg-bg" data-testid="lifecycle-phase-drawer">
      <header className="sticky top-0 z-10 border-b border-border bg-panel px-5 py-4 sm:px-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-accent">{portfolioItem?.title ?? spec?.title ?? phase.specId}</p>
            <h2 className="mt-1 text-lg font-semibold text-[var(--text)]">{readable(phase.phaseId)} phase</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-200 hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Close phase details"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
          <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text)]">
            <LifecycleStatusIcon status={phase.status} size={14} />
            {LIFECYCLE_STATUS_LABELS[phase.status]}
          </span>
          <span>{passedGates} of {gates.length} gates passed</span>
          <span className="inline-flex items-center gap-1"><Clock3 size={13} aria-hidden="true" /> Last activity: {timestamp(lastActivity)}</span>
        </div>
        <p className="mt-2 break-all text-xs text-muted">
          Revision: {revision
            ? `Spec ${revision.specVersion ?? 'unknown'} · Plan ${revision.planVersion} · ${revision.inputHash}`
            : 'Unknown'}
        </p>
      </header>

      <main className="flex-1 space-y-5 px-5 py-5 sm:px-6" aria-live="polite">
        <section className="rounded-lg border border-border bg-panel p-4" aria-labelledby="phase-state-heading">
          <SectionHeading id="phase-state-heading">Current phase state</SectionHeading>
          <div className="flex items-start gap-2 text-sm">
            <LifecycleStatusIcon status={phase.status} size={16} />
            <div>
              <p className="font-semibold text-[var(--text)]">{LIFECYCLE_STATUS_LABELS[phase.status]} · {passedGates} of {gates.length} gates passed</p>
              <h3 className={`mt-3 text-xs font-semibold uppercase tracking-wide ${phase.blocker ? 'text-error' : 'text-muted'}`}>Blocker</h3>
              <p className={`mt-1 ${phase.blocker ? 'text-error' : 'text-muted'}`}>{phase.blocker?.reason ?? 'No blocker is reported for the current snapshot.'}</p>
            </div>
          </div>
          <div className="mt-4 border-l-2 border-accent pl-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Next safe action</h3>
            {guidance ? (
              <>
                <p className="mt-1 text-sm font-medium text-[var(--text)]">{guidance.action}</p>
                <p className="mt-1 text-sm text-muted">{guidance.rationale}</p>
                <p className="mt-2 text-xs text-muted">Backend classifier: {readable(guidance.classifier)} · {Math.round(guidance.confidence * 100)}% confidence</p>
              </>
            ) : <p className="mt-1 text-sm text-warning">Classifier guidance is unavailable. No client-inferred action is shown.</p>}
          </div>
        </section>

        <section aria-labelledby="phase-why-heading">
          <SectionHeading id="phase-why-heading">Why required</SectionHeading>
          <p className="text-sm leading-6 text-[var(--text)]">{phase.whyRequired ?? 'No requirement rationale was supplied.'}</p>
        </section>

        <section aria-labelledby="phase-mapping-heading">
          <SectionHeading id="phase-mapping-heading">Mapped requirements, decisions, and stories</SectionHeading>
          <div className="border-y border-border">
            <BoundedMapping label="Requirements" value={phase.mappedRequirements} onOpenTraceability={openTraceability} />
            <BoundedMapping label="Decisions" value={phase.mappedDecisions} onOpenTraceability={openTraceability} />
            <BoundedMapping label="Stories" value={phase.mappedStories} onOpenTraceability={openTraceability} />
          </div>
        </section>

        {spec?.traceability && (
          <section ref={traceabilityViewRef} tabIndex={-1} aria-labelledby="phase-traceability-heading" className="focus:outline-none">
            <SectionHeading id="phase-traceability-heading">Requirement-to-evidence traceability</SectionHeading>
            <LifecycleTraceability traceability={spec.traceability} snapshotId={phase.snapshotId} onOpenEvidence={openEvidence} />
          </section>
        )}

        <section aria-labelledby="phase-gates-heading">
          <SectionHeading id="phase-gates-heading">Required gates</SectionHeading>
          <div className="divide-y divide-border border-y border-border">
            {gates.length === 0 && <p className="py-3 text-sm text-muted">No gates are required for this phase.</p>}
            {gates.map((gate) => {
              const supportingEvidence = gateEvidence(gate.gateId, phase.evidence.items);
              const status = gate.evaluation?.status;
              return (
                <button
                  key={gate.gateId}
                  type="button"
                  disabled={!supportingEvidence}
                  onClick={(event) => supportingEvidence && openEvidence(supportingEvidence.id, event.currentTarget)}
                  className="flex w-full items-start gap-3 py-3 text-left enabled:hover:bg-surface-200/50 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                  aria-label={`${gate.title}. ${status ? LIFECYCLE_STATUS_LABELS[status] : 'Evaluation unknown'}. ${supportingEvidence ? 'Open supporting evidence' : 'Supporting evidence unavailable'}`}
                >
                  <LifecycleStatusIcon status={status ?? 'not_started'} size={15} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-[var(--text)]">{gate.title}</span>
                    <span className="mt-1 block text-xs text-muted">
                      {status ? LIFECYCLE_STATUS_LABELS[status] : 'Evaluation unknown'} · Source: {supportingEvidence?.sourceSystem || 'Unknown'} · {timestamp(supportingEvidence?.observedAt)} · {revisionLabel(supportingEvidence)}
                    </span>
                    {!supportingEvidence && <span className="mt-1 block text-xs text-warning">Supporting evidence is missing or unknown.</span>}
                  </span>
                  {supportingEvidence && <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          {phase.requiredGates.truncated && <p className="mt-2 text-xs text-warning">Showing {gates.length} of {phase.requiredGates.total} gates.</p>}
        </section>

        <section aria-labelledby="phase-evidence-heading">
          <SectionHeading id="phase-evidence-heading">Bounded evidence</SectionHeading>
          <div className="divide-y divide-border border-y border-border">
            {phase.evidence.items.length === 0 && <p className="py-3 text-sm text-muted">No evidence has been recorded; source, time, and revision match are unknown.</p>}
            {phase.evidence.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={(event) => openEvidence(item.id, event.currentTarget)}
                aria-expanded={selectedEvidenceId === item.id}
                className="flex w-full items-start gap-3 py-3 text-left hover:bg-surface-200/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-[var(--text)]">{item.evidenceType || 'Unknown evidence type'}</span>
                  <span className="mt-1 block text-xs text-muted">
                    {readable(item.status)} · Source: {item.sourceSystem || 'Unknown'} · {timestamp(item.observedAt)} · {revisionLabel(item)}
                  </span>
                  {item.invalidReasons.length > 0 && <span className="mt-1 block text-xs text-warning">{item.invalidReasons.map(readable).join(' · ')}</span>}
                </span>
                <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
              </button>
            ))}
          </div>
          {(phase.evidence.hasMore || phase.evidence.items.length < phase.evidence.total) && (
            <p className="mt-2 text-xs text-warning">Showing {phase.evidence.items.length} of {phase.evidence.total} evidence records.</p>
          )}

          {selectedEvidenceId && (
            <LifecycleEvidenceInspector
              evidence={evidence}
              pinnedSnapshotId={selectedEvidenceSnapshotId}
              onRefresh={onRefreshEvidence}
              onClose={closeEvidence}
            />
          )}
        </section>

        {phase.phaseId === 'learn' && (
          <section aria-labelledby="phase-learn-heading" data-testid="lifecycle-learn-closeout">
            <SectionHeading id="phase-learn-heading">Governed Learn closeout</SectionHeading>
            {phase.learn ? (
              <div className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-panel p-3">
                  <span className="text-muted">Required candidates</span>
                  <strong className="text-right text-[var(--text)]">{phase.learn.candidateCount}/{phase.learn.requiredCandidateCount}</strong>
                  <span className="text-muted">Source evidence</span>
                  <strong className="text-right text-[var(--text)]">{phase.learn.sourceEvidenceCount}</strong>
                  <span className="text-muted">Generation</span>
                  <strong className="text-right text-[var(--text)]">{readable(phase.learn.generation.state)}</strong>
                </div>
                {phase.learn.generation.blocker && (
                  <p className="rounded-md border border-error/30 bg-error/10 p-3 text-error">
                    {phase.learn.generation.blocker.message}
                  </p>
                )}
                <ul className="divide-y divide-border border-y border-border" aria-label="Provenance-linked Learn candidates">
                  {phase.learn.candidates.items.map((candidate) => (
                    <li key={candidate.id} className="space-y-2 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong className="text-[var(--text)]">{candidate.category ?? 'Memory'} candidate #{candidate.id}</strong>
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{readable(candidate.status)}</span>
                      </div>
                      <p className="text-xs text-muted">
                        Workspace {candidate.provenance.workspaceId ?? 'unknown'} · Spec {candidate.provenance.specId ?? 'unknown'} · Run {candidate.provenance.runId ?? 'unknown'} · Story {candidate.provenance.storyId ?? 'run'}
                      </p>
                      <p className="break-all text-xs text-muted">
                        Subject {candidate.provenance.releaseSubject
                          ? `${readable(candidate.provenance.releaseSubject.type)} ${candidate.provenance.releaseSubject.value}`
                          : 'unknown'} · Commit {candidate.provenance.commitSha ?? 'unknown'}
                      </p>
                      <div className="flex flex-wrap gap-2 text-xs">
                        {candidate.provenance.sourceEvidenceIds.map((evidenceId) => (/^\d+$/.test(evidenceId) ? (
                          <button key={evidenceId} type="button" onClick={(event) => openEvidence(evidenceId, event.currentTarget)} className="rounded-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                            Evidence {evidenceId}
                          </button>
                        ) : <span key={evidenceId} className="text-muted">Evidence {evidenceId}</span>))}
                      </div>
                      {candidate.securitySensitive && <p className="text-xs text-warning">Sensitive delivery fact — human review is mandatory.</p>}
                      <p className="text-xs text-muted">Default retrieval: {candidate.defaultRetrievalEligible ? 'Eligible after review' : 'Not eligible'}</p>
                    </li>
                  ))}
                  {phase.learn.candidates.items.length === 0 && <li className="py-3 text-muted">No reviewable candidate exists. Learn remains not started or blocked.</li>}
                </ul>
                <p className="border-l-2 border-accent pl-3 text-[var(--text)]">Next action: {phase.learn.nextAction}</p>
              </div>
            ) : (
              <p className="text-warning">Learn closeout status is unavailable; this phase cannot be presented as passed.</p>
            )}
          </section>
        )}

        <section aria-labelledby="phase-liveness-heading">
          <SectionHeading id="phase-liveness-heading">Liveness</SectionHeading>
          {liveness ? (
            <div className="text-sm text-[var(--text)]">
              <p className="flex items-center gap-2"><Activity size={15} className="text-accent" aria-hidden="true" /> {readable(liveness.state)} · {Math.round(liveness.confidence * 100)}% confidence</p>
              <p className="mt-1 text-xs text-muted">Last meaningful activity: {timestamp(liveness.lastMeaningfulActivity)}</p>
              <details className="mt-2 text-xs text-muted">
                <summary className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Classifier evidence ({liveness.evidence.length})</summary>
                <ul className="mt-2 space-y-1">
                  {liveness.evidence.length === 0 && <li>Evidence unavailable.</li>}
                  {liveness.evidence.map((item) => <li key={`${item.source}:${item.reference}`}>{readable(item.source)} · {timestamp(item.observedAt)} · {item.detail}</li>)}
                </ul>
              </details>
            </div>
          ) : <p className="text-sm text-muted">Run liveness is unknown; no current run evidence is available.</p>}
        </section>

      </main>

      <footer className="sticky bottom-0 z-10 mt-auto border-t border-border bg-panel px-5 py-3 sm:px-6" aria-label="Server-permitted phase actions">
        {actions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {actions.map((action, index) => (
              <button
                key={action.id}
                type="button"
                disabled={actionPending !== null}
                onClick={() => onAction(action.id)}
                className={`${index === 0 ? 'bg-accent text-white hover:bg-accent-hover' : 'border border-border bg-bg text-[var(--text)] hover:bg-surface-200'} inline-flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60`}
              >
                {actionPending === action.id ? 'Working…' : action.label}
                {action.id !== 'recompile_plan' && <ExternalLink size={13} aria-hidden="true" />}
              </button>
            ))}
          </div>
        ) : <p className="text-xs text-muted">No server-permitted actions are available.</p>}
      </footer>
    </div>
  );
}
