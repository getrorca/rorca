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
  LifecycleAdviceResponse,
  LifecycleEvaluatedStatus,
  LifecycleDevelopmentExecution,
  LifecycleEvidenceDetail,
  LifecyclePhaseResponse,
  LifecycleSourceMaterial,
  LifecyclePortfolioItem,
  LifecycleQueryState,
  LifecycleSpecResponse,
} from '../../types/lifecycle';
import type { SpecCoverageByPhase, SpecCoveragePhaseEntry } from '../../lib/specWorkflow';
import { testA11y } from '../../test/a11y-helpers';
import LifecyclePhaseView from '../LifecyclePhaseView';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn().mockResolvedValue({
    exportKit: {
      status: 'current',
      reason: null,
      identity: {
        manifestHash: `sha256:${'a'.repeat(64)}`,
        kitPath: `forge/export-kits/spec-a/${'b'.repeat(64)}`,
        artifacts: {
          spec: { path: 'spec.json', contentHash: `sha256:${'1'.repeat(64)}` },
          requirements: { path: 'PRD.md', contentHash: `sha256:${'2'.repeat(64)}` },
          design: { path: 'SDD.md', contentHash: `sha256:${'3'.repeat(64)}` },
          delivery: { path: 'PLAN.md', contentHash: `sha256:${'4'.repeat(64)}` },
        },
      },
    },
  }),
}));

const MARKS = { snapshotId: 'snapshot-1', evidenceHighWaterMark: 'evidence:4', decisionHighWaterMark: 'decision:2' };

function phase(status: LifecycleEvaluatedStatus = 'blocked'): LifecyclePhaseResponse {
  return {
    workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing', state: status === 'stale' ? 'stale' : 'current', status, ownStatus: status, dependencyStatus: 'ready',
    disposition: status === 'deferred' ? 'deferred' : status === 'not_applicable' ? 'not_applicable' : 'required',
    whyRequired: 'Tenant isolation must be verified before release.',
    mappedRequirements: { items: ['REQ-002'], total: 1, truncated: false },
    mappedDecisions: { items: ['ADR-004'], total: 1, truncated: false },
    mappedStories: { items: ['US-006'], total: 1, truncated: false },
    governedDecisions: { items: [], total: 0, truncated: false },
    requiredGates: {
      items: [{
        gateId: 'gate-validation', phaseId: 'testing', title: 'Tenant isolation integration test',
        evidenceKind: 'automated_validation', subjectRevisionRequirement: 'current_commit', approvalRequirement: 'none',
        expirationPolicy: 'when_subject_changes', blockingSeverity: 'blocking', evidenceRequirementIds: ['evr-1'],
        acceptedSubjectTypes: ['commit_sha'], downstreamSubjectCoherence: { testing: 'same_subject', deployment: 'same_subject' },
        evaluation: { status, rationale: 'Current bounded evaluation.', blockerReason: status === 'blocked' ? 'Test failed.' : null, nextSafeAction: 'Retry the failed story.', evidenceCount: 1, decisionCount: 0 },
      }, {
        gateId: 'gate-missing', phaseId: 'testing', title: 'Manual acceptance judgment',
        evidenceKind: 'qa_assessment', subjectRevisionRequirement: 'current_commit', approvalRequirement: 'human',
        expirationPolicy: 'when_subject_changes', blockingSeverity: 'blocking', evidenceRequirementIds: ['evr-2'],
        acceptedSubjectTypes: ['commit_sha'], downstreamSubjectCoherence: { testing: 'same_subject', deployment: 'same_subject' },
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

function developmentExecution(): LifecycleDevelopmentExecution {
  const items: LifecycleDevelopmentExecution['stories']['items'] = Array.from({ length: 10 }, (_, index) => {
    const storyNumber = index + 1;
    const passed = storyNumber <= 6;
    const running = storyNumber === 7;
    return {
      storyId: `ACC-${String(storyNumber).padStart(3, '0')}`,
      status: passed ? 'passed' : running ? 'running' : 'pending',
      attempts: passed || running ? 1 : 0,
      elapsedSeconds: passed ? 600 : null,
      modelUsed: passed || running ? 'openai-codex/gpt-5.6-sol' : null,
      commitSha: passed ? String(storyNumber).repeat(40).slice(0, 40) : null,
      integrationState: passed ? 'finalized' : null,
      resultingHead: passed ? 'a'.repeat(40) : null,
      failureReason: null,
    };
  });
  return {
    run: {
      id: '64',
      status: 'running',
      agentType: 'omp',
      startedAt: '2026-07-15T12:00:00.000Z',
      finishedAt: null,
    },
    activityStatus: 'in_progress',
    currentStoryId: 'ACC-007',
    stories: { total: 10, passed: 6, failed: 0, items },
    source: {
      worktreePath: '/workspace/spec-a',
      branch: 'feat/spec-a',
      baseCommit: 'b'.repeat(40),
      resultingHead: 'a'.repeat(40),
      dirty: false,
    },
    changes: {
      commits: 6,
      additions: null,
      deletions: null,
      files: [{ path: 'src/accountant-copilot.ts', change: 'modified' }],
    },
    verification: {
      hostReview: { status: 'passed', evidence: '6 canonical local-review bundles' },
      unit: { status: 'passed', evidence: '6 host-observed validation receipts' },
      typecheck: { status: 'missing', evidence: null },
      build: { status: 'missing', evidence: null },
      security: { status: 'missing', evidence: null },
      secrets: { status: 'missing', evidence: null },
      dependencies: { status: 'missing', evidence: null },
    },
    integration: { finalized: 6, failed: 0, expected: 10, conflicted: 0, resultingHead: 'a'.repeat(40) },
  };
}

function sourceMaterial(lens: 'planning' | 'requirements' | 'design', verified = false): LifecycleSourceMaterial {
  return {
    state: 'available',
    schemaVersion: 'rorca.lifecycle-source-material.v1',
    lens,
    package: {
      packageId: 'billing-security-delivery-pack',
      title: 'Billing Security',
      workspaceId: 'billing',
      status: verified ? 'published' : 'ready_for_review',
      publicationStatus: verified ? 'published' : 'draft-not-published',
      authoritative: verified,
      scope: 'entire-project-kb',
      contentHash: `sha256:${'a'.repeat(64)}`,
      previewHash: `sha256:${'b'.repeat(64)}`,
      snapshotHash: `sha256:${'c'.repeat(64)}`,
    },
    authority: {
      status: verified ? 'verified' : 'context_only',
      reasonCode: verified ? 'verified' : 'authority_receipt_not_declared',
      rationale: verified ? 'Canonical package authority verified.' : 'Draft package has no canonical publication authority.',
      receiptId: verified ? `package-event:sha256:${'1'.repeat(64)}` : null,
      receiptHash: verified ? `sha256:${'2'.repeat(64)}` : null,
      manifestHash: verified ? `sha256:${'3'.repeat(64)}` : null,
      releaseSubject: verified ? { type: 'spec_hash', value: `sha256:${'4'.repeat(64)}` } : null,
    },
    match: {
      method: 'referenced_source_overlap',
      confidence: 0.86,
      referencesMatched: ['docs/security.md'],
      rationale: 'One spec context source also appears in this export manifest.',
    },
    inventory: {
      evidenceCount: 14,
      excludedCount: 3,
      warningCount: 1,
      contradictionCount: 0,
      uncertaintyCount: 0,
      warnings: ['Selected evidence includes non-approved material.'],
      contradictions: [],
      uncertainties: [],
    },
    artifacts: [{
      name: 'PRD.md',
      label: 'Product requirements',
      role: 'requirements',
      relativePath: 'genesis/artifacts/export-packs/billing/PRD.md',
      sizeBytes: 2_048,
      modifiedAt: '2026-07-15T12:00:00.000Z',
      contentHash: `sha256:${'d'.repeat(64)}`,
    }, {
      name: 'SDD.md',
      label: 'System design',
      role: 'design',
      relativePath: 'genesis/artifacts/export-packs/billing/SDD.md',
      sizeBytes: 4_096,
      modifiedAt: '2026-07-15T12:00:00.000Z',
      contentHash: `sha256:${'e'.repeat(64)}`,
    }],
    synthesis: {
      title: lens === 'planning'
        ? 'Planning synthesis from the exact export bundle'
        : lens === 'requirements'
          ? 'Requirements synthesis from the exact export bundle'
          : 'Design synthesis from the exact export bundle',
      description: 'Exact source wording with bounded citations.',
      sections: [{
        id: `${lens}-section`,
        title: lens === 'planning' ? 'Mission and scope' : lens === 'requirements' ? 'Functional requirements' : 'Authorization boundaries',
        content: lens === 'planning' ? 'Plan the bounded tenant cutover.' : lens === 'requirements' ? 'REQ-1 Deny cross-tenant reads.' : 'Forced RLS and workspace membership.',
        sourcePath: lens === 'design'
          ? 'genesis/artifacts/export-packs/billing/SDD.md'
          : 'genesis/artifacts/export-packs/billing/PRD.md',
        startLine: 12,
        endLine: 18,
        truncated: false,
        sourceContentHash: lens === 'design' ? `sha256:${'e'.repeat(64)}` : `sha256:${'d'.repeat(64)}`,
        freshness: 'current',
      }],
      sourcePackageHash: `sha256:${'a'.repeat(64)}`,
    },
  };
}

const portfolioItem = {
  specId: 'spec-a', title: 'Billing anomaly alerts', specStatus: 'approved', state: 'current', overallStatus: 'blocked', risk: 'high', owner: null,
  storySummary: { total: 1, passed: 0, failed: 1 }, currentPhaseId: 'testing', blocked: true, blockers: [], liveness: null,
  currentRevision: { specVersion: '7', inputHash: 'sha256:input', planVersion: 3 }, phases: [], updatedAt: '2026-07-15T11:58:00.000Z',
  readiness: {
    execution: { status: 'completed', runId: 913, rationale: 'Run 913 completed.' },
    assurance: { status: 'partial', passedControls: 4, totalControls: 11, pendingPolicyApprovals: 1, pendingHumanApprovals: 2, rationale: 'Assurance is partial.' },
    delivery: { status: 'in_progress', rationale: 'Current delivery is reconciling.', reconciledAt: null, reconciliation: null },
  },
  delivery: { status: 'in_progress', rationale: 'Current delivery run is active.', reconciledAt: null },
  assurance: { status: 'partial', passedControls: 4, totalControls: 11, coverage: 4 / 11, rationale: 'Assurance is partial.' },
  reconciliation: null,
} satisfies LifecyclePortfolioItem;

const spec = {
  workspaceId: 'ws-1', specId: 'spec-a', title: 'Billing anomaly alerts', state: 'current', plan: null, provenance: null,
  overallReadiness: { ready: false, completionRate: 0.5, counts: null }, phaseTimeline: [],
  readiness: {
    execution: { status: 'completed', runId: 913, rationale: 'Run 913 completed.' },
    assurance: { status: 'partial', passedControls: 4, totalControls: 11, pendingPolicyApprovals: 1, pendingHumanApprovals: 2, rationale: 'Assurance is partial.' },
    delivery: { status: 'in_progress', rationale: 'Current delivery is reconciling.', reconciledAt: null, reconciliation: null },
  },
  delivery: { status: 'in_progress', rationale: 'Current delivery run is active.', reconciledAt: null },
  assurance: { status: 'partial', passedControls: 4, totalControls: 11, coverage: 4 / 11, rationale: 'Assurance is partial.' },
  reconciliation: null,
  traceability: { requirements: { items: [], total: 0, truncated: false }, stories: { items: [], total: 0, truncated: false }, architectureDecisions: { items: [], total: 0, truncated: false }, gates: { items: [], total: 0, truncated: false }, evidence: { total: 1, validForCurrentRevision: 1, stale: 0, boundedAt: 200 } },
  currentRun: null, evaluationSnapshot: MARKS, ...MARKS,
} satisfies LifecycleSpecResponse;

function evidenceQuery(data: LifecycleEvidenceDetail | null = null): LifecycleQueryState<LifecycleEvidenceDetail> {
  return { data, snapshotId: data?.snapshotId ?? null, loading: false, refreshing: false, stale: false, partial: false, error: null };
}

function renderPhaseView(overrides: Partial<React.ComponentProps<typeof LifecyclePhaseView>> = {}) {
  const props: React.ComponentProps<typeof LifecyclePhaseView> = {
    phase: phase(), spec, portfolioItem, evidence: evidenceQuery(), selectedEvidenceId: null, selectedEvidenceSnapshotId: null,
    onOpenEvidence: vi.fn(), onCloseEvidence: vi.fn(), onRefreshEvidence: vi.fn(), onClose: vi.fn(), onSelectPhase: vi.fn(), onAction: vi.fn(), actionPending: null,
    ...overrides,
  };
  return { ...render(<LifecyclePhaseView {...props} />), props };
}

describe('LifecyclePhaseView', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
  });
  it('keeps the phase overview compact and reveals details only on demand', async () => {
    const user = userEvent.setup();
    const { props } = renderPhaseView();
    expect(screen.getAllByText('Billing anomaly alerts')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Testing phase' })).toBeInTheDocument();
    expect(screen.getByText('0/2 gates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to board' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Phase detail view' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Switch lifecycle stage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Testing/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /Deployment/ }));
    expect(props.onSelectPhase).toHaveBeenCalledWith('deployment');

    const phaseStats = screen.getByLabelText('Phase status at a glance');
    expect(within(phaseStats).getByText('4 records')).toBeInTheDocument();
    expect(within(phaseStats).getByText('0 recorded')).toBeInTheDocument();
    const exportKit = screen.getByRole('heading', { name: 'Canonical export kit' }).closest('section')!;
    await waitFor(() => expect(within(exportKit).getByText('Current')).toBeInTheDocument());
    expect(within(exportKit).getByText('PRD')).toBeInTheDocument();
    expect(within(exportKit).getByText('SDD')).toBeInTheDocument();
    expect(within(exportKit).getByText('PLAN')).toBeInTheDocument();
    expect(screen.getByTestId('phase-overview-context')).toHaveAttribute('hidden');
    expect(screen.getByTestId('phase-overview-gates')).not.toHaveAttribute('hidden');
    expect(screen.getByTestId('phase-overview-evidence')).toHaveAttribute('hidden');
    expect(screen.getByTestId('phase-overview-traceability')).toHaveAttribute('hidden');
    const gatesTab = screen.getByRole('tab', { name: /^Gates/ });
    gatesTab.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /^Evidence/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('phase-overview-evidence')).not.toHaveAttribute('hidden');

    await user.click(screen.getByText('Activity and revision'));
    expect(screen.getByText('Revision: Spec 7 · Plan 3', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy revision hash: input' })).toHaveAttribute('title', 'sha256:input');

    await user.click(screen.getByRole('tab', { name: /^Gates/ }));
    expect(screen.getByRole('heading', { name: 'Required gates', level: 3 })).toBeInTheDocument();
    expect(screen.getByText('Supporting evidence is not shown on this page. 4 evidence records exist for this phase.')).toBeInTheDocument();
    expect(screen.queryByText(/source, time, and revision match/i)).not.toBeInTheDocument();
  }, 15_000);

  it('keeps active development progress compact without claiming gate completion', () => {
    const development = phase('in_progress');
    development.phaseId = 'development';
    development.activityStatus = 'in_progress';
    development.ownStatus = 'not_started';
    development.permittedActions = ['inspect_evidence', 'run_phase'];
    development.developmentExecution = developmentExecution();
    const activeSpec: LifecycleSpecResponse = {
      ...spec,
      traceability: {
        ...spec.traceability,
        stories: { items: [], total: 10, truncated: false },
      },
      currentRun: {
        id: 64,
        status: 'running',
        startedAt: '2026-07-15T12:00:00.000Z',
        finishedAt: null,
        queuePosition: null,
        triggerType: 'manual',
        agentType: 'omp',
        stories: { total: 6, passed: 6, failed: 0 },
        liveness: {
          state: 'active',
          evaluatedAt: '2026-07-15T12:06:00.000Z',
          lastMeaningfulActivity: '2026-07-15T12:05:00.000Z',
          confidence: 1,
          evidence: [],
          blocker: null,
          nextSafeAction: { action: 'wait', explanation: 'Run is active.' },
          policy: { inactivityThresholdMs: 60_000, lookbackMs: 300_000, evidenceLimit: 16 },
        },
      },
    };

    renderPhaseView({ phase: development, spec: activeSpec, portfolioItem: null });

    expect(screen.getByText('Phase In progress')).toBeInTheDocument();
    expect(screen.getByLabelText('6 of 10 stories passed for run 64')).toHaveTextContent('6/10');
    expect(screen.getByRole('heading', { name: 'Implementation execution' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'ACC-007' })).toBeInTheDocument();
    expect(screen.getByText('6/10 passed')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Source change set' })).toBeInTheDocument();
    expect(screen.getByText('src/accountant-copilot.ts')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Development verification' })).toBeInTheDocument();
    expect(screen.getByText('6 host-observed validation receipts')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Repository integration' })).toBeInTheDocument();
    expect(screen.getByText('0/2 gates')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Canonical export kit' })).not.toBeInTheDocument();
  });


  it('loads an expanded synthesis section from the bounded preview API when aggregate content is withheld', async () => {
    const user = userEvent.setup();
    const value = phase();
    value.phaseId = 'requirements';
    value.sourceMaterial = sourceMaterial('requirements');
    if (value.sourceMaterial.state !== 'available') throw new Error('Expected available requirements source fixture');
    const firstSection = value.sourceMaterial.synthesis.sections[0]!;
    delete (firstSection as { content?: string }).content;
    const onReadSourceArtifact = vi.fn().mockResolvedValue({
      relativePath: firstSection.sourcePath,
      name: 'PRD.md',
      role: 'requirements',
      content: 'Bounded requirements passage loaded on expansion.',
      contentType: 'markdown',
      startLine: firstSection.startLine,
      endLine: firstSection.endLine,
      totalLines: 100,
      truncated: false,
      projectedContentHash: `sha256:${'d'.repeat(64)}`,
      actualContentHash: `sha256:${'d'.repeat(64)}`,
      stale: false,
      modifiedAt: '2026-07-15T12:00:00.000Z',
    });

    renderPhaseView({ phase: value, onReadSourceArtifact });
    await user.click(screen.getByRole('tab', { name: 'Synthesis' }));

    expect(await screen.findByText('Bounded requirements passage loaded on expansion.')).toBeInTheDocument();
    expect(onReadSourceArtifact).toHaveBeenCalledWith(
      firstSection.sourcePath,
      firstSection.startLine,
      firstSection.endLine,
    );
  });
  it('uses roving arrow, Home, and End behavior with an associated phase-detail tabpanel', async () => {
    const user = userEvent.setup();
    renderPhaseView();
    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();

    await user.keyboard('{ArrowRight}');
    const synthesis = screen.getByRole('tab', { name: 'Synthesis' });
    expect(synthesis).toHaveFocus();
    expect(synthesis).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Synthesis' })).toHaveAttribute('aria-labelledby', synthesis.id);

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Sources' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(overview).toHaveFocus();
    expect(overview).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps a failed source-open target visible and retryable without leaving the phase', async () => {
    const user = userEvent.setup();
    const onOpenSourceArtifact = vi.fn();
    const value = phase();
    value.phaseId = 'requirements';
    value.sourceMaterial = sourceMaterial('requirements');
    renderPhaseView({
      phase: value,
      onOpenSourceArtifact,
      sourceArtifactError: {
        relativePath: 'genesis/artifacts/export-packs/billing/PRD.md',
        action: 'open',
        line: 12,
        message: 'Canonical Genesis source artifact authority is not verified',
        remediation: 'Verify canonical source authority for this workspace, then retry.',
      },
    });

    await user.click(screen.getByRole('tab', { name: /^Context/ }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Canonical Genesis source artifact authority is not verified');
    expect(alert).toHaveTextContent('Verify canonical source authority');
    await user.click(within(alert).getByRole('button', { name: 'Retry open' }));
    expect(onOpenSourceArtifact).toHaveBeenCalledWith(
      'genesis/artifacts/export-packs/billing/PRD.md',
      'open',
      12,
      undefined,
    );
    expect(screen.getByRole('button', { name: 'Back to board' })).toBeInTheDocument();
  });
  it.each([
    ['planning', 'planning', 'Mission and scope', 'PRD.md'],
    ['requirements', 'requirements', 'Functional requirements', 'PRD.md'],
    ['design', 'design', 'Authorization boundaries', 'SDD.md'],
  ] as const)('renders the exact export package through the %s lens with synthesis and source actions', async (
    lens,
    phaseId,
    sectionTitle,
    sourceFile,
  ) => {
    const user = userEvent.setup();
    const onOpenSourceArtifact = vi.fn();
    const value = phase();
    value.phaseId = phaseId;
    value.sourceMaterial = sourceMaterial(lens, true);
    renderPhaseView({ phase: value, onOpenSourceArtifact });

    await user.click(screen.getByRole('tab', { name: /^Context/ }));
    const sourceSection = screen.getByTestId('lifecycle-source-material');
    const lensTitle = lens === 'planning'
      ? 'Intent, scope, and delivery shape'
      : lens === 'requirements'
        ? 'Behavior and acceptance contract'
        : 'Architecture and system boundaries';
    expect(within(sourceSection).getByRole('heading', { name: lensTitle })).toBeInTheDocument();
    expect(within(sourceSection).getByText('Billing Security')).toBeInTheDocument();
    expect(within(sourceSection).getByText('Authoritative source')).toBeInTheDocument();
    expect(within(sourceSection).getByText(/Selected evidence includes non-approved material/)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Synthesis' }));
    expect(screen.getByRole('tab', { name: 'Synthesis' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('lifecycle-phase-view')).toHaveTextContent(`${lens === 'planning' ? 'Planning' : lens === 'requirements' ? 'Requirements' : 'Design'} synthesis from the exact export bundle`);
    expect((await screen.findAllByText(sectionTitle)).length).toBeGreaterThan(0);
    const sourcePath = `genesis/artifacts/export-packs/billing/${sourceFile}`;
    await user.click(screen.getByRole('button', { name: `Open ${sourcePath} in editor at line 12` }));
    expect(onOpenSourceArtifact).toHaveBeenCalledWith(sourcePath, 'open', 12);

    await user.click(screen.getByRole('tab', { name: 'Sources' }));
    expect(await screen.findByRole('table', { name: 'Raw export artifacts' })).toBeInTheDocument();
    const menu = screen.getByRole('button', { name: 'More actions for genesis/artifacts/export-packs/billing/PRD.md' });
    await user.click(menu);
    await user.click(screen.getByRole('button', { name: 'Reveal genesis/artifacts/export-packs/billing/PRD.md in folder' }));
    expect(onOpenSourceArtifact).toHaveBeenCalledWith(
      'genesis/artifacts/export-packs/billing/PRD.md',
      'reveal',
      undefined,
    );
  });


  it('announces Development activity independently from gate and dependency readiness', async () => {
    const value = phase('not_started');
    value.phaseId = 'development';
    value.activityStatus = 'not_started';
    value.ownStatus = 'passed';
    value.dependencyStatus = 'waiting';
    const rendered = renderPhaseView({ phase: value, selectedPhaseId: 'development' });

    const readiness = screen.getByRole('group', { name: 'Execution, assurance, and delivery readiness' });
    expect(within(readiness).getByText('Execution completed')).toBeInTheDocument();
    expect(within(readiness).getByText('Assurance partial')).toBeInTheDocument();
    expect(within(readiness).getByText('Delivery in progress')).toBeInTheDocument();

    const phaseState = screen.getByRole('group', { name: 'Phase gate and dependency status' });
    expect(within(phaseState).getByText('Phase Not started')).toBeInTheDocument();
    expect(within(phaseState).getByText('Waiting on dependencies')).toBeInTheDocument();
    await testA11y(rendered.container);
  });

  it('shows execution as unknown on a mixed snapshot instead of deriving it from partial assurance', () => {
    const legacySpec = { ...spec } as Partial<typeof spec>;
    const legacyPortfolioItem = { ...portfolioItem } as Partial<typeof portfolioItem>;
    delete legacySpec.readiness;
    delete legacyPortfolioItem.readiness;
    renderPhaseView({
      spec: legacySpec as typeof spec,
      portfolioItem: legacyPortfolioItem as typeof portfolioItem,
    });
    const readiness = screen.getByRole('group', { name: 'Execution, assurance, and delivery readiness' });
    expect(within(readiness).getByText('Execution unknown')).toBeInTheDocument();
    expect(within(readiness).getByText('Assurance partial')).toBeInTheDocument();
    expect(within(readiness).queryByText('Execution not started')).not.toBeInTheDocument();
  });
  it('searches synthesis, supports keyboard navigation, and previews cited source lines', async () => {
    const user = userEvent.setup();
    const value = phase();
    value.phaseId = 'requirements';
    value.sourceMaterial = sourceMaterial('requirements', true);
    if (value.sourceMaterial.state !== 'available') throw new Error('Expected available requirements source fixture');
    value.sourceMaterial.synthesis.sections.push({
      id: 'requirements-security',
      title: 'Security boundaries',
      content: 'Deny unsafe transfer.',
      sourcePath: 'genesis/artifacts/export-packs/billing/PRD.md',
      startLine: 40,
      endLine: 44,
      truncated: false,
      sourceContentHash: `sha256:${'d'.repeat(64)}`,
      freshness: 'current',
    });
    const onReadSourceArtifact = vi.fn().mockResolvedValue({
      relativePath: 'genesis/artifacts/export-packs/billing/PRD.md',
      name: 'PRD.md',
      role: 'requirements',
      content: '### Functional requirements\n\nREQ-1 Deny cross-tenant reads.',
      contentType: 'markdown',
      startLine: 12,
      endLine: 18,
      totalLines: 100,
      truncated: false,
      projectedContentHash: `sha256:${'d'.repeat(64)}`,
      actualContentHash: `sha256:${'d'.repeat(64)}`,
      stale: false,
      modifiedAt: '2026-07-15T12:00:00.000Z',
    });
    const onOpenSourceArtifact = vi.fn();
    renderPhaseView({ phase: value, onReadSourceArtifact, onOpenSourceArtifact });

    await user.click(screen.getByRole('tab', { name: 'Synthesis' }));
    const search = screen.getByRole('searchbox', { name: 'Search synthesis' });
    await user.type(search, 'security');
    expect(screen.getAllByText('Security boundaries')).toHaveLength(2);
    expect(screen.queryByText('REQ-1 Deny cross-tenant reads.')).not.toBeInTheDocument();
    await user.clear(search);
    search.blur();

    await user.keyboard(']');
    const selected = document.querySelector('[aria-current="location"]');
    expect(selected).toHaveTextContent('Security boundaries');
    expect(selected).toHaveAttribute('aria-current', 'location');
    await user.keyboard('o');
    expect(onOpenSourceArtifact).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Preview genesis/artifacts/export-packs/billing/PRD.md lines 12 to 18' }));
    expect(onReadSourceArtifact).toHaveBeenCalledWith(
      'genesis/artifacts/export-packs/billing/PRD.md',
      12,
      18,
    );
    const previewDialog = await screen.findByRole('dialog', { name: 'Source · PRD.md' });
    expect(screen.queryByRole('button', { name: /Open .*PRD\.md in editor/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reveal .*PRD\.md in folder/ })).not.toBeInTheDocument();
    expect(within(previewDialog).getByRole('heading', { name: 'Functional requirements' })).toBeInTheDocument();
    expect(window.location.search).toContain('sourceLine=12');
  });

  it('remembers the selected source view and expanded state while flagging stale projections', async () => {
    const user = userEvent.setup();
    const value = phase();
    value.phaseId = 'requirements';
    value.sourceMaterial = sourceMaterial('requirements');
    if (value.sourceMaterial.state !== 'available') throw new Error('Expected available requirements source fixture');
    value.sourceMaterial.synthesis.sections[0]!.freshness = 'stale';
    value.sourceMaterial.synthesis.sections[0]!.sourceContentHash = null;
    const rendered = renderPhaseView({ phase: value });
    await user.click(screen.getByRole('tab', { name: 'Synthesis' }));
    expect(screen.getAllByText('stale').length).toBeGreaterThan(0);
    expect(localStorage.getItem('rorca:lifecycle-source-view:v1:ws-1:spec-a:requirements')).toBe('synthesis');

    const sectionHeading = document.getElementById('source-section-heading-requirements-section');
    const sectionToggle = sectionHeading?.closest('button');
    expect(sectionToggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(sectionToggle as HTMLButtonElement);
    await waitFor(() => expect(localStorage.getItem('rorca:lifecycle-source-expanded:v1:ws-1:spec-a:requirements')).toBe('[]'));

    rendered.unmount();
    window.history.replaceState(null, '', '/');
    renderPhaseView({ phase: value });
    expect(screen.getByRole('tab', { name: 'Synthesis' })).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById('source-section-heading-requirements-section')?.closest('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a deep-linked synthesis section and preserves its canonical query state', async () => {
    const value = phase();
    value.phaseId = 'requirements';
    value.sourceMaterial = sourceMaterial('requirements');
    window.history.replaceState(null, '', '/?sourceView=synthesis&sourceSection=requirements-section');
    renderPhaseView({ phase: value });

    expect(screen.getByRole('tab', { name: 'Synthesis' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(document.querySelector('[aria-current="location"]')).toHaveTextContent('Functional requirements'));
    expect(window.location.search).toContain('sourceSection=requirements-section');
  });

  it('summarizes changes between immutable package generations observed in this browser', async () => {
    const user = userEvent.setup();
    const historyKey = 'rorca:lifecycle-source-history:v1:ws-1:spec-a:requirements';
    const original = phase();
    original.phaseId = 'requirements';
    original.sourceMaterial = sourceMaterial('requirements');
    const firstRender = renderPhaseView({ phase: original });
    await waitFor(() => expect(localStorage.getItem(historyKey)).not.toBeNull());
    firstRender.unmount();

    const changed = phase();
    changed.phaseId = 'requirements';
    changed.sourceMaterial = sourceMaterial('requirements');
    if (changed.sourceMaterial.state !== 'available') throw new Error('Expected available requirements source fixture');
    changed.sourceMaterial.package.contentHash = `sha256:${'f'.repeat(64)}`;
    changed.sourceMaterial.synthesis.sourcePackageHash = changed.sourceMaterial.package.contentHash;
    changed.sourceMaterial.artifacts[0]!.contentHash = `sha256:${'9'.repeat(64)}`;
    changed.sourceMaterial.synthesis.sections[0]!.sourceContentHash = changed.sourceMaterial.artifacts[0]!.contentHash;
    changed.sourceMaterial.synthesis.sections[0]!.content = 'REQ-1 Deny cross-tenant reads and writes.';
    renderPhaseView({ phase: changed });

    const changeSummary = await screen.findByText(/What changed: 2 package items/);
    await user.click(changeSummary);
    expect(screen.getByText('Updated sections')).toBeInTheDocument();
    expect(screen.getByText('Updated files')).toBeInTheDocument();
    expect(screen.getAllByText('PRD.md').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('tab', { name: 'Synthesis' }));
    expect(screen.getAllByText('updated').length).toBeGreaterThan(0);
  });

  it('resets browser generation history when the projected package family changes', async () => {
    const historyKey = 'rorca:lifecycle-source-history:v1:ws-1:spec-a:requirements';
    const original = phase();
    original.phaseId = 'requirements';
    original.sourceMaterial = sourceMaterial('requirements');
    if (original.sourceMaterial.state !== 'available') throw new Error('Expected available requirements source fixture');
    original.sourceMaterial.package.packageId = 'billing-security-delivery-pack-aaaaaaaaaaaa';
    const firstRender = renderPhaseView({ phase: original });
    await waitFor(() => expect(localStorage.getItem(historyKey)).not.toBeNull());
    firstRender.unmount();

    const replacement = phase();
    replacement.phaseId = 'requirements';
    replacement.sourceMaterial = sourceMaterial('requirements');
    if (replacement.sourceMaterial.state !== 'available') throw new Error('Expected available requirements source fixture');
    replacement.sourceMaterial.package.packageId = 'different-evidence-package-bbbbbbbbbbbb';
    replacement.sourceMaterial.package.contentHash = `sha256:${'f'.repeat(64)}`;
    replacement.sourceMaterial.synthesis.sourcePackageHash = replacement.sourceMaterial.package.contentHash;
    const replacementRender = renderPhaseView({ phase: replacement });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(historyKey) ?? '{}') as { previous?: unknown };
      expect(stored.previous).toBeNull();
    });
    replacementRender.unmount();
    const staleHistory = JSON.parse(localStorage.getItem(historyKey) ?? '{}') as {
      current: Record<string, unknown>;
      previous: Record<string, unknown> | null;
    };
    staleHistory.previous = { ...staleHistory.current, packageId: 'unrelated-old-package-cccccccccccc' };
    localStorage.setItem(historyKey, JSON.stringify(staleHistory));
    renderPhaseView({ phase: replacement });
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(historyKey) ?? '{}') as { previous?: unknown };
      expect(stored.previous).toBeNull();
    });
    expect(screen.queryByText(/What changed:/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Synthesis' }));
    expect(screen.queryByText('Stale sections removed by this package generation')).not.toBeInTheDocument();
  });

  it('has no automated accessibility violations in the synthesis workspace', async () => {
    const user = userEvent.setup();
    const value = phase();
    value.phaseId = 'requirements';
    value.sourceMaterial = sourceMaterial('requirements');
    const { container } = renderPhaseView({ phase: value });
    await user.click(screen.getByRole('tab', { name: 'Synthesis' }));
    await testA11y(container);
  });


  it('hides redundant breakdown tabs for a singleton stage', () => {
    renderPhaseView({
      phase: { ...phase(), phaseId: 'development' },
    });
    expect(screen.queryByRole('tablist', { name: 'Development phases' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Implementation' })).not.toBeInTheDocument();
  });

  it.each(['blocked', 'passed', 'deferred', 'not_applicable', 'stale', 'awaiting_approval'] as LifecycleEvaluatedStatus[])(
    'renders the backend %s state without inventing guidance',
    (status) => {
      const value = phase(status);
      renderPhaseView({ phase: value });
      const readableStatus = status.replace(/_/g, ' ');
      expect(screen.getByText(`Own gates ${readableStatus.charAt(0).toUpperCase()}${readableStatus.slice(1)}`)).toBeInTheDocument();
      expect(screen.getByText(value.nextSafeActionGuidance.action)).toBeInTheDocument();
      expect(screen.getByText(/Phase evaluator · 95% confidence/)).toBeInTheDocument();
      expect(screen.queryByText('Legacy text must not render.')).not.toBeInTheDocument();
    },
  );

  it('renders embedded rationale hashes as copyable short references and leaves ordinary prose unchanged', async () => {
    const user = userEvent.setup();
    const fullHash = `sha256:${'a'.repeat(64)}`;
    const hashed = phase();
    hashed.nextSafeActionGuidance.rationale = `Collect new architecture review evidence for ${fullHash} before release.`;
    const rendered = renderPhaseView({ phase: hashed });
    const guidance = screen.getByRole('heading', { name: 'What is blocking this phase' }).closest('section');

    expect(guidance).toHaveTextContent('Collect new architecture review evidence for aaaaaaaaaa… before release.');
    expect(guidance).not.toHaveTextContent(fullHash);
    const chip = within(guidance as HTMLElement).getByRole('button', { name: 'aaaaaaaaaa… copy full hash' });
    expect(chip).toHaveAttribute('title', fullHash);
    await user.click(chip);
    expect(await navigator.clipboard.readText()).toBe(fullHash);
    expect(chip).toHaveTextContent('Copied');

    const plain = phase();
    plain.nextSafeActionGuidance.rationale = 'The evaluator found one bounded failed gate.';
    rendered.rerender(<LifecyclePhaseView {...rendered.props} phase={plain} />);
    expect(guidance).toHaveTextContent('The evaluator found one bounded failed gate.');
    expect(within(guidance as HTMLElement).queryByRole('button', { name: /copy full hash/i })).not.toBeInTheDocument();
  });

  it('drills requirement, decision, and story rows into the bounded traceability view', async () => {
    const user = userEvent.setup();
    renderPhaseView();
    for (const reference of ['REQ-002', 'ADR-004', 'US-006']) {
      await user.click(screen.getByRole('tab', { name: /^Mappings/ }));
      await user.click(screen.getByRole('button', { name: `Open traceability for ${reference}` }));
      expect(screen.getByRole('heading', { name: 'Requirement traceability' }).parentElement).toHaveFocus();
    }
  });

  it('exposes source, time, revision match, and evidence drill-down from gate and evidence rows', async () => {
    const user = userEvent.setup();
    const onOpenEvidence = vi.fn();
    renderPhaseView({ onOpenEvidence });
    await user.click(screen.getByRole('tab', { name: /^Gates/ }));
    const gate = screen.getByRole('button', { name: /Tenant isolation integration test.*Open supporting evidence/i });
    expect(gate).toHaveTextContent('Source: GitHub Actions');
    expect(gate).toHaveTextContent('Current revision');
    expect(within(gate).getByText((_content, element) => element?.tagName === 'TIME')).toHaveAttribute('dateTime', '2026-07-15T12:00:00.000Z');
    expect(screen.getByRole('article', { name: /Manual acceptance judgment.*Supporting evidence is not shown on this page/i })).toBeInTheDocument();
    await user.click(gate);
    expect(onOpenEvidence).toHaveBeenCalledWith('7');
  });

  it('claims no gate evidence only when the phase evidence total is zero', async () => {
    const value = phase('passed');
    value.evidence = { items: [], total: 0, hasMore: false };
    const user = userEvent.setup();
    renderPhaseView({ phase: value });
    await user.click(screen.getByRole('tab', { name: /^Gates/ }));
    expect(screen.getAllByText(/No evidence yet for this gate/)).toHaveLength(2);
    expect(screen.queryByText(/Supporting evidence is not shown on this page/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('labels decision-backed gates without inventing missing evidence metadata', async () => {
    const value = phase('passed');
    value.evidence = { items: [], total: 0, hasMore: false };
    value.requiredGates.items[0].evaluation = {
      ...value.requiredGates.items[0].evaluation!,
      evidenceCount: 0,
      decisionCount: 1,
    };
    const user = userEvent.setup();
    renderPhaseView({ phase: value });
    await user.click(screen.getByRole('tab', { name: /^Gates/ }));

    const gate = screen.getByRole('article', { name: /Tenant isolation integration test/i });
    expect(gate).toHaveTextContent('Decision-backed evaluation');
    expect(gate).toHaveTextContent('No separate evidence record is attached; this gate is satisfied by the recorded decision');
    expect(gate).not.toHaveTextContent('Source: Unknown');
    expect(screen.getAllByText(/No evidence yet for this gate/)).toHaveLength(1);
  });

  it('uses server decision activity and never infers expiry from the client clock', async () => {
    const value = phase();
    value.governedDecisions = {
      items: [{
        id: 'decision-recorded', gateId: null, storyId: null, decisionType: 'gate_override', rationale: 'Recorded without server activity.',
        evidenceGap: null, actor: { id: 'u1', label: 'Reviewer', type: 'user' }, createdAt: '2026-07-15T00:00:00.000Z',
        expiresAt: '2020-01-01T00:00:00.000Z', revokedAt: null,
      }, {
        id: 'decision-expired', gateId: null, storyId: null, decisionType: 'testing_approval', rationale: 'Server marked expired.',
        evidenceGap: null, actor: { id: 'u1', label: 'Reviewer', type: 'user' }, createdAt: '2026-07-15T00:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z', revokedAt: null, activity: 'expired',
      }],
      total: 2,
      truncated: false,
    };
    const user = userEvent.setup();
    renderPhaseView({ phase: value });
    await user.click(screen.getByRole('tab', { name: /^Decisions/ }));
    expect(screen.getByText('Recorded')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('Recorded without server activity.').closest('li')).toHaveTextContent('expires');
  });

  it('restores focus to the evidence row when the inspector closes', async () => {
    const user = userEvent.setup();
    const rendered = renderPhaseView();
    await user.click(screen.getByRole('tab', { name: /^Evidence/ }));
    const evidenceRow = screen.getByRole('button', { name: /automated_validation.*GitHub Actions/i });
    await user.click(evidenceRow);
    rendered.rerender(<LifecyclePhaseView {...rendered.props} selectedEvidenceId="7" selectedEvidenceSnapshotId={MARKS.snapshotId} />);
    await user.click(screen.getByRole('button', { name: 'Close Evidence Inspector' }));
    expect(rendered.props.onCloseEvidence).toHaveBeenCalled();
    await waitFor(() => expect(evidenceRow).toHaveFocus());
  });

  it('switches stages with one roving tab stop and selects member phases without firing a governed action', async () => {
    const user = userEvent.setup();
    const onSelectPhase = vi.fn();
    const onAction = vi.fn();
    renderPhaseView({ onSelectPhase, onAction });
    const switcher = screen.getByRole('group', { name: 'Switch lifecycle stage' });
    const stageButtons = within(switcher).getAllByRole('button');
    expect(stageButtons).toHaveLength(7);
    expect(stageButtons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    expect(stageButtons.filter((button) => button.tabIndex === -1)).toHaveLength(6);
    // Identity stages are singletons: no sub-tab bar renders, the stage
    // button itself is the phase selector.
    expect(screen.queryByRole('tablist', { name: 'Testing phases' })).not.toBeInTheDocument();
    const testing = within(switcher).getByRole('button', { name: 'Testing' });
    testing.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(switcher).getByRole('button', { name: 'Deployment' })).toHaveFocus();
    expect(onSelectPhase).not.toHaveBeenCalled();
    await user.keyboard('{End}{Enter}');
    // End moves to Maintenance; Enter opens its lead phase (maintenance).
    expect(onSelectPhase).toHaveBeenCalledWith('maintenance');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('keeps the primary authorized action sticky and moves secondary actions into the command menu', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderPhaseView({ onAction });
    const footer = screen.getByLabelText('Server-permitted phase actions');
    expect(within(footer).getByRole('button', { name: /Retry story/ })).toBeInTheDocument();
    expect(within(footer).queryByRole('button', { name: /Open run/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More phase actions' }));
    expect(screen.getByRole('button', { name: 'Open run' })).toBeInTheDocument();
    await user.click(within(footer).getByRole('button', { name: /Retry story/ }));
    expect(onAction).toHaveBeenCalledWith('retry_smallest_scope');
  });

  it('exposes a provenance-linked reviewable Learn candidate and its evidence chain', async () => {
    const user = userEvent.setup();
    const onOpenEvidence = vi.fn();
    const learnPhase: LifecyclePhaseResponse = {
      ...phase('passed'),
      phaseId: 'maintenance',
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
              workspaceId: 'ws-1', specId: 'spec-a', runId: 913, storyId: null, commitSha: 'abc123',
              releaseSubject: { type: 'commit_sha', value: 'abc123' }, sourceEvidenceIds: ['7', 'EVD-sha256:host'],
              sourceDecisionIds: ['CLO-sha256:accepted'], deduplicationKey: 'sha256:dedupe',
            },
          }],
        },
        nextAction: 'Review 1 provenance-linked candidate.',
      },
    };
    renderPhaseView({ phase: learnPhase, onOpenEvidence });
    await user.click(screen.getByRole('tab', { name: /^Closeout/ }));

    const learn = screen.getByTestId('lifecycle-learn-closeout');
    expect(within(learn).getByText('1/1')).toBeInTheDocument();
    expect(within(learn).getByText('Decision candidate #91')).toBeInTheDocument();
    expect(within(learn).getByText(/Workspace ws-1 · Spec spec-a · Run 913 · Story unknown/)).toBeInTheDocument();
    expect(within(learn).getByText(/Not eligible for retrieval by default/)).toBeInTheDocument();
    await user.click(within(learn).getByRole('button', { name: 'Evidence 7' }));
    expect(onOpenEvidence).toHaveBeenCalledWith('7');
  });

  it('keeps long evidence payload and provenance collapsed by default', () => {
    const detail = {
      id: '7', workspaceId: 'ws-1', specId: 'spec-a', scope: { workspaceId: 'ws-1', specSlug: 'spec-a', runId: 913, storyId: 'US-006', phaseId: 'testing', gateId: 'gate-validation' },
      source: { type: 'ci', system: 'GitHub Actions', eventId: 'check-7' }, observedAt: '2026-07-15T12:00:00.000Z', createdAt: null,
      subject: { type: 'commit_sha', value: 'abc123' }, phaseSubject: null, releaseIdentity: { commitSha: 'abc123', artifactDigest: null, deploymentId: null },
      classification: 'automated_validation', status: 'passed', trustLevel: 'provider_verified', confidence: 0.98, excerpt: 'A very long payload', actor: null, rationale: null,
      expiresAt: null, environment: null, redactionState: 'normalized_redacted', details: {}, provenanceChain: [], revisionMismatch: false, eligibleForActiveGate: true, invalidReasons: [], lineageVerified: true, payloadHash: 'sha256:payload', sourcePayloadHash: null,
      rawReference: { available: false, accessTier: 'auth', allowed: false, kind: 'unknown', label: 'No raw reference', reference: null, href: null, external: false, rawPayloadIncluded: false }, ...MARKS,
    } satisfies LifecycleEvidenceDetail;
    renderPhaseView({ selectedEvidenceId: '7', selectedEvidenceSnapshotId: MARKS.snapshotId, evidence: evidenceQuery(detail) });
    const disclosure = screen.getByText('Bounded normalized payload and provenance').closest('details');
    expect(disclosure).not.toHaveAttribute('open');
  });

  describe('engineering canon coverage section', () => {
    const PHASE_IDS = ['planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance'];
    const emptyEntry = (phaseId: string): SpecCoveragePhaseEntry => ({
      phaseId, inScope: false, required: [], covered: [], uncovered: [], missingSkills: [], nextActions: [], genesisPackageIds: [],
    });

    function availableCoverage(): SpecCoverageByPhase {
      const phases: Record<string, SpecCoveragePhaseEntry> = Object.fromEntries(PHASE_IDS.map((id) => [id, emptyEntry(id)]));
      phases.testing = {
        phaseId: 'testing', inScope: true,
        required: [{ requirementId: 'REQ-TESTING-2', overlayId: 'overlay.testing', operation: 'review', disposition: 'required', gaps: ['missing_skill', 'insufficient_evidence'] }],
        covered: [{ requirementId: 'REQ-TESTING-1', overlayId: 'overlay.testing', operation: 'review', resolution: 'covered' }],
        uncovered: [{ requirementId: 'REQ-TESTING-2', overlayId: 'overlay.testing', operation: 'review', disposition: 'required', gaps: ['missing_skill', 'insufficient_evidence'] }],
        missingSkills: [{ requirementId: 'REQ-TESTING-2', overlayId: 'overlay.testing', operation: 'review', disposition: 'required', gaps: ['missing_skill'] }],
        nextActions: [{ code: 'review_and_promote_required_skill', label: 'Review required candidate skills and attach genuine promotion receipts.' }],
        genesisPackageIds: ['GEN-PKG-1'],
      };
      phases.testing.covered.push(
        { requirementId: 'REQ-TESTING-1B', overlayId: 'overlay.testing', operation: 'review', resolution: 'covered' },
      );
      return { adapterStatus: 'available', phases };
    }

    function degradedCoverage(): SpecCoverageByPhase {
      return {
        adapterStatus: 'degraded',
        reasonCode: 'package_unavailable',
        message: 'Optional engineering canon package is unavailable or invalid.',
        phases: Object.fromEntries(PHASE_IDS.map((id) => [id, emptyEntry(id)])),
      };
    }

    it('renders covered and uncovered cells with citations, missing skills, next actions, and Genesis bindings', async () => {
      const user = userEvent.setup();
      renderPhaseView({ coverage: availableCoverage() });
      await user.click(screen.getByRole('tab', { name: /^Mappings/ }));

      const section = screen.getByTestId('lifecycle-phase-coverage');
      expect(within(section).getByRole('heading', { name: 'Engineering canon coverage' })).toBeInTheDocument();
      expect(within(section).getByText('1 required')).toBeInTheDocument();
      expect(within(section).getByText('2 covered')).toBeInTheDocument();
      expect(within(section).getByText('1 missing skills')).toBeInTheDocument();

      // Uncovered required cell with its citations.
      const required = within(section).getByLabelText('Required coverage cells');
      expect(within(required).getByText('REQ-TESTING-2')).toBeInTheDocument();
      expect(within(required).getByText('overlay.testing')).toBeInTheDocument();
      expect(within(required).getByText(/Gaps: Missing skill · Insufficient evidence/)).toBeInTheDocument();

      // Covered cell with its resolution.
      const covered = within(section).getByLabelText('Covered coverage cells');
      expect(within(covered).getByText('REQ-TESTING-1')).toBeInTheDocument();
      expect(within(covered).getByText('REQ-TESTING-1B')).toBeInTheDocument();
      expect(within(covered).getAllByText('Covered')).toHaveLength(2);

      // Missing skills carry the same cell citations.
      const missing = within(section).getByLabelText('Missing skills with citations');
      expect(within(missing).getByText('REQ-TESTING-2')).toBeInTheDocument();
      expect(within(missing).getByText('overlay.testing')).toBeInTheDocument();

      expect(within(section).getByLabelText('Coverage next actions')).toHaveTextContent('Review required candidate skills and attach genuine promotion receipts.');
      expect(within(section).getByLabelText('Bound Genesis packages')).toHaveTextContent('GEN-PKG-1');
    });

    it('renders coverage unavailable for a degraded canon without errors', async () => {
      const user = userEvent.setup();
      renderPhaseView({ coverage: degradedCoverage() });
      await user.click(screen.getByRole('tab', { name: /^Mappings/ }));
      const section = screen.getByTestId('lifecycle-phase-coverage');
      expect(within(section).getByText('Coverage unavailable')).toBeInTheDocument();
      expect(within(section).getByText('Optional engineering canon package is unavailable or invalid.')).toBeInTheDocument();
    });

    it('omits the coverage section when readiness carries no coverage', () => {
      renderPhaseView({ coverage: null });
      expect(screen.queryByTestId('lifecycle-phase-coverage')).not.toBeInTheDocument();
    });
  });

  describe("advisory 'what's missing' panel", () => {
    const advice: LifecycleAdviceResponse = {
      advisory: true,
      workspaceId: 'ws-1',
      specId: 'spec-a',
      phaseId: 'testing',
      generatedAt: '2026-07-15T12:00:00.000Z',
      suggestions: [
        { text: 'Attach an approved test-result artifact to the validation gate.', cites: ['REQ-TESTING-2', 'source-brief'] },
        { text: 'Confirm the GEN-PKG-1 binding is still intended.', cites: ['CTRL-VALIDATION-GATE'] },
      ],
    };

    it('renders the advisory panel with cited suggestions and the Advisory label', async () => {
      const user = userEvent.setup();
      renderPhaseView({ advice, onRequestAdvice: vi.fn() });
      await user.click(screen.getByRole('tab', { name: /^Advisory/ }));

      const panel = screen.getByTestId('lifecycle-phase-advice');
      expect(within(panel).getByRole('heading', { name: /What's missing/i })).toBeInTheDocument();
      expect(within(panel).getByText('Advisory')).toBeInTheDocument();
      const suggestions = within(panel).getByLabelText('Advisory suggestions');
      expect(within(suggestions).getByText('Attach an approved test-result artifact to the validation gate.')).toBeInTheDocument();
      expect(within(suggestions).getByText('REQ-TESTING-2')).toBeInTheDocument();
      expect(within(suggestions).getByText('source-brief')).toBeInTheDocument();
      expect(within(suggestions).getByText('CTRL-VALIDATION-GATE')).toBeInTheDocument();
      expect(within(panel).getByText(/never recorded as lifecycle evidence/)).toBeInTheDocument();
    });

    it('requests advice through the handler and reflects loading and error states', async () => {
      const user = userEvent.setup();
      const onRequestAdvice = vi.fn();
      const rendered = renderPhaseView({ onRequestAdvice });
      await user.click(screen.getByRole('tab', { name: /^Advisory/ }));

      const panel = screen.getByTestId('lifecycle-phase-advice');
      const trigger = within(panel).getByRole('button', { name: 'Ask the phase advisor' });
      await user.click(trigger);
      expect(onRequestAdvice).toHaveBeenCalledTimes(1);

      rendered.rerender(<LifecyclePhaseView {...rendered.props} adviceLoading advice={null} />);
      expect(screen.getByRole('status')).toHaveTextContent('Asking the phase advisor…');
      expect(screen.queryByRole('button', { name: /Ask/ })).not.toBeInTheDocument();

      rendered.rerender(<LifecyclePhaseView {...rendered.props} adviceLoading={false} adviceError="The advisor model is unavailable." />);
      expect(screen.getByRole('alert')).toHaveTextContent('The advisor model is unavailable.');
      await user.click(screen.getByRole('button', { name: 'Ask the phase advisor' }));
      expect(onRequestAdvice).toHaveBeenCalledTimes(2);
    });

    it('reports an empty advisory result without implying coverage', async () => {
      const user = userEvent.setup();
      renderPhaseView({ advice: { ...advice, suggestions: [] }, onRequestAdvice: vi.fn() });
      await user.click(screen.getByRole('tab', { name: /^Advisory/ }));
      expect(screen.getByText('The advisor found no gaps to suggest for this phase.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Ask again' })).toBeInTheDocument();
    });

    it('omits the advisory section when no handler or data is provided', () => {
      renderPhaseView();
      expect(screen.queryByTestId('lifecycle-phase-advice')).not.toBeInTheDocument();
    });
  });
});
