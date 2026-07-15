/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { AlertTriangle, ChevronRight, GitBranch } from 'lucide-react';
import type { LifecycleEvidenceSummary, LifecycleTraceability } from '../types/lifecycle';
import { LIFECYCLE_STATUS_LABELS, LifecycleStatusIcon } from '../panels/LifecycleCell';

interface LifecycleTraceabilityProps {
  traceability: LifecycleTraceability;
  snapshotId: string;
  onOpenEvidence: (evidenceId: string, trigger?: HTMLElement) => void;
}

function readable(value: string): string {
  return value.replace(/_/g, ' ');
}

function EvidenceButton({ evidence, historical, onOpen }: {
  evidence: LifecycleEvidenceSummary;
  historical: boolean;
  onOpen: (evidenceId: string, trigger?: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => onOpen(evidence.id, event.currentTarget)}
      className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-label={`Inspect ${historical ? 'historical ' : ''}${evidence.evidenceType} evidence ${evidence.sourceEventId}`}
    >
      <LifecycleStatusIcon status={historical ? 'stale' : evidence.status === 'passed' ? 'passed' : 'blocked'} size={14} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-[var(--text)]">{evidence.evidenceType} · {evidence.sourceSystem}</span>
        <span className={`mt-0.5 block text-[11px] ${historical ? 'text-warning' : 'text-muted'}`}>
          {historical ? 'Historical — excluded from active gate' : 'Eligible for bound revision'} · {evidence.sourceEventId}
        </span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-muted" aria-hidden="true" />
    </button>
  );
}

export default function LifecycleTraceability({ traceability, snapshotId, onOpenEvidence }: LifecycleTraceabilityProps) {
  const revision = traceability.boundRevision;
  const blockers = traceability.blockers?.items ?? [];
  const lineage = traceability.subjectLineage ?? [];
  const coherence = traceability.downstreamCoherence;

  return (
    <div className="space-y-3" data-testid="lifecycle-traceability">
      <div className="rounded-md border border-border bg-panel p-3 text-xs">
        <div className="font-semibold text-[var(--text)]">Bound immutable revision</div>
        <div className="mt-1 break-all text-muted">
          {revision ? `Spec ${revision.specVersion ?? 'unknown'} · Plan ${revision.planVersion} · ${revision.inputHash}` : 'Revision link absent — recompile the lifecycle plan.'}
        </div>
        <div className="mt-1 break-all text-[11px] text-muted">Evaluation snapshot: {snapshotId}</div>
      </div>

      {blockers.length > 0 && (
        <div className="rounded-md border border-error/40 bg-error/10 p-3" role="alert">
          <div className="flex items-center gap-2 text-xs font-semibold text-error"><AlertTriangle size={14} aria-hidden="true" /> Readiness blockers ({traceability.blockers?.total ?? blockers.length})</div>
          <ul className="mt-2 space-y-2">
            {blockers.map((blocker, index) => (
              <li key={`${blocker.kind}:${blocker.requirementReference}:${blocker.gateId}:${index}`} className="text-xs text-[var(--text)]">
                <div>{blocker.message}</div>
                <div className="mt-0.5 text-muted"><span className="font-medium">Remediation:</span> {blocker.remediation}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-md border border-border">
        <div className="border-b border-border px-3 py-2 text-xs font-semibold text-[var(--text)]">Requirement chains ({traceability.requirements.total})</div>
        {traceability.requirements.items.length === 0 && <p className="p-3 text-xs text-muted">No canonical requirement mappings are available.</p>}
        {traceability.requirements.items.map((requirement) => (
          <details key={requirement.requirementReference} className="border-b border-border last:border-b-0">
            <summary className="cursor-pointer px-3 py-3 text-sm font-medium text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
              {requirement.requirementReference}
              {(requirement.blockers?.length ?? 0) > 0 && <span className="ml-2 text-xs text-error">Blocked</span>}
            </summary>
            <div className="space-y-3 border-t border-border bg-bg px-3 py-3 text-xs">
              <div><span className="font-semibold text-muted">Decisions:</span> {requirement.decisions.join(', ') || 'Missing'}</div>
              <div><span className="font-semibold text-muted">Stories:</span> {requirement.stories.join(', ') || 'Missing'}</div>
              <div className="space-y-2">
                {(requirement.gates ?? []).map((gate) => (
                  <div key={gate.gateId} className="rounded-md border border-border bg-panel p-2">
                    <div className="flex items-start gap-2">
                      <LifecycleStatusIcon status={gate.status} size={14} />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-[var(--text)]">{gate.title}</div>
                        <div className="mt-0.5 text-muted">{gate.gateId} · {LIFECYCLE_STATUS_LABELS[gate.status]} · {readable(gate.subjectRevisionRequirement ?? 'revision unknown')}</div>
                      </div>
                    </div>
                    <div className="mt-2 divide-y divide-border">
                      {(gate.currentEvidence ?? []).map((evidence) => <EvidenceButton key={evidence.id} evidence={evidence} historical={false} onOpen={onOpenEvidence} />)}
                      {(gate.historicalEvidence ?? []).map((evidence) => <EvidenceButton key={evidence.id} evidence={evidence} historical onOpen={onOpenEvidence} />)}
                      {(gate.currentEvidence?.length ?? 0) + (gate.historicalEvidence?.length ?? 0) === 0 && <p className="px-2 py-2 text-warning">Evidence link missing. Collect {gate.evidenceRequirementIds?.join(', ') || 'required'} evidence for this gate.</p>}
                    </div>
                  </div>
                ))}
                {(requirement.gates?.length ?? 0) === 0 && <p className="text-warning">Gate link missing. Update the requirement mapping and recompile.</p>}
              </div>
            </div>
          </details>
        ))}
        {traceability.requirements.truncated && <p className="border-t border-border p-2 text-xs text-warning">Showing {traceability.requirements.items.length} of {traceability.requirements.total} requirements.</p>}
      </div>

      <div className="rounded-md border border-border p-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text)]"><GitBranch size={14} aria-hidden="true" /> Typed subject lineage</div>
        <ol className="mt-2 space-y-1 text-xs">
          {lineage.length === 0 && <li className="text-warning">Lineage unavailable; no identifiers were inferred.</li>}
          {lineage.map((node, index) => (
            <li key={node.type} className="break-all text-muted">
              {index > 0 && <span aria-hidden="true">↳ </span>}<span className="font-medium text-[var(--text)]">{node.type}</span>: {node.status === 'available' ? node.value : node.status === 'not_applicable' ? 'Not applicable' : 'Absent'}
            </li>
          ))}
        </ol>
      </div>

      {coherence && (
        <div className={`rounded-md border p-3 ${coherence.status === 'mismatch' ? 'border-error/40 bg-error/10' : 'border-border'}`}>
          <div className="text-xs font-semibold text-[var(--text)]">QA → merge → production identity: {readable(coherence.status)}</div>
          <ul className="mt-2 space-y-1 text-[11px] text-muted">
            {coherence.bindings.map((binding) => <li key={binding.phaseId} className="break-all"><span className="font-medium text-[var(--text)]">{binding.phaseId.toUpperCase()}</span> · commit {binding.commitSha ?? 'absent'} · image {binding.artifactDigest ?? 'absent'} · deployment {binding.deploymentId ?? 'absent'}</li>)}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-muted">
        {traceability.graphContext?.mode === 'full'
          ? `Knowledge graph enrichment: ${traceability.graphContext.relatedEvidenceLabels.join(', ') || 'no related labels'}.`
          : 'Canonical relational provenance is active; graph enrichment is unavailable or not required.'}
      </p>
    </div>
  );
}
