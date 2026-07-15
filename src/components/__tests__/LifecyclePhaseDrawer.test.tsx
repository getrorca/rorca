/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  LifecycleEvaluatedStatus,
  LifecycleEvidenceDetail,
  LifecyclePhaseResponse,
  LifecyclePortfolioItem,
  LifecycleQueryState,
  LifecycleSpecResponse,
} from '../../types/lifecycle';
import LifecyclePhaseDrawer from '../LifecyclePhaseDrawer';

const MARKS = { snapshotId: 'snapshot-1', evidenceHighWaterMark: 'evidence:4', decisionHighWaterMark: 'decision:2' };

function phase(status: LifecycleEvaluatedStatus = 'blocked'): LifecyclePhaseResponse {
  return {
    workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'validation', state: status === 'stale' ? 'stale' : 'current', status,
    disposition: status === 'deferred' ? 'deferred' : status === 'not_applicable' ? 'not_applicable' : 'required',
    whyRequired: 'Tenant isolation must be verified before release.',
    mappedRequirements: { items: ['REQ-002'], total: 1, truncated: false },
    mappedDecisions: { items: ['ADR-004'], total: 1, truncated: false },
    mappedStories: { items: ['US-006'], total: 1, truncated: false },
    governedDecisions: { items: [], total: 0, truncated: false },
    requiredGates: {
      items: [{
        gateId: 'gate-validation', phaseId: 'validation', title: 'Tenant isolation integration test',
        evidenceKind: 'automated_validation', subjectRevisionRequirement: 'current_commit', approvalRequirement: 'none',
        expirationPolicy: 'when_subject_changes', blockingSeverity: 'blocking', evidenceRequirementIds: ['evr-1'],
        acceptedSubjectTypes: ['commit_sha'], downstreamSubjectCoherence: { qa: 'same_subject', merge: 'same_subject', production: 'same_subject' },
        evaluation: { status, rationale: 'Current bounded evaluation.', blockerReason: status === 'blocked' ? 'Test failed.' : null, nextSafeAction: 'Retry the failed story.', evidenceCount: 1, decisionCount: 0 },
      }, {
        gateId: 'gate-missing', phaseId: 'validation', title: 'Manual acceptance judgment',
        evidenceKind: 'qa_assessment', subjectRevisionRequirement: 'current_commit', approvalRequirement: 'human',
        expirationPolicy: 'when_subject_changes', blockingSeverity: 'blocking', evidenceRequirementIds: ['evr-2'],
        acceptedSubjectTypes: ['commit_sha'], downstreamSubjectCoherence: { qa: 'same_subject', merge: 'same_subject', production: 'same_subject' },
        evaluation: null,
      }],
      total: 2,
      truncated: false,
    },
    evidence: {
      items: [{
        id: '7', evidenceType: 'automated_validation', sourceSystem: 'GitHub Actions', sourceEventId: 'check-7',
        status: status === 'passed' ? 'passed' : 'story_caused_failure', trustLevel: 'provider_verified', confidence: 0.98,
        observedAt: '2026-07-15T12:00:00.000Z', subject: { type: 'commit_sha', value: 'abc123' }, gateId: 'gate-validation',
        storyId: 'US-006', runId: 913, currentRevision: status !== 'stale', stale: status === 'stale',
        invalidReasons: status === 'stale' ? ['subject_revision_mismatch'] : [],
      }],
      total: 4,
      hasMore: true,
    },
    blocker: status === 'blocked' ? { gateId: 'gate-validation', reason: 'Tenant isolation test failed.' } : null,
    nextSafeActionGuidance: {
      action: status === 'passed' ? 'No action is required for this phase.' : 'Retry the failed story only.',
      rationale: 'The backend evaluator found one bounded failed gate.', confidence: 0.95, classifier: 'phase_evaluator',
    },
    nextSafeAction: 'Legacy text must not render.',
    permittedActions: status === 'blocked' ? ['inspect_evidence', 'retry_smallest_scope', 'run_phase'] : ['inspect_evidence'],
    evaluationSnapshot: { ...MARKS, planId: 'plan-a', planVersion: 3, inputHash: 'sha256:input', activeReleaseSubject: { type: 'commit_sha', value: 'abc123' }, policyVersion: '1', compilerVersion: '1', evaluatedAt: '2026-07-15T12:01:00.000Z' },
    ...MARKS,
  };
}

const portfolioItem = {
  specId: 'spec-a', title: 'Billing anomaly alerts', specStatus: 'approved', state: 'current', overallStatus: 'blocked', risk: 'high', owner: null,
  storySummary: { total: 1, passed: 0, failed: 1 }, currentPhaseId: 'validation', blocked: true, blockers: [], liveness: null,
  currentRevision: { specVersion: '7', inputHash: 'sha256:input', planVersion: 3 }, phases: [], updatedAt: '2026-07-15T11:58:00.000Z',
} satisfies LifecyclePortfolioItem;

const spec = {
  workspaceId: 'ws-1', specId: 'spec-a', title: 'Billing anomaly alerts', state: 'current', plan: null, provenance: null,
  overallReadiness: { ready: false, completionRate: 0.5, counts: null }, phaseTimeline: [],
  traceability: { requirements: { items: [], total: 0, truncated: false }, stories: { items: [], total: 0, truncated: false }, architectureDecisions: { items: [], total: 0, truncated: false }, gates: { items: [], total: 0, truncated: false }, evidence: { total: 1, validForCurrentRevision: 1, stale: 0, boundedAt: 200 } },
  currentRun: null, evaluationSnapshot: MARKS, ...MARKS,
} satisfies LifecycleSpecResponse;

function evidenceQuery(data: LifecycleEvidenceDetail | null = null): LifecycleQueryState<LifecycleEvidenceDetail> {
  return { data, snapshotId: data?.snapshotId ?? null, loading: false, refreshing: false, stale: false, partial: false, error: null };
}

function renderDrawer(overrides: Partial<React.ComponentProps<typeof LifecyclePhaseDrawer>> = {}) {
  const props: React.ComponentProps<typeof LifecyclePhaseDrawer> = {
    phase: phase(), spec, portfolioItem, evidence: evidenceQuery(), selectedEvidenceId: null, selectedEvidenceSnapshotId: null,
    onOpenEvidence: vi.fn(), onCloseEvidence: vi.fn(), onRefreshEvidence: vi.fn(), onClose: vi.fn(), onAction: vi.fn(), actionPending: null,
    ...overrides,
  };
  return { ...render(<LifecyclePhaseDrawer {...props} />), props };
}

describe('LifecyclePhaseDrawer', () => {
  it('renders the complete header and ordered traceability sections with explicit unknowns', () => {
    renderDrawer();
    expect(screen.getByText('Billing anomaly alerts')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Validation phase' })).toBeInTheDocument();
    expect(screen.getByText('0 of 2 gates passed')).toBeInTheDocument();
    expect(screen.getByText(/Revision: Spec 7 · Plan 3 · sha256:input/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close phase details' })).toBeInTheDocument();

    const headings = ['Why required', 'Mapped requirements, decisions, and stories', 'Requirement-to-evidence traceability', 'Required gates', 'Bounded evidence', 'Blocker', 'Liveness', 'Next safe action'];
    const positions = headings.map((name) => screen.getByRole('heading', { name }).compareDocumentPosition(document.body));
    expect(positions).toHaveLength(8);
    const ordered = headings.map((name) => screen.getByRole('heading', { name }));
    ordered.slice(1).forEach((node, index) => expect(ordered[index].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());

    expect(screen.getByText('REQ-002')).toBeInTheDocument();
    expect(screen.getByText('ADR-004')).toBeInTheDocument();
    expect(screen.getByText('US-006')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 4 evidence records.')).toBeInTheDocument();
    expect(screen.getByText('Supporting evidence is missing or unknown.')).toBeInTheDocument();
    expect(screen.queryByText(/source, time, and revision match/i)).not.toBeInTheDocument();
  });

  it.each(['blocked', 'passed', 'deferred', 'not_applicable', 'stale', 'awaiting_approval'] as LifecycleEvaluatedStatus[])(
    'renders the backend %s state without inventing guidance',
    (status) => {
      const value = phase(status);
      renderDrawer({ phase: value });
      expect(screen.getAllByText(status === 'stale' ? 'Stale warning' : status.replace(/_/g, ' '), { exact: false }).length).toBeGreaterThan(0);
      expect(screen.getByText(value.nextSafeActionGuidance.action)).toBeInTheDocument();
      expect(screen.getByText(/Backend classifier: Phase evaluator · 95% confidence/)).toBeInTheDocument();
      expect(screen.queryByText('Legacy text must not render.')).not.toBeInTheDocument();
    },
  );

  it('drills requirement, decision, and story rows into the bounded traceability view', async () => {
    const user = userEvent.setup();
    renderDrawer();
    for (const reference of ['REQ-002', 'ADR-004', 'US-006']) {
      await user.click(screen.getByRole('button', { name: `Open traceability for ${reference}` }));
      expect(screen.getByRole('heading', { name: 'Requirement-to-evidence traceability' }).parentElement).toHaveFocus();
    }
  });

  it('exposes source, time, revision match, and evidence drill-down from gate and evidence rows', async () => {
    const user = userEvent.setup();
    const onOpenEvidence = vi.fn();
    renderDrawer({ onOpenEvidence });
    const gate = screen.getByRole('button', { name: /Tenant isolation integration test.*Open supporting evidence/i });
    expect(gate).toHaveTextContent('Source: GitHub Actions');
    expect(gate).toHaveTextContent('Current revision');
    expect(within(gate).getByText((_content, element) => element?.tagName === 'TIME')).toHaveAttribute('dateTime', '2026-07-15T12:00:00.000Z');
    await user.click(gate);
    expect(onOpenEvidence).toHaveBeenCalledWith('7');
    expect(screen.getByRole('button', { name: /Manual acceptance judgment.*Supporting evidence unavailable/i })).toBeDisabled();
  });

  it('restores focus to the evidence row when the inspector closes', async () => {
    const user = userEvent.setup();
    const rendered = renderDrawer();
    const evidenceRow = screen.getByRole('button', { name: /automated_validation.*GitHub Actions/i });
    await user.click(evidenceRow);
    rendered.rerender(<LifecyclePhaseDrawer {...rendered.props} selectedEvidenceId="7" selectedEvidenceSnapshotId={MARKS.snapshotId} />);
    await user.click(screen.getByRole('button', { name: 'Close Evidence Inspector' }));
    expect(rendered.props.onCloseEvidence).toHaveBeenCalled();
    await waitFor(() => expect(evidenceRow).toHaveFocus());
  });

  it('shows only the sticky actions authorized by the server', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderDrawer({ onAction });
    const footer = screen.getByLabelText('Server-permitted phase actions');
    expect(within(footer).getByRole('button', { name: /Retry story/ })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: /Open run/ })).toBeInTheDocument();
    expect(within(footer).queryByRole('button', { name: /Review override|Recompile|Request approval/ })).not.toBeInTheDocument();
    await user.click(within(footer).getByRole('button', { name: /Retry story/ }));
    expect(onAction).toHaveBeenCalledWith('retry_smallest_scope');
  });

  it('exposes a provenance-linked reviewable Learn candidate and its evidence chain', async () => {
    const user = userEvent.setup();
    const onOpenEvidence = vi.fn();
    const learnPhase: LifecyclePhaseResponse = {
      ...phase('passed'),
      phaseId: 'learn',
      status: 'passed',
      learn: {
        requiredCandidateCount: 1,
        candidateCount: 1,
        sourceEvidenceCount: 2,
        reviewStates: { review_required: 1 },
        generation: { state: 'generated', attemptedAt: '2026-07-15T12:02:00.000Z', blocker: null },
        candidates: {
          total: 1,
          truncated: false,
          items: [{
            id: 91,
            status: 'review_required',
            category: 'Decision',
            confidence: 'high',
            securitySensitive: false,
            defaultRetrievalEligible: false,
            createdAt: '2026-07-15T12:02:00.000Z',
            provenance: {
              workspaceId: 'ws-1', specId: 'spec-a', runId: 913, storyId: 'US-006', commitSha: 'abc123',
              releaseSubject: { type: 'commit_sha', value: 'abc123' }, sourceEvidenceIds: ['7', 'EVD-sha256:host'],
              sourceDecisionIds: ['CLO-sha256:accepted'], deduplicationKey: 'sha256:dedupe',
            },
          }],
        },
        nextAction: 'Review 1 provenance-linked candidate.',
      },
    };
    renderDrawer({ phase: learnPhase, onOpenEvidence });

    const learn = screen.getByTestId('lifecycle-learn-closeout');
    expect(within(learn).getByText('1/1')).toBeInTheDocument();
    expect(within(learn).getByText('Decision candidate #91')).toBeInTheDocument();
    expect(within(learn).getByText(/Workspace ws-1 · Spec spec-a · Run 913 · Story US-006/)).toBeInTheDocument();
    expect(within(learn).getByText(/Default retrieval: Not eligible/)).toBeInTheDocument();
    await user.click(within(learn).getByRole('button', { name: 'Evidence 7' }));
    expect(onOpenEvidence).toHaveBeenCalledWith('7');
  });

  it('keeps long evidence payload and provenance collapsed by default', () => {
    const detail = {
      id: '7', workspaceId: 'ws-1', specId: 'spec-a', scope: { workspaceId: 'ws-1', specSlug: 'spec-a', runId: 913, storyId: 'US-006', phaseId: 'validation', gateId: 'gate-validation' },
      source: { type: 'ci', system: 'GitHub Actions', eventId: 'check-7' }, observedAt: '2026-07-15T12:00:00.000Z', createdAt: null,
      subject: { type: 'commit_sha', value: 'abc123' }, phaseSubject: null, releaseIdentity: { commitSha: 'abc123', artifactDigest: null, deploymentId: null },
      classification: 'automated_validation', status: 'passed', trustLevel: 'provider_verified', confidence: 0.98, excerpt: 'A very long payload', actor: null, rationale: null,
      expiresAt: null, environment: null, redactionState: 'normalized_redacted', details: {}, provenanceChain: [], revisionMismatch: false, eligibleForActiveGate: true, invalidReasons: [], lineageVerified: true, payloadHash: 'sha256:payload', sourcePayloadHash: null,
      rawReference: { available: false, accessTier: 'auth', allowed: false, kind: 'unknown', label: 'No raw reference', reference: null, href: null, external: false, rawPayloadIncluded: false }, ...MARKS,
    } satisfies LifecycleEvidenceDetail;
    renderDrawer({ selectedEvidenceId: '7', selectedEvidenceSnapshotId: MARKS.snapshotId, evidence: evidenceQuery(detail) });
    const disclosure = screen.getByText('Bounded normalized payload and provenance').closest('details');
    expect(disclosure).not.toHaveAttribute('open');
  });
});
