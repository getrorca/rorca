/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { AlertTriangle, CheckCircle2, CircleHelp, Clock3, GitBranch, ShieldAlert } from 'lucide-react';
import { identityState } from '../lib/feature-assurance-map';
import type {
  FeatureAssuranceChain,
  FeatureAssuranceEvidence,
  FeatureAssuranceIdentity,
  FeatureAssuranceDecision,
  FeatureAssuranceMapProjection,
  FeatureAssuranceStatus,
  DevelopmentAssuranceCheck,
  DevelopmentAssuranceCompilation,
  DevelopmentAssuranceDisposition,
  FeatureAssuranceReviewEvidence,
  FeatureAssuranceReviewTrustState,
  FeatureAssuranceReviewView as FeatureAssuranceReviewProjection,
  FeatureAssuranceSourceLocation,
} from '../types/feature-assurance-map';

const STATUS_LABELS: Record<FeatureAssuranceStatus, string> = {
  verified: 'Verified',
  pending: 'Pending',
  stale: 'Stale',
  blocked: 'Blocked',
  unavailable: 'Unavailable',
};

const STATUS_CLASSES: Record<FeatureAssuranceStatus, string> = {
  verified: 'border-success/40 bg-success/10 text-success',
  pending: 'border-warning/40 bg-warning/10 text-warning',
  stale: 'border-warning/40 bg-warning/10 text-warning',
  blocked: 'border-error/40 bg-error/10 text-error',
  unavailable: 'border-border bg-bg text-muted',
};

const OBLIGATION_LABELS: Record<DevelopmentAssuranceDisposition, string> = {
  required: 'Required',
  not_applicable: 'Not applicable',
  unresolved: 'Unresolved',
  blocked: 'Blocked',
};

const OBLIGATION_CLASSES: Record<DevelopmentAssuranceDisposition, string> = {
  required: 'border-warning/40 bg-warning/10 text-warning',
  not_applicable: 'border-border bg-bg text-muted',
  unresolved: 'border-warning/40 bg-warning/10 text-warning',
  blocked: 'border-error/40 bg-error/10 text-error',
};

const REVIEW_TRUST_LABELS: Record<FeatureAssuranceReviewTrustState, string> = {
  independent: 'Independent',
  'self-review': 'Self-review',
  'stale-review': 'Stale review',
  'unattributed-review': 'Unattributed review',
};

const REVIEW_TRUST_CLASSES: Record<FeatureAssuranceReviewTrustState, string> = {
  independent: 'border-success/40 bg-success/10 text-success',
  'self-review': 'border-warning/40 bg-warning/10 text-warning',
  'stale-review': 'border-warning/40 bg-warning/10 text-warning',
  'unattributed-review': 'border-border bg-bg text-muted',
};

const REVIEW_AXIS_LABELS = {
  standards: 'Standards',
  design: 'Design',
  adversarial: 'Adversarial',
} as const;

function displayIdentity(identity: FeatureAssuranceIdentity | null): string {
  if (!identity) return 'Unavailable';
  return `revision ${identity.revision ?? 'unknown'} · plan ${identity.planId ?? 'unknown'} · v${identity.planVersion ?? 'unknown'}`;
}

function StatusIcon({ status }: { status: FeatureAssuranceStatus }) {
  if (status === 'verified') return <CheckCircle2 size={14} aria-hidden="true" />;
  if (status === 'blocked' || status === 'stale') return <ShieldAlert size={14} aria-hidden="true" />;
  if (status === 'pending') return <Clock3 size={14} aria-hidden="true" />;
  return <CircleHelp size={14} aria-hidden="true" />;
}

function StatusBadge({ status }: { status: FeatureAssuranceStatus }) {
  return <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_CLASSES[status]}`}><StatusIcon status={status} />{STATUS_LABELS[status]}</span>;
}

function IdentityState({ label, state }: { label: string; state: FeatureAssuranceChain['requirement']['identity'] }) {
  return (
    <div className="mt-1 text-[10px] text-muted">
      <span className="font-medium text-[var(--text)]">{label}:</span> {displayIdentity(state.row)}
      {state.status === 'stale' && <><span className="mx-1">· source:</span>{displayIdentity(state.source)}</>}
      {state.status === 'stale' && <span className="ml-1 text-warning">(stale)</span>}
      {state.status === 'unavailable' && <span className="ml-1 text-warning">(identity unavailable)</span>}
    </div>
  );
}

function NodeLabel({ label, value, onNavigate }: { label: string; value: string; onNavigate?: () => void }) {
  if (!onNavigate) return <span><span className="font-semibold text-muted">{label}:</span> {value}</span>;
  return <button type="button" onClick={onNavigate} className="text-left hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><span className="font-semibold text-muted">{label}:</span> {value}</button>;
}

function EvidenceRow({ evidence, onOpenEvidence }: { evidence: FeatureAssuranceEvidence; onOpenEvidence?: (id: string) => void }) {
  const identity = identityState(evidence.identity, evidence.sourceIdentity);
  return (
    <li className="rounded border border-border bg-bg p-2 text-[11px]" data-testid={`assurance-evidence-${evidence.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {onOpenEvidence ? <button type="button" onClick={() => onOpenEvidence(evidence.id)} className="font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{evidence.id}</button> : <span className="font-semibold text-[var(--text)]">{evidence.id}</span>}
        <span className="text-muted">{evidence.outcome} · {evidence.trustLevel} · lineage {evidence.lineageVerified === true ? 'verified' : evidence.lineageVerified === false ? 'unverified' : 'unavailable'}</span>
      </div>
      <dl className="mt-1 grid gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-muted">Source</dt><dd>{evidence.source} · {evidence.sourceSystem}</dd>
        <dt className="text-muted">Observed</dt><dd>{evidence.observedAt ?? 'Unavailable'}</dd>
        <dt className="text-muted">Binding</dt><dd className="break-all">{Object.entries(evidence.binding).filter(([, value]) => value != null).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' · ') || 'Unavailable'}</dd>
        <dt className="text-muted">Identity</dt>
        <dd data-testid={`assurance-evidence-identity-${evidence.id}`}>
          {displayIdentity(identity.row)}
          {identity.status === 'stale' && <><span className="mx-1">· source {displayIdentity(identity.source)}</span><span className="text-warning">· Stale identity</span></>}
          {identity.status === 'unavailable' && <span className="ml-1 text-warning">· Identity unavailable</span>}
        </dd>
      </dl>
    </li>
  );
}

function DecisionRow({ decision, onNavigate }: { decision: FeatureAssuranceDecision; onNavigate?: (kind: string, id: string) => void }) {
  const identity = identityState(decision.identity, decision.sourceIdentity);
  return (
    <li className="rounded border border-border bg-panel p-2" data-testid={`assurance-decision-${decision.id}`}>
      <div className="flex flex-wrap justify-between gap-2">
        {onNavigate ? <button type="button" onClick={() => onNavigate('decision', decision.id)} className="font-medium text-left hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{decision.id} · {decision.decisionType}</button> : <span className="font-medium">{decision.id} · {decision.decisionType}</span>}
        <span className="text-muted">{decision.outcome} · {decision.createdAt ?? 'Unavailable'}</span>
      </div>
      <div className="mt-1 text-muted">Source: {decision.source} · binding: {Object.entries(decision.binding).filter(([, value]) => value != null).map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(' · ') || 'Unavailable'}</div>
      <IdentityState label="Identity" state={identity} />
    </li>
  );
}

function DevelopmentAssuranceRow({ check }: { check: DevelopmentAssuranceCheck }) {
  return (
    <li className="border-b border-border last:border-b-0" data-testid={`development-assurance-check-${check.checkId}`}>
      <details>
        <summary className="cursor-pointer px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-xs font-medium text-[var(--text)]">{check.checkKind} · {check.requirement?.requirementId ?? 'feature scope'} · {check.change?.kind ?? 'scope'} · {check.componentOrBoundary ?? 'unresolved boundary'}</span>
            <span className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${OBLIGATION_CLASSES[check.disposition]}`}>{OBLIGATION_LABELS[check.disposition]}</span>
          </span>
        </summary>
        <div className="space-y-2 border-t border-border bg-bg px-3 py-3 text-xs">
          <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted">Requirement</dt><dd>{check.requirement ? `${check.requirement.requirementId} · ${check.requirement.text}` : 'Not bound'}</dd>
            <dt className="text-muted">Change</dt><dd>{check.change ? `${check.change.changeId} · ${check.change.kind} · ${check.change.path}` : 'Feature/work-package scope'}</dd>
            <dt className="text-muted">Component / boundary</dt><dd>{check.componentOrBoundary ?? 'Unresolved'}</dd>
            <dt className="text-muted">Risk</dt><dd>{check.riskId ?? 'Not bound'}</dd>
            <dt className="text-muted">Architecture decision</dt><dd>{check.architectureDecisionId ?? 'Not bound'}</dd>
            <dt className="text-muted">Selection</dt><dd>{check.selection} · {check.state}</dd>
            <dt className="text-muted">Rationale</dt><dd>{check.rationale}</dd>
            <dt className="text-muted">Reason codes</dt><dd>{check.reasonCodes.join(' · ')}</dd>
          </dl>
          <div>
            <div className="mb-1 font-semibold text-[var(--text)]">Expected evidence ({check.expectedEvidence.length})</div>
            {check.expectedEvidence.length > 0
              ? <ul className="space-y-1">{check.expectedEvidence.map((evidence) => <li key={evidence.evidenceRequirementId} className="rounded border border-border bg-panel p-2"><span className="font-medium">{evidence.evidenceRequirementId}</span> · {evidence.kind} · {evidence.minimumTrustLevel}<div className="mt-0.5 text-muted">{evidence.description}</div></li>)}</ul>
              : <p className="rounded border border-warning/40 bg-warning/10 p-2 text-warning">No exact lifecycle evidence requirement is resolved for this check.</p>}
          </div>
        </div>
      </details>
    </li>
  );
}

function DevelopmentAssuranceObligations({ compilation }: { compilation: DevelopmentAssuranceCompilation }) {
  return (
    <section className="rounded-md border border-border" aria-labelledby="development-assurance-heading" data-testid="development-assurance-obligations">
      <div className="border-b border-border px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 id="development-assurance-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Development assurance obligations</h3>
            <p className="mt-1 break-all text-[10px] text-muted">{compilation.obligationSetId} · {compilation.obligationSetHash}</p>
          </div>
          <span className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${compilation.summary.readyForEvidence ? OBLIGATION_CLASSES.required : OBLIGATION_CLASSES.blocked}`}>{compilation.summary.readyForEvidence ? 'Awaiting evidence' : 'Needs resolution'}</span>
        </div>
        <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
          <div><dt className="inline font-semibold">Required:</dt> <dd className="inline">{compilation.summary.required}</dd></div>
          <div><dt className="inline font-semibold">Excluded:</dt> <dd className="inline">{compilation.summary.notApplicable}</dd></div>
          <div><dt className="inline font-semibold">Unresolved:</dt> <dd className="inline">{compilation.summary.unresolved}</dd></div>
          <div><dt className="inline font-semibold">Blocked:</dt> <dd className="inline">{compilation.summary.blocked}</dd></div>
        </dl>
        <dl
          className="mt-3 grid gap-x-3 gap-y-1 border-t border-border pt-2 text-[10px] sm:grid-cols-[auto_minmax(0,1fr)]"
          data-testid="development-assurance-binding"
        >
          <dt className="font-semibold text-muted">Feature</dt>
          <dd className="break-all">{compilation.binding.featureId} · {compilation.binding.revision}</dd>
          <dt className="font-semibold text-muted">Candidate</dt>
          <dd className="break-all">{compilation.binding.candidateId ?? 'Unresolved'}</dd>
          <dt className="font-semibold text-muted">Lifecycle plan</dt>
          <dd className="break-all">{compilation.binding.planId ?? 'Unresolved'}{compilation.binding.planVersion == null ? '' : ` · v${compilation.binding.planVersion}`}</dd>
          <dt className="font-semibold text-muted">Work package</dt>
          <dd className="break-all">
            {compilation.binding.workPackageId ?? 'Unresolved'}
            {compilation.binding.workPackageRevision == null ? '' : ` · revision ${compilation.binding.workPackageRevision}`}
            {compilation.binding.workPackageHash ? ` · ${compilation.binding.workPackageHash}` : ''}
          </dd>
          <dt className="font-semibold text-muted">Scope identity</dt>
          <dd className="break-all">{compilation.binding.scopeIdentity ?? 'Unresolved'}</dd>
        </dl>
      </div>
      <ol>{compilation.checks.map((check) => <DevelopmentAssuranceRow key={check.checkId} check={check} />)}</ol>
    </section>
  );
}

function ReviewTrustBadge({ state }: { state: FeatureAssuranceReviewTrustState }) {
  return (
    <span
      className={`rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${REVIEW_TRUST_CLASSES[state]}`}
      data-testid={`review-trust-${state}`}
    >
      {REVIEW_TRUST_LABELS[state]}
    </span>
  );
}

function SourceLocations({ locations }: { locations: FeatureAssuranceSourceLocation[] }) {
  return (
    <ul className="space-y-0.5">
      {locations.map((location) => (
        <li key={`${location.path}:${location.startLine}:${location.endLine}:${location.startColumn ?? 0}:${location.endColumn ?? 0}`} className="break-all font-mono text-[10px]">
          {location.path}:{location.startLine}{location.startColumn ? `:${location.startColumn}` : ''}–{location.endLine}{location.endColumn ? `:${location.endColumn}` : ''}
        </li>
      ))}
    </ul>
  );
}

function ReviewEvidence({ review }: { review: FeatureAssuranceReviewEvidence }) {
  return (
    <li className="rounded border border-border bg-bg p-3" data-testid={`feature-assurance-review-${review.reviewId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-[var(--text)]">{review.reviewId}</div>
          <div className="mt-0.5 text-[10px] text-muted">
            {review.reviewer.reviewerId} · {review.reviewer.reviewerKind} · {review.reviewer.executionId}
            {review.reviewer.model ? ` · ${review.reviewer.model}` : ''}
          </div>
        </div>
        <ReviewTrustBadge state={review.trustState} />
      </div>
      <dl className="mt-2 grid gap-x-3 gap-y-1 text-[10px] sm:grid-cols-[auto_minmax(0,1fr)]">
        <dt className="text-muted">Freshness</dt><dd>{review.freshness} · completed {review.completedAt}</dd>
        <dt className="text-muted">Subject</dt><dd className="break-all">{review.subjectId} · {review.subjectMatches ? 'exact match' : `submitted ${review.submittedSubjectId}`}</dd>
        <dt className="text-muted">Reviewed source</dt><dd><SourceLocations locations={review.reviewedSourceLocations} /></dd>
        <dt className="text-muted">Evidence use</dt><dd>{review.evidenceUsable ? 'Inspectable' : 'Insufficient'} · authorization {review.authorization}</dd>
      </dl>
      {review.issues.length > 0 && (
        <div className="mt-2 rounded border border-warning/40 bg-warning/10 p-2 text-[10px] text-warning" role="status">
          {review.issues.join(' ')}
        </div>
      )}
      <div className="mt-3">
        <h5 className="text-[10px] font-semibold uppercase tracking-wide text-muted">Findings ({review.findings.length})</h5>
        {review.findings.length > 0 ? (
          <ul className="mt-1 space-y-1.5">
            {review.findings.map((finding) => (
              <li key={finding.findingId} className="rounded border border-border bg-panel p-2 text-[10px]">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="font-semibold text-[var(--text)]">{finding.detection} · {finding.title}</span>
                  <span className="text-muted">{finding.severity} · {finding.disposition} · {finding.freshness}</span>
                </div>
                <p className="mt-1 text-[var(--text)]">{finding.description}</p>
                <div className="mt-1 text-muted">Reviewer: {finding.reviewer.reviewerId}</div>
                <div className="mt-1"><SourceLocations locations={finding.sourceLocations} /></div>
              </li>
            ))}
          </ul>
        ) : <p className="mt-1 text-[10px] text-muted">No findings returned for this bounded subject.</p>}
      </div>
    </li>
  );
}

function FeatureAssuranceReviews({ view }: { view: FeatureAssuranceReviewProjection }) {
  const insufficient = view.evidenceState === 'insufficient_evidence';
  return (
    <section className="rounded-md border border-border" aria-labelledby="feature-assurance-review-heading" data-testid="feature-assurance-review-view">
      <div className="border-b border-border p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 id="feature-assurance-review-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Independent review evidence</h3>
            <p className="mt-1 break-all text-[10px] text-muted">Bound subject: {view.subjectId}</p>
          </div>
          <span className={`rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${insufficient ? 'border-warning/40 bg-warning/10 text-warning' : 'border-success/40 bg-success/10 text-success'}`}>
            {insufficient ? 'Insufficient evidence' : 'Evidence available'}
          </span>
        </div>
        <p className={`mt-2 text-xs ${insufficient ? 'text-warning' : 'text-muted'}`} role={insufficient ? 'alert' : 'status'}>{view.reason}</p>
        <p className="mt-1 text-[10px] font-medium text-muted">Inspection evidence only · no approval authority · no lifecycle mutation</p>
        <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Review trust state summary">
          {(Object.keys(REVIEW_TRUST_LABELS) as FeatureAssuranceReviewTrustState[]).map((state) => (
            <span key={state} className="inline-flex items-center gap-1">
              <ReviewTrustBadge state={state} />
              <span className="text-[10px] text-muted">{view.trustStateCounts[state]}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="grid gap-3 p-3 lg:grid-cols-3">
        {view.axes.map((axis) => (
          <section key={axis.axis} className="min-w-0 rounded border border-border bg-panel p-2" aria-label={`${REVIEW_AXIS_LABELS[axis.axis]} review axis`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold text-[var(--text)]">{REVIEW_AXIS_LABELS[axis.axis]}</h4>
              <span className={`text-[10px] font-medium ${axis.evidenceState === 'insufficient_evidence' ? 'text-warning' : 'text-muted'}`}>
                {axis.required ? 'Independent required' : 'Advisory'} · {axis.evidenceState === 'available' ? `${axis.independentReviewCount} independent` : 'insufficient evidence'}
              </span>
            </div>
            {axis.reviews.length > 0
              ? <ul className="mt-2 space-y-2">{axis.reviews.map((review) => <ReviewEvidence key={review.reviewId} review={review} />)}</ul>
              : <p className="mt-2 rounded border border-warning/40 bg-warning/10 p-2 text-[10px] text-warning">No review evidence is available for this axis.</p>}
          </section>
        ))}
      </div>
    </section>
  );
}

function Chain({ chain, onNavigate, onOpenEvidence }: { chain: FeatureAssuranceChain; onNavigate?: (kind: string, id: string) => void; onOpenEvidence?: (id: string) => void }) {
  const requirement = chain.requirement.value;
  const criterion = chain.acceptanceCriterion.value;
  const story = chain.story.value;
  const control = chain.control.value;
  const workPackage = chain.workPackage.value;
  return (
    <li className="border-b border-border last:border-b-0">
      <details>
        <summary className="cursor-pointer px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent">
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-sm font-medium text-[var(--text)]">{requirement?.id ?? 'Missing requirement'} → {criterion?.id ?? `Missing acceptance criterion${chain.acceptanceCriterion.expectedId ? ` ${chain.acceptanceCriterion.expectedId}` : ''}`} → {story?.id ?? `Missing story${chain.story.expectedId ? ` ${chain.story.expectedId}` : ''}`} → {control?.id ?? `Missing control${chain.control.expectedId ? ` ${chain.control.expectedId}` : ''}`}</span>
            <StatusBadge status={chain.status} />
          </span>
        </summary>
        <div className="space-y-3 border-t border-border bg-bg px-3 py-3 text-xs">
          <div className="grid gap-2 sm:grid-cols-2">
            <div><NodeLabel label="Requirement" value={requirement ? `${requirement.id} · ${requirement.text}` : `Unavailable${chain.requirement.expectedId ? ` · expected ${chain.requirement.expectedId}` : ''}`} onNavigate={requirement && onNavigate ? () => onNavigate('requirement', requirement.id) : undefined} /><IdentityState label="Identity" state={chain.requirement.identity} /></div>
            <div><NodeLabel label="Acceptance criterion" value={criterion ? `${criterion.id} · ${criterion.text}` : `Unavailable${chain.acceptanceCriterion.expectedId ? ` · expected ${chain.acceptanceCriterion.expectedId}` : ''}`} onNavigate={criterion && onNavigate ? () => onNavigate('acceptance-criterion', criterion.id) : undefined} /><IdentityState label="Identity" state={chain.acceptanceCriterion.identity} /></div>
            <div><NodeLabel label="Story" value={story ? `${story.id} · ${story.title}` : `Unavailable${chain.story.expectedId ? ` · expected ${chain.story.expectedId}` : ''}`} onNavigate={story && onNavigate ? () => onNavigate('story', story.id) : undefined} /><IdentityState label="Identity" state={chain.story.identity} /></div>
            <div><NodeLabel label="Control" value={control ? `${control.id} · ${control.title}` : `Unavailable${chain.control.expectedId ? ` · expected ${chain.control.expectedId}` : ''}`} onNavigate={control && onNavigate ? () => onNavigate('control', control.id) : undefined} /><IdentityState label="Identity" state={chain.control.identity} /></div>
          </div>

          <section aria-label="Evidence records">
            <h4 className="mb-1 flex items-center gap-1 font-semibold text-[var(--text)]"><GitBranch size={13} aria-hidden="true" /> Evidence ({chain.evidence.length})</h4>
            {chain.evidence.length > 0 ? <ul className="space-y-1.5">{chain.evidence.map((evidence) => <EvidenceRow key={evidence.id} evidence={evidence} onOpenEvidence={onOpenEvidence} />)}</ul> : <p className="rounded border border-warning/40 bg-warning/10 p-2 text-warning">No evidence record is bound to this complete chain.</p>}
          </section>

          <section aria-label="Decisions">
            <h4 className="mb-1 font-semibold text-[var(--text)]">Decisions ({chain.decisions.length})</h4>
            {chain.decisions.length > 0
              ? <ul className="space-y-1.5">{chain.decisions.map((decision) => <DecisionRow key={decision.id} decision={decision} onNavigate={onNavigate} />)}</ul>
              : <p className="rounded border border-warning/40 bg-warning/10 p-2 text-warning">No decision is bound to this complete chain.</p>}
          </section>

          <section aria-label="Work package facts">
            <h4 className="mb-1 font-semibold text-[var(--text)]">Work-package facts</h4>
            {workPackage ? <div className="rounded border border-border bg-panel p-2"><div className="font-medium">{workPackage.id}</div><IdentityState label="Identity" state={chain.workPackage.identity} /><dl className="mt-2 grid gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">{workPackage.facts.map((fact) => <div key={fact.label} className="contents"><dt className="text-muted">{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl></div> : <p className="rounded border border-warning/40 bg-warning/10 p-2 text-warning">Work-package facts are unavailable for this story.</p>}
          </section>

          {chain.gaps.length > 0 && <div className="rounded border border-error/40 bg-error/10 p-2" role="alert"><div className="mb-1 flex items-center gap-1 font-semibold text-error"><AlertTriangle size={13} aria-hidden="true" /> Relationship gaps</div><ul className="space-y-1 text-[var(--text)]">{chain.gaps.map((gap, index) => <li key={`${gap.kind}-${gap.relatedId ?? index}`}>{gap.status}: {gap.message}</li>)}</ul></div>}
        </div>
      </details>
    </li>
  );
}

export default function FeatureAssuranceMap({ projection, onNavigate, onOpenEvidence }: { projection: FeatureAssuranceMapProjection; onNavigate?: (kind: string, id: string) => void; onOpenEvidence?: (id: string) => void }) {
  return (
    <div className="space-y-3" data-testid="feature-assurance-map">
      <div className="rounded-md border border-border bg-panel p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h3 className="text-sm font-semibold text-[var(--text)]">Feature Assurance Map</h3><p className="mt-1 text-xs text-muted">Read-only projection for {projection.feature.id} · {projection.feature.title}</p><p className="mt-1 text-[10px] text-muted">Feature identity: {displayIdentity(projection.feature.identity)}</p></div>
          <span className="rounded border border-border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">No lifecycle mutation</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Assurance map status summary">{(Object.keys(STATUS_LABELS) as FeatureAssuranceStatus[]).map((status) => <span key={status} className="inline-flex items-center gap-1"><StatusBadge status={status} /><span className="text-[10px] text-muted">{projection.summary[status]}</span></span>)}</div>
      </div>
      {projection.developmentAssurance && <DevelopmentAssuranceObligations compilation={projection.developmentAssurance} />}
      {projection.reviewView && <FeatureAssuranceReviews view={projection.reviewView} />}
      <section className="rounded-md border border-border" aria-labelledby="feature-assurance-chain-heading">
        <h3 id="feature-assurance-chain-heading" className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted">Requirement → acceptance criterion → story → control → evidence → decision</h3>
        {projection.chains.length > 0 ? <ol>{projection.chains.map((chain) => <Chain key={chain.key} chain={chain} onNavigate={onNavigate} onOpenEvidence={onOpenEvidence} />)}</ol> : <p className="p-3 text-xs text-warning">No traceable requirement chain is available for this feature.</p>}
      </section>
      {(projection.unlinkedEvidence.length > 0 || projection.unlinkedDecisions.length > 0) && <section className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs" role="status"><h3 className="font-semibold text-warning">Unlinked records</h3><p className="mt-1 text-[var(--text)]">These records are visible but cannot satisfy a chain until their bindings match the current feature revision and plan.</p><ul className="mt-2 list-disc pl-4 text-[var(--text)]">{projection.unlinkedEvidence.map((item) => <li key={item.id}>Evidence {item.id} · {item.source} · {item.observedAt ?? 'timestamp unavailable'}</li>)}{projection.unlinkedDecisions.map((item) => <li key={item.id}>Decision {item.id} · {item.source} · {item.createdAt ?? 'timestamp unavailable'}</li>)}</ul></section>}
    </div>
  );
}
