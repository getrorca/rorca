/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronRight, GitBranch } from 'lucide-react';
import type {
  LifecycleEvidenceSummary,
  LifecyclePhaseCell,
  LifecycleTraceability,
  LifecycleTraceabilityGate,
  LifecycleTraceabilityRequirement,
} from '../types/lifecycle';
import { LIFECYCLE_STATUS_LABELS, LifecycleStatusIcon } from '../panels/LifecycleCell';
import LifecycleHashChip, { ProseWithHashes } from './LifecycleHashChip';

interface LifecycleTraceabilityProps {
  traceability: LifecycleTraceability;
  snapshotId: string;
  onOpenEvidence: (evidenceId: string, trigger?: HTMLElement) => void;
}

function readable(value: string): string {
  const normalized = value.replace(/_/g, ' ');
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function stripDerivedRefHashes(value: string): string {
  return value.replace(/:sha256:[a-f0-9]{64}/gi, '');
}

/** Strip derived-reference content hashes for display: 'LBC-001:ac:sha256:…' → 'LBC-001:ac'. */
function displayRef(value: string): string {
  const withoutDerivedSuffix = stripDerivedRefHashes(value);
  return withoutDerivedSuffix.replace(
    /sha256:([a-f0-9]{64})/g,
    (_match, hash: string) => `${hash.slice(0, 10)}…`,
  );
}

function compactGateLabel(value: string): string {
  const compact = displayRef(value).replace(
    /^gate-(?:ctrl-)?(?:planning|requirements|design|development|testing|deployment|maintenance)-/i,
    '',
  );
  return readable(compact);
}

const EVIDENCE_STATUS_ICON: Record<LifecycleEvidenceSummary['status'], LifecyclePhaseCell['status']> = {
  passed: 'passed',
  failed: 'blocked',
  story_caused_failure: 'blocked',
  unrelated_baseline: 'not_applicable',
  environment_credential_blocker: 'blocked',
  skipped_with_rationale: 'deferred',
  unknown: 'unassessed',
};

const TRACEABILITY_PAGE_SIZE = 12;

function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueEvidence(items: LifecycleEvidenceSummary[]): LifecycleEvidenceSummary[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function mergeGates(gates: LifecycleTraceabilityGate[]): LifecycleTraceabilityGate[] {
  const merged = new Map<string, LifecycleTraceabilityGate>();
  for (const gate of gates) {
    const key = `${gate.phaseId}:${gate.gateId}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, gate);
      continue;
    }
    merged.set(key, {
      ...current,
      evidenceRequirementIds: uniqueValues([...(current.evidenceRequirementIds ?? []), ...(gate.evidenceRequirementIds ?? [])]),
      currentEvidence: uniqueEvidence([...(current.currentEvidence ?? []), ...(gate.currentEvidence ?? [])]),
      historicalEvidence: uniqueEvidence([...(current.historicalEvidence ?? []), ...(gate.historicalEvidence ?? [])]),
    });
  }
  return [...merged.values()];
}

function mergeRequirements(items: LifecycleTraceabilityRequirement[]): LifecycleTraceabilityRequirement[] {
  const merged = new Map<string, LifecycleTraceabilityRequirement>();
  for (const requirement of items) {
    const current = merged.get(requirement.requirementReference);
    if (!current) {
      merged.set(requirement.requirementReference, requirement);
      continue;
    }
    const blockers = [...(current.blockers ?? []), ...(requirement.blockers ?? [])];
    merged.set(requirement.requirementReference, {
      ...current,
      stories: uniqueValues([...current.stories, ...requirement.stories]),
      decisions: uniqueValues([...current.decisions, ...requirement.decisions]),
      gateIds: uniqueValues([...current.gateIds, ...requirement.gateIds]),
      evidenceRequirementIds: uniqueValues([...current.evidenceRequirementIds, ...requirement.evidenceRequirementIds]),
      gates: mergeGates([...(current.gates ?? []), ...(requirement.gates ?? [])]),
      blockers: [...new Map(blockers.map((blocker) => [
        `${blocker.kind}:${blocker.requirementReference}:${blocker.storyReference}:${blocker.gateId}:${blocker.message}`,
        blocker,
      ])).values()],
    });
  }
  return [...merged.values()];
}

type TraceChain = NonNullable<LifecycleTraceability['endToEnd']>['items'][number];

interface TraceabilityMatrixRow {
  key: string;
  requirementReference: string;
  storyReference: string;
  chainsByGate: Map<string, TraceChain>;
}

function needsAttention(chain: TraceChain): boolean {
  return chain.status !== 'passed' && chain.status !== 'not_applicable';
}

function mergeTraceChain(current: TraceChain, next: TraceChain): TraceChain {
  const preferred = needsAttention(next) && !needsAttention(current) ? next : current;
  return {
    ...preferred,
    evidenceIds: uniqueValues([...current.evidenceIds, ...next.evidenceIds]),
    decisionIds: uniqueValues([...current.decisionIds, ...next.decisionIds]),
    exactSubject: preferred.exactSubject ?? current.exactSubject ?? next.exactSubject,
  };
}

function buildTraceabilityMatrix(chains: TraceChain[]): TraceabilityMatrixRow[] {
  const rows = new Map<string, TraceabilityMatrixRow>();
  for (const chain of chains) {
    const key = `${chain.requirementReference}\u0000${chain.storyReference}`;
    const row = rows.get(key) ?? {
      key,
      requirementReference: chain.requirementReference,
      storyReference: chain.storyReference,
      chainsByGate: new Map<string, TraceChain>(),
    };
    const current = row.chainsByGate.get(chain.gateId);
    row.chainsByGate.set(chain.gateId, current ? mergeTraceChain(current, chain) : chain);
    rows.set(key, row);
  }
  return [...rows.values()];
}

function EvidenceButton({ evidence, historical, onOpen }: {
  evidence: LifecycleEvidenceSummary;
  historical: boolean;
  onOpen: (evidenceId: string, trigger?: HTMLElement) => void;
}) {
  const outcome = readable(evidence.status);
  const iconStatus = historical ? 'stale' : EVIDENCE_STATUS_ICON[evidence.status];
  return (
    <button
      type="button"
      onClick={(event) => onOpen(evidence.id, event.currentTarget)}
      className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-label={`Inspect ${historical ? 'historical ' : ''}${evidence.evidenceType} evidence ${evidence.sourceEventId}. Outcome: ${outcome}`}
    >
      <LifecycleStatusIcon status={iconStatus} size={14} />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-[var(--text)]">{evidence.evidenceType} · {evidence.sourceSystem}</span>
        <span className={`mt-0.5 block text-xs ${historical ? 'text-warning' : 'text-muted'}`}>
          {outcome} · {historical ? 'Historical — excluded from active gate' : 'Eligible for bound revision'} · {evidence.sourceEventId}
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
  const chains = useMemo(() => traceability.endToEnd?.items ?? [], [traceability.endToEnd?.items]);
  const attentionChains = useMemo(() => chains.filter(needsAttention), [chains]);
  const matrixRows = useMemo(() => buildTraceabilityMatrix(chains), [chains]);
  const gateIds = useMemo(
    () => uniqueValues(chains.map((chain) => chain.gateId)),
    [chains],
  );
  const attentionRows = useMemo(
    () => matrixRows.filter((row) => [...row.chainsByGate.values()].some(needsAttention)),
    [matrixRows],
  );
  const [chainScope, setChainScope] = useState<'attention' | 'all'>('attention');
  const visibleMatrixRows = chainScope === 'attention' && attentionRows.length > 0 ? attentionRows : matrixRows;
  const [selectedChain, setSelectedChain] = useState<TraceChain | null>(null);
  const uniqueMatrixCellCount = matrixRows.reduce((count, row) => count + row.chainsByGate.size, 0);
  const requirements = useMemo(
    () => mergeRequirements(traceability.requirements.items),
    [traceability.requirements.items],
  );
  const [visibleRequirementCount, setVisibleRequirementCount] = useState(TRACEABILITY_PAGE_SIZE);
  const visibleRequirements = requirements.slice(0, visibleRequirementCount);

  return (
    <div className="space-y-3" data-testid="lifecycle-traceability">
      <div className="rounded-md border border-border bg-panel p-3 text-xs">
        <div className="font-semibold text-[var(--text)]">Bound revision</div>
        {revision ? (
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted">
            <span>Spec {revision.specVersion ?? 'unknown'} · Plan {revision.planVersion}</span>
            <LifecycleHashChip value={revision.inputHash} label="revision hash" />
          </div>
        ) : <p className="mt-1 text-muted">Revision link is missing — recompile the lifecycle plan to restore it.</p>}
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted">
          <span>Evaluation snapshot</span>
          <LifecycleHashChip value={snapshotId} label="evaluation snapshot hash" />
        </div>
      </div>

      {blockers.length > 0 && (
        <div className="rounded-md border border-error/40 bg-error/10 p-3" role="alert">
          <div className="flex items-center gap-2 text-xs font-semibold text-error"><AlertTriangle size={14} aria-hidden="true" /> Readiness blockers ({traceability.blockers?.total ?? blockers.length})</div>
          <ul className="mt-2 space-y-2">
            {blockers.map((blocker, index) => (
              <li key={`${blocker.kind}:${blocker.requirementReference}:${blocker.gateId}:${index}`} className="text-xs text-[var(--text)]">
                <div><ProseWithHashes text={stripDerivedRefHashes(blocker.message)} /></div>
                <div className="mt-0.5 text-muted"><span className="font-medium">Remediation:</span> <ProseWithHashes text={stripDerivedRefHashes(blocker.remediation)} /></div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {traceability.endToEnd && (
        <section className="lifecycle-traceability-matrix" aria-labelledby="lifecycle-end-to-end-heading">
          <div className="lifecycle-traceability-matrix__header">
            <div>
              <h4 id="lifecycle-end-to-end-heading">Coverage matrix</h4>
              <p>
                {matrixRows.length} requirement/story {matrixRows.length === 1 ? 'path' : 'paths'} × {gateIds.length} gates
                {' · '}{uniqueMatrixCellCount} unique checks
              </p>
            </div>
            <div className="flex items-center gap-1" role="group" aria-label="Filter traceability paths">
              <button
                type="button"
                aria-pressed={chainScope === 'attention' && attentionRows.length > 0}
                disabled={attentionRows.length === 0}
                onClick={() => setChainScope('attention')}
                className="lifecycle-traceability-filter"
              >
                Attention ({attentionRows.length})
              </button>
              <button
                type="button"
                aria-pressed={chainScope === 'all' || attentionRows.length === 0}
                onClick={() => setChainScope('all')}
                className="lifecycle-traceability-filter"
              >
                All ({matrixRows.length})
              </button>
            </div>
          </div>
          {chains.length === 0 ? (
            <p className="p-3 text-xs text-muted">No complete requirement-to-decision chains are available for this revision.</p>
          ) : (
            <>
              <div className="lifecycle-traceability-matrix__viewport">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Requirement / story</th>
                      {gateIds.map((gateId) => <th key={gateId} scope="col" title={displayRef(gateId)}>{compactGateLabel(gateId)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMatrixRows.map((row) => (
                      <tr key={row.key}>
                        <th scope="row">
                          <span>{displayRef(row.requirementReference)}</span>
                          <small>{displayRef(row.storyReference)}</small>
                        </th>
                        {gateIds.map((gateId) => {
                          const chain = row.chainsByGate.get(gateId);
                          return (
                            <td key={gateId}>
                              {chain ? (
                                <button
                                  type="button"
                                  data-status={chain.status}
                                  aria-label={`${displayRef(row.requirementReference)}, ${displayRef(row.storyReference)}, ${displayRef(gateId)}: ${LIFECYCLE_STATUS_LABELS[chain.status]}`}
                                  aria-pressed={selectedChain === chain}
                                  title={`${displayRef(gateId)} · ${LIFECYCLE_STATUS_LABELS[chain.status]}`}
                                  onClick={() => setSelectedChain(chain)}
                                >
                                  <LifecycleStatusIcon status={chain.status} size={14} />
                                </button>
                              ) : <span aria-label={`${displayRef(gateId)} not mapped`}>—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="lifecycle-traceability-matrix__legend">
                {attentionChains.length > 0 ? `${attentionChains.length} checks need attention.` : 'All loaded checks are satisfied.'}
                {chains.length > uniqueMatrixCellCount && ` ${chains.length - uniqueMatrixCellCount} duplicate records were collapsed.`}
              </p>
              {selectedChain && (
                <dl className="lifecycle-traceability-matrix__selection">
                  <dt>Selected</dt>
                  <dd>{displayRef(selectedChain.requirementReference)} → {displayRef(selectedChain.storyReference)} → {displayRef(selectedChain.gateId)}</dd>
                  <dt>Status</dt>
                  <dd>{LIFECYCLE_STATUS_LABELS[selectedChain.status]} · {readable(selectedChain.phaseId)}</dd>
                  <dt>Subject</dt>
                  <dd>{selectedChain.exactSubject
                    ? <LifecycleHashChip value={selectedChain.exactSubject.value} label="exact subject" />
                    : <span className="text-warning">Missing</span>}</dd>
                  <dt>Evidence</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {selectedChain.evidenceIds.map((evidenceId) => (
                      <button
                        key={evidenceId}
                        type="button"
                        aria-label={`Inspect evidence ${displayRef(evidenceId)} for ${displayRef(selectedChain.gateId)}`}
                        onClick={(event) => onOpenEvidence(evidenceId, event.currentTarget)}
                        className="lifecycle-ref-chip lifecycle-ref-chip--link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {displayRef(evidenceId)}
                      </button>
                    ))}
                    {selectedChain.evidenceIds.length === 0 && <span className="text-warning">Missing</span>}
                  </dd>
                  <dt>Decisions</dt>
                  <dd>{selectedChain.decisionIds.map(displayRef).join(', ') || 'None recorded'}</dd>
                </dl>
              )}
              {traceability.endToEnd.truncated && (
                <p className="border-t border-border p-2 text-xs text-warning">The API returned {chains.length} of {traceability.endToEnd.total} checks. Refine the server query for the complete matrix.</p>
              )}
            </>
          )}
        </section>
      )}

      <details className="lifecycle-traceability-group">
        <summary>
          <span className="min-w-0">
            <strong>Requirement chains ({traceability.requirements.total})</strong>
            <span>{requirements.length} unique {requirements.length === 1 ? 'requirement' : 'requirements'}</span>
          </span>
          <ChevronRight size={15} aria-hidden="true" />
        </summary>
        <div className="border-t border-border">
          {requirements.length === 0 && <p className="p-3 text-xs text-muted">No canonical requirement mappings are available.</p>}
          {visibleRequirements.map((requirement) => (
            <details key={requirement.requirementReference} className="border-b border-border last:border-b-0">
              <summary
                className="cursor-pointer px-3 py-3 text-sm font-medium text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                aria-label={displayRef(requirement.requirementReference)}
              >
                {displayRef(requirement.requirementReference)}
                {(requirement.blockers?.length ?? 0) > 0 && <span className="ml-2 text-xs text-error">Blocked</span>}
              </summary>
              <div className="space-y-3 border-t border-border bg-bg px-3 py-3 text-xs">
                <div><span className="font-semibold text-muted">Decisions:</span> {requirement.decisions.map(displayRef).join(', ') || 'Missing'}</div>
                <div><span className="font-semibold text-muted">Stories:</span> {requirement.stories.map(displayRef).join(', ') || 'Missing'}</div>
                <div className="space-y-2">
                  {(requirement.gates ?? []).map((gate) => (
                    <div key={`${gate.phaseId}:${gate.gateId}`} className="rounded-md border border-border bg-panel p-2">
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
          {visibleRequirements.length < requirements.length && (
            <button
              type="button"
              onClick={() => setVisibleRequirementCount((count) => count + TRACEABILITY_PAGE_SIZE)}
              className="w-full border-t border-border px-3 py-2 text-left text-xs font-medium text-accent hover:bg-surface-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            >
              Show {Math.min(TRACEABILITY_PAGE_SIZE, requirements.length - visibleRequirements.length)} more requirements
            </button>
          )}
          {traceability.requirements.truncated && <p className="border-t border-border p-2 text-xs text-warning">The API returned {traceability.requirements.items.length} of {traceability.requirements.total} requirement mappings.</p>}
        </div>
      </details>

      <details className="lifecycle-traceability-group">
        <summary>
          <span className="min-w-0">
            <strong>Release binding details</strong>
            <span>{coherence ? `Testing ↔ Deployment ${readable(coherence.status)}` : 'Lineage and graph provenance'}</span>
          </span>
          <ChevronRight size={15} aria-hidden="true" />
        </summary>
        <div className="space-y-3 border-t border-border p-3 text-xs">
          <div>
            <div className="flex items-center gap-2 font-semibold text-[var(--text)]"><GitBranch size={14} aria-hidden="true" /> Release lineage</div>
            <ol className="mt-2 space-y-1.5">
              {lineage.length === 0 && <li className="text-warning">Release lineage is not available for this snapshot.</li>}
              {lineage.map((node, index) => (
                <li key={node.type} className="flex flex-wrap items-center gap-1.5 text-muted">
                  {index > 0 && <span aria-hidden="true">↳</span>}
                  <span className="font-medium text-[var(--text)]">{readable(node.type)}:</span>
                  {node.status === 'available' && node.value
                    ? <LifecycleHashChip value={node.value} label={readable(node.type)} />
                    : node.status === 'not_applicable' ? 'Not applicable' : 'Absent'}
                </li>
              ))}
            </ol>
          </div>
          {coherence && (
            <div className={`rounded-md border p-3 ${coherence.status === 'mismatch' ? 'border-error/40 bg-error/10' : 'border-border'}`}>
              <div className="font-semibold text-[var(--text)]">Release identity across Testing and Deployment: {readable(coherence.status)}</div>
              <ul className="mt-2 space-y-1.5 text-muted">
                {coherence.bindings.map((binding) => (
                  <li key={binding.phaseId} className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-[var(--text)]">{binding.phaseId.toUpperCase()}</span>
                    <span>Commit</span>{binding.commitSha ? <LifecycleHashChip value={binding.commitSha} label={`${binding.phaseId} commit`} /> : <span>absent</span>}
                    <span>Artifact</span>{binding.artifactDigest ? <LifecycleHashChip value={binding.artifactDigest} label={`${binding.phaseId} artifact`} /> : <span>absent</span>}
                    <span>Deployment</span>{binding.deploymentId ? <LifecycleHashChip value={binding.deploymentId} label={`${binding.phaseId} deployment`} /> : <span>absent</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-muted">
            {traceability.graphContext?.mode === 'full'
              ? `Graph-enriched provenance is active. Related evidence: ${traceability.graphContext.relatedEvidenceLabels.join(', ') || 'none'}.`
              : 'Standard relational provenance is active. Knowledge-graph enrichment is unavailable or not required for this spec.'}
          </p>
        </div>
      </details>
    </div>
  );
}
