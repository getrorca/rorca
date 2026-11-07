/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import LifecycleGovernedActionDialog from '../LifecycleGovernedActionDialog';
import type { LifecyclePhaseResponse, LifecycleRetryPreviewResponse } from '../../types/lifecycle';

const hash = `sha256:${'a'.repeat(64)}`;
const marks = { snapshotId: 'snapshot-1', evidenceHighWaterMark: 'e:1', decisionHighWaterMark: 'd:1' };

function phase(hardDeny = false): LifecyclePhaseResponse {
  return {
    workspaceId: 'ws-1', specId: 'spec-a', phaseId: 'testing', state: 'current', status: 'blocked', disposition: 'required',
    whyRequired: 'QA is required', mappedRequirements: { items: ['REQ-1'], total: 1, truncated: false }, mappedDecisions: { items: [], total: 0, truncated: false },
    mappedStories: { items: ['US-6'], total: 1, truncated: false }, governedDecisions: { items: [], total: 0, truncated: false },
    requiredGates: { items: [{
      gateId: 'qa-policy-gate', phaseId: 'testing', title: 'Immutable QA release rule', evidenceKind: 'qa_assessment',
      subjectRevisionRequirement: 'current_commit', approvalRequirement: 'human', expirationPolicy: 'when_subject_changes', blockingSeverity: 'release_blocking',
      evidenceRequirementIds: ['qa-report'], acceptedSubjectTypes: ['commit_sha'], hardDeny,
      authorizedApprovers: ['local_admin', 'authenticated_admin'],
      downstreamSubjectCoherence: { testing: 'same_subject', deployment: 'same_subject' },
      evaluation: { status: 'blocked', rationale: 'Missing QA report', blockerReason: 'qa-report is missing', nextSafeAction: 'Request approval', evidenceCount: 0, decisionCount: 0 },
    }], total: 1, truncated: false },
    evidence: { items: [], total: 0, hasMore: false }, blocker: { gateId: 'qa-policy-gate', reason: 'qa-report is missing' },
    nextSafeActionGuidance: { action: 'Request approval', rationale: 'Policy requires review.', confidence: 1, classifier: 'phase_evaluator' },
    nextSafeAction: 'Request approval', permittedActions: ['request_approval'], evaluationSnapshot: marks, ...marks,
  };
}

function retryPreview(expiresAt = '2999-07-15T12:10:00.000Z'): LifecycleRetryPreviewResponse {
  const story = (storyId: string, reasonCode: string) => ({ storyId, reasonCode });
  return {
    ok: true,
    preview: {
      schemaVersion: 'retry-preview.v1', originalRunId: 913, previewHash: hash, requiresApproval: false, forceSequential: true,
      scope: {
        requested: [story('US-006', 'REQUESTED_FAILED_STORY')], requiredDependency: [story('US-004', 'REQUIRED_FAILED_DEPENDENCY')],
        copiedPassed: [story('US-001', 'PASSED_RESULT_COPIED_NOT_EXECUTABLE')], skipped: [story('US-009', 'FAILED_NOT_REQUESTED')],
        executable: [story('US-004', 'EXECUTABLE_RETRY_WORK'), story('US-006', 'EXECUTABLE_RETRY_WORK')], remaining: [], excluded: [],
      },
      options: {
        agent: 'pi', model: 'approved-model', effort: 'high', terminalMode: 'headless', includeGraph: true,
        worktree: { enabled: true, path: '/tmp/wt', branch: 'retry/us-006' }, merge: { strategy: 'branch-only', autoMerge: false },
        safety: { deploy: false, externalSend: false, policyLocked: true, allowBackendJest: false },
      },
      destructiveOperations: ['reset', 'branch_delete', 'force_push', 'auto_merge', 'deploy', 'external_send'],
    },
    previewIdentity: { schemaVersion: 'retry-preview-identity.v1', previewHash: hash, originalRunId: 913, expiresAt, signature: hash },
    worktreePreflight: { classification: 'fresh', ok: true },
  };
}

const portfolioItem = {
  specId: 'spec-a', title: 'Spec A', specStatus: 'approved' as const, state: 'current' as const, overallStatus: 'blocked' as const, risk: 'high' as const,
  owner: null, storySummary: { total: 2, passed: 1, failed: 1 }, currentPhaseId: 'testing' as const, blocked: true, blockers: [], liveness: null,
  currentRevision: { specVersion: '7', inputHash: hash, planVersion: 3 }, phases: [], updatedAt: null,
  delivery: { status: 'in_progress' as const, rationale: 'Current delivery run is active.', reconciledAt: null },
  assurance: { status: 'partial' as const, passedControls: 4, totalControls: 11, coverage: 4 / 11, rationale: 'Assurance is partial.' },
  reconciliation: null,
};

function renderDialog(dialog: Parameters<typeof LifecycleGovernedActionDialog>[0]['dialog'], overrides: Partial<Parameters<typeof LifecycleGovernedActionDialog>[0]> = {}) {
  const props = {
    dialog, phase: phase(), spec: null, portfolioItem, pending: false, error: null,
    onCancel: vi.fn(), onRetryConfirm: vi.fn(), onDecisionConfirm: vi.fn(), ...overrides,
  };
  return { ...render(<LifecycleGovernedActionDialog {...props} />), props };
}

describe('LifecycleGovernedActionDialog', () => {
  it('shows exact retry scope and server-enforced publication policy, then cancel is a no-op', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ kind: 'retry', preview: retryPreview() });
    expect(screen.getByLabelText('Exact retry scope')).toHaveTextContent('US-006');
    expect(screen.getByLabelText('Exact retry scope')).toHaveTextContent('US-004');
    expect(screen.getByLabelText('Exact retry scope')).toHaveTextContent('US-001');
    const policy = screen.getByLabelText('Server-enforced retry execution policy');
    expect(policy).toHaveTextContent('pi · approved-model · high');
    expect(policy).toHaveTextContent('isolated worktree · /tmp/wt · retry/us-006');
    expect(policy).toHaveTextContent('branch-only · auto-merge=false · deploy=false · external-send=false');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onRetryConfirm).not.toHaveBeenCalled();
    expect(props.onDecisionConfirm).not.toHaveBeenCalled();
  });

  it('closes on Escape without recording a decision or queueing work', async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ kind: 'retry', preview: retryPreview() });
    await user.keyboard('{Escape}');
    expect(props.onCancel).toHaveBeenCalledOnce();
    expect(props.onRetryConfirm).not.toHaveBeenCalled();
    expect(props.onDecisionConfirm).not.toHaveBeenCalled();
  });

  it('fails closed for stale previews and suppresses duplicate submission while pending', async () => {
    const stale = renderDialog({ kind: 'retry', preview: retryPreview('2020-01-01T00:00:00.000Z') });
    expect(screen.getByRole('alert')).toHaveTextContent('Preview expired');
    expect(screen.getByRole('button', { name: 'Queue exact retry' })).toBeDisabled();
    stale.unmount();

    renderDialog({ kind: 'retry', preview: retryPreview() }, { pending: true });
    expect(screen.getByRole('button', { name: 'Submitting…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('renders the complete override policy packet and never enables a hard-deny waiver', async () => {
    const user = userEvent.setup();
    renderDialog({ kind: 'decision', decisionType: 'gate_override' }, { phase: phase(true) });
    const packet = screen.getByLabelText('Governed policy packet');
    expect(packet).toHaveTextContent('Immutable QA release rule');
    expect(packet).toHaveTextContent('qa-report is missing');
    expect(packet).toHaveTextContent('high · release_blocking');
    expect(packet).toHaveTextContent('local_admin, authenticated_admin');
    expect(packet).toHaveTextContent('spec-a / testing / qa-policy-gate');
    expect(packet).toHaveTextContent('Spec 7 · Plan 3');
    expect(packet).toHaveTextContent('Non-bypassable');
    await user.type(screen.getByLabelText(/Rationale/), 'A concrete override rationale');
    await user.type(screen.getByLabelText(/Missing evidence statement/), 'A concrete evidence gap');
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Submit override decision' })).toBeDisabled();
  });

  it.each([
    ['testing_approval', 'Testing approval'],
    ['deployment_approval', 'Deployment approval'],
    ['release_approval', 'Release approval'],
  ] as const)('requires explicit confirmation and states immutable non-execution consequence for %s', async (decisionType, label) => {
    const user = userEvent.setup();
    const { props } = renderDialog({ kind: 'decision', decisionType });
    expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
    expect(screen.getByLabelText('Governed policy packet')).toHaveTextContent('does not merge, deploy, or send externally');
    const submit = screen.getByRole('button', { name: `Record ${label}` });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Rationale/), 'Reviewed immutable evidence packet');
    await user.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(props.onDecisionConfirm).toHaveBeenCalledOnce();
  });
});
