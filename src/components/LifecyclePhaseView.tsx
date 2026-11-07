/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Clock3,
  Command,
  ExternalLink,
  MoreHorizontal,
  FileText,
} from 'lucide-react';
import LifecycleEvidenceInspector from './LifecycleEvidenceInspector';
import LifecycleHashChip, { ProseWithHashes } from './LifecycleHashChip';
import LifecycleLivenessBadge from './LifecycleLivenessBadge';
import LifecycleTraceability from './LifecycleTraceability';
import LifecycleSourceWorkspace, { type LifecycleSourceActionError, type LifecycleSourceView } from './LifecycleSourceWorkspace';
import { LifecycleDependencyBadge, LifecycleReadinessStates, LifecycleStatusBadge } from './LifecycleBadges';
import { lifecycleStageOf, type LifecycleMissionStage } from '../types/lifecycle';
import {
  LIFECYCLE_STAGE_IDS,
  aggregateStageCells,
  stageDisplayName,
  stageLeadPhase,
} from '../lib/lifecycle-stages';
import { apiFetch } from '../lib/apiFetch';
import type { SpecCoverageByPhase, SpecCoverageCell } from '../lib/specWorkflow';
import type {
  LifecycleAdviceResponse,
  LifecycleBounded,
  LifecycleDevelopmentExecution,
  LifecycleDecisionType,
  LifecycleEvidenceDetail,
  LifecycleEvidenceSummary,
  LifecycleGovernedDecisionSummary,
  LifecyclePermittedAction,
  LifecycleSourceArtifactAction,
  LifecycleSourceArtifactPreview,
  LifecyclePhaseId,
  LifecyclePhaseResponse,
  LifecyclePortfolioItem,
  LifecycleQueryState,
  LifecycleSpecResponse,
} from '../types/lifecycle';
import { LifecycleStatusIcon } from '../panels/LifecycleCell';

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

interface LifecyclePhaseViewProps {
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
  onSelectPhase: (phaseId: LifecyclePhaseId) => void;
  onAction: (action: LifecyclePermittedAction) => void;
  selectedPhaseId?: LifecyclePhaseId;
  phasePending?: boolean;
  actionPending?: LifecyclePermittedAction | null;
  /** US-010: per-phase engineering-canon coverage from the readiness inspection. */
  coverage?: SpecCoverageByPhase | null;
  coverageLoading?: boolean;
  /** US-011: advisory "what's missing" panel. Never persisted by the server. */
  advice?: LifecycleAdviceResponse | null;
  adviceLoading?: boolean;
  adviceError?: string | null;
  onRequestAdvice?: () => void;
  onOpenSourceArtifact?: (relativePath: string, action: LifecycleSourceArtifactAction, line?: number | null, column?: number | null) => void;
  sourceArtifactError?: LifecycleSourceActionError | null;
  onDismissSourceArtifactError?: () => void;
  onReadSourceArtifact?: (relativePath: string, startLine?: number | null, endLine?: number | null) => Promise<LifecycleSourceArtifactPreview>;
  sourceArtifactPending?: string | null;
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

const DECISION_TYPE_LABELS: Record<LifecycleDecisionType, string> = {
  defer: 'Deferral',
  not_applicable_confirmation: 'Not applicable',
  gate_override: 'Gate override',
  testing_approval: 'Testing approval',
  deployment_approval: 'Deployment approval',
  release_approval: 'Release approval',
};

/** Presentation of server-returned decision fields only — no client-clock inference. */
function decisionActivity(decision: LifecycleGovernedDecisionSummary): { label: string; tone: 'passed' | 'muted' } {
  if (decision.activity === 'active') return { label: 'Active', tone: 'passed' };
  if (decision.activity === 'expired') return { label: 'Expired', tone: 'muted' };
  if (decision.activity === 'revoked') return { label: 'Revoked', tone: 'muted' };
  if (decision.activity === 'stale_revision') return { label: 'Stale revision', tone: 'muted' };
  if (decision.revokedAt) return { label: 'Revoked', tone: 'muted' };
  return { label: 'Recorded', tone: 'muted' };
}
interface LifecycleExportKitIdentity {
  manifestHash: string;
  kitPath: string;
  artifacts: Record<'spec' | 'requirements' | 'design' | 'delivery', {
    path: string;
    contentHash: string;
  }>;
  sealHash?: string | null;
}

interface LifecycleExportKitInspection {
  status: 'current' | 'legacy_missing' | 'stale' | 'tampered';
  identity: LifecycleExportKitIdentity | null;
  reason: string | null;
}

function ExportKitSummary({ workspaceId, specId }: { workspaceId: string; specId: string }) {
  const [inspection, setInspection] = useState<LifecycleExportKitInspection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInspection(null);
    setError(null);
    apiFetch<{ exportKit: LifecycleExportKitInspection }>(
      `/api/specs/${encodeURIComponent(specId)}/export-kit?workspaceId=${encodeURIComponent(workspaceId)}`,
    ).then((response) => {
      if (!cancelled) setInspection(response.exportKit);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Export kit unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, [specId, workspaceId]);

  const identity = inspection?.identity;
  return (
    <section className="rounded-md border border-border bg-panel p-3" aria-labelledby="lifecycle-export-kit-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="lifecycle-export-kit-heading" className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <FileText size={14} aria-hidden="true" />
          Canonical export kit
        </h3>
        {inspection && (
          <span className="lifecycle-chip">{readable(inspection.status)}</span>
        )}
      </div>
      {!inspection && !error && <p className="mt-2 text-xs text-muted">Verifying PRD, SDD, and delivery plan…</p>}
      {error && <p className="mt-2 text-xs text-error">{error}</p>}
      {inspection && inspection.status !== 'current' && (
        <p className="mt-2 text-xs text-warning">{inspection.reason ?? 'The canonical kit is not current for this revision.'}</p>
      )}
      {identity && (
        <>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{identity.kitPath}</span>
            <LifecycleHashChip value={identity.manifestHash} label="kit manifest" />
            {identity.sealHash && <LifecycleHashChip value={identity.sealHash} label="approval seal" />}
          </p>
          <dl className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Canonical spec export-kit artifacts">
            {Object.entries(identity.artifacts).map(([role, artifact]) => (
              <div key={role} className="rounded border border-border px-2 py-1.5">
                <dt className="text-xs font-semibold text-[var(--text)]">{role === 'spec' ? 'Canonical spec' : role === 'requirements' ? 'PRD' : role === 'design' ? 'SDD' : 'PLAN'}</dt>
                <dd className="mt-0.5 text-xs text-muted">{artifact.path}</dd>
                <dd className="mt-1"><LifecycleHashChip value={artifact.contentHash} label={`${role} hash`} /></dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}

function developmentStoryStatus(status: LifecycleDevelopmentExecution['stories']['items'][number]['status']) {
  if (status === 'passed') return 'passed' as const;
  if (status === 'running' || status === 'retrying') return 'in_progress' as const;
  if (status === 'failed') return 'blocked' as const;
  if (status === 'skipped') return 'not_applicable' as const;
  return 'not_started' as const;
}

function developmentVerificationStatus(
  status: LifecycleDevelopmentExecution['verification']['unit']['status'],
) {
  if (status === 'passed') return 'passed' as const;
  if (status === 'failed') return 'blocked' as const;
  if (status === 'pending') return 'in_progress' as const;
  return 'not_started' as const;
}

function DevelopmentExecutionOverview({
  execution,
  onOpenRun,
}: {
  execution?: LifecycleDevelopmentExecution;
  onOpenRun?: () => void;
}) {
  if (!execution) {
    return (
      <section className="rounded-md border border-border bg-panel p-4" aria-labelledby="development-execution-heading">
        <h3 id="development-execution-heading" className="text-sm font-semibold text-[var(--text)]">Implementation execution</h3>
        <p className="mt-2 text-sm text-muted">No canonical Development execution snapshot is available.</p>
      </section>
    );
  }
  const run = execution.run;
  const currentStoryId = execution.currentStoryId
    ?? execution.stories.items.find((story) => story.status === 'running' || story.status === 'retrying')?.storyId
    ?? null;
  return (
    <section className="rounded-md border border-border bg-panel" aria-labelledby="development-execution-heading">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <h3 id="development-execution-heading" className="text-sm font-semibold text-[var(--text)]">Implementation execution</h3>
          <p className="mt-1 text-xs text-muted">
            {run ? <>Run <span className="font-mono">{run.id}</span> · {readable(run.agentType)} · Started {timestamp(run.startedAt)}</> : 'No implementation run has started.'}
          </p>
        </div>
        {run && onOpenRun && (
          <button
            type="button"
            onClick={onOpenRun}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-xs font-medium text-[var(--text)] hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open run <ExternalLink size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      <dl className="grid grid-cols-2 divide-x divide-y divide-border border-b border-border sm:grid-cols-4 sm:divide-y-0" aria-label="Development execution status">
        <div className="p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">Stories</dt>
          <dd className="mt-1 text-sm font-semibold text-[var(--text)]">{execution.stories.passed}/{execution.stories.total} passed</dd>
        </div>
        <div className="p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">Current</dt>
          <dd className="mt-1 text-sm font-semibold text-[var(--text)]">{currentStoryId ?? (run?.status === 'running' ? 'Between stories' : 'None')}</dd>
        </div>
        <div className="p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">Integrated</dt>
          <dd className="mt-1 text-sm font-semibold text-[var(--text)]">{execution.integration.finalized}/{execution.integration.expected}</dd>
        </div>
        <div className="p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">Resulting head</dt>
          <dd className="mt-1 text-sm font-semibold text-[var(--text)]">
            {execution.source.resultingHead
              ? <LifecycleHashChip value={execution.source.resultingHead} label="resulting repository head" />
              : 'Pending'}
          </dd>
        </div>
      </dl>
      {(execution.source.branch || execution.source.worktreePath || execution.source.baseCommit) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-border px-4 py-2 text-xs text-muted">
          {execution.source.branch && <span>Branch <strong className="font-mono font-medium text-[var(--text)]">{execution.source.branch}</strong></span>}
          {execution.source.baseCommit && <span>Base <LifecycleHashChip value={execution.source.baseCommit} label="base commit" /></span>}
          {execution.source.worktreePath && <span className="min-w-0 truncate" title={execution.source.worktreePath}>Worktree {execution.source.worktreePath}</span>}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] text-left text-xs">
          <thead className="border-b border-border text-[10px] uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2 font-semibold">Story</th>
              <th className="px-3 py-2 font-semibold">Result</th>
              <th className="px-3 py-2 font-semibold">Attempts</th>
              <th className="px-3 py-2 font-semibold">Commit</th>
              <th className="px-4 py-2 font-semibold">Integration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {execution.stories.items.map((story) => (
              <tr key={story.storyId} className={story.storyId === currentStoryId ? 'bg-accent/5' : undefined}>
                <td className="px-4 py-2.5 font-mono font-semibold text-[var(--text)]">{story.storyId}</td>
                <td className="px-3 py-2.5">
                  <span className="inline-flex items-center gap-1.5">
                    <LifecycleStatusIcon status={developmentStoryStatus(story.status)} size={13} />
                    {readable(story.status)}
                  </span>
                </td>
                <td className="px-3 py-2.5 tabular-nums text-muted">{story.attempts || '—'}</td>
                <td className="px-3 py-2.5">{story.commitSha ? <LifecycleHashChip value={story.commitSha} label={`${story.storyId} commit`} /> : '—'}</td>
                <td className="px-4 py-2.5">
                  <span className={story.failureReason ? 'text-error' : 'text-muted'} title={story.failureReason ?? undefined}>
                    {story.integrationState ? readable(story.integrationState) : 'Pending'}
                  </span>
                </td>
              </tr>
            ))}
            {execution.stories.items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">No frozen implementation stories were found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="grid border-t border-border lg:grid-cols-3 lg:divide-x lg:divide-border">
        <section className="p-4" aria-labelledby="development-changes-heading">
          <div className="flex items-baseline justify-between gap-3">
            <h4 id="development-changes-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Source change set</h4>
            <span className="text-xs tabular-nums text-muted">
              {execution.changes.commits} commits
              {execution.changes.additions !== null && execution.changes.deletions !== null
                ? <> · <span className="text-success">+{execution.changes.additions}</span> / <span className="text-error">−{execution.changes.deletions}</span></>
                : <> · {execution.changes.files.length} files inventoried</>}
            </span>
          </div>
          <ul className="mt-3 space-y-2">
            {execution.changes.files.slice(0, 6).map((file) => (
              <li key={file.path} className="flex min-w-0 items-center gap-2 text-xs">
                <span className="w-14 shrink-0 rounded bg-surface px-1.5 py-0.5 text-center text-[10px] font-semibold uppercase text-muted">{file.change}</span>
                <span className="truncate font-mono text-[var(--text)]" title={file.path}>{file.path}</span>
              </li>
            ))}
            {execution.changes.files.length === 0 && <li className="text-xs text-muted">No changed-file inventory is available yet.</li>}
          </ul>
          {execution.changes.files.length > 6 && (
            <p className="mt-2 text-xs text-muted">+{execution.changes.files.length - 6} more changed files</p>
          )}
        </section>
        <section className="border-t border-border p-4 lg:border-t-0" aria-labelledby="development-verification-heading">
          <h4 id="development-verification-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Development verification</h4>
          <ul className="mt-3 space-y-2">
            {Object.entries(execution.verification).map(([check, result]) => (
              <li key={check} className="flex items-start justify-between gap-3 text-xs">
                <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text)]">
                  <LifecycleStatusIcon status={developmentVerificationStatus(result.status)} size={12} />
                  {readable(check)}
                </span>
                <span className="max-w-[60%] text-right text-muted" title={result.evidence ?? undefined}>
                  {result.evidence ?? readable(result.status)}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="border-t border-border p-4 lg:border-t-0" aria-labelledby="development-integration-heading">
          <h4 id="development-integration-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Repository integration</h4>
          <dl className="mt-3 space-y-2 text-xs">
            <div className="flex justify-between gap-3"><dt className="text-muted">Finalized stories</dt><dd className="font-semibold tabular-nums text-[var(--text)]">{execution.integration.finalized}/{execution.integration.expected}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Conflicts</dt><dd className={execution.integration.conflicted > 0 ? 'font-semibold text-error' : 'font-semibold text-[var(--text)]'}>{execution.integration.conflicted}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Worktree</dt><dd className="font-semibold text-[var(--text)]">{execution.source.dirty === null ? 'Not reported' : execution.source.dirty ? 'Uncommitted changes' : 'Clean'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted">Integrated head</dt><dd>{execution.integration.resultingHead ? <LifecycleHashChip value={execution.integration.resultingHead} label="integrated repository head" /> : 'Pending'}</dd></div>
          </dl>
        </section>
      </div>
    </section>
  );
}

/** Requirement/decision/story references become labeled chips; full refs stay out of visible text. */
function RefChip({ reference, onOpenTraceability }: { reference: string; onOpenTraceability?: (reference: string) => void }) {
  const display = reference
    .replace(/:sha256:[a-f0-9]{64}/g, '')
    .replace(/sha256:([a-f0-9]{64})/g, (_match, hash: string) => `${hash.slice(0, 10)}…`);
  if (!onOpenTraceability) return <span className="lifecycle-ref-chip">{display}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpenTraceability(reference)}
      className="lifecycle-ref-chip lifecycle-ref-chip--link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-label={`Open traceability for ${display}`}
    >{display}</button>
  );
}

function BoundedMapping({ label, value, onOpenTraceability }: { label: string; value: LifecycleBounded<string>; onOpenTraceability?: (reference: string) => void }) {
  return (
    <div className="border-b border-border py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold text-muted">{label}</h4>
        <span className="text-xs tabular-nums text-muted">{value.total}</span>
      </div>
      {value.items.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {value.items.map((item) => (
            <li key={item}><RefChip reference={item} onOpenTraceability={onOpenTraceability} /></li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">No {label.toLowerCase()} are mapped to this phase.</p>
      )}
      {value.truncated && <p className="mt-2 text-xs text-warning">Showing {value.items.length} of {value.total} mapped records.</p>}
    </div>
  );
}

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return <h3 id={id} className="lifecycle-phase-view__heading">{children}</h3>;
}

type PhaseInspectorSection =
  | 'gates'
  | 'evidence'
  | 'traceability'
  | 'decisions'
  | 'mappings'
  | 'liveness'
  | 'context'
  | 'advisory'
  | 'closeout';

function OverviewPanel({
  id,
  active,
  children,
  testId,
}: {
  id: PhaseInspectorSection;
  active: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section
      id={`phase-inspector-${id}`}
      role="tabpanel"
      aria-labelledby={`phase-inspector-tab-${id}`}
      hidden={!active}
      data-testid={testId}
      className="lifecycle-overview-inspector__panel"
      tabIndex={0}
    >
      {children}
    </section>
  );
}


function SectionNav({
  phaseId,
  view,
  onChange,
}: {
  phaseId: LifecyclePhaseId;
  view: LifecycleSourceView;
  onChange: (view: LifecycleSourceView) => void;
}) {
  const synthesisContext = phaseId === 'planning'
    ? 'Intent & sequence'
    : phaseId === 'requirements'
      ? 'Behavior & acceptance'
      : phaseId === 'design'
        ? 'Architecture & boundaries'
        : 'Source-backed view';
  const options: Array<{ id: LifecycleSourceView; label: string; context: string }> = [
    { id: 'overview', label: 'Overview', context: 'Readiness & gates' },
    { id: 'synthesis', label: 'Synthesis', context: synthesisContext },
    { id: 'sources', label: 'Sources', context: 'Package files' },
  ];
  const tabRefs = useRef(new Map<LifecycleSourceView, HTMLButtonElement>());
  const panelId = `lifecycle-${phaseId}-detail-panel`;
  const moveFocus = (currentView: LifecycleSourceView, key: string) => {
    const currentIndex = options.findIndex((option) => option.id === currentView);
    let nextIndex = currentIndex;
    if (key === 'ArrowRight' || key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length;
    else if (key === 'ArrowLeft' || key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length;
    else if (key === 'Home') nextIndex = 0;
    else if (key === 'End') nextIndex = options.length - 1;
    else return false;
    const next = options[nextIndex];
    if (!next) return false;
    onChange(next.id);
    tabRefs.current.get(next.id)?.focus();
    return true;
  };
  return (
    <div className="lifecycle-section-nav" role="tablist" aria-label="Phase detail view">
      {options.map((option) => (
        <button
          key={option.id}
          ref={(node) => {
            if (node) tabRefs.current.set(option.id, node);
            else tabRefs.current.delete(option.id);
          }}
          type="button"
          role="tab"
          id={`lifecycle-${phaseId}-${option.id}-tab`}
          aria-controls={panelId}
          onClick={() => onChange(option.id)}
          onKeyDown={(event) => {
            if (moveFocus(option.id, event.key)) event.preventDefault();
          }}
          aria-selected={view === option.id}
          tabIndex={view === option.id ? 0 : -1}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span>{option.label}</span>
          <span className="lifecycle-section-nav__context" aria-hidden="true">{option.context}</span>
        </button>
      ))}
    </div>
  );
}

/** One requirement cell from the canon receipt, rendered with its citations. */
function CoverageCellRow({ cell }: { cell: SpecCoverageCell }) {
  return (
    <li className="lifecycle-phase-view__row">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-[var(--text)]">{cell.requirementId}</span>
          {cell.resolution && <span className="lifecycle-chip">{readable(cell.resolution)}</span>}
          {cell.disposition && <span className="lifecycle-chip">{cell.disposition}</span>}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>{cell.overlayId}</span>
          {cell.operation && <><span aria-hidden="true">·</span><span>{readable(cell.operation)}</span></>}
          {(cell.gaps?.length ?? 0) > 0 && <><span aria-hidden="true">·</span><span>Gaps: {cell.gaps?.map(readable).join(' · ')}</span></>}
        </span>
      </span>
    </li>
  );
}

function AdvisorySection({
  advice,
  loading,
  error,
  onRequest,
}: {
  advice: LifecycleAdviceResponse | null;
  loading: boolean;
  error: string | null;
  onRequest?: () => void;
}) {
  const requestButton = (
    <button
      type="button"
      onClick={onRequest}
      disabled={loading || !onRequest}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border bg-panel px-3 text-xs font-medium text-[var(--text)] hover:bg-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
    >
      {loading ? 'Asking the phase advisor…' : advice ? 'Ask again' : 'Ask the phase advisor'}
    </button>
  );
  return (
    <section aria-labelledby="phase-advice-heading" data-testid="lifecycle-phase-advice">
      <SectionHeading id="phase-advice-heading">What's missing</SectionHeading>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="lifecycle-chip">Advisory</span>
          <span className="text-xs text-muted">
            Model-generated suggestions are never recorded as lifecycle evidence and never satisfy gates.
          </span>
        </div>
        {loading && !advice && (
          <p className="text-sm text-muted" role="status">Asking the phase advisor…</p>
        )}
        {error && (
          <div className="rounded-md border border-error/30 bg-error/10 p-3" role="alert">
            <p className="text-sm text-[var(--text)]"><ProseWithHashes text={error} /></p>
          </div>
        )}
        {advice && !loading && (
          <ul className="lifecycle-phase-view__list" aria-label="Advisory suggestions">
            {advice.suggestions.map((suggestion, index) => (
              <li key={`${suggestion.text.slice(0, 40)}-${index}`} className="lifecycle-phase-view__row">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-[var(--text)]"><ProseWithHashes text={suggestion.text} /></span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    Cited:
                    {suggestion.cites.map((cite) => <RefChip key={cite} reference={cite} />)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {advice && advice.suggestions.length === 0 && !loading && (
          <p className="text-sm text-muted">The advisor found no gaps to suggest for this phase.</p>
        )}
        {onRequest && !loading && requestButton}
      </div>
    </section>
  );
}

/** Coverage body: required/covered/missing cells, next actions, Genesis bindings. */
function PhaseCoverageSection({ coverage, phaseId }: { coverage: SpecCoverageByPhase; phaseId: LifecyclePhaseId }) {
  if (coverage.adapterStatus !== 'available') {
    return (
      <div className="lifecycle-empty-hint" role="status">
        <p className="text-sm font-medium text-[var(--text)]">Coverage unavailable</p>
        <p className="mt-1 text-xs text-muted">
          {coverage.message ?? 'The engineering canon adapter did not report coverage for this spec.'}
        </p>
      </div>
    );
  }
  const entry = coverage.phases[phaseId];
  if (!entry) {
    return (
      <div className="lifecycle-empty-hint" role="status">
        <p className="text-sm font-medium text-[var(--text)]">Coverage unavailable</p>
        <p className="mt-1 text-xs text-muted">No canon coverage was reported for this phase.</p>
      </div>
    );
  }
  const required = entry.required;
  const covered = entry.covered;
  const missing = entry.missingSkills;
  const actions = entry.nextActions;
  const genesis = entry.genesisPackageIds;
  const cellKey = (cell: SpecCoverageCell) => `${cell.overlayId}:${cell.requirementId}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="lifecycle-chip tabular-nums">{required.length} required</span>
        <span className="lifecycle-chip tabular-nums">{covered.length} covered</span>
        <span className="lifecycle-chip tabular-nums">{missing.length} missing skills</span>
        {!entry.inScope && <span className="lifecycle-chip">Outside declared canon scope</span>}
      </div>
      <div>
        <h4 className="text-xs font-semibold text-muted">What this phase requires</h4>
        {required.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No uncovered requirement cells are attributed to this phase.</p>
        ) : (
          <ul className="lifecycle-phase-view__list" aria-label="Required coverage cells">
            {required.map((cell) => <CoverageCellRow key={cellKey(cell)} cell={cell} />)}
          </ul>
        )}
      </div>
      <div>
        <h4 className="text-xs font-semibold text-muted">Covered by the canon receipt</h4>
        {covered.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No covered requirement cells are attributed to this phase.</p>
        ) : (
          <ul className="lifecycle-phase-view__list" aria-label="Covered coverage cells">
            {covered.map((cell) => <CoverageCellRow key={cellKey(cell)} cell={cell} />)}
          </ul>
        )}
      </div>
      <div>
        <h4 className="text-xs font-semibold text-muted">Missing skills</h4>
        {missing.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No missing-skill gaps are attributed to this phase.</p>
        ) : (
          <ul className="lifecycle-phase-view__list" aria-label="Missing skills with citations">
            {missing.map((cell) => <CoverageCellRow key={cellKey(cell)} cell={cell} />)}
          </ul>
        )}
      </div>
      {actions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-muted">Next actions</h4>
          <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Coverage next actions">
            {actions.map((action) => <li key={action.code} className="lifecycle-chip">{action.label}</li>)}
          </ul>
        </div>
      )}
      <div>
        <h4 className="text-xs font-semibold text-muted">Bound Genesis packages</h4>
        {genesis.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No approved Genesis package bindings participate in this coverage.</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Bound Genesis packages">
            {genesis.map((packageId) => <li key={packageId} className="lifecycle-ref-chip" title={packageId}>{packageId}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function LifecyclePhaseView({
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
  onSelectPhase,
  selectedPhaseId,
  phasePending = false,
  onAction,
  actionPending = null,
  coverage,
  coverageLoading = false,
  advice = null,
  adviceLoading = false,
  adviceError = null,
  onRequestAdvice,
  onOpenSourceArtifact,
  sourceArtifactError = null,
  onDismissSourceArtifactError,
  sourceArtifactPending = null,
  onReadSourceArtifact,
}: LifecyclePhaseViewProps) {
  const gates = phase.requiredGates.items;
  const passedGates = gates.filter((gate) => gate.evaluation?.status === 'passed').length;
  const requiredGateCount = phase.requiredGates.total;
  const ownStatus = phase.ownStatus ?? phase.status;
  const activityStatus = phase.activityStatus ?? phase.status;
  const readinessOwner = spec ?? portfolioItem;
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
  const specTitle = portfolioItem?.title ?? spec?.title ?? phase.specId;
  const mappedItemCount = phase.mappedRequirements.total + phase.mappedDecisions.total + phase.mappedStories.total;
  const traceChainCount = spec?.traceability?.endToEnd?.total ?? spec?.traceability?.requirements.total ?? 0;
  const developmentRunProgress = phase.phaseId !== 'development'
    ? null
    : phase.developmentExecution?.run
      ? {
          runId: phase.developmentExecution.run.id,
          passed: phase.developmentExecution.stories.passed,
          total: phase.developmentExecution.stories.total,
        }
      : spec?.currentRun || portfolioItem
        ? {
            runId: spec?.currentRun?.id ?? portfolioItem?.readiness?.execution.runId ?? null,
            passed: spec?.currentRun?.stories.passed ?? portfolioItem?.storySummary.passed ?? 0,
            total: portfolioItem?.storySummary.total
              ?? spec?.traceability.stories.total
              ?? spec?.currentRun?.stories.total
              ?? 0,
          }
        : null;
  const attentionTraceChainCount = spec?.traceability?.endToEnd?.items.filter(
    (chain) => chain.status !== 'passed' && chain.status !== 'not_applicable',
  ).length ?? 0;
  const evidenceTriggerRef = useRef<HTMLElement | null>(null);
  const traceabilityViewRef = useRef<HTMLElement | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const stageButtonRefs = useRef(new Map<LifecycleMissionStage, HTMLButtonElement>());
  const displayedPhaseId = selectedPhaseId ?? phase.phaseId;
  const sourceViewKey = `rorca:lifecycle-source-view:v1:${phase.workspaceId}:${phase.specId}:${displayedPhaseId}`;
  const initialSourceView = useMemo<LifecycleSourceView>(() => {
    const deepLinked = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('sourceView')
      : null;
    if (deepLinked === 'overview' || deepLinked === 'synthesis' || deepLinked === 'sources') return deepLinked;
    let stored: string | null = null;
    try {
      stored = typeof window !== 'undefined' ? localStorage.getItem(sourceViewKey) : null;
    } catch {
      // Browser storage is an optional UX enhancement.
    }
    return stored === 'overview' || stored === 'synthesis' || stored === 'sources' ? stored : 'overview';
  }, [sourceViewKey]);
  const [sourceView, setSourceView] = useState<LifecycleSourceView>(() => initialSourceView);
  const defaultInspectorSection: PhaseInspectorSection = phase.blocker || phase.phaseId === 'development'
    ? 'gates'
    : attentionTraceChainCount > 0
      ? 'traceability'
      : 'gates';
  const [inspectorSection, setInspectorSection] = useState<PhaseInspectorSection>(
    selectedEvidenceId ? 'evidence' : defaultInspectorSection,
  );
  const inspectorTabs: Array<{ id: PhaseInspectorSection; label: string; meta: string }> = [
    { id: 'gates', label: 'Gates', meta: `${passedGates}/${requiredGateCount}` },
    { id: 'evidence', label: 'Evidence', meta: String(phase.evidence.total) },
    ...(spec?.traceability ? [{
      id: 'traceability' as const,
      label: 'Traceability',
      meta: attentionTraceChainCount > 0 ? `${attentionTraceChainCount} attention` : `${traceChainCount} chains`,
    }] : []),
    { id: 'decisions', label: 'Decisions', meta: String(phase.governedDecisions.total) },
    { id: 'mappings', label: 'Mappings', meta: String(mappedItemCount) },
    { id: 'liveness', label: 'Run', meta: liveness ? readable(liveness.state) : 'none' },
    { id: 'context', label: 'Context', meta: phase.sourceMaterial ? 'source' : 'rationale' },
    ...((onRequestAdvice || advice || adviceLoading || adviceError) ? [{
      id: 'advisory' as const,
      label: 'Advisory',
      meta: advice ? 'ready' : 'optional',
    }] : []),
    ...(phase.phaseId === 'maintenance' ? [{
      id: 'closeout' as const,
      label: 'Closeout',
      meta: phase.learn ? `${phase.learn.candidateCount}/${phase.learn.requiredCandidateCount}` : 'pending',
    }] : []),
  ];
  const inspectorTabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeStageId = lifecycleStageOf(displayedPhaseId);
  const stageCells = portfolioItem ? aggregateStageCells(portfolioItem) : [];
  const stageCellById = new Map(stageCells.map((cell) => [cell.stageId, cell]));
  const [rovingStageId, setRovingStageId] = useState<LifecycleMissionStage>(activeStageId);
  useEffect(() => {
    backRef.current?.focus();
  }, []);
  useEffect(() => {
    setRovingStageId(activeStageId);
  }, [activeStageId]);
  const inspectorPhaseRef = useRef(displayedPhaseId);
  useEffect(() => {
    if (inspectorPhaseRef.current !== displayedPhaseId) {
      inspectorPhaseRef.current = displayedPhaseId;
      setInspectorSection(selectedEvidenceId ? 'evidence' : defaultInspectorSection);
    } else if (selectedEvidenceId) {
      setInspectorSection('evidence');
    }
  }, [defaultInspectorSection, displayedPhaseId, selectedEvidenceId]);
  useEffect(() => {
    try {
      localStorage.setItem(sourceViewKey, sourceView);
    } catch {
      // Remembering the presentation view is optional.
    }
    if (typeof window !== 'undefined' && typeof window.history?.replaceState === 'function') {
      const current = new URLSearchParams(window.location.search);
      current.set('sourceView', sourceView);
      const search = current.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`);
    }
  }, [sourceView, sourceViewKey]);
  const handleInspectorTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % inspectorTabs.length;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + inspectorTabs.length) % inspectorTabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = inspectorTabs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    setInspectorSection(inspectorTabs[nextIndex].id);
    inspectorTabRefs.current[nextIndex]?.focus();
  };
  const openEvidence = (evidenceId: string, trigger?: HTMLElement) => {
    evidenceTriggerRef.current = trigger ?? null;
    setInspectorSection('evidence');
    onOpenEvidence(evidenceId);
  };
  const closeEvidence = () => {
    onCloseEvidence();
    queueMicrotask(() => evidenceTriggerRef.current?.focus());
  };
  const openTraceability = () => {
    setInspectorSection('traceability');
    queueMicrotask(() => traceabilityViewRef.current?.focus());
  };

  const selectStage = (stageId: LifecycleMissionStage) => {
    const stageCell = stageCellById.get(stageId);
    onSelectPhase(stageCell ? stageLeadPhase(stageCell) : stageId);
  };

  const moveStageFocus = (currentStageId: LifecycleMissionStage, key: string) => {
    const currentIndex = LIFECYCLE_STAGE_IDS.indexOf(currentStageId);
    let nextIndex = currentIndex;
    if (key === 'ArrowRight' || key === 'ArrowDown') nextIndex = (currentIndex + 1) % LIFECYCLE_STAGE_IDS.length;
    else if (key === 'ArrowLeft' || key === 'ArrowUp') nextIndex = (currentIndex - 1 + LIFECYCLE_STAGE_IDS.length) % LIFECYCLE_STAGE_IDS.length;
    else if (key === 'Home') nextIndex = 0;
    else if (key === 'End') nextIndex = LIFECYCLE_STAGE_IDS.length - 1;
    else return false;
    const nextStageId = LIFECYCLE_STAGE_IDS[nextIndex];
    if (!nextStageId) return false;
    setRovingStageId(nextStageId);
    stageButtonRefs.current.get(nextStageId)?.focus();
    return true;
  };

  return (
    <div className="lifecycle-phase-view" data-testid="lifecycle-phase-view">
      <header className="lifecycle-phase-view__header">
        <h2 className="sr-only">{readable(displayedPhaseId)} phase</h2>
        <div className="lifecycle-phase-command">
          <div className="flex min-w-0 items-center gap-3">
            <button
              ref={backRef}
              type="button"
              onClick={onClose}
              aria-label="Back to board"
              className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 text-xs font-medium text-muted hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back
            </button>
            <div className="min-w-0">
              <nav className="lifecycle-phase-view__breadcrumb" aria-label="Breadcrumb">
                <span>Lifecycle</span>
                <ChevronRight size={12} aria-hidden="true" />
                <span className="max-w-[16rem] truncate" title={specTitle}>{specTitle}</span>
                <ChevronRight size={12} aria-hidden="true" />
                <span aria-current="page" className="font-semibold text-[var(--text)]">{readable(displayedPhaseId)}</span>
              </nav>
              <p className="lifecycle-phase-view__mobile-title" title={`${specTitle} · ${readable(displayedPhaseId)}`}>
                <span className="truncate">{specTitle}</span>
                <span aria-hidden="true">·</span>
                <span className="shrink-0 font-semibold text-[var(--text)]">{readable(displayedPhaseId)}</span>
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Phase gate and dependency status">
                  <LifecycleStatusBadge
                    status={phase.phaseId === 'development' ? activityStatus : ownStatus}
                    label={phase.phaseId === 'development'
                      ? `Phase ${readable(activityStatus)}`
                      : `Own gates ${readable(ownStatus)}`}
                  />
                  <LifecycleDependencyBadge status={phase.dependencyStatus} />
                </span>
                <span className="lifecycle-chip tabular-nums">{passedGates}/{requiredGateCount} gates</span>
                {phase.phaseId !== 'development' && <LifecycleLivenessBadge liveness={liveness} />}
              </div>
              {readinessOwner && (
                <div className="mt-1.5">
                  <LifecycleReadinessStates
                    readiness={spec?.readiness ?? portfolioItem?.readiness}
                    assurance={readinessOwner.assurance}
                    delivery={readinessOwner.delivery}
                    storyProgress={developmentRunProgress ?? undefined}
                  />
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {actions.length > 1 && (
              <details className="lifecycle-source-menu">
                <summary role="button" aria-label="More phase actions"><MoreHorizontal size={17} aria-hidden="true" /></summary>
                <div>
                  {actions.slice(1).map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      disabled={actionPending !== null}
                      onClick={() => onAction(action.id)}
                      className="lifecycle-source-action"
                    >{actionPending === action.id ? 'Working…' : action.label}</button>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
        <div className="lifecycle-phase-switcher" role="group" aria-label="Switch lifecycle stage">
          {LIFECYCLE_STAGE_IDS.map((stageId) => {
            const stageCell = stageCellById.get(stageId);
            return (
              <button
                key={stageId}
                ref={(node) => {
                  if (node) stageButtonRefs.current.set(stageId, node);
                  else stageButtonRefs.current.delete(stageId);
                }}
                type="button"
                tabIndex={stageId === rovingStageId ? 0 : -1}
                aria-pressed={stageId === activeStageId}
                onFocus={() => setRovingStageId(stageId)}
                onKeyDown={(event) => {
                  if (moveStageFocus(stageId, event.key)) event.preventDefault();
                }}
                onClick={() => selectStage(stageId)}
                className="lifecycle-phase-switcher__item focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <LifecycleStatusIcon status={stageCell?.status ?? 'not_started'} size={12} />
                <span>{stageDisplayName(stageId)}</span>
              </button>
            );
          })}
        </div>
        <details className="lifecycle-phase-context">
          <summary><Command size={13} aria-hidden="true" /> Activity and revision</summary>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
            <Clock3 size={12} aria-hidden="true" /> Last activity: {timestamp(lastActivity)}
            <span>· Revision: {revision ? `Spec ${revision.specVersion ?? 'unknown'} · Plan ${revision.planVersion}` : 'Unknown'}</span>
            {revision?.inputHash && <LifecycleHashChip value={revision.inputHash} label="revision hash" />}
          </p>
        </details>
        <SectionNav phaseId={displayedPhaseId} view={sourceView} onChange={setSourceView} />
      </header>

      <div
        id={`lifecycle-${displayedPhaseId}-detail-panel`}
        role="tabpanel"
        aria-labelledby={`lifecycle-${displayedPhaseId}-${sourceView}-tab`}
        tabIndex={0}
        className="lifecycle-phase-view__body"
        aria-busy={phasePending}
        data-loading={phasePending ? 'true' : 'false'}
      >
        {phasePending && (
          <div className="lifecycle-empty-hint" role="status">
            Loading {readable(displayedPhaseId)} phase evidence… Previous phase details remain visible.
          </div>
        )}
        {sourceView === 'overview' && (
          <>
            <section className="lifecycle-guidance" aria-labelledby="phase-guidance-heading" data-tone={phase.blocker ? 'blocked' : 'accent'}>
              <h3 id="phase-guidance-heading" className="lifecycle-phase-view__heading">{phase.blocker ? 'What is blocking this phase' : 'Recommended next step'}</h3>
              {phase.blocker && (
                <p className="text-sm font-medium text-error"><ProseWithHashes text={phase.blocker.reason} /></p>
              )}
              {guidance ? (
                <div className={phase.blocker ? 'mt-3' : ''}>
                  <p className="text-sm font-semibold text-[var(--text)]"><ProseWithHashes text={guidance.action} /></p>
                  <p className="mt-1 text-sm text-muted"><ProseWithHashes text={guidance.rationale} /></p>
                  <p className="mt-2"><span className="lifecycle-chip">{readable(guidance.classifier)} · {Math.round(guidance.confidence * 100)}% confidence</span></p>
                </div>
              ) : (
                <p className="mt-1 text-sm text-warning">Classifier guidance is unavailable for this snapshot. No client-inferred action is shown.</p>
              )}
            </section>

            {phase.phaseId === 'development' ? (
              <DevelopmentExecutionOverview
                execution={phase.developmentExecution}
                onOpenRun={phase.developmentExecution?.run && permitted.has('run_phase')
                  ? () => onAction('run_phase')
                  : undefined}
              />
            ) : (
              <>
                <dl className="lifecycle-phase-overview-stats" aria-label="Phase status at a glance">
                  <div>
                    <dt>Gates</dt>
                    <dd>{passedGates}/{requiredGateCount} passed</dd>
                  </div>
                  <div>
                    <dt>Evidence</dt>
                    <dd>{phase.evidence.total} {phase.evidence.total === 1 ? 'record' : 'records'}</dd>
                  </div>
                  <div>
                    <dt>Decisions</dt>
                    <dd>{phase.governedDecisions.total} recorded</dd>
                  </div>
                  <div>
                    <dt>Trace chains</dt>
                    <dd>{traceChainCount}</dd>
                  </div>
                </dl>
                <ExportKitSummary workspaceId={phase.workspaceId} specId={phase.specId} />
              </>
            )}
          </>
        )}

        {sourceView !== 'overview' && (
          <>
            {phase.phaseId === 'development' && sourceView === 'sources' && (
              <ExportKitSummary workspaceId={phase.workspaceId} specId={phase.specId} />
            )}
            {phase.sourceMaterial && (
              <LifecycleSourceWorkspace
                source={phase.sourceMaterial}
                view={sourceView}
                workspaceId={phase.workspaceId}
                specId={phase.specId}
                pending={sourceArtifactPending}
                onOpen={onOpenSourceArtifact}
                actionError={sourceArtifactError}
                onDismissActionError={onDismissSourceArtifactError}
                onRead={onReadSourceArtifact}
              />
            )}
          </>
        )}

        {sourceView === 'overview' && (
          <div className="lifecycle-overview-inspector">
            <div className="lifecycle-overview-inspector__tabs" role="tablist" aria-label="Inspect phase data">
              {inspectorTabs.map((tab, index) => (
                <button
                  key={tab.id}
                  id={`phase-inspector-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={inspectorSection === tab.id}
                  ref={(node) => { inspectorTabRefs.current[index] = node; }}
                  tabIndex={inspectorSection === tab.id ? 0 : -1}
                  onKeyDown={(event) => handleInspectorTabKeyDown(event, index)}
                  aria-controls={`phase-inspector-${tab.id}`}
                  onClick={() => setInspectorSection(tab.id)}
                  className="lifecycle-overview-inspector__tab"
                >
                  <span>{tab.label}</span>
                  <span>{tab.meta}</span>
                </button>
              ))}
            </div>
            <div className="lifecycle-overview-inspector__body">
            <OverviewPanel
              id="context"
              active={inspectorSection === 'context'}
              testId="phase-overview-context"
            >
              {phase.sourceMaterial && (
                <LifecycleSourceWorkspace
                  source={phase.sourceMaterial}
                  view="overview"
                  workspaceId={phase.workspaceId}
                  specId={phase.specId}
                  pending={sourceArtifactPending}
                  onOpen={onOpenSourceArtifact}
                  actionError={sourceArtifactError}
                  onDismissActionError={onDismissSourceArtifactError}
                  onRead={onReadSourceArtifact}
                />
              )}
              <section aria-labelledby="phase-why-heading">
                <SectionHeading id="phase-why-heading">Why this phase is in its current state</SectionHeading>
                <p className="text-sm leading-6 text-[var(--text)]"><ProseWithHashes text={phase.whyRequired ?? 'No requirement rationale was supplied.'} /></p>
              </section>
            </OverviewPanel>
            <OverviewPanel
              id="gates"
              active={inspectorSection === 'gates'}
              testId="phase-overview-gates"
            >
              <section aria-labelledby="phase-gates-heading">
          <SectionHeading id="phase-gates-heading">Required gates</SectionHeading>
          <div className="lifecycle-phase-view__list">
            {gates.length === 0 && <p className="py-3 text-sm text-muted">No gates are required for this phase.</p>}
            {gates.map((gate) => {
              const supportingEvidence = phase.evidence.items.find((item) => item.gateId === gate.gateId);
              const status = gate.evaluation?.status;
              const decisionCount = gate.evaluation?.decisionCount ?? 0;
              const isDecisionBacked = !supportingEvidence && decisionCount > 0;
              const unavailableGuidance = isDecisionBacked
                ? `No separate evidence record is attached; this gate is satisfied by the recorded ${decisionCount === 1 ? 'decision' : 'decisions'}.`
                : phase.evidence.total === 0
                  ? `No evidence yet for this gate — collect ${readable(gate.evidenceKind)} evidence bound to the current revision.`
                  : `Supporting evidence is not shown on this page. ${phase.evidence.total} evidence records exist for this phase.`;
              const content = (
                <>
                  <LifecycleStatusIcon status={status ?? 'not_started'} size={15} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-[var(--text)]">{gate.title}</span>
                    {isDecisionBacked ? (
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <span>Decision-backed evaluation</span>
                        <span aria-hidden="true">·</span>
                        <span>{decisionCount} recorded {decisionCount === 1 ? 'decision' : 'decisions'}</span>
                      </span>
                    ) : (
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <span>{status ? readable(status) : 'Evaluation unknown'}</span>
                        <span aria-hidden="true">·</span>
                        <span>Source: {supportingEvidence?.sourceSystem || 'Unknown'}</span>
                        <span aria-hidden="true">·</span>
                        {timestamp(supportingEvidence?.observedAt)}
                        <span aria-hidden="true">·</span>
                        <span>{revisionLabel(supportingEvidence)}</span>
                      </span>
                    )}
                    {!supportingEvidence && <span className={`mt-1 block text-xs ${isDecisionBacked ? 'text-muted' : 'text-warning'}`}>{unavailableGuidance}</span>}
                  </span>
                  {supportingEvidence && <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />}
                </>
              );
              return supportingEvidence ? (
                <button
                  key={gate.gateId}
                  type="button"
                  onClick={(event) => openEvidence(supportingEvidence.id, event.currentTarget)}
                  className="lifecycle-phase-view__row hover:bg-surface-200/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                  aria-label={`${gate.title}. ${status ? readable(status) : 'Evaluation unknown'}. Open supporting evidence`}
                >
                  {content}
                </button>
              ) : (
                <article
                  key={gate.gateId}
                  className="lifecycle-phase-view__row"
                  aria-label={`${gate.title}. ${status ? readable(status) : 'Evaluation unknown'}. ${unavailableGuidance}`}
                >
                  {content}
                </article>
              );
            })}
          </div>
          {phase.requiredGates.truncated && <p className="mt-2 text-xs text-warning">Showing {gates.length} of {phase.requiredGates.total} gates.</p>}
              </section>
            </OverviewPanel>
            <OverviewPanel
              id="evidence"
              active={inspectorSection === 'evidence'}
              testId="phase-overview-evidence"
            >
              <section aria-labelledby="phase-evidence-heading">
          <SectionHeading id="phase-evidence-heading">Evidence</SectionHeading>
          {phase.evidence.items.length === 0 ? (
            <div className="lifecycle-empty-hint" role="status">
              <p className="text-sm font-medium text-[var(--text)]">No standalone evidence records</p>
              <p className="mt-1 text-xs text-muted">
                {phase.governedDecisions.items.length > 0
                  ? 'Recorded decisions for this phase are shown below. Evidence records appear here when a run reports them, pinned to the snapshot you are viewing.'
                  : 'Evidence records appear here when a run reports them, and every record stays pinned to the snapshot you are viewing.'}
              </p>
            </div>
          ) : (
            <div className="lifecycle-phase-view__list">
              {phase.evidence.items.map((item) => (
                <div
                  key={item.id}
                  className="lifecycle-phase-view__row hover:bg-surface-200/50"
                >
                  <span className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={(event) => openEvidence(item.id, event.currentTarget)}
                      aria-expanded={selectedEvidenceId === item.id}
                      className="block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                    >
                      <span className="block text-sm font-medium text-[var(--text)]">{item.evidenceType || 'Unknown evidence type'}</span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <span>{readable(item.status)}</span>
                        <span aria-hidden="true">·</span>
                        <span>Source: {item.sourceSystem || 'Unknown'}</span>
                        <span aria-hidden="true">·</span>
                        {timestamp(item.observedAt)}
                        <span aria-hidden="true">·</span>
                        <span>{revisionLabel(item)}</span>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        <span className="lifecycle-chip">{readable(item.trustLevel)} · {Math.round(item.confidence * 100)}% confidence</span>
                      </span>
                    </button>
                    {item.invalidReasons.length > 0 && (
                      <span className="mt-1 block text-xs text-warning">
                        Excluded: <ProseWithHashes text={item.invalidReasons.map(readable).join(' · ')} />
                      </span>
                    )}
                  </span>
                  <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                </div>
              ))}
            </div>
          )}
          {(phase.evidence.hasMore || phase.evidence.items.length < phase.evidence.total) && phase.evidence.items.length > 0 && (
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
            </OverviewPanel>
            <OverviewPanel
              id="decisions"
              active={inspectorSection === 'decisions'}
              testId="phase-overview-decisions"
            >
              <section aria-labelledby="phase-decisions-heading">
          <SectionHeading id="phase-decisions-heading">Decisions</SectionHeading>
          {phase.governedDecisions.items.length === 0 ? (
            <div className="lifecycle-empty-hint">
              <p className="text-sm text-muted">No governed decisions are recorded for this phase. Approvals and overrides appear here once a reviewer records them.</p>
            </div>
          ) : (
            <ul className="lifecycle-phase-view__list" aria-label="Governed decisions">
              {phase.governedDecisions.items.map((decision) => {
                const activity = decisionActivity(decision);
                return (
                  <li key={decision.id} className="lifecycle-phase-view__row">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium text-[var(--text)]">{DECISION_TYPE_LABELS[decision.decisionType]}</span>
                        <span className="lifecycle-badge" data-tone={activity.tone}>{activity.label}</span>
                      </span>
                      <span className="mt-1 block text-sm text-muted"><ProseWithHashes text={decision.rationale} /></span>
                      {decision.evidenceGap && <span className="mt-1 block text-xs text-muted">Evidence gap: <ProseWithHashes text={decision.evidenceGap} /></span>}
                      <span className="mt-1 block text-xs text-muted">
                        {decision.actor.label} · recorded {timestamp(decision.createdAt)}
                        {decision.expiresAt && <> · expires {timestamp(decision.expiresAt)}</>}
                        {decision.revokedAt && <> · revoked {timestamp(decision.revokedAt)}</>}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
              </section>
            </OverviewPanel>
            <OverviewPanel
              id="mappings"
              active={inspectorSection === 'mappings'}
              testId="phase-overview-mappings"
            >
              <section aria-labelledby="phase-mapping-heading">
          <SectionHeading id="phase-mapping-heading">Mapped to this phase</SectionHeading>
          <p className="mb-2 text-xs text-muted">
            Items mapped directly to this phase. Plan-level mappings for the whole spec live in the traceability section below.
          </p>
          <div className="lifecycle-phase-view__list">
            <BoundedMapping label="Requirements" value={phase.mappedRequirements} onOpenTraceability={openTraceability} />
            <BoundedMapping label="Decisions" value={phase.mappedDecisions} onOpenTraceability={openTraceability} />
            <BoundedMapping label="Stories" value={phase.mappedStories} onOpenTraceability={openTraceability} />
          </div>
        </section>

        {(coverage || coverageLoading) && (
          <section aria-labelledby="phase-coverage-heading" data-testid="lifecycle-phase-coverage">
            <SectionHeading id="phase-coverage-heading">Engineering canon coverage</SectionHeading>
            {coverageLoading && !coverage ? (
              <div className="lifecycle-empty-hint" role="status">
                <p className="text-sm text-muted">Loading canon coverage…</p>
              </div>
            ) : coverage ? (
              <PhaseCoverageSection coverage={coverage} phaseId={displayedPhaseId} />
            ) : null}
          </section>
        )}
            </OverviewPanel>

        {(onRequestAdvice || advice || adviceLoading || adviceError) && (
          <OverviewPanel
            id="advisory"
            active={inspectorSection === 'advisory'}
            testId="phase-overview-advisory"
          >
          <AdvisorySection
            advice={advice}
            loading={adviceLoading}
            error={adviceError}
            onRequest={onRequestAdvice}
          />
          </OverviewPanel>
        )}

        {spec?.traceability && (
          <OverviewPanel
            id="traceability"
            active={inspectorSection === 'traceability'}
            testId="phase-overview-traceability"
          >
            <section ref={traceabilityViewRef} tabIndex={-1} aria-labelledby="phase-traceability-heading" className="focus:outline-none">
            <SectionHeading id="phase-traceability-heading">Requirement traceability</SectionHeading>
            <LifecycleTraceability traceability={spec.traceability} snapshotId={phase.snapshotId} onOpenEvidence={openEvidence} />
            </section>
          </OverviewPanel>
        )}

        <OverviewPanel
          id="liveness"
          active={inspectorSection === 'liveness'}
          testId="phase-overview-liveness"
        >
          <section aria-labelledby="phase-liveness-heading">
          <SectionHeading id="phase-liveness-heading">Run liveness</SectionHeading>
          {liveness ? (
            <div className="text-sm text-[var(--text)]">
              <p className="flex flex-wrap items-center gap-2">
                <LifecycleLivenessBadge liveness={liveness} />
                <span className="lifecycle-chip">{Math.round(liveness.confidence * 100)}% confidence</span>
              </p>
              <p className="mt-1 text-xs text-muted">Last meaningful activity: {timestamp(liveness.lastMeaningfulActivity)}</p>
              {liveness.blocker && (
                <p className="mt-2 rounded-md border border-error/30 bg-error/10 p-2 text-xs text-[var(--text)]">
                  <ProseWithHashes text={liveness.blocker.summary} /> <span className="text-muted">How to fix: <ProseWithHashes text={liveness.blocker.remediation} /></span>
                </p>
              )}
              <details className="mt-2 text-xs text-muted">
                <summary className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Signals ({liveness.evidence.length})</summary>
                <ul className="mt-2 space-y-1">
                  {liveness.evidence.length === 0 && <li>Evidence unavailable.</li>}
                  {liveness.evidence.map((item) => <li key={`${item.source}:${item.reference}`}>{readable(item.source)} · {timestamp(item.observedAt)} · <ProseWithHashes text={item.detail} /></li>)}
                </ul>
              </details>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted"><LifecycleLivenessBadge liveness={null} /> No run evidence is available for the current snapshot.</p>
          )}
          </section>
        </OverviewPanel>
        {phase.phaseId === 'maintenance' && (
            <OverviewPanel
              id="closeout"
              active={inspectorSection === 'closeout'}
              testId="lifecycle-learn-closeout"
            >
              <section aria-labelledby="phase-learn-heading">
            <SectionHeading id="phase-learn-heading">Maintenance closeout</SectionHeading>
            {phase.learn ? (
              <div className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-panel p-3">
                  <span className="text-muted">Review candidates</span>
                  <strong className="text-right text-[var(--text)]">{phase.learn.candidateCount}/{phase.learn.requiredCandidateCount}</strong>
                  <span className="text-muted">Source evidence</span>
                  <strong className="text-right text-[var(--text)]">{phase.learn.sourceEvidenceCount}</strong>
                  <span className="text-muted">Generation</span>
                  <strong className="text-right text-[var(--text)]">{readable(phase.learn.generation.state)}</strong>
                </div>
                {phase.learn.generation.blocker && (
                  <p className="rounded-md border border-error/30 bg-error/10 p-3 text-error">
                    <ProseWithHashes text={phase.learn.generation.blocker.message} />
                  </p>
                )}
                <ul className="divide-y divide-border border-y border-border" aria-label="Provenance-linked maintenance candidates">
                  {phase.learn.candidates.items.map((candidate) => (
                    <li key={candidate.id} className="space-y-2 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong className="text-[var(--text)]">{candidate.category ?? 'Memory'} candidate #{candidate.id}</strong>
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">{readable(candidate.status)}</span>
                      </div>
                      <p className="text-xs text-muted">
                        Workspace {candidate.provenance.workspaceId ?? 'unknown'} · Spec {candidate.provenance.specId ?? 'unknown'} · Run {candidate.provenance.runId ?? 'unknown'} · Story {candidate.provenance.storyId ?? 'unknown'}
                      </p>
                      <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                        Subject: {candidate.provenance.releaseSubject
                          ? <>{readable(candidate.provenance.releaseSubject.type)} <LifecycleHashChip value={candidate.provenance.releaseSubject.value} label="release subject" /></>
                          : 'unknown'}
                        {candidate.provenance.commitSha && <> · Commit <LifecycleHashChip value={candidate.provenance.commitSha} label="commit" /></>}
                      </p>
                      <div className="flex flex-wrap gap-2 text-xs">
                        {candidate.provenance.sourceEvidenceIds.map((evidenceId) => (/^\d+$/.test(evidenceId) ? (
                          <button key={evidenceId} type="button" onClick={(event) => openEvidence(evidenceId, event.currentTarget)} className="rounded-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                            Evidence {evidenceId}
                          </button>
                        ) : <span key={evidenceId} className="text-muted">Evidence {evidenceId}</span>))}
                      </div>
                      {candidate.securitySensitive && <p className="text-xs text-warning">Sensitive delivery fact — human review is mandatory.</p>}
                      <p className="text-xs text-muted">{candidate.defaultRetrievalEligible ? 'Eligible for retrieval after review' : 'Not eligible for retrieval by default'}</p>
                    </li>
                  ))}
                  {phase.learn.candidates.items.length === 0 && (
                    <li className="py-3 text-muted">Nothing to review yet — closeout candidates appear here after a terminal run finishes.</li>
                  )}
                </ul>
                <p className="border-l-2 border-accent pl-3 text-[var(--text)]">Next step: {phase.learn.nextAction}</p>
              </div>
            ) : (
              <div className="lifecycle-empty-hint" role="status">
                <p className="text-sm font-medium text-[var(--text)]">Maintenance closeout has not started</p>
                <p className="mt-1 text-xs text-muted">This phase cannot be presented as passed until the closeout runs. Candidates are generated when a terminal run completes.</p>
              </div>
            )}
              </section>
            </OverviewPanel>
        )}
          </div>
          </div>
        )}

      </div>

      <footer className="lifecycle-phase-view__footer" aria-label="Server-permitted phase actions">
        {actions[0] ? (
          <button
            type="button"
            disabled={actionPending !== null}
            onClick={() => onAction(actions[0]!.id)}
            className="inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-[var(--accent-contrast)] hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
          >
            {actionPending === actions[0].id ? 'Working…' : actions[0].label}
            {actions[0].id !== 'recompile_plan' && <ExternalLink size={13} aria-hidden="true" />}
          </button>
        ) : <p className="text-xs text-muted">No actions are currently permitted for this phase.</p>}
      </footer>
    </div>
  );
}
