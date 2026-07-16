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

function evidence(id: string, currentRevision: boolean): LifecycleEvidenceSummary {
  return {
    id, evidenceType: 'github_check', sourceSystem: 'GitHub', sourceEventId: `check-${id}`, status: 'passed',
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
      gates: [{ gateId: 'gate-qa', phaseId: 'qa', title: 'QA approval', status: 'blocked', subjectRevisionRequirement: 'current_commit', evidenceRequirementIds: ['evidence-qa'], currentEvidence: [evidence('8', true)], historicalEvidence: [evidence('7', false)] }],
      blockers: [{ kind: 'subject_coherence', requirementReference: 'REQ-001', storyReference: null, gateId: 'gate-qa', message: 'QA image differs from production.', remediation: 'Re-run production against image sha256:new.' }],
    }], total: 1, truncated: false,
  },
  stories: { items: ['US-001'], total: 1, truncated: false },
  architectureDecisions: { items: ['ADR-001'], total: 1, truncated: false },
  gates: { items: [], total: 1, truncated: false },
  blockers: { items: [{ kind: 'subject_coherence', requirementReference: 'REQ-001', storyReference: null, gateId: 'gate-qa', message: 'QA image differs from production.', remediation: 'Re-run production against image sha256:new.' }], total: 1, truncated: false },
  boundRevision: { specVersion: '4', inputHash: 'sha256:spec', planId: 'plan-1', planVersion: 3 },
  subjectLineage: [
    { type: 'spec_hash', status: 'available', value: 'sha256:spec' },
    { type: 'commit_sha', status: 'available', value: 'current-sha' },
    { type: 'artifact_digest', status: 'absent', value: null },
    { type: 'deployment_id', status: 'not_applicable', value: null },
  ],
  downstreamCoherence: { status: 'mismatch', bindings: [
    { phaseId: 'qa', commitSha: 'current-sha', artifactDigest: 'sha256:new', deploymentId: null },
    { phaseId: 'merge', commitSha: 'current-sha', artifactDigest: 'sha256:new', deploymentId: null },
    { phaseId: 'production', commitSha: 'current-sha', artifactDigest: 'sha256:old', deploymentId: 'deploy-1' },
  ] },
  graphContext: { mode: 'lite', relatedEvidenceLabels: [] },
  evidence: { total: 2, validForCurrentRevision: 1, stale: 1, boundedAt: 500 },
};

describe('LifecycleTraceability', () => {
  it('renders one bounded canonical chain with exact blockers, history, lineage, and graph fallback', async () => {
    const user = userEvent.setup();
    const onOpenEvidence = vi.fn();
    render(<LifecycleTraceabilityView traceability={traceability} snapshotId="sha256:snapshot" onOpenEvidence={onOpenEvidence} />);

    expect(screen.getByText(/Spec 4 · Plan 3 · sha256:spec/)).toBeInTheDocument();
    expect(screen.getByText('QA image differs from production.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Remediation: Re-run production against image sha256:new.');
    await user.click(screen.getByText('REQ-001'));
    const requirement = screen.getByText('REQ-001').closest('details');
    expect(requirement).toHaveTextContent('Decisions: ADR-001');
    expect(requirement).toHaveTextContent('Stories: US-001');
    expect(screen.getByText(/Historical — excluded from active gate/)).toBeInTheDocument();
    expect(screen.getByText(/artifact_digest/).parentElement).toHaveTextContent('Absent');
    expect(screen.getByText(/QA → merge → production identity: mismatch/)).toBeInTheDocument();
    expect(screen.getByText(/Canonical relational provenance is active/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Inspect historical github_check evidence check-7/ }));
    expect(onOpenEvidence).toHaveBeenCalledWith('7', expect.any(HTMLElement));
  });
});
