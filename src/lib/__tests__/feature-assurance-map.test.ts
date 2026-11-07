/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import {
  completeFeatureAssuranceFixture,
  mismatchedFeatureAssuranceFixture,
  mismatchedPlanIdentityFeatureAssuranceFixture,
  missingLinkFeatureAssuranceFixture,
  staleFeatureAssuranceFixture,
} from '../../fixtures/featureAssuranceMap';
import { projectFeatureAssuranceMap } from '../feature-assurance-map';

describe('feature assurance map projection', () => {
  it('projects a complete chain as verified only with host-observed evidence', () => {
    const result = projectFeatureAssuranceMap(completeFeatureAssuranceFixture());
    expect(result.readOnly).toBe(true);
    expect(result.chains).toHaveLength(1);
    expect(result.chains[0]).toMatchObject({ status: 'verified', evidence: [{ id: 'EVIDENCE-NARRATIVE' }, { id: 'EVIDENCE-HOST' }] });
    expect(result.chains[0].evidence.find((item) => item.source === 'generated_narrative')).toMatchObject({ trustLevel: 'agent_proposed', lineageVerified: false });
    expect(result.chains[0].evidence.find((item) => item.source === 'host_observed')).toMatchObject({ observedAt: '2026-08-18T10:05:00.000Z', lineageVerified: true, binding: { evidenceRequirementIds: ['EVIDENCE-001'] } });
    expect(result.chains[0].decisions[0]).toMatchObject({ source: 'reviewer', createdAt: '2026-08-18T10:10:00.000Z' });
    expect(result.chains[0].workPackage.value?.facts).toEqual([
      { label: 'run', value: '42' },
      { label: 'allowed paths', value: 'src/feature-assurance-map.ts' },
    ]);
  });

  it('rejects narrative-only, unlineaged, and control-incomplete evidence as false-green', () => {
    const narrativeOnly = completeFeatureAssuranceFixture();
    narrativeOnly.evidence = narrativeOnly.evidence.filter((item) => item.source === 'generated_narrative');
    const narrativeProjection = projectFeatureAssuranceMap(narrativeOnly);
    expect(narrativeProjection.chains[0].status).toBe('pending');
    expect(narrativeProjection.chains[0].gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'untrusted_evidence' }),
    ]));

    const unlineaged = completeFeatureAssuranceFixture();
    const hostWithoutLineage = unlineaged.evidence.find((item) => item.source === 'host_observed');
    if (hostWithoutLineage) hostWithoutLineage.lineageVerified = false;
    expect(projectFeatureAssuranceMap(unlineaged).summary.verified).toBe(0);

    const incompleteControlEvidence = completeFeatureAssuranceFixture();
    const hostWithoutCoverage = incompleteControlEvidence.evidence.find((item) => item.source === 'host_observed');
    if (hostWithoutCoverage) hostWithoutCoverage.binding.evidenceRequirementIds = [];
    const incomplete = projectFeatureAssuranceMap(incompleteControlEvidence);
    expect(incomplete.chains[0].status).toBe('pending');
    expect(incomplete.chains[0].gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Trusted evidence does not cover control requirements: EVIDENCE-001.' }),
    ]));
  });

  it('keeps distinct narrative and host evidence visible while reporting missing links', () => {
    const result = projectFeatureAssuranceMap(missingLinkFeatureAssuranceFixture());
    const chain = result.chains[0];
    expect(chain.status).toBe('unavailable');
    expect(chain.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'EVIDENCE-NARRATIVE',
        source: 'generated_narrative',
        sourceSystem: 'planner',
        observedAt: '2026-08-18T10:00:00.000Z',
        trustLevel: 'agent_proposed',
        binding: expect.objectContaining({ storyId: 'STORY-001', controlId: 'CTRL-001' }),
      }),
      expect.objectContaining({
        id: 'EVIDENCE-HOST',
        source: 'host_observed',
        sourceSystem: 'vitest',
        observedAt: '2026-08-18T10:05:00.000Z',
        trustLevel: 'host_observed',
        binding: expect.objectContaining({ storyId: 'STORY-001', controlId: 'CTRL-001' }),
      }),
    ]));
    expect(chain.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing_link', status: 'pending', message: 'No decision is bound to the complete chain.' }),
      expect.objectContaining({ kind: 'missing_link', status: 'unavailable', message: 'No work package is bound to story STORY-001.' }),
    ]));
    expect(result.summary.verified).toBe(0);
  });

  it('reports both row and source identities when a projection is stale', () => {
    const result = projectFeatureAssuranceMap(staleFeatureAssuranceFixture());
    const chain = result.chains[0];
    expect(chain.status).toBe('stale');
    expect(chain.story.identity).toEqual({
      row: { revision: 'spec-rev-6', planId: 'plan-feature-6', planVersion: 2 },
      source: { revision: 'spec-rev-7', planId: 'plan-feature-7', planVersion: 3 },
      status: 'stale',
    });
    expect(chain.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'stale_identity', relatedId: 'STORY-001' }),
    ]));
  });

  it('blocks a false-green relationship when evidence binds to another story', () => {
    const result = projectFeatureAssuranceMap(mismatchedFeatureAssuranceFixture());
    const chain = result.chains[0];
    expect(chain.status).toBe('blocked');
    expect(chain.evidence).toHaveLength(0);
    expect(chain.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'mismatched_binding', status: 'blocked', relatedId: 'EVIDENCE-WRONG-STORY' }),
    ]));
    expect(result.summary.verified).toBe(0);
  });

  it('keeps missing declared rows visible instead of dropping them into a false-green chain', () => {
    const fixture = completeFeatureAssuranceFixture();
    fixture.requirements[0].acceptanceCriterionIds.push('AC-MISSING');

    const result = projectFeatureAssuranceMap(fixture);
    const missing = result.chains.find((chain) => chain.acceptanceCriterion.expectedId === 'AC-MISSING');
    expect(result.chains).toHaveLength(2);
    expect(missing).toMatchObject({
      status: 'unavailable',
      acceptanceCriterion: { value: null, expectedId: 'AC-MISSING' },
    });
    expect(missing?.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'missing_link', relatedId: 'AC-MISSING' }),
    ]));
    expect(result.summary.unavailable).toBe(1);
  });

  it('scopes controls to the requirement/story relationship when a story spans requirements', () => {
    const fixture = completeFeatureAssuranceFixture();
    const identity = fixture.requirements[0].identity;
    fixture.requirements.push({
      id: 'REQ-002',
      text: 'A second requirement is implemented by the same story.',
      identity,
      acceptanceCriterionIds: ['AC-002'],
      controlIds: ['CTRL-002'],
    });
    fixture.acceptanceCriteria.push({
      id: 'AC-002',
      text: 'The shared story remains traceable.',
      requirementId: 'REQ-002',
      storyIds: ['STORY-001'],
      identity,
    });
    fixture.stories[0].acceptanceCriterionIds.push('AC-002');
    fixture.stories[0].controlIds.push('CTRL-002');
    fixture.controls.push({
      id: 'CTRL-002',
      title: 'Second traceability control',
      evidenceRequirementIds: ['EVIDENCE-002'],
      identity,
    });

    const result = projectFeatureAssuranceMap(fixture);
    expect(result.chains).toHaveLength(2);
    expect(result.chains.find((chain) => chain.requirement.value?.id === 'REQ-001')?.control.value?.id).toBe('CTRL-001');
    expect(result.chains.find((chain) => chain.requirement.value?.id === 'REQ-002')?.control.value?.id).toBe('CTRL-002');
  });

  it('blocks a one-way story binding and keeps a pending decision from appearing verified', () => {
    const reverseMismatch = completeFeatureAssuranceFixture();
    reverseMismatch.stories[0].acceptanceCriterionIds = [];
    expect(projectFeatureAssuranceMap(reverseMismatch).chains[0]).toMatchObject({
      status: 'blocked',
      gaps: [expect.objectContaining({ kind: 'mismatched_binding', relatedId: 'STORY-001' })],
    });

    const pendingDecision = completeFeatureAssuranceFixture();
    pendingDecision.decisions[0].outcome = 'pending';
    expect(projectFeatureAssuranceMap(pendingDecision).chains[0]).toMatchObject({
      status: 'pending',
      gaps: [expect.objectContaining({ kind: 'pending_decision', status: 'pending' })],
    });
  });

  it('blocks a decision bound to a different plan identity and preserves both identities', () => {
    const result = projectFeatureAssuranceMap(mismatchedPlanIdentityFeatureAssuranceFixture());
    const chain = result.chains[0];
    expect(chain.status).toBe('stale');
    expect(chain.decisions[0]?.identity).toEqual({
      revision: 'spec-rev-7',
      planId: 'plan-feature-old',
      planVersion: 3,
    });
    expect(chain.decisions[0]?.sourceIdentity).toEqual({
      revision: 'spec-rev-7',
      planId: 'plan-feature-7',
      planVersion: 3,
    });
    expect(result.summary.verified).toBe(0);
  });
});
