/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  completeFeatureAssuranceFixture,
  developmentAssuranceFeatureFixture,
  missingLinkFeatureAssuranceFixture,
  staleFeatureAssuranceFixture,
  reviewTrustStatesFeatureAssuranceFixture,
} from '../../fixtures/featureAssuranceMap';
import { projectFeatureAssuranceMap } from '../../lib/feature-assurance-map';
import FeatureAssuranceMap from '../FeatureAssuranceMap';

describe('FeatureAssuranceMap', () => {
  it('shows a navigable chain and distinct evidence provenance', async () => {
    const user = userEvent.setup();
    const onOpenEvidence = vi.fn();
    const onNavigate = vi.fn();
    render(<FeatureAssuranceMap projection={projectFeatureAssuranceMap(completeFeatureAssuranceFixture())} onNavigate={onNavigate} onOpenEvidence={onOpenEvidence} />);

    expect(screen.getByTestId('feature-assurance-map')).toBeInTheDocument();
    expect(screen.getByText(/Requirement → acceptance criterion → story → control → evidence → decision/)).toBeInTheDocument();
    expect(screen.getAllByText(/Verified/).length).toBeGreaterThan(0);
    await user.click(screen.getByText(/REQ-001 → AC-001 → STORY-001 → CTRL-001/));
    await user.click(screen.getByRole('button', { name: /Requirement: REQ-001/ }));
    expect(onNavigate).toHaveBeenCalledWith('requirement', 'REQ-001');
    expect(screen.getByText('generated_narrative · planner')).toBeInTheDocument();
    expect(screen.getByText('host_observed · vitest')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'EVIDENCE-HOST' }));
    expect(onOpenEvidence).toHaveBeenCalledWith('EVIDENCE-HOST');
  });

  it('names the expected identity of an unavailable relationship', () => {
    const fixture = completeFeatureAssuranceFixture();
    fixture.requirements[0].acceptanceCriterionIds.push('AC-MISSING');
    render(<FeatureAssuranceMap projection={projectFeatureAssuranceMap(fixture)} />);

    expect(screen.getByText(/REQ-001 → Missing acceptance criterion AC-MISSING/)).toBeInTheDocument();
  });

  it('renders source details and gap states when the chain is incomplete', async () => {
    const user = userEvent.setup();
    render(<FeatureAssuranceMap projection={projectFeatureAssuranceMap(missingLinkFeatureAssuranceFixture())} />);

    await user.click(screen.getByText(/REQ-001 → AC-001 → STORY-001 → CTRL-001/));
    expect(screen.getByText('generated_narrative · planner')).toBeInTheDocument();
    expect(screen.getByText('host_observed · vitest')).toBeInTheDocument();
    expect(screen.getByText('2026-08-18T10:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText('2026-08-18T10:05:00.000Z')).toBeInTheDocument();
    expect(screen.getAllByText(/requirementId=REQ-001.*storyId=STORY-001.*controlId=CTRL-001/)).toHaveLength(2);
    expect(screen.getByText(/pending: No decision is bound to the complete chain\./)).toBeInTheDocument();
    expect(screen.getByText(/unavailable: No work package is bound to story STORY-001\./)).toBeInTheDocument();
  });

  it('shows both identities for stale rows and never labels them verified', async () => {
    const user = userEvent.setup();
    render(<FeatureAssuranceMap projection={projectFeatureAssuranceMap(staleFeatureAssuranceFixture())} />);

    expect(screen.getAllByText(/Stale/).length).toBeGreaterThan(0);
    await user.click(screen.getByText(/REQ-001 → AC-001 → STORY-001 → CTRL-001/));
    expect(screen.getByText(/revision spec-rev-6 · plan plan-feature-6 · v2/)).toBeInTheDocument();
    expect(screen.getByText(/source:/).parentElement).toHaveTextContent(/source:revision spec-rev-7.*plan plan-feature-7.*v3/);
  });
  it('labels stale evidence rows and preserves both identities', async () => {
    const user = userEvent.setup();
    const fixture = completeFeatureAssuranceFixture();
    fixture.evidence[1].identity = { ...fixture.evidence[1].identity, planVersion: 2 };
    render(<FeatureAssuranceMap projection={projectFeatureAssuranceMap(fixture)} />);

    await user.click(screen.getByText(/REQ-001 → AC-001 → STORY-001 → CTRL-001/));
    expect(within(screen.getByTestId('assurance-evidence-EVIDENCE-HOST')).getByTestId('assurance-evidence-identity-EVIDENCE-HOST')).toHaveTextContent(/revision spec-rev-7.*v2.*source revision spec-rev-7.*v3.*Stale identity/);
  });

  it('compares decision identities by fields rather than object property order', async () => {
    const user = userEvent.setup();
    const fixture = completeFeatureAssuranceFixture();
    fixture.decisions[0].identity = {
      planVersion: fixture.decisions[0].identity.planVersion,
      planId: fixture.decisions[0].identity.planId,
      revision: fixture.decisions[0].identity.revision,
    };
    render(<FeatureAssuranceMap projection={projectFeatureAssuranceMap(fixture)} />);

    await user.click(screen.getByText(/REQ-001 → AC-001 → STORY-001 → CTRL-001/));
    const decision = screen.getByTestId('assurance-decision-DECISION-001');
    expect(decision).toHaveTextContent('revision spec-rev-7 · plan plan-feature-7 · v3');
    expect(decision).not.toHaveTextContent('Stale identity');
  });

  it('renders selected, excluded, unresolved, and blocked Development Assurance checks with rationale', async () => {
    const user = userEvent.setup();
    render(<FeatureAssuranceMap projection={projectFeatureAssuranceMap(developmentAssuranceFeatureFixture())} />);

    expect(screen.getByTestId('development-assurance-obligations')).toBeInTheDocument();
    expect(screen.getByText('Needs resolution')).toBeInTheDocument();
    expect(screen.getByText('Required:').parentElement).toHaveTextContent('Required: 1');
    expect(screen.getByText('Excluded:').parentElement).toHaveTextContent('Excluded: 1');
    expect(screen.getByText('Unresolved:').parentElement).toHaveTextContent('Unresolved: 1');
    expect(screen.getByText('Blocked:').parentElement).toHaveTextContent('Blocked: 1');
    const binding = screen.getByTestId('development-assurance-binding');
    expect(binding).toHaveTextContent('feature-assurance · spec-rev-7');
    expect(binding).toHaveTextContent('candidate-map');
    expect(binding).toHaveTextContent('plan-feature-7 · v3');
    expect(binding).toHaveTextContent('WP-001 · revision 1');

    await user.click(screen.getByText(/requirement-implementation · REQ-001 · modified/));
    expect(screen.getByText('The UI change must preserve the inspectable requirement chain.')).toBeInTheDocument();
    expect(screen.getByText('EVIDENCE-001')).toBeInTheDocument();
    expect(screen.getByText('Review the exact Feature Assurance Map change.')).toBeInTheDocument();
    expect(screen.getByTestId('development-assurance-check-DAC-required')).toHaveTextContent(
      'change-map · modified · src/components/FeatureAssuranceMap.tsx',
    );

    await user.click(screen.getByText(/risk-mitigation · feature scope/));
    expect(screen.getByText('Billing risk does not apply to the bound Feature Assurance Map change.')).toBeInTheDocument();
    expect(screen.getByText('Not applicable')).toBeInTheDocument();
    expect(screen.getByTestId('development-assurance-check-DAC-excluded')).toHaveTextContent('RISK-BILLING');
    expect(screen.getByText(/architecture-conformance · REQ-001 · boundary/)).toBeInTheDocument();
    expect(screen.getByText(/scope-conformance · feature scope/)).toBeInTheDocument();
  });

  it('shows independent, self-review, and stale-review trust without treating review evidence as approval', () => {
    render(<FeatureAssuranceMap projection={projectFeatureAssuranceMap(reviewTrustStatesFeatureAssuranceFixture())} />);

    const reviewView = screen.getByTestId('feature-assurance-review-view');
    expect(within(reviewView).getByText('Independent review evidence')).toBeInTheDocument();
    expect(within(reviewView).getByText('Insufficient evidence')).toBeInTheDocument();
    expect(within(reviewView).getByRole('alert')).toHaveTextContent('Independent review evidence is unavailable');
    const trustSummary = within(reviewView).getByLabelText('Review trust state summary');
    expect(within(trustSummary).getByTestId('review-trust-independent')).toHaveTextContent('Independent');
    expect(within(trustSummary).getByTestId('review-trust-self-review')).toHaveTextContent('Self-review');
    expect(within(trustSummary).getByTestId('review-trust-stale-review')).toHaveTextContent('Stale review');
    expect(within(reviewView).getByText(/Inspection evidence only · no approval authority/)).toBeInTheDocument();

    const standards = within(reviewView).getByRole('region', { name: 'Standards review axis' });
    expect(standards).toHaveTextContent('agent:standards · agent · review-execution:standards:17');
    expect(standards).toHaveTextContent('standards-nonconformance');
    expect(standards).toHaveTextContent('medium · open · current');
    expect(standards).toHaveTextContent('src/components/FeatureAssuranceMap.tsx:177–190');

    const design = within(reviewView).getByRole('region', { name: 'Design review axis' });
    expect(design).toHaveTextContent('Self-review');
    expect(design).toHaveTextContent('insufficient evidence');

    const adversarial = within(reviewView).getByRole('region', { name: 'Adversarial review axis' });
    expect(adversarial).toHaveTextContent('Stale review');
    expect(adversarial).toHaveTextContent('stale-replay');
    expect(adversarial).toHaveTextContent('review does not bind the exact current subject.');
  });
});
