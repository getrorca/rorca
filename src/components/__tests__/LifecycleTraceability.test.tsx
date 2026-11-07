/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { LifecycleEvidenceSummary, LifecycleTraceability } from '../../types/lifecycle';
import LifecycleTraceabilityView from '../LifecycleTraceability';

function evidence(
  id: string,
  currentRevision: boolean,
  status: LifecycleEvidenceSummary['status'] = 'passed',
): LifecycleEvidenceSummary {
  return {
    id, evidenceType: 'github_check', sourceSystem: 'GitHub', sourceEventId: `check-${id}`, status,
    trustLevel: 'provider_verified', confidence: 1, observedAt: '2026-07-15T12:00:00.000Z',
    subject: { type: 'commit_sha', value: currentRevision ? 'current-sha' : 'old-sha' }, gateId: 'gate-qa',
    storyId: 'US-001', runId: 42, currentRevision, stale: !currentRevision,
    invalidReasons: currentRevision ? [] : ['subject_revision_mismatch'],
  };
}

const traceability: LifecycleTraceability = {
  requirements: {
    items: [{
      requirementReference: 'REQ-001', stories: ['US-001'], decisions: ['ADR-001'], gateIds: ['gate-qa'], evidenceRequirementIds: ['evidence-qa'],
      gates: [{ gateId: 'gate-qa', phaseId: 'testing', title: 'QA approval', status: 'blocked', subjectRevisionRequirement: 'current_commit', evidenceRequirementIds: ['evidence-qa'], currentEvidence: [evidence('8', true, 'story_caused_failure')], historicalEvidence: [evidence('7', false)] }],
      blockers: [{ kind: 'subject_coherence', requirementReference: 'REQ-001', storyReference: null, gateId: 'gate-qa', message: 'QA image differs from production.', remediation: 'Re-run production against image sha256:new.' }],
    }], total: 1, truncated: false,
  },
  stories: { items: ['US-001'], total: 1, truncated: false },
  architectureDecisions: { items: ['ADR-001'], total: 1, truncated: false },
  gates: { items: [], total: 1, truncated: false },
  blockers: { items: [{ kind: 'subject_coherence', requirementReference: 'REQ-001', storyReference: null, gateId: 'gate-qa', message: 'QA image differs from production.', remediation: 'Re-run production against image sha256:new.' }], total: 1, truncated: false },
  endToEnd: {
    items: [{
      requirementReference: 'REQ-001',
      storyReference: 'US-001',
      gateId: 'gate-qa',
      phaseId: 'testing',
      status: 'blocked',
      exactSubject: { type: 'commit_sha', value: 'current-sha' },
      evidenceIds: ['8'],
      decisionIds: ['decision-22'],
    }],
    total: 1,
    truncated: false,
  },
  boundRevision: { specVersion: '4', inputHash: 'sha256:spec', planId: 'plan-1', planVersion: 3 },
  subjectLineage: [
    { type: 'spec_hash', status: 'available', value: 'sha256:spec' },
    { type: 'commit_sha', status: 'available', value: 'current-sha' },
    { type: 'artifact_digest', status: 'absent', value: null },
    { type: 'deployment_id', status: 'not_applicable', value: null },
  ],
  downstreamCoherence: { status: 'mismatch', bindings: [
    { phaseId: 'testing', commitSha: 'current-sha', artifactDigest: 'sha256:new', deploymentId: null },
    { phaseId: 'deployment', commitSha: 'current-sha', artifactDigest: 'sha256:new', deploymentId: null },
    { phaseId: 'deployment', commitSha: 'current-sha', artifactDigest: 'sha256:old', deploymentId: 'deploy-1' },
  ] },
  graphContext: { mode: 'lite', relatedEvidenceLabels: [] },
  evidence: { total: 2, validForCurrentRevision: 1, stale: 1, boundedAt: 500 },
};

describe('LifecycleTraceability', () => {
  it('renders one bounded canonical chain with exact blockers, history, lineage, and graph fallback', async () => {
    const user = userEvent.setup();
    const onOpenEvidence = vi.fn();
    render(<LifecycleTraceabilityView traceability={traceability} snapshotId="sha256:snapshot" onOpenEvidence={onOpenEvidence} />);

    expect(screen.getByText(/Spec 4 · Plan 3/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy revision hash: spec' })).toHaveAttribute('title', 'sha256:spec');
    expect(screen.getByText('QA image differs from production.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Remediation: Re-run production against image sha256:new.');
    expect(screen.getByRole('heading', { name: 'Coverage matrix' })).toBeInTheDocument();
    const matrixCell = screen.getByRole('button', { name: 'REQ-001, US-001, gate-qa: Blocked' });
    matrixCell.focus();
    expect(matrixCell).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(matrixCell).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Copy exact subject: current-sha' })).toHaveAttribute('title', 'current-sha');
    expect(screen.getByText('decision-22')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Inspect evidence 8 for gate-qa' }));
    expect(onOpenEvidence).toHaveBeenCalledWith('8', expect.any(HTMLElement));
    await user.click(screen.getByText('Requirement chains (1)'));
    const requirementSummary = screen.getAllByText('REQ-001')
      .map((node) => node.closest('summary'))
      .find((summary) => summary?.getAttribute('aria-label') === 'REQ-001');
    expect(requirementSummary).toBeDefined();
    await user.click(requirementSummary!);
    const requirement = requirementSummary!.closest('details');
    expect(requirement).toHaveTextContent('Decisions: ADR-001');
    expect(requirement).toHaveTextContent('Stories: US-001');
    expect(screen.getByText(/Historical — excluded from active gate/)).toBeInTheDocument();
    expect(screen.getByText(/Story caused failure · Eligible for bound revision/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Inspect github_check evidence check-8\. Outcome: Story caused failure/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Inspect historical github_check evidence check-7\. Outcome: Passed/ })).toBeInTheDocument();
    expect(screen.getByText(/Artifact digest/).parentElement).toHaveTextContent('Absent');
    expect(screen.getByText(/Release identity across Testing and Deployment: Mismatch/)).toBeInTheDocument();
    expect(screen.getByText(/Standard relational provenance is active/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Inspect historical github_check evidence check-7/ }));
    expect(onOpenEvidence).toHaveBeenCalledWith('7', expect.any(HTMLElement));
  });
  it('strips derived-reference hashes from visible copy, tooltips, and accessible names', async () => {
    const fullRef = `LBC-001:ac:sha256:${'3d2d7fe82fffef3dce9f1c411c45c43f64f5ce4bb445071d1f54d0184b24c17f'}`;
    const derived = {
      ...traceability,
      requirements: {
        ...traceability.requirements,
        items: [{
          ...traceability.requirements.items[0],
          requirementReference: fullRef,
          blockers: [{
            ...traceability.requirements.items[0].blockers![0],
            message: `Requirement ${fullRef} has no mapped implementation story.`,
            remediation: `Map ${fullRef} to at least one story, then recompile.`,
          }],
        }],
      },
      blockers: {
        ...traceability.blockers!,
        items: [{
          ...traceability.blockers!.items[0],
          message: `Requirement ${fullRef} has no mapped implementation story.`,
          remediation: `Map ${fullRef} to at least one story, then recompile.`,
        }],
      },
    };
    render(<LifecycleTraceabilityView traceability={derived} snapshotId="sha256:snapshot" onOpenEvidence={vi.fn()} />);

    expect(screen.getByText('LBC-001:ac')).toBeInTheDocument();
    expect(screen.queryByText(fullRef)).not.toBeInTheDocument();
    const summary = screen.getByText('LBC-001:ac').closest('summary');
    expect(summary).not.toHaveAttribute('title');
    expect(summary).toHaveAttribute('aria-label', 'LBC-001:ac');
    expect(screen.getByRole('alert')).toHaveTextContent('Requirement LBC-001:ac has no mapped implementation story.');
    expect(screen.getByRole('alert')).toHaveTextContent('Map LBC-001:ac to at least one story, then recompile.');
    expect(screen.queryByText(/sha256:3d2d7fe82fff/)).not.toBeInTheDocument();
  });
  it('deduplicates requirement rows and renders the complete matrix without paging', async () => {
    const user = userEvent.setup();
    const requirementItems = Array.from({ length: 27 }, (_, index) => ({
      ...traceability.requirements.items[0],
      requirementReference: `REQ-${String((index % 3) + 1).padStart(3, '0')}`,
      stories: [`US-${String(index + 1).padStart(3, '0')}`],
    }));
    const chainItems = Array.from({ length: 20 }, (_, index) => ({
      ...traceability.endToEnd!.items[0],
      requirementReference: `REQ-${String(index + 1).padStart(3, '0')}`,
      storyReference: `US-${String(index + 1).padStart(3, '0')}`,
      gateId: `gate-${index + 1}`,
      status: 'blocked' as const,
    }));
    const largeTraceability: LifecycleTraceability = {
      ...traceability,
      requirements: { items: requirementItems, total: 27, truncated: false },
      endToEnd: { items: chainItems, total: 20, truncated: false },
    };

    render(<LifecycleTraceabilityView traceability={largeTraceability} snapshotId="sha256:snapshot" onOpenEvidence={vi.fn()} />);

    expect(screen.getByText(/20 requirement\/story paths × 20 gates/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /REQ-\d+, US-\d+, gate-\d+: Blocked/ })).toHaveLength(20);
    expect(screen.getByRole('button', { name: 'Attention (20)' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'All (20)' }));
    expect(screen.getByRole('button', { name: 'All (20)' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByText('Requirement chains (27)'));
    expect(screen.getAllByLabelText(/^REQ-00[1-3]$/)).toHaveLength(3);
  });
});
