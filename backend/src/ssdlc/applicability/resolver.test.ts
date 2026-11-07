/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  resolveActiveControls,
  type ApplicabilityControl,
  type ApplicabilityProfile,
} from './resolver';

const controls: ApplicabilityControl[] = [
  {
    controlId: 'CTRL-UNIVERSAL',
    applicability: { universal: true, productProfiles: [], riskProfiles: [], domainRegulatory: [] },
  },
  {
    controlId: 'CTRL-API',
    applicability: { universal: false, productProfiles: ['api-service'], riskProfiles: [], domainRegulatory: [] },
  },
  {
    controlId: 'CTRL-CLI',
    applicability: { universal: false, productProfiles: ['cli'], riskProfiles: [], domainRegulatory: [] },
  },
  {
    controlId: 'CTRL-SAFETY',
    applicability: { universal: false, productProfiles: [], riskProfiles: ['safety-critical'], domainRegulatory: [] },
  },
  {
    controlId: 'CTRL-FINANCE',
    applicability: { universal: false, productProfiles: [], riskProfiles: [], domainRegulatory: ['finance'] },
  },
  {
    controlId: 'CTRL-HEALTHCARE',
    applicability: { universal: false, productProfiles: [], riskProfiles: [], domainRegulatory: ['healthcare'] },
  },
  {
    controlId: 'CTRL-ARTIFACT',
    applicability: { universal: false, productProfiles: [], riskProfiles: ['external-integration'], domainRegulatory: [] },
  },
  {
    controlId: 'CTRL-AVIATION',
    applicability: { universal: false, productProfiles: [], riskProfiles: [], domainRegulatory: ['aviation'] },
  },
  {
    controlId: 'CTRL-PRIVACY-ARTIFACT',
    applicability: {
      universal: false,
      productProfiles: [],
      riskProfiles: ['data-modifying'],
      domainRegulatory: ['privacy-regulated'],
    },
  },
  {
    controlId: 'CTRL-X',
    applicability: { universal: false, productProfiles: ['api-service'], riskProfiles: [], domainRegulatory: [] },
  },
];

const emptyProfile: ApplicabilityProfile = {
  productProfile: null,
  riskProfile: [],
  domainRegulatory: [],
  workspaceConventions: [],
  specTaskOverrides: [],
};

describe('resolveActiveControls', () => {
  test('selects L0 universal and L1 product controls while excluding another product', () => {
    const result = resolveActiveControls({ ...emptyProfile, productProfile: 'api-service' }, controls);

    expect(result.activeControlIds).toEqual(['CTRL-UNIVERSAL', 'CTRL-API', 'CTRL-X']);
    expect(result.activeControlIds).not.toContain('CTRL-CLI');
  });

  test('selects L2 risk controls and derives independent-verification depth', () => {
    const result = resolveActiveControls({ ...emptyProfile, riskProfile: ['safety-critical'] }, controls);

    expect(result.activeControlIds).toContain('CTRL-SAFETY');
    expect(result.evidenceDepthByControlId['CTRL-SAFETY']).toBe('independent-verification');
  });

  test('selects only matching L3 domain-regulatory controls', () => {
    const result = resolveActiveControls({ ...emptyProfile, domainRegulatory: ['finance'] }, controls);

    expect(result.activeControlIds).toContain('CTRL-FINANCE');
    expect(result.activeControlIds).not.toContain('CTRL-HEALTHCARE');
  });

  test('applies and logs L4 workspace convention overrides after L0-L3', () => {
    const result = resolveActiveControls({
      ...emptyProfile,
      workspaceConventions: ['CTRL-CLI', 'exclude:CTRL-UNIVERSAL'],
    }, controls);

    expect(result.activeControlIds).toEqual(['CTRL-CLI']);
    expect(result.resolutionLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ controlId: 'CTRL-CLI', action: 'include', layer: 'L4', source: 'CTRL-CLI' }),
      expect.objectContaining({ controlId: 'CTRL-UNIVERSAL', action: 'exclude', layer: 'L4' }),
    ]));
  });

  test('applies L5 exclusion last and records the requirement as its source', () => {
    const result = resolveActiveControls({
      ...emptyProfile,
      productProfile: 'api-service',
      workspaceConventions: ['CTRL-X'],
      specTaskOverrides: [{ controlId: 'CTRL-X', action: 'exclude', requirementId: 'REQ-42' }],
    }, controls);

    expect(result.activeControlIds).not.toContain('CTRL-X');
    expect(result.resolutionLog).toContainEqual(expect.objectContaining({
      controlId: 'CTRL-X',
      action: 'exclude',
      layer: 'L5',
      source: 'REQ-42',
      requirementId: 'REQ-42',
    }));
  });

  test('derives all depth levels with independent verification taking priority over artifact', () => {
    const derived = resolveActiveControls({
      ...emptyProfile,
      riskProfile: ['external-integration', 'safety-critical', 'data-modifying'],
      domainRegulatory: ['aviation', 'privacy-regulated'],
    }, controls);
    expect(derived.evidenceDepthByControlId).toMatchObject({
      'CTRL-UNIVERSAL': 'self-attestation',
      'CTRL-SAFETY': 'independent-verification',
      'CTRL-ARTIFACT': 'artifact',
      'CTRL-AVIATION': 'independent-verification',
      'CTRL-PRIVACY-ARTIFACT': 'independent-verification',
    });
  });

  test('gives ordered L5 overrides final precedence, including evidence depth', () => {
    const overridden = resolveActiveControls({
      ...emptyProfile,
      riskProfile: ['external-integration'],
      specTaskOverrides: [
        { controlId: 'CTRL-ARTIFACT', action: 'exclude', requirementId: 'REQ-EXCLUDE' },
        {
          controlId: 'CTRL-ARTIFACT',
          action: 'include',
          evidenceDepthOverride: 'self-attestation',
          requirementId: 'REQ-DEPTH',
        },
      ],
    }, controls);
    expect(overridden.activeControlIds).toContain('CTRL-ARTIFACT');
    expect(overridden.evidenceDepthByControlId['CTRL-ARTIFACT']).toBe('self-attestation');
    expect(overridden.resolutionLog.slice(-2).map(({ action, source }) => ({ action, source }))).toEqual([
      { action: 'exclude', source: 'REQ-EXCLUDE' },
      { action: 'include', source: 'REQ-DEPTH' },
    ]);
  });

  test('returns only L0 controls for an empty profile and is deterministic', () => {
    const first = resolveActiveControls(emptyProfile, controls);
    const second = resolveActiveControls(emptyProfile, controls);

    expect(first.activeControlIds).toEqual(['CTRL-UNIVERSAL']);
    expect(first.activeControlIds).toEqual(second.activeControlIds);
    expect(first.evidenceDepthByControlId).toEqual(second.evidenceDepthByControlId);
  });

  test('never derives a baseline weaker than canonical control evidence', () => {
    const canonical = resolveActiveControls(emptyProfile);

    expect(canonical.evidenceDepthByControlId['CTRL-TESTING-THREAT-AUTHZ-SECRETS'])
      .toBe('artifact');
  });
});
